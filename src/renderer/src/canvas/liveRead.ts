/**
 * What the canvas reads from the CLI's live area (the rows the stream engine says are live,
 * liveView.ts) — never to size anything: the working line for the canvas's live line, the
 * `[Image #n]` marks for the thumbnails above the box, and whether the prompt is up.
 */

export interface LiveRead {
  /** The agent's own working line: "✶ Pondering… (12s · ↓ 88 tokens)". */
  live: { glyph: string; verb: string; detail: string } | null
  /** The `[Image #n]` marks in the live area (the pictures attached to the message being written). */
  marks: number[]
  /** The plain prompt is showing (Claude's input box, Codex's `›`). */
  prompt: boolean
}

/** Claude's working line: one glyph, a verb with an ellipsis, the details. */
const SPINNER = /^(\S)\s+([A-Z][a-z]+(?:[- ][a-z]+)?(?:…|\.\.\.))\s*(.*)$/
/** Codex's: a bullet, what it is doing, its timer with the interrupt hint. */
const CODEX_WORKING = /^(\S)\s+(.+?)\s+\(([^()]*?)\s*•\s*esc to interrupt\)\s*$/

export function readLive(rows: string[], agent: string | null): LiveRead {
  let live: LiveRead['live'] = null
  for (const r of rows) {
    if (agent === 'codex') {
      const m = CODEX_WORKING.exec(r.trim())
      if (m) {
        live = { glyph: '✻', verb: m[2]!.endsWith('…') ? m[2]! : `${m[2]!}…`, detail: m[3]!.trim() }
        break
      }
    } else if (!/^\s/.test(r)) {
      const m = SPINNER.exec(r.trim())
      if (m) {
        live = { glyph: m[1]!, verb: m[2]!, detail: m[3]!.replace(/^\(|\)$/g, '').replace(/\s*·\s*esc to interrupt/i, '') }
        break
      }
    }
  }
  const marks: number[] = []
  for (const r of rows) for (const m of r.matchAll(/\[Image #(\d+)\]/g)) marks.push(Number(m[1]))
  const prompt = rows.some((r) => (agent === 'codex' ? /^›(?:\s|$)/ : /^\s?[❯>]/).test(r))
  return { live, marks, prompt }
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
