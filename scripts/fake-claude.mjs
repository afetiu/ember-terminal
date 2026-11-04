/**
 * A stand-in for Claude Code in its structured mode, for scripts/probe-native*.mjs.
 *
 * Speaks enough of the protocol (docs/specs/claude-protocol-reference.md): answers
 * `initialize` (with a command list), echoes each user message back as a replay when it
 * starts, streams a reply as text deltas, sends the finished assistant message and a
 * `result`. Like the real one, a message sent while a turn runs is queued
 * (`command_lifecycle`), runs after it, survives an interrupt unless `cancel_queued`, and
 * can be dropped with `cancel_async_message`.
 *
 * What a message says picks the turn:
 *   "slow"      streams for a long time, so an interrupt has something to stop
 *   "ask"       asks to run a Bash command first (`can_use_tool`); "quietly" = no always-allow
 *   "edit"      asks to Edit a file (the card's diff)
 *   "question"  asks an AskUserQuestion; replies with the answers it got
 *   "plan"      asks ExitPlanMode; replies with the decision
 *   "elicit"    an MCP server's form (`elicitation`)
 *   "cancelme"  asks, then withdraws the question (`control_cancel_request`)
 *   "/context"  a synthetic context table, as /context answers
 *   "/clear"    a new conversation: a new session id from then on
 * Also: `--resume <id>` takes that id (FAKE_CLAUDE_MISSING=<id> makes it fail the way a
 * missing session does); set_model, apply_flag_settings and get_context_usage answer.
 * Pictures are counted; `<bash-input>`/`<bash-stdout>` blocks before the text are quoted.
 *
 * FAKE_CLAUDE_LOG names a file that gets its argv, cwd and a line per message it read —
 * appended, so a restarted process (the CLI view and back, a restart) adds its own argv line.
 */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const LOG = process.env.FAKE_CLAUDE_LOG
const log = (o) => LOG && appendFileSync(LOG, JSON.stringify(o) + '\n')
if (LOG) appendFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: { EMBER_TAB_ID: process.env.EMBER_TAB_ID ?? '', EMBER_SURFACE: process.env.EMBER_SURFACE ?? '' } }) + '\n')

let sid = (() => {
  const i = process.argv.indexOf('--session-id')
  const r = process.argv.indexOf('--resume')
  return i > 0 ? process.argv[i + 1] : r > 0 ? process.argv[r + 1] : randomUUID()
})()
if (process.argv.includes('--resume') && process.env.FAKE_CLAUDE_MISSING && process.env.FAKE_CLAUDE_MISSING === sid) {
  process.stderr.write(`No conversation found with session ID: ${sid}\n`)
  process.exit(1)
}
let model = 'fake-haiku'
let ctxPct = 3
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const COMMANDS = [
  { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '' },
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>' },
  { name: 'context', description: 'Visualize current context usage as a colored grid', argumentHint: '' },
  { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '' },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '[model]' },
  { name: 'review', description: 'Review a pull request', argumentHint: '[pr]' },
  { name: 'da-labs', description: 'Run the business side of Deep Answer Labs (user)', argumentHint: '' },
  { name: 'config', description: 'Set a setting: /config key=value', argumentHint: 'key=value' },
  { name: 'fake-terminal-only', description: 'Bound to the terminal', argumentHint: '' },
]
const MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 for complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 for everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5 for quick answers' },
]
const FILES = ['src\\', 'src\\main.ts', 'src\\renderer\\', 'scripts\\probe.mjs', 'README.md', 'package.json']

let turn = null
/** The permission mode, as set_permission_mode leaves it (reported by system/init). */
let mode = 'default'
const queue = []
const asks = new Map()

/** Ask Ember something and wait for the answer; with `withdrawAfter`, take the question back instead. */
function ask(request, withdrawAfter = 0) {
  const id = randomUUID()
  const answered = new Promise((r) => asks.set(id, r))
  out({ type: 'control_request', request_id: id, request })
  if (!withdrawAfter) return answered
  return Promise.race([
    answered,
    wait(withdrawAfter).then(() => {
      asks.delete(id)
      out({ type: 'control_cancel_request', request_id: id })
      return { behavior: 'withdrawn' }
    }),
  ])
}

function textOf(m) {
  const c = m.message.content
  if (typeof c === 'string') return { text: c, images: [], context: [] }
  const texts = c.filter((b) => b.type === 'text').map((b) => b.text)
  const context = texts.filter((t) => /^<bash-(input|stdout)>/.test(t))
  return { text: texts.filter((t) => !context.includes(t)).join(' '), images: c.filter((b) => b.type === 'image'), context }
}

