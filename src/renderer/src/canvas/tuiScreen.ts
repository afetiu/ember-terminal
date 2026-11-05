import type { Terminal } from '@xterm/xterm'

/**
 * Reading an agent's own screen (Claude Code, Codex) — only to decide how tall its box
 * should be and whether it is mid-turn. Nothing read here is ever cut out of the screen or
 * shown anywhere else: the real TUI is drawn whole, at the size its PTY has.
 *
 * What is measured is the TUI's *bottom area*: everything it keeps pinned under the
 * conversation — the working line and its tip, the todo list, queued messages, the prompt
 * box, the footer — or the picker, permission prompt, question or menu it draws there. The
 * CLI's box is that tall plus a spare row (host.ts), so the conversation has no room in it.
 *
 * Both TUIs run in their classic, main-screen mode inside Ember (Claude Code's `tui:
 * "default"`, Codex's inline viewport): the conversation is printed above the bottom area
 * and scrolls up out of the box into the scrollback. So is the top of a bottom area that
 * has outgrown the box — which is why the reader looks a little way up into the scrollback
 * too: what is there says by how much the box must grow.
 */

export interface TuiRead {
  /** The plain prompt is all on screen (Claude's input box, Codex's `›` with its footer). */
  prompt: boolean
  /** Something other than the plain prompt is showing: a menu, a picker, a dialog. */
  room: boolean
  /** Why `room` (or `cut`) is set, in words, for probes and support. */
  why: string
  /** The agent's own working line: "✶ Pondering… (12s · ↓ 88 tokens)". */
  live: { glyph: string; verb: string; detail: string } | null
  /**
   * The bottom area's height in rows, from its first row (the working line, the queue
   * above it, the box's top rule, a dialog's top rule) to the last row drawn — scrollback
   * included when its top has scrolled out of view. 0: nothing recognisable on screen.
   */
  dock: number
  /** The same as `dock`, kept for older probes. */
  need: number
  /** Part of the bottom area is not on screen: it has scrolled up, or its top is not drawn. */
  cut: boolean
  /** A list in the bottom area says it has this many more entries than it shows. */
  more: number
  /** A name for what the bottom area shows ("Select model", "slash menu"), to tell one dialog from the next. */
  key: string
  /** What is typed in the prompt (placeholder and ghost text left out). */
  text: string
  /** The room asked for is all the tab can give (a prompt scrolling inside its box). */
  most?: boolean
  /** The `[Image #n]` marks in the prompt (the pictures attached to the message being written). */
  marks: number[]
}

/** How far up into the scrollback the reader looks for the top of the bottom area. */
const BACK = 60

/** The rows on screen, as text. */
export function screenRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
  return out
}

/** The screen and a little of the scrollback above it: `lines[vp]` is the screen's top row. */
interface View {
  term: Terminal
  lines: string[]
  /** Index of the screen's first row in `lines`. */
  vp: number
  /** Buffer line of `lines[0]`. */
  base: number
}

