/**
 * The CLI box leaves out the agent's own horizontal rules (Claude's `────` above and below
 * its prompt, the `╌╌╌╌` around a command it asks about): the box already frames the input.
 * Only plain rules go: a row of nothing but horizontal line characters (and spaces) across
 * most of the width. A labelled separator (any letter or digit) and a dialog's own box (its
 * corners and sides) stay. The colour a dropped rule had is kept: Claude colours its prompt
 * rules by mode (`!` shell mode, a dialog's kind), and the box takes it as an accent.
 *
 * Works on any xterm buffer (the renderer's and the replay tests' headless one).
 */

/** The cell API this reads (IBufferCell / IBufferLine of @xterm/xterm). */
interface CellLike {
  getChars(): string
  getWidth(): number
  isFgRGB(): boolean
  isFgPalette(): boolean
  getFgColor(): number
}
interface LineLike {
  getCell(x: number, cell?: CellLike): CellLike | undefined
}

/** A rule's colour: an RGB value, a palette index, or the default foreground. */
export type RuleColor = { rgb: number } | { palette: number } | null

const RULE = new Set(['─', '━', '═', '╌', '╍', '┄', '┅', '┈', '┉', '╴', '╶', '╸', '╺', '-', '—', '–'])
/** How much of the width a rule spans, at least. */
const SPAN = 0.6

/** A plain horizontal rule: its colour (null: the default foreground); undefined if the row is not one. */
export function ruleOf(line: LineLike | undefined, cols: number, cell?: CellLike): RuleColor | undefined {
  if (!line || cols < 2) return undefined
  let n = 0
  let color: RuleColor = null
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell)
    if (!c) break
    if (c.getWidth() === 0) continue
    const ch = c.getChars()
    if (!ch || ch === ' ') continue
    if (!RULE.has(ch)) return undefined
    if (n++ === 0) color = c.isFgRGB() ? { rgb: c.getFgColor() } : c.isFgPalette() ? { palette: c.getFgColor() } : null
  }
  return n >= Math.ceil(cols * SPAN) ? color : undefined
}

/** A grey (or the default colour): a rule in its ordinary dress, nothing to tell. */
export function isPlainRule(c: RuleColor): boolean {
  if (!c) return true
  if ('palette' in c) {
    const p = c.palette
    return p === 0 || p === 7 || p === 8 || p === 15 || p >= 232
  }
  const r = (c.rgb >> 16) & 255
  const g = (c.rgb >> 8) & 255
  const b = c.rgb & 255
  return Math.max(r, g, b) - Math.min(r, g, b) <= 16
}

/** Rows of a region the box shows: its rows from `top` to `bottom`, rules left out, at most `cap` (the bottom ones). */
export function keptRows(
  lineAt: (y: number) => LineLike | undefined,
  top: number,
  bottom: number,
  cols: number,
  cap: number,
  cell?: CellLike
): { ys: number[]; total: number; accent: RuleColor } {
  const ys: number[] = []
  let total = 0
  let accent: RuleColor = null
  for (let y = bottom; y >= top; y--) {
    const rule = ruleOf(lineAt(y), cols, cell)
    if (rule !== undefined) {
      // The topmost coloured rule wins (a dialog's top edge, the prompt's upper rule).
      if (!isPlainRule(rule)) accent = rule
      continue
    }
    total++
    if (ys.length < cap) ys.push(y)
  }
  ys.reverse()
  return { ys, total, accent }
}