async function run(m) {
  const { text: said0, images, context } = textOf(m)
  const uuid = m.uuid
  const me = (turn = { stop: false, uuid })
  out({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', uuid: randomUUID() })
  if (said0.trim() === '/clear') {
    // A new conversation, as Claude Code starts one: a new id, the command and its (empty) output.
    sid = randomUUID()
    ctxPct = 1
    out({ type: 'system', subtype: 'init', model, permissionMode: mode, cwd: process.cwd(), terminal_slash_commands: ['fake-terminal-only'], uuid: randomUUID() })
    out({ ...m, isReplay: true })
    out({ type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' }, isReplay: true, parent_tool_use_id: null, uuid: randomUUID() })
    out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: '', local_command: 'clear', user_message_uuid: uuid, uuid: randomUUID() })
    return finish(me, uuid)
  }
  const named = /^\/(?:name|rename)\s+(.+)$/.exec(said0.trim())
  if (named) {
    // As the real one answers /name (2.1.3xx): the new title, init, the command's output as a
    // synthetic assistant message, a result. Nothing goes to the model.
    out({ type: 'system', subtype: 'session_title_changed', title: named[1], uuid: randomUUID(), session_id: sid })
    out({ type: 'system', subtype: 'init', model, permissionMode: mode, cwd: process.cwd(), terminal_slash_commands: ['fake-terminal-only'], uuid: randomUUID() })
    out({ type: 'assistant', message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: `Session renamed to: ${named[1]}` }] }, parent_tool_use_id: null, uuid: randomUUID() })
    out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: '', user_message_uuid: uuid, uuid: randomUUID() })
    return finish(me, uuid)
  }
  ctxPct += 9
  out({ type: 'system', subtype: 'init', model, permissionMode: mode, cwd: process.cwd(), effort: 'medium', terminal_slash_commands: ['fake-terminal-only'], uuid: randomUUID() })
  out({ ...m, isReplay: true })
  out({ type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: [uuid], uuid: randomUUID() })
  let text = said0
  if (text.trim() === '/context') {
    await wait(200)
    out({ type: 'assistant', message: { id: `msg_${randomUUID()}`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: '## Context Usage\n\n| Category | Tokens |\n|---|---|\n| System prompt | 3.1k |\n| Messages | 120 |\n| Free space | 196k |' }] }, parent_tool_use_id: null, uuid: randomUUID() })
    out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: '', local_command: 'context', user_message_uuid: uuid, uuid: randomUUID() })
    return finish(me, uuid)
  }
  if (/question/i.test(text)) {
    const questions = [
      { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] },
      { question: 'Which sizes?', header: 'Sizes', multiSelect: true, options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }] },
    ]
    const a = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', requires_user_interaction: true, input: { questions }, tool_use_id: 'toolu_q' })
    text = a.behavior === 'allow' ? `answers ${JSON.stringify(a.updatedInput?.answers ?? {})}` : `question ${a.behavior}: ${a.message ?? ''}`
  } else if (/plan/i.test(text)) {
    const plan = '# Plan\n\n1. Read `main.ts`\n2. Add the **flag**\n3. Run the tests\n\n- keeps the old path\n- no new deps'
    const a = await ask({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', display_name: 'ExitPlanMode', input: { plan }, tool_use_id: 'toolu_p' })
    text = a.behavior === 'allow' ? `plan approved ${JSON.stringify(a.updatedPermissions ?? [])}` : `plan ${a.behavior}: ${a.message ?? ''}`
  } else if (/elicit/i.test(text)) {
    const a = await ask({
      subtype: 'elicitation',
      mcp_server_name: 'tickets',
      message: 'Which project should the ticket go to?',
      mode: 'form',
      requested_schema: {
        type: 'object',
        properties: { project: { type: 'string', title: 'Project', enum: ['EMBER', 'NIMOM'] }, title: { type: 'string', title: 'Title', description: 'One line' }, urgent: { type: 'boolean', title: 'Urgent' } },
        required: ['project', 'title'],
      },
    })
    text = `elicitation ${a.action} ${JSON.stringify(a.content ?? {})}`
  } else if (/cancelme/i.test(text)) {
    const a = await ask({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'sleep 99' }, tool_use_id: 'toolu_c' }, 1500)
    text = `cancel ${a.behavior}`
  } else if (/edit/i.test(text)) {
    const a = await ask({
      subtype: 'can_use_tool',
      tool_name: 'Edit',
      display_name: 'Edit',
      input: { file_path: 'C:\\work\\src\\main.ts', old_string: 'const debug = false\nstart()', new_string: 'const debug = process.env.DEBUG === "1"\nstart({ debug })' },
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      tool_use_id: 'toolu_e',
    })
    text = `edit ${a.behavior}`
  } else if (/ask/i.test(text)) {
    const quiet = /quietly/i.test(text)
    const a = await ask({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'npm test -- --watch=false', description: 'Run the tests once' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }],
      decision_reason: 'npm test is not in your allow list',
      ...(quiet ? { suppress_always_allow_rule: true } : {}),
      tool_use_id: 'toolu_fake',
    })
    text = `you said ${a.behavior}${a.updatedPermissions ? ' always' : ''}${a.message ? `: ${a.message}` : ''}`
  }
  if (images.length) text = `I see ${images.length} image${images.length > 1 ? 's' : ''} (${images.map((i) => `${i.source.media_type} ${i.source.data.length}b`).join(', ')}). ${text}`
  if (context.length) text = `I saw your shell: ${context.join(' ').replace(/\s+/g, ' ').slice(0, 200)}. ${text}`
  const slow = /slow/i.test(text)
  const words = slow ? Array.from({ length: 400 }, (_, i) => `word${i} `) : `Hello from the fake Claude. You said: ${text}`.split(/(?<= )/)
  const mid = `msg_${randomUUID()}`
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: mid } }, parent_tool_use_id: null, uuid: randomUUID() })
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null, uuid: randomUUID() })
  let said = ''
  for (const w of words) {
    if (me.stop) break
    said += w
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, parent_tool_use_id: null, uuid: randomUUID() })
    await wait(slow ? 60 : 30)
  }
  out({ type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'text', text: said }], stop_reason: null }, parent_tool_use_id: null, uuid: randomUUID() })
  if (me.stop) {
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, uuid: randomUUID() })
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '', user_message_uuid: uuid, uuid: randomUUID() })
    out({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled', uuid: randomUUID() })
  } else {
    out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: said, user_message_uuid: uuid, uuid: randomUUID() })
  }
  finish(me, uuid, me.stop)
}

