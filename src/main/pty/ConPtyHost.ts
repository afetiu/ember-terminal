import { createRequire } from 'node:module'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import type { PtyHost, PtySession, PtySpawnOptions, PtyStats } from './PtyHost.js'

// The package is CJS and ships a prebuilt N-API binary; createRequire keeps this
// deterministic regardless of how electron-vite emits the surrounding module.
const require = createRequire(import.meta.url)
const nodePty = require('@lydell/node-pty') as typeof import('@lydell/node-pty')

/**
 * Coalescing window. ConPTY hands us many tiny chunks; forwarding each one as its
 * own IPC message is what makes naive Electron terminals feel slow. Batching to a
 * single message per frame costs at most one frame of latency and removes the
 * overwhelming majority of IPC round-trips under heavy output.
 */
const FLUSH_MS = 4
/**
 * The same batching, widened while output is actually pouring in.
 *
 * 4ms is the right answer for an echoed keystroke, where the whole budget is latency and
 * the payload is one character. It is the wrong answer for a model streaming a reply: it
 * caps out at 250 messages a second, every one of which wakes the renderer to parse,
 * scan and render a fragment the screen will not show until the next frame anyway.
 *
 * So the delay is chosen from the size of the last flush. Typing keeps the fast path
 * because typing produces tiny flushes; a flood settles into roughly one message per
 * frame. Latency is unchanged where it is felt and throughput improves where it is not.
 */
const BULK_FLUSH_MS = 12
/** A flush larger than this means bulk output rather than an echo. */
const BULK_BYTES = 2048
/**
 * Above this many unacked chars in flight, stop reading from the shell.
 *
 * This is the one place Ember can make a program *wait*. Pausing the pty fills the pipe,
 * the program's next console write blocks, and a program that is blocked on a write is
 * not reading its keyboard — so everything typed piles up and lands at once when the
 * renderer catches up. That is precisely the lag this app is not allowed to have, and an
 * agent CLI redrawing its whole screen while it streams produced bursts well past the old
 * 120K limit. The bound now exists only to stop a runaway firehose from filling memory;
 * nothing a program does in the course of drawing itself should reach it.
 */
const HIGH_WATER = Number(process.env['EMBER_HIGH_WATER'] || 4_000_000)
const LOW_WATER = Number(process.env['EMBER_LOW_WATER'] || 1_000_000)
/** Probe knob: EMBER_NO_FASTFLUSH=1 restores the always-timer coalescing. */
const FAST_FLUSH = !process.env['EMBER_NO_FASTFLUSH']
/** After a write, output within this window is treated as its echo and never batched. */
const ECHO_MS = 300

interface Entry {
  pty: IPty
  session: PtySession
  pending: string
  timer: NodeJS.Timeout | null
  /** When the last flush went out, so an isolated echo can go immediately. */
  lastFlushAt: number
  unacked: number
  /** When the person last typed into this pty; its echo must never wait for a timer. */
  lastWriteAt: number
  /** Whether the last flush looked like bulk output. See BULK_FLUSH_MS. */
  bulk: boolean
  paused: boolean
  pausedAt: number
  pauses: number
  pausedMs: number
  exited: boolean
}

