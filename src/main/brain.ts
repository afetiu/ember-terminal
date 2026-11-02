import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { ipcMain } from 'electron'
import { CONFIG_DIR, loadConfig } from './config.js'

/**
 * Ember Brain: one store of knowledge every agent works from (docs/specs/brain.md).
 *
 * Each agent CLI keeps what it knows in its own place — Claude in CLAUDE.md and its memory
 * folders, Codex in AGENTS.md — so switching agents meant switching what the agent knew.
 * The brain lives in Ember's own folder, is seeded from whatever is already on the machine,
 * and is handed to every agent in the form that agent reads:
 *   - instructions: a marked section in each agent's own instructions file;
 *   - memory: Ember's recall / remember / forget tools, which every agent with the canvas
 *     tools has, over plain markdown files any agent can also read directly;
 *   - skills: copied where an agent reads SKILL.md, and readable through a tool otherwise.
 * Nothing outside the marked sections is touched, and each file is backed up once before
 * Ember first writes to it.
 */

const HOME = homedir()
export const BRAIN_DIR = join(CONFIG_DIR, 'brain')
const MEMORY = join(BRAIN_DIR, 'memory')
const SKILLS = join(BRAIN_DIR, 'skills')
const INSTRUCTIONS = join(BRAIN_DIR, 'instructions.md')
const STATE = join(BRAIN_DIR, 'state.json')
const INDEX = join(MEMORY, 'MEMORY.md')

const START = '<!-- ember:brain:start — managed by Ember; edit ~/.ember/brain/instructions.md instead -->'
const END = '<!-- ember:brain:end -->'

interface BrainState {
  /** Where instructions.md was first seeded from. That agent is not handed a copy of its own file. */
  instructionsFrom?: 'claude' | 'codex' | null
  importedAt?: string
  syncedAt?: string
}

function readState(): BrainState {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as BrainState
  } catch {
    return {}
  }
}

function writeState(s: BrainState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8')
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** A file's text without Ember's own managed section, so an import never brings it back in. */
function withoutBlock(text: string): string {
  const a = text.indexOf(START)
  const b = text.indexOf(END)
  return a >= 0 && b > a ? (text.slice(0, a) + text.slice(b + END.length)).trim() : text.trim()
}

// ---------------------------------------------------------------- memory

interface Fact {
  name: string
  description: string
  body: string
  file: string
  mtime: number
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'note'
  )
}

function parseFact(file: string): Fact | null {
  const text = read(file)
  if (!text) return null
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text)
  const head = m?.[1] ?? ''
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  const base = file.split(/[\\/]/).pop()!.replace(/\.md$/i, '')
  return { name: field('name') || base, description: field('description'), body: (m?.[2] ?? text).trim(), file, mtime: statSync(file).mtimeMs }
}

function facts(): Fact[] {
  if (!existsSync(MEMORY)) return []
  return readdirSync(MEMORY)
    .filter((n) => n.toLowerCase().endsWith('.md') && n !== 'MEMORY.md')
    .map((n) => parseFact(join(MEMORY, n)))
    .filter((f): f is Fact => !!f)
}

function writeIndex(): void {
  const lines = facts()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `- [${f.name}](${f.file.split(/[\\/]/).pop()}) — ${f.description || f.body.split('\n')[0]?.slice(0, 120) || ''}`)
  writeFileSync(INDEX, `# Memory\n\nShared by every agent Ember runs. One fact per file.\n\n${lines.join('\n')}\n`, 'utf8')
}

/** The facts that match a question, best first; with no question, the index. */
export function recall(query: string, limit = 8): string {
  const all = facts()
  if (!all.length) return 'Memory is empty.'
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  if (!words.length) return read(INDEX) || all.map((f) => `- ${f.name}: ${f.description}`).join('\n')
  const scored = all
    .map((f) => {
      const head = `${f.name} ${f.description}`.toLowerCase()
      const body = f.body.toLowerCase()
      let score = 0
      for (const w of words) score += (head.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0)
      return { f, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.f.mtime - a.f.mtime)
    .slice(0, limit)
  if (!scored.length) return `Nothing in memory about "${query}".`
  return scored.map(({ f }) => `## ${f.name}\n${f.description ? `${f.description}\n\n` : ''}${f.body.slice(0, 1500)}`).join('\n\n')
}

/** Save one fact (or replace the one with this name). */
export function remember(name: string, description: string, body: string, type = ''): string {
  mkdirSync(MEMORY, { recursive: true })
  const file = join(MEMORY, `${slug(name)}.md`)
  const meta = [`name: ${slug(name)}`, `description: ${description.replace(/\n/g, ' ').trim()}`, ...(type ? [`type: ${type}`] : [])]
  writeFileSync(file, `---\n${meta.join('\n')}\n---\n\n${body.trim()}\n`, 'utf8')
  writeIndex()
  return `Saved "${slug(name)}" to the shared memory.`
}

/** Move a fact to the brain's trash: kept, but no longer recalled. */
export function forget(name: string): string {
  const file = join(MEMORY, `${slug(name)}.md`)
  if (!existsSync(file)) return `No fact called "${name}".`
  const trash = join(BRAIN_DIR, '.trash')
  mkdirSync(trash, { recursive: true })
  renameSync(file, join(trash, `${Date.now()}-${slug(name)}.md`))
  writeIndex()
  return `Forgot "${slug(name)}".`
}

// ---------------------------------------------------------------- skills

function skillDirs(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).filter((n) => existsSync(join(root, n, 'SKILL.md')))
  } catch {
    return []
  }
}

