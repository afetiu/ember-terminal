import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import type { ClaudeStatus, PanelAct, PanelOption, PanelPush } from '../shared/types.js'
import { renderPanelDocument, setViewLoader } from './panelDoc.js'
import { BUILTIN_VIEWS } from './panelView.js'
import { resourcePath } from './resources.js'
import { bindSession, rebindFromStatus, unbindSession } from './transcript.js'
import { forget, recall, remember, skills } from './brain.js'
import { registerMedia, requestAnnotate, requestCanvasPoint, screenOf, serveMedia } from './canvas.js'
import { createNote, deleteNote, listNotes, NOTES_DIR, readNote, readTodo, saveNote, TODO_FILE, writeTodo } from './notes.js'
import { CONFIG_DIR, loadConfig } from './config.js'
import { homedir } from 'node:os'
import { deskAct, deskEnv, deskHideCallout, deskLook, deskPoint, deskState, haltDesk, onActivity, resumeDesk, setDeskBridge, startDesk, stopDesk } from './desk.js'
import type { DeskActivity } from '../shared/types.js'

/**
 * The bridge: how a Claude session inside a tab reaches that tab's panel.
 *
 * The session runs in a pty as the real CLI, so there is no in-process channel to it —
 * whatever it starts is a grandchild of a shell. A loopback HTTP server is the one
 * thing every such descendant can find with nothing but an environment variable, and
 * the MCP server the CLI spawns inherits that variable for free.
 *
 * Two directions cross it. Inbound: a session POSTs a panel. Outbound: the panel's
 * webview GETs the document to display. The second is why this is a server and not a
 * socket — the rendered page needs a real origin so the webview has somewhere to load
 * from, and an origin that is not the renderer's is exactly what keeps model-authored
 * HTML away from `window.ember`.
 */

let server: Server | null = null
let port = 0
let token = ''

/** Latest content per tab. Kept so a panel that opens late still has something to show. */
const stacks = new Map<string, PanelPush[]>()
const MAX_PER_TAB = 20
/**
 * Loom tabs keep what they were shown: every push is a piece of the conversation that
 * stays on the canvas, and its frame must still be able to load its document. So their
 * stacks are far deeper and a `replace` does not empty them.
 */
const MAX_PER_CANVAS_TAB = 400
const canvasTabs = new Set<string>()

export function markCanvasTab(tabId: string, on: boolean): void {
  if (on) canvasTabs.add(tabId)
  else canvasTabs.delete(tabId)
}

let mcpConfig = ''
/** The `--settings` file the shim passes: a status line and nothing else. */
let settingsFile = ''
/** The user's own status line command, if their settings have one, to run inside ours. */
let innerStatusLine = ''

/**
 * Write the settings file that gives an Ember session a status line.
 *
 * The command is a .cmd wrapper rather than a `node …` line because nothing here may
 * assume node is on PATH — the native Claude Code installer needs none — and the app
 * binary running as node is what the panel's MCP server already does. Forward slashes
 * in the path because Claude Code runs the command through a shell that may be bash.
 *
 * If the user has a status line of their own, its command is carried to the script by
 * environment (see bridgeEnv) and run with the same stdin, so Ember's line replaces
 * nothing: theirs still shows, and the bridge still hears.
 */
function writeSettings(): string {
  const dir = join(app.getPath('temp'), `ember-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const cmd = join(dir, 'ember-statusline.cmd')
  writeFileSync(
    cmd,
    ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${process.execPath}" "${resourcePath('statusline.mjs')}"`].join('\r\n') +
      '\r\n',
    'utf8'
  )
  // The image hook (resources/image-hook.mjs): screenshots and pictures the session sees,
  // onto the panel. `async` so Claude never waits on it.
  const hook = join(dir, 'ember-image-hook.cmd')
  writeFileSync(
    hook,
    ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${process.execPath}" "${resourcePath('image-hook.mjs')}"`].join('\r\n') +
      '\r\n',
    'utf8'
  )
  const imageHook = { type: 'command', command: hook.replace(/\\/g, '/'), async: true, timeout: 30 }
  const file = join(dir, 'ember-settings.json')
  writeFileSync(
    file,
    JSON.stringify(
      {
        statusLine: { type: 'command', command: cmd.replace(/\\/g, '/'), padding: 0 },
        hooks: {
          PostToolUse: [{ matcher: 'Read|mcp__.*', hooks: [imageHook] }],
          Stop: [{ hooks: [imageHook] }],
        },
      },
      null,
      2
    ),
    'utf8'
  )
  return file
}

/** The status line command in the user's own Claude Code settings, or ''. */
function readUserStatusLine(): string {
  try {
    const dir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
    const file = join(dir, 'settings.json')
    if (!existsSync(file)) return ''
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { statusLine?: { type?: unknown; command?: unknown } }
    const sl = raw.statusLine
    return sl && sl.type === 'command' && typeof sl.command === 'string' ? sl.command : ''
  } catch {
    return ''
  }
}

/** The status line JSON, as Claude Code sends it, reduced to what the card shows. */
function statusFrom(tabId: string, raw: Record<string, unknown>): ClaudeStatus {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
  const model = obj(raw['model'])
  const ctx = obj(raw['context_window'])
  const cost = obj(raw['cost'])
  const cache = obj(raw['prompt_cache'])
  return {
    tabId,
    sessionId: String(raw['session_id'] ?? ''),
    model: String(model['display_name'] ?? model['id'] ?? ''),
    contextPercent: num(ctx['used_percentage']),
    contextSize: num(ctx['context_window_size']),
    costUsd: num(cost['total_cost_usd']),
    durationMs: num(cost['total_duration_ms']),
    cacheWarm: typeof cache['warm'] === 'boolean' ? cache['warm'] : null,
    at: Date.now(),
  }
}

/**
 * Write the `--mcp-config` file the `claude` shim points at.
 *
 * It holds no secret: the token reaches the MCP server by inheritance from the shell,
 * not through this file, so a stale copy on disk grants nothing. `ELECTRON_RUN_AS_NODE`
 * is set here rather than in the shell's environment because it must apply to this one
 * child and to nothing else the user runs.
 */
/**
 * The same server, described the way each of the other agent CLIs wants it. None of them
 * holds a secret either: the bridge token reaches the server by inheritance from the
 * shell, exactly as it does for Claude Code.
 */
let agentMcp: Record<string, string> = {}

