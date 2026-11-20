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