/** The shared skills: a list with one-line descriptions, or one skill's full text. */
export function skills(name?: string): string {
  if (name) {
    const text = read(join(SKILLS, name, 'SKILL.md'))
    return text || `No skill called "${name}".`
  }
  const list = skillDirs(SKILLS).map((n) => {
    const d = /^description:\s*(.+)$/m.exec(read(join(SKILLS, n, 'SKILL.md')))?.[1] ?? ''
    return `- ${n}: ${d.slice(0, 160)}`
  })
  return list.length ? list.join('\n') : 'No shared skills yet.'
}

/** Copy skills that `to` does not have yet (a skill already there is the owner's and stays). */
function copyMissing(from: string, to: string): number {
  let n = 0
  for (const s of skillDirs(from)) {
    if (existsSync(join(to, s))) continue
    try {
      mkdirSync(to, { recursive: true })
      cpSync(join(from, s), join(to, s), { recursive: true })
      n++
    } catch {
      /* one skill that will not copy does not stop the rest */
    }
  }
  return n
}

// ---------------------------------------------------------------- import

/** Claude Code's memory folders: one per project, plus the global one. */
function claudeMemoryDirs(): string[] {
  const root = join(HOME, '.claude', 'projects')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .map((p) => join(root, p, 'memory'))
      .filter((d) => existsSync(d))
  } catch {
    return []
  }
}

/** Bring in Claude's memory files the brain does not have, or has older copies of. */
function importClaudeMemory(): number {
  let n = 0
  mkdirSync(MEMORY, { recursive: true })
  for (const dir of claudeMemoryDirs()) {
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.md') && x !== 'MEMORY.md')
    } catch {
      continue
    }
    for (const x of names) {
      const src = join(dir, x)
      const dst = join(MEMORY, x)
      try {
        if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue
        writeFileSync(dst, readFileSync(src))
        n++
      } catch {
        /* skip one unreadable file */
      }
    }
  }
  if (n) writeIndex()
  return n
}

/** First use: seed the brain from what this machine already has. */
function seed(): void {
  mkdirSync(MEMORY, { recursive: true })
  mkdirSync(SKILLS, { recursive: true })
  const state = readState()
  if (!existsSync(INSTRUCTIONS)) {
    const claude = withoutBlock(read(join(HOME, '.claude', 'CLAUDE.md')))
    const codex = withoutBlock(read(join(HOME, '.codex', 'AGENTS.md')))
    const from = claude ? 'claude' : codex ? 'codex' : null
    const body = claude || codex
    writeFileSync(
      INSTRUCTIONS,
      body
        ? `${body}\n`
        : '# How I work\n\nWrite here what every agent should know about you and how you like to work. Ember hands it to all of them.\n',
      'utf8'
    )
    state.instructionsFrom = from
  }
  importClaudeMemory()
  copyMissing(join(HOME, '.claude', 'skills'), SKILLS)
  if (!existsSync(INDEX)) writeIndex()
  state.importedAt ??= new Date().toISOString()
  writeState(state)
}

// ---------------------------------------------------------------- sync to each agent

/** Each agent's global instructions file, and whether it is present on this machine. */
function targets(): Array<{ agent: string; file: string; present: boolean }> {
  const t = (agent: string, dir: string, name: string) => ({ agent, file: join(dir, name), present: existsSync(dir) })
  return [
    t('claude', join(HOME, '.claude'), 'CLAUDE.md'),
    t('codex', join(HOME, '.codex'), 'AGENTS.md'),
    t('gemini', join(HOME, '.gemini'), 'GEMINI.md'),
    t('qwen', join(HOME, '.qwen'), 'QWEN.md'),
    t('opencode', join(HOME, '.config', 'opencode'), 'AGENTS.md'),
  ]
}

const MEMORY_PROTOCOL = [
  '## Shared memory (Ember)',
  '',
  "You share one long-term memory with the user's other coding agents, kept by Ember.",
  '- At the start of a task, recall what is known about it: the Ember tool `recall` (query = the topic), or read',
  `  ${INDEX.replace(HOME, '~')} and the files it lists.`,
  '- When you learn something durable — about the user, their projects, decisions, preferences — save it with',
  '  `remember` (one fact per call), or write a markdown file with name/description frontmatter in that folder.',
  `- Shared skills: the Ember tool \`skills\`, or ${SKILLS.replace(HOME, '~')}.`,
].join('\n')