function view(term: Terminal): View {
  const buf = term.buffer.active
  const start = Math.max(0, buf.viewportY - BACK)
  const lines: string[] = []
  for (let y = start; y < buf.viewportY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return { term, lines, vp: buf.viewportY - start, base: start }
}

/** A row's text with what is drawn dim or italic (placeholders, ghost text) blanked. */
function strongText(v: View, i: number): string {
  const line = v.term.buffer.active.getLine(v.base + i)
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

/** The colour of a row's first drawn character from column `from`, for telling rows apart. */
function fgAt(v: View, i: number, from = 0): number {
  const line = v.term.buffer.active.getLine(v.base + i)
  if (!line) return -2
  for (let x = from; x < line.length; x++) {
    const c = line.getCell(x)
    if (c && c.getChars().trim()) return c.getFgColor() + c.getFgColorMode() * 1e9
  }
  return -2
}

/** `[Image #n]` in these rows, by number. */
function marksIn(rows: string[]): number[] {
  const out: number[] = []
  for (const r of rows) for (const m of r.matchAll(/\[Image #(\d+)\]/g)) out.push(Number(m[1]))
  return out
}

/** The last row of the screen that has anything drawn on it. */
function lastDrawn(v: View): number {
  let last = v.lines.length - 1
  while (last > v.vp && !v.lines[last]!.trim()) last--
  return last
}

/** "↓ 23 more", "… +7 models": how many entries a list has past what it shows. */
function moreIn(rows: string[]): number {
  let n = 0
  for (const r of rows) {
    const m = /(?:↓\s*|…\s*\+)(\d+)\s*(?:more|models?|items?|servers?|files?|commands?|options?)\b/i.exec(r)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n
}

const none = (why = ''): TuiRead => ({ prompt: false, room: false, why, live: null, dock: 0, need: 0, cut: false, more: 0, key: '', text: '', marks: [] })

// ---------------------------------------------------------------- Claude Code

const RULE = /^\s*[─━]{20,}\s*$/
const PROMPT_LINE = /^\s?[❯>!]\s?/
/** The spinner row, mid-turn: one glyph, a verb with an ellipsis, the details. */
const SPINNER = /^(\S)\s+([A-Z][a-z]+(?:[- ][a-z]+)?…)\s*(.*)$/
/** Lines a dialog or picker draws that the plain prompt never does. */
const DIALOG = /Do you want to|Esc to (?:cancel|close|go back|exit)|Enter to (?:select|confirm|continue|set)|↑\/?↓ to (?:navigate|select)|^\s*❯\s*\d+\.\s|^\s*\d+\.\s+(?:Yes|No)\b|Yes, I trust this folder/i
/** The rows between the working line and the box: blank, the tip and the todo list (indented). */
const UNDER_SPINNER = /^(?:\s*|\s+\S.*)$/

function readClaude(v: View): TuiRead {
  const L = v.lines
  const last = lastDrawn(v)
  // The input box: a rule, the `❯` line (and its continuation lines), a rule — the lowest
  // one with its bottom rule drawn.
  let top = -1
  let bottom = -1
  for (let y = last - 1; y > 0; y--) {
    if (!PROMPT_LINE.test(L[y]!) || !RULE.test(L[y - 1]!)) continue
    let end = y
    while (end + 1 <= last && !RULE.test(L[end + 1]!)) end++
    if (end + 1 > last) break
    // The live box has its bottom rule on screen: one wholly in the scrollback is an old frame.
    if (end + 1 < v.vp) break
    top = y
    bottom = end + 1
    break
  }
  if (top < 0) return claudeDialog(v, last)
  // The working line: right above the box, with only its tip, its todo list and blank rows
  // between (a line of the conversation stops the search: nothing past it is the bottom area's).
  let live: TuiRead['live'] = null
  let first = top - 1
  for (let y = top - 2; y >= 0 && y >= top - 26; y--) {
    const m = SPINNER.exec(L[y]!.trim())
    if (m && !/^\s/.test(L[y]!)) {
      live = { glyph: m[1]!, verb: m[2]!, detail: m[3]!.replace(/^\(|\)$/g, '').replace(/\s*·\s*esc to interrupt/i, '') }
      first = y
      break
    }
    if (!UNDER_SPINNER.test(L[y]!)) break
  }
  // Queued messages: listed above the working line, each a `❯` row drawn in the same dim
  // colour as the "ctrl+x ctrl+s to send now" under the last (the prompt that started the
  // turn, just above them, is drawn brighter: it is the conversation's).
  if (live) {
    for (let h = first - 1; h >= Math.max(0, first - 3); h--) {
      if (!/ctrl\+x ctrl\+s to send now/i.test(L[h]!)) continue
      const dim = fgAt(v, h)
      let q = h
      for (let y = h - 1; y >= 0 && y >= h - 40; y--) {
        const r = L[y]!
        if (/^\s*❯\s/.test(r)) {
          if (fgAt(v, y, r.indexOf('❯') + 1) !== dim) break
          q = y
        } else if (r.trim() && !/^\s{2,}\S/.test(r)) break
      }
      first = q
      break
    }
  }
  const dock = last - first + 1
  const cut = first < v.vp
  const below = L.slice(bottom + 1, last + 1)
  const marks = marksIn(L.slice(top, bottom))
  const text = strongText(v, top).replace(PROMPT_LINE, '').trim()
  const base = { prompt: top - 1 >= v.vp, live, dock, need: dock, cut, more: moreIn(below), text, marks }
  const why = (w: string) => (cut ? `${w || 'bottom area'} (scrolled up)` : w)
  // The `/` commands or `@` files, listed under the box while the prompt holds the word.
  const menuRow = (r: string) => /^\s*(?:❯\s*)?\/[\w:.-]+\s{2,}\S/.test(r)
  if (/^\/[\w:.-]*$/.test(text) && below.some(menuRow)) return { ...base, room: true, why: why('slash menu'), key: 'slash menu' }
  if (/(?:^|\s)@\S*$/.test(text) && below.length > 3) return { ...base, room: true, why: why('file menu'), key: 'file menu' }
  // A dialog drawn under the box (some pickers keep the box above them).
  if (below.some((r) => DIALOG.test(r))) return { ...base, room: true, why: why('dialog under the prompt'), key: below.find((r) => r.trim())?.trim().slice(0, 60) ?? 'dialog' }
  return { ...base, room: false, why: why(''), key: '' }
}

/**
 * No input box: a dialog in its place (a permission prompt, AskUserQuestion, plan approval,
 * `/model`, `/mcp`, the trust dialog…). Claude Code starts each with a rule across the
 * screen; its top is the lowest such rule over the dialog's words. None on screen or in the
 * scrollback just above: the top is not drawn yet, or scrolled away — more room.
 */
function claudeDialog(v: View, last: number): TuiRead {
  const L = v.lines
  const screen = L.slice(v.vp)
  if (!screen.some((r) => DIALOG.test(r))) {
    // Parts of the box without the whole (mid-redraw, or its rules out of view): more room.
    const parts = screen.some((r) => RULE.test(r)) && screen.some((r) => /^\s?❯/.test(r))
    return parts ? { ...none('prompt box in part'), cut: true } : none()
  }
  let rule = -1
  for (let y = last; y >= 0; y--) {
    if (RULE.test(L[y]!)) {
      rule = y
      break
    }
  }
  const rows = rule >= 0 ? L.slice(rule + 1, last + 1) : screen
  const key = rows.find((r) => r.trim())?.trim().slice(0, 60) ?? 'dialog'
  const more = moreIn(rows)
  if (rule < 0) return { ...none('dialog, its top not on screen'), room: true, cut: true, more, key }
  const dock = last - rule + 1
  return { ...none(rule < v.vp ? 'dialog (scrolled up)' : 'dialog'), room: true, dock, need: dock, cut: rule < v.vp, more, key }
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

function readCodex(v: View): TuiRead {
  const L = v.lines
  const last = lastDrawn(v)
  let top = -1
  let foot: string[] = []
  for (let y = last; y >= Math.max(0, last - 14); y--) {
    if (!CODEX_PROMPT.test(L[y]!)) continue
    let end = y
    while (end + 1 <= last && L[end + 1]!.trim() && /^\s{2}\S/.test(L[end + 1]!) && !CODEX_FOOT.test(L[end + 1]!)) end++
    foot = L.slice(end + 1, last + 1).filter((r) => r.trim())
    top = y
    break
  }
  let live: TuiRead['live'] = null
  let liveAt = -1
  const end = top >= 0 ? top : L.length
  for (let y = end - 1; y >= 0 && y >= end - 16; y--) {
    const m = CODEX_WORKING.exec(L[y]!.trim())
    if (m) {
      live = { glyph: '✻', verb: m[2]!.endsWith('…') ? m[2]! : `${m[2]!}…`, detail: m[3]!.trim() }
      liveAt = y
      break
    }
  }
  const screen = L.slice(v.vp)
  // A dialog in the prompt's place (an approval, a startup screen), or a list of choices
  // drawn with the same `›` and its key hints under it.
  if (top < 0 || foot.some((r) => CODEX_KEYS.test(r))) {
    if (!screen.some((r) => CODEX_DIALOG.test(r) || CODEX_KEYS.test(r))) return { ...none(), live }
    // Its top: the first row of the block it draws, which a blank row (or two) separates from
    // the conversation above; blank rows inside it come before an indented or numbered row.
    let first = last
    for (let y = last; y >= 0 && y >= last - 50; y--) {
      if (L[y]!.trim()) {
        first = y
        continue
      }
      const above = L[y - 1] ?? ''
      if (y - 1 >= 0 && above.trim() && /^\s{2,}\S|^\s*(?:[›>]\s*)?\d+\.\s/.test(L[y + 1] ?? '') && /^\s{2,}\S|^\s*\S.*[?:]\s*$/.test(above)) continue
      break
    }
    const dock = last - first + 1
    const key = L[first]?.trim().slice(0, 60) ?? 'dialog'
    return { ...none(first < v.vp ? 'dialog (scrolled up)' : 'dialog'), live, room: true, dock, need: dock, cut: first < v.vp, more: moreIn(L.slice(first, last + 1)), key }
  }
  const text = strongText(v, top).replace(/^›\s?/, '').trim()
  // The bottom area: from the working line (and the queued messages under it), else the
  // prompt and the blank row Codex keeps over it.
  let first = liveAt >= 0 ? liveAt : top
  // Codex's `/` and `@` popups sit just above the prompt (0.156): their rows are the bottom
  // area's too.
  const popRow = (r: string) => /^\s*(?:›\s*)?(?:\/[\w-]+|[\w./\\-]+\.\w+|[\w./\\-]+[/\\])(?:\s{2,}\S.*)?\s*$/.test(r)
  const menuOn = /^\/[\w-]*$/.test(text) || /(?:^|\s)@\S*$/.test(text)
  if (menuOn && liveAt < 0) {
    let y = first - 1
    if (y >= 0 && !L[y]!.trim()) y--
    let pop = -1
    while (y >= 0 && L[y]!.trim() && popRow(L[y]!)) pop = y--
    if (pop >= 0) first = pop
  }
  if (first - 1 >= 0 && !L[first - 1]!.trim()) first--
  const dock = last - first + 1
  let pEnd = top
  while (pEnd + 1 <= last && /^\s{2}\S/.test(L[pEnd + 1]!) && !CODEX_FOOT.test(L[pEnd + 1]!)) pEnd++
  const marks = marksIn(L.slice(top, pEnd + 1))
  // No footer under the prompt: Codex has dropped it for want of a row (it never draws the
  // prompt without one) — the area is two rows taller than what shows.
  const footless = !foot.length
  const cut = first < v.vp || footless
  const base = { prompt: top >= v.vp, live, dock: footless ? dock + 2 : dock, need: footless ? dock + 2 : dock, cut, more: moreIn(foot), text, marks }
  const why = (w: string) => (footless ? `${w || 'bottom area'} (no footer yet)` : cut ? `${w || 'bottom area'} (scrolled up)` : w)
  // Codex's `/` popup: above the prompt in 0.156 (under it, above the footer, before).
  if (/^\/[\w-]*$/.test(text)) {
    if (L.some((r, y) => y >= first && y !== top && /^\s*(?:›\s*)?\/[\w-]+\s{2,}\S/.test(r))) return { ...base, room: true, why: why('slash menu'), key: 'slash menu' }
    // Codex leaves its popup out when the screen has no room for it: room, then measure.
    if (liveAt < 0) return { ...base, dock: dock + 10, need: dock + 10, room: true, why: 'slash menu, not drawn yet', key: 'slash menu' }
  }
  if (/(?:^|\s)@\S*$/.test(text) && foot.length > 3) return { ...base, room: true, why: why('file menu'), key: 'file menu' }
  if (foot.length > 4) return { ...base, room: true, why: why('menu under the prompt'), key: foot[0]!.trim().slice(0, 60) }
  return { ...base, room: false, why: why(''), key: '' }
}

/** What the agent's screen shows now. Cheap: a pass over the visible rows and a few above. */
export function readTui(term: Terminal, agent: string): TuiRead {
  const v = view(term)
  return agent === 'codex' ? readCodex(v) : readClaude(v)
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
