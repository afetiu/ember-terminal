import { ipcMain, type WebContents } from 'electron'
import { existsSync, statSync, createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, basename, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CanvasAnnotateResult, CanvasFeed } from '../shared/types.js'
import { transcriptPath } from './transcript.js'

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
  private offset = 0
  private carry = ''
  private timer: NodeJS.Timeout | null = null
  private reading: Promise<void> | null = null

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

  /** Read whatever has been appended since last time. Concurrent callers share one read. */
  drain(): Promise<void> {
    if (!this.reading) {
      this.reading = this.read().finally(() => {
        this.reading = null
      })
    }
    return this.reading
  }

  private async read(): Promise<void> {
    const file = transcriptPath(this.tabId)
    if (!file) return
    if (file !== this.file) {
      // A new session in the same tab: `/clear`, `/resume`, or `claude` run again. The
      // canvas marks the seam and reads the new one from its first line, because a resumed
      // session's history is exactly what you want to see again.
      if (!existsSync(file)) return
      const first = !this.file
      this.file = file
      this.offset = 0
      this.carry = ''
      this.emit({ tabId: this.tabId, kind: 'switch', file, first })
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
    let cut = this.carry.indexOf('\n')
    while (cut !== -1) {
      const raw = this.carry.slice(0, cut).trim()
      this.carry = this.carry.slice(cut + 1)
      if (raw) {
        try {
          const slim = slimLine(JSON.parse(raw) as Json)
          if (slim) lines.push(slim)
        } catch {
          /* half a line; the rest arrives with the next append */
        }
      }
      cut = this.carry.indexOf('\n')
    }
    if (lines.length) this.emit({ tabId: this.tabId, kind: 'lines', lines })
  }
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
      resolve({ ok: false, error: 'the canvas did not answer — is this a Loom tab with a page open?' })
    }, 8000)
    annotateWaiters.set(reqId, (r) => {
      clearTimeout(timer)
      annotateWaiters.delete(reqId)
      resolve(r)
    })
    broadcast('ember:canvas:annotate', { ...payload, reqId })
  })
}

// ---------------------------------------------------------------- wiring

export interface CanvasDeps {
  /** The bridge's origin, for URLs the canvas can load. Empty until it is listening. */
  origin: () => string
  /** Host a small document on the bridge (a diagram from a mermaid fence) and give back its URL. */
  hostDoc: (tabId: string, title: string, format: 'markdown' | 'mermaid' | 'code', content: string) => string
  /** This tab is a Loom tab: its pushes accumulate instead of replacing one another. */
  markCanvasTab: (tabId: string, on: boolean) => void
}

export function registerCanvas(deps: CanvasDeps): void {
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
  ipcMain.handle('ember:canvas:doc', (_e, tabId: string, title: string, format: 'markdown' | 'mermaid' | 'code', content: string) =>
    deps.hostDoc(tabId, title, format, content)
  )
  ipcMain.on('ember:canvas:annotated', (_e, reqId: string, result: CanvasAnnotateResult) => {
    annotateWaiters.get(reqId)?.(result)
  })
}
