/**
 * The story of a session, for the person: a title that says what the session is about —
 * high level, the way a document is titled, changing only when the work grows beyond it —
 * and the story of what happened in it, a few plain sentences per request ("We moved the
 * tab names over to the session's own name, so resumed chats keep theirs"), grouped by
 * what they were about. Written by a small background run when a request ends — never in
 * the session itself, so its context is not spent — and kept per session (its
 * transcript's name), so a resumed session has its story back. A session that has no
 * story yet is given one from its history when it is opened.
 *
 * The words are what the person cares about: what was decided, what works now, what waits
 * on them. Not files, commands, tools or counts.
 *
 * `header` holds the title. Stories from before 2026-11-20 (v1) held a progress line there
 * and short log-like lines; they are written again from the history.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import type { Story, StoryRequest } from '../shared/types.js'

const DIR = join(CONFIG_DIR, 'story')
const KEEP = 200
const VERSION = 2

function pathOf(key: string): string {
  return join(DIR, `${key.replace(/[^\w.-]/g, '_').slice(0, 120)}.json`)
}

export function loadStory(key: string): Story {
  try {
    const s = JSON.parse(readFileSync(pathOf(key), 'utf8')) as Story & { v?: number }
    if (s && s.v === VERSION && Array.isArray(s.entries)) return { header: String(s.header ?? ''), goal: String(s.goal ?? ''), entries: s.entries }
  } catch {
    /* none yet */
  }
  return { header: '', goal: '', entries: [] }
}

function saveStory(key: string, s: Story): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  writeFileSync(pathOf(key), JSON.stringify({ v: VERSION, ...s, entries: s.entries.slice(-KEEP) }, null, 1), 'utf8')
}

function clip(s: string, n: number): string {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const RULES = [
  '- title: what this whole session is about: a fair summary of everything in the story so far plus this request, at',
  '  the level of the area of work, the way you would title a document. 3 to 8 words, sentence case. Not the latest',
  '  request, not progress, not a status, never a list of the parts. One request about one thing: name its area, not',
  '  the thing ("Ember: how sessions read", not "Ember: bigger prompt line"). Several things in one project: name what',
  '  they share ("Ember: everyday workflow and a Slack inbox"). If the previous title is still a fair summary of all of',
  '  it, return it unchanged, word for word. Name the project only from the folder or the person’s own words.',
  '- goal: the feature, problem or question the request was about, 2 to 6 words ("Tab names", "Slack inbox"). Keep the',
  '  previous goal word for word when the request carries on the same thing. Releasing, committing, testing or checking',
  '  what was just built is never a goal of its own: it stays under the previous goal.',
  '- entry: the story of the request, for someone reading back later to understand what happened: one or two plain',
  '  sentences, at most 35 words, "we" voice, past tense — what we did, why, and how it ended up (what works now, what',
  '  was decided, what is left or waiting on the person). Not a list of steps. Empty string when nothing worth telling',
  '  happened (a thanks, an ok).',
  '',
  'Write what the person cares about, never the machinery: no file names, functions, commands, tools, tests, counts of',
  'files or steps. A version they asked to release is fine. Plain words, no jargon, no emoji. Same language as the person.',
  'Call the person "you", never "the user".',
]

export function storyPrompt(s: Story, r: StoryRequest): string {
  const recent = s.entries.slice(-10)
  return [
    'You keep the story of a work session between a person and their AI coding agent, for the person: its title, and what',
    'happened in it.',
    '',
    'Reply with ONLY a JSON object, no prose, no code fence:',
    '{"title": "...", "goal": "...", "entry": "..."}',
    '',
    ...RULES,
    '',
    `The session works in the folder: ${r.folder || '(unknown)'}`,
    `Previous title: ${s.header || '(none yet)'}`,
    `Previous goal: ${s.goal || '(none yet)'}`,
    'The story so far:',
    ...(recent.length ? recent.map((e) => `- [${e.goal}] ${e.text}`) : ['(nothing yet)']),
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
    return { goal: str('goal'), header: str('title') || str('header'), entry: str('entry') }
  } catch {
    return null
  }
}

/** One request at a time per session, in the order they ended. */
const chains = new Map<string, Promise<unknown>>()

function queue(key: string, job: () => Promise<Story>): Promise<Story> {
  const next = (chains.get(key) ?? Promise.resolve()).then(job)
  chains.set(
    key,
    next.catch(() => undefined)
  )
  return next.catch(() => loadStory(key))
}

export function tellStory(r: StoryRequest): Promise<Story> {
  return queue(r.key, async () => {
    const s = loadStory(r.key)
    if (s.entries.some((e) => e.uuid === r.uuid)) return s
    const { runAgent } = await import('./agents.js')
    const out = await runAgent(storyPrompt(s, r), { timeoutMs: 90_000, model: 'sonnet' }).done
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
}

/**
 * A session with no story yet (one from before the story existed, or resumed): its title
 * and story so far, from what the person asked in it and the agent's last reply. Once.
 */
export function backfillStory(key: string, asks: Array<{ uuid: string; text: string }>, lastReply: string, folder = ''): Promise<Story> {
  return queue(key, async () => {
    const s = loadStory(key)
    if (s.header || !asks.length) return s
    // The asks themselves carry the story; long sessions keep their first and last ones.
    const picked = asks.length > 40 ? [...asks.slice(0, 10), ...asks.slice(-30)] : asks
    const prompt = [
      'You write the story of a work session between a person and their AI coding agent, for the person: its title, and what',
      'happened in it so far. You have what the person asked, in order, and the agent\'s last reply.',
      '',
      'Reply with ONLY a JSON object, no prose, no code fence:',
      '{"title": "...", "goal": "...", "story": [{"goal": "...", "entry": "...", "from": <number of the first request it covers>}]}',
      '',
      ...RULES,
      '- story: the story so far, at most 8 entries, oldest first. Each entry tells one piece of work (one goal), and may',
      '  cover several requests; "from" is the number of the first request it covers. goal (top level): the last one.',
      '',
      `The session works in the folder: ${folder || '(unknown)'}`,
      '',
      'What the person asked, in order:',
      ...picked.map((a, i) => `${i + 1}. ${clip(a.text, 400).replace(/\s+/g, ' ')}`),
      '',
      "The agent's last reply:",
      clip(lastReply, 2500) || '(none)',
    ].join('\n')
    const { runAgent } = await import('./agents.js')
    const out = await runAgent(prompt, { timeoutMs: 120_000, model: 'sonnet' }).done
    if (!out.ok) return s
    const m = /\{[\s\S]*\}/.exec(out.text)
    if (!m) return s
    try {
      const j = JSON.parse(m[0]) as { title?: string; goal?: string; story?: Array<{ goal?: string; entry?: string; from?: number }> }
      const entries = (j.story ?? [])
        .filter((e) => e.entry)
        .slice(0, 8)
        .map((e, i) => {
          const at = picked[Math.max(0, Math.min(picked.length - 1, Number(e.from ?? 1) - 1))]
          return { uuid: `${at?.uuid ?? 'early'}#${i}`, goal: String(e.goal ?? ''), text: String(e.entry), at: Date.now() }
        })
      const story: Story = { header: String(j.title ?? '').trim(), goal: String(j.goal ?? entries[entries.length - 1]?.goal ?? ''), entries }
      if (!story.header) return s
      saveStory(key, story)
      return story
    } catch {
      return s
    }
  })
}