function writeAgentMcpConfigs(dir: string): Record<string, string> {
  const exe = process.execPath
  const mjs = resourcePath('mcp-panel.mjs')
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  const out: Record<string, string> = {}
  const put = (name: string, envVar: string, body: unknown) => {
    const file = join(dir, name)
    writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
    out[envVar] = file
  }
  // Gemini CLI gets none: since 0.6x it skips a system settings file in any folder the
  // user can write to, which is every folder Ember has, and says so on each start.
  // OpenCode: an extra config file named by OPENCODE_CONFIG, merged with theirs.
  put('opencode.json', 'EMBER_OPENCODE_CONFIG', {
    $schema: 'https://opencode.ai/config.json',
    mcp: { 'ember-panel': { type: 'local', command: [exe, mjs], environment: env, enabled: true } },
  })
  // Copilot CLI: --additional-mcp-config @file.
  put('copilot-mcp.json', 'EMBER_COPILOT_MCP', {
    mcpServers: { 'ember-panel': { type: 'local', command: exe, args: [mjs], env, tools: ['*'] } },
  })
  // Codex takes -c overrides, and a bare command with no inline table is the only shape
  // that survives cmd.exe's second parse; the launcher carries ELECTRON_RUN_AS_NODE.
  out['EMBER_MCP_LAUNCHER'] = join(CONFIG_DIR, 'bin', 'ember-mcp.cmd')
  return out
}

function writeMcpConfig(): string {
  const dir = join(app.getPath('temp'), `ember-${process.pid}`)
  const file = join(dir, 'mcp-panel.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        mcpServers: {
          'ember-panel': {
            command: process.execPath,
            args: [resourcePath('mcp-panel.mjs')],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          },
        },
      },
      null,
      2
    ),
    'utf8'
  )
  return file
}

/**
 * The same push the HTTP route performs, callable from main. For probes only: it lets a
 * script open a real panel — a document the bridge holds and the webview loads — without
 * a bridge token, which only a shell spawned by Ember is given.
 */
export function pushFromMain(body: Record<string, unknown>): { ok: boolean; id?: string; error?: string } {
  const result = handlePush(body)
  if (!result.ok) return { ok: false, error: result.error }
  const { act: _act, ...forRenderer } = result.push
  broadcast('ember:panel:push', forRenderer)
  return { ok: true, id: result.push.id }
}

/**
 * `ember <words>` in flight: the shell is waiting on the HTTP response, the renderer is
 * running the command; its reply (over IPC, by request id) releases the response.
 */
const orchWaiters = new Map<string, (result: string) => void>()

export function resolveOrchTool(reqId: string, result: string): void {
  const done = orchWaiters.get(reqId)
  orchWaiters.delete(reqId)
  done?.(result)
}

/** What a headless orchestrator run needs to reach the bridge: it is spawned by main, not a shell. */
export function orchEnv(run: string): Record<string, string> {
  return port ? { EMBER_BRIDGE_URL: `http://127.0.0.1:${port}`, EMBER_BRIDGE_TOKEN: token, EMBER_ORCH_RUN: run } : {}
}

const cmdWaiters = new Map<string, (r: { result: string; error?: string }) => void>()

export function resolveCmd(reqId: string, r: { result: string; error?: string }): void {
  const done = cmdWaiters.get(reqId)
  cmdWaiters.delete(reqId)
  done?.(r)
}

export function bridgeEnv(tabId: string): Record<string, string> {
  if (!server || !port) return {}
  return {
    EMBER_BRIDGE_URL: `http://127.0.0.1:${port}`,
    EMBER_BRIDGE_TOKEN: token,
    EMBER_TAB_ID: tabId,
    EMBER_MCP_CONFIG: mcpConfig,
    ...agentMcp,
    // Where the notes are, so the MCP server can say so in its instructions and a
    // session that would rather grep the folder than call a tool can do that instead.
    EMBER_NOTES_DIR: NOTES_DIR,
    // Computer use: the port and token `desk` needs. Only a shell Ember spawned has them.
    ...deskEnv(),
    // The status line, when the setting is on. Read at spawn time so a change in
    // Settings applies to the next shell without a restart.
    ...(settingsFile && loadConfig().claude.statusLine ? { EMBER_SETTINGS: settingsFile } : {}),
    ...(innerStatusLine ? { EMBER_STATUSLINE_INNER: innerStatusLine } : {}),
  }
}

export function bridgeOrigin(): string {
  return port ? `http://127.0.0.1:${port}` : ''
}

