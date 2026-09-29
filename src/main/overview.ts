import { subscribe } from './transcript.js'
import type { SessionBrief } from '../shared/types.js'

/**
 * One line per Claude session: what it last said, what it is doing now.
 *
 * The overview surface shows every session at once, and the thing worth a glance is
 * not the terminal's last screenful but the last sentence the model wrote and the tool
 * it is in the middle of. Both are in the session's transcript, which narration already
 * reads; this listens to the same feed for every bound tab and keeps the latest of each.
 *
 * A tab is tracked from the moment its session announces itself over the bridge — the
 * only moment tab id and session id are known together — and dropped with the tab. The
 * watcher starts at the end of the file, so a session that was already running shows
 * nothing until its next turn; a stale sentence would be worse than a blank.
 */

const briefs = new Map<string, SessionBrief>()
const stops = new Map<string, () => void>()
const listeners = new Set<(b: SessionBrief) => void>()

/** The last sentence or two of what was said, short enough for one line. */
function lastSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 160) return flat
  const parts = flat.split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
  let out = parts[parts.length - 1] ?? flat
  // A closing "Done." on its own says nothing; take the sentence before it too.
  for (let i = parts.length - 2; i >= 0 && out.length < 40; i--) out = `${parts[i]} ${out}`
  return out.length > 160 ? `…${out.slice(-158)}` : out
}

function emit(b: SessionBrief): void {
  for (const l of listeners) l(b)
}

/** Start (or re-point) the brief for a tab whose session has announced itself. */
export function trackBrief(tabId: string, sessionId: string, cwd: string): void {
  const existing = briefs.get(tabId)
  if (existing) {
    if (existing.sessionId !== sessionId) {
      // A new `claude` in the same tab: what the old one said is no longer news.
      existing.sessionId = sessionId
      existing.cwd = cwd
      existing.said = ''
      existing.doing = ''
      existing.turnEnded = false
      existing.at = Date.now()
      emit(existing)
    }
    return
  }
  const brief: SessionBrief = { tabId, sessionId, cwd, said: '', saidAt: 0, doing: '', doingAt: 0, turnEnded: false, at: Date.now() }
  briefs.set(tabId, brief)
  stops.set(
    tabId,
    subscribe(tabId, (e) => {
      const b = briefs.get(tabId)
      if (!b) return
      const now = Date.now()
      if (e.kind === 'assistant') {
        b.said = lastSentence(e.text)
        b.saidAt = now
        b.turnEnded = false
      } else if (e.kind === 'tool') {
        b.doing = e.text
        b.doingAt = now
        b.turnEnded = false
      } else if (e.kind === 'turn-end') {
        b.turnEnded = true
        b.doing = ''
      } else {
        return
      }
      b.at = now
      emit(b)
    })
  )
}

export function forgetBrief(tabId: string): void {
  stops.get(tabId)?.()
  stops.delete(tabId)
  briefs.delete(tabId)
}

export function allBriefs(): SessionBrief[] {
  return [...briefs.values()]
}

export function onBrief(fn: (b: SessionBrief) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
