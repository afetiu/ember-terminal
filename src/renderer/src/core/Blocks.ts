import type { Terminal } from '@xterm/xterm'

export interface CommandBlock {
  id: number
  /** Absolute buffer row of the line the command was typed on. */
  markRow: number
  /** Absolute row where its output ends. -1 while still running. */
  endRow: number
  command: string
  outcome: 'ok' | 'fail' | 'running'
  startedAt: number
  durationMs: number
}

/**
 * Structure over the scrollback: every command and its output as an addressable unit.
 *
 * The boundaries come from watching the user's own Enter keystroke rather than shell
 * integration (no OSC 133 required, so it works with a stock PowerShell profile).
 * That gives an exact start row; the end is fixed when output goes quiet, minus the
 * height of the prompt that reappears underneath.
 *
 * Rows are absolute buffer rows, so they stay valid as the viewport scrolls. They do
 * shift once scrollback starts evicting lines, which `trim` handles.
 */
export class BlockTracker {
  private readonly blocks: CommandBlock[] = []
  private seq = 0
  private open: CommandBlock | null = null

  constructor(private readonly term: Terminal) {}

  get all(): readonly CommandBlock[] {
    return this.blocks
  }

  get current(): CommandBlock | null {
    return this.open
  }

  /**
   * Called the moment Enter is submitted.
   *
   * `typed` is what the user actually keyed since the last Enter. It is the reliable
   * source for a pasted command (whose echo has not landed in the buffer yet) while
   * the buffer read is the reliable one for a command recalled from history (where
   * the keystrokes were arrow keys, not text). Taking whichever is longer covers both.
   */
  begin(markRow: number, typed = ''): void {
    const fromBuffer = this.readCommand(markRow)
    const command = fromBuffer.length >= typed.length ? fromBuffer : typed
    this.open = {
      id: ++this.seq,
      markRow,
      endRow: -1,
      command,
      outcome: 'running',
      startedAt: performance.now(),
      durationMs: 0,
    }
    this.blocks.push(this.open)
    this.trim()
  }

  /** Called when output goes quiet and the outcome is known. */
  end(outcome: 'ok' | 'fail', promptLines: number): void {
    if (!this.open) return
    this.refreshOpenCommand()
    const buf = this.term.buffer.active
    this.open.endRow = Math.max(this.open.markRow, buf.baseY + buf.cursorY - promptLines)
    this.open.outcome = outcome
    this.open.durationMs = Math.round(performance.now() - this.open.startedAt)
    this.open = null
  }

  /**
   * Re-read the open block's command text.
   *
   * Called on render because at the instant Enter is pressed the echo may not have
   * landed yet — a pasted command arrives as one chunk, so the buffer still holds
   * only the bare prompt. The line stays on screen after submission, so re-reading
   * until we get something is both safe and accurate.
   */
  refreshOpenCommand(): void {
    if (!this.open) return
    const text = this.readCommand(this.open.markRow)
    // Keep the longest reading: the first render after Enter often catches the echo
    // mid-flight, so "Write-Output 'BLO" arrives before the full line does.
    if (text.length > this.open.command.length) this.open.command = text
  }

  /**
   * The prompt is drawn on the same line as the command, so the raw line includes the
   * whole oh-my-posh decoration. Cut at the last prompt glyph.
   */
  private readCommand(row: number): string {
    const raw = this.term.buffer.active.getLine(row)?.translateToString(true).trim() ?? ''
    const m = /[❯▸>$#]\s+(.*)$/.exec(raw)
    // With no prompt glyph this may be a decorative prompt line rather than the
    // command — a right-aligned oh-my-posh segment leaves a long run of spaces.
    if (!m && /\s{10}/.test(raw)) return ''
    const text = (m?.[1] ?? raw).trim()
    // A bare prompt glyph carries no command; treat it as "not known yet".
    return /^[❯▸>$#]*$/.test(text) ? '' : text
  }

  /** Drop blocks whose rows have fallen out of the scrollback. */
  private trim(): void {
    const floor = this.term.buffer.active.baseY - this.term.options.scrollback! - this.term.rows
    while (this.blocks.length && this.blocks[0]!.markRow < floor) this.blocks.shift()
    if (this.blocks.length > 500) this.blocks.splice(0, this.blocks.length - 500)
  }

  /** The block whose output contains this absolute row, if any. */
  at(row: number): CommandBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!
      if (row >= b.markRow && (b.endRow < 0 || row <= b.endRow)) return b
    }
    return null
  }

  /** Next/previous command mark relative to a row. */
  step(fromRow: number, dir: 1 | -1): CommandBlock | null {
    if (dir === 1) return this.blocks.find((b) => b.markRow > fromRow) ?? null
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i]!.markRow < fromRow) return this.blocks[i]!
    }
    return null
  }

  /** Plain text of a block's output, excluding the command line itself. */
  outputOf(block: CommandBlock): string {
    const buf = this.term.buffer.active
    const end = block.endRow < 0 ? buf.baseY + buf.cursorY : block.endRow
    const lines: string[] = []
    for (let row = block.markRow + 1; row < end; row++) {
      lines.push(buf.getLine(row)?.translateToString(true) ?? '')
    }
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
    return lines.join('\n')
  }

  lineCount(block: CommandBlock): number {
    const buf = this.term.buffer.active
    const end = block.endRow < 0 ? buf.baseY + buf.cursorY : block.endRow
    return Math.max(0, end - block.markRow - 1)
  }
}
