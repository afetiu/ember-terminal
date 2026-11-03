import { ipcMain, type WebContents } from 'electron'
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { extname, basename, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CanvasAnnotateResult, CanvasFeed, ScreenItem } from '../shared/types.js'
import { transcriptPath } from './transcript.js'
import { CostMeter } from './emberCost.js'
import { AGENT_LOGS, type AgentLog } from './providers/logs.js'

/**
 * The main-process half of a Loom tab: the session's transcript as a feed, local media
 * served to the canvas, and the round trip that lets the agent draw on a page.
 *
 * A Loom tab is an ordinary shell with the real `claude` in it. Nothing here talks to
 * Claude Code; it reads what Claude Code already writes. The transcript is the same file
 * narration tails (see transcript.ts), but the canvas wants all of it — every block, from
 * the first line — where narration wants a sentence at a time from wherever it joined.
 */

// ---------------------------------------------------------------- media

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

export type MediaKind = 'image' | 'video' | 'audio'

/**
 * Files the canvas may load, by an id nobody can guess.
 *
 * The route that serves them is a GET without the bridge token — an <img> cannot send a
 * header — so the id is the capability. A path in the URL would let any page on this
 * machine that can reach the bridge read any file the user can; an id minted only when
 * the session or the renderer asked for that exact file grants that file and nothing else.
 */
const media = new Map<string, { path: string; type: string }>()
const byPath = new Map<string, string>()

export function mediaKind(type: string): MediaKind {
  return type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'image'
}

export function registerMedia(path: string): { id: string; type: string; kind: MediaKind; name: string } | { error: string } {
  const clean = String(path ?? '').trim().replace(/^"|"$/g, '')
  if (!clean || !isAbsolute(clean)) return { error: `not an absolute path: ${clean || '(empty)'}` }
  const type = MEDIA_TYPES[extname(clean).toLowerCase()]
  if (!type) return { error: `not an image, video or audio file: ${basename(clean)}` }
  if (!existsSync(clean)) return { error: `no such file: ${clean}` }
  try {
    if (!statSync(clean).isFile()) return { error: `not a file: ${clean}` }
  } catch {
    return { error: `cannot read: ${clean}` }
  }
  let id = byPath.get(clean.toLowerCase())
  if (!id) {
    id = randomBytes(16).toString('hex')
    media.set(id, { path: clean, type })
    byPath.set(clean.toLowerCase(), id)
  }
  return { id, type, kind: mediaKind(type), name: basename(clean) }
}

/**
 * Serve a registered file, with byte ranges.
 *
 * Ranges are not a nicety: Chromium will not seek a <video> whose server ignores them,
 * and a recording you cannot scrub is a recording nobody watches past the first second.
 */
