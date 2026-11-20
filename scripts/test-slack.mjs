/**
 * Slack: which message events are for you (src/shared/slackFilter.ts).
 *
 *   node --test scripts/test-slack.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wantSlackEvent } from '../src/shared/slackFilter.ts'

const ME = 'U0ME'
const msg = (o) => ({ type: 'message', user: 'U0NOAH', channel: 'C1', ts: '100.1', text: 'hi', channel_type: 'channel', ...o })

test('a DM from someone else is for you', () => {
  assert.deepEqual(wantSlackEvent(msg({ channel: 'D1', channel_type: 'im' }), ME, {}), { dm: true })
  assert.deepEqual(wantSlackEvent(msg({ channel: 'G1', channel_type: 'mpim' }), ME, {}), { dm: true })
})
test('a channel message mentioning you is; one that does not is not', () => {
  assert.deepEqual(wantSlackEvent(msg({ text: '<@U0ME> can you check the deploy?' }), ME, {}), { dm: false })
  assert.equal(wantSlackEvent(msg({ text: 'deploy is green' }), ME, {}), null)
  assert.equal(wantSlackEvent(msg({ text: '<!here> standup in 5' }), ME, {}), null)
})
test('a reply in a thread a session took on goes to that session, mention or not', () => {
  assert.deepEqual(wantSlackEvent(msg({ ts: '105.2', thread_ts: '100.1', text: 'also the logs' }), ME, { 'C1:100.1': 'g7' }), { dm: false, tab: 'g7' })
})
test('your own messages, bots, edits and joins are not', () => {
  assert.equal(wantSlackEvent(msg({ channel_type: 'im', user: ME }), ME, {}), null)
  assert.equal(wantSlackEvent(msg({ channel_type: 'im', bot_id: 'B1' }), ME, {}), null)
  assert.equal(wantSlackEvent(msg({ channel_type: 'im', subtype: 'message_changed' }), ME, {}), null)
  assert.equal(wantSlackEvent(msg({ text: '<@U0ME>', subtype: 'channel_join' }), ME, {}), null)
  assert.equal(wantSlackEvent({ type: 'reaction_added', user: 'U0NOAH' }, ME, {}), null)
})
test('a shared file in a DM still is', () => {
  assert.deepEqual(wantSlackEvent(msg({ channel_type: 'im', subtype: 'file_share' }), ME, {}), { dm: true })
})
