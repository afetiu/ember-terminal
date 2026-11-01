import { ipcMain } from 'electron'
import { AGENTS, type AgentId } from '../shared/agents.js'
import type { CouncilEvent, CouncilRequest } from '../shared/types.js'
import { killTree, runAgent } from './agents.js'
import { runCouncil, type Ask } from './councilRun.js'

/**
 * The council (docs/specs/providers.md §4): several agent CLIs debate one question,
 * read-only, in the tab's folder, and a chair concludes. The order of play lives in
 * `councilRun.ts`; this file gives it real headless runs and the IPC.
 *
 * Notes between rounds ride on the existing contract: a second `start` carrying the id
 * of a council that is still running does not start anything — its `interject` becomes
 * the note everyone reads at the start of the next round.
 */

/** One call to one agent. Long enough for a careful answer, short enough to notice a hang. */
const CALL_TIMEOUT_MS = 3 * 60_000

interface Running {
  abort: AbortController
  note?: string
}

const running = new Map<string, Running>()

/** A real headless run through agents.ts, killed when the council is stopped. */
export const askAgent: Ask = (agent, prompt, cwd, signal) => {
  if (!(agent in AGENTS)) return Promise.resolve({ ok: false, text: '', error: `unknown agent ${agent}` })
  if (signal.aborted) return Promise.resolve({ ok: false, text: '', error: 'stopped' })
  // No `args`: the run gets the agent's own read-only flags.
  const run = runAgent(prompt, { agent: agent as AgentId, cwd, timeoutMs: CALL_TIMEOUT_MS })
  // Stop answers at once; the process tree is killed behind it.
  return new Promise((resolve) => {
    const kill = () => {
      killTree(run.child)
      resolve({ ok: false, text: '', error: 'stopped' })
    }
    signal.addEventListener('abort', kill, { once: true })
    void run.done.then((r) => {
      signal.removeEventListener('abort', kill)
      resolve(r)
    })
  })
}

export function registerCouncil(send: (channel: string, payload: unknown) => void): void {
  const emit = (e: CouncilEvent) => send('ember:council:event', e)

  ipcMain.on('ember:council:start', (_e, req: CouncilRequest) => {
    if (!req || typeof req.id !== 'string') return
    const live = running.get(req.id)
    if (live) {
      // A note for the next round, not a second council.
      const note = req.interject?.trim()
      live.note = note || undefined
      emit({ id: req.id, at: Date.now(), kind: 'status', text: note ? 'Your note will be read in the next round.' : 'Note cleared.' })
      return
    }
    const entry: Running = { abort: new AbortController(), note: req.interject?.trim() || undefined }
    running.set(req.id, entry)
    void runCouncil(req, askAgent, emit, {
      signal: entry.abort.signal,
      takeNote: () => {
        const n = entry.note
        entry.note = undefined
        return n
      },
    })
      .catch((err: unknown) => {
        emit({ id: req.id, at: Date.now(), kind: 'error', text: String(err) })
        emit({ id: req.id, at: Date.now(), kind: 'done', text: 'failed' })
      })
      .finally(() => running.delete(req.id))
  })

  ipcMain.on('ember:council:stop', (_e, id: string) => {
    running.get(id)?.abort.abort()
  })
}
