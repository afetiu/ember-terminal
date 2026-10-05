import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AGENTS, AGENT_IDS, agentSpec, type AgentId, type AgentSpec, type AgentStatus } from '../shared/agents.js'
import { loadConfig } from './config.js'
import { cleanEnv } from './pty/ConPtyHost.js'

/**
 * The agent CLIs on this machine, and one way to ask any of them a question.
 *
 * Everything Ember does with a model goes through here: the map, check-todos, any
 * headless question. Which CLI answers is the person's choice (Settings › Agent), and
 * whichever it is runs as them, on their own sign-in — Ember holds no key and never
 * sees one.
 */

const HOME = homedir()

/**
 * Folders a CLI installer puts its command in that a PATH captured before the install
 * will not have. Ember reads PATH once, at launch; installing Codex from a tab and then
 * pressing Refresh has to find it without a restart.
 */
function extraDirs(): string[] {
  const appData = process.env['APPDATA'] ?? join(HOME, 'AppData', 'Roaming')
  const local = process.env['LOCALAPPDATA'] ?? join(HOME, 'AppData', 'Local')
  return [
    join(appData, 'npm'),
    join(local, 'cursor-agent'),
    join(HOME, '.local', 'bin'),
    join(HOME, '.opencode', 'bin'),
    join(HOME, '.claude', 'local'),
    join(local, 'Programs', 'claude'),
  ]
}

function searchDirs(): string[] {
  const env = cleanEnv()
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const dirs = (env[key] ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...dirs, ...extraDirs()])]
}

const EXTS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']

/** Where a command resolves, looking the way a shell would. No process is spawned. */
export function resolveBin(bin: string): string | null {
  for (const dir of searchDirs()) {
    for (const ext of EXTS) {
      const full = join(dir, bin + ext)
      if (ext === '' && process.platform === 'win32') continue
      if (existsSync(full)) return full
    }
  }
  return null
}

function resolveAgent(spec: AgentSpec): string | null {
  for (const bin of [spec.bin, ...(spec.altBins ?? [])]) {
    const found = resolveBin(bin)
    if (found) return found
  }
  return null
}

function version(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(`"${bin}" --version`, { shell: true, timeout: 8000, windowsHide: true, env: cleanEnv() }, (err, stdout) => {
      if (err) return resolve(undefined)
      const line = String(stdout).trim().split('\n')[0] ?? ''
      resolve(line.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? (line.slice(0, 40) || undefined))
    })
  })
}

/** Which agent CLIs are installed. `withVersions` spawns each one, so it costs a second or two. */
export async function detectAgents(withVersions = false): Promise<AgentStatus[]> {
  return Promise.all(
    AGENT_IDS.map(async (id): Promise<AgentStatus> => {
      const path = resolveAgent(AGENTS[id]) ?? undefined
      if (!path) return { id, installed: false }
      return { id, installed: true, path, version: withVersions ? await version(path) : undefined }
    })
  )
}

/** The agent Ember's own features run through: the chosen one. */
export function defaultAgent(): AgentId {
  return agentSpec(loadConfig().agent?.default).id
}

// ---------------------------------------------------------------------------
// One headless question
// ---------------------------------------------------------------------------

export interface AgentRun {
  child: ChildProcess
  done: Promise<{ ok: boolean; text: string; error?: string }>
}

export interface RunOptions {
  /** Defaults to the chosen agent. */
  agent?: AgentId
  cwd?: string
  timeoutMs: number
  /** A line of progress: a tool being used, or the first line of something it said. */
  onLine?: (line: string) => void
  /**
   * Per-agent flags that replace the agent's read-only defaults — the map gives Claude
   * its own list of allowed tools, for example. Absent, a run is read-only where the
   * CLI can be told so.
   */
  args?: Partial<Record<AgentId, string[]>>
  /** Extra environment for the child. */
  env?: Record<string, string>
  /**
   * An MCP server to attach for this one run, in whichever way the CLI takes one. It
   * inherits the child's environment, so anything it needs goes in `env`, listed in
   * `forward` for the CLIs (Codex) that pass MCP servers a filtered environment.
   */
  mcp?: {
    name: string
    /** The server script, run by Ember's own binary as node. */
    script: string
    /** A .cmd that does the same, for CLIs that can only be given a bare command. */
    launcher: string
    forward: string[]
  }
}

/**
 * The flags, environment and working folder that give one headless run an MCP server.
 *
 * Every CLI takes one differently, and none of the ways may put a double quote on the
 * command line (cmd.exe parses a .cmd shim's arguments a second time). JSON goes in a
 * file; Codex's `-c` values are TOML literal strings, which are single-quoted.
 */