/**
 * Where things are shown, when the agent runs inside Ember. In a global instructions file,
 * because that is the only text an agent weighs as heavily as its own tools' descriptions:
 * Claude Code also carries the claude.ai Artifact tool, which asks to publish every
 * dashboard as a page, and the canvas tools' MCP instructions alone lost to it ("show me
 * a mission control" opened a browser). Worded to apply only inside Ember, since the same
 * file is read in every other terminal too.
 */
const CANVAS_PROTOCOL = [
  '## Showing things (Ember)',
  '',
  "When you are running inside Ember (Ember's tools such as `show_view` and `show_panel` are available to you),",
  "Ember's canvas is where you show things. A request to show, visualize or lay out anything — a dashboard, a",
  'mission control, a plan, a board, a chart, a diagram, a table, a mockup, a page, a report — goes on the canvas',
  'with those tools: `show_view` for data (stats, kanban, table, timeline, charts), `show_panel` for a diagram,',
  'markdown or a small html page, `show_steps` for a plan, `show_file` for a file. Do not publish it as a claude.ai',
  'Artifact, write an HTML file and open it in a browser, or use another app, unless the user asks for that by',
  'name. Outside Ember, this section does not apply.',
].join('\n')

function block(agent: string, from: BrainState['instructionsFrom']): string {
  const parts = [START, '']
  // Claude reads imports; everything else gets the text itself. The agent the instructions
  // were seeded from already has them in its own file.
  if (agent !== from) parts.push(agent === 'claude' ? `@${INSTRUCTIONS.replace(HOME, '~').split(sep).join('/')}` : read(INSTRUCTIONS).trim(), '')
  parts.push(MEMORY_PROTOCOL, '', CANVAS_PROTOCOL, '', END)
  return parts.join('\n')
}

function writeBlock(file: string, text: string): boolean {
  const old = read(file)
  if (old && !existsSync(`${file}.ember-backup`)) writeFileSync(`${file}.ember-backup`, old, 'utf8')
  const a = old.indexOf(START)
  const b = old.indexOf(END)
  const next = a >= 0 && b > a ? old.slice(0, a) + text + old.slice(b + END.length) : `${old.trimEnd()}${old.trim() ? '\n\n' : ''}${text}\n`
  if (next === old) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, next, 'utf8')
  return true
}

export interface BrainStatus {
  dir: string
  facts: number
  skills: number
  instructionsFrom: string | null
  syncedAt: string | null
  agents: Array<{ agent: string; file: string; present: boolean; synced: boolean; skills: number | null }>
}

export function brainStatus(): BrainStatus {
  const state = readState()
  const total = skillDirs(SKILLS).length
  const skillsAt: Record<string, string> = { claude: join(HOME, '.claude', 'skills'), codex: join(HOME, '.codex', 'skills') }
  return {
    dir: BRAIN_DIR,
    facts: facts().length,
    skills: total,
    instructionsFrom: state.instructionsFrom ?? null,
    syncedAt: state.syncedAt ?? null,
    agents: targets().map((t) => ({
      agent: t.agent,
      file: t.file,
      present: t.present,
      synced: read(t.file).includes(START),
      skills: skillsAt[t.agent] ? skillDirs(SKILLS).filter((s) => existsSync(join(skillsAt[t.agent]!, s))).length : null,
    })),
  }
}

/** Seed if new, take in Claude's latest memory, and hand everything to every agent present. */
export function syncBrain(): BrainStatus {
  seed()
  const state = readState()
  for (const t of targets()) if (t.present) writeBlock(t.file, block(t.agent, state.instructionsFrom))
  if (existsSync(join(HOME, '.codex'))) copyMissing(SKILLS, join(HOME, '.codex', 'skills'))
  if (existsSync(join(HOME, '.claude'))) copyMissing(SKILLS, join(HOME, '.claude', 'skills'))
  state.syncedAt = new Date().toISOString()
  writeState(state)
  return brainStatus()
}

export function registerBrain(): void {
  ipcMain.handle('ember:brain:status', () => brainStatus())
  ipcMain.handle('ember:brain:sync', () => syncBrain())
  // On by default: the point is that it needs no setup. Settings › Agent turns it off.
  const run = () => {
    if (loadConfig().brain?.sync === false) return
    try {
      syncBrain()
    } catch (err) {
      console.warn('[ember] brain sync failed', err)
    }
  }
  setTimeout(run, 4000)
  // Claude keeps writing its own memory; take it in every quarter hour.
  setInterval(run, 15 * 60_000)
}