export function serveMedia(req: IncomingMessage, res: ServerResponse, id: string): void {
  const entry = media.get(id)
  if (!entry || !existsSync(entry.path)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('gone')
    return
  }
  const size = statSync(entry.path).size
  const headers: Record<string, string> = {
    'content-type': entry.type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // An SVG opened as a document could run script on the bridge origin. As an <img> it
    // cannot; this makes sure it cannot either way.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers['range'] ?? ''))
  if (range && size > 0) {
    let start = range[1] ? Number(range[1]) : NaN
    let end = range[2] ? Number(range[2]) : size - 1
    if (Number.isNaN(start)) {
      // A suffix range: the last N bytes.
      start = Math.max(0, size - end)
      end = size - 1
    }
    end = Math.min(end, size - 1)
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
    createReadStream(entry.path, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  createReadStream(entry.path).pipe(res)
}

// ---------------------------------------------------------------- transcript feed

/** Past this, a block's text is cut. A canvas shows output; it is not a pager for a 4MB log. */
const TEXT_CAP = 24_000
/** Images bigger than this stay out of the feed — base64 through IPC per screenshot adds up. */
const IMAGE_CAP = 6_000_000

type Json = Record<string, unknown>

function cap(text: string, max = TEXT_CAP): string {
  return text.length > max ? `${text.slice(0, max)}\n… ${(text.length - max).toLocaleString()} more characters` : text
}

/** Cut what is too big to be worth carrying, and drop what the canvas never shows. */
function slimBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block
  const b = block as Json
  switch (b['type']) {
    case 'text':
      return { type: 'text', text: cap(String(b['text'] ?? '')) }
    case 'thinking':
    case 'redacted_thinking':
      // The CLI hides these too. Their length is enough to say that thought happened.
      return { type: 'thinking', length: String(b['thinking'] ?? '').length }
    case 'image': {
      const src = (b['source'] ?? {}) as Json
      const data = String(src['data'] ?? '')
      if (data.length > IMAGE_CAP) return { type: 'text', text: '(an image too large to show here)' }
      return { type: 'image', source: { type: 'base64', media_type: String(src['media_type'] ?? 'image/png'), data } }
    }
    case 'tool_use': {
      const input = (b['input'] ?? {}) as Json
      const slim: Json = {}
      for (const [k, v] of Object.entries(input)) slim[k] = typeof v === 'string' ? cap(v) : v
      return { type: 'tool_use', id: b['id'], name: b['name'], input: slim }
    }
    case 'tool_result': {
      const content = b['content']
      return {
        type: 'tool_result',
        tool_use_id: b['tool_use_id'],
        is_error: b['is_error'] === true,
        content: typeof content === 'string' ? cap(content) : Array.isArray(content) ? content.map(slimBlock) : content,
      }
    }
    default:
      return b
  }
}

/** One transcript line, reduced to what the canvas renders. Null for lines it never shows. */
/**
 * A transcript the session moved to holds nothing said before the move: `/clear` (Claude
 * Code clears its messages and goes on under a new session id, in a new file) or a new
 * `claude`. A resumed session's file carries its earlier exchange, written before the move.
 * The margin covers the status line's report arriving a moment after the move itself.
 */
export function isFresh(lines: Json[], since: number): boolean {
  for (const l of lines) {
    if (l['type'] !== 'user' && l['type'] !== 'assistant') continue
    const t = Date.parse(String(l['timestamp'] ?? ''))
    if (Number.isFinite(t) && t < since - 1500) return false
  }
  return true
}

function slimLine(line: Json): Json | null {
  const type = String(line['type'] ?? '')
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return null
  const msg = (line['message'] ?? {}) as Json
  const content = msg['content']
  return {
    type,
    uuid: line['uuid'],
    parentUuid: line['parentUuid'],
    timestamp: line['timestamp'],
    isMeta: line['isMeta'] === true,
    isSidechain: line['isSidechain'] === true,
    isCompactSummary: line['isCompactSummary'] === true,
    subtype: line['subtype'],
    // System lines carry their words at the top level, not in a message.
    text: typeof line['content'] === 'string' ? cap(String(line['content'])) : undefined,
    message: {
      role: msg['role'],
      id: msg['id'],
      model: msg['model'],
      stop_reason: msg['stop_reason'],
      content: typeof content === 'string' ? cap(content) : Array.isArray(content) ? content.map(slimBlock) : content,
    },
    toolUseResult: slimResult(line['toolUseResult']),
  }
}

/**
 * Claude Code's own structured account of a tool's result, which is better than the text
 * the model saw: an Edit's real hunks with line numbers, a command's stdout and stderr
 * apart. Kept shallow and capped; `originalFile` is the whole file before an edit and is
 * the one field that is routinely enormous.
 */
function slimResult(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return typeof raw === 'string' ? cap(raw, 4000) : undefined
  const out: Json = {}
  for (const [k, v] of Object.entries(raw as Json)) {
    if (k === 'originalFile' || (k === 'content' && typeof v === 'string' && v.length > TEXT_CAP)) continue
    if (typeof v === 'string') out[k] = cap(v)
    else if (Array.isArray(v)) out[k] = v.slice(0, 200)
    else if (v && typeof v === 'object') {
      const inner: Json = {}
      for (const [ik, iv] of Object.entries(v as Json)) {
        if (ik === 'content' && typeof iv === 'string') inner[ik] = cap(iv, 2000)
        else if (typeof iv !== 'object' || iv === null) inner[ik] = iv
      }
      out[k] = inner
    } else out[k] = v
  }
  return out
}

/**
 * One tail per Loom tab, from the top of the file.
 *
 * Polled rather than watched, for the reason transcript.ts gives: fs.watch on Windows
 * misses appends. 250ms is the difference between text that appears as Claude finishes a
 * block and text that appears a beat later; it is one stat() of one file.
 */
class Tail {
  private file = ''
  /** The transcript the tab's session points at, and since when: a switch to it is told once its first lines show whether it is fresh. */
  private target = ''
  private targetSince = 0
  private switching: { file: string; first: boolean; since: number } | null = null
  private offset = 0
  private carry = ''
  private timer: NodeJS.Timeout | null = null
  private reading: Promise<void> | null = null
  private meter = new CostMeter()
  /** The session's subagents' own logs, and how far each has been read. */
  private agentOffsets = new Map<string, number>()
  /** Another agent's log, when the tab runs one with an adapter (providers/logs.ts). */
  private log: { agent: string; since: number; adapter: AgentLog; state: Record<string, unknown>; locatedAt: number; stamp: string } | null = null

  constructor(
    private readonly tabId: string,
    private readonly to: WebContents
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.drain(), 250)
    void this.drain()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private emit(feed: CanvasFeed): void {
    if (!this.to.isDestroyed()) this.to.send('ember:canvas:feed', feed)
  }

  /** New steps in the session's subagents' logs (`<session>/subagents/agent-<id>.jsonl`). */
  private async readAgents(file: string): Promise<void> {
    const dir = join(file.replace(/\.jsonl$/, ''), 'subagents')
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => /^agent-.+\.jsonl$/.test(n))
    } catch {
      return
    }
    for (const n of names) {
      const path = join(dir, n)
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      const from = this.agentOffsets.get(path) ?? Math.max(0, size - 64_000)
      if (size <= from) continue
      this.agentOffsets.set(path, size)
      let text = ''
      try {
        const h = await open(path, 'r')
        const buf = Buffer.alloc(size - from)
        await h.read(buf, 0, buf.length, from)
        await h.close()
        text = buf.toString('utf8')
      } catch {
        continue
      }
      let last = ''
      let at = 0
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        try {
          const j = JSON.parse(raw) as Json
          const step = agentStep(j)
          if (step) {
            last = step
            at = Date.parse(String(j['timestamp'] ?? '')) || Date.now()
          }
        } catch {
          /* a line still being written */
        }
      }
      if (last && !this.to.isDestroyed()) this.to.send('ember:canvas:agent', { tabId: this.tabId, agentId: n.replace(/^agent-|\.jsonl$/g, ''), action: last, at })
    }
  }

  /** Read whatever has been appended since last time. Concurrent callers share one read. */
  drain(): Promise<void> {
    if (!this.reading) {
      this.reading = this.read().finally(() => {
        this.reading = null
      })
    }
    return this.reading
  }

  /** The log this tail is on, so other tabs' tails keep off it. */
  get following(): string {
    return this.file
  }

  private async read(): Promise<void> {
    // A tab that says it runs another agent is read through that agent's log, even if a
    // Claude session once bound to it: the binding outlives `claude`, the agent mark does not.
    const agent = tabAgents.get(this.tabId)
    const adapter = agent && agent.agent !== 'claude' ? AGENT_LOGS[agent.agent] : undefined
    if (agent && adapter) return this.readLog(agent, adapter)
    this.log = null
    const file = transcriptPath(this.tabId)
    if (!file) return
    if (file !== this.target) {
      this.target = file
      this.targetSince = Date.now()
    }
    if (file !== this.file) {
      // A new session in the same tab: `/clear`, `/resume`, or `claude` run again. The
      // canvas marks the seam and reads the new one from its first line, because a resumed
      // session's history is exactly what you want to see again.
      if (!existsSync(file)) return
      const first = !this.file
      this.file = file
      this.offset = 0
      this.carry = ''
      this.meter = new CostMeter()
      // Told with the first lines, which say whether the session is fresh (`/clear`, a new
      // `claude`) or one with a history (`/resume`, `--continue`).
      this.switching = { file, first, since: this.targetSince }
    }
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size < this.offset) this.offset = 0
    if (size === this.offset) return
    const handle = await open(file, 'r')
    try {
      const length = size - this.offset
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, this.offset)
      this.offset = size
      this.carry += buf.toString('utf8')
    } finally {
      await handle.close()
    }
    const lines: Json[] = []
    let costed = false
    let cut = this.carry.indexOf('\n')
    while (cut !== -1) {
      const raw = this.carry.slice(0, cut).trim()
      this.carry = this.carry.slice(cut + 1)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Json
          if (this.meter.add(parsed)) costed = true
          const slim = slimLine(parsed)
          if (slim) lines.push(slim)
        } catch {
          /* half a line; the rest arrives with the next append */
        }
      }
      cut = this.carry.indexOf('\n')
    }
    const sw = this.switching
    if (sw && lines.length) {
      this.switching = null
      this.emit({ tabId: this.tabId, kind: 'switch', file: sw.file, first: sw.first, fresh: isFresh(lines, sw.since) })
    }
    if (lines.length) this.emit({ tabId: this.tabId, kind: 'lines', lines })
    if (costed && !this.to.isDestroyed()) this.to.send('ember:canvas:cost', this.meter.summary(this.tabId))
    await this.readAgents(file)
  }

  /**
   * Follow a non-Claude agent's own session log. Nothing binds a tab to its file the way
   * the panel server binds Claude's, so it is looked for — the newest log for the tab's
   * folder written since the agent started — every couple of seconds until found, and
   * after that in case a newer session starts in the same tab (`/new`, the agent run
   * again). Lines go through the adapter into Claude's shape and on the same way.
   *
   * The cost meter and subagent steps stay Claude's: they read Claude's own fields.
   */
  private async readLog(agent: TabAgent, adapter: AgentLog): Promise<void> {
    if (!this.log || this.log.agent !== agent.agent || this.log.since !== agent.since || this.log.adapter !== adapter) {
      this.log = { agent: agent.agent, since: agent.since, adapter, state: {}, locatedAt: 0, stamp: '' }
    }
    const log = this.log
    // Looked for even before the folder is known: an agent started with the shell runs
    // before any prompt has said where it is, and the adapter then takes the newest session.
    if (Date.now() - log.locatedAt >= RELOCATE_MS) {
      log.locatedAt = Date.now()
      const taken = new Set<string>()
      for (const [id, t] of tails) if (id !== this.tabId && t.following) taken.add(t.following)
      const found = adapter.locate(agent.cwd, agent.since, taken)
      // Only a session that started after the one on screen replaces it; one that merely
      // wrote more recently is another tab's, or an old one resumed elsewhere.
      if (found && found !== this.file && (!this.isMine() || born(found) >= born(this.file))) {
        const first = !this.file
        this.file = found
        this.offset = 0
        this.carry = ''
        log.state = {}
        log.stamp = ''
        this.emit({ tabId: this.tabId, kind: 'switch', file: found, first })
      }
    }
    if (!this.isMine()) return
    const file = this.file
    let size = 0
    let mtime = 0
    try {
      const st = statSync(file)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      return
    }
    const lines: Json[] = []
    const take = (records: Json[]): void => {
      for (const raw of adapter.convert(records, log.state)) {
        const slim = slimLine(raw)
        if (slim) lines.push(slim)
      }
    }
    if (adapter.kind === 'doc') {
      // Rewritten whole: read all of it again and send everything; Feed drops uuids it has.
      const stamp = `${size}:${mtime}`
      if (stamp === log.stamp) return
      let doc: unknown
      try {
        doc = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return // caught mid-write; the next poll sees it whole
      }
      log.stamp = stamp
      log.state = {}
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) take([doc as Json])
    } else {
      if (size < this.offset) {
        // Truncated or replaced: start over.
        this.offset = 0
        this.carry = ''
        log.state = {}
      }
      if (size === this.offset) return
      const handle = await open(file, 'r')
      try {
        const length = size - this.offset
        const buf = Buffer.alloc(length)
        await handle.read(buf, 0, length, this.offset)
        this.offset = size
        this.carry += buf.toString('utf8')
      } finally {
        await handle.close()
      }
      const records: Json[] = []
      let cut = this.carry.indexOf('\n')
      while (cut !== -1) {
        const raw = this.carry.slice(0, cut).trim()
        this.carry = this.carry.slice(cut + 1)
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed as Json)
          } catch {
            /* half a line; the rest arrives with the next append */
          }
        }
        cut = this.carry.indexOf('\n')
      }
      if (records.length) take(records)
    }
    if (lines.length) this.emit({ tabId: this.tabId, kind: 'lines', lines })
  }

  /** Whether the file on screen is the agent's log (and not a Claude transcript from before). */
  private isMine(): boolean {
    return !!this.log && !!this.file && this.file !== transcriptPath(this.tabId)
  }
}

