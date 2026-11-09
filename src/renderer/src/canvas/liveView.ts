import { Terminal, type IBufferCell, type IBufferLine } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { StreamEngine, type LiveRegion } from '@shared/streamEngine'
import type { Session } from '../core/Session'

/**
 * The CLI box: only the agent CLI's live area (docs/specs/stream-engine.md).
 *
 * The tab's real terminal keeps running full size — its PTY is the whole tab, so no picker
 * or dialog is ever drawn short — and keeps the keyboard, but is not seen while the canvas
 * is on. The stream engine reads, as the real terminal parses each chunk, which of its rows
 * are the live area; on every complete frame those rows (characters, colours, attributes, the
 * caret) are copied into this display-only terminal, which is exactly that many rows tall.
 * The copy is one write per frame, so the box never shows half a frame.
 */
export class LiveView {
  readonly el: HTMLElement
  readonly term: Terminal
  readonly engine: StreamEngine
  /** The region the box shows now (the engine's last complete frame). */
  region: LiveRegion | null = null
  /** Rows shown, and the first of them in the real terminal's screen. */
  shown = { rows: 0, from: 0, cols: 0, total: 0 }
  /** Every frame drawn, for probes: when, the region, the rows shown. */
  readonly log: Array<{ t: number; top: number; bottom: number; rows: number; from: number; why: string }> = []
  private readonly subs: Array<{ dispose(): void }> = []
  private redraw = 0
  private settle = 0
  private frameOut: { out: string; shown: LiveView['shown']; r: LiveRegion } | null = null
  private pendingSince = 0
  private lapse = 0
  private cap = 12
  private on = false
  private opened = false
  private webgl: WebglAddon | null = null
  /** Called when the region's height changed: the tab lays itself out again. */
  onHeight: (() => void) | null = null
  /** Called once a frame is in the box's terminal (parsed, painted on the next frame): size the box now. */
  onDrawn: (() => void) | null = null
  private readonly session: Session

