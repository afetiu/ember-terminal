import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HOME = homedir()

/**
 * What the orchestrator knows before anyone says anything.
 *
 * The previous voice orchestrator was told, in its own instructions, "you do not know
 * things and you do not do work" — and it was true. Nothing about the user's machine, his
 * repositories or his memory reached it, so every question, however small, became a
 * round trip through a full Claude Code turn: minutes of latency to establish a fact
 * that could have been in the prompt all along. Worse, a model that knows nothing writes
 * long speculative questions, which is exactly how you miss the point of a short one.
 *
 * So this assembles a briefing and it goes in the system prompt, where prompt caching
 * makes it nearly free: the cached prefix reads at about a tenth of input price and skips
 * prefill, so carrying a few thousand tokens of standing context costs less per turn than
 * one tool call would have.
 *
 * Everything here is cheap and local. Nothing in this file may block on the network, and
 * nothing may take longer than a second — this runs on the path to the first word of a
 * spoken reply.
 */

/** Read a file if it exists, capped. Notes and memory grow; the prompt should not. */
function readCapped(path: string, max: number): string {
  try {
    if (!existsSync(path)) return ''
    const text = readFileSync(path, 'utf8')
    return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text
  } catch {
    return ''
  }
}

export interface ProjectSummary {
  name: string
  path: string
  branch: string
  dirty: number
  lastCommit: string
}

/**
 * The repositories in the home directory, with their current state.
 *
 * Bounded by mtime rather than listing everything: two dozen project folders is a lot of
 * tokens, and the ones touched this month are the ones a conversation is going to be
 * about. A repo the user has not opened since spring is still reachable through the tools —
 * it just does not earn a line in the standing brief.
 */
export async function projects(limit = 14): Promise<ProjectSummary[]> {
  let dirs: string[] = []
  try {
    dirs = readdirSync(HOME, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(HOME, e.name, '.git')))
      .map((e) => e.name)
  } catch {
    return []
  }

  const byRecency = dirs
    .map((name) => {
      let at = 0
      try {
        at = statSync(join(HOME, name, '.git')).mtimeMs
      } catch {
        /* unreadable — sorts last */
      }
      return { name, at }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)

  // One git call per repo, in parallel, with a hard timeout. A hung git must never be
  // the reason a spoken answer is late.
  const summaries = await Promise.all(
    byRecency.map(async ({ name }): Promise<ProjectSummary | null> => {
      const path = join(HOME, name)
      try {
        const [status, log] = await Promise.all([
          run('git', ['-C', path, 'status', '--porcelain=v2', '--branch'], { timeout: 1500, windowsHide: true }),
          run('git', ['-C', path, 'log', '-1', '--format=%s (%cr)'], { timeout: 1500, windowsHide: true }),
        ])
        let branch = ''
        let dirty = 0
        for (const line of status.stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
          else if (/^[12u?] /.test(line)) dirty++
        }
        return { name, path, branch, dirty, lastCommit: log.stdout.trim() }
      } catch {
        return null
      }
    }),
  )
  return summaries.filter((s): s is ProjectSummary => s !== null)
}

/**
 * The standing brief, as one string.
 *
 * Deliberately assembled in a stable order with no timestamp anywhere: this is the cached
 * prefix, and a clock in it would invalidate the cache on every single turn — paying full
 * price for the whole briefing, every time, to tell the model something it can be told in
 * the volatile part of the prompt instead.
 */
export async function briefing(): Promise<string> {
  const memory = readCapped(join(HOME, '.claude', 'projects', HOME.replace(/[:\\/]/g, '-'), 'memory', 'MEMORY.md'), 12_000)
  const claudeMd = readCapped(join(HOME, 'CLAUDE.md'), 8_000)
  const repos = await projects()

  const parts: string[] = []

  parts.push(
    'You are the user’s orchestrator. You are Claude, running with his real context: his ' +
      'machine, his repositories, his memory and his notes. You are not a switchboard and ' +
      'you are not a stranger — when he asks you something, you almost always already know ' +
      'enough to answer, or can find out in one fast tool call.\n',
  )

  if (memory) {
    parts.push(
      '# What you remember about the user and his work\n\n' +
        'This is his memory index, written across many sessions. Treat it as true unless ' +
        'something in front of you contradicts it, and note that it records what was true ' +
        'when written — a file or flag it names may since have changed.\n\n' +
        memory +
        '\n',
    )
  }

  if (claudeMd) {
    parts.push(`# His machine, as documented\n\n${claudeMd}\n`)
  }

  if (repos.length) {
    const rows = repos
      .map((r) => {
        const state = r.dirty > 0 ? `${r.dirty} uncommitted` : 'clean'
        return `- ${r.name} — ${r.branch || 'detached'}, ${state}. Last: ${r.lastCommit}`
      })
      .join('\n')
    parts.push(
      `# His repositories right now\n\nMost recently touched first. Paths are under ${HOME}.\n\n${rows}\n`,
    )
  }

  return parts.join('\n')
}

/**
 * How the orchestrator talks and decides.
 *
 * Two separate jobs, and they used to be confused. The old instructions spent almost
 * their whole length on brevity, because a model with nothing to say still says a lot.
 * Brevity still matters — this is speech, and a paragraph is unlistenable — but the
 * harder rule now is knowing when to answer from what it already knows, which is most of
 * the time, and when the honest answer is that it has to go and look.
 */
export const ORCHESTRATOR_SYSTEM = [
  '# How you talk\n',
  'You are being spoken to and you answer out loud. One or two sentences. Say the thing, ',
  'then stop.\n',
  '- No preamble. Never open with "okay", "got it", "sure", "right", "let me", "I’ll go ',
  'ahead and". Start with the content.\n',
  '- No lists, no headings, no markdown. Nobody can hear an asterisk.\n',
  '- Numbers and names get said the way a person would say them. "About twenty minutes", ',
  'not "19.4 minutes".\n',
  '- If the answer is long, give the headline and let him ask for the rest.\n\n',

  '# What you know\n',
  'Answer from your briefing and your own reasoning first. You have his memory, his ',
  'project list and the state of every repository — most questions are already answered ',
  'there, and reaching for a tool to confirm something you were just told is the habit ',
  'that made the old orchestrator unbearable.\n\n',

  '# When to use a tool\n',
  'The read tools are fast — tens of milliseconds. Use them freely and silently when a ',
  'fact would settle the question: what a file says, what changed, what a session is ',
  'doing, what is open on GitHub. Do not announce them.\n\n',
  'ask_claude is different. It hands the question to a full Claude Code session and takes ',
  'minutes. It is for work, not for knowledge: write this, run that, fix the thing. If you ',
  'are about to use it to *find something out*, you are almost certainly wrong — read the ',
  'file yourself. When you do use it, say one short line first so he is not left in ',
  'silence, and never use it for something he is not waiting on.\n\n',

  '# Being wrong\n',
  'If you do not know, say so in a sentence and say what you would check. Do not guess at ',
  'specifics — a confident wrong branch name or file path costs him more than an admission ',
  'does. If you looked and the answer is not there, that is the answer.\n',
].join('')
