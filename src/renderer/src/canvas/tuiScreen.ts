import type { Terminal } from '@xterm/xterm'

/**
 * Reading an agent's own screen (Claude Code, Codex) — only to decide how tall its area
 * should be and whether it is mid-turn. Nothing read here is ever cut out of the screen or
 * shown anywhere else: the real TUI is drawn whole, at the size its PTY has.
 *
 * The rule: the TUI's plain prompt (its input box and the status/footer rows under it) is
 * what fits in the CLI's normal height. Anything else — a picker, a permission prompt, a
 * question, the trust dialog, the `/` or `@` menu — needs more room, and the area grows
 * until the plain prompt is back.
 */

export interface TuiRead {
  /** The plain prompt is on screen (an input box or Codex's `›` with its footer only). */
  prompt: boolean
  /** Something taller than the plain prompt is showing: the CLI should grow. */
  room: boolean
  /** Why `room` is set, in words, for probes and support. */
  why: string
  /** The agent's own working line: "✶ Pondering… (12s · ↓ 88 tokens)". */
  live: { glyph: string; verb: string; detail: string } | null
  /**
   * How many rows the TUI's bottom area takes, from its first line (the working line, the
   * todo list and queued messages under it, else the input box) to the last row: what must
   * stay in view. More than the screen has, when part of it has already scrolled away.
   */
  need: number
  /** The room asked for is all the tab can give (a prompt scrolling inside its box). */
  most?: boolean
  /** The `[Image #n]` marks in the prompt (the pictures attached to the message being written). */
  marks: number[]
}

/** The rows on screen, as text. */
export function screenRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
  return out
}

/** A row's text with what is drawn dim or italic (placeholders, ghost text) blanked. */
function strongText(term: Terminal, y: number): string {
  const buf = term.buffer.active
  const line = buf.getLine(buf.viewportY + y)
  if (!line) return ''
  let s = ''
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x)
    if (!c) continue
    const ch = c.getChars()
    s += ch && (c.isDim() || c.isItalic()) ? ' ' : ch || ' '
  }
  return s.replace(/\s+$/, '')
}