  constructor(session: Session, cursorColor: string) {
    this.session = session
    this.el = document.createElement('div')
    this.el.className = 'loom-live'
    const src = session.term.options
    this.term = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      disableStdin: true,
      scrollback: 0,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'bar',
      fontFamily: src.fontFamily,
      fontSize: src.fontSize,
      fontWeight: src.fontWeight,
      fontWeightBold: src.fontWeightBold,
      lineHeight: src.lineHeight,
      letterSpacing: src.letterSpacing,
      drawBoldTextInBrightColors: src.drawBoldTextInBrightColors,
      minimumContrastRatio: src.minimumContrastRatio,
      theme: { ...src.theme, cursor: cursorColor, cursorAccent: src.theme?.background ?? '#000' },
      cols: Math.max(2, session.term.cols),
      rows: this.cap,
    })
    this.engine = new StreamEngine(session.term, { agent: null })
    // Every chunk the real terminal has parsed: read the frame; draw it on the next paint.
    this.subs.push(
      session.term.onWriteParsed(() => this.read()),
      session.term.onResize(() => this.read()),
      session.term.onData((d) => this.engine.noteInput(d)),
      // The shim's announcement comes in the stream just before the agent's first byte: read
      // its screen from exactly there (layout learns of the agent a frame later).
      session.term.parser.registerOscHandler(133, (data) => {
        const a = /^E;ember-agent=([a-z-]+)/.exec(data)
        if (a?.[1]) this.engine.reset(a[1])
        return false
      })
    )
    // A click in the box is a click into the CLI: the keyboard is the real terminal's.
    this.el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      session.term.focus()
    })
  }

  /** The box is in the tree: open its terminal once. */
  private open(): void {
    if (this.opened || !this.el.isConnected) return
    this.opened = true
    const unicode = new Unicode11Addon()
    this.term.loadAddon(unicode)
    this.term.unicode.activeVersion = '11'
    this.term.open(this.el)
    // The real terminal's renderer, so the same font makes the same cells: WebGL floors the
    // glyph width to whole device pixels and the DOM renderer does not (7.0 px against 7.62 at
    // 13 px), and the box's columns would run past its right edge by a column in thirteen.
    if (this.session.gpu) {
      try {
        const gl = new WebglAddon()
        const drop = () => {
          if (this.webgl !== gl) return
          this.webgl = null
          gl.dispose()
        }
        gl.onContextLoss(drop)
        this.term.loadAddon(gl)
        this.webgl = gl
        // Both on the DOM renderer from then on, so the cells still match.
        this.session.onGpuLost(drop)
      } catch {
        /* the DOM renderer, as the real terminal will be once it loses its context too */
      }
    }
  }

  /** The real terminal's font, so the box's cells are its cells (a font change in Settings follows). */
  private syncFont(): void {
    const src = this.session.term.options
    const o = this.term.options
    if (o.fontFamily !== src.fontFamily) o.fontFamily = src.fontFamily
    if (o.fontSize !== src.fontSize) o.fontSize = src.fontSize
    if (o.fontWeight !== src.fontWeight) o.fontWeight = src.fontWeight
    if (o.fontWeightBold !== src.fontWeightBold) o.fontWeightBold = src.fontWeightBold
    if (o.lineHeight !== src.lineHeight) o.lineHeight = src.lineHeight
    if (o.letterSpacing !== src.letterSpacing) o.letterSpacing = src.letterSpacing
  }

  /** An agent came (or went): read its screen afresh from where it starts drawing. */
  start(agent: string | null): void {
    if (this.engine.agent !== agent) this.engine.reset(agent)
    this.region = null
    this.frameOut = null
    this.shown = { rows: 0, from: 0, cols: 0, total: 0 }
    this.read()
  }

  /** The box shows (canvas on, the agent's live area at the bottom) or not. */
  show(on: boolean): void {
    this.on = on
    this.el.classList.toggle('is-on', on)
    if (on) {
      this.open()
      this.draw()
    }
  }

  /** The most rows the box may have, from the tab's height. */
  setCap(rows: number): void {
    const cap = Math.max(4, rows)
    if (cap === this.cap) return
    this.cap = cap
    this.compose()
    this.draw()
  }

  /** Rows the box needs now: the live area, at most the cap. */
  get rows(): number {
    const r = this.region
    if (!r || r.mode !== 'split') return 0
    return Math.min(this.cap, r.bottom - r.top + 1)
  }

  private read(): void {
    const r = this.engine.frame()
    if (!r) return
    // An app's live area is never empty: one with nothing drawn in it is the app between
    // clearing it and drawing it again (Codex, when its viewport moves). Not a frame to show.
    if (r.mode === 'split' && !this.engine.drawnIn(r)) return
    const before = this.rows
    const was = this.region
    this.region = r
    this.compose()
    // An animation that lapses changes the area with nothing written: look again then.
    window.clearTimeout(this.lapse)
    this.lapse = window.setTimeout(() => this.read(), 850)
    if (this.rows !== before) this.onHeight?.()
    const go = () => {
      this.pendingSince = 0
      if (!this.redraw) this.redraw = requestAnimationFrame(() => this.draw())
    }
    // The same area redrawn (typing, the working line): on the next paint. An area that moved
    // or changed size: once the app has stopped writing for 20 ms (at the latest 50 ms after),
    // so a layout drawn over two frames is shown only finished.
    const same = !!was && was.mode === r.mode && was.top === r.top && was.bottom === r.bottom
    window.clearTimeout(this.settle)
    if (same && !this.pendingSince) return go()
    const now = performance.now()
    if (!this.pendingSince) this.pendingSince = now
    if (now - this.pendingSince >= 50) go()
    else this.settle = window.setTimeout(go, 20)
  }


  /**
   * The region's rows as one write, taken from the real terminal when its frame is complete
   * (by the paint the real terminal may be halfway through its next one).
   */
  private compose(): void {
    const r = this.region
    if (!r || r.mode !== 'split' || this.engine.inSync) return
    const src = this.session.term
    const buf = src.buffer.active
    const n = this.rows
    // Taller than the box may be: its bottom part (the input line, a dialog's choices and
    // footer are at the bottom).
    const from = r.bottom - n + 1
    const cols = src.cols
    // One synchronized frame: xterm paints it whole or not at all.
    let out = '\x1b[?2026h\x1b[0m\x1b[H\x1b[2J'
    const cell = buf.getNullCell()
    for (let i = 0; i < n; i++) {
      const line = buf.getLine(buf.baseY + from + i)
      out += `\x1b[${i + 1};1H${line ? rowSgr(line, cols, cell) : ''}\x1b[0m`
    }
    const c = r.cursor
    const cy = c.y - from
    out += c.visible && cy >= 0 && cy < n ? `\x1b[${cy + 1};${c.x + 1}H\x1b[?25h` : '\x1b[?25l'
    out += '\x1b[?2026l'
    this.frameOut = { out, shown: { rows: n, from, cols, total: r.bottom - r.top + 1 }, r }
  }

  /** Copy the last complete frame into the box, in one write. */
  draw(): void {
    if (this.redraw) cancelAnimationFrame(this.redraw)
    this.redraw = 0
    const f = this.frameOut
    if (!this.on || !this.opened || !f) return
    const { out, shown, r } = f
    const { rows: n, from, cols } = shown
    this.syncFont()
    if (this.term.cols !== cols || this.term.rows !== this.cap) this.term.resize(Math.max(2, cols), this.cap)
    // The box takes its new height when the frame is in its terminal: both are painted
    // on the same next frame, never a frame of one without the other.
    this.term.write(out, () => {
      this.shown = shown
      this.el.classList.toggle('is-clipped', from > r.top)
      this.log.push({ t: performance.now(), top: r.top, bottom: r.bottom, rows: n, from, why: r.why })
      if (this.log.length > 600) this.log.splice(0, this.log.length - 600)
      this.onDrawn?.()
    })
  }

  /** The shown rows as text, for probes. */
  text(): string[] {
    const b = this.term.buffer.active
    const out: string[] = []
    for (let y = 0; y < this.shown.rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
    return out
  }

  /** The live area's rows in the real terminal, as text (what the canvas reads: the working line, image marks). */
  liveRows(): string[] {
    const r = this.region
    if (!r || r.mode !== 'split') return []
    const b = this.session.term.buffer.active
    const out: string[] = []
    for (let y = r.top; y <= r.bottom; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '')
    return out
  }

  dispose(): void {
    window.clearTimeout(this.lapse)
    window.clearTimeout(this.settle)
    if (this.redraw) cancelAnimationFrame(this.redraw)
    for (const s of this.subs) s.dispose()
    this.engine.dispose()
    this.webgl?.dispose()
    this.webgl = null
    this.term.dispose()
    this.el.remove()
  }
}