function attachMcp(spec: AgentSpec, m: NonNullable<RunOptions['mcp']>, dir: string): { args: string[]; env: Record<string, string>; cwd?: string } {
  const server = { command: process.execPath, args: [m.script], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const file = (name: string, body: unknown) => {
    const p = join(dir, name)
    writeFileSync(p, JSON.stringify(body, null, 2), 'utf8')
    return p
  }
  switch (spec.id) {
    case 'claude':
      return { args: ['--mcp-config', file('mcp.json', { mcpServers: { [m.name]: server } })], env: {} }
    case 'codex':
      return {
        args: [
          '-c',
          `mcp_servers.${m.name}.command='${m.launcher}'`,
          '-c',
          `mcp_servers.${m.name}.env_vars=[${m.forward.map((v) => `'${v}'`).join(',')}]`,
        ],
        env: {},
      }
    case 'gemini': {
      // Gemini skips a system settings file the user could have written, and it will not
      // set ELECTRON_RUN_AS_NODE for a server or hand one any variable named like a
      // secret. So: a workspace of its own, the launcher, and the variables named as
      // `$VAR`, which Gemini fills in from its own environment. The workspace is trusted
      // by the variable, not by --skip-trust: the flag is read after settings are loaded,
      // so with it alone the workspace's servers are dropped as untrusted.
      const ws = join(dir, 'workspace')
      mkdirSync(join(ws, '.gemini'), { recursive: true })
      const env = Object.fromEntries(m.forward.map((v) => [v, `$${v}`]))
      writeFileSync(join(ws, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { [m.name]: { command: m.launcher, args: [], env, trust: true } } }, null, 2), 'utf8')
      return { args: [], env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' }, cwd: ws }
    }
    case 'opencode':
      return {
        args: [],
        env: { OPENCODE_CONFIG: file('opencode.json', { mcp: { [m.name]: { type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true } } }) },
      }
    case 'copilot':
      return {
        args: ['--additional-mcp-config', `@${file('copilot.json', { mcpServers: { [m.name]: { type: 'local', ...server, tools: ['*'] } } })}`, '--allow-tool', m.name],
        env: {},
      }
    case 'cursor': {
      // Cursor reads servers only from ~/.cursor or the workspace's .cursor folder, so the
      // run gets a workspace of its own holding just this one.
      const ws = join(dir, 'workspace')
      mkdirSync(join(ws, '.cursor'), { recursive: true })
      writeFileSync(join(ws, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { [m.name]: server } }, null, 2), 'utf8')
      return { args: ['--approve-mcps', '--workspace', ws], env: {}, cwd: ws }
    }
  }
}

