import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import { INSTRUCTIONS, ORCHESTRATOR_TOOLS } from './openai.js'
import { runAgent } from './agents.js'
import { resourcePath } from './resources.js'

/**
 * The orchestrator's text half.
 *
 * It is the same agent as the voice — same brief, same tools, same shared history — with
 * a different way in. That matters more than it sounds: the point is not "a chat box as
 * well", it is that you can start something out loud, walk into an office, and carry on
 * typing to the *same* thing without re-explaining anything.
 *
 * Only one turn of the loop lives here. The tools run in the renderer, because that is
 * where the tabs and sessions are, so main does the part only main can do — hold the key
 * and make the request — and hands back whatever the model said, including any tool calls
 * it wants run. The renderer executes them and calls back with the results. The key never
 * crosses into a window; the window never has to know how to reach OpenAI.
 *
 * Chat Completions rather than Realtime, obviously, but also rather than the Responses
 * API: the loop here is explicitly renderer-driven, and Chat Completions' plain
 * messages-in-messages-out shape is the one that survives being split across a process
 * boundary without carrying server-side state that only one side can see.
 */

const SECRETS_PATH = join(CONFIG_DIR, 'secrets.json')

function key(): string {
  try {
    if (!existsSync(SECRETS_PATH)) return ''
    return (JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as { openai?: { key?: string } }).openai?.key ?? ''
  } catch {
    return ''
  }
}

/**
 * How the written half differs from the spoken one.
 *
 * Everything about *what it is* is shared — the crew, the wait-or-don't judgement, the
 * briefing discipline. What changes is only the medium, and the medium changes real
 * things: prose can be read back, so it can be denser; there is no floor to hold, so the
 * holding line is pointless; and a list is readable where spoken it is unbearable.
 */
const TEXT_ADDENDUM = [
  '\n\nYou are being written to rather than spoken to right now. Same you, same crew, same ',
  'conversation — the user may have been talking to you a minute ago and is now typing because ',
  'he is somewhere he cannot speak.\n\n',
  'Write for reading: no markdown headings, no bold, a short list only where a list is ',
  'genuinely clearer than a sentence. Denser than speech is fine, because he can re-read ',
  'it — shorter is still better. Two or three lines is a normal answer.\n\n',
  'The brevity rules above still hold, and matter more here because padding is visible on ',
  'a screen: no preamble, no restating the request, no closing offer. No holding line ',
  'before a slow tool — there is no silence to fill, so do the work and answer once. Name ',
  'the session that has the work, so he can follow it without asking.',
].join('')

export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface TurnResult {
  ok: boolean
  message?: TurnMessage
  error?: string
}

/** The realtime tool shape, rewritten for Chat Completions. Same tools, different envelope. */
function chatTools(): unknown[] {
  return ORCHESTRATOR_TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: (t as { name: string }).name,
      description: (t as { description: string }).description,
      parameters: (t as { parameters: unknown }).parameters,
    },
  }))
}

/**
 * Run one model turn and hand back what it said.
 *
 * Returns rather than throws for anything the caller could sensibly show: the panel is a
 * conversation, and "OpenAI is rate-limiting us" belongs in it as a message rather than
 * as an exception that leaves the composer looking broken.
 */
export async function textTurn(history: TurnMessage[], model: string): Promise<TurnResult> {
  const k = key()
  if (!k) return { ok: false, error: `No OpenAI key — add one to ${SECRETS_PATH}` }

  const messages: TurnMessage[] = [{ role: 'system', content: INSTRUCTIONS + TEXT_ADDENDUM }, ...history]

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: chatTools(), tool_choice: 'auto' }),
      // Long enough for a tool-heavy turn, short enough that a wedged request does not
      // leave the composer spinning forever.
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `OpenAI said ${res.status}: ${detail.slice(0, 240)}` }
    }

    const body = (await res.json()) as { choices?: Array<{ message?: TurnMessage }> }
    const message = body.choices?.[0]?.message
    if (!message) return { ok: false, error: 'OpenAI returned no message' }
    return { ok: true, message }
  } catch (err) {
    return { ok: false, error: `Could not reach OpenAI: ${(err as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// The orchestrator on the person's own agent CLI — no key
// ---------------------------------------------------------------------------

/**
 * Who the orchestrator is when it runs as a turn of the chosen CLI.
 *
 * Written for anyone, not for one person: it knows nothing about the user beyond what the
 * sessions, the folders and the conversation show it, and it says so rather than guessing.
 */
const CLI_ORCHESTRATOR = [
  'You are the orchestrator inside Ember, a terminal app. The user runs several coding-agent sessions in Ember tabs; ',
  'you see all of them and can hand them work through the ember-orch tools (list_sessions, send_work, ask_session, ',
  'start_session, check_work, list_projects, show_session, close_session). You may also read files to answer ',
  'directly. You never edit files or run commands yourself: work goes to a session.\n\n',
  'Judgement: if the user wants an answer now, answer from what you can read, or ask_session and wait. If it is work — ',
  'a change, a build, an investigation — send_work to an idle session (list_sessions first), or start_session when ',
  'all are busy or it belongs in another project folder, then say in one line what you set going. Brief sessions in ',
  'full: they cannot see this conversation.\n\n',
  'Write for reading in a small side panel: lead with the answer, two or three lines is normal, no headings, no ',
  'preamble, no restating the request, no closing offer. Name the session that has the work.',
].join('')

export interface CliTurnResult {
  ok: boolean
  text: string
  error?: string
}

/** Ask the orchestrator one thing through the chosen agent CLI, with its tools attached. */
export function cliTurn(
  text: string,
  recap: string,
  env: Record<string, string>,
  onLine: (line: string) => void
): Promise<CliTurnResult> {
  const prompt = [
    CLI_ORCHESTRATOR,
    recap ? `\n\nThe conversation so far:\n${recap}` : '',
    `\n\nThe user says: ${text}`,
  ].join('')
  const launcher = join(CONFIG_DIR, 'bin', 'ember-orch.cmd')
  const r = runAgent(prompt, {
    timeoutMs: 12 * 60_000,
    onLine,
    env,
    mcp: {
      name: 'ember-orch',
      script: resourcePath('mcp-orch.mjs'),
      launcher,
      forward: ['EMBER_BRIDGE_URL', 'EMBER_BRIDGE_TOKEN', 'EMBER_ORCH_RUN'],
    },
  })
  return r.done
}
