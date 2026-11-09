/**
 * Ember turns: a main request and its follow-ups.
 *
 * Not every prompt is a new chat. "yes do it", "/model", "try again", "and the other one?",
 * an answer to the questions the reply asked: each carries on the turn on screen, and the
 * canvas shows it inside that turn (one point on the rail) rather than as a turn of its own.
 *
 * Deterministic and cheap: the prompt's words and the transcript's timestamps only, so a
 * live session and the same transcript reloaded group the same way. No model call.
 */

/** What a prompt is, as the transcript says. */
export type PromptKind = 'prompt' | 'command' | 'shell'

/** The turn on screen, as far as grouping cares. */
export interface TurnState {
  /** When its main request was sent (ms; NaN when unknown). */
  askAt: number
  /** When anything last happened in it: the reply, a step, a follow-up (ms; NaN when unknown). */
  lastAt: number
  /** The text of the last prompt in it. */
  prompt: string
  /** It ended interrupted ("[Request interrupted by user]"). */
  interrupted: boolean
  /** Its last reply asked questions (the canvas put an answer card under it). */
  questions: boolean
}

export interface Grouping {
  join: boolean
  /** Why, for probes and support. */
  why: string
}

/** Short enough to be a follow-up by size alone, when sent soon after the reply. */
export const SHORT_WORDS = 12
export const SHORT_CHARS = 80
/** Longer than this is a request of its own (unless it answers questions or resends one). */
export const LONG_WORDS = 25
/** "Soon after the reply". */
export const SOON_MS = 3 * 60_000
/** A pause this long starts afresh, whatever is typed. */
export const PAUSE_MS = 20 * 60_000

/** Acknowledgements and go-aheads. */
const ACK =
  /^(?:y|ya|yes|yep|yeah|yup|ok|okay|k|kk|sure|fine|great|perfect|nice|cool|good|thanks|thank you|thx|ty|lgtm|looks good|sounds good|works|it works|correct|right|exactly|agreed|no|nope|nah|not quite|wrong|go|go ahead|go on|do it|do that|do both|proceed|continue|keep going|carry on|again|try again|retry|once more|one more time|please do|yes please|ship it|commit|push|commit and push|merge|done|same|same here|neither|both|all of them|all|none)\b/i
/** Openers that lean on what came before. */
const CONT =
  /^(?:and|also|plus|now|then|next|but|instead|actually|same for|same with|same thing|what about|how about|and the|make it|make them|make that|fix it|fix that|fix this|fix them|undo|revert|change it|change that|why|wait|hmm+|hm+|oh|ah|again|still|it still|it's still|its still|that's|thats|this|that|these|those|the other|the same|one more|another one|not that|not this|rather|or)\b/i
/** A pick from options: "B", "2", "1. B; 2. A", "option 3", "a and c". */
const PICK = /^(?:(?:option|choice|#)\s*)?\d{1,2}[.):]?(?:\s*[a-h])?(?:\s*(?:[,;&/]|and|or)\s*(?:(?:option|choice|#)\s*)?(?:\d{1,2}[.):]?(?:\s*[a-h])?|[a-h]))*$|^[a-h](?:\s*(?:[,;&/]|and|or)\s*[a-h])*$/i
const NUMBERED = /^\s*\d+[.)]\s*\S.*(?:[;\n]\s*\d+[.)]\s*\S.*)+$/s
/** A plain reference: "this", "that one", "the second". */
const REF = /^(?:this|that|this one|that one|these|those|the (?:first|second|third|last|other|same) ?(?:one)?|it)$/i
/** Saying outright that this is something else. */
const NEW_TOPIC =
  /^(?:new (?:task|topic|question|thing|request)|next task|unrelated|different (?:topic|question|thing|task)|switch(?:ing)? to|let'?s (?:move on|switch|start|work on|build|look at)|moving on|another (?:task|question|topic)|separate (?:task|question)|fresh start|forget (?:that|this|it|the above))\b/i

function words(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** Word overlap of two prompts (0..1): a resent prompt is mostly the same words. */
export function likeness(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const B = new Set(b.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / Math.max(A.size, B.size)
}

/**
 * Does this prompt join the turn on screen? `state` null: there is no turn to join (the
 * first prompt, after `/clear`, after a compaction or a new session).
 */
export function joinsTurn(text: string, at: number, kind: PromptKind, state: TurnState | null): Grouping {
  if (!state) return { join: false, why: 'no turn' }
  // The CLI's own business, and `!` shell commands: part of what you were doing.
  if (kind === 'command') return { join: true, why: 'command' }
  if (kind === 'shell') return { join: true, why: 'shell' }
  const t = text.trim()
  const n = words(t)
  const last = Number.isFinite(state.lastAt) ? state.lastAt : state.askAt
  const gap = Number.isFinite(at) && Number.isFinite(last) ? Math.max(0, at - last) : NaN
  const known = !Number.isNaN(gap)
  if (NEW_TOPIC.test(t)) return { join: false, why: 'new topic' }
  // Picking up an interrupted request: the same words again, or a correction soon after.
  if (state.interrupted) {
    if (likeness(t, state.prompt) >= 0.6) return { join: true, why: 'resent' }
    if (n <= 60 && (!known || gap < 5 * 60_000)) return { join: true, why: 'after interrupt' }
  }
  // Answers to the questions the reply asked.
  if (state.questions && n <= 60 && (!known || gap < 60 * 60_000)) return { join: true, why: 'answers' }
  if (known && gap > PAUSE_MS) return { join: false, why: 'pause' }
  if (n > LONG_WORDS) return { join: false, why: 'long' }
  const bare = t.replace(/[\s.!?…]+$/, '')
  if (n <= SHORT_WORDS && (ACK.test(bare) || PICK.test(bare) || REF.test(bare))) return { join: true, why: 'ack' }
  if (NUMBERED.test(t)) return { join: true, why: 'picks' }
  if (CONT.test(bare)) return { join: true, why: 'continues' }
  if (n <= SHORT_WORDS && t.length <= SHORT_CHARS && known && gap < SOON_MS) return { join: true, why: 'short and soon' }
  return { join: false, why: 'new request' }
}

/** One step of a conversation, for grouping a whole transcript (and the tests). */
export type Step =
  | { kind: PromptKind; text: string; at: number }
  | { kind: 'reply'; at: number; questions?: boolean }
  | { kind: 'interrupt'; at: number }
  | { kind: 'clear' }

/** The turn each prompt lands in (0-based, in order), as the canvas groups them. */
export function groupSteps(steps: Step[]): number[] {
  const out: number[] = []
  let state: TurnState | null = null
  let turn = -1
  for (const s of steps) {
    if (s.kind === 'clear') {
      state = null
      continue
    }
    if (s.kind === 'reply' || s.kind === 'interrupt') {
      if (!state) continue
      state.lastAt = s.at
      if (s.kind === 'interrupt') state.interrupted = true
      else {
        state.interrupted = false
        state.questions = !!s.questions
      }
      continue
    }
    const g = joinsTurn(s.text, s.at, s.kind, state)
    if (!g.join || !state) {
      turn++
      state = { askAt: s.at, lastAt: s.at, prompt: s.text, interrupted: false, questions: false }
    } else {
      state.lastAt = s.at
      if (s.kind === 'prompt') {
        state.prompt = s.text
        state.interrupted = false
        state.questions = false
      }
    }
    out.push(turn)
  }
  return out
}
