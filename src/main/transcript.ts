import { existsSync, statSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Reads what a Claude session in a tab is doing, for narration.
 *
 * Not from the terminal. The CLI is a full-screen TUI that redraws itself constantly,
 * so anything scraped off the grid is a race against the next repaint and arrives as
 * spinner frames and box-drawing characters. Claude Code already writes a clean,
 * structured record of the same session to `~/.claude/projects/<slug>/<id>.jsonl`, one
 * JSON object per line, appended as it goes. Tailing that gives assistant text and tool
 * calls exactly as they happen, with nothing to parse out.
 *
 * (This is also why the environment scrub matters: a session that inherits
 * CLAUDE_CODE_CHILD_SESSION writes no transcript at all, and narration would have
 * nothing to read.)
 *
 * Binding a tab to its file used to be guesswork, and was wrong in practice.
 *
 * The first version took the newest `.jsonl` under the tab's working directory. Run
 * several sessions from one directory — six transcripts in one project folder here, two
 * of them written inside the same second — and that picks whichever session wrote last.
 * The symptom is not silence but something worse: the tab on screen says nothing while
 * you hear another session's work read out, with nothing to indicate the two have been
 * crossed.
 *
 * Claude Code puts `CLAUDE_CODE_SESSION_ID` into the environment of every MCP server it
 * spawns, and the transcript is named after it. Ember already runs an MCP server in each
 * session for the panel, and that server already knows which tab it belongs to from
 * `EMBER_TAB_ID` — so it reports the pair and the binding becomes exact, with no hook to
 * install and no settings file to write over the user's own.
 *
 * The old heuristic survives for one case only: a session that was already running
 * before narration was switched on, where there is nothing better to go on.
 */

export interface TranscriptEvent {
  tabId: string
  /** What to say. Already shortened; the renderer speaks it verbatim. Empty on 'turn-end'. */
  text: string
  /**
   * 'turn-end' is not something to say — it is the moment the session stopped working
   * and handed the floor back. Narration ignores it; the voice loop waits for it, since
   * it is the only reliable "the answer is complete" signal in the transcript.
   */
  kind: 'assistant' | 'tool' | 'result' | 'turn-end' | 'usage'
  /** On 'assistant': the text as written, markdown and all, for a reader rather than a voice. */
  full?: string
  /** On 'tool': the call itself, for whoever wants more than the spoken line. */
  tool?: { name: string; input: Record<string, unknown> }
  /** On 'usage': the message's token counts. Repeated per content block; `msgId` dedupes. */
  usage?: TokenUsage
  msgId?: string
  /** When the line was written, from the transcript's own timestamp. */
  at?: number
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** How Claude Code names a working directory's transcript folder. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const PROJECTS = join(homedir(), '.claude', 'projects')

/** Tool calls, said the way a person would say them. */
function describeTool(name: string, input: Record<string, unknown>): string | null {
  const file = (p: unknown): string => String(p ?? '').split(/[/\\]/).pop() || String(p ?? '')
  switch (name) {
    case 'Read':
      return `Reading ${file(input['file_path'])}`
    case 'Edit':
      return `Editing ${file(input['file_path'])}`
    case 'Write':
      return `Writing ${file(input['file_path'])}`
    case 'Bash':
    case 'PowerShell':
      // The description exists precisely because the command is unreadable aloud.
      return String(input['description'] ?? 'Running a command')
    case 'Grep':
      return `Searching for ${String(input['pattern'] ?? '')}`.slice(0, 80)
    case 'Glob':
      return 'Looking for files'
    case 'Task':
    case 'Agent':
      return `Handing off to a subagent: ${String(input['description'] ?? '')}`.slice(0, 90)
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up on the web'
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      // Bookkeeping. Saying it out loud is noise.
      return null
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        return `Using ${parts[2] ?? parts[1] ?? 'a tool'}`
      }
      return `Running ${name}`
  }
}

/**
 * Strip what reads badly aloud.
 *
 * Code blocks are the main offender — a fenced diff spoken character by character is
 * unlistenable and takes minutes. They are replaced by a mention, not dropped, so the
 * sentence still makes sense.
 */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' — code — ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[*_#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface Line {
  type?: string
  timestamp?: string
  message?: {
    id?: string
    role?: string
    content?: unknown
    stop_reason?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

type LineEvent = Omit<TranscriptEvent, 'tabId'>

export function eventsFrom(line: Line): LineEvent[] {
  if (line.type !== 'assistant') return []
  const content = line.message?.content
  if (!Array.isArray(content)) return []

  const parsed = line.timestamp ? Date.parse(line.timestamp) : NaN
  const at = Number.isFinite(parsed) ? parsed : undefined
  const out: LineEvent[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block['type'] === 'text') {
      const raw = String(block['text'] ?? '')
      const text = speakable(raw)
      if (text) out.push({ text, kind: 'assistant', full: raw.trim(), at })
    } else if (block['type'] === 'tool_use') {
      const name = String(block['name'] ?? '')
      const input = (block['input'] as Record<string, unknown>) ?? {}
      const said = describeTool(name, input)
      if (said) out.push({ text: said, kind: 'tool', tool: { name, input }, at })
    }
  }

  // Every content block of one message is its own line, each carrying the message's
  // usage so far; the id is what lets a reader count a message once.
  const u = line.message?.usage
  if (u && line.message?.id) {
    out.push({
      text: '',
      kind: 'usage',
      msgId: line.message.id,
      at,
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
    })
  }

  // `end_turn` is the session finishing and waiting for you; `tool_use` is it carrying on
  // to the next call. Reading the distinction off the transcript beats every alternative
  // — the terminal is a TUI redrawing itself, and a silence timer cannot tell a session
  // that has finished from one that is thinking hard.
  if (line.message?.stop_reason === 'end_turn') out.push({ text: '', kind: 'turn-end', at })

  return out
}

class Watcher {
  private file = ''
  private offset = 0
  private carry = ''
  private reading = false
  private again = false
  private timer: NodeJS.Timeout | null = null

  private readonly tabId: string
  private readonly emit: (e: TranscriptEvent) => void

  // Written out rather than declared as constructor parameters so this module can be
  // run directly by node's type stripping, which is how it is tested.
  constructor(tabId: string, emit: (e: TranscriptEvent) => void) {
    this.tabId = tabId
    this.emit = emit
  }

  start(): void {
    this.pick()
    // fs.watch on Windows misses appends often enough that a slow poll is the
    // difference between narration and silence. It also picks up the binding when it
    // arrives, since `claude` may be started long after narration is switched on.
    this.timer = setInterval(() => this.schedule(), 1000)
  }

  private schedule(): void {
    this.pick()
    void this.drain()
  }

  /** A binding arrived after this watcher started; move to the right file at once. */
  retarget(): void {
    this.schedule()
  }

  /**
   * Point at the transcript this tab's own session is writing, and at nothing else.
   *
   * There is deliberately no fallback. The first version guessed — newest `.jsonl` in
   * the folder — and the guess was wrong in both directions: with two Ember tabs in one
   * directory it crossed them, and with a Claude running in Windows Terminal it read
   * *that*, narrating a session in a different application entirely. A tab reads the
   * session that announced itself from inside that tab, or it reads nothing.
   */
  private pick(): void {
    const bound = bindings.get(this.tabId)
    if (!bound) return
    const file = join(PROJECTS, projectSlug(bound.cwd), `${bound.sessionId}.jsonl`)
    if (file === this.file) return

    if (!existsSync(file)) {
      // The transcript is not there yet. Anything eventually written to it happened
      // after we started listening, so when it does appear it must be read from the
      // top — see `fresh` below.
      this.fresh = true
      return
    }

    this.file = file
    // Normally from the end: the session may have been running a while, and reading its
    // backlog back at you is not what switching narration on means.
    //
    // But if the file did not exist when we started watching, seeking to the end is how
    // a whole answer gets skipped. That is a real race and it cost an afternoon: a
    // question was typed, Claude answered inside two seconds, the transcript was created
    // in between, and the next poll adopted it by seeking straight past the reply. The
    // terminal showed the answer; the watcher reported silence.
    this.offset = this.fresh ? 0 : statSync(file).size
    this.fresh = false
    this.carry = ''
  }

  /** The transcript did not exist when this watcher started, so none of it is backlog. */
  private fresh = false

  private async drain(): Promise<void> {
    if (!this.file) return
    if (this.reading) {
      this.again = true
      return
    }
    this.reading = true
    try {
      const size = statSync(this.file).size
      // Truncated or replaced: start over from where it now ends.
      if (size < this.offset) this.offset = 0
      if (size > this.offset) {
        const chunk = await this.read(this.offset, size - 1)
        this.offset = size
        this.consume(chunk)
      }
    } catch {
      /* mid-write is normal; the next tick picks it up */
    } finally {
      this.reading = false
      if (this.again) {
        this.again = false
        void this.drain()
      }
    }
  }

  private read(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      createReadStream(this.file, { start, end })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        .on('error', reject)
    })
  }

  private consume(chunk: string): void {
    this.carry += chunk
    let cut = this.carry.indexOf('\n')
    while (cut !== -1) {
      const line = this.carry.slice(0, cut).trim()
      this.carry = this.carry.slice(cut + 1)
      if (line) {
        try {
          for (const e of eventsFrom(JSON.parse(line) as Line)) {
            this.emit({ tabId: this.tabId, ...e })
          }
        } catch {
          /* a half-written line is finished by the next append */
        }
      }
      cut = this.carry.indexOf('\n')
    }
  }

  /** Which file this watcher is tailing, and how far in. For `watchState` only. */
  get watching(): string {
    return this.file
  }

  get at(): number {
    return this.offset
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/**
 * One watcher per tab, shared by everyone reading it.
 *
 * Narration and the voice loop both want the same file, and an earlier shape where
 * `startNarration` simply replaced the watcher meant whichever started second silently
 * stole the first one's tail. They subscribe instead: the watcher exists while anyone is
 * listening and stops when the last one leaves, and each subscriber picks the event kinds
 * it cares about.
 */
const watchers = new Map<string, Watcher>()
const listeners = new Map<string, Set<(e: TranscriptEvent) => void>>()

export function subscribe(tabId: string, fn: (e: TranscriptEvent) => void): () => void {
  let set = listeners.get(tabId)
  if (!set) {
    set = new Set()
    listeners.set(tabId, set)
  }
  set.add(fn)

  if (!watchers.has(tabId)) {
    const w = new Watcher(tabId, (e) => {
      // Snapshot: a listener that unsubscribes from inside its own callback — which the
      // voice loop does the moment it sees `turn-end` — must not reshape the set mid-loop.
      for (const l of [...(listeners.get(tabId) ?? [])]) l(e)
    })
    watchers.set(tabId, w)
    w.start()
  }

  return () => {
    const current = listeners.get(tabId)
    if (!current) return
    current.delete(fn)
    if (current.size) return
    listeners.delete(tabId)
    watchers.get(tabId)?.stop()
    watchers.delete(tabId)
  }
}

/** tab id -> the Claude session running in it, as reported by that session's MCP server. */
const bindings = new Map<string, { sessionId: string; cwd: string }>()

/**
 * A session in a tab has identified itself.
 *
 * Reported by the panel MCP server, which Claude Code spawns with both
 * `CLAUDE_CODE_SESSION_ID` and the `EMBER_TAB_ID` it inherited from the shell — the only
 * place those two facts exist together. It arrives whenever `claude` starts, which may
 * be long before or long after narration is switched on, so a live watcher is retargeted
 * on the spot.
 */
export function bindSession(tabId: string, sessionId: string, cwd: string): void {
  if (!tabId || !sessionId || !cwd) return
  bindings.set(tabId, { sessionId, cwd })
  watchers.get(tabId)?.retarget()
}

/** The Ember tab a Claude session runs in, if it announced itself from one. */
export function tabForSession(sessionId: string): string | undefined {
  for (const [tabId, b] of bindings) if (b.sessionId === sessionId) return tabId
  return undefined
}

/** The transcript file a session writes, whether or not it exists yet. */
export function transcriptFile(sessionId: string, cwd: string): string {
  return join(PROJECTS, projectSlug(cwd), `${sessionId}.jsonl`)
}

/** Forget a tab's session binding when the tab goes away. */
export function unbindSession(tabId: string): void {
  bindings.delete(tabId)
}

/**
 * Has a Claude session in this tab announced itself?
 *
 * The voice loop asks before typing: without a binding there is no transcript to read an
 * answer from, and the question would land in whatever the shell happens to be — usually
 * PowerShell, which answers a spoken sentence with a page of red.
 */
export function isBound(tabId: string): boolean {
  return bindings.has(tabId)
}

/**
 * What a tab's watcher is actually looking at.
 *
 * Everything here fails silently by design — a missing binding, a file that is not there
 * yet, an offset parked at the end — so when narration says nothing or a spoken question
 * gets no answer, there is otherwise nothing to look at but an empty transcript. This is
 * the one window into it.
 */
export function watchState(tabId: string): {
  bound: boolean
  cwd: string
  sessionId: string
  file: string
  exists: boolean
  size: number
  offset: number
  listeners: number
} {
  const bound = bindings.get(tabId)
  const w = watchers.get(tabId)
  const file = w?.watching ?? ''
  return {
    bound: !!bound,
    cwd: bound?.cwd ?? '',
    sessionId: bound?.sessionId ?? '',
    file,
    exists: !!file && existsSync(file),
    size: file && existsSync(file) ? statSync(file).size : -1,
    offset: w?.at ?? -1,
    listeners: listeners.get(tabId)?.size ?? 0,
  }
}

/**
 * Begin narrating a tab.
 *
 * It says nothing until a session inside that tab has announced itself, which may be
 * before this call or long after — the toggle can be flipped on an empty shell and
 * starts reading the moment `claude` runs in it.
 */
export function startNarration(tabId: string, emit: (e: TranscriptEvent) => void): void {
  stopNarration(tabId)
  narrations.set(tabId, subscribe(tabId, emit))
}

/** Unsubscribe handles for the narration listener of each tab, so it can be dropped alone. */
const narrations = new Map<string, () => void>()

export function stopNarration(tabId: string): void {
  narrations.get(tabId)?.()
  narrations.delete(tabId)
}

export function stopAllNarration(): void {
  for (const id of [...narrations.keys()]) stopNarration(id)
}
