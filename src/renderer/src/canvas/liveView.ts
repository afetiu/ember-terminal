import { Terminal, type IBufferCell, type IBufferLine } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { StreamEngine, type LiveRegion } from '@shared/streamEngine'
import type { Session } from '../core/Session'

/** The most of the tab the live box takes; a taller live area shows its bottom part. */
export const LIVE_SHARE = 0.6

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
  private lapse = 0
  private cap = 12
  private on = false
  private opened = false
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
      session.term.onData((d) => this.engine.noteInput(d))
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
  }

  /** An agent came (or went): read its screen afresh from where it starts drawing. */
  start(agent: string | null): void {
    this.engine.reset(agent)
    this.region = null
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
    const before = this.rows
    this.region = r
    // An animation that lapses changes the area with nothing written: look again then.
    window.clearTimeout(this.lapse)
    this.lapse = window.setTimeout(() => this.read(), 850)
    if (this.rows !== before) this.onHeight?.()
    if (!this.redraw) this.redraw = requestAnimationFrame(() => this.draw())
  }

  /** Copy the region's rows from the real terminal into the box, in one write. */
  draw(): void {
    if (this.redraw) cancelAnimationFrame(this.redraw)
    this.redraw = 0
    const r = this.region
    if (!this.on || !this.opened || !r || r.mode !== 'split') return
    const src = this.session.term
    const buf = src.buffer.active
    const n = this.rows
    // Taller than the box may be: its bottom part (the input line, a dialog's choices and
    // footer are at the bottom).
    const from = r.bottom - n + 1
    const cols = src.cols
    if (this.term.cols !== cols || this.term.rows !== this.cap) this.term.resize(Math.max(2, cols), this.cap)
    let out = '\x1b[0m\x1b[H\x1b[2J'
    const cell = buf.getNullCell()
    for (let i = 0; i < n; i++) {
      const line = buf.getLine(buf.baseY + from + i)
      out += `\x1b[${i + 1};1H${line ? rowSgr(line, cols, cell) : ''}\x1b[0m`
    }
    const c = r.cursor
    const cy = c.y - from
    out += c.visible && cy >= 0 && cy < n ? `\x1b[${cy + 1};${c.x + 1}H\x1b[?25h` : '\x1b[?25l'
    const shown = { rows: n, from, cols, total: r.bottom - r.top + 1 }
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
    if (this.redraw) cancelAnimationFrame(this.redraw)
    for (const s of this.subs) s.dispose()
    this.engine.dispose()
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
