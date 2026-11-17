/**
 * What the agent is doing, in plain words — for the live status on the canvas, so you can
 * follow the work without opening the CLI. Every step the agent takes falls into a stage
 * ("Reading the code", "Building", "Testing", "Researching online"...) and gets one sentence
 * of what exactly ("Running the tests", "Searching the web for “codex thread names”").
 *
 * Pure and deterministic: the tool's name and input only.
 */

export type PhaseKey =
  | 'think'
  | 'read'
  | 'search'
  | 'web'
  | 'edit'
  | 'build'
  | 'test'
  | 'check'
  | 'run'
  | 'install'
  | 'save'
  | 'ship'
  | 'helpers'
  | 'plan'
  | 'canvas'
  | 'browser'
  | 'ready'
  | 'app'
  | 'wait'

/** The stage, as the headline says it. */
export const PHASE_LABEL: Record<PhaseKey, string> = {
  think: 'Thinking it through',
  read: 'Reading the code',
  search: 'Looking through the project',
  web: 'Researching online',
  edit: 'Making changes',
  build: 'Building',
  test: 'Testing',
  check: 'Checking the result',
  run: 'Running a command',
  install: 'Installing what it needs',
  save: 'Saving the work',
  ship: 'Publishing',
  helpers: 'Working with helpers',
  plan: 'Planning the steps',
  canvas: 'Putting it on your canvas',
  browser: 'Using the browser',
  ready: 'Getting ready',
  app: 'Using your apps',
  wait: 'Waiting for you',
}

export interface Step {
  phase: PhaseKey
  /** One plain sentence: what exactly. */
  what: string
  /** The app it used, for `app` ("Gmail", "Google Drive"). */
  app?: string
  /** The file it touched, for counting distinct files. */
  file?: string
}

type Json = Record<string, unknown>

function base(p: unknown): string {
  return String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** A shell command's stage, from the command and the agent's own description of it. */
export function shellPhase(command: string, description = ''): PhaseKey {
  const c = command.toLowerCase()
  const d = description.toLowerCase()
  const both = `${d}\n${c}`
  if (/\b(git\s+push\b.*--tags|git\s+push\s+\S+\s+v\d|deploy|release|publish|wrangler|heroku\s+(releases|container)|gh\s+release|vercel|netlify)\b/.test(both) && !/\b(status|view|list|log)\b/.test(d)) return 'ship'
  if (/\bgit\s+(commit|push|tag|merge|rebase)\b/.test(c) || /\b(commit|push)\b/.test(d)) return 'save'
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bpoetry\s+(add|install)\b|\bcargo\s+add\b|\bgo\s+get\b|\bapt(-get)?\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bdotnet\s+add\b/.test(c) || /\binstall\b/.test(d)) return 'install'
  if (/\b(test|tests|spec|jest|vitest|pytest|mocha|playwright\s+test|cargo\s+test|go\s+test|dotnet\s+test|--test)\b|\bprobe/.test(both)) return 'test'
  if (/\b(screenshot|lighthouse|curl|wget|invoke-webrequest|ping)\b/.test(both) || /\b(check|verify|confirm)\b/.test(d)) return 'check'
  if (/\b(build|compile|typecheck|tsc|webpack|vite\s+build|esbuild|rollup|cargo\s+build|go\s+build|make\b|gradle|mvn|dotnet\s+build|lint|eslint|prettier|format)\b/.test(both)) return 'build'
  if (/^\s*(ls|dir|cat|head|tail|sed\s+-n|grep|rg|find|wc|tree|type|get-content|get-childitem|select-string)\b/.test(c) || /\bgit\s+(status|log|diff|show|branch|blame)\b/.test(c) || /\b(list|show|read|look|find|search|inspect|view)\b/.test(d)) return 'read'
  return 'run'
}

const SHELL_WHAT: Partial<Record<PhaseKey, string>> = {
  ship: 'Publishing a new version',
  save: 'Saving the changes',
  install: 'Installing what it needs',
  test: 'Running the tests',
  check: 'Checking that it works',
  build: 'Building the project',
  read: 'Looking at the project',
  run: 'Running a command',
}

/** Friendly names for the apps behind MCP servers. */
const APPS: Array<[RegExp, string]> = [
  [/gmail/i, 'Gmail'],
  [/google[_ -]?drive|gdrive/i, 'Google Drive'],
  [/calendar/i, 'your calendar'],
  [/slack/i, 'Slack'],
  [/notion/i, 'Notion'],
  [/linear/i, 'Linear'],
  [/github/i, 'GitHub'],
  [/figma/i, 'Figma'],
  [/atlassian|jira|confluence/i, 'Jira'],
  [/outlook|ms-365|microsoft/i, 'Outlook'],
  [/cloudflare/i, 'Cloudflare'],
  [/play[-_ ]?store/i, 'the Play Store'],
  [/godaddy/i, 'GoDaddy'],
  [/docs/i, 'your docs'],
]

