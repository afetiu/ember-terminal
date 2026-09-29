import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { CONFIG_DIR } from './config.js'
import { briefing, ORCHESTRATOR_SYSTEM } from './briefing.js'

const run = promisify(execFile)
const HOME = homedir()
const SECRETS_PATH = join(CONFIG_DIR, 'secrets.json')

/**
 * The orchestrator's brain.
 *
 * The voice used to be the whole orchestrator: an OpenAI realtime model with no context
 * and one tool, which was a full Claude Code session. It could hear and speak beautifully
 * and it knew nothing, so every question — including ones answerable from a file it could
 * have read in 40ms — became a multi-minute round trip whose long, speculative prompt was
 * written by something with no idea what it was asking about. That is the whole diagnosis:
 * not a bad model, a model with no context and one very expensive way to get any.
 *
 * So the speech stays where it is good and the thinking moves here. OpenAI's realtime
 * model keeps the microphone, the turn-taking and the voice; every substantive turn is
 * forwarded to Claude, which answers with the user's memory, his project list and the live
 * state of his machine already in front of it.
 *
 * Three things make this fast enough to talk to:
 *
 *   - The briefing is a **cached prefix**. It is assembled in a stable order with no clock
 *     in it, so it reads at a fraction of input price and skips prefill on every turn
 *     after the first. Carrying a few thousand tokens of standing context is cheaper per
 *     turn than the single tool call it replaces.
 *   - **Low effort.** This is conversation, not a refactor. Opus 5 is unusually strong at
 *     the low end, and depth here costs latency measured in seconds of silence.
 *   - **Streaming.** The first sentence is spoken while the rest is still being written.
 *
 * The tools are all local and all fast. `ask_claude` — the old slow path — is not here:
 * it stays in the renderer, because dispatching work to a session is the renderer's job,
 * and because it is now the exception rather than the only route to a fact.
 */

/** Conversation, low effort. Depth here is paid for in silence. */
const MODEL = 'claude-opus-5'
const EFFORT = 'low'

interface Secrets {
  anthropic?: { key?: string }
}

function readKey(): string {
  try {
    if (!existsSync(SECRETS_PATH)) return ''
    const s = JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as Secrets
    return s.anthropic?.key ?? ''
  } catch {
    return ''
  }
}

export function brainConfigured(): boolean {
  return !!readKey()
}

/**
 * Keep a path inside the home directory.
 *
 * The model chooses these, and a model's choice is untrusted input however well it is
 * behaving. Confining reads to `~` is what stops "read my notes" from becoming a way to
 * read anything on the disk, including the secrets file two directories up.
 */
