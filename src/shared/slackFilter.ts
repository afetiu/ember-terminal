/**
 * Which Slack message events are for you (main/slack.ts): new words from someone else in
 * a DM or group DM, a message that mentions you, or a reply in a thread a session took on.
 * Not edits, deletions, joins, bots or your own messages. Pure, for the tests.
 */
export function wantSlackEvent(ev: Record<string, unknown>, me: string, threads: Record<string, string>): { dm: boolean; tab?: string } | null {
  if (ev['type'] !== 'message') return null
  const sub = String(ev['subtype'] ?? '')
  if (sub && sub !== 'thread_broadcast' && sub !== 'file_share') return null
  if (ev['bot_id']) return null
  const user = String(ev['user'] ?? '')
  if (!user || user === me) return null
  const channel = String(ev['channel'] ?? '')
  const ts = String(ev['ts'] ?? '')
  const threadTs = String(ev['thread_ts'] ?? ts)
  const type = String(ev['channel_type'] ?? '')
  const dm = type === 'im' || type === 'mpim'
  const mentioned = String(ev['text'] ?? '').includes(`<@${me}>`)
  const tab = threads[`${channel}:${threadTs}`]
  if (!dm && !mentioned && !tab) return null
  return tab ? { dm, tab } : { dm }
}

/** The model's answer as a route. Unreadable → shown, with no suggestion pressed on it. Pure, for the tests. */
export function parseRoute(
  text: string,
  m: { text: string },
  sessions: Array<{ tabId: string; folder: string }>
): { action: 'session' | 'new' | 'todo' | 'note' | 'ignore'; tabId?: string; why: string; title: string; folder?: string } {
  const fallback = { action: 'todo' as const, why: 'Could not sort it; your call', title: m.text.slice(0, 30) }
  const j = /\{[\s\S]*\}/.exec(text)
  if (!j) return fallback
  try {
    const r = JSON.parse(j[0]) as Record<string, unknown>
    const action = (['session', 'new', 'todo', 'note', 'ignore'] as const).find((a) => a === r['action'])
    if (!action) return fallback
    const n = Number(r['session'])
    const s = action === 'session' && Number.isInteger(n) ? sessions[n - 1] : undefined
    return {
      action: action === 'session' && !s ? 'new' : action,
      ...(s ? { tabId: s.tabId, folder: s.folder } : {}),
      why: String(r['why'] ?? '').slice(0, 120),
      title: String(r['title'] ?? '').slice(0, 60) || m.text.slice(0, 30),
    }
  } catch {
    return fallback
  }
}