/** `[Image #n]` in these rows, by number. */
function marksIn(rows: string[]): number[] {
  const out: number[] = []
  for (const r of rows) for (const m of r.matchAll(/\[Image #(\d+)\]/g)) out.push(Number(m[1]))
  return out
}

// ---------------------------------------------------------------- Claude Code

const RULE = /^\s*[─━]{20,}\s*$/
/** A prompt this many lines tall: Claude Code starts scrolling it inside its box. */
const LONG_PROMPT = 3
const PROMPT_LINE = /^\s?[❯>!]\s?/
/** The spinner row, mid-turn: one glyph, a verb with an ellipsis, the details. */
const SPINNER = /^(\S)\s+([A-Z][a-z]+(?:[- ][a-z]+)?…)\s*(.*)$/
/** Lines a dialog or picker draws that the plain prompt never does. */
const DIALOG = /Do you want to|Esc to (?:cancel|close|go back|exit)|Enter to (?:select|confirm|continue)|↑\/?↓ to (?:navigate|select)|^\s*❯\s*\d+\.\s|^\s*\d+\.\s+(?:Yes|No)\b|Yes, I trust this folder/i

function readClaude(term: Terminal, rows: string[]): TuiRead {
  // The input box: a rule, the `❯` line (and its continuation lines), a rule.
  let top = -1
  let bottom = -1
  for (let y = rows.length - 2; y > 0; y--) {
    if (!PROMPT_LINE.test(rows[y]!) || !RULE.test(rows[y - 1]!)) continue
    let end = y
    while (end + 1 < rows.length && !RULE.test(rows[end + 1]!)) end++
    if (end + 1 >= rows.length) break
    top = y
    bottom = end + 1
    break
  }
  let live: TuiRead['live'] = null
  const end = top >= 0 ? top - 1 : rows.length
  for (let y = end - 1; y >= 0 && y >= end - 16; y--) {
    const m = SPINNER.exec(rows[y]!.trim())
    if (m) {
      live = { glyph: m[1]!, verb: m[2]!, detail: m[3]!.replace(/^\(|\)$/g, '').replace(/\s*·\s*esc to interrupt/i, '') }
      break
    }
  }
  if (top < 0) {
    const dialog = rows.some((r) => DIALOG.test(r))
    return { prompt: false, room: dialog, why: dialog ? 'dialog' : '', live, need: 0, marks: [] }
  }
  // The bottom area starts at the working line (the queue above it, the todo list under it)
  // or, between turns, at the box's top rule. Reaching the screen's top, part of it may be
  // out of view already: then it needs more than the screen has.
  let first = top - 1
  if (live) for (let y = top - 2; y >= 0; y--) if (SPINNER.test(rows[y]!.trim())) { first = y; break }
  // Queued messages (2.1.318 lists them above the working line, each a `❯` row, the last
  // with "ctrl+x ctrl+s to send now" under it): they are part of the bottom area too.
  for (let h = first - 1; h >= Math.max(0, first - 4); h--) {
    if (!/ctrl\+x ctrl\+s to send now/i.test(rows[h]!)) continue
    for (let y = h - 1; y >= 0; y--) {
      const r = rows[y]!
      if (/^\s*❯\s/.test(r)) first = y
      else if (r.trim() && !/^\s{2,}\S/.test(r)) break
    }
    break
  }
  const need = first <= 0 ? rows.length + 4 : rows.length - first
  const marks = marksIn(rows.slice(top, bottom))
  // A menu by the box (2.1.318 draws it just above): the `/` commands or the `@` files,
  // while the prompt holds the word.
  const text = strongText(term, top).replace(PROMPT_LINE, '').trim()
  const menuRow = (r: string) => /^\s*(?:❯\s*)?\/[\w:.-]+\s{2,}\S/.test(r)
  if (/^\/[\w:.-]*$/.test(text) && rows.some((r, y) => (y < top - 1 || y > bottom) && menuRow(r))) return { prompt: true, room: true, why: 'slash menu', live, need, marks }
  if (/(?:^|\s)@\S*$/.test(text)) return { prompt: true, room: true, why: 'file menu', live, need, marks }
  // A prompt of several lines: the box scrolls inside itself once it outgrows its share of
  // the screen, so it gets the room to show them.
  // At about a third of the screen the box is full and scrolls: then it wants all there is.
  if (bottom - top >= LONG_PROMPT) {
    const full = bottom - top >= Math.floor(rows.length * 0.3)
    return { prompt: true, room: true, why: full ? 'long prompt, scrolling in its box' : 'long prompt', live, need, marks, most: full }
  }
  // A dialog drawn under the box (some pickers keep the box above them).
  if (rows.slice(bottom + 1).some((r) => DIALOG.test(r))) return { prompt: true, room: true, why: 'dialog under the prompt', live, need, marks }
  return { prompt: true, room: false, why: '', live, need, marks }
}

// ---------------------------------------------------------------- Codex

/** The prompt line: `›` and what is typed (the placeholder is drawn dim). */
const CODEX_PROMPT = /^›(?:\s|$)/
/** The lines Codex draws under its prompt: model and folder, hints, context left. */
const CODEX_FOOT = /·|for shortcuts|esc to interrupt|context left|⚠|tab to queue|to edit|shift\+tab|plan mode|ctrl\+c/i
/** The working line: a bullet, what it is doing, and its timer with the interrupt hint. */
const CODEX_WORKING = /^(\S)\s+(.+?)\s+\(([^()]*?)\s*•\s*esc to interrupt\)\s*$/
/** The key hints under a dialog's choices. */
const CODEX_KEYS = /enter (?:to )?(?:confirm|continue|select)|esc (?:to )?(?:skip|quit|cancel|close|go back)|press enter/i
const CODEX_DIALOG = /Would you like to (?:run|make|apply|allow|grant)|Press enter to confirm or esc to cancel|Yes, proceed \(y\)|^\s*›?\s*\d+\.\s|enter (?:to )?(?:confirm|continue|select)|esc (?:to )?(?:skip|quit|cancel|close)/i

function readCodex(term: Terminal, rows: string[]): TuiRead {
  let last = rows.length - 1
  while (last > 0 && !rows[last]!.trim()) last--
  let top = -1
  let foot: string[] = []
  for (let y = last; y >= Math.max(0, last - 12); y--) {
    if (!CODEX_PROMPT.test(rows[y]!)) continue
    let end = y
    while (end + 1 <= last && rows[end + 1]!.trim() && /^\s{2}\S/.test(rows[end + 1]!) && !CODEX_FOOT.test(rows[end + 1]!)) end++
    foot = rows.slice(end + 1, last + 1).filter((r) => r.trim())
    top = y
    break
  }
  let live: TuiRead['live'] = null
  const end = top >= 0 ? top : rows.length
  for (let y = end - 1; y >= 0 && y >= end - 16; y--) {
    const m = CODEX_WORKING.exec(rows[y]!.trim())
    if (m) {
      live = { glyph: '✻', verb: m[2]!.endsWith('…') ? m[2]! : `${m[2]!}…`, detail: m[3]!.trim() }
      break
    }
  }
  if (top < 0) {
    const dialog = rows.some((r) => CODEX_DIALOG.test(r))
    return { prompt: false, room: dialog, why: dialog ? 'dialog' : '', live, need: 0, marks: [] }
  }
  // A list of choices with its key hints is a dialog drawn with the same `›`, not the prompt.
  if (foot.some((r) => CODEX_KEYS.test(r))) return { prompt: false, room: true, why: 'dialog', live, need: 0, marks: [] }
  const text = strongText(term, top).replace(/^›\s?/, '').trim()
  // The bottom area: from the working line (and the queued messages under it), else the prompt.
  let first = top
  if (live) for (let y = top - 1; y >= 0; y--) if (CODEX_WORKING.test(rows[y]!.trim())) { first = y; break }
  for (let y = first - 1; y >= 0 && y >= first - 2; y--) if (!rows[y]!.trim()) first = y
  const need = first <= 0 ? rows.length + 4 : last + 1 - first
  let pEnd = top
  while (pEnd + 1 <= last && /^\s{2}\S/.test(rows[pEnd + 1]!) && !CODEX_FOOT.test(rows[pEnd + 1]!)) pEnd++
  const marks = marksIn(rows.slice(top, pEnd + 1))
  // Codex's `/` popup: above the prompt in 0.156 (under it, above the footer, before).
  if (/^\/[\w-]*$/.test(text) && rows.some((r, y) => y !== top && /^\s*(?:›\s*)?\/[\w-]+\s{2,}\S/.test(r))) return { prompt: true, room: true, why: 'slash menu', live, need, marks }
  if (/(?:^|\s)@\S*$/.test(text) && foot.length > 3) return { prompt: true, room: true, why: 'file menu', live, need, marks }
  if (foot.length > 4) return { prompt: true, room: true, why: 'menu under the prompt', live, need, marks }
  return { prompt: true, room: false, why: '', live, need, marks }
}

/** What the agent's screen shows now. Cheap: a pass over the visible rows. */
export function readTui(term: Terminal, agent: string): TuiRead {
  const rows = screenRows(term)
  return agent === 'codex' ? readCodex(term, rows) : readClaude(term, rows)
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

/**
 * Type words into the TUI's prompt as the person would paste them: one bracketed paste
 * (newlines stay newlines, nothing submits early), then Enter on its own a beat later.
 * The one typing path Ember keeps — the question deck's Send and the canvas's "ask about
 * this" use it. Control characters are dropped: they are keys, not text.
 */
export async function pasteIntoTui(write: (d: string) => void, text: string, submit = true): Promise<void> {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
  if (!clean.trim()) return
  write(`\x1b[200~${clean}\x1b[201~`)
  if (!submit) return
  await sleep(180)
  write('\r')
}
