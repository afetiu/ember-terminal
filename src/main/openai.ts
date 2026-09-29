import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'

/**
 * The OpenAI key, and the ephemeral secret minted in front of it.
 *
 * Same shape as `azure.ts`, for the same reason: the real key lives in
 * `~/.ember/secrets.json` and never leaves this process. What the realtime page gets is
 * a client secret from `/v1/realtime/client_secrets`, scoped to one realtime session and
 * good for a couple of minutes — so a web context that goes wrong costs one conversation,
 * not a key that can be billed against until someone notices.
 *
 * The endpoint is worth pinning down in a comment, because the obvious one is wrong now.
 * `POST /v1/realtime/sessions` — the shape most code and most training data still carries —
 * 404s, and `POST /v1/realtime?model=…` answers with "The Realtime Beta API is no longer
 * supported. Please use /v1/realtime/calls for the GA API." Both were checked against the
 * live API rather than recalled. The GA pair is:
 *
 *   mint      POST /v1/realtime/client_secrets   { session: { type, model, … } }  -> { value: "ek_…" }
 *   connect   POST /v1/realtime/calls?model=…    SDP offer, Bearer ek_…           -> SDP answer
 */

const SECRETS_PATH = join(CONFIG_DIR, 'secrets.json')

interface Secrets {
  openai?: { key?: string }
  anthropic?: { key?: string }
}

/** Which provider a settings field is talking about. */
export type SecretProvider = 'openai' | 'anthropic'

function read(): Secrets {
  try {
    if (!existsSync(SECRETS_PATH)) return {}
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as Secrets
  } catch (err) {
    console.error(`[ember] could not read ${SECRETS_PATH}: ${(err as Error).message}`)
    return {}
  }
}

export function openaiConfigured(): boolean {
  return !!read().openai?.key
}

/**
 * The last four characters of the stored key, or ''.
 *
 * Enough to tell two keys apart when you are looking at the settings panel wondering
 * which account is being billed; useless to anything that gets hold of it. The whole
 * key never goes to the renderer — see `setOpenaiKey` for the other half of that rule.
 */
export function openaiKeyHint(): string {
  return keyHint('openai')
}

export function keyConfigured(provider: SecretProvider): boolean {
  return !!read()[provider]?.key
}

export function keyHint(provider: SecretProvider): string {
  const key = read()[provider]?.key ?? ''
  return key ? key.slice(-4) : ''
}

/**
 * Store or clear any provider's key.
 *
 * One function for both because they are the same secret in the same file with the same
 * rules — the OpenAI key buys the voice, the Anthropic key buys the thinking, and a
 * machine with one and not the other is half a working orchestrator either way.
 */
export function setProviderKey(provider: SecretProvider, key: string): boolean {
  const trimmed = key.trim()
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    const secrets = read()
    if (trimmed) secrets[provider] = { ...secrets[provider], key: trimmed }
    else delete secrets[provider]
    writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (err) {
    console.error(`[ember] could not write ${SECRETS_PATH}: ${(err as Error).message}`)
    return false
  }
}

/**
 * Store the account key, or clear it when given an empty string.
 *
 * This exists so a fresh install can be finished from inside the app. Before it, the
 * only way to get a key onto a machine was to hand-place `secrets.json`, which meant
 * copying a live credential between computers — the orchestrator and the realtime call
 * both just stayed silent until someone did.
 *
 * Reads and rewrites the whole file rather than overwriting it: `azureSpeech` and
 * anything added later share it, and clobbering a sibling key to save a parse would be
 * a poor trade. Written 0600 — no-op on Windows in practice, correct everywhere else,
 * and free.
 */
export function setOpenaiKey(key: string): boolean {
  const trimmed = key.trim()
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    const secrets = read()
    if (trimmed) secrets.openai = { ...secrets.openai, key: trimmed }
    else delete secrets.openai
    writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (err) {
    console.error(`[ember] could not write ${SECRETS_PATH}: ${(err as Error).message}`)
    return false
  }
}

