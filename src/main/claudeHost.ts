import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { ClaudeEvent, ClaudeImage, ClaudeStartOptions, ClaudeStartResult } from '../shared/types.js'
import { killTree, resolveBin } from './agents.js'
import { bridgeEnv } from './bridge.js'
import { loadConfig, resolveHome } from './config.js'
import { NOTES_DIR } from './notes.js'
import { cleanEnv } from './pty/ConPtyHost.js'

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
  /** Questions Claude Code is waiting on, so a stop can answer them rather than leave them. */
  private readonly asked = new Set<string>()
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
    void this.control({ subtype: 'initialize', hooks: {}, supportedDialogKinds: [] }, INIT_TIMEOUT_MS).then((r) => {
      if (this.child !== child) return
      if (!r.ok) {
        this.emit({ tabId: this.tabId, kind: 'error', text: `Claude Code did not start: ${r.error ?? 'no answer'}` })
        return
      }
      this.ready = true
      for (const line of this.held.splice(0)) this.write(line)
      this.emit({ tabId: this.tabId, kind: 'ready', info: summarise(r.response ?? {}) })
    })
    return { ok: true, sessionId: this.sessionId, ...(child.pid ? { pid: child.pid } : {}) }
  }

  send(text: string, images?: ClaudeImage[]): void {
    const content: unknown =
      images && images.length
        ? [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
          ]
        : text
    const line = JSON.stringify({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content } })
    if (this.ready) this.write(line)
    else this.held.push(line)
  }

  interrupt(): Promise<{ ok: boolean; error?: string }> {
    if (!this.alive) return Promise.resolve({ ok: false, error: 'Claude Code is not running' })
    return this.control({ subtype: 'interrupt' }, CONTROL_TIMEOUT_MS).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error ?? 'no answer' }))
  }

  answer(requestId: string, response: Json): void {
    if (!this.asked.delete(requestId)) return
    this.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }))
  }

  /** Close stdin — Claude Code finishes what it is writing and exits — and kill it if it lingers. */
  stop(now = false): void {
    const child = this.child
    if (!child || this.stopping) return
    this.stopping = true
    // A question left open would hold the turn; say no to it on the way out.
    for (const id of [...this.asked]) this.answer(id, { behavior: 'deny', message: 'The tab was closed.' })
    if (now) {
      killTreeNow(child)
      return
    }
    try {
      child.stdin?.end()
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killTree(child)
    }, STOP_GRACE_MS)
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
    if (subtype === 'can_use_tool') {
      this.asked.add(id)
      this.emit({ tabId: this.tabId, kind: 'ask', requestId: id, request: req })
      return
    }
    const reply = (response: Json) =>
      this.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }))
    // An MCP server asking for input: not drawn yet, so declined rather than left waiting.
    if (subtype === 'elicitation') return reply({ action: 'decline' })
    this.write(
      JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `Ember does not handle ${subtype} yet` } })
    )
  }
}

/** The parts of the `initialize` answer the canvas uses, not the whole command list. */
function summarise(r: Json): Json {
  const account = (r['account'] ?? {}) as Json
  return {
    version: r['claude_code_version'] ?? '',
    permissionMode: r['current_permission_mode'] ?? '',
    subscription: account['subscriptionType'] ?? '',
    models: Array.isArray(r['models']) ? (r['models'] as Json[]).slice(0, 20) : [],
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

// ------------------------------------------------------------------ IPC

const hosts = new Map<string, ClaudeHost>()

/** @param extraBin folders put first on the process's PATH — `notes`, `ember` — as a tab's shell has. */
export function registerClaudeHost(extraBin: string[]): void {
  const broadcast = (e: ClaudeEvent) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('ember:claude:event', e)
  }
  // A window that goes (closed, reloaded) takes its tabs' processes with it.
  const owners = new WeakSet<WebContents>()
  const own = (wc: WebContents) => {
    if (owners.has(wc)) return
    owners.add(wc)
    wc.once('destroyed', () => {
      for (const h of hosts.values()) h.stop()
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
  ipcMain.on('ember:claude:send', (_e, tabId: string, text: string, images?: ClaudeImage[]) => hosts.get(tabId)?.send(String(text ?? ''), images))
  ipcMain.handle('ember:claude:interrupt', (_e, tabId: string) => hosts.get(tabId)?.interrupt() ?? { ok: false, error: 'no Claude in this tab' })
  ipcMain.on('ember:claude:answer', (_e, tabId: string, requestId: string, response: Json) => hosts.get(tabId)?.answer(String(requestId), response ?? {}))
  ipcMain.on('ember:claude:stop', (_e, tabId: string) => {
    hosts.get(tabId)?.stop()
    hosts.delete(tabId)
  })
  app.on('before-quit', () => {
    for (const h of hosts.values()) h.stop(true)
    hosts.clear()
  })
}
