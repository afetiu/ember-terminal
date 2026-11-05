import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * The stream engine: where an agent CLI's *live area* is on its screen — the rows it keeps
 * redrawing at the bottom (prompt, menus, pickers, dialogs, queue, working line, status) —
 * read from the PTY byte stream as the terminal parses it, not guessed from glyphs.
 * docs/specs/stream-engine.md has the evidence per CLI; the short of it:
 *
 *  - **Codex** (ratatui inline viewport) states its viewport exactly: it clears it from its
 *    top row (`CUP top;1` + `ED 0`) whenever the viewport moves or changes size, and writes
 *    history above it inside a scroll region `DECSTBM 1;top`. Frames are bracketed by
 *    synchronized output (`?2026h` … `?2026l`).
 *  - **Ink log-update** renderers erase the previous frame line by line (`EL 2`, `CUU 1`) from
 *    the bottom to its top row before drawing the next: the topmost erased row is the top.
 *  - **Claude Code** (2.1, classic renderer) is a cell-diff renderer: each frame rewrites only
 *    the rows that changed, relative to the frame's last row, and never writes above the
 *    frame's top. The stream gives the frame's bottom exactly, and every row it changes is
 *    inside the frame — but rows that have not changed since the frame was laid out (the
 *    prompt box's top border, a dialog's top border) are not restated. For those the engine
 *    takes the one structural fact every Claude bottom area has: it starts at a full-width
 *    border row, searched only among the rows the renderer wrote since it last moved the
 *    frame (never in the conversation above), and extended up over rows the renderer keeps
 *    animating (the working line and the queue under it).
 *  - **Alt-screen** (full-screen) apps can't be split: the engine says `full`.
 *
 * The engine only observes: it registers parser hooks that return false (xterm still does
 * the work) and reads the buffer. It runs on any xterm `Terminal`, opened or not, so the
 * same code replays recordings in node (scripts/test-stream-engine.mjs) and runs live in
 * the renderer on the session's own terminal.
 *
 * Region rows are *screen* rows (0 = the top row of the screen), because an inline TUI's
 * live area is always on screen; `abs` gives buffer lines.
 */

export type LiveModel = 'viewport' | 'log-update' | 'diff' | 'none'

export interface LiveRegion {
  /** `split`: rows top..bottom are the live area. `full`: show the whole terminal (alt screen). `none`: nothing drawn yet. */
  mode: 'split' | 'full' | 'none'
  /** Screen rows, inclusive. */
  top: number
  bottom: number
  /** The buffer line of the screen's first row when this was read (top + base = buffer line). */
  base: number
  /** The cursor, screen row/col, and whether the app shows it. */
  cursor: { x: number; y: number; visible: boolean }
  /** Which evidence placed the top, for probes and the spec's tables. */
  why: string
  model: LiveModel
  /** Frames seen so far. */
  seq: number
}

export interface EngineOptions {
  /** The agent the shell said it started: 'claude', 'codex', … (only picks a starting model). */
  agent?: string | null
  /** Rows changed in a frame at most for it to count as an animation (working line, typing). */
  smallFrame?: number
  /** How long an animated row keeps the top up there with no further change, in ms. */
  animMs?: number
  now?: () => number
}

/** A row the renderer draws as a border: one character repeated over (nearly) the whole width. */
export function isBorderRow(text: string, cols: number): boolean {
  const t = text.replace(/\s+$/, '')
  if (t.length < Math.max(8, Math.floor(cols * 0.6))) return false
  const s = t.replace(/^ /, '')
  const c = s[0]
  if (!c || /[\p{L}\p{N}\s]/u.test(c)) return false
  for (const ch of s) if (ch !== c) return false
  return true
}

export class StreamEngine {
  private readonly hooks: IDisposable[] = []
  private readonly opts: Required<Omit<EngineOptions, 'agent'>> & { agent: string | null }
  private model: LiveModel = 'none'
  /** Inside a synchronized-output frame. */
  private sync = false
  private alt = false
  private cursorVisible = true
  /** Scroll margins, 1-based as sent, 0 = unset (full screen). */
  private margin = { top: 0, bottom: 0 }
  /** Viewport (ratatui): the viewport's top, screen row; and the base it was measured against. */
  private vTop = -1
  private lastBase = 0
  /** log-update: the topmost row an `EL 2` hit in this frame. */
  private eraseTop = Infinity
  private eraseCount = 0
  /** diff: the screen as last read (to tell which rows a frame changed). */
  private prev: string[] = []
  /** diff: rows at or below this were written since the frame last moved; nothing above is live. */
  private floor = 0
  /** diff: rows a small frame changed (distance from the bottom → when). */
  private anim = new Map<number, number>()
  private top = -1
  private seqNo = 0
  private last: LiveRegion | null = null
  /** Committed (finished) lines not yet taken: buffer line numbers. */
  private committedTo = 0
  private pending: string[] = []