export interface RealtimeAuth {
  ok: boolean
  /** The ephemeral client secret, `ek_…`. Never the account key. */
  secret?: string
  model?: string
  /** Where the page POSTs its SDP offer. Carried so the page hardcodes nothing. */
  callsUrl?: string
  expiresAt?: number
  error?: string
}

/**
 * The voice's own brief, sent as the session's instructions.
 *
 * Terse on purpose, and the terseness is the feature the user asked for by name. The first
 * version told it to be "warm, direct, unhurried" and to cover slow tools with a holding
 * line; what came out was a colleague who restated the plan before doing it, again while
 * doing it, and again afterwards. Three turns, one fact.
 *
 * So the brief now spends most of its length on what NOT to say. That is deliberate: a
 * speech model's default register is padded, and trimming it takes more words than
 * describing the job does. The banned-openers list is explicit rather than a general plea
 * for brevity because "be brief" is advice and "never start with okay, got it, sure" is a
 * rule — and only one of those survives contact with a model mid-conversation.
 *
 * The SAY IT ONCE section pairs with the response gating in `resources/realtime/rtc.js`.
 * Neither fixes the repetition alone: the code stops us *asking* for several replies to
 * one request, and this stops the model padding the reply it does give.
 */
export const INSTRUCTIONS = [
  'You are Ember’s voice, talking with the person at this computer.\n\n',

  'WHAT YOU ARE. You are the ears and the mouth. The thinking happens somewhere else — ',
  '`consult` reaches Claude, which has the user’s memory, his repositories, his notes and the ',
  'live state of his machine. You have none of that. You are extremely good at hearing him ',
  'and at speaking, and you know nothing whatsoever about his work.\n\n',

  'So: every question goes to `consult`, first, before you say anything of substance. It ',
  'comes back in about a second — no holding line, no "let me look into that". Then say ',
  'what it said, in your own mouth, conversationally. Do not add to it, do not soften it, ',
  'and do not correct it with something you think you know; you do not know.\n\n',

  'The one thing you handle yourself is social noise — "hey", "thanks", "hold on", "never ',
  'mind", "say that again". Answer those instantly and do not consult. Everything else, ',
  'including anything that sounds simple, goes to `consult`. A question that sounds simple ',
  'to you sounds simple because you cannot see what it depends on.\n\n',

  'HOW YOU TALK. Short. Say the thing, then stop.\n',
  '- One or two sentences. Never a paragraph. If it needs more, give the headline and let ',
  'him ask.\n',
  '- No preamble. Never open with "okay", "got it", "sure", "right", "perfect", ',
  '"understood", "let me", "I’ll go ahead and". Start with the content.\n',
  '- Never repeat his request back to him. He knows what he said.\n',
  '- No offers he did not ask for. Never "if you want, I can also…", never "let me know if".\n',
  '- No hedging, no filler, no enthusiasm. Plain and flat is correct.\n',
  '- Concrete over vague: names, ids, numbers, states. "Two sessions. g1 idle, g2 on the ',
  'migration." not "there are a couple of things running".\n',
  '- Speech, so: contractions, no markdown, no emoji, no lists read aloud, no file paths ',
  'or code spoken character by character.\n\n',

  'SAY IT ONCE. One request gets one answer. You often need several tools to serve it — ',
  'that is one request, not several. Do not narrate between tools, do not say what you are ',
  'about to do and then say you did it, and never restate a fact already said in this ',
  'conversation. If you have said a session is running, it stays said.\n\n',

  'YOUR ROLE. You do not know things and you do not do work. You run a crew of Claude ',
  'sessions that do both — each has the user’s real context: his projects, files, notes and ',
  'memory, and can read and change things on his machine. You track them, decide who does ',
  'what, and report. Never answer a substantive question from your own knowledge and never ',
  'guess at his projects.\n\n',

  'WAIT OR DON’T. The judgement that matters. If he is waiting to hear the answer, ',
  'ask_claude and wait. If it is work — a refactor, an investigation, a build, a piece of ',
  'writing — send_work or start_session, say what you set going in one clause, and move on. ',
  'When in doubt, hand it off. He can ask how it is going.\n\n',

  'Before dispatching, list_sessions and place the work properly: reuse an idle session, ',
  'never pile a second task onto a busy one, open a new one when all are busy or the work ',
  'belongs in another project. Brief them in full — they cannot hear this conversation, so ',
  'spell out the goal and the constraints. Never write "the thing we discussed".\n\n',

  'Before ask_claude specifically — and only that one, because it is the one that leaves ',
  'the line silent — say one short clause first: "one sec", "let me check". Once, not ',
  'before every tool. Never name a tool, never narrate mechanism, never announce that you ',
  'are checking or searching.\n\n',

  'You are told when a session finishes, sometimes mid-conversation. Say the outcome in a ',
  'sentence when there is a gap. Not the transcript, not the steps.\n\n',

  'Reporting what a session said: outcome first, in your own words. Cut what only works on ',
  'a page. If it is long, give the one-line version and stop.\n\n',

  'Small talk, acknowledgements and clarifying questions: handle yourself, immediately, no ',
  'tool. If he interrupts, stop talking. If a request is genuinely ambiguous, ask — one ',
  'question, not a menu.',
].join('')

