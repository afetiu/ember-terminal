import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { ClaudeControlRequest, ClaudeEvent, ClaudeImage, ClaudeSendOptions, ClaudeStartOptions, ClaudeStartResult, NativeTabState } from '../shared/types.js'
import { killTree, resolveBin } from './agents.js'
import { bridgeEnv } from './bridge.js'
import { CONFIG_DIR, loadConfig, resolveHome } from './config.js'
import { NOTES_DIR } from './notes.js'
import { cleanEnv } from './pty/ConPtyHost.js'
import { boundSession, projectSlug, transcriptFile } from './transcript.js'

/**
 * Claude Code in its structured mode, one process per canvas tab.
 *
 * The canvas used to read Claude Code's screen. With `canvas.native` on, a Claude tab runs
 * the same CLI the way the Agent SDK and the IDE extensions do: newline-delimited JSON on
 * stdin and stdout (docs/specs/claude-protocol-reference.md). Main owns the process; the
 * renderer is told what it says and tells it what to do, by tab id.
 *
 * It is the person's own `claude`, on their own sign-in, with what Ember gives every
 * Claude session in a tab: the panel's MCP server, Ember's settings file, the bridge's
 * variables. Nothing about it is a separate agent.
 *
 * One process stays up for the life of the tab. Startup costs seconds (hooks, MCP
 * servers), so it is never respawned per message.
 */

/** How long a request Ember sends may go unanswered. `initialize` waits on the user's hooks and MCP servers. */
const INIT_TIMEOUT_MS = 90_000
const CONTROL_TIMEOUT_MS = 15_000
/** After stdin closes, how long Claude Code gets to finish on its own. */
const STOP_GRACE_MS = 2_000

type Json = Record<string, unknown>

interface Pending {
  resolve: (r: { ok: boolean; response?: Json; error?: string }) => void
  timer: NodeJS.Timeout
}

class ClaudeHost {
  private child: ChildProcess | null = null
  private buf = ''
  private ready = false
  /** Messages sent before `initialize` was answered: Claude Code must hear that first. */
  private held: string[] = []
  private readonly pending = new Map<string, Pending>()
  /** Questions Claude Code is waiting on, by kind, so a stop can answer them rather than leave them. */
  private readonly asked = new Map<string, 'can_use_tool' | 'elicitation'>()
  private stopping = false
  sessionId = ''

  constructor(
    readonly tabId: string,
    private readonly emit: (e: ClaudeEvent) => void
  ) {}

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(opts: ClaudeStartOptions, extraBin: string[]): ClaudeStartResult {
    if (this.alive) return { ok: true, sessionId: this.sessionId, ...(this.pid ? { pid: this.pid } : {}) }
    const cwd = longCwd(opts.cwd)
    this.sessionId = opts.resume || randomUUID()
    const panel = bridgeEnv(this.tabId)
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      ...(opts.resume ? ['--resume', opts.resume] : ['--session-id', this.sessionId]),
      // What the `claude` shim gives a session in a tab: the panel, and Ember's settings
      // (the image hook; the status line rides along unused, there is no screen here).
      ...(panel['EMBER_MCP_CONFIG'] ? ['--mcp-config', panel['EMBER_MCP_CONFIG']] : []),
      ...(panel['EMBER_SETTINGS'] ? ['--settings', panel['EMBER_SETTINGS']] : []),
      // Probes only: a model for the real run (`--model haiku`), never set by the app.
      ...(process.env['EMBER_CLAUDE_ARGS'] ?? '').split(/\s+/).filter(Boolean),
    ]