/** Constant-time compare that cannot throw on a length mismatch. */
function tokenOk(req: IncomingMessage): boolean {
  const given = String(req.headers['x-ember-token'] ?? '')
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: ServerResponse, code: number, body: string, type = 'application/json'): void {
  res.writeHead(code, {
    'content-type': type,
    // Nothing here is for a browser at large; the panel webview loads it directly.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

async function readJson(req: IncomingMessage, limit = 4_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // A panel is a thing you read, not a payload. Cap it well above any real document.
    if (size > limit) throw new Error('payload too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const FORMATS = new Set(['markdown', 'code', 'mermaid', 'html', 'url', 'ask', 'view'])

/**
 * Images a tab's session has seen or shown, newest first.
 *
 * The panel cannot load a file:// path — its page lives on the bridge's origin — so each
 * image is registered here under a random id and served from /img/<id>, the same way a
 * document is served from /doc/<id>. Bytes that arrived as base64 are written to a file
 * in the session's temp folder; a path that was already a file is served where it is.
 */
interface ImageEntry {
  id: string
  file: string
  mime: string
  source: string
  caption: string
  at: number
  hash: string
}
const images = new Map<string, ImageEntry[]>()
const MAX_IMAGES = 60
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' }

/**
 * Add one image to a tab. A picture already there (same bytes) moves to the front instead
 * of appearing twice; `null` when it is unusable or, for an automatic one, already shown.
 */
function addImage(tabId: string, body: Record<string, unknown>, auto: boolean): ImageEntry | null {
  let bytes: Buffer
  let file = ''
  let mime = ''
  const path = String(body['path'] ?? '')
  if (path) {
    if (!isAbsolute(path) || !existsSync(path)) return null
    mime = MIME[extname(path).toLowerCase()] ?? ''
    if (!mime || statSync(path).size > 25_000_000) return null
    bytes = readFileSync(path)
    file = path
  } else {
    mime = String(body['mime'] ?? '').toLowerCase()
    const data = String(body['data'] ?? '')
    if (!EXT[mime] || !data) return null
    bytes = Buffer.from(data, 'base64')
  }
  const hash = createHash('sha1').update(bytes).digest('hex')
  const list = images.get(tabId) ?? []
  const seen = list.findIndex((e) => e.hash === hash)
  if (seen !== -1) {
    if (auto) return null
    const [again] = list.splice(seen, 1)
    list.unshift({ ...again!, at: Date.now() })
    return list[0]!
  }
  const id = randomBytes(8).toString('hex')
  if (!file) {
    const dir = join(app.getPath('temp'), `ember-${process.pid}`, 'images')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `${id}${EXT[mime]}`)
    writeFileSync(file, bytes)
  }
  const entry: ImageEntry = {
    id,
    file,
    mime,
    source: String(body['source'] ?? '').slice(0, 80),
    caption: String(body['caption'] ?? '').slice(0, 200),
    at: Date.now(),
    hash,
  }
  list.unshift(entry)
  if (list.length > MAX_IMAGES) list.length = MAX_IMAGES
  images.set(tabId, list)
  return entry
}

/** The tab's images as one panel document, the newest in front. */
function imagesPush(tabId: string, quiet: boolean): PanelPush {
  const list = images.get(tabId) ?? []
  const push: PanelPush = {
    tabId,
    title: list.length === 1 ? 'Image' : `Images · ${list.length}`,
    format: 'images',
    content: JSON.stringify(list.map(({ id, source, caption, at, file }) => ({ id, source, caption: caption || source || file.split(/[\\/]/).pop(), at }))),
    replace: false,
    ...(quiet ? { quiet: true } : {}),
    id: randomBytes(8).toString('hex'),
    at: Date.now(),
    act: randomBytes(16).toString('hex'),
  }
  const stack = stacks.get(tabId) ?? []
  stack.unshift(push)
  if (stack.length > MAX_PER_TAB) stack.length = MAX_PER_TAB
  stacks.set(tabId, stack)
  return push
}


/**
 * Coerce whatever a session sent as `options` into buttons.
 *
 * Bounded rather than validated-or-rejected: a malformed option is a panel with one
 * odd button, and refusing the whole push over it would lose the question as well as
 * the answer.
 */
function readOptions(raw: unknown): PanelOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 12)
    .map((entry): PanelOption | null => {
      if (typeof entry === 'string') return entry.trim() ? { label: entry.slice(0, 160) } : null
      if (!entry || typeof entry !== 'object') return null
      const o = entry as Record<string, unknown>
      const label = String(o['label'] ?? o['value'] ?? '').slice(0, 160)
      if (!label.trim()) return null
      return {
        label,
        ...(o['value'] ? { value: String(o['value']).slice(0, 2000) } : {}),
        ...(o['hint'] ? { hint: String(o['hint']).slice(0, 240) } : {}),
        ...(o['submit'] === false ? { submit: false } : {}),
      }
    })
    .filter((o): o is PanelOption => o !== null)
}

function handlePush(body: Record<string, unknown>): { ok: true; push: PanelPush } | { ok: false; error: string } {
  const tabId = String(body['tabId'] ?? '')
  if (!tabId) return { ok: false, error: 'tabId is required' }

  const format = String(body['format'] ?? 'markdown')
  if (!FORMATS.has(format)) return { ok: false, error: `unknown format "${format}"` }

  const content = String(body['content'] ?? '')
  if (!content) return { ok: false, error: 'content is required' }

  const options = readOptions(body['options'])
  if (format === 'ask' && !options.length && body['freeText'] === false) {
    return { ok: false, error: 'an ask panel needs options, a free-text box, or both' }
  }

  const push: PanelPush = {
    tabId,
    title: String(body['title'] ?? 'Panel').slice(0, 120),
    format: format as PanelPush['format'],
    content,
    ...(body['language'] ? { language: String(body['language']).slice(0, 40) } : {}),
    ...(body['file'] ? { file: String(body['file']) } : {}),
    ...(options.length ? { options } : {}),
    ...(body['freeText'] === false ? { freeText: false } : {}),
    replace: body['replace'] === true,
    id: randomBytes(8).toString('hex'),
    at: Date.now(),
    // What the rendered page will present to prove it is the page we served, rather
    // than something else on this machine that guessed a document id.
    act: randomBytes(16).toString('hex'),
  }

  const canvas = canvasTabs.has(tabId)
  const stack = push.replace && !canvas ? [] : (stacks.get(tabId) ?? [])
  stack.unshift(push)
  const max = canvas ? MAX_PER_CANVAS_TAB : MAX_PER_TAB
  if (stack.length > max) stack.length = max
  stacks.set(tabId, stack)

  return { ok: true, push }
}

/** Pushes waiting to hear how they rendered: a diagram that would not draw is reported to the session. */
const docWaiters = new Map<string, (s: { ok: boolean; error: string; repaired: boolean }) => void>()

export function docStatus(id: string, status: { ok: boolean; error: string; repaired: boolean }): void {
  docWaiters.get(id)?.(status)
  docWaiters.delete(id)
}

/** Wait a moment for a canvas to say how a document drew. Null if nobody said (hidden, or no diagram). */
function awaitRender(id: string, ms = 4500): Promise<{ ok: boolean; error: string; repaired: boolean } | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      docWaiters.delete(id)
      resolve(null)
    }, ms)
    docWaiters.set(id, (s) => {
      clearTimeout(t)
      resolve(s)
    })
  })
}

const hasDiagram = (p: PanelPush) => p.format === 'mermaid' || (p.format === 'markdown' && /```\s*mermaid/i.test(p.content))

/** Where sessions' own views are kept. */
const VIEWS_DIR = join(CONFIG_DIR, 'views')
setViewLoader((name) => {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) return null
  const file = join(VIEWS_DIR, `${name}.html`)
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
})

const CODE_LANGS: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.py': 'python', '.rs': 'rust', '.go': 'go',
  '.cs': 'csharp', '.java': 'java', '.kt': 'kotlin', '.rb': 'ruby', '.php': 'php', '.sh': 'bash', '.ps1': 'powershell', '.sql': 'sql',
  '.css': 'css', '.scss': 'scss', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.txt': 'text', '.log': 'text', '.ini': 'ini',
}

/**
 * A PDF, drawn page by page with pdf.js into a scroller of fixed height: the pages as
 * pictures, sharp at the frame's width, lazily as they scroll into view. No plugin.
 */
function pdfPage(mediaId: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font:13px system-ui,sans-serif;color:var(--ember-muted,#999)}
#v{height:640px;overflow:auto;padding:14px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:14px}
canvas{display:block;max-width:100%;border-radius:6px;box-shadow:0 10px 30px -12px rgba(0,0,0,.55);background:#fff}
.n{font-size:11px;opacity:.6;margin-top:-8px}
</style></head><body><div id="v"><div class="n">Opening…</div></div>
<script type="module">
// Loaded with import(), not an import line: the bundler rewrites lines that start with import.
const pdfjs = await import('/vendor/pdf.min.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'
const v = document.getElementById('v')
try {
  const doc = await pdfjs.getDocument('/media/${mediaId}').promise
  v.innerHTML = ''
  const width = () => Math.min(900, v.clientWidth - 28)
  const slots = []
  for (let i = 1; i <= Math.min(doc.numPages, 200); i++) {
    const c = document.createElement('canvas')
    c.dataset.p = i
    c.style.width = width() + 'px'
    c.style.aspectRatio = '0.7727'
    v.appendChild(c)
    slots.push(c)
  }
  const draw = async (c) => {
    if (c.dataset.done) return
    c.dataset.done = '1'
    const page = await doc.getPage(Number(c.dataset.p))
    const base = page.getViewport({ scale: 1 })
    const scale = (width() / base.width) * (window.devicePixelRatio || 1)
    const vp = page.getViewport({ scale })
    c.width = vp.width
    c.height = vp.height
    c.style.aspectRatio = vp.width + ' / ' + vp.height
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise
  }
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && draw(e.target)), { root: v, rootMargin: '600px' })
  slots.forEach((c) => io.observe(c))
  const n = document.createElement('div')
  n.className = 'n'
  n.textContent = doc.numPages + (doc.numPages === 1 ? ' page' : ' pages')
  v.appendChild(n)
} catch (e) {
  v.innerHTML = '<div class="n">This PDF could not be opened: ' + String(e && e.message || e).replace(/</g, '&lt;') + '</div>'
}
</script></body></html>`
}