/**
 * The one tool the voice has.
 *
 * Deliberately singular and deliberately vague about mechanism. The realtime model does
 * not need to know that "Claude" is a CLI in a pty, that there is a transcript being
 * tailed, or that any of this is happening in a terminal — it needs to know that there is
 * somewhere smarter to send a hard question.
 */
export const ORCHESTRATOR_TOOLS = [
  {
    type: 'function',
    name: 'consult',
    description:
      'Put the user’s words to the orchestrator and say what comes back. This is Claude, with ' +
      'his memory, his repositories and his machine in front of it — it knows what you do ' +
      'not, which is everything. Use it for every question, every request, every remark ' +
      'that is not pure social noise, and use it FIRST. It answers in about a second; you ' +
      'do not need a holding line. You are not permitted to answer a question about the user, ' +
      'his work, his code, his projects or his machine from your own knowledge, because ' +
      'you have none of it and what you would produce is a guess.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'What he said, as he said it. Resolve pronouns from earlier in the call and ' +
            'otherwise do not rewrite him — the orchestrator reads the actual question ' +
            'better than your summary of it.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'ask_claude',
    description:
      'Ask a Claude session and WAIT for the answer. It has the user’s real context: his ' +
      'repositories, files, notes and memory, and it can read and run things on his machine. ' +
      'Use this when the user is waiting to hear the answer — a question, a decision, a look at ' +
      'something. It is slow, so say a short holding line before you call it. For work he is ' +
      'not waiting on, use send_work instead and keep talking.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The question, self-contained. Resolve pronouns and carry over what was said ' +
            'earlier in the call — the session has no memory of this conversation.',
        },
        session: {
          type: 'string',
          description:
            'Which session to ask, from list_sessions. Omit for the one the user is looking at.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_sessions',
    description:
      'What every Claude session on this machine is doing right now — which are working, ' +
      'which are idle, which want the user’s attention, what each was last asked to do, and how ' +
      'long it has been at it. Fast; call it freely. Call it before dispatching work so you ' +
      'reuse an idle session instead of piling onto a busy one, and whenever the user asks what ' +
      'is going on.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'send_work',
    description:
      'Hand a task to a session and DO NOT wait. Returns immediately so you can carry on ' +
      'talking; the session works in the background and you will be told when it finishes. ' +
      'This is the right tool for anything the user is not sitting waiting on — a refactor, a ' +
      'build, an investigation, a piece of writing. Brief it properly: the session cannot ' +
      'hear the conversation, so spell out the goal, the constraints and where to work.',
    parameters: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Which session, from list_sessions. Prefer an idle one.',
        },
        task: {
          type: 'string',
          description:
            'The whole brief in plain English, self-contained. State the goal and any ' +
            'constraint that matters. Do not say "as we discussed" — it was not there.',
        },
      },
      required: ['session', 'task'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'start_session',
    description:
      'Open a new terminal tab, start Claude in it, and give it a task. Returns immediately ' +
      'with the session id; starting up takes a few seconds and the task is sent as soon as ' +
      'it is ready, then you are told. Use this when every existing session is busy, or when ' +
      'the work belongs in a different project directory. Do not open one per question — ' +
      'reuse idle sessions.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The brief for the new session, self-contained. Optional; omit to just open one.',
        },
        directory: {
          type: 'string',
          description:
            'Absolute path, or a folder name under the user’s home like "my-app" or "api". ' +
            'Omit for his home directory. Get names from list_projects.',
        },
        name: { type: 'string', description: 'Short label for the tab, so he can find it.' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'check_work',
    description:
      'What a session has said since you last looked, and whether it has finished. Use it ' +
      'when the user asks how something is going, or before reporting on work you dispatched. ' +
      'You are told automatically when a session finishes, so do not poll this in a loop.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Which session, from list_sessions.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_projects',
    description:
      'The user’s project directories, for choosing where a new session should work. Use it when ' +
      'he names a project and you need the real folder.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'close_session',
    description:
      'Close a session and end its shell. Use it to tidy up after work is finished, or when ' +
      'The user asks. It throws away anything unsaved in that tab and cannot be undone, so prefer ' +
      'leaving an idle session open to closing one you are unsure about. It refuses on a ' +
      'session that is still working unless you pass force, and it refuses on the last ' +
      'remaining session, because closing that one shuts Ember down.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Which session, from list_sessions.' },
        force: {
          type: 'boolean',
          description:
            'Close it even though it is working. Only when the user has said to — it kills ' +
            'whatever that session is in the middle of.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'show_session',
    description:
      'Bring a session on screen, so the user can see what you are talking about. Use it when he ' +
      'asks to see something, or when you are reporting on work and it would help him look.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Which session, from list_sessions.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
]

