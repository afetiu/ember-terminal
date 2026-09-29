import { isBound, subscribe, type TranscriptEvent } from './transcript.js'
import type { PtyHost } from './pty/PtyHost.js'

/**
 * The crew: every Claude session Ember can see, and what it is doing.
 *
 * `converse.ts` handles the synchronous half of the voice — ask a question, wait for the
 * whole turn, speak the answer. That is a conversation. This is the other half: work
 * handed off and left running, which is what makes the voice an orchestrator rather than
 * a remote control.
 *
 * The distinction that matters is *waiting*. A question you asked is worth blocking the
 * call for; a refactor is not. Dispatched work returns immediately, keeps accumulating
 * into a journal, and announces itself when the session goes quiet — so you can say "go
 * do that" and carry on talking about something else, which is the thing that was
 * actually being asked for.
 *
 * Every session is watched from the moment it is dispatched to, not from the moment
 * someone asks about it. Journals that only start on the first question miss precisely
 * the work that happened while you were busy, which is all of it.
 */

/** How much of a session's talk to keep. Old lines are dropped, not summarised. */
const JOURNAL_LINES = 40

export interface CrewNote {
  tabId: string
  /** 'progress' while it works, 'done' when the turn ends. */
  kind: 'progress' | 'done'
  text: string
}

interface Journal {
  unsubscribe: () => void
  /** What it has said since the last drain. */
  fresh: string[]
  /** Everything recent, for "what has it been doing" without consuming it. */
  recent: string[]
  /** What it was last asked to do, so a report can name the work. */
  task: string
  /** It has produced something since the last dispatch and has now gone quiet. */
  finished: boolean
  /** Wall-clock of the dispatch, so "for how long" is answerable. */
  since: number
  /** Events this journal has actually been handed, by kind. Diagnostic. */
  seen: Record<string, number>
}

const journals = new Map<string, Journal>()
let notify: ((note: CrewNote) => void) | null = null

/**
 * Where a finished hand-off is announced.
 *
 * Set once by main. The renderer decides what to do with it — during a call it becomes
 * something the voice mentions; otherwise it is dropped, because a notification nobody
 * is listening to is not worth waking anything up for.
 */
export function onCrewNote(fn: (note: CrewNote) => void): void {
  notify = fn
}

function ensure(tabId: string): Journal {
  const existing = journals.get(tabId)
  if (existing) return existing

  const j: Journal = {
    unsubscribe: () => {},
    fresh: [],
    recent: [],
    task: '',
    finished: false,
    since: Date.now(),
    seen: {},
  }

  j.unsubscribe = subscribe(tabId, (e: TranscriptEvent) => {
    j.seen[e.kind] = (j.seen[e.kind] ?? 0) + 1
    if (e.kind === 'assistant' && e.text) {
      j.fresh.push(e.text)
      j.recent.push(e.text)
      if (j.recent.length > JOURNAL_LINES) j.recent.shift()
      j.finished = false
    }
    if (e.kind === 'turn-end') {
      // A turn ending with nothing said is a session answering itself — a tool call
      // completing, a permission prompt. Announcing those would make the voice a
      // narrator, and there is already a narrator.
      if (!j.fresh.length) return
      j.finished = true
      notify?.({
        tabId,
        kind: 'done',
        text: `${j.task ? `"${j.task}" — ` : ''}${j.fresh.join(' ')}`.slice(0, 1200),
      })
    }
  })

  journals.set(tabId, j)
  return j
}

/**
 * Hand work to a session and do not wait for it.
 *
 * Returns as soon as the text is on its way. Everything after that arrives through the
 * journal and, when the session goes quiet, through `onCrewNote`.
 */
export function dispatch(host: PtyHost, tabId: string, sessionId: string, task: string): { ok: boolean; error?: string } {
  const line = task.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (!line) return { ok: false, error: 'nothing to send' }
  if (!isBound(tabId)) {
    return {
      ok: false,
      error: 'That tab has no Claude session running in it yet.',
    }
  }

  const j = ensure(tabId)
  j.task = line.slice(0, 160)
  j.fresh.length = 0
  j.finished = false
  j.since = Date.now()

  // Same two-step as `converse.ts`, and for the same reason: a burst of characters
  // ending in CR reads as a paste to Claude Code's TUI, so the Enter goes separately and
  // repeats until the session shows signs of having taken it.
  host.write(sessionId, line)
  for (const at of [350, 2500, 6000]) {
    setTimeout(() => {
      const still = journals.get(tabId)
      if (still && !still.fresh.length) host.write(sessionId, '\r')
    }, at)
  }

  return { ok: true }
}

/** Start watching a session without giving it anything to do. */
export function follow(tabId: string): void {
  ensure(tabId)
}

export interface CrewReport {
  tabId: string
  task: string
  /** Minutes since the work was handed over. */
  forMinutes: number
  finished: boolean
  /** What it has said, newest last. */
  said: string
  /** How many events of each kind reached this journal. Diagnostic. */
  seen: Record<string, number>
}

/** What a session has been up to. Does not consume the journal. */
export function report(tabId: string): CrewReport | null {
  const j = journals.get(tabId)
  if (!j) return null
  return {
    tabId,
    task: j.task,
    forMinutes: Math.max(0, Math.round((Date.now() - j.since) / 60_000)),
    finished: j.finished,
    said: j.recent.join(' ').slice(-1500),
    seen: { ...j.seen },
  }
}

/** Take what a session has said since the last drain, and reset it. */
export function drain(tabId: string): string {
  const j = journals.get(tabId)
  if (!j) return ''
  const out = j.fresh.join(' ')
  j.fresh.length = 0
  return out
}

/** Stop watching a tab — it closed, or the call it belonged to ended. */
export function forget(tabId: string): void {
  const j = journals.get(tabId)
  if (!j) return
  j.unsubscribe()
  journals.delete(tabId)
}

export function forgetAll(): void {
  for (const id of [...journals.keys()]) forget(id)
}
