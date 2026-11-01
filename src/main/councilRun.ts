import { AGENTS, type AgentId } from '../shared/agents.js'
import type { CouncilEvent, CouncilRequest } from '../shared/types.js'

/**
 * The council's order of play, with no Electron and no processes in it: who speaks when,
 * what each one is shown, and what the person sees. `council.ts` gives it a real way to
 * ask an agent; `scripts/probe-council.mjs` gives it a fake one.
 */

export interface AskResult {
  ok: boolean
  text: string
  error?: string
}

/** Ask one agent one thing, read-only, in `cwd`. Must settle soon after `signal` aborts. */
export type Ask = (agent: string, prompt: string, cwd: string, signal: AbortSignal) => Promise<AskResult>

export interface CouncilControl {
  signal: AbortSignal
  /** The person's note for the next round, taken (and cleared) as that round starts. */
  takeNote(): string | undefined
}

export function agentName(id: string): string {
  return AGENTS[id as AgentId]?.name ?? id
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function openingPrompt(question: string): string {
  return [
    'You are one member of a council of AI agents answering the same question. Do not edit any files.',
    '',
    `Question: ${question}`,
    '',
    'Give your position in under 200 words: your answer, your key reason, and the main risk. Plain prose, no headings.',
  ].join('\n')
}

export function debatePrompt(question: string, self: string, previous: Map<string, string>, note: string | undefined): string {
  const others = [...previous].map(([id, text]) => `${agentName(id)}${id === self ? ' (you)' : ''}:\n${text.trim()}`)
  return [
    `You are ${agentName(self)}, one member of a council of AI agents. Do not edit any files.`,
    '',
    `Question: ${question}`,
    '',
    "The council's last answers:",
    '',
    others.join('\n\n'),
    ...(note ? ['', `A note from the person who asked: ${note.trim()}`] : []),
    '',
    'Reply in under 150 words: where you agree, where you disagree and why, and your updated position.',
  ].join('\n')
}

export function conclusionPrompt(question: string, debate: Array<{ round: number; member: string; text: string }>, notes: string[]): string {
  const rounds = new Map<number, string[]>()
  for (const d of debate) {
    const r = rounds.get(d.round) ?? []
    r.push(`${agentName(d.member)}:\n${d.text.trim()}`)
    rounds.set(d.round, r)
  }
  const body = [...rounds].map(([r, lines]) => `## ${r === 0 ? 'Opening positions' : `Round ${r}`}\n\n${lines.join('\n\n')}`)
  return [
    'You chair a council of AI agents. Do not edit any files.',
    '',
    `Question: ${question}`,
    ...(notes.length ? ['', `Notes from the person who asked: ${notes.join(' / ')}`] : []),
    '',
    'The debate:',
    '',
    body.join('\n\n'),
    '',
    "Write the council's conclusion in under 250 words: what everyone agrees on, the real disagreements, and a clear recommendation.",
  ].join('\n')
}

/** Run one council to the end (or until stopped). Always emits `done` last. */
export async function runCouncil(req: CouncilRequest, ask: Ask, emit: (e: CouncilEvent) => void, ctl: CouncilControl): Promise<void> {
  const id = req.id
  const send = (e: Omit<CouncilEvent, 'id' | 'at'>) => {
    if (!ctl.signal.aborted) emit({ id, at: Date.now(), ...e })
  }
  const question = req.question.trim()
  const members = [...new Set(req.members)].filter(Boolean)
  const rounds = Math.max(0, Math.min(3, Math.floor(req.rounds || 0)))
  const debate: Array<{ round: number; member: string; text: string }> = []
  const notes: string[] = []
  let alive = members.slice()

  try {
    if (!question || !members.length) {
      send({ kind: 'error', text: !question ? 'Ask a question first.' : 'Pick at least one member.' })
      return
    }
    send({ kind: 'status', round: 0, text: `Asking ${list(members.map(agentName))}…` })

    let previous = new Map<string, string>()
    for (let round = 0; round <= rounds; round++) {
      if (ctl.signal.aborted) return
      if (!alive.length) {
        send({ kind: 'status', text: 'No members left to answer.' })
        break
      }
      const note = round === 0 ? undefined : ctl.takeNote()
      if (note) notes.push(note)
      if (round > 0) {
        if (alive.length < 2) {
          send({ kind: 'status', round, text: 'Only one member is left, so the debate ends here.' })
          break
        }
        send({ kind: 'status', round, text: `Round ${round} of ${rounds}${note ? ', with your note' : ''}…` })
      }
      const answers = new Map<string, string>()
      const failed: string[] = []
      await Promise.all(
        alive.map(async (member) => {
          const prompt = round === 0 ? openingPrompt(question) : debatePrompt(question, member, previous, note)
          const r = await ask(member, prompt, req.cwd, ctl.signal).catch((e: unknown) => ({ ok: false, text: '', error: String(e) }))
          if (ctl.signal.aborted) return
          if (r.ok && r.text.trim()) {
            answers.set(member, r.text.trim())
            debate.push({ round, member, text: r.text.trim() })
            send({ kind: 'speak', member, round, text: r.text.trim() })
          } else {
            failed.push(member)
            send({ kind: 'error', member, round, text: oneLine(r.error || 'answered with nothing') })
          }
        })
      )
      if (ctl.signal.aborted) return
      alive = alive.filter((m) => !failed.includes(m))
      // Keep speaking order stable, whatever order they finished in.
      previous = new Map(members.filter((m) => answers.has(m)).map((m) => [m, answers.get(m)!]))
    }

    if (!debate.length) {
      send({ kind: 'status', text: 'Nobody answered, so there is nothing to conclude.' })
      return
    }
    // The chair may have dropped out; the first member still standing takes over.
    const chair = members.includes(req.chair) && alive.includes(req.chair) ? req.chair : alive[0] ?? req.chair
    send({ kind: 'status', round: -1, member: chair, text: `${agentName(chair)} is writing the conclusion…` })
    const r = await ask(chair, conclusionPrompt(question, debate, notes), req.cwd, ctl.signal).catch(
      (e: unknown): AskResult => ({ ok: false, text: '', error: String(e) })
    )
    if (ctl.signal.aborted) return
    if (r.ok && r.text.trim()) send({ kind: 'conclusion', member: chair, round: -1, text: r.text.trim() })
    else send({ kind: 'error', member: chair, round: -1, text: `No conclusion: ${oneLine(r.error || 'answered with nothing')}` })
  } finally {
    const stopped = ctl.signal.aborted
    if (stopped) emit({ id, at: Date.now(), kind: 'status', text: 'Stopped.' })
    emit({ id, at: Date.now(), kind: 'done', text: stopped ? 'stopped' : 'finished' })
  }
}
