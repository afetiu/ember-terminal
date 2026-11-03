/**
 * A stand-in for Claude Code in its structured mode, for scripts/probe-native.mjs.
 *
 * Speaks just enough of the protocol (docs/specs/claude-protocol-reference.md): answers
 * `initialize`, echoes each user message back as a replay, streams a reply as text deltas,
 * sends the finished assistant message and a `result`. A message containing "slow" streams
 * for a long time so an interrupt has something to stop; one containing "ask" asks to run a
 * Bash command first and says what it was told.
 *
 * FAKE_CLAUDE_LOG names a file that gets its argv, cwd and a line per message it read.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const LOG = process.env.FAKE_CLAUDE_LOG
const log = (o) => LOG && appendFileSync(LOG, JSON.stringify(o) + '\n')
if (LOG) writeFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: { EMBER_TAB_ID: process.env.EMBER_TAB_ID ?? '', EMBER_SURFACE: process.env.EMBER_SURFACE ?? '' } }) + '\n')

const sid = (() => {
  const i = process.argv.indexOf('--session-id')
  return i > 0 ? process.argv[i + 1] : randomUUID()
})()
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let turn = null
const asks = new Map()

async function reply(uuid, text) {
  const me = (turn = { stop: false })
  out({ type: 'system', subtype: 'init', model: 'fake-haiku', permissionMode: 'default', cwd: process.cwd(), uuid: randomUUID() })
  out({ type: 'system', subtype: 'status', status: 'requesting', uuid: randomUUID() })
  if (/ask/i.test(text)) {
    const id = randomUUID()
    const answered = new Promise((r) => asks.set(id, r))
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: 'toolu_fake' } })
    const answer = await answered
    text = `you said ${answer.behavior}`
  }
  const words = /slow/i.test(text) ? Array.from({ length: 400 }, (_, i) => `word${i} `) : `Hello from the fake Claude. You said: ${text}`.split(/(?<= )/)
  const mid = `msg_${randomUUID()}`
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: mid } }, parent_tool_use_id: null, uuid: randomUUID() })
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null, uuid: randomUUID() })
  let said = ''
  for (const w of words) {
    if (me.stop) break
    said += w
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, parent_tool_use_id: null, uuid: randomUUID() })
    await wait(/slow/i.test(text) ? 60 : 40)
  }
  out({ type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'text', text: said }], stop_reason: null }, parent_tool_use_id: null, uuid: randomUUID() })
  if (me.stop) {
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, uuid: randomUUID() })
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '', user_message_uuid: uuid, uuid: randomUUID() })
  } else {
    out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: said, user_message_uuid: uuid, uuid: randomUUID() })
  }
  if (turn === me) turn = null
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    log({ in: m.type, subtype: m.request?.subtype ?? m.response?.subtype })
    if (m.type === 'control_request' && m.request.subtype === 'initialize') {
      // A little startup time, as the real one has.
      setTimeout(() => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, current_permission_mode: 'default', claude_code_version: 'fake' } } }), 400)
    } else if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
      if (turn) turn.stop = true
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } })
    } else if (m.type === 'control_response') {
      asks.get(m.response.request_id)?.(m.response.response)
    } else if (m.type === 'user') {
      out({ ...m, isReplay: true })
      const c = m.message.content
      void reply(m.uuid, typeof c === 'string' ? c : c.map((b) => b.text ?? '').join(' '))
    }
  }
})
// Closing stdin ends the session, as it does for the real one.
process.stdin.on('end', () => setTimeout(() => process.exit(0), 100))