    const profile = (() => {
      const c = loadConfig()
      return c.profiles.find((p) => p.id === c.defaultProfile) ?? c.profiles[0]
    })()
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      ...(profile?.env ?? {}),
      EMBER_NOTES_DIR: NOTES_DIR,
      EMBER_SURFACE: 'canvas',
      ...panel,
      TERM_PROGRAM: 'Ember',
      // The value the Agent SDK sets; known to work on this channel.
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    }
    delete env['NODE_OPTIONS']
    if (extraBin.length) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
      env[key] = [...extraBin, env[key] ?? ''].filter(Boolean).join(delimiter)
    }

    // EMBER_CLAUDE_BIN points a probe at a stand-in that speaks the protocol.
    const bin = process.env['EMBER_CLAUDE_BIN'] || resolveBin('claude')
    if (!bin) return { ok: false, error: 'Claude Code is not installed — Settings › Agent can install it' }
    let child: ChildProcess
    try {
      const ext = extname(bin).toLowerCase()
      if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
        child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
      } else if (ext === '.cmd' || ext === '.bat') {
        // An npm shim: only a shell runs it. Every argument here is a flag or a path.
        child = spawn([`"${bin}"`, ...args.map(quoteArg)].join(' '), { cwd, env, shell: true, windowsHide: true })
      } else {
        child = spawn(bin, args, { cwd, env, windowsHide: true })
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.child = child
    this.ready = false
    this.stopping = false
    this.buf = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.read(d))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      const text = d.trim()
      if (text) this.emit({ tabId: this.tabId, kind: 'stderr', text: text.slice(-4000) })
    })
    child.stdin?.on('error', () => {
      /* a write after the process went: the exit event says so */
    })
    child.on('error', (err) => {
      this.emit({ tabId: this.tabId, kind: 'error', text: err.message })
      // A process that never started has no exit to report.
      if (this.child === child && !child.pid) {
        this.child = null
        this.emit({ tabId: this.tabId, kind: 'exit', code: null, signal: null })
      }
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      if (this.buf.trim()) this.line(this.buf)
      this.buf = ''
      this.child = null
      this.ready = false
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve({ ok: false, error: 'Claude Code stopped' })
      }
      this.pending.clear()
      this.asked.clear()
      this.emit({ tabId: this.tabId, kind: 'exit', code, signal: signal ?? null })
    })

    // `initialize` goes first, before anything else is written.
    void this.control({ subtype: 'initialize', hooks: {}, supportedDialogKinds: [] }, INIT_TIMEOUT_MS).then(async (r) => {
      if (this.child !== child) return
      if (!r.ok) {
        this.emit({ tabId: this.tabId, kind: 'error', text: `Claude Code did not start: ${r.error ?? 'no answer'}` })
        return
      }
      const info = summarise(r.response ?? {})
      // Before the first message goes: the mode the TUI would start in, the effort the
      // settings give, the name the session already has.
      const said = opts.resume ? sessionFacts(transcriptFile(opts.resume, cwd)) : { title: '', mode: '' }
      const settings = await this.control({ subtype: 'get_settings' }, CONTROL_TIMEOUT_MS)
      if (this.child !== child) return
      const eff = (settings.ok ? ((settings.response?.['effective'] ?? {}) as Json) : {}) as Json
      const level = String(eff['effortLevel'] ?? '')
      if (EFFORTS.has(level)) info['effort'] = level
      if (said.title) info['title'] = said.title
      const want = startMode(opts.followMode ? said.mode : '', !!((eff['permissions'] ?? {}) as Json)['defaultMode'])
      if (want && want !== info['permissionMode']) {
        const m = await this.control({ subtype: 'set_permission_mode', mode: want }, CONTROL_TIMEOUT_MS)
        if (this.child !== child) return
        if (m.ok) info['permissionMode'] = want
      }
      this.ready = true
      for (const line of this.held.splice(0)) this.write(line)
      this.emit({ tabId: this.tabId, kind: 'ready', info })
    })
    return { ok: true, sessionId: this.sessionId, ...(child.pid ? { pid: child.pid } : {}) }
  }

  send(text: string, images?: ClaudeImage[], opts?: ClaudeSendOptions): void {
    const pics = (images ?? []).filter((i) => IMAGE_TYPES.has(i?.mediaType) && typeof i.data === 'string' && i.data.length > 0)
    const context = (opts?.context ?? []).filter((c): c is string => typeof c === 'string' && c.length > 0)
    const content: unknown =
      pics.length || context.length
        ? [
            ...context.map((t) => ({ type: 'text', text: t })),
            ...(text ? [{ type: 'text', text }] : []),
            ...pics.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
          ]
        : text
    // The canvas's own uuid when it gave one: Claude Code echoes it back, which is how the
    // message it already shows is matched to the echo and to the queue's lifecycle.
    const uuid = typeof opts?.uuid === 'string' && UUID_RE.test(opts.uuid) ? opts.uuid : randomUUID()
    const line = JSON.stringify({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content } })
    if (this.ready) this.write(line)
    else this.held.push(line)
  }

  interrupt(): Promise<{ ok: boolean; error?: string }> {
    if (!this.alive) return Promise.resolve({ ok: false, error: 'Claude Code is not running' })
    return this.control({ subtype: 'interrupt' }, CONTROL_TIMEOUT_MS).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error ?? 'no answer' }))
  }

  /** A control request from the canvas: only the kinds it needs, each with only its own fields. */
  ask(req: ClaudeControlRequest): Promise<{ ok: boolean; response?: Json; error?: string }> {
    if (!this.alive) return Promise.resolve({ ok: false, error: 'Claude Code is not running' })
    const clean = sanitizeControl(req)
    if (!clean) return Promise.resolve({ ok: false, error: 'not a request the canvas may send' })
    return this.control(clean, CONTROL_TIMEOUT_MS)
  }

  answer(requestId: string, response: Json): void {
    if (!this.asked.delete(requestId)) return
    this.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }))
  }

  /**
   * Close stdin — Claude Code finishes what it is writing and exits — and kill it if it
   * lingers. Resolves once the process has gone (the CLI view waits on it: one process
   * owns a session at a time).
   */
  stop(now = false): Promise<void> {
    const child = this.child
    if (!child) return Promise.resolve()
    const gone = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', () => resolve())
      setTimeout(resolve, STOP_GRACE_MS + 3_000)
    })
    if (this.stopping) return gone
    this.stopping = true
    // A question left open would hold the turn; say no to it on the way out.
    for (const [id, kind] of [...this.asked]) this.answer(id, kind === 'elicitation' ? { action: 'decline' } : { behavior: 'deny', message: 'The tab was closed.' })
    if (now) {
      killTreeNow(child)
      return gone
    }
    try {
      child.stdin?.end()
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killTree(child)
    }, STOP_GRACE_MS)
    return gone
  }

  // ------------------------------------------------------------- the wire

  private write(line: string): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return
    stdin.write(line + '\n', 'utf8')
  }

  /** A request of Ember's, matched to its answer by id. */
  private control(request: Json, timeoutMs: number): Promise<{ ok: boolean; response?: Json; error?: string }> {
    const id = `ember_${randomUUID()}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: `no answer to ${String(request['subtype'])} in ${Math.round(timeoutMs / 1000)}s` })
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      // Control requests never wait on `initialize` — only user messages do.
      this.write(JSON.stringify({ type: 'control_request', request_id: id, request }))
    })
  }

  /** Stdout arrives in pieces; a message is a whole line, however it was cut. */
  private read(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.line(line)
    }
  }

  private line(raw: string): void {
    const text = raw.replace(/\r$/, '').trim()
    if (!text) return
    let msg: Json
    try {
      msg = JSON.parse(text) as Json
    } catch {
      // Not ours to understand: shown as what it printed, never fatal.
      this.emit({ tabId: this.tabId, kind: 'stderr', text: text.slice(0, 2000) })
      return
    }
    if (!msg || typeof msg !== 'object') return
    switch (msg['type']) {
      case 'control_response': {
        const r = (msg['response'] ?? {}) as Json
        const id = String(r['request_id'] ?? '')
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (r['subtype'] === 'success') p.resolve({ ok: true, response: (r['response'] ?? {}) as Json })
        else p.resolve({ ok: false, error: String(r['error'] ?? 'failed') })
        return
      }
      case 'control_request':
        this.request(String(msg['request_id'] ?? ''), (msg['request'] ?? {}) as Json)
        return
      case 'control_cancel_request': {
        const id = String(msg['request_id'] ?? '')
        if (this.asked.delete(id)) this.emit({ tabId: this.tabId, kind: 'cancel', requestId: id })
        return
      }
      case 'keep_alive':
        return
      case 'stream_event': {
        // Only what the canvas draws from: the text as it is written, and where blocks
        // start and stop. Tool input deltas are many and the full call follows anyway.
        const ev = (msg['event'] ?? {}) as Json
        const delta = (ev['delta'] ?? {}) as Json
        if (ev['type'] === 'content_block_delta' && delta['type'] !== 'text_delta') return
        if (ev['type'] === 'message_delta') return
        break
      }
    }
    if (msg['type'] === 'system' && msg['subtype'] === 'init' && typeof msg['session_id'] === 'string') this.sessionId = msg['session_id']
    // Everything else — known or not — goes to the canvas, which ignores what it does not draw.
    this.emit({ tabId: this.tabId, kind: 'message', msg })
  }

  /** Claude Code asking Ember something. Only a tool permission is the person's to answer. */
  private request(id: string, req: Json): void {
    if (!id) return
    const subtype = String(req['subtype'] ?? '')
    // A tool permission, Claude's question or plan (they come as tool permissions), or an
    // MCP server asking for input: each is a card on the canvas, answered from there.
    if (subtype === 'can_use_tool' || subtype === 'elicitation') {
      this.asked.set(id, subtype)
      this.emit({ tabId: this.tabId, kind: 'ask', requestId: id, request: req })
      return
    }
    this.write(
      JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `Ember does not handle ${subtype} yet` } })
    )
  }
}

/** The parts of the `initialize` answer the canvas uses, not the whole command list. */
function summarise(r: Json): Json {
  const account = (r['account'] ?? {}) as Json
  const commands = Array.isArray(r['commands'])
    ? (r['commands'] as Json[])
        .filter((c) => c && typeof c['name'] === 'string')
        .slice(0, 500)
        .map((c) => ({
          name: String(c['name']),
          description: String(c['description'] ?? '').slice(0, 300),
          argumentHint: String(c['argumentHint'] ?? ''),
          ...(Array.isArray(c['aliases']) ? { aliases: (c['aliases'] as unknown[]).map(String).slice(0, 8) } : {}),
        }))
    : []
  return {
    version: r['claude_code_version'] ?? '',
    permissionMode: r['current_permission_mode'] ?? '',
    subscription: account['subscriptionType'] ?? '',
    models: Array.isArray(r['models']) ? (r['models'] as Json[]).slice(0, 20) : [],
    commands,
    capabilities: Array.isArray(r['capabilities']) ? (r['capabilities'] as unknown[]).map(String) : [],
  }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'])
const MODEL_RE = /^[\w.:\-[\]]{1,100}$/
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Rebuilds a canvas control request from its known fields only; null for anything else. */
function sanitizeControl(req: ClaudeControlRequest): Json | null {
  if (!req || typeof req !== 'object') return null
  switch (req.subtype) {
    case 'file_suggestions':
      return { subtype: 'file_suggestions', query: String(req.query ?? '').slice(0, 300) }
    case 'cancel_async_message':
      return UUID_RE.test(String(req.message_uuid)) ? { subtype: 'cancel_async_message', message_uuid: req.message_uuid } : null
    case 'interrupt':
      return { subtype: 'interrupt', ...(req.cancel_queued === true ? { cancel_queued: true } : {}) }
    case 'set_permission_mode':
      // Bypass is never switched on from the canvas: that stays a choice made at launch.
      return MODES.has(String(req.mode)) ? { subtype: 'set_permission_mode', mode: req.mode } : null
    case 'get_context_usage':
      return { subtype: 'get_context_usage' }
    case 'set_model':
      // A model id or alias as `initialize.models` lists them ('default', 'sonnet[1m]', 'claude-haiku-5-5'), or null.
      if (req.model === null) return { subtype: 'set_model', model: null }
      return typeof req.model === 'string' && MODEL_RE.test(req.model) ? { subtype: 'set_model', model: req.model } : null
    case 'rename_session': {
      // A name from the tab's own rename: one line, as /rename takes it.
      const title = String(req.title ?? '').replace(/[\0-\x1f]/g, ' ').trim().slice(0, 120)
      return title ? { subtype: 'rename_session', title, source: 'host' } : null
    }
    case 'apply_flag_settings': {
      const level = String(req.settings?.effortLevel ?? '')
      return EFFORTS.has(level) ? { subtype: 'apply_flag_settings', settings: { effortLevel: level } } : null
    }
    default:
      return null
  }
}

/**
 * The folder as its long path. An 8.3 short path (`C:\Users\AGON-M~1\…`) makes Claude
 * Code treat ordinary writes as suspicious and ask about each one.
 */
function longCwd(cwd: string | undefined): string {
  const c = loadConfig()
  const profile = c.profiles.find((p) => p.id === c.defaultProfile) ?? c.profiles[0]
  const dir = resolveHome(cwd || profile?.cwd)
  try {
    if (existsSync(dir)) return realpathSync.native(dir)
  } catch {
    /* fall through */
  }
  return homedir()
}

function quoteArg(a: string): string {
  return /[\s"(),*&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

/** On the way out there is no later: the tree goes now, synchronously. */
function killTreeNow(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}

// ------------------------------------------------------------------ what a session starts with

/**
 * What the transcript knows that structured mode does not say on `--resume`: the name the
 * session was given (`/rename`, `/name`, a rename from the tab) and the permission mode it
 * was last in. Read once per start; a transcript is a few MB at most.
 */
function sessionFacts(file: string): { title: string; mode: string } {
  let title = ''
  let mode = ''
  try {
    if (!existsSync(file) || statSync(file).size > 64 * 1024 * 1024) return { title, mode }
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('"custom-title"')) {
        try {
          const o = JSON.parse(line) as Json
          if (o['type'] === 'custom-title' && typeof o['customTitle'] === 'string') title = o['customTitle']
        } catch {
          /* a torn line */
        }
      }
      const m = /"permissionMode":"([a-zA-Z]+)"/.exec(line)
      if (m) mode = m[1]!
    }
  } catch {
    /* unreadable: nothing known */
  }
  return { title: title.slice(0, 120), mode }
}

/**
 * The permission mode Claude Code's own screen starts in, so a Claude tab starts the same.
 *
 * Structured mode applies `permissions.defaultMode` from the settings itself; without one
 * it starts in `default`, while the TUI may start elsewhere (on accounts where auto mode is
 * the default, it starts in auto). Neither the protocol nor the settings say which, so it
 * is read off the newest session the TUI itself started (`"entrypoint":"cli"`): the mode
 * of its first message. Back from the CLI view the session goes on in the mode the TUI
 * left it in. Bypass is never chosen here: only a launch flag or the settings start it.
 */
function startMode(followed: string, settingsSay: boolean): string {
  if (MODES.has(followed)) return followed
  if (settingsSay) return ''
  void refreshTuiMode()
  return MODES.has(tuiMode) ? tuiMode : ''
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
let tuiMode = ''
let tuiModeAt = 0
let tuiModeRun: Promise<void> | null = null

/** Find the TUI's starting mode in the background; at most every ten minutes. */
function refreshTuiMode(): Promise<void> {
  if (tuiModeRun) return tuiModeRun
  if (Date.now() - tuiModeAt < 10 * 60_000) return Promise.resolve()
  tuiModeRun = (async () => {
    try {
      const files: Array<{ path: string; at: number }> = []
      for (const dir of await readdir(PROJECTS_DIR).catch(() => [] as string[])) {
        const names = await readdir(join(PROJECTS_DIR, dir)).catch(() => [] as string[])
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue
          const path = join(PROJECTS_DIR, dir, n)
          const st = await stat(path).catch(() => null)
          if (st) files.push({ path, at: st.mtimeMs })
        }
      }
      files.sort((a, b) => b.at - a.at)
      for (const f of files.slice(0, 60)) {
        const head = readHead(f.path, 256 * 1024)
        if (!head.includes('"entrypoint":"cli"')) continue
        const line = head.split('\n').find((l) => l.includes('"entrypoint":"cli"') && l.includes('"permissionMode"'))
        const m = line ? /"permissionMode":"([a-zA-Z]+)"/.exec(line) : null
        if (m) {
          tuiMode = m[1]!
          break
        }
      }
    } finally {
      tuiModeAt = Date.now()
      tuiModeRun = null
    }
  })()
  return tuiModeRun
}

function readHead(file: string, bytes: number): string {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/**
 * The session in a folder whose transcript was written last, at or after `since`: where
 * the CLI view's Claude Code ended up (`/clear` and `/resume` move it to another file).
 */
async function latestSession(cwd: string, since: number): Promise<string> {
  if (!cwd || /[\0\r\n]/.test(cwd)) return ''
  const dir = join(PROJECTS_DIR, projectSlug(cwd))
  let best = ''
  let at = since - 1500
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(n)
    if (!m || !UUID_RE.test(m[1]!)) continue
    const st = await stat(join(dir, n)).catch(() => null)
    if (st && st.mtimeMs >= at) {
      at = st.mtimeMs
      best = m[1]!
    }
  }
  return best
}

// ------------------------------------------------------------------ tabs across restarts

/**
 * The native tabs, so that after a restart each comes back on its own session
 * (`--resume <id>`). Only this: a session id and a folder per tab, in order. Unlike the
 * old scrollback replay (state.ts), what comes back is the live session itself.
 */
const NATIVE_TABS = join(CONFIG_DIR, 'native-tabs.json')
const MAX_TABS = 30

function cleanTabs(raw: unknown): NativeTabState[] {
  if (!Array.isArray(raw)) return []
  const out: NativeTabState[] = []
  for (const t of raw.slice(0, MAX_TABS)) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const sessionId = typeof r['sessionId'] === 'string' && UUID_RE.test(r['sessionId']) ? r['sessionId'] : ''
    const cwd = typeof r['cwd'] === 'string' && r['cwd'].length < 1000 && !/[\0\r\n]/.test(r['cwd']) ? r['cwd'] : ''
    const title = typeof r['title'] === 'string' ? r['title'].replace(/[\0-\x1f]/g, ' ').trim().slice(0, 120) : ''
    out.push({ sessionId, cwd, ...(title ? { title } : {}) })
  }
  return out
}

function saveNativeTabs(raw: unknown): void {
  try {
    writeFileSync(NATIVE_TABS, JSON.stringify(cleanTabs(raw), null, 2))
  } catch (err) {
    console.error(`[ember] could not save native tabs: ${(err as Error).message}`)
  }
}

function loadNativeTabs(): NativeTabState[] {
  try {
    return existsSync(NATIVE_TABS) ? cleanTabs(JSON.parse(readFileSync(NATIVE_TABS, 'utf8'))) : []
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ IPC

const hosts = new Map<string, ClaudeHost>()

/** @param extraBin folders put first on the process's PATH — `notes`, `ember` — as a tab's shell has. */
export function registerClaudeHost(extraBin: string[]): void {
  // Ready before the first tab asks (see startMode).
  setTimeout(() => void refreshTuiMode(), 3_000)
  const broadcast = (e: ClaudeEvent) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('ember:claude:event', e)
  }
  // A window that goes (closed, reloaded) takes its tabs' processes with it.
  const owners = new WeakSet<WebContents>()
  const own = (wc: WebContents) => {
    if (owners.has(wc)) return
    owners.add(wc)
    wc.once('destroyed', () => {
      for (const h of hosts.values()) void h.stop()
      hosts.clear()
    })
  }

  ipcMain.handle('ember:claude:start', (e, tabId: string, opts: ClaudeStartOptions) => {
    own(e.sender)
    let h = hosts.get(tabId)
    if (!h) {
      h = new ClaudeHost(String(tabId), broadcast)
      hosts.set(tabId, h)
    }
    return h.start(opts ?? {}, extraBin)
  })
  ipcMain.on('ember:claude:send', (_e, tabId: string, text: string, images?: ClaudeImage[], opts?: ClaudeSendOptions) =>
    hosts.get(tabId)?.send(String(text ?? ''), Array.isArray(images) ? images : undefined, opts && typeof opts === 'object' ? opts : undefined)
  )
  ipcMain.handle('ember:claude:interrupt', (_e, tabId: string) => hosts.get(tabId)?.interrupt() ?? { ok: false, error: 'no Claude in this tab' })
  ipcMain.handle('ember:claude:control', (_e, tabId: string, request: ClaudeControlRequest) =>
    hosts.get(tabId)?.ask(request) ?? { ok: false, error: 'no Claude in this tab' }
  )
  ipcMain.on('ember:claude:answer', (_e, tabId: string, requestId: string, response: Json) => hosts.get(tabId)?.answer(String(requestId), response ?? {}))
  ipcMain.handle('ember:claude:stop', async (_e, tabId: string) => {
    const h = hosts.get(tabId)
    hosts.delete(tabId)
    await h?.stop()
  })
  ipcMain.on('ember:claude:saveTabs', (_e, tabs: unknown) => saveNativeTabs(tabs))
  ipcMain.handle('ember:claude:savedTabs', () => loadNativeTabs())
  ipcMain.handle('ember:claude:bound', (_e, tabId: string) => boundSession(String(tabId)))
  ipcMain.handle('ember:claude:latest', (_e, cwd: string, since: number) => latestSession(String(cwd ?? ''), Number(since) || 0))
  app.on('before-quit', () => {
    for (const h of hosts.values()) void h.stop(true)
    hosts.clear()
  })
}
