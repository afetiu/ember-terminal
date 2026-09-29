#!/usr/bin/env node
/**
 * The orchestrator's MCP server.
 *
 * The orchestrator is not a model Ember calls with a key. It is one headless turn of the
 * agent CLI the person chose — Claude Code, Codex, Gemini… — run with this server
 * attached. The tools are the ones that run the crew: list the sessions, hand one work,
 * open a new one, ask one and wait. They all live in the renderer, which is where the
 * tabs are, so every call here is forwarded over the bridge (`/orch/tool`) and answered
 * by the window. This process only speaks MCP.
 *
 * Hand-rolled JSON-RPC for the same reason as mcp-panel.mjs: it must run from a packaged
 * app with no node_modules.
 */

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const RUN = process.env.EMBER_ORCH_RUN || ''

const session = { type: 'string', description: 'Which session: its id, its number or a word of its title, from list_sessions.' }

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'Every terminal session open in Ember right now: which agent CLI runs in it, whether it is working, idle or ' +
      'waiting for the user, its folder, and what it was last asked to do. Fast; call it before handing out work so ' +
      'you reuse an idle session instead of piling onto a busy one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_work',
    description:
      'Hand a task to a session and do not wait. The session works in the background; Ember tells the user when it ' +
      'finishes. Brief it fully — it cannot see this conversation, so state the goal, the constraints and where to work.',
    inputSchema: {
      type: 'object',
      properties: { session, task: { type: 'string', description: 'The whole brief, self-contained.' } },
      required: ['session', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_session',
    description:
      'Ask a session a question and wait for its answer (up to a few minutes). Use it only when the user is waiting ' +
      'to hear the answer; for work, use send_work.',
    inputSchema: {
      type: 'object',
      properties: { session, question: { type: 'string', description: 'The question, self-contained.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_session',
    description:
      'Open a new tab, start the user’s agent CLI in it, and give it a task. Returns at once; the task is sent as ' +
      'soon as the agent is up. Use it when every session is busy or the work belongs in another project folder.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The brief, self-contained. Omit to just open one.' },
        directory: { type: 'string', description: 'Absolute path, or a project folder name from list_projects. Omit for the home folder.' },
        name: { type: 'string', description: 'A short label for the tab.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_work',
    description: 'What a session has said since work was handed to it, and whether it has finished.',
    inputSchema: { type: 'object', properties: { session }, required: ['session'], additionalProperties: false },
  },
  {
    name: 'list_projects',
    description: 'The user’s project folders, for choosing where a new session should work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_session',
    description: 'Bring a session on screen so the user can see it.',
    inputSchema: { type: 'object', properties: { session }, required: ['session'], additionalProperties: false },
  },
  {
    name: 'close_session',
    description:
      'Close a session and end its shell. Refuses on a session that is still working unless force is set, and on the ' +
      'last one. Only when the user asked, or to tidy up work that is clearly finished.',
    inputSchema: {
      type: 'object',
      properties: { session, force: { type: 'boolean', description: 'Close it even though it is working. Only when the user said so.' } },
      required: ['session'],
      additionalProperties: false,
    },
  },
]

// Annotations tell a CLI how careful to be, and a headless run has nobody to answer an
// approval prompt. None of these touch a file or run a command: the dispatching ones hand
// words to a session, which keeps its own permission prompts for whatever it then does.
// Only close_session destroys something, and it says so — a CLI that refuses it headless
// is the right outcome.
const READ_ONLY = new Set(['list_sessions', 'check_work', 'list_projects', 'show_session', 'ask_session', 'send_work', 'start_session'])
for (const t of TOOLS) {
  t.annotations = READ_ONLY.has(t.name)
    ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: t.name === 'close_session', openWorldHint: false }
}

/** The renderer's names for the two tools that were named for Claude. */
const RENAMED = { ask_session: 'ask_claude' }

async function call(name, args) {
  if (!BRIDGE || !TOKEN) throw new Error('Ember is not reachable from here — this server only works in a run Ember started.')
  const res = await fetch(`${BRIDGE}/orch/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
    body: JSON.stringify({ run: RUN, name: RENAMED[name] ?? name, args }),
  })
  if (!res.ok) throw new Error(`Ember said ${res.status}: ${await res.text().catch(() => '')}`)
  const body = await res.json()
  return String(body.result ?? '')
}

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

async function handle(msg) {
  const { id, method, params } = msg
  const reply = (result) => id !== undefined && id !== null && write({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ember-orch', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call':
      try {
        return reply({ content: [{ type: 'text', text: await call(params?.name, params?.arguments ?? {}) }] })
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Could not reach Ember: ${err.message}` }], isError: true })
      }
    default:
      if (id !== undefined && id !== null && !String(method).startsWith('notifications/')) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method "${method}"` } })
      }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let cut = buffer.indexOf('\n')
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line) {
      try {
        void handle(JSON.parse(line))
      } catch {
        /* unparseable line */
      }
    }
    cut = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