/** Resolve a bare command name against PATH/PATHEXT so we can fall back gracefully. */
function which(cmd: string): string | null {
  if (isAbsolute(cmd)) {
    try {
      accessSync(cmd, constants.X_OK)
      return cmd
    } catch {
      return null
    }
  }
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const hasExt = exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()))
  for (const dir of dirs) {
    const candidates = hasExt ? [join(dir, cmd)] : exts.map((e) => join(dir, cmd + e))
    for (const c of candidates) {
      try {
        accessSync(c, constants.F_OK)
        return c
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/**
 * Wrap the PowerShell prompt so each one reports the working directory as OSC 9;9.
 *
 * Everything cwd-dependent — the git badge, the task runner, splits inheriting the
 * current folder, restoring into the right directory — needs this, and there is no
 * way to read another process's working directory on Windows from Node.
 *
 * Two deliberate choices: the existing prompt is *wrapped* rather than replaced, so
 * oh-my-posh keeps working; and it is passed via `-NoExit -Command` so it runs after
 * the profile loads and never appears on screen or in history, which sending it as
 * typed input would.
 */
function withShellIntegration(exePath: string, args: string[]): string[] {
  const exe = exePath.toLowerCase()
  if (!exe.endsWith('pwsh.exe') && !exe.endsWith('powershell.exe')) return args
  // Already customised by the user — do not fight it.
  if (args.some((a) => /^-(?:c|command|noexit)$/i.test(a))) return args

  // `$?` must be read as the very first statement in the prompt, before anything
  // else clobbers it. OSC 133;D carries the real exit status, which beats guessing
  // failure from whether the output happened to contain red.
  const script =
    `if(-not $global:__emberOldPrompt){` +
    `$global:__emberOldPrompt=$function:prompt;` +
    `function global:prompt{` +
    `$c=if($?){0}else{1};` +
    `([char]27+']133;D;'+$c+[char]7)+` +
    `([char]27+']9;9;'+$PWD.ProviderPath+[char]7)+` +
    `(& $global:__emberOldPrompt)}}`

  return [...args, '-NoExit', '-Command', script]
}

/**
 * Teach this shell's `claude` about the tab's panel.
 *
 * The alternative was registering the panel MCP server in `~/.claude.json`, which would
 * have attached it to every Claude session on the machine — including the ones in
 * Windows Terminal, where there is no panel to draw on. A function that shadows the
 * command only exists inside this pty, so the reach of the feature is exactly the reach
 * of Ember.
 *
 * `Get-Command -CommandType Application` is what stops the function calling itself.
 * Subcommands are passed through untouched: `claude mcp add` must not be run with a
 * `--mcp-config` we injected, or it edits the wrong file.
 *
 * **Nothing but flags may be added here, and never a paragraph of English.** A version
 * of this passed `--append-system-prompt` with the panel instructions read out of a
 * file. On this machine `claude` resolves to `claude.cmd`, so every argument is parsed
 * a second time by cmd.exe — and the prompt contained the words `"show me"` in quotes,
 * which ended cmd's quoted region. The tail became a *positional* argument, which
 * Claude Code takes as the initial prompt, so every session in every Ember tab opened
 * by answering half a sentence nobody had typed. The panel's system prompt belongs in
 * the MCP server's `instructions`, which travel as JSON over stdio and are parsed by
 * nothing on the way.
 */
/**
 * The same for every other agent CLI Ember knows (src/shared/agents.ts).
 *
 * Each gets two things. The panel, handed over the way that CLI takes an MCP server —
 * `-c` overrides for Codex, a settings file named by an environment variable for Gemini
 * and OpenCode, a flag for Copilot — with the variable set only for the life of the call.
 * And an announcement: the terminal title is set to the command's name while it runs and
 * cleared when it exits, which is how the card knows an agent is in the tab (Claude Code
 * does this itself). Cursor Agent has no per-session way to add a server, so it gets the
 * announcement only.
 *
 * The rule above holds: flags and file paths only, never prose. Every value here is free
 * of double quotes, so cmd.exe's second parse of a .cmd shim has nothing to split.
 */
export function otherAgentShims(): string[] {
  const esc = '$([char]27)'
  const bel = '$([char]7)'
  return [
    'function global:__emberRun([string]$bin, [object[]]$pre, [object[]]$rest, [hashtable]$envs) {',
    '  $real = @(Get-Command $bin -CommandType Application -ErrorAction SilentlyContinue)[0]',
    '  if (-not $real) { Write-Error "$bin was not found on PATH. Settings > Agent can install it."; return }',
    '  $saved = @{}',
    '  foreach ($k in $envs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item "env:$k" $envs[$k] }',
    `  [Console]::Write("${esc}]0;$bin${bel}${esc}]133;E;ember-agent=$($envs.EMBER_SESSION_AGENT)${bel}")`,
    '  try { & $real.Source @pre @rest } finally {',
    '    foreach ($k in $envs.Keys) { if ($null -eq $saved[$k]) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } else { Set-Item "env:$k" $saved[$k] } }',
    `    [Console]::Write("${esc}]0;${bel}")`,
    '  }',
    '}',
    'function global:codex {',
    '  $pre = @()',
    "  $bare = @('login','logout','mcp','mcp-server','app-server','completion','sandbox','debug','apply','features','cloud','help')",
    '  if ($env:EMBER_MCP_LAUNCHER -and -not ($args.Count -gt 0 -and $bare -contains $args[0])) {',
    `    $pre = @('-c', "mcp_servers.ember-panel.command='$env:EMBER_MCP_LAUNCHER'", '-c', "mcp_servers.ember-panel.env_vars=['EMBER_BRIDGE_URL','EMBER_BRIDGE_TOKEN','EMBER_TAB_ID','EMBER_NOTES_DIR','EMBER_SESSION_AGENT']")`,
    '  }',
    "  __emberRun codex $pre $args @{ EMBER_SESSION_AGENT = 'codex' }",
    '}',
    'function global:gemini {',
    "  $e = @{ EMBER_SESSION_AGENT = 'gemini' }",
    '  if ($env:EMBER_GEMINI_SETTINGS -and -not $env:GEMINI_CLI_SYSTEM_SETTINGS_PATH) { $e.GEMINI_CLI_SYSTEM_SETTINGS_PATH = $env:EMBER_GEMINI_SETTINGS }',
    '  __emberRun gemini @() $args $e',
    '}',
    'function global:opencode {',
    "  $e = @{ EMBER_SESSION_AGENT = 'opencode' }",
    '  if ($env:EMBER_OPENCODE_CONFIG -and -not $env:OPENCODE_CONFIG) { $e.OPENCODE_CONFIG = $env:EMBER_OPENCODE_CONFIG }',
    '  __emberRun opencode @() $args $e',
    '}',
    'function global:copilot {',
    '  $pre = @()',
    "  if ($env:EMBER_COPILOT_MCP -and -not ($args.Count -gt 0 -and @('help','version','update') -contains $args[0])) { $pre = @('--additional-mcp-config', \"@$env:EMBER_COPILOT_MCP\") }",
    "  __emberRun copilot $pre $args @{ EMBER_SESSION_AGENT = 'copilot' }",
    '}',
    "function global:cursor-agent { __emberRun cursor-agent @() $args @{ EMBER_SESSION_AGENT = 'cursor' } }",
  ]
}

function withPanelShim(exePath: string, args: string[]): string[] {
  const exe = exePath.toLowerCase()
  if (!exe.endsWith('pwsh.exe') && !exe.endsWith('powershell.exe')) return args

  // `note` and `notes` used to be PowerShell functions defined here. They are real
  // commands now — launchers in ~/.ember/bin, put on PATH in spawn() — so they exist in
  // Git Bash and cmd as well as PowerShell, which is what lets a Claude session run them.
  const script = [
    'function global:claude {',
    '  $real = @(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue)[0]',
    "  if (-not $real) { Write-Error 'claude was not found on PATH'; return }",
    "  $bare = @('mcp','config','doctor','update','install','migrate-installer','setup-token','plugin')",
    '  if (-not $env:EMBER_MCP_CONFIG -or ($args.Count -gt 0 -and $bare -contains $args[0])) {',
    '    & $real.Source @args; return',
    '  }',
    // The status line rides in the same way: a settings file main wrote, holding only a
    // `statusLine` command that reports to the bridge. A path, never text — see above.
    '  if ($env:EMBER_SETTINGS) { & $real.Source --mcp-config $env:EMBER_MCP_CONFIG --settings $env:EMBER_SETTINGS @args; return }',
    '  & $real.Source --mcp-config $env:EMBER_MCP_CONFIG @args',
    '}',
    ...otherAgentShims(),
  ].join('\n')

  // Fold into an existing -Command rather than adding a second one: powershell.exe
  // honours only the last, so appending would silently drop shell integration.
  const at = args.findIndex((a) => /^-(?:c|command)$/i.test(a))
  if (at !== -1 && at + 1 < args.length) {
    const merged = [...args]
    merged[at + 1] = `${script}\n${merged[at + 1]}`
    return merged
  }
  return [...args, '-NoExit', '-Command', script]
}

/**
 * Variables that describe whoever launched Ember, not the terminal Ember provides.
 *
 * A shell inherits our environment, so anything the launcher set leaks into every
 * pane. That is fine for PATH and ruinous for the rest: start Ember from inside an
 * agent's shell and `NO_COLOR=1` follows it in, and every CLI in every tab renders
 * monochrome. `CLAUDE_CODE_CHILD_SESSION` is worse than cosmetic — a Claude session
 * that sees it stops writing its transcript.
 *
 * The exact prefix match is deliberate: `CLAUDE_CODE_*` covers markers we have not
 * met yet, but `CLAUDE_*` would take the user's own API keys with it.
 */
const LAUNCHER_ONLY = [
  'NO_COLOR',
  'FORCE_COLOR',
  'CLAUDECODE',
  'CLAUDE_CODE_',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'VSCODE_',
]

/** Ember's own environment, minus whatever the launcher was. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (LAUNCHER_ONLY.some((p) => (p.endsWith('_') ? k.startsWith(p) : k === p))) continue
    out[k] = v
  }
  return out
}

export class ConPtyHost implements PtyHost {
  private readonly sessions = new Map<string, Entry>()
  private dataCb: ((sessionId: string, data: string) => void) | null = null
  private exitCb: ((sessionId: string, exitCode: number, signal?: number) => void) | null = null

  onData(cb: (sessionId: string, data: string) => void): void {
    this.dataCb = cb
  }

  onExit(cb: (sessionId: string, exitCode: number, signal?: number) => void): void {
    this.exitCb = cb
  }

  spawn(opts: PtySpawnOptions): PtySession {
    const { profile } = opts
    const resolved = which(profile.command) ?? which('powershell.exe')
    if (!resolved) throw new Error(`Could not resolve shell "${profile.command}" or a PowerShell fallback on PATH`)

    let args = opts.shellIntegration ? withShellIntegration(resolved, profile.args) : profile.args
    if (opts.panel) args = withPanelShim(resolved, args)

    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      ...profile.env,
      ...(opts.env ?? {}),
      ...(opts.panel ?? {}),
      TERM_PROGRAM: 'Ember',
      COLORTERM: 'truecolor',
    }
    if (opts.bin?.length) {
      // Windows spells it `Path`; node's env object is case-insensitive on read but not
      // on write, so find the key that exists rather than adding a second one.
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
      env[key] = [...opts.bin, env[key] ?? ''].filter(Boolean).join(delimiter)
    }

    const pty = nodePty.spawn(resolved, args, {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols),
      rows: Math.max(1, opts.rows),
      cwd: opts.cwd,
      env,
      // Use the conpty.dll shipped in the package rather than the OS one — it is the
      // same component Windows Terminal bundles and is newer than the in-box copy.
      // The OS's ConPTY, not the OpenConsole bundled with node-pty. Under the bundled one
      // PowerShell took 4-7 s to reach its prompt against 1.2-1.8 s in-box (measured
      // 2026-09-05, scripts/bench-spawn.cjs) — the "PowerShell is slower in Ember than in
      // Windows Terminal" that was felt for weeks. Throughput is a wash either way
      // (scripts/bench-pty.cjs --inbox). EMBER_BUNDLED_CONPTY=1 brings the bundled one back.
      useConptyDll: !!process.env['EMBER_BUNDLED_CONPTY'],
    })

    const session: PtySession = { sessionId: opts.sessionId, pid: pty.pid, shell: resolved }
    const entry: Entry = { pty, session, pending: '', timer: null, lastFlushAt: 0, unacked: 0, lastWriteAt: 0, bulk: false, paused: false, pausedAt: 0, pauses: 0, pausedMs: 0, exited: false }
    this.sessions.set(opts.sessionId, entry)

    pty.onData((chunk) => {
      entry.pending += chunk
      entry.unacked += chunk.length
      if (!entry.paused && entry.unacked > HIGH_WATER) {
        entry.paused = true
        entry.pausedAt = Date.now()
        entry.pauses++
        pty.pause()
      }
      if (entry.timer === null) {
        // A keystroke's echo is a few bytes arriving on a quiet line. Coalescing exists
        // for floods, and a flood announces itself by the next chunk arriving inside the
        // window — so the first chunk after a quiet spell goes out at once, and only what
        // follows it is batched. Typing pays no timer at all; a build pays the same as before.
        const now = Date.now()
        const quiet = now - entry.lastFlushAt >= FLUSH_MS
        // A keystroke went in a moment ago: whatever comes back now is (or carries) its
        // echo, so it goes out at once even in the middle of a stream that would
        // otherwise batch it behind the bulk timer. Measured: a key typed while Claude
        // Code streamed waited the 12 ms timer plus a frame; now it waits neither.
        const echoing = now - entry.lastWriteAt < ECHO_MS
        if (FAST_FLUSH && (echoing || (quiet && !entry.bulk)) && entry.pending.length <= BULK_BYTES) {
          this.flush(entry)
          return
        }
        entry.timer = setTimeout(() => this.flush(entry), entry.bulk ? BULK_FLUSH_MS : FLUSH_MS)
      }
    })

    pty.onExit(({ exitCode, signal }) => {
      entry.exited = true
      this.flush(entry)
      this.sessions.delete(opts.sessionId)
      this.exitCb?.(opts.sessionId, exitCode, signal)
    })

    return session
  }

  private flush(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.pending.length === 0) return
    const data = entry.pending
    entry.pending = ''
    entry.lastFlushAt = Date.now()
    // Decided per flush rather than latched, so the first small flush after a build
    // finishes puts echo back on the fast path immediately.
    entry.bulk = data.length > BULK_BYTES
    this.dataCb?.(entry.session.sessionId, data)
  }

  write(sessionId: string, data: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.exited) return
    entry.lastWriteAt = Date.now()
    entry.pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.exited) return
    try {
      entry.pty.resize(Math.max(2, cols), Math.max(1, rows))
    } catch (err) {
      // A resize racing with shell exit throws; it is never worth crashing over.
      console.error(`[ember] resize failed for ${sessionId}: ${(err as Error).message}`)
    }
  }

  ack(sessionId: string, chars: number): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.unacked = Math.max(0, entry.unacked - chars)
    if (entry.paused && entry.unacked < LOW_WATER) {
      entry.paused = false
      entry.pausedMs += Date.now() - entry.pausedAt
      entry.pty.resume()
    }
  }

  stats(): Record<string, PtyStats> {
    const out: Record<string, PtyStats> = {}
    for (const [id, e] of this.sessions) {
      const live = e.paused ? Date.now() - e.pausedAt : 0
      out[id] = { unacked: e.unacked, paused: e.paused, pauses: e.pauses, pausedMs: e.pausedMs + live }
    }
    return out
  }

  kill(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
