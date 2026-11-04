import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Which Claude Code transcript a tab's session is writing.
 *
 * Claude Code writes a structured record of each session to
 * `~/.claude/projects/<slug>/<id>.jsonl`; the canvas feed (canvas.ts) tails it. Binding
 * a tab to its file is exact: Claude Code puts `CLAUDE_CODE_SESSION_ID` into the
 * environment of every MCP server it spawns, and Ember's panel server knows its tab from
 * `EMBER_TAB_ID`, so it reports the pair. The status line follows `/clear` and `/resume`.
 */

/** How Claude Code names a working directory's transcript folder. */
function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const PROJECTS = join(homedir(), '.claude', 'projects')

/**
 * tab id -> the Claude session running in it, as reported by that session's MCP server.
 *
 * `file` is set when the transcript's path was reported outright (the status line carries
 * it), which beats deriving it from the working directory.
 */
const bindings = new Map<string, { sessionId: string; cwd: string; file?: string }>()

/** The transcript a tab's session is writing, or null while no session has announced itself. */
export function transcriptPath(tabId: string): string | null {
  const bound = bindings.get(tabId)
  if (!bound) return null
  return bound.file || join(PROJECTS, projectSlug(bound.cwd), `${bound.sessionId}.jsonl`)
}

/**
 * A session in a tab has identified itself.
 *
 * Reported by the panel MCP server, which Claude Code spawns with both
 * `CLAUDE_CODE_SESSION_ID` and the `EMBER_TAB_ID` it inherited from the shell — the only
 * place those two facts exist together. It arrives whenever `claude` starts.
 */
export function bindSession(tabId: string, sessionId: string, cwd: string, file?: string): void {
  if (!tabId || !sessionId || !cwd) return
  bindings.set(tabId, { sessionId, cwd, ...(file ? { file } : {}) })
}

/**
 * Follow the session a tab's status line reports.
 *
 * The MCP server announces a session once, when `claude` starts — but `/clear` and
 * `/resume` move the same process on to a different transcript, and the announcement
 * never comes again. The status line is redrawn all the time and carries both the
 * current session id and the exact transcript path, so a change there is the change.
 */
export function rebindFromStatus(tabId: string, raw: Record<string, unknown>): void {
  const sessionId = String(raw['session_id'] ?? '')
  const file = String(raw['transcript_path'] ?? '')
  if (!tabId || !sessionId) return
  const current = bindings.get(tabId)
  if (current && current.sessionId === sessionId) {
    if (file && current.file !== file) current.file = file
    return
  }
  const workspace = (raw['workspace'] ?? {}) as Record<string, unknown>
  const cwd = current?.cwd || String(raw['cwd'] ?? workspace['project_dir'] ?? workspace['current_dir'] ?? '')
  if (!cwd && !file) return
  bindSession(tabId, sessionId, cwd || '.', file || undefined)
}

/** Forget a tab's session binding when the tab goes away. */
export function unbindSession(tabId: string): void {
  bindings.delete(tabId)
}

/** The session a tab's Claude last reported — by its panel server or its status line. */
export function boundSession(tabId: string): string {
  return bindings.get(tabId)?.sessionId ?? ''
}