/**
 * Mint a client secret for one realtime session.
 *
 * The session's whole configuration — instructions, tools, voice, turn detection — is
 * baked into the secret here rather than sent from the page over the data channel. That
 * is on purpose: the page is a web context, and a page that could rewrite the tool list
 * or the system instructions would be a page that could point the voice at something
 * else. It receives a session it cannot renegotiate.
 */
export async function realtimeSecret(voice: string, model: string): Promise<RealtimeAuth> {
  const key = read().openai?.key
  if (!key) return { ok: false, error: `no OpenAI key — add one to ${SECRETS_PATH}` }

  try {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model,
          instructions: INSTRUCTIONS,
          tools: ORCHESTRATOR_TOOLS,
          tool_choice: 'auto',
          // A backstop against a monologue, not the brevity mechanism — INSTRUCTIONS does
          // that work. Output audio runs around 60 tokens a second, so this is about
          // fifteen seconds of speech: far past the one or two sentences being asked for,
          // and short of the paragraph nobody wants to sit through. Deliberately not
          // tighter, because a reply cut off mid-word is worse than a long one.
          max_output_tokens: 900,
          audio: {
            input: {
              // Server-side turn detection is most of why this feels like a call rather
              // than a walkie-talkie: the model decides you have finished on the shape of
              // the audio, not on a fixed silence timer, and `interrupt_response` is what
              // lets the user talk over it mid-sentence.
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'medium',
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 401 here is the key; 400 is almost always the model name or a field this account
      // cannot use. Saying which is the difference between a minute and an afternoon.
      const why = res.status === 401 ? 'key rejected' : detail.slice(0, 240)
      return { ok: false, error: `OpenAI refused the session (${res.status}): ${why}` }
    }

    const body = (await res.json()) as { value?: string; expires_at?: number; session?: { model?: string } }
    if (!body.value) return { ok: false, error: 'OpenAI returned no client secret' }

    return {
      ok: true,
      secret: body.value,
      model: body.session?.model ?? model,
      callsUrl: 'https://api.openai.com/v1/realtime/calls',
      ...(body.expires_at ? { expiresAt: body.expires_at } : {}),
    }
  } catch (err) {
    return { ok: false, error: `could not reach OpenAI: ${(err as Error).message}` }
  }
}

export { SECRETS_PATH as OPENAI_SECRETS_PATH }