/** One row as SGR and text: what it takes to draw it again, cell for cell. */
function rowSgr(line: IBufferLine, cols: number, cell: IBufferCell): string {
  let out = ''
  let last = ''
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell)
    if (!c) break
    const w = c.getWidth()
    if (w === 0) continue
    const sgr = sgrOf(c)
    if (sgr !== last) {
      out += `\x1b[0${sgr}m`
      last = sgr
    }
    out += c.getChars() || ' '
  }
  return out
}

function sgrOf(c: IBufferCell): string {
  let s = ''
  if (c.isBold()) s += ';1'
  if (c.isDim()) s += ';2'
  if (c.isItalic()) s += ';3'
  if (c.isUnderline()) s += ';4'
  if (c.isBlink()) s += ';5'
  if (c.isInverse()) s += ';7'
  if (c.isInvisible()) s += ';8'
  if (c.isStrikethrough()) s += ';9'
  if (c.isOverline()) s += ';53'
  if (c.isFgRGB()) {
    const v = c.getFgColor()
    s += `;38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`
  } else if (c.isFgPalette()) s += `;38;5;${c.getFgColor()}`
  if (c.isBgRGB()) {
    const v = c.getBgColor()
    s += `;48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`
  } else if (c.isBgPalette()) s += `;48;5;${c.getBgColor()}`
  return s
}