function quoteArg(a: string): string {
  return /[\s"(),*&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

/** "Reading src/app.ts", "Running git log -5" — Claude Code's tool names, said plainly. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const short = (p: string) => p.replace(/\\/g, '/').replace(/^.*?\/Users\/[^/]+\//i, '~/')
  switch (name) {
    case 'Read':
      return `Reading ${short(s('file_path'))}`
    case 'Glob':
      return `Looking for ${s('pattern')}${s('path') ? ` in ${short(s('path'))}` : ''}`
    case 'Grep':
      return `Searching for ${s('pattern')}`
    case 'Bash':
      return `Running ${s('command').replace(/\s+/g, ' ').slice(0, 90)}`
    case 'WebFetch':
      return `Fetching ${s('url')}`
    case 'WebSearch':
      return `Searching the web: ${s('query')}`
    default:
      return name
  }
}

/**
 * Stdout, read the way this agent writes it. Returns the final answer once known, and
 * reports progress as it goes.
 */
function reader(spec: AgentSpec, onLine?: (line: string) => void) {
  let result: string | null = null
  let isError = false
  let lastText = ''
  let all = ''
  const say = (text: string) => {
    const first = text.trim().split('\n')[0] ?? ''
    if (first && !first.startsWith('```') && !first.startsWith('{')) onLine?.(first.slice(0, 140))
  }
  const line = (raw: string) => {
    if (spec.output === 'text') {
      all += raw + '\n'
      if (raw.trim()) onLine?.(raw.trim().slice(0, 140))
      return
    }
    if (!raw.trim()) return
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (spec.output === 'claude-stream') {
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as { content?: Array<Record<string, unknown>> } | undefined
        for (const c of msg?.content ?? []) {
          if (c['type'] === 'tool_use') onLine?.(describeTool(String(c['name']), (c['input'] as Record<string, unknown>) ?? {}))
          else if (c['type'] === 'text' && typeof c['text'] === 'string') {
            lastText = c['text']
            say(c['text'])
          }
        }
      } else if (ev['type'] === 'result') {
        result = typeof ev['result'] === 'string' ? ev['result'] : lastText
        isError = ev['is_error'] === true
      }
      return
    }
    // codex-jsonl
    const item = ev['item'] as Record<string, unknown> | undefined
    if (ev['type'] === 'item.started' && item?.['type'] === 'command_execution') {
      onLine?.(`Running ${String(item['command'] ?? '').replace(/\s+/g, ' ').slice(0, 90)}`)
    } else if (ev['type'] === 'item.completed' && item?.['type'] === 'agent_message' && typeof item['text'] === 'string') {
      lastText = item['text']
      say(item['text'])
    } else if (ev['type'] === 'turn.completed') {
      result = lastText
    } else if (ev['type'] === 'turn.failed' || ev['type'] === 'error') {
      isError = true
      const err = (ev['error'] as { message?: string } | undefined)?.message ?? ev['message']
      result = typeof err === 'string' ? err : 'the run failed'
    }
  }
  const finish = (): { result: string | null; isError: boolean; lastText: string } =>
    spec.output === 'text' ? { result: all.trim() || null, isError: false, lastText: all.trim() } : { result, isError, lastText }
  return { line, finish }
}

/**
 * Ask the chosen agent CLI one thing, headless.
 *
 * The prompt goes in on stdin where the CLI takes it, which spares it every quoting rule
 * cmd.exe has — the CLIs are .cmd shims as often as .exe, and only a shell finds either.
 * Where a CLI only takes the prompt as an argument, it is written to a file and the
 * argument is one plain sentence pointing at it, so nothing the prompt says can end a
 * quoted region and leak into the command line.
 */
export function runAgent(prompt: string, opts: RunOptions): AgentRun {
  const spec = agentSpec(opts.agent ?? defaultAgent())
  let cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : HOME
  const flags = [...(opts.args?.[spec.id] ?? spec.readOnly)]
  const runDir = join(tmpdir(), 'ember-agent', randomUUID())
  mkdirSync(runDir, { recursive: true })
  let mcpEnv: Record<string, string> = {}
  let mcpArgs: string[] = []
  if (opts.mcp) {
    const a = attachMcp(spec, opts.mcp, runDir)
    mcpArgs = a.args
    mcpEnv = a.env
    if (a.cwd) cwd = a.cwd
    // Claude Code asks before an MCP tool in -p mode unless it is allowed by name.
    if (spec.id === 'claude') {
      const at = flags.indexOf('--allowedTools')
      if (at >= 0 && at + 1 < flags.length) flags[at + 1] = `${flags[at + 1]},mcp__${opts.mcp.name}`
      else flags.push('--allowedTools', `mcp__${opts.mcp.name}`)
    }
  }
  // Codex's -c must come before `exec`; everyone else takes flags anywhere.
  const args = spec.id === 'codex' ? [...mcpArgs, ...spec.headless, ...flags] : [...spec.headless, ...flags, ...mcpArgs]

  let promptFile = ''
  if (spec.promptArg) {
    const dir = runDir
    promptFile = join(dir, `${randomUUID()}.md`)
    writeFileSync(promptFile, prompt, 'utf8')
    if (spec.promptFlag) args.push(spec.promptFlag)
    args.push(`Read the file ${promptFile} and do exactly what it asks. Its contents are your whole task.`)
  } else if (spec.id === 'codex') {
    args.push('-')
  }

  const bin = resolveAgent(spec)
  const exe = bin ? `"${bin}"` : spec.bin
  const child = spawn([exe, ...args.map(quoteArg)].join(' '), {
    shell: true,
    cwd,
    env: { ...cleanEnv(), EMBER_MAP_RUN: '1', ...opts.env, ...mcpEnv },
    windowsHide: true,
  })

  const done = new Promise<{ ok: boolean; text: string; error?: string }>((resolve) => {
    let buf = ''
    let stderr = ''
    const r = reader(spec, opts.onLine)
    const cleanup = () => rmSync(runDir, { recursive: true, force: true })
    const timer = setTimeout(() => {
      killTree(child)
      cleanup()
      resolve({ ok: false, text: '', error: `gave up after ${Math.round(opts.timeoutMs / 60000)} minutes` })
    }, opts.timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        r.line(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-2000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      cleanup()
      resolve({ ok: false, text: '', error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      if (buf) r.line(buf)
      const { result, isError, lastText } = r.finish()
      if (result !== null && !isError && (spec.output !== 'text' || code === 0)) return resolve({ ok: true, text: result })
      const notFound = /not recognized|not found/i.test(stderr) && !bin
      resolve({
        ok: false,
        text: result ?? lastText,
        error: notFound
          ? `${spec.name} is not installed — Settings › Agent can install it`
          : (isError ? result : stderr.trim()) || `${spec.bin} exited without an answer`,
      })
    })
  })
  if (spec.promptArg) child.stdin?.end()
  else child.stdin?.end(prompt, 'utf8')
  return { child, done }
}

/** cmd.exe sits between us and the CLI; killing it alone leaves the CLI running. */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  else child.kill('SIGTERM')
}

/** A one-line sanity check that the chosen agent answers — the onboarding's "Test" button. */
export async function pingAgent(id: AgentId): Promise<{ ok: boolean; text: string; error?: string; ms: number }> {
  const t0 = Date.now()
  const run = runAgent('Reply with exactly the word: ready', { agent: id, timeoutMs: 120_000 })
  const r = await run.done
  return { ...r, text: r.text.trim().slice(0, 200), ms: Date.now() - t0 }
}