function finish(me, uuid, cancelled = false) {
  if (!cancelled) out({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed', uuid: randomUUID() })
  if (turn === me) turn = null
  // What waited runs next, as the real one does — after an interrupt too.
  const next = queue.shift()
  if (next) void run(next)
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
    // The log keeps what each message carried, pictures cut short.
    log({
      in: m.type,
      subtype: m.request?.subtype ?? m.response?.subtype,
      ...(m.request ? { request: m.request } : {}),
      ...(m.response ? { response: m.response.response } : {}),
      ...(m.type === 'user'
        ? {
            uuid: m.uuid,
            content:
              typeof m.message.content === 'string'
                ? m.message.content
                : m.message.content.map((b) => (b.type === 'image' ? { type: 'image', media_type: b.source.media_type, bytes: b.source.data.length } : b)),
          }
        : {}),
    })
    const reply = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } })
    if (m.type === 'control_request') {
      const r = m.request
      if (r.subtype === 'initialize') {
        // A little startup time, as the real one has.
        setTimeout(
          () =>
            reply({ commands: COMMANDS, models: MODELS, account: {}, current_permission_mode: 'default', claude_code_version: 'fake', capabilities: ['interrupt_send_now_v1', 'interrupt_cancel_queued_v1'] }),
          400
        )
      } else if (r.subtype === 'interrupt') {
        const cancelled = r.cancel_queued ? queue.splice(0).map((q) => q.uuid) : []
        for (const u of cancelled) out({ type: 'command_lifecycle', command_uuid: u, state: 'cancelled', uuid: randomUUID() })
        if (turn) turn.stop = true
        reply({ still_queued: queue.map((q) => q.uuid), ...(cancelled.length ? { cancelled } : {}) })
      } else if (r.subtype === 'file_suggestions') {
        const q = String(r.query ?? '').toLowerCase()
        setTimeout(() => reply({ suggestions: FILES.filter((f) => f.toLowerCase().includes(q)).map((path) => ({ path })), cwd: process.cwd() }), 30)
      } else if (r.subtype === 'cancel_async_message') {
        const at = queue.findIndex((q) => q.uuid === r.message_uuid)
        if (at >= 0) {
          queue.splice(at, 1)
          out({ type: 'command_lifecycle', command_uuid: r.message_uuid, state: 'cancelled', uuid: randomUUID() })
        }
        reply({ cancelled: at >= 0 })
      } else if (r.subtype === 'set_model') {
        model = r.model ?? 'fake-haiku'
        reply({ model })
      } else if (r.subtype === 'apply_flag_settings') {
        reply({})
      } else if (r.subtype === 'get_context_usage') {
        reply({ percentage: ctxPct, totalTokens: ctxPct * 2000, maxTokens: 200000, categories: [] })
      } else if (r.subtype === 'get_settings') {
        // FAKE_CLAUDE_SETTINGS: the effective settings to report (JSON); by default a
        // defaultMode, so Ember leaves the starting mode alone.
        let effective = { permissions: { defaultMode: 'default' } }
        try {
          if (process.env.FAKE_CLAUDE_SETTINGS) effective = JSON.parse(process.env.FAKE_CLAUDE_SETTINGS)
        } catch {}
        reply({ effective, sources: {}, applied: {} })
      } else if (r.subtype === 'rename_session') {
        reply({})
        out({ type: 'system', subtype: 'session_title_changed', title: r.title, uuid: randomUUID(), session_id: sid })
      } else if (r.subtype === 'set_permission_mode') {
        mode = r.mode
        reply({})
        out({ type: 'system', subtype: 'status', status: null, permissionMode: r.mode, uuid: randomUUID() })
      } else {
        out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Unsupported control request subtype: ${r.subtype}` } })
      }
    } else if (m.type === 'control_response') {
      const r = asks.get(m.response.request_id)
      asks.delete(m.response.request_id)
      r?.(m.response.response)
    } else if (m.type === 'user') {
      out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued', uuid: randomUUID() })
      if (turn) queue.push(m)
      else void run(m)
    }
  }
})
// Closing stdin ends the session, as it does for the real one.
process.stdin.on('end', () => setTimeout(() => process.exit(0), 100))