  private readonly term: Terminal

  constructor(term: Terminal, opts: EngineOptions = {}) {
    this.term = term
    this.opts = {
      agent: opts.agent ?? null,
      smallFrame: opts.smallFrame ?? 4,
      animMs: opts.animMs ?? 800,
      now: opts.now ?? (() => Date.now()),
    }
    if (this.opts.agent === 'codex') this.model = 'viewport'
    else if (this.opts.agent === 'claude') this.model = 'diff'
    const p = term.parser
    this.hooks.push(
      p.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this.mode(params, true)),
      p.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this.mode(params, false)),
      p.registerCsiHandler({ final: 'r' }, (params) => this.margins(params)),
      p.registerCsiHandler({ final: 'J' }, (params) => this.eraseDisplay(params)),
      p.registerCsiHandler({ final: 'K' }, (params) => this.eraseLine(params)),
      term.onResize(() => {
        this.resized = true
      })
    )
    this.lastBase = this.buf.baseY
    this.committedTo = this.buf.baseY
  }

  private get buf() {
    return this.term.buffer.active
  }

  /** Base moved since last looked: a whole-screen scroll moves the viewport up with the text. */
  private syncBase(): void {
    const base = this.buf.baseY
    const d = base - this.lastBase
    this.lastBase = base
    if (!d || this.vTop < 0) return
    const partial = this.margin.top === 1 && this.margin.bottom > 0 && this.margin.bottom < this.term.rows
    if (!partial) this.vTop = Math.max(0, this.vTop - d)
  }

  private mode(params: (number | number[])[], on: boolean): boolean {
    for (const p of params) {
      const n = typeof p === 'number' ? p : p[0]
      if (n === 2026) {
        this.sync = on
      } else if (n === 1049 || n === 1047 || n === 47) this.alt = on
      else if (n === 25) this.cursorVisible = on
    }
    return false
  }

  private margins(params: (number | number[])[]): boolean {
    this.syncBase()
    const t = Number(params[0] ?? 0) || 0
    const b = Number(params[1] ?? 0) || 0
    this.margin = { top: t, bottom: b }
    // History goes in above the viewport: the region's last row is the one above it.
    if (t === 1 && b > 0 && b < this.term.rows) {
      this.vTop = b
      this.model = 'viewport'
    }
    return false
  }

  private eraseDisplay(params: (number | number[])[]): boolean {
    this.syncBase()
    const n = Number(params[0] ?? 0) || 0
    // The viewport cleared from its top row: Codex does this every time it moves or resizes.
    if (n === 0 && this.buf.cursorX === 0 && this.model !== 'diff') {
      this.vTop = this.buf.cursorY
      if (this.model === 'none') this.model = 'viewport'
    }
    if (n === 2 || n === 3) this.vTop = this.model === 'viewport' ? 0 : this.vTop
    return false
  }

  private eraseLine(params: (number | number[])[]): boolean {
    if ((Number(params[0] ?? 0) || 0) === 2) {
      this.eraseTop = Math.min(this.eraseTop, this.buf.cursorY)
      this.eraseCount++
    }
    return false
  }

  /** The screen's rows as text. */
  private rows(): string[] {
    const b = this.buf
    const out: string[] = []
    for (let y = 0; y < this.term.rows; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '')
    return out
  }

  /** The last row with anything on it, or -1. */
  private static lastDrawn(rows: string[], from = 0): number {
    for (let y = rows.length - 1; y >= from; y--) if (rows[y]!.trim()) return y
    return -1
  }

  /**
   * After the terminal has parsed a chunk (the write callback): the live region, or null
   * while a synchronized frame is still open (the frame is not complete yet).
   */
  frame(): LiveRegion | null {
    if (this.sync) return null
    this.syncBase()
    const rows = this.rows()
    const b = this.buf
    const now = this.opts.now()
    this.seqNo++
    const cursor = { x: b.cursorX, y: b.cursorY, visible: this.cursorVisible }
    const base = b.baseY
    const done = (r: Omit<LiveRegion, 'base' | 'cursor' | 'seq' | 'model'>): LiveRegion => {
      const out: LiveRegion = { ...r, base, cursor, seq: this.seqNo, model: this.model }
      this.last = out
      if (out.mode === 'split') this.commitAbove(base + out.top)
      return out
    }
    if (this.alt || b.type === 'alternate') {
      this.prev = rows
      return done({ mode: 'full', top: 0, bottom: this.term.rows - 1, why: 'alt screen' })
    }
    // Shifted by a whole-screen scroll: what was row y is row y - d now.
    const shift = this.prevBase === undefined ? 0 : base - this.prevBase
    this.prevBase = base
    const prev = shift > 0 ? this.prev.slice(shift) : this.prev
    if (shift > 0) {
      this.floor = Math.max(0, this.floor - shift)
      if (this.top >= 0) this.top = Math.max(0, this.top - shift)
    }
    const changed: number[] = []
    for (let y = 0; y < rows.length; y++) if (rows[y] !== (prev[y] ?? '')) changed.push(y)
    this.prev = rows
    const erased = this.eraseCount >= 2 ? this.eraseTop : Infinity
    this.eraseTop = Infinity
    this.eraseCount = 0
    const bottom = StreamEngine.lastDrawn(rows)
    if (bottom < 0) return done({ mode: 'none', top: 0, bottom: -1, why: 'nothing drawn' })

    // ratatui: the viewport, exactly.
    if (this.model === 'viewport' && this.vTop >= 0) {
      const top = Math.min(this.vTop, bottom)
      const last = Math.max(StreamEngine.lastDrawn(rows, top), top)
      this.top = top
      return done({ mode: 'split', top, bottom: last, why: 'viewport' })
    }

    // Ink log-update: erased from the bottom up to the frame's top before redrawing it.
    if (erased !== Infinity && this.model !== 'diff') {
      this.model = 'log-update'
      this.top = Math.min(erased, bottom)
      return done({ mode: 'split', top: this.top, bottom, why: 'erased lines' })
    }
    if (this.model === 'log-update' && this.top >= 0) {
      return done({ mode: 'split', top: Math.min(this.top, bottom), bottom, why: 'last erase' })
    }

    // The diff renderer (Claude Code), and the reading for a CLI that has not said which it is.
    // A resize reflows every row: that is xterm's doing, not a frame of the app's.
    if (this.resized) {
      this.resized = false
      changed.length = 0
    }
    if (changed.length) {
      const cMin = changed[0]!
      const small = changed.length <= this.opts.smallFrame
      // A frame that rewrote from the live top (or above): the renderer moved its frame there
      // or redrew it. Nothing above that row is live from now on.
      if (this.top < 0 || cMin <= this.top) this.floor = Math.min(cMin, bottom)
      // Rows a small frame changed are the ones the app animates (working line, timers, the
      // caret's row). Kept as a distance from the bottom: the frame moves down as the
      // conversation grows above it, and the bottom moves with it.
      if (small) for (const row of changed) if (row <= bottom) this.anim.set(bottom - row, now)
      // The frame the app drew for the person's Enter during a turn: a queued message, inserted
      // above the working line. Its rows are part of the live area while the turn runs.
      if (now < this.expectQueue) {
        this.expectQueue = 0
        // A second message joins the first: the queue's top stays the first one's.
        const held = this.queue ? this.findQueue(rows, bottom) : -1
        const at = held >= 0 && held < cMin ? held : cMin
        this.queue = { dist: bottom - at, text: rows[at] ?? '' }
      }
    }
    for (const [dist, at] of this.anim) {
      const row = bottom - dist
      if (now - at >= this.opts.animMs || row < this.floor || row < 0 || !rows[row]!.trim()) this.anim.delete(dist)
    }
    let border = -1
    for (let y = this.floor; y <= bottom; y++)
      if (isBorderRow(rows[y]!, this.term.cols)) {
        border = y
        break
      }
    let animTop = Infinity
    for (const dist of this.anim.keys()) animTop = Math.min(animTop, bottom - dist)
    // The queue holds while the turn does and its rows stay where they were drawn.
    if (this.queue) {
      // Its first row, as drawn, where it was or moved with the frame: gone, the queue was
      // sent (or taken back to edit).
      const at = animTop === Infinity ? -1 : this.findQueue(rows, bottom, animTop)
      if (at < 0) this.queue = null
      else {
        this.queue.dist = bottom - at
        animTop = Math.min(animTop, at)
      }
    }
    this.working = animTop < (border < 0 ? bottom : border)
    let top: number
    let why: string
    if (border >= 0 && animTop < border) {
      top = animTop
      why = this.queue ? 'queue + animated rows over the border' : 'animated row over the border'
    } else if (border >= 0) {
      top = border
      why = 'border'
    } else if (animTop !== Infinity) {
      top = animTop
      why = 'animated row'
    } else {
      // Nothing to place the top by (the app between two drawings): it stays where it was,
      // never up to the floor and the conversation's rows.
      top = this.top >= this.floor ? this.top : this.floor
      why = this.top >= this.floor ? 'held' : 'frame floor'
    }
    // The caret is always the app's: never left out.
    if (cursor.visible && cursor.y >= this.floor && cursor.y < top) {
      top = cursor.y
      why += ' + caret'
    }
    top = Math.min(top, bottom)
    this.top = top
    return done({ mode: 'split', top, bottom, why })
  }

  private prevBase: number | undefined
  private resized = false
  /** Until when a frame is taken as the queued message the person's Enter made. */
  private expectQueue = 0
  /** The queued messages above the working line: their top as a distance from the bottom. */
  private queue: { dist: number; text: string } | null = null

  /**
   * What the person typed into the PTY (keys, paste), before it is written. An Enter while
   * the agent is animating its working line queues a message; the next frame draws it.
   */
  noteInput(data: string): void {
    if (this.model !== 'diff' || !/\r/.test(data) || /^\x1b\[200~/.test(data)) return
    if (!this.working) return
    this.expectQueue = this.opts.now() + 1500
  }

  /** Whether the frame has rows animating over its border (the working line): a turn is on. */
  private working = false

  /** The queue's first row on screen now: where it was, or the nearest row with its text, above `below`. */
  private findQueue(rows: string[], bottom: number, below = bottom + 1): number {
    const q = this.queue
    if (!q || !q.text.trim()) return -1
    const was = bottom - q.dist
    if (was >= this.floor && was < below && rows[was] === q.text) return was
    let best = -1
    for (let y = this.floor; y < Math.min(below, rows.length); y++)
      if (rows[y] === q.text && (best < 0 || Math.abs(y - was) < Math.abs(best - was))) best = y
    return best
  }

  /** Inside a synchronized-output frame the app has not finished. */
  get inSync(): boolean {
    return this.sync
  }

  /** Whether anything is drawn in the region's rows. */
  drawnIn(r: LiveRegion): boolean {
    const b = this.buf
    for (let y = r.top; y <= r.bottom; y++) if (b.getLine(b.baseY + y)?.translateToString(true).trim()) return true
    return false
  }

  /** The agent the engine reads for (as last reset). */
  get agent(): string | null {
    return this.opts.agent
  }

  /** The latest region read. */
  get region(): LiveRegion | null {
    return this.last
  }

  /** Lines that left the live area for good since last asked, as plain text. */
  takeCommitted(): string[] {
    const out = this.pending
    this.pending = []
    return out
  }

  private commitAbove(line: number): void {
    const b = this.buf
    if (line <= this.committedTo) return
    // A shell or an earlier agent's output is not this agent's: begin where it was first seen.
    for (let y = this.committedTo; y < line; y++) this.pending.push(b.getLine(y)?.translateToString(true) ?? '')
    this.committedTo = line
    if (this.pending.length > 2000) this.pending.splice(0, this.pending.length - 2000)
  }

  /** Forget everything (a new agent, /clear): the next frame is read from scratch. */
  reset(agent?: string | null): void {
    if (agent !== undefined) this.opts.agent = agent
    this.model = this.opts.agent === 'codex' ? 'viewport' : this.opts.agent === 'claude' ? 'diff' : 'none'
    this.vTop = -1
    this.top = -1
    this.floor = 0
    this.anim = new Map()
    this.queue = null
    this.expectQueue = 0
    // What is on screen now (the shell, the command that started the agent) is not the
    // agent's: only what changes from here is.
    this.prev = this.rows()
    this.prevBase = this.buf.baseY
    this.lastBase = this.buf.baseY
    this.last = null
    this.committedTo = this.buf.baseY + this.buf.cursorY
    this.pending = []
  }

  dispose(): void {
    for (const h of this.hooks) h.dispose()
    this.hooks.length = 0
  }
}
