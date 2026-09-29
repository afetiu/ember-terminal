import { isBound, subscribe, type TranscriptEvent } from './transcript.js'
import type { PtyHost } from './pty/PtyHost.js'

/**
 * `ask_claude`: a spoken question in, a real Claude turn out.
 *
 * This is the join between the two loops. The voice runs at conversational speed and
 * knows nothing; the Claude session in the tab runs at thinking speed and knows
 * everything — the user's repositories, his notes, his memory, his machine. The question
 * goes in as if typed, and the answer is read back off the transcript.
 *
 * Typing into the pty is not a hack around a missing API; it is the only route that
 * preserves what makes the answer worth having. Calling the Anthropic API directly from
 * here would produce a Claude with no tools, no project context, no memory and no panel —
 * a worse assistant than the one already sitting in the tab. So the session stays the
 * session, and the voice becomes another way to talk to it.
 *
 * Reading the reply is the mirror of narration, and for the same reason: the terminal is
 * a TUI that redraws itself, so anything scraped off the grid arrives as spinner frames.
 * Claude Code's own JSONL has the assistant's text cleanly, and `stop_reason: end_turn`
 * marks the moment it stopped working — which no timer can infer, because a session that
 * is thinking hard and a session that has finished look identical from outside.
 */

/** A turn can legitimately take minutes. Past this, say something rather than nothing. */
const TURN_TIMEOUT_MS = 150_000

/**
 * How long a silent session is given before we conclude the question never landed.
 *
 * Distinct from the timeout above: this one covers "the shell was at a prompt, not in
 * Claude, and the question was typed into bash". Without it the caller waits the full
 * timeout for an answer that was never coming.
 */
const FIRST_TOKEN_MS = 45_000

/**
 * When to press Enter after typing the question, and when to press it again.
 *
 * `${line}\r` in a single write does not submit to Claude Code: its TUI reads a burst of
 * characters ending in CR as a *paste*, and a carriage return inside a paste is a newline
 * in the composer. The question lands in the prompt looking perfectly correct and sits
 * there while the transcript stays empty.
 *
 * A single delayed Enter fixes it most of the time, which is worse than it sounds — the
 * first version used 140ms, passed, and then failed on the next run. The exact threshold
 * is Claude Code's, not ours, and it moves with how the pty happens to chunk the text.
 * So rather than guess a number and hope, the Enter is re-sent while nothing has come
 * back. A stray Enter at an empty prompt does nothing, so the retries are free.
 */
const SUBMIT_AT_MS = [350, 2500, 6000]

export interface AskResult {
  ok: boolean
  /** What Claude said, joined and ready to be spoken. */
  text?: string
  /** Set when the answer is partial — the caller should say so rather than pretend. */
  partial?: boolean
  error?: string
}

interface Pending {
  resolve: (r: AskResult) => void
  unsubscribe: () => void
  timer: NodeJS.Timeout
  firstTimer: NodeJS.Timeout | null
  /** The scheduled Enter presses, so they stop the moment the question is accepted. */
  submits: NodeJS.Timeout[]
  parts: string[]
}

/** One question at a time per tab. A second would interleave two answers in one transcript. */
const pending = new Map<string, Pending>()

function finish(tabId: string, result: AskResult): void {
  const p = pending.get(tabId)
  if (!p) return
  pending.delete(tabId)
  p.unsubscribe()
  clearTimeout(p.timer)
  if (p.firstTimer) clearTimeout(p.firstTimer)
  for (const t of p.submits) clearTimeout(t)
  p.resolve(result)
}

/**
 * Put the question to the session in `tabId` and wait for the turn to complete.
 *
 * `sessionId` is the pane the question is typed into — the tab's focused one, chosen by
 * the renderer, since only it knows which pane you are looking at.
 */
export function askClaude(host: PtyHost, tabId: string, sessionId: string, question: string): Promise<AskResult> {
  const line = question.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (!line) return Promise.resolve({ ok: false, error: 'empty question' })

  if (pending.has(tabId)) {
    return Promise.resolve({
      ok: false,
      error: 'Claude is still working on the previous question. Say that, and offer to wait.',
    })
  }

  // No binding means no Claude session has announced itself in this tab — the shell is
  // sitting at a prompt. Typing a spoken sentence into PowerShell would produce a page of
  // red, so refuse in words the voice can just say out loud.
  if (!isBound(tabId)) {
    return Promise.resolve({
      ok: false,
      error:
        'There is no Claude session running in this tab yet. Tell the user to start one by ' +
        'typing claude in the terminal, then ask again.',
    })
  }

  return new Promise<AskResult>((resolve) => {
    const parts: string[] = []

    const onEvent = (e: TranscriptEvent): void => {
      const p = pending.get(tabId)
      if (!p) return

      // The first sign of life means the question landed in Claude rather than in a
      // shell — and that no further Enter presses are needed.
      if (p.firstTimer) {
        clearTimeout(p.firstTimer)
        p.firstTimer = null
        for (const t of p.submits) clearTimeout(t)
        p.submits.length = 0
      }

      // Tool narration ("Reading config.ts") is for a listener watching work happen. In an
      // answer it is noise — the voice wants what Claude concluded, not how it got there.
      if (e.kind === 'assistant' && e.text) parts.push(e.text)
      if (e.kind === 'turn-end') {
        finish(tabId, parts.length ? { ok: true, text: parts.join(' ') } : {
          ok: false,
          error: 'Claude finished without saying anything. Ask the user to look at the terminal.',
        })
      }
    }

    const unsubscribe = subscribe(tabId, onEvent)

    const entry: Pending = {
      resolve,
      unsubscribe,
      parts,
      submits: [],
      timer: setTimeout(() => {
        finish(tabId, {
          ok: true,
          partial: true,
          text: parts.join(' ') || 'Claude is still working on it.',
        })
      }, TURN_TIMEOUT_MS),
      firstTimer: setTimeout(() => {
        finish(tabId, {
          ok: false,
          error:
            'The question went to the terminal but nothing came back. The session may not ' +
            'be at a prompt. Ask the user to check the terminal.',
        })
      }, FIRST_TOKEN_MS),
    }
    pending.set(tabId, entry)

    // Type the question, then press Enter separately — and keep pressing until something
    // comes back. See SUBMIT_AT_MS for why a single delayed Enter is not enough.
    host.write(sessionId, line)
    for (const at of SUBMIT_AT_MS) {
      const t = setTimeout(() => {
        // `firstTimer` is still set only while nothing at all has arrived from the
        // session, which is exactly the condition "the question has not been accepted".
        const p = pending.get(tabId)
        if (p?.firstTimer) host.write(sessionId, '\r')
      }, at)
      entry.submits.push(t)
    }
  })
}

/** Drop a tab's in-flight question — the call ended, or the tab did. */
export function cancelAsk(tabId: string): void {
  finish(tabId, { ok: false, error: 'cancelled' })
}

/**
 * Is there a Claude session in this tab that a question could reach?
 *
 * Separate from `askClaude` rather than inferred from one of its errors: the caller
 * usually wants to know *before* it has a question — to say "start a session first"
 * rather than to discover it by asking — and the probe needs a check with no side
 * effects at all.
 */
export function canAsk(tabId: string): boolean {
  return isBound(tabId)
}