/** Files being shown, watched so a save redraws them. */
const watched = new Map<string, { tabId: string; title: string; stop: () => void }>()

/** Split a CSV/TSV line, honouring quotes. */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === sep) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/** Turn a file into a push: rendered, not resent by the session. */
function pushForFile(tabId: string, path: string, title: string): PanelPush {
  const ext = extname(path).toLowerCase()
  const size = statSync(path).size
  let body: Record<string, unknown>
  if (ext === '.pdf') {
    const m = registerMedia(path)
    if ('error' in m) throw new Error(m.error)
    // A PDF needs the browser's own viewer, which a sandboxed document frame may not load:
    // it opens as a page in the canvas's browser instead, at a fixed, readable height.
    body = { format: 'html', content: pdfPage(m.id) }
  } else {
    if (size > 4 * 1024 * 1024) throw new Error('file is larger than 4 MB')
    const text = readFileSync(path, 'utf8')
    const isTodo = path.toLowerCase() === join(NOTES_DIR, TODO_FILE).toLowerCase()
    if (isTodo) {
      const items = text
        .split(/\r?\n/)
        .map((l) => /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m && !!m[2]!.trim())
        .map((m) => ({ text: m[2]!.trim(), done: m[1] !== ' ' }))
      body = { format: 'view', content: JSON.stringify({ view: 'todo', data: { items } }) }
    } else if (ext === '.md' || ext === '.markdown') body = { format: 'markdown', content: text || ' ' }
    else if (ext === '.html' || ext === '.htm') body = { format: 'html', content: text }
    else if (ext === '.mmd' || ext === '.mermaid') body = { format: 'mermaid', content: text }
    else if (ext === '.csv' || ext === '.tsv') {
      const sep = ext === '.tsv' ? '\t' : text.split('\n', 1)[0]!.includes(';') && !text.split('\n', 1)[0]!.includes(',') ? ';' : ','
      const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 2001)
      const [head = '', ...rows] = lines
      body = { format: 'view', content: JSON.stringify({ view: 'table', data: { columns: splitRow(head, sep), rows: rows.map((r) => splitRow(r, sep)) } }) }
    } else if (ext === '.json') {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        value = text
      }
      body = { format: 'view', content: JSON.stringify({ view: 'json', data: { value } }) }
    } else body = { format: 'code', content: text || ' ', language: CODE_LANGS[ext] ?? ext.slice(1) }
  }
  const result = handlePush({ tabId, title, file: path, ...body })
  if (!result.ok) throw new Error(result.error)
  return result.push
}

