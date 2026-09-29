import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import { runAgent } from './agents.js'
import { resourcePath } from './resources.js'

/**
 * The orchestrator: the agent that sees every session and hands them work.
 *
 * It is not a model Ember calls with a key. Each turn is one headless run of the agent
 * CLI the person chose, with resources/mcp-orch.mjs attached; that server's tools (list
 * the sessions, hand one work, open a new one…) come back through the bridge and run in
 * the renderer, which is where the tabs are. The conversation lives in the renderer and
 * arrives here as a recap, so each turn stands alone.
 */

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