function safePath(p: string): string | null {
  if (!p) return null
  const expanded = p.startsWith('~') ? join(HOME, p.slice(1)) : p
  const full = resolve(isAbsolute(expanded) ? expanded : join(HOME, expanded))
  return full === HOME || full.startsWith(HOME + '\\') || full.startsWith(HOME + '/') ? full : null
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read a file from the user’s machine. Fast — use it rather than asking a Claude session ' +
      'what a file says. Paths may be absolute or relative to his home directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "ember/package.json" or "~/CLAUDE.md"' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory. Use it to find something before reading it.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Search file contents under a directory, by regular expression. Returns matching ' +
      'lines with their files. This is how you answer "where is X" without opening a session.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search. Defaults to the home directory.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'git',
    description:
      'Run a read-only git command in a repository — log, status, diff, branch, show. ' +
      'Write commands are refused; this is for finding out, not for changing.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository directory, e.g. "ember".' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments after `git`, e.g. ["log", "-5", "--oneline"].',
        },
      },
      required: ['repo', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'github',
    description:
      'Run a read-only GitHub CLI command — pr list, issue list, run list, release view. ' +
      'gh is already signed in on this machine. Use it for anything about the remote.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments after `gh`, e.g. ["pr", "list", "--repo", "owner/repo"].',
        },
        repo: { type: 'string', description: 'Optional directory to run in, for repo context.' },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
  {
    name: 'notes',
    description: 'List the user’s notes, newest first, with a preview of each. Read one with read_file.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** Only ever read. The orchestrator answers questions; sessions do the work. */
const GIT_READONLY = new Set(['log', 'status', 'diff', 'show', 'branch', 'remote', 'tag', 'blame', 'describe', 'rev-parse', 'shortlog'])
const GH_READONLY = new Set(['pr', 'issue', 'run', 'release', 'repo', 'workflow', 'api', 'search', 'status'])
/** Subcommands of an otherwise-read-only `gh` noun that write. `gh pr list` yes, `gh pr merge` no. */
const GH_WRITE_VERBS = new Set(['create', 'merge', 'close', 'delete', 'edit', 'comment', 'review', 'rerun', 'cancel', 'upload', 'clone', 'fork', 'sync', 'ready', 'reopen'])

const CAP = 6000
const cap = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}\n…(truncated)` : s)

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  const str = (k: string): string => String(input[k] ?? '').trim()
  const list = (k: string): string[] => (Array.isArray(input[k]) ? (input[k] as unknown[]).map(String) : [])

  try {
    switch (name) {
      case 'read_file': {
        const p = safePath(str('path'))
        if (!p) return 'That path is outside the user’s home directory, so it is not readable from here.'
        if (!existsSync(p)) return `No such file: ${str('path')}`
        if (statSync(p).isDirectory()) return `${str('path')} is a directory — use list_dir.`
        return cap(readFileSync(p, 'utf8'))
      }

      case 'list_dir': {
        const p = safePath(str('path') || '.')
        if (!p || !existsSync(p)) return `No such directory: ${str('path')}`
        const entries = readdirSync(p, { withFileTypes: true })
          .slice(0, 200)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return entries.join('\n') || '(empty)'
      }

      case 'search': {
        const dir = safePath(str('path') || '.')
        if (!dir) return 'That path is outside the user’s home directory.'
        // ripgrep ships with the user's tooling and is the difference between this being a
        // tool the orchestrator reaches for and one it avoids.
        const { stdout } = await run('rg', ['--line-number', '--max-count', '5', '--max-columns', '200', str('pattern'), dir], {
          timeout: 8000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })
        return cap(stdout) || 'No matches.'
      }

      case 'git': {
        const args = list('args')
        if (!args.length || !GIT_READONLY.has(args[0]!)) {
          return `git ${args[0] ?? ''} is not a read-only command. The orchestrator only reads; hand writing work to a session.`
        }
        const repo = safePath(str('repo') || '.')
        if (!repo) return 'That repository path is outside the user’s home directory.'
        const { stdout } = await run('git', ['-C', repo, ...args], { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        return cap(stdout) || '(no output)'
      }

      case 'github': {
        const args = list('args')
        if (!args.length || !GH_READONLY.has(args[0]!)) return `gh ${args[0] ?? ''} is not permitted here.`
        if (args.some((a) => GH_WRITE_VERBS.has(a))) {
          return 'That gh command writes. The orchestrator only reads — hand it to a session if it needs doing.'
        }
        const cwd = safePath(str('repo') || '.') ?? HOME
        const { stdout } = await run('gh', args, { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        return cap(stdout) || '(no output)'
      }

      case 'notes': {
        const dir = process.env['EMBER_NOTES_DIR'] || join(HOME, 'Documents', 'Ember Notes')
        if (!existsSync(dir)) return 'There are no notes yet.'
        const rows = readdirSync(dir)
          .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
          .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => b.at - a.at)
          .slice(0, 40)
          .map(({ f, at }) => `${f} — ${new Date(at).toLocaleString()}`)
        return rows.join('\n') || 'There are no notes yet.'
      }

      default:
        return `Unknown tool: ${name}`
    }
  } catch (err) {
    // Tool failures are conversational, not exceptional: the orchestrator should be able
    // to say "that repo has no commits yet" rather than going silent mid-sentence.
    const msg = (err as { stderr?: string; message?: string }).stderr || (err as Error).message
    return `That failed: ${String(msg).trim().slice(0, 400)}`
  }
}

export interface TurnResult {
  ok: boolean
  text: string
  error?: string
}

/** Per-tab conversation history, so a call is a conversation rather than a series of strangers. */
const histories = new Map<string, Anthropic.MessageParam[]>()
/** The briefing, built once per process. Rebuilding it per turn would defeat the cache. */
let cachedBriefing: string | null = null

export function forgetBrain(tabId?: string): void {
  if (tabId) histories.delete(tabId)
  else histories.clear()
}

/**
 * One spoken turn.
 *
 * `live` carries whatever the renderer knows and the briefing cannot: which tab is open,
 * what the sessions are doing right now. It is deliberately appended *after* the cached
 * prefix rather than folded into the system prompt — anything that changes per turn must
 * live on the volatile side of the cache breakpoint, or it invalidates the whole briefing
 * on every single request.
 */
export async function speak(tabId: string, question: string, live: string): Promise<TurnResult> {
  const key = readKey()
  if (!key) {
    return { ok: false, text: '', error: 'no anthropic key' }
  }

  cachedBriefing ??= await briefing()
  const client = new Anthropic({ apiKey: key })

  const history = histories.get(tabId) ?? []
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: live ? `${live}\n\n${question}` : question },
  ]

  try {
    // Up to a few tool round trips, then answer with what it has. A voice call cannot
    // wait out a long agentic loop — if it needs that much digging, the honest reply is
    // to say so and offer to hand it to a session.
    for (let hop = 0; hop < 4; hop++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        output_config: { effort: EFFORT },
        // The breakpoint sits at the end of the briefing: everything before it is
        // byte-identical every turn and reads from cache.
        system: [
          { type: 'text', text: ORCHESTRATOR_SYSTEM },
          { type: 'text', text: cachedBriefing, cache_control: { type: 'ephemeral' } },
        ],
        tools: TOOLS,
        messages,
      })
      const reply = await stream.finalMessage()

      if (reply.stop_reason !== 'tool_use') {
        const text = reply.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim()
        messages.push({ role: 'assistant', content: reply.content })
        // Keep the tail only. A spoken conversation does not need its whole history, and
        // an unbounded one would eventually cost more than the briefing it sits behind.
        histories.set(tabId, messages.slice(-12))
        return { ok: true, text }
      }

      messages.push({ role: 'assistant', content: reply.content })
      const calls = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const results = await Promise.all(
        calls.map(async (c) => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: await runTool(c.name, (c.input ?? {}) as Record<string, unknown>),
        })),
      )
      messages.push({ role: 'user', content: results })
    }

    histories.set(tabId, messages.slice(-12))
    return { ok: true, text: 'That is taking more digging than I can do while we talk. Want me to put a session on it?' }
  } catch (err) {
    console.error(`[ember] orchestrator turn failed: ${(err as Error).message}`)
    return { ok: false, text: '', error: (err as Error).message }
  }
}