export function showFile(tabId: string, raw: string, title?: string): { ok: true; title: string; live: boolean } {
  const path = raw.replace(/^file:\/\//, '')
  if (!isAbsolute(path)) throw new Error('path must be absolute')
  if (!existsSync(path)) throw new Error(`no such file: ${path}`)
  const name = title || path.split(/[\\/]/).pop() || path
  const push = pushForFile(tabId, path, name)
  const { act: _act, ...forRenderer } = push
  broadcast('ember:panel:push', forRenderer)
  // Watch it: saved again, it redraws in place. One watcher per file, for a few hours.
  watched.get(path)?.stop()
  let last = statSync(path).mtimeMs
  const timer = setInterval(() => {
    try {
      const m = statSync(path).mtimeMs
      if (m === last) return
      last = m
      const again = pushForFile(tabId, path, name)
      const { act: _a, ...r } = again
      broadcast('ember:panel:push', r)
    } catch {
      /* gone or unreadable for a moment; try again next tick */
    }
  }, 900)
  const stopAt = setTimeout(() => watched.get(path)?.stop(), 4 * 60 * 60 * 1000)
  watched.set(path, {
    tabId,
    title: name,
    stop: () => {
      clearInterval(timer)
      clearTimeout(stopAt)
      watched.delete(path)
    },
  })
  return { ok: true, title: name, live: true }
}

/** Which push a document secret belongs to, and therefore which tab it may speak for. */
function findByAct(secret: string): PanelPush | null {
  for (const stack of stacks.values()) {
    const found = stack.find((p) => p.act === secret)
    if (found) return found
  }
  return null
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  // The document route is a GET from our own webview and carries no token — a token in
  // a navigable URL ends up in history and referrers. It is safe unauthenticated
  // because it only ever returns content this same machine already pushed.
  if (req.method === 'GET' && url.pathname.startsWith('/doc/')) {
    const id = url.pathname.slice('/doc/'.length)
    for (const stack of stacks.values()) {
      const found = stack.find((p) => p.id === id)
      // ?tone=light&paper=rrggbb come from the renderer, the one place that knows the theme.
      const paper = /^[0-9a-f]{6}$/i.test(url.searchParams.get('paper') ?? '') ? `#${url.searchParams.get('paper')}` : undefined
      // ?accent=&fg=&bg= (rrggbb): the theme's colours, so documents and diagrams match it.
      const hex = (k: string) => (/^[0-9a-f]{6}$/i.test(url.searchParams.get(k) ?? '') ? `#${url.searchParams.get(k)}` : null)
      const accent = hex('accent')
      const fg = hex('fg')
      const bg = hex('bg')
      const palette = accent && fg && bg ? { accent, fg, bg } : undefined
      // ?target=phone: the phone's version (answers by postMessage, not a POST to this bridge).
      const target = url.searchParams.get('target') === 'phone' ? 'phone' : 'bridge'
      if (found) return send(res, 200, renderPanelDocument(found, target, url.searchParams.get('tone') === 'light', paper, palette), 'text/html; charset=utf-8')
    }
    return send(res, 404, '<!doctype html><title>gone</title>', 'text/html; charset=utf-8')
  }

  // An image a session saw, by the id it was registered under. Unauthenticated for the
  // same reason /doc is: it only ever returns what this machine already handed over.
  if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
    const id = url.pathname.slice('/img/'.length)
    for (const list of images.values()) {
      const found = list.find((e) => e.id === id)
      if (!found || !existsSync(found.file)) continue
      res.writeHead(200, { 'content-type': found.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' })
      createReadStream(found.file).pipe(res)
      return
    }
    return send(res, 404, 'gone', 'text/plain')
  }

  // Mermaid, served to the document rather than bundled into it. One 3MB file that
  // Chromium then caches, instead of 3MB inlined into every diagram we push.
  const VENDOR = ['mermaid.min.js', 'pdf.min.mjs', 'pdf.worker.min.mjs']
  if (req.method === 'GET' && url.pathname.startsWith('/vendor/') && VENDOR.includes(url.pathname.slice(8))) {
    const file = resourcePath('vendor', url.pathname.slice(8))
    if (!existsSync(file)) return send(res, 404, '// not shipped with this build', 'text/javascript')
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' })
    createReadStream(file).pipe(res)
    return
  }

  // Images and video for a Loom canvas. No token, like /doc: the id is a capability
  // minted only for a file the session or the renderer asked for (see canvas.ts).
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/media/')) {
    serveMedia(req, res, url.pathname.slice('/media/'.length))
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ ok: true }))
  }

  // The way back: a panel document reporting that the user pressed something on it.
  //
  // Above the token gate on purpose. The bridge token belongs to the session, and
  // writing it into a page that carries model-authored markup would hand that markup
  // the ability to push panels to any tab. The per-document secret minted at push time
  // is enough for this one direction, and it is worth exactly one tab's prompt.
  if (req.method === 'POST' && url.pathname === '/panel/act') {
    void readJson(req)
      .then((body) => {
        const secret = String(body['act'] ?? '')
        const owner = secret ? findByAct(secret) : null
        if (!owner) return send(res, 403, JSON.stringify({ error: 'stale panel' }))

        // Only one kind now. There used to be a `focus` kind as well, reporting when a
        // field inside a panel document had the caret so a dictated sentence could land
        // there instead of in the prompt — that went out with dictation itself.
        const act: PanelAct = {
          tabId: owner.tabId,
          kind: 'send',
          // One line, always. The prompt is a line editor, and a pasted newline in a TUI
          // that treats Enter as submit sends half a sentence.
          text: String(body['text'] ?? '')
            .replace(/\s*\r?\n\s*/g, ' ')
            .slice(0, 4000),
          submit: body['submit'] !== false,
        }
        if (!act.text) return send(res, 400, JSON.stringify({ error: 'text is required' }))
        broadcast('ember:panel:act', act)
        send(res, 200, JSON.stringify({ ok: true }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  if (!tokenOk(req)) return send(res, 401, JSON.stringify({ error: 'bad token' }))

  // Computer use. The daemon reports what it just did (cursor + strip); the `desk`
  // client asks for the daemon, or throws the switch.
  if (req.method === 'POST' && url.pathname.startsWith('/desk/')) {
    const verb = url.pathname.slice('/desk/'.length)
    void readJson(req)
      .then(async (body) => {
        switch (verb) {
          case 'activity': {
            const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
            const a: DeskActivity = {
              action: String(body['action'] ?? 'move').slice(0, 20),
              x: num(body['x']),
              y: num(body['y']),
              label: String(body['label'] ?? '').slice(0, 120),
              tab: String(body['tab'] ?? ''),
              at: Date.now(),
            }
            onActivity(a)
            return send(res, 200, JSON.stringify({ ok: true }))
          }
          case 'start':
            return send(res, 200, JSON.stringify({ ok: true, state: await startDesk() }))
          case 'stop':
            return send(res, 200, JSON.stringify({ ok: true, state: stopDesk() }))
          case 'halt':
            return send(res, 200, JSON.stringify({ ok: true, state: haltDesk() }))
          case 'resume':
            return send(res, 200, JSON.stringify({ ok: true, state: resumeDesk() }))
          case 'status':
            return send(res, 200, JSON.stringify({ ok: true, state: deskState() }))
          // Ember Hands. Pointing shows and explains, and never clicks; acting clicks and
          // types. Each is allowed only as far as the user's setting says.
          case 'point': {
            // Something on the canvas itself: Ember knows where it drew it, so the canvas points.
            if (body['object']) {
              const r = await requestCanvasPoint(broadcast, {
                tabId: String(body['tabId'] ?? ''),
                object: String(body['object']),
                text: body['text'] ? String(body['text']) : '',
                say: body['say'] ? String(body['say']).slice(0, 400) : '',
                step: typeof body['step'] === 'number' ? body['step'] : undefined,
                steps: typeof body['steps'] === 'number' ? body['steps'] : undefined,
              })
              return send(res, 200, JSON.stringify(r))
            }
            const mode = loadConfig().hands ?? 'show'
            if (mode === 'off') return send(res, 200, JSON.stringify({ ok: false, error: 'Ember Hands is off. The user can turn it on from the hand control at the top of the canvas.' }))
            const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
            const r = await deskPoint({
              window: body['window'] ? String(body['window']) : undefined,
              name: body['name'] ? String(body['name']) : undefined,
              ctype: body['ctype'] ? String(body['ctype']) : undefined,
              x: num(body['x']),
              y: num(body['y']),
              say: body['say'] ? String(body['say']).slice(0, 400) : undefined,
              step: num(body['step']),
              steps: num(body['steps']),
            })
            return send(res, 200, JSON.stringify(r))
          }
          case 'act': {
            const mode = loadConfig().hands ?? 'show'
            if (mode !== 'act')
              return send(res, 200, JSON.stringify({ ok: false, error: `Ember Hands is set to "${mode === 'off' ? 'Off' : 'Show me'}": it may ${mode === 'off' ? 'not use the desktop' : 'point but not click or type'}. Ask the user to switch it to "Show & act" (the hand control at the top of the canvas), or point instead.` }))
            const r = await deskAct(String(body['script'] ?? ''))
            return send(res, 200, JSON.stringify(r))
          }
          case 'look': {
            if ((loadConfig().hands ?? 'show') === 'off') return send(res, 200, JSON.stringify({ ok: false, error: 'Ember Hands is off.' }))
            const r = await deskLook(body['window'] ? String(body['window']) : undefined, typeof body['depth'] === 'number' ? body['depth'] : 4)
            return send(res, 200, JSON.stringify(r))
          }
          case 'hide':
            deskHideCallout()
            return send(res, 200, JSON.stringify({ ok: true }))
          default:
            return send(res, 404, JSON.stringify({ error: 'no such route' }))
        }
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // Images onto the panel: from the image hook (auto) or show_image (chosen). One image
  // or several (`paths`); base64 bytes for ones that were never a file.
  if (req.method === 'POST' && url.pathname === '/image') {
    void readJson(req, 40_000_000)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        if (!tabId) return send(res, 400, JSON.stringify({ error: 'tabId is required' }))
        const auto = body['auto'] === true
        // An image a session merely looked at (a screenshot for itself) is not put up in a
        // Loom tab; only one it chose to show is.
        if (auto && canvasTabs.has(tabId)) return send(res, 200, JSON.stringify({ ok: true, skipped: 'canvas' }))
        const raw = body['paths']
        const many = Array.isArray(raw) ? raw.slice(0, 12).map(String) : typeof raw === 'string' && raw ? [raw] : null
        const added = (many ?? [null])
          .reverse()
          .map((p) => addImage(tabId, p === null ? body : { ...body, path: p }, auto))
          .filter((e): e is ImageEntry => e !== null)
        if (!added.length) {
          return send(res, auto ? 200 : 400, JSON.stringify(auto ? { ok: true, count: 0 } : { error: 'no readable image (absolute path to a png, jpg, gif, webp or bmp)' }))
        }
        const push = imagesPush(tabId, auto)
        const { act: _act, ...forRenderer } = push
        broadcast('ember:panel:push', forRenderer)
        send(res, 200, JSON.stringify({ ok: true, count: added.length }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // Change a piece with a few find-and-replace edits instead of sending all of it again:
  // the session writes a few tokens, not the whole page. Works on what was pushed, and on a
  // diagram or table that sits in a reply (its source comes from the canvas's screen list).
  // A file shown by its path: the session sends a path, not the content, so a long report
  // or a page it already wrote costs it nothing to show. It stays live: saved again, it
  // redraws in place.
  if (req.method === 'POST' && url.pathname === '/canvas/file') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        const path = String(body['path'] ?? '')
        if (!tabId || !path) throw new Error('tabId and path are required')
        const r = showFile(tabId, path, body['title'] ? String(body['title']) : undefined)
        send(res, 200, JSON.stringify(r))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // A session saving a view of its own: an html page that draws window.EMBER_DATA. Kept on
  // disk, so every later session can send data to it by name.
  if (req.method === 'POST' && url.pathname === '/canvas/view') {
    void readJson(req)
      .then((body) => {
        const name = String(body['name'] ?? '').trim().toLowerCase()
        const html = String(body['html'] ?? '')
        if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) throw new Error('name: 2-41 characters, a-z, 0-9 and -')
        if ((BUILTIN_VIEWS as readonly string[]).includes(name)) throw new Error(`"${name}" is a built-in view`)
        if (!/<html|<!doctype/i.test(html)) throw new Error('html must be a whole document')
        mkdirSync(VIEWS_DIR, { recursive: true })
        writeFileSync(join(VIEWS_DIR, `${name}.html`), html, 'utf8')
        send(res, 200, JSON.stringify({ ok: true, name }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // Ember Brain: the memory and skills every agent shares (src/main/brain.ts).
  if (req.method === 'POST' && url.pathname.startsWith('/brain/')) {
    void readJson(req)
      .then((body) => {
        const str = (k: string) => String(body[k] ?? '')
        const op = url.pathname.slice('/brain/'.length)
        const text =
          op === 'recall'
            ? recall(str('query'))
            : op === 'remember'
              ? remember(str('name'), str('description'), str('body'), str('type'))
              : op === 'forget'
                ? forget(str('name'))
                : op === 'skills'
                  ? skills(str('name') || undefined)
                  : null
        if (text === null) return send(res, 404, JSON.stringify({ error: 'unknown brain op' }))
        send(res, 200, JSON.stringify({ ok: true, text }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // The session's notes and todo list: show one by name, add a todo, tick one, write to a note.
  if (req.method === 'POST' && url.pathname === '/canvas/notes') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        const op = String(body['op'] ?? '')
        const name = String(body['name'] ?? '').trim()
        const text = String(body['text'] ?? '')
        const find = (q: string) => {
          const n = q.toLowerCase().replace(/\.md$/, '')
          const all = listNotes()
          return all.find((x) => x.id.toLowerCase().replace(/\.md$/, '') === n) ?? all.find((x) => x.title.toLowerCase() === n) ?? all.find((x) => x.title.toLowerCase().includes(n) || x.id.toLowerCase().includes(n))
        }
        if (op === 'show') {
          if (/^todos?$/i.test(name)) {
            readTodo()
            return send(res, 200, JSON.stringify(showFile(tabId, join(NOTES_DIR, TODO_FILE), 'Todo')))
          }
          const note = find(name)
          if (!note) throw new Error(`No note matches "${name}". Notes: ${listNotes().slice(0, 30).map((x) => x.title).join(', ')}`)
          return send(res, 200, JSON.stringify(showFile(tabId, join(NOTES_DIR, note.id), note.title)))
        }
        if (op === 'list') return send(res, 200, JSON.stringify({ ok: true, notes: listNotes().map((x) => x.title) }))
        if (op === 'todo_add') {
          if (!text.trim()) throw new Error('text is required')
          const cur = readTodo()
          writeTodo(`${cur.replace(/\s*$/, '')}\n- [ ] ${text.trim()}\n`)
          return send(res, 200, JSON.stringify({ ok: true }))
        }
        if (op === 'todo_done') {
          const q = text.trim().toLowerCase()
          const lines = readTodo().split('\n')
          const i = lines.findIndex((l) => /^\s*[-*]\s*\[ \]/.test(l) && l.toLowerCase().includes(q))
          if (i < 0) throw new Error(`No open todo contains "${text}"`)
          lines[i] = lines[i]!.replace('[ ]', '[x]')
          writeTodo(lines.join('\n'))
          return send(res, 200, JSON.stringify({ ok: true, done: lines[i]!.replace(/^\s*[-*]\s*\[x\]\s*/, '') }))
        }
        if (op === 'append' || op === 'create') {
          const note = op === 'append' && name ? find(name) : undefined
          if (note) {
            const r = saveNote(note.id, `${(readNote(note.id) ?? '').replace(/\s*$/, '')}\n\n${text}\n`)
            return send(res, 200, JSON.stringify({ ok: r.ok, title: note.title }))
          }
          const made = createNote(name && !text.startsWith('#') ? `# ${name}\n\n${text}\n` : `${text}\n`)
          if (!made) throw new Error('could not create the note')
          return send(res, 200, JSON.stringify({ ok: true, title: made.title, created: true }))
        }
        throw new Error(`unknown op "${op}"`)
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  if (req.method === 'POST' && url.pathname === '/panel/edit') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        const title = String(body['title'] ?? '')
        if (!tabId || !title) throw new Error('tabId and title are required')
        const edits = (Array.isArray(body['edits']) ? (body['edits'] as Array<Record<string, unknown>>) : []).slice(0, 40)
        if (!edits.length) throw new Error('edits is required')
        const norm = (t: string) => t.replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
        const pushed = (stacks.get(tabId) ?? []).find((p) => norm(p.title) === norm(title) && p.format !== 'images' && p.format !== 'url')
        const placed = pushed ? null : screenOf(tabId).find((it) => norm(it.title) === norm(title) && it.source)
        if (!pushed && !placed) throw new Error(`Nothing called "${title}" is on the canvas. Call on_screen for the exact titles.`)
        let content = pushed ? pushed.content : placed!.source!
        const format = pushed ? pushed.format : placed!.format === 'mermaid' ? 'mermaid' : placed!.format === 'code' ? 'code' : 'markdown'
        for (const e of edits) {
          const find = String(e['find'] ?? '')
          const replace = String(e['replace'] ?? '')
          if (!find) throw new Error('every edit needs find')
          const count = content.split(find).length - 1
          if (!count) throw new Error(`Not found in "${title}": ${find.slice(0, 120)}`)
          if (count > 1 && e['all'] !== true) throw new Error(`Found ${count} times in "${title}" (add more context, or all: true): ${find.slice(0, 120)}`)
          content = e['all'] === true ? content.split(find).join(replace) : content.replace(find, () => replace)
        }
        const result = handlePush({ tabId, title: pushed?.title ?? placed?.title ?? title, format, content, ...(pushed?.language ? { language: pushed.language } : {}) })
        if (!result.ok) throw new Error(result.error)
        const { act: _act, ...forRenderer } = result.push
        const wait = hasDiagram(result.push) ? awaitRender(result.push.id) : null
        broadcast('ember:panel:push', forRenderer)
        if (!wait) return send(res, 200, JSON.stringify({ ok: true, edits: edits.length }))
        void wait.then((render) => send(res, 200, JSON.stringify({ ok: true, edits: edits.length, render })))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  if (req.method === 'POST' && url.pathname === '/panel') {
    void readJson(req)
      .then((body) => {
        const result = handlePush(body)
        if (!result.ok) return send(res, 400, JSON.stringify({ error: result.error }))
        const { act: _act, ...forRenderer } = result.push
        const wait = canvasTabs.has(result.push.tabId) && hasDiagram(result.push) ? awaitRender(result.push.id) : null
        broadcast('ember:panel:push', forRenderer)
        if (!wait) return send(res, 200, JSON.stringify({ ok: true, id: result.push.id }))
        void wait.then((render) => send(res, 200, JSON.stringify({ ok: true, id: result.push.id, render })))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // A Claude session naming itself, so narration can read its transcript rather than
  // whichever one in the folder was written most recently.
  if (req.method === 'POST' && url.pathname === '/session') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        const sessionId = String(body['sessionId'] ?? '')
        const cwd = String(body['cwd'] ?? '')
        bindSession(tabId, sessionId, cwd)
        send(res, 200, JSON.stringify({ ok: true }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // A session's status line reporting in: context, cost, model, for the tab's card.
  if (req.method === 'POST' && url.pathname === '/status') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        const raw = body['status']
        if (!tabId || !raw || typeof raw !== 'object') throw new Error('tabId and status are required')
        broadcast('ember:claude:status', statusFrom(tabId, raw as Record<string, unknown>))
        // `/clear` and `/resume` change the session without a new announcement; the status
        // line is where the change shows.
        rebindFromStatus(tabId, raw as Record<string, unknown>)
        send(res, 200, JSON.stringify({ ok: true }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // A Loom canvas being handed pictures, recordings or clips by path or URL.
  if (req.method === 'POST' && url.pathname === '/canvas/media') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        const raw = Array.isArray(body['items']) ? (body['items'] as unknown[]) : []
        if (!tabId || !raw.length) throw new Error('tabId and items are required')
        const items: Array<{ src: string; kind: string; name: string; caption?: string }> = []
        const errors: string[] = []
        for (const entry of raw.slice(0, 24)) {
          const o = (entry && typeof entry === 'object' ? entry : { path: entry }) as Record<string, unknown>
          const caption = o['caption'] ? String(o['caption']).slice(0, 300) : undefined
          const link = String(o['url'] ?? '')
          if (/^https?:\/\//i.test(link)) {
            const kind = /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(link) ? 'video' : 'image'
            items.push({ src: link, kind, name: link.split('/').pop() ?? link, ...(caption ? { caption } : {}) })
            continue
          }
          const r = registerMedia(String(o['path'] ?? ''))
          if ('error' in r) errors.push(r.error)
          else items.push({ src: `http://127.0.0.1:${port}/media/${r.id}`, kind: r.kind, name: r.name, ...(caption ? { caption } : {}) })
        }
        if (items.length) {
          broadcast('ember:canvas:media', {
            tabId,
            title: String(body['title'] ?? '').slice(0, 120),
            items,
            id: randomBytes(6).toString('hex'),
          })
        }
        send(res, items.length ? 200 : 400, JSON.stringify({ ok: items.length > 0, shown: items.length, errors }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // A Loom canvas's steps card: the plan, as the session keeps it.
  // What the user has placed on the canvas, for the session to refer to and update in place.
  // A piece Claude pushed carries its latest content, so it can be edited rather than redone.
  if (req.method === 'POST' && url.pathname === '/canvas/screen') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        if (!tabId) throw new Error('tabId is required')
        const stack = stacks.get(tabId) ?? []
        const items = screenOf(tabId).map((it) => {
          if (it.source) return it
          const push = [...stack].reverse().find((p) => p.title === it.title)
          return push && push.format !== 'url' ? { ...it, source: push.content.slice(0, 8000) } : it
        })
        send(res, 200, JSON.stringify({ items }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  if (req.method === 'POST' && url.pathname === '/canvas/steps') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        if (!tabId) throw new Error('tabId is required')
        const steps = (Array.isArray(body['steps']) ? (body['steps'] as unknown[]) : []).slice(0, 40).map((raw) => {
          const o = (raw && typeof raw === 'object' ? raw : { text: raw }) as Record<string, unknown>
          const status = String(o['status'] ?? 'pending')
          return {
            text: String(o['text'] ?? o['content'] ?? '').slice(0, 300),
            status: status === 'done' || status === 'completed' ? 'done' : status === 'active' || status === 'in_progress' ? 'active' : 'pending',
          }
        })
        broadcast('ember:canvas:steps', { tabId, title: String(body['title'] ?? '').slice(0, 120), steps })
        send(res, 200, JSON.stringify({ ok: true }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // A Loom canvas being asked to mark things on the page it is showing.
  if (req.method === 'POST' && url.pathname === '/canvas/annotate') {
    void readJson(req)
      .then(async (body) => {
        const tabId = String(body['tabId'] ?? '')
        if (!tabId) throw new Error('tabId is required')
        const result = await requestAnnotate(broadcast, {
          tabId,
          marks: Array.isArray(body['marks']) ? (body['marks'] as unknown[]).slice(0, 12) : [],
          clear: body['clear'] === true,
          ...(body['url'] ? { url: String(body['url']) } : {}),
        })
        send(res, result.ok ? 200 : 400, JSON.stringify(result))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  if (req.method === 'POST' && url.pathname === '/panel/clear') {
    void readJson(req)
      .then((body) => {
        const tabId = String(body['tabId'] ?? '')
        stacks.delete(tabId)
        broadcast('ember:panel:clear', { tabId })
        send(res, 200, JSON.stringify({ ok: true }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // The `note` and `notes` shell functions land here. A shell cannot open a tab, and it
  // should not learn how — it posts an intent and the renderer, which owns tabs, decides
  // what that means. Same shape as /panel: authenticated by the same token, reaching the
  // same renderer, over the connection the pty already has.
  // The `ember` command. The words go to the renderer as typed; it owns the table of
  // what they mean (the same table the palette shows) and answers with what to print.
  // Long enough for the orchestrator to think when the words were for it.
  if (req.method === 'POST' && url.pathname === '/cmd') {
    void readJson(req)
      .then((body) => {
        const words = Array.isArray(body['words']) ? (body['words'] as unknown[]).map(String) : []
        const tabId = String(body['tabId'] ?? '')
        const reqId = randomUUID()
        const timer = setTimeout(() => {
          cmdWaiters.delete(reqId)
          send(res, 504, JSON.stringify({ error: 'Ember did not answer in time' }))
        }, 120_000)
        cmdWaiters.set(reqId, (r) => {
          clearTimeout(timer)
          send(res, 200, JSON.stringify(r.error ? { error: r.error } : { ok: true, result: r.result }))
        })
        broadcast('ember:cmd', { reqId, words, tabId })
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // The orchestrator's tools, called by resources/mcp-orch.mjs from inside a headless
  // agent run. The renderer owns the tabs, so it runs the tool and answers by request id.
  // Long, because ask_session waits for a whole turn of another session.
  if (req.method === 'POST' && url.pathname === '/orch/tool') {
    void readJson(req)
      .then((body) => {
        const reqId = randomUUID()
        const timer = setTimeout(() => {
          orchWaiters.delete(reqId)
          send(res, 504, JSON.stringify({ error: 'Ember did not answer in time' }))
        }, 10 * 60_000)
        orchWaiters.set(reqId, (result) => {
          clearTimeout(timer)
          send(res, 200, JSON.stringify({ ok: true, result }))
        })
        const args = body['args'] && typeof body['args'] === 'object' ? body['args'] : {}
        broadcast('ember:orch:tool', { reqId, run: String(body['run'] ?? ''), name: String(body['name'] ?? ''), args })
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  if (req.method === 'POST' && url.pathname === '/notes/open') {
    void readJson(req)
      .then((body) => {
        // `notes` is the list; `note` is a fresh page, with whatever words followed the
        // command already on it, so a thought is captured in one line.
        const m = String(body['mode'] ?? 'list')
        const mode = m === 'new' || m === 'open' || m === 'todo' ? m : 'list'
        const text = String(body['text'] ?? '').trim()
        const id = String(body['id'] ?? '')
        // The tab whose shell asked: the note opens there, over that shell, the way
        // `claude` runs in the tab it was typed in.
        const tabId = String(body['tabId'] ?? '')
        broadcast('ember:notes:open', { mode, ...(text ? { text } : {}), ...(id ? { id } : {}), ...(tabId ? { tabId } : {}) })
        send(res, 200, JSON.stringify({ ok: true }))
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  // The notes, for a Claude session. Same files the Notes tab edits, reached through the
  // same functions main already has, so there is exactly one notion of what a note is.
  // Every write announces itself, so a tab showing that note picks the change up rather
  // than overwriting it with the last thing it saw.
  if (req.method === 'POST' && url.pathname.startsWith('/notes/')) {
    const verb = url.pathname.slice('/notes/'.length)
    void readJson(req)
      .then(async (body) => {
        const id = String(body['id'] ?? '')
        const content = typeof body['content'] === 'string' ? body['content'] : ''
        switch (verb) {
          case 'list':
            return send(res, 200, JSON.stringify({ dir: NOTES_DIR, notes: listNotes() }))
          case 'read': {
            const text = readNote(id)
            if (text === null) return send(res, 404, JSON.stringify({ error: `no note "${id}"` }))
            return send(res, 200, JSON.stringify({ id, content: text }))
          }
          case 'write': {
            if (id) {
              if (readNote(id) === null) return send(res, 404, JSON.stringify({ error: `no note "${id}"` }))
              const r = saveNote(id, content)
              if (!r.ok) return send(res, 500, JSON.stringify({ error: r.error ?? 'could not save' }))
              broadcast('ember:notes:changed', { id: r.id, was: id })
              return send(res, 200, JSON.stringify({ id: r.id }))
            }
            const meta = createNote(content)
            if (!meta) return send(res, 500, JSON.stringify({ error: 'could not create the note' }))
            broadcast('ember:notes:changed', { id: meta.id })
            return send(res, 200, JSON.stringify({ id: meta.id }))
          }
          case 'append': {
            const before = readNote(id)
            if (before === null) return send(res, 404, JSON.stringify({ error: `no note "${id}"` }))
            const sep = before.length === 0 || before.endsWith('\n') ? '' : '\n'
            const r = saveNote(id, `${before}${sep}${content}${content.endsWith('\n') ? '' : '\n'}`)
            if (!r.ok) return send(res, 500, JSON.stringify({ error: r.error ?? 'could not save' }))
            broadcast('ember:notes:changed', { id: r.id, was: id })
            return send(res, 200, JSON.stringify({ id: r.id }))
          }
          case 'delete': {
            const ok = await deleteNote(id)
            if (ok) broadcast('ember:notes:changed', { id, deleted: true })
            return send(res, ok ? 200 : 404, JSON.stringify(ok ? { ok: true } : { error: `no note "${id}"` }))
          }
          default:
            return send(res, 404, JSON.stringify({ error: 'no such route' }))
        }
      })
      .catch((err: Error) => send(res, 400, JSON.stringify({ error: err.message })))
    return
  }

  send(res, 404, JSON.stringify({ error: 'no such route' }))
}

/**
 * Bring the bridge up on a loopback port the OS picks.
 *
 * A fixed port would collide with a second Ember and, worse, would let anything that
 * once learned the number keep talking to a later run. The port and the token are both
 * per-process and reach a shell only by being spawned with them.
 */
export async function startBridge(): Promise<void> {
  if (server) return
  token = randomBytes(24).toString('hex')
  server = createServer(route)
  await new Promise<void>((resolve) => {
    server!.on('error', (err) => {
      console.error(`[ember] bridge failed: ${err.message}`)
      server = null
      port = 0
      resolve()
    })
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      // Computer use learns where to report, and picks its own port before any shell spawns.
      setDeskBridge(`http://127.0.0.1:${port}`, token)
      try {
        mcpConfig = writeMcpConfig()
        try {
          agentMcp = writeAgentMcpConfigs(dirname(mcpConfig))
        } catch (err) {
          console.error(`[ember] could not write the agent MCP configs: ${(err as Error).message}`)
        }
      } catch (err) {
        // Without it the shim simply does not add the flag, and `claude` runs bare.
        console.error(`[ember] could not write the panel MCP config: ${(err as Error).message}`)
      }
      try {
        settingsFile = writeSettings()
        innerStatusLine = readUserStatusLine()
      } catch (err) {
        // Same shape of failure: no status line, everything else as before.
        console.error(`[ember] could not write the status line settings: ${(err as Error).message}`)
      }
      resolve()
    })
  })
}

/**
 * Host a small document for a Loom canvas — a diagram from a mermaid fence in Claude's
 * text — the way a pushed panel is hosted, without showing it anywhere. The canvas puts it
 * in a frame of its own: model-authored markup is rendered on the bridge's origin, never
 * in the process that holds the IPC handles.
 */
export function hostDoc(tabId: string, title: string, format: 'markdown' | 'mermaid' | 'code' | 'html' | 'view', content: string): string {
  if (!port) return ''
  const result = handlePush({ tabId, title, format, content })
  return result.ok ? `http://127.0.0.1:${port}/doc/${result.push.id}` : ''
}

export function stopBridge(): void {
  server?.close()
  server = null
  port = 0
  stacks.clear()
}

/** Drop a tab's history when its tab closes, so a reused id cannot inherit it. */
export function forgetTab(tabId: string): void {
  stacks.delete(tabId)
  images.delete(tabId)
  unbindSession(tabId)
}
