/**
 * The name a tab running an agent shows: the session's own name, whatever started it — a new
 * session, one resumed, one renamed.
 *
 *   1. the name you gave it (`/rename`, Codex's thread name, Claude Code's hooks)
 *   2. the title the agent gave it by itself (Claude Code's `ai-title`, what `/resume` lists)
 *   3. the terminal title the agent sets, when it says more than the agent's own name
 *      (Cursor, Gemini and the rest, whose logs Ember doesn't read for a name)
 *   4. the first thing you asked in it
 *
 * '' when there is none yet: the card then says "agent · folder".
 */
export interface NameSources {
  named: string
  ai: string
  terminal: string
  first: string
  /** The agent's display name ("Claude Code", "Codex"). */
  agent: string
  folder: string
  /** Whether a title names an agent CLI (shared/agents.ts agentFromTitle). */
  isAgent?: (title: string) => boolean
}

const MAX = 48

export function sessionName(s: NameSources): string {
  const named = s.named.trim()
  if (named) return named
  const ai = s.ai.trim()
  if (ai) return ai
  const term = terminalName(s.terminal, s.agent, s.folder, s.isAgent)
  if (term) return term
  return firstPrompt(s.first)
}

/** A terminal title worth showing: not the agent's name, a path, a shell or a spinner alone. */
export function terminalName(raw: string, agent: string, folder: string, isAgent: (title: string) => boolean = () => false): string {
  // Spinners and status marks agents put in front ("✳ ", "⠋ ", "● ").
  const t = raw
    .replace(/^Administrator:\s*/i, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length < 3) return ''
  const low = t.toLowerCase()
  if (low === agent.toLowerCase() || low === `${agent} cli`.toLowerCase()) return ''
  // Just the agent's name with a folder, a version or a mode ("codex", "cursor-agent ~/repo").
  if (isAgent(t) && t.split(' ').length <= 3) return ''
  if (/[\\/]/.test(t) || /\.(exe|cmd|bat|ps1)$/i.test(t)) return ''
  if (/^(pwsh|powershell|cmd|bash|zsh|sh|node|npm|npx|windows powershell)(\b|$)/i.test(t)) return ''
  const base = folder.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (base && low === base.toLowerCase()) return ''
  return clip(t)
}

/** The first prompt as a name: its first line, without tags or a pasted path, cut at a word. */
export function firstPrompt(text: string): string {
  const line =
    text
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  return clip(line.replace(/\s+/g, ' '))
}

function clip(t: string): string {
  if (t.length <= MAX) return t
  const cut = t.slice(0, MAX)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`
}