/** One tool call, as a stage and a sentence. */
export function classifyStep(name: string, input: Json): Step {
  const s = (k: string) => String(input[k] ?? '').trim()
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const f = base(input['file_path'] ?? input['notebook_path'])
      return { phase: 'read', what: f ? `Reading ${f}` : 'Reading a file', file: f }
    }
    case 'Grep':
      return { phase: 'search', what: s('pattern') ? `Searching the project for “${clip(s('pattern'), 40)}”` : 'Searching the project' }
    case 'Glob':
    case 'LS':
      return { phase: 'search', what: 'Finding the right files' }
    case 'WebSearch':
      return { phase: 'web', what: s('query') ? `Searching the web for “${clip(s('query'), 60)}”` : 'Searching the web' }
    case 'WebFetch': {
      let host = ''
      try {
        host = new URL(s('url')).host.replace(/^www\./, '')
      } catch {
        /* no url */
      }
      return { phase: 'web', what: host ? `Reading a page on ${host}` : 'Reading a page online' }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const f = base(input['file_path'] ?? input['notebook_path'])
      return { phase: 'edit', what: f ? `Changing ${f}` : 'Changing a file', file: f }
    }
    case 'Write': {
      const f = base(input['file_path'])
      return { phase: 'edit', what: f ? `Writing ${f}` : 'Writing a file', file: f }
    }
    case 'Bash':
    case 'PowerShell': {
      const desc = s('description')
      const phase = shellPhase(s('command'), desc)
      return { phase, what: desc ? cap(clip(desc, 90)) : SHELL_WHAT[phase]! }
    }
    case 'Task':
    case 'Agent':
      return { phase: 'helpers', what: s('description') ? `A helper is ${clip(s('description'), 70).replace(/^./, (c) => c.toLowerCase())}` : 'Handing part of the work to a helper' }
    case 'TodoWrite':
      return { phase: 'plan', what: 'Writing down the steps' }
    case 'ExitPlanMode':
      return { phase: 'wait', what: 'A plan is waiting for your approval below' }
    case 'AskUserQuestion':
      return { phase: 'wait', what: 'It has a question for you below' }
    case 'ToolSearch':
      return { phase: 'ready', what: 'Getting the tools it needs' }
    case 'Skill':
      return { phase: 'ready', what: s('skill') ? `Following the ${s('skill')} playbook` : 'Following a playbook' }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) {
    const server = mcp[1]!
    const tool = mcp[2]!.replace(/_/g, ' ')
    if (server === 'ember-panel') return { phase: 'canvas', what: 'Drawing it on your canvas' }
    if (/playwright|chrome|browser|puppeteer|computer/i.test(server)) {
      if (/screenshot|snapshot/i.test(tool)) return { phase: 'check', what: 'Looking at the page' }
      return { phase: 'browser', what: /navigate/i.test(tool) ? 'Opening a page' : `Using the browser: ${tool}` }
    }
    const app = APPS.find(([re]) => re.test(server))?.[1]
    if (app) return { phase: 'app', what: `Using ${app}: ${tool}`, app }
    return { phase: 'app', what: cap(tool), app: server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '').replace(/[-_]/g, ' ') }
  }
  return { phase: 'run', what: cap(name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()) }
}

/** What a turn has done so far, in plain words: "read 8 files · changed 3 · ran the tests twice". */
export class Progress {
  private files = { read: new Set<string>(), edit: new Set<string>() }
  private n: Partial<Record<PhaseKey, number>> = {}

  add(step: Step): void {
    if (step.file && (step.phase === 'read' || step.phase === 'edit')) this.files[step.phase].add(step.file)
    this.n[step.phase] = (this.n[step.phase] ?? 0) + 1
  }

  get empty(): boolean {
    return Object.keys(this.n).length === 0
  }

  summary(): string {
    const parts: string[] = []
    const times = (k: number) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`)
    const files = (k: number) => `${k} file${k === 1 ? '' : 's'}`
    const read = this.files.read.size
    if (read) parts.push(`read ${files(read)}`)
    if (this.n.search) parts.push(`searched the project ${times(this.n.search)}`)
    if (this.n.web) parts.push(`looked ${this.n.web === 1 ? 'one thing' : `${this.n.web} things`} up online`)
    const edit = this.files.edit.size
    if (edit) parts.push(`changed ${files(edit)}`)
    if (this.n.install) parts.push('installed what it needed')
    if (this.n.build) parts.push(`built ${times(this.n.build)}`)
    if (this.n.test) parts.push(`ran the tests ${times(this.n.test)}`)
    if (this.n.check) parts.push(`checked the result ${times(this.n.check)}`)
    if (this.n.run) parts.push(`ran ${this.n.run} command${this.n.run === 1 ? '' : 's'}`)
    if (this.n.helpers) parts.push(`used ${this.n.helpers} helper${this.n.helpers === 1 ? '' : 's'}`)
    if (this.n.save) parts.push('saved the changes')
    if (this.n.ship) parts.push('published')
    return parts.join(' · ')
  }
}

/** The agent's own words between steps, as one short line: its first sentence. */
export function firstSentence(text: string, max = 160): string {
  const t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  const m = /^(.+?[.!?:])(\s|$)/.exec(t)
  return clip(m ? m[1]!.replace(/:$/, '.') : t, max)
}

/** The elapsed time out of the agent's working line ("12s · ↓ 88 tokens" → "12s"). */
export function elapsed(detail: string): string {
  return /(\d+h\s*)?(\d+m\s*)?\d+s/.exec(detail)?.[0]?.replace(/\s+/g, ' ') ?? ''
}
