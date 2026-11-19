/**
 * The story of a session, for the person: a header that says what the work is and where it
 * stands, and one plain line per request, grouped by goal. Written by a small background
 * run when a request ends — never in the session itself, so its context is not spent —
 * and kept per session (its transcript's name), so a resumed session has its story back.
 *
 * The words are what the person cares about: what was decided, what works now, what waits
 * on them. Not files, commands, tools or counts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import type { Story, StoryRequest } from '../shared/types.js'

const DIR = join(CONFIG_DIR, 'story')
const KEEP = 200

function pathOf(key: string): string {
  return join(DIR, `${key.replace(/[^\w.-]/g, '_').slice(0, 120)}.json`)
}

export function loadStory(key: string): Story {
  try {
    const s = JSON.parse(readFileSync(pathOf(key), 'utf8')) as Story
    if (s && Array.isArray(s.entries)) return { header: String(s.header ?? ''), goal: String(s.goal ?? ''), entries: s.entries }
  } catch {
    /* none yet */
  }
  return { header: '', goal: '', entries: [] }
}

function saveStory(key: string, s: Story): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  writeFileSync(pathOf(key), JSON.stringify({ ...s, entries: s.entries.slice(-KEEP) }, null, 1), 'utf8')
}

function clip(s: string, n: number): string {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export function storyPrompt(s: Story, r: StoryRequest): string {
  const recent = s.entries.slice(-12)
  return [
    'You keep a short running account of a work session between a person and their AI coding agent. It is for the person,',
    'so they can see at a glance what they are doing and where it stands without scrolling back.',
    '',
    'Reply with ONLY a JSON object, no prose, no code fence:',
    '{"goal": "...", "header": "...", "entry": "..."}',
    '',
    '- goal: the one feature, problem or question this request is about, 2 to 6 words, sentence case ("Tab names", "Live',
    '  status while working"). Not the project or app as a whole. Keep the previous goal word for word only when this',
    '  request carries on the same thing; a different feature or problem is a new goal. Releasing, committing, testing or',
    '  checking what was just built is never a goal of its own: it stays under the previous goal.',
    '- header: one sentence, at most 16 words: that goal and where it stands now — what is done, what is next, or what is',
    '  waiting on the person.',
    '- entry: what this request achieved, past tense, at most 12 words, the way the person would tell a colleague:',
    '  outcomes, decisions, answers. Empty string when nothing happened worth a line (a thanks, an ok).',
    '',
    'Write what the person cares about, never the machinery: no file names, functions, commands, tools, tests, counts of',
    'files or steps. A version they asked to release is fine. Plain words, no jargon, no emoji. Same language as the person.',
    '',
    `Previous goal: ${s.goal || '(none yet)'}`,
    `Previous header: ${s.header || '(none yet)'}`,
    'Earlier lines:',
    ...(recent.length ? recent.map((e) => `- [${e.goal}] ${e.text}`) : ['(none yet)']),
    '',
    'The person asked:',
    clip(r.prompt, 2000),
    '',
    "The agent's final reply:",
    clip(r.reply, 3500) || '(no reply text)',
  ].join('\n')
}

/** The JSON out of the run's text, loosely: a fence or a word around it is tolerated. */
export function parseStory(text: string): { goal: string; header: string; entry: string } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string).replace(/\s+/g, ' ').trim() : '')
    return { goal: str('goal'), header: str('header'), entry: str('entry') }
  } catch {
    return null
  }
}

/** One request at a time per session, in the order they ended. */
const chains = new Map<string, Promise<unknown>>()

export function tellStory(r: StoryRequest): Promise<Story> {
  const prev = chains.get(r.key) ?? Promise.resolve()
  const next = prev.then(async () => {
    const s = loadStory(r.key)
    if (s.entries.some((e) => e.uuid === r.uuid)) return s
    const { runAgent } = await import('./agents.js')
    const out = await runAgent(storyPrompt(s, r), { timeoutMs: 90_000, model: 'haiku' }).done
    const got = out.ok ? parseStory(out.text) : null
    if (!got) return s
    const goal = got.goal || s.goal
    const story: Story = {
      goal,
      header: got.header || s.header,
      entries: got.entry ? [...s.entries, { uuid: r.uuid, goal, text: got.entry, at: r.at || Date.now() }] : s.entries,
    }
    saveStory(r.key, story)
    return story
  })
  chains.set(
    r.key,
    next.catch(() => undefined)
  )
  return next.catch(() => loadStory(r.key))
}