/** How often a tab following another agent looks for its log, or a newer one. */
const RELOCATE_MS = 2000

/** When a file was created: a newer session's log is a newer file. */
function born(path: string): number {
  try {
    const st = statSync(path)
    return st.birthtimeMs || st.ctimeMs
  } catch {
    return 0
  }
}

/** Which agent each Loom tab runs, as the renderer last said (from the shim's `ember-agent=` mark). */
interface TabAgent {
  agent: string
  cwd: string
  since: number
}
const tabAgents = new Map<string, TabAgent>()

/** A step of a subagent, said short: the tool and what it was given, or the first words it said. */
function agentStep(line: Json): string {
  if (line['type'] !== 'assistant') return ''
  const content = ((line['message'] ?? {}) as Json)['content']
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const b of content as Json[]) {
    if (b['type'] === 'tool_use') {
      const input = (b['input'] ?? {}) as Json
      const arg = String(input['description'] ?? input['file_path'] ?? input['pattern'] ?? input['command'] ?? input['query'] ?? input['url'] ?? '')
      const name = String(b['name'] ?? '').replace(/^mcp__[^_]+__/, '')
      out = `${name}${arg ? ` ${arg.split(/[\\/]/).pop()!.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`
    } else if (b['type'] === 'text' && String(b['text'] ?? '').trim()) {
      out = String(b['text']).replace(/\s+/g, ' ').trim().slice(0, 100)
    }
  }
  return out
}

const tails = new Map<string, Tail>()

// ---------------------------------------------------------------- annotate round trip

const annotateWaiters = new Map<string, (r: CanvasAnnotateResult) => void>()

/**
 * Ask the renderer to draw on the tab's live page, and wait for what it found.
 *
 * The answer matters to the agent: "marked 2 of 3, could not find 'Checkout'" is
 * something it can act on, where fire-and-forget would leave it pointing at nothing.
 */
export function requestAnnotate(
  broadcast: (channel: string, payload: unknown) => void,
  payload: Json
): Promise<CanvasAnnotateResult> {
  const reqId = randomBytes(8).toString('hex')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      annotateWaiters.delete(reqId)
      resolve({ ok: false, error: 'the canvas did not answer — is this a canvas tab with a page open?' })
    }, 8000)
    annotateWaiters.set(reqId, (r) => {
      clearTimeout(timer)
      annotateWaiters.delete(reqId)
      resolve(r)
    })
    broadcast('ember:canvas:annotate', { ...payload, reqId })
  })
}

const pointWaiters = new Map<string, (r: { ok: boolean; error?: string; found?: string }) => void>()

/** Point at something on a Loom canvas (a node in a diagram, a row in a table) with Ember's pointer, drawn in the canvas. */
export function requestCanvasPoint(
  broadcast: (channel: string, payload: unknown) => void,
  payload: Json
): Promise<{ ok: boolean; error?: string; found?: string }> {
  const reqId = randomBytes(8).toString('hex')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pointWaiters.delete(reqId)
      resolve({ ok: false, error: 'the canvas did not answer — is this a canvas tab with that object on it?' })
    }, 6000)
    pointWaiters.set(reqId, (r) => {
      clearTimeout(timer)
      pointWaiters.delete(reqId)
      resolve(r)
    })
    broadcast('ember:canvas:point', { ...payload, reqId })
  })
}

// ---------------------------------------------------------------- wiring

export interface CanvasDeps {
  /** The bridge's origin, for URLs the canvas can load. Empty until it is listening. */
  origin: () => string
  /** Host a small document on the bridge (a diagram from a mermaid fence) and give back its URL. */
  hostDoc: (tabId: string, title: string, format: 'markdown' | 'mermaid' | 'code' | 'html' | 'view', content: string) => string
  /** This tab is a Loom tab: its pushes accumulate instead of replacing one another. */
  markCanvasTab: (tabId: string, on: boolean) => void
}

/** What the user has placed on each Loom tab's canvas, as its renderer last reported. */
const screens = new Map<string, ScreenItem[]>()

export function screenOf(tabId: string): ScreenItem[] {
  return screens.get(tabId) ?? []
}

export function registerCanvas(deps: CanvasDeps): void {
  ipcMain.on('ember:canvas:tabAgent', (_e, tabId: unknown, agent: unknown, cwd: unknown, since: unknown) => {
    if (typeof tabId !== 'string' || !tabId) return
    if (typeof agent !== 'string' || !agent) {
      // The agent has gone: stop following its log. A Claude binding, if any, takes over.
      tabAgents.delete(tabId)
      return
    }
    tabAgents.set(tabId, {
      agent: agent.slice(0, 40),
      cwd: typeof cwd === 'string' ? cwd : '',
      since: typeof since === 'number' && Number.isFinite(since) ? since : Date.now(),
    })
    void tails.get(tabId)?.drain()
  })
  ipcMain.on('ember:canvas:screen', (_e, tabId: string, items: ScreenItem[]) => {
    if (typeof tabId === 'string' && Array.isArray(items)) screens.set(tabId, items.slice(0, 40))
  })
  ipcMain.handle('ember:canvas:watch', (e, tabId: string) => {
    tails.get(tabId)?.stop()
    const tail = new Tail(tabId, e.sender)
    tails.set(tabId, tail)
    deps.markCanvasTab(tabId, true)
    tail.start()
    return true
  })
  ipcMain.on('ember:canvas:unwatch', (_e, tabId: string) => {
    tails.get(tabId)?.stop()
    tails.delete(tabId)
    deps.markCanvasTab(tabId, false)
  })
  ipcMain.handle('ember:canvas:drain', async (_e, tabId: string) => {
    await tails.get(tabId)?.drain()
    return true
  })
  ipcMain.handle('ember:canvas:media', (_e, path: string) => {
    const r = registerMedia(path)
    if ('error' in r) return { error: r.error }
    const origin = deps.origin()
    return origin ? { src: `${origin}/media/${r.id}`, kind: r.kind, name: r.name } : { error: 'bridge not listening' }
  })
  ipcMain.handle('ember:canvas:doc', (_e, tabId: string, title: string, format: 'markdown' | 'mermaid' | 'code' | 'html' | 'view', content: string) =>
    deps.hostDoc(tabId, title, format, content)
  )
  ipcMain.on('ember:canvas:pointed', (_e, reqId: string, result: { ok: boolean; error?: string; found?: string }) => {
    pointWaiters.get(reqId)?.(result)
  })
  ipcMain.on('ember:canvas:annotated', (_e, reqId: string, result: CanvasAnnotateResult) => {
    annotateWaiters.get(reqId)?.(result)
  })
}
