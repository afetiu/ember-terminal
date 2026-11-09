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

/** A row's text, as drawn. */
function textOf(line: LineLike | undefined, cols: number, cell?: CellLike): string {
  if (!line) return ''
  let out = ''
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell)
    if (!c) break
    if (c.getWidth() === 0) continue
    out += c.getChars() || ' '
  }
  return out
}

/**
 * The agent's working line ("✻ Whirlpooling… (12s · ↓ 300 tokens)", Codex's "• Working (3s
 * • esc to interrupt)") and the `⎿` lines hanging under it (a tip, the hook it is running).
 * The canvas already says it at the top, so the box leaves it out rather than saying it twice.
 */
const WORKING = /^\s*[^\w\s]\s+[A-Z][a-z]+(?:-[a-z]+)?(?:…|\.\.\.)(?:\s|$)/
const CODEX_WORKING = /^\s*[•◦]\s+Working\b/
const HANGING = /^\s*⎿/
/** The same line once the turn is over ("✻ Worked for 1s · done 18:33"), for the moment before it scrolls into the transcript. */
const WORKED = /^\s*[^\w\s]\s+[A-Z][a-z]+ed for \d/

/**
 * Which of a region's rows (as text, top down) are the working line: the line itself, the `⎿`
 * lines under it, the blank rows that spaced it from what follows, and blank rows above it when
 * nothing but blanks is above it (the box would otherwise open on empty rows).
 */
export function workingRows(texts: string[]): Set<number> {
  const out = new Set<number>()
  const blank = (i: number) => !texts[i]?.trim()
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]
    if (!WORKING.test(t) && !CODEX_WORKING.test(t) && !WORKED.test(t)) continue
    out.add(i)
    let j = i + 1
    while (j < texts.length && HANGING.test(texts[j])) out.add(j++)
    while (j < texts.length && blank(j)) out.add(j++)
    let above = true
    for (let k = 0; k < i; k++) if (!blank(k) && !out.has(k)) above = false
    if (above) for (let k = 0; k < i; k++) out.add(k)
    i = j - 1
  }
  return out
}

/** Rows of a region the box shows: its rows from `top` to `bottom`, rules and the working line left out, at most `cap` (the bottom ones). */
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
  // The working line's rows (found top down: a `⎿` line goes only under one).
  const texts: string[] = []
  for (let y = top; y <= bottom; y++) texts.push(textOf(lineAt(y), cols, cell))
  const working = workingRows(texts)
  for (let y = bottom; y >= top; y--) {
    if (working.has(y - top)) continue
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
