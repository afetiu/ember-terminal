import type { ClaudeEvent, ClaudeImage } from '@shared/types'
import type { Feed } from './Feed'
import { Asks } from './Asks'
import { Composer, tuiOnly, type Attachment, type QueuedMessage, type SlashCommand } from './Composer'

/**
 * A Claude tab the canvas drives itself (Settings › Agent › "Canvas drives Claude directly").
 *
 * Main runs Claude Code in its structured mode (src/main/claudeHost.ts) and passes on what
 * it says. This is the tab's end of that: the messages fed to the canvas as the transcript
 * would have fed them, the reply drawn as it is written, Ember's own input (Composer) and
 * the questions Claude Code asks (Asks). Nothing is read off a screen and nothing is typed
 * into one; the tab's shell stays a plain shell underneath, and `!command` runs there.
 *
 * Phases 1–4 of docs/specs/canvas-native.md: the bar's switches (mode, model, effort,
 * context) are driven from here, and the CLI view hands the session to the real TUI and
 * takes it back (`handOff` / `takeBack`): one process owns a session at a time.
 */

type Json = Record<string, unknown>

export type NativePhase = 'starting' | 'idle' | 'working' | 'asking' | 'exited' | 'cli'

/** A model as `initialize.models` lists it. */
export interface NativeModel {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsAutoMode?: boolean
}

export interface NativeState {
  phase: NativePhase
  /** The model's id as Claude Code reports it, once a turn has started. */
  model: string
  permissionMode: string
  /** "12s · ↓ 340 tokens", while it works. */
  detail: string
  /** The model picked from the bar (a `models` value), '' = whatever Claude Code started with. */
  picked: string
  /** The effort level set from the bar, or the session's own (`system/init.effort`). */
  effort: string
  /** Context used after the last turn, 0–100; null before the first. */
  context: number | null
}

export interface ShellResult {
  output: string
  code: number | null
  /** Still running when Ember stopped waiting: the output is what it printed so far. */
  timedOut: boolean
  error?: string
}

export interface NativeContext {
  feed: Feed
  /** Where the input goes: the frame the TUI's prompt sat in. */
  frame: HTMLElement
  /** Where questions, the queue, pictures and menus go: right above the input. */
  above: HTMLElement
  /** Something about the session changed: phase, model, the working line. */
  changed(state: NativeState): void
  /** The input's height may have changed. */
  relayout(): void
  /** The feed got something to show. */
  grew(): void
  toast(text: string): void
  /** `!command`: run it in the tab's own shell and give back what it printed. */
  shell(command: string): Promise<ShellResult>
  /** Ctrl+C to that shell. */
  interruptShell(): void
  /**
   * The session this tab holds, whenever it is known or changes: its id (only once it has a
   * transcript, i.e. a turn started) and its folder. Remembered across restarts.
   */
  session(sessionId: string, cwd: string): void
  /** A command that only exists in Claude Code's own screen (`/login`): open the CLI view with it. */
  openCli(command: string): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What a `!command` hands Claude, at most: Claude Code's bash mode trims long output too. */
const BANG_CONTEXT_MAX = 30_000

interface Mine {
  text: string
  images: ClaudeImage[]
  shown: boolean
}

export class NativeClaude {
  private readonly composer: Composer
  private readonly asks: Asks
  private readonly unsubs: Array<() => void> = []
  private state: NativeState = { phase: 'starting', model: '', permissionMode: '', detail: '', picked: '', effort: '', context: null }
  private sessionId = ''
  /** The session has a transcript on disk: it can be resumed. */
  private hasTranscript = false
  /** The folder Claude Code says it runs in (long path). */
  private workDir = ''
  /** Started with `--resume`: a failure before `initialize` means the session is gone. */
  private resuming = ''
  private everReady = false
  /** Between `handOff` and `takeBack`: the TUI owns the session. */
  private cli = false
  /** A `/clear` was just shown: the session id that follows is its new conversation. */
  private clearing = false
  /** Turns started since the canvas last started over: the hint goes with the first. */
  private turnCount = 0
  models: NativeModel[] = []
  private capabilities: string[] = []
  private pid = 0
  private liveText = ''
  private liveReq = 0
  private startedAt = 0
  private tick = 0
  private stderr = ''
  private stopped = false
  private commands: SlashCommand[] = []
  /** Commands bound to Claude Code's own screen (`system/init.terminal_slash_commands`): not offered. */
  private terminalOnly = new Set<string>()
  /** Messages sent from here, by uuid: shown at once, the echo matched to them. */
  private readonly mine = new Map<string, Mine>()
  private queue: QueuedMessage[] = []
  /** What `!` commands printed since the last message, for the next one. */
  private bangContext: string[] = []
  private bangRunning = false
  /** For probes: what this tab's process has said, by kind. */
  private readonly counts: Record<string, number> = {}

  constructor(
    private readonly tabId: string,
    private readonly cwd: string | undefined,
    private readonly ctx: NativeContext,
    resume?: string
  ) {
    this.asks = new Asks({
      answer: (id, response) => window.ember.claude.answer(this.tabId, id, response),
      setMode: (mode) => {
        void window.ember.claude.control(this.tabId, { subtype: 'set_permission_mode', mode })
        this.set({ permissionMode: mode })
      },
      relayout: () => ctx.relayout(),
      closed: () => {
        if (!this.asks.size && this.state.phase === 'asking') this.working()
        // After the key that answered has finished: focused now, its character would land in the box.
        requestAnimationFrame(() => {
          if (!this.asks.size || !document.activeElement?.closest('.loom-ask-card')) this.composer.focus()
        })
      },
    })
    ctx.above.prepend(this.asks.el)
    this.composer = new Composer({
      frame: ctx.frame,
      above: ctx.above,
      commands: () => this.commands.filter((c) => !this.terminalOnly.has(c.name)),
      files: async (query) => {
        const r = await window.ember.claude.control(this.tabId, { subtype: 'file_suggestions', query })
        const list = r.ok && Array.isArray(r.response?.['suggestions']) ? (r.response['suggestions'] as Json[]) : []
        return list.map((s) => String(s['path'] ?? s['displayText'] ?? '')).filter(Boolean)
      },
      submit: (text, images) => this.submit(text, images),
      cycleMode: () => this.cycleMode(),
      sendNow: (uuid) => this.sendNow(uuid),
      cancel: (uuid) => void this.cancelQueued(uuid),
      toast: (t) => ctx.toast(t),
      relayout: () => ctx.relayout(),
    })
    this.unsubs.push(window.ember.claude.onEvent((e) => e.tabId === this.tabId && this.onEvent(e)))
    if (resume) {
      // A session from before the restart: it has a transcript, and it is this tab's.
      this.sessionId = resume
      this.hasTranscript = true
    }
    void this.start(resume)
  }

  get input(): HTMLTextAreaElement {
    return this.composer.input
  }

  // ------------------------------------------------------------- process

  private async start(resume?: string): Promise<void> {
    this.set({ phase: 'starting' })
    this.resuming = resume ?? ''
    this.everReady = false
    this.stderr = ''
    const cwd = this.workDir || this.cwd
    const r = await window.ember.claude.start(this.tabId, { ...(cwd ? { cwd } : {}), ...(resume ? { resume } : {}) })
    if (!r.ok) {
      this.ctx.feed.notice(r.error ?? 'Claude Code could not start', true)
      this.set({ phase: 'exited' })
      return
    }
    this.sessionId = r.sessionId ?? ''
    this.pid = r.pid ?? 0
    this.report()
  }

  /** Tell the tab which session it holds (remembered across restarts). */
  private report(): void {
    this.ctx.session(this.resumableId, this.folder)
  }

  /** The session id to resume: '' while it has no transcript yet (a new tab that never sent anything). */
  get resumableId(): string {
    return this.hasTranscript ? this.sessionId : ''
  }

  get folder(): string {
    return this.workDir || this.cwd || ''
  }

  get turns(): number {
    return this.turnCount
  }

  /** The canvas started over (`/clear`): the hint may show again until the next turn. */
  cleared(): void {
    this.turnCount = 0
  }

  // ------------------------------------------------------------- the CLI view

  /**
   * Give the session to Claude Code's own screen: finish (or, asked first, stop) the turn,
   * then stop this process and wait until it has gone. False when the person said no.
   */
  async handOff(): Promise<boolean> {
    if (this.cli) return true
    if (this.state.phase === 'working' || this.state.phase === 'asking') {
      const yes = await this.asks.confirm('Stop the current turn and open the CLI?', 'Stop and open the CLI', 'Keep working')
      if (!yes) return false
      // What was queued goes back into the box; questions still open are answered no on the way out (ClaudeHost.stop).
      const queued = this.queue.splice(0)
      if (queued.length) {
        this.composer.setQueue(this.queue)
        for (const q of queued) this.mine.delete(q.uuid)
        this.composer.append(queued.map((q) => q.text).join('\n'))
      }
      if (this.state.phase === 'working') await window.ember.claude.control(this.tabId, { subtype: 'interrupt', ...(queued.length ? { cancel_queued: true } : {}) })
    }
    this.cli = true
    this.stopped = true
    this.asks.closeAll()
    this.flushLive('')
    await window.ember.claude.stop(this.tabId)
    this.set({ phase: 'cli' })
    return true
  }

  /** The TUI has exited: pick the session up again, on the id it ended on. */
  takeBack(sessionId: string): void {
    if (!this.cli) return
    this.cli = false
    this.stopped = false
    if (sessionId && UUID.test(sessionId) && sessionId !== this.sessionId) {
      this.sessionId = sessionId
      this.hasTranscript = true
    }
    void this.start(this.resumableId || undefined)
  }

  get inCli(): boolean {
    return this.cli
  }

  // ------------------------------------------------------------- the bar

  /** The order Shift+Tab goes through, as in Claude Code; auto only where the model offers it. Never bypass. */
  get modes(): string[] {
    const auto = this.currentModel()?.supportsAutoMode === true || this.state.permissionMode === 'auto'
    return ['default', 'acceptEdits', 'plan', ...(auto ? ['auto'] : [])]
  }

  cycleMode(): void {
    if (this.state.phase === 'cli' || this.state.phase === 'exited' || this.state.phase === 'starting') return
    const list = this.modes
    const at = list.indexOf(this.state.permissionMode)
    // From a mode the canvas does not cycle through (bypass, chosen at launch): back to default.
    const next = at < 0 ? 'default' : list[(at + 1) % list.length]!
    this.set({ permissionMode: next })
    void window.ember.claude.control(this.tabId, { subtype: 'set_permission_mode', mode: next }).then((r) => {
      if (!r.ok) this.ctx.toast(`Could not switch the mode: ${r.error ?? 'no answer'}`)
    })
  }

  /** The model row the session is on: the one picked, else the one whose id the session reports. */
  currentModel(): NativeModel | undefined {
    const pick = this.state.picked
    if (pick) return this.models.find((m) => m.value === pick)
    const id = this.state.model
    return this.models.find((m) => m.value === id || m.resolvedModel === id) ?? this.models.find((m) => m.value === 'default')
  }

  setModel(value: string): void {
    if (!this.models.some((m) => m.value === value)) return
    if (this.state.phase === 'cli' || this.state.phase === 'exited') return
    this.set({ picked: value })
    void window.ember.claude.control(this.tabId, { subtype: 'set_model', model: value === 'default' ? null : value }).then((r) => {
      if (!r.ok) this.ctx.toast(`Could not switch the model: ${r.error ?? 'no answer'}`)
      else if (typeof r.response?.['model'] === 'string') this.set({ model: r.response['model'] as string })
    })
  }

  /** The effort levels the current model takes; empty when it takes none. */
  get efforts(): string[] {
    const m = this.currentModel()
    return m?.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : []
  }

  setEffort(level: string): void {
    if (!this.efforts.includes(level)) return
    if (this.state.phase === 'cli' || this.state.phase === 'exited') return
    this.set({ effort: level })
    void window.ember.claude.control(this.tabId, { subtype: 'apply_flag_settings', settings: { effortLevel: level } }).then((r) => {
      if (!r.ok) this.ctx.toast(`Could not set the effort: ${r.error ?? 'no answer'}`)
    })
  }

  /** How full the context is, asked after each turn. */
  private async refreshContext(): Promise<void> {
    const r = await window.ember.claude.control(this.tabId, { subtype: 'get_context_usage' })
    const p = r.ok ? Number(r.response?.['percentage']) : NaN
    if (Number.isFinite(p)) this.set({ context: Math.max(0, Math.min(100, p)) })
  }

  /** Something of the input's is open over the canvas: a menu, a card, the queue. */
  get menuOpen(): boolean {
    return !!this.composer.menuOpen || this.asks.size > 0 || this.queue.length > 0
  }

  /** Enter in the composer. */
  private submit(text: string, images: Attachment[]): void {
    if (text.startsWith('!') && !images.length) {
      void this.runBang(text.slice(1).trim())
      return
    }
    if (tuiOnly(text)) {
      this.ctx.openCli(text.trim())
      return
    }
    this.send(text, images.map((a) => a.image))
  }

  /**
   * One message to Claude. Shown in the turn at once; while a turn runs it waits in the
   * queue above the input instead, and moves into the turn when Claude Code takes it.
   * A session that stopped is picked up again first.
   */
  send(text: string, images: ClaudeImage[] = []): void {
    if (!text && !images.length) return
    if (this.cli) return
    if (this.state.phase === 'exited') void this.start(this.resumableId || undefined)
    const uuid = crypto.randomUUID()
    const context = this.bangContext.splice(0)
    const busy = this.state.phase === 'working' || this.state.phase === 'asking'
    this.mine.set(uuid, { text, images, shown: false })
    if (busy) {
      this.queue.push({ uuid, text, images: images.length })
      this.composer.setQueue(this.queue)
    } else {
      this.show(uuid)
      this.working()
    }
    window.ember.claude.send(this.tabId, text, images, { uuid, ...(context.length ? { context } : {}) })
  }

  /** The person's message in the turn, as the transcript would have it. */
  private show(uuid: string): void {
    const m = this.mine.get(uuid)
    if (!m || m.shown) return
    m.shown = true
    const slash = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(m.text)
    // The feed starts the canvas over for it; the new conversation's id follows in system/init.
    if (slash && /^(clear|reset|new)$/.test(slash[1]!)) this.clearing = true
    else this.turnCount++
    const content: unknown =
      slash && !m.images.length
        ? `<command-name>/${slash[1]}</command-name><command-args>${slash[2] ?? ''}</command-args>`
        : m.images.length
          ? [
              ...(m.text ? [{ type: 'text', text: m.text }] : []),
              ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
            ]
          : m.text
    this.ctx.feed.add([{ type: 'user', uuid, timestamp: new Date().toISOString(), message: { role: 'user', content } }])
  }

  private dequeue(uuid: string): boolean {
    const i = this.queue.findIndex((q) => q.uuid === uuid)
    if (i < 0) return false
    this.queue.splice(i, 1)
    this.composer.setQueue(this.queue)
    return true
  }

  /**
   * Send now: stop the turn and let the queue go. Claude Code runs what is queued as soon
   * as an interrupt (without cancel_queued) ends the turn — protocol reference §5.5.
   */
  private sendNow(uuid: string): void {
    if (!this.queue.some((q) => q.uuid === uuid)) return
    void window.ember.claude.control(this.tabId, { subtype: 'interrupt' }).then((r) => {
      if (!r.ok) this.ctx.toast(`Could not send now: ${r.error ?? 'no answer'}`)
    })
  }

  private async cancelQueued(uuid: string): Promise<void> {
    const r = await window.ember.claude.control(this.tabId, { subtype: 'cancel_async_message', message_uuid: uuid })
    if (!r.ok || r.response?.['cancelled'] === false) {
      if (this.queue.some((q) => q.uuid === uuid)) this.ctx.toast('Too late — Claude already took that one')
      return
    }
    this.dequeue(uuid)
    this.mine.delete(uuid)
  }

  /**
   * Esc, innermost first: a menu, a question (no), a `!` command (Ctrl+C), the turn
   * (interrupt — the queue goes with it, back into the input). False when there was nothing.
   */
  escape(): boolean {
    if (this.composer.escape()) return true
    if (this.asks.escape()) return true
    if (this.bangRunning) {
      this.ctx.interruptShell()
      return true
    }
    if (this.state.phase !== 'working') return false
    const queued = this.queue.splice(0)
    if (queued.length) this.composer.setQueue(this.queue)
    void window.ember.claude.control(this.tabId, { subtype: 'interrupt', ...(queued.length ? { cancel_queued: true } : {}) }).then((r) => {
      if (!r.ok) this.ctx.toast(`Could not interrupt: ${r.error ?? 'no answer'}`)
    })
    // What was waiting goes back into the box, as Claude Code does with its own queue.
    const back = queued.map((q) => this.mine.get(q.uuid)?.text ?? q.text).filter(Boolean)
    for (const q of queued) this.mine.delete(q.uuid)
    if (back.length) this.composer.append(back.join('\n'))
    return true
  }

  // ------------------------------------------------------------- `!` in the shell

  /**
   * `!command`: not Claude's. It runs in the tab's own shell, its output shows in the turn,
   * and the next message carries both to Claude as `<bash-input>` / `<bash-stdout>`, the
   * way Claude Code's bash mode adds them to the conversation.
   */
  private async runBang(command: string): Promise<void> {
    if (!command) return
    if (this.bangRunning) {
      this.ctx.toast('A command is still running in the shell — Esc stops it')
      return
    }
    this.bangRunning = true
    const id = crypto.randomUUID()
    const feed = this.ctx.feed
    feed.add([{ type: 'user', uuid: `${id}-in`, timestamp: new Date().toISOString(), message: { role: 'user', content: `<bash-input>${command}</bash-input>` } }])
    const running = feed.notice("running in this tab's shell · esc to stop")
    let r: ShellResult
    try {
      r = await this.ctx.shell(command)
    } catch (err) {
      r = { output: '', code: null, timedOut: false, error: err instanceof Error ? err.message : String(err) }
    }
    running.remove()
    this.bangRunning = false
    if (r.error) {
      feed.notice(r.error, true)
      return
    }
    const out = r.output.replace(/\s+$/, '')
    feed.add([{ type: 'user', uuid: `${id}-out`, timestamp: new Date().toISOString(), message: { role: 'user', content: `<bash-stdout>${out}</bash-stdout><bash-stderr></bash-stderr>` } }])
    if (r.timedOut) feed.notice("Still running in the tab's shell. What it printed so far goes to Claude with your next message.")
    else if (r.code) feed.notice(`exit code ${r.code}`, true)
    else if (!out) feed.notice('(no output)')
    const kept = out.length > BANG_CONTEXT_MAX ? `${out.slice(0, BANG_CONTEXT_MAX)}\n… (${out.length - BANG_CONTEXT_MAX} more characters)` : out
    this.bangContext.push(`<bash-input>${command}</bash-input>`, `<bash-stdout>${kept}</bash-stdout><bash-stderr></bash-stderr>`)
    this.ctx.grew()
  }

  /** Files dropped on the canvas: pictures attach, anything else is mentioned by path. */
  dropFiles(files: File[]): void {
    void this.composer.addFiles(files, (f) => window.ember.platform.pathForFile(f))
  }

  /** Text put in the box without sending it (a canvas action). */
  put(text: string): void {
    this.composer.append(text)
  }

  // ------------------------------------------------------------- what it says

  private onEvent(e: ClaudeEvent): void {
    this.counts[e.kind] = (this.counts[e.kind] ?? 0) + 1
    switch (e.kind) {
      case 'ready': {
        const mode = String(e.info['permissionMode'] ?? '')
        this.everReady = true
        if (Array.isArray(e.info['commands'])) this.commands = e.info['commands'] as SlashCommand[]
        if (Array.isArray(e.info['models'])) this.models = (e.info['models'] as NativeModel[]).filter((m) => m && typeof m.value === 'string')
        if (Array.isArray(e.info['capabilities'])) this.capabilities = (e.info['capabilities'] as unknown[]).map(String)
        this.set({ phase: this.state.phase === 'starting' ? 'idle' : this.state.phase, ...(mode ? { permissionMode: mode } : {}) })
        return
      }
      case 'message':
        this.message(e.msg)
        return
      case 'ask':
        this.asks.open(e.requestId, e.request)
        this.set({ phase: 'asking' })
        return
      case 'cancel':
        this.asks.close(e.requestId)
        return
      case 'stderr':
        this.stderr = (this.stderr + '\n' + e.text).slice(-1500)
        return
      case 'error':
        this.ctx.feed.notice(e.text, true)
        return
      case 'exit': {
        // `--resume` of a session that is gone (deleted, another folder): start a new one.
        if (this.resuming && !this.everReady && !this.stopped && !this.cli) {
          const why = this.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
          this.ctx.feed.notice(`Could not pick up the last session${why ? ` (${why.slice(0, 200)})` : ''}. Started a new one.`, true)
          this.hasTranscript = false
          this.sessionId = ''
          void this.start()
          return
        }
        this.asks.closeAll()
        this.flushLive('')
        const lost = this.queue.splice(0)
        this.composer.setQueue(this.queue)
        for (const q of lost) this.mine.delete(q.uuid)
        if (lost.length) this.composer.append(lost.map((q) => q.text).join('\n'))
        if (this.cli) return
        if (!this.stopped) {
          const why = this.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' · ')
          this.ctx.feed.notice(`Claude Code stopped${e.code ? ` (exit code ${e.code})` : ''}${why ? ` — ${why}` : ''}. Send a message to pick the session up again.`, !!e.code)
        }
        this.set({ phase: 'exited' })
        return
      }
    }
  }

  private message(msg: Json): void {
    const type = msg['type']
    const kind = `${String(type)}${msg['subtype'] ? `/${String(msg['subtype'])}` : ''}`
    this.counts[kind] = (this.counts[kind] ?? 0) + 1
    if (type === 'conversation_reset') {
      // A new conversation not started from this input: the canvas starts over too.
      if (!this.clearing) this.ctx.feed.switchSession(false, true)
      this.clearing = false
      return
    }
    if (type === 'command_lifecycle') {
      const uuid = String(msg['command_uuid'] ?? '')
      const st = msg['state']
      if (!this.mine.has(uuid)) return
      if (st === 'started') {
        this.dequeue(uuid)
        this.show(uuid)
        if (this.state.phase !== 'asking') this.working()
      } else if (st === 'cancelled') {
        if (this.dequeue(uuid)) this.mine.delete(uuid)
      }
      return
    }
    if (type === 'system') {
      const sub = msg['subtype']
      if (sub === 'init') {
        this.set({
          model: String(msg['model'] ?? ''),
          permissionMode: String(msg['permissionMode'] ?? this.state.permissionMode),
          ...(typeof msg['effort'] === 'string' && !this.state.effort ? { effort: msg['effort'] } : {}),
        })
        this.sessionSaid(String(msg['session_id'] ?? ''), typeof msg['cwd'] === 'string' ? msg['cwd'] : '')
        if (Array.isArray(msg['terminal_slash_commands'])) this.terminalOnly = new Set((msg['terminal_slash_commands'] as unknown[]).map((c) => String(c).replace(/^\//, '')))
      } else if (sub === 'status') {
        if (typeof msg['permissionMode'] === 'string') this.set({ permissionMode: msg['permissionMode'] })
        if (msg['status'] === 'requesting' && this.state.phase !== 'asking') this.working()
      } else if (sub === 'compact_boundary') {
        this.ctx.feed.add([this.line(msg)])
      } else if (sub === 'commands_changed' && Array.isArray(msg['commands'])) {
        this.commands = (msg['commands'] as Json[]).filter((c) => typeof c['name'] === 'string') as unknown as SlashCommand[]
      }
      return
    }
    if (type === 'stream_event') {
      // Claude's words as they are written. Only the main conversation: a subagent's
      // stream is its own business, and its summary comes back as the tool's result.
      if (msg['parent_tool_use_id']) return
      const ev = (msg['event'] ?? {}) as Json
      if (ev['type'] === 'content_block_start') this.flushLive('')
      else if (ev['type'] === 'content_block_delta') {
        const d = (ev['delta'] ?? {}) as Json
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
          this.liveText += d['text']
          this.paintLive()
        }
      }
      return
    }
    if (type === 'user' && msg['isReplay'] === true) {
      // The echo of a message sent from here: it is already on the canvas (or waiting in
      // the queue, and Claude has now taken it).
      const uuid = String(msg['uuid'] ?? '')
      if (this.mine.has(uuid)) {
        this.dequeue(uuid)
        this.show(uuid)
        return
      }
    }
    if (type === 'assistant' || type === 'user') {
      if (!msg['parent_tool_use_id']) this.flushLive('')
      this.ctx.feed.add([this.line(msg)])
      const err = msg['error']
      if (type === 'assistant' && typeof err === 'string' && err) {
        this.ctx.feed.notice(
          err === 'authentication_failed' ? 'Claude Code is not signed in. Run claude in a terminal tab and sign in, then try again.' : `Claude Code: ${err.replace(/_/g, ' ')}`,
          true
        )
      }
      return
    }
    if (type === 'result') {
      this.flushLive('')
      const reason = String(msg['terminal_reason'] ?? '')
      if (msg['is_error'] === true && !/^aborted/.test(reason)) {
        const errors = Array.isArray(msg['errors']) ? (msg['errors'] as unknown[]).map(String).filter(Boolean) : []
        const text = errors.join(' · ') || (typeof msg['result'] === 'string' ? msg['result'] : '') || String(msg['subtype'] ?? 'error').replace(/_/g, ' ')
        this.ctx.feed.notice(`The turn ended with an error: ${text}`, true)
      }
      // Messages of this turn are done with; their uuids need no matching any more.
      for (const u of [msg['user_message_uuid'], ...(Array.isArray(msg['user_message_uuids']) ? (msg['user_message_uuids'] as unknown[]) : [])])
        if (typeof u === 'string' && this.mine.get(u)?.shown) this.mine.delete(u)
      this.idle()
      void this.refreshContext()
    }
  }

  /**
   * The session id (and folder) Claude Code reports at the start of each turn. A new id
   * means a new conversation: `/clear`, which the feed has already started over for.
   */
  private sessionSaid(id: string, cwd: string): void {
    let changed = false
    if (cwd && cwd !== this.workDir) {
      this.workDir = cwd
      changed = true
    }
    if (id && UUID.test(id) && (id !== this.sessionId || !this.hasTranscript)) {
      this.sessionId = id
      this.hasTranscript = true
      this.clearing = false
      changed = true
    }
    if (changed) this.report()
  }

  /** A stream message in the transcript's shape, which is what the feed reads. */
  private line(msg: Json): Json {
    return {
      ...msg,
      timestamp: new Date().toISOString(),
      // A subagent's own steps: the transcript marks them so, and the feed leaves them out.
      isSidechain: !!msg['parent_tool_use_id'],
      ...(msg['tool_use_result'] !== undefined ? { toolUseResult: msg['tool_use_result'] } : {}),
    }
  }

  private paintLive(): void {
    if (this.liveReq) return
    this.liveReq = requestAnimationFrame(() => {
      this.liveReq = 0
      this.ctx.feed.live(this.liveText)
      this.ctx.grew()
      this.set({ detail: this.detail() })
    })
  }

  private flushLive(text: string): void {
    if (this.liveReq) cancelAnimationFrame(this.liveReq)
    this.liveReq = 0
    this.liveText = text
    this.ctx.feed.live(text)
  }

  // ------------------------------------------------------------- state

  private working(): void {
    if (this.state.phase !== 'working') this.startedAt = Date.now()
    this.set({ phase: 'working', detail: this.detail() })
    if (!this.tick) this.tick = window.setInterval(() => this.set({ detail: this.detail() }), 1000)
  }

  private idle(): void {
    if (this.tick) window.clearInterval(this.tick)
    this.tick = 0
    this.set({ phase: this.asks.size ? 'asking' : 'idle', detail: '' })
  }

  private detail(): string {
    const s = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000))
    // Roughly four characters a token: the same arrow-and-count the TUI shows.
    const tokens = Math.round(this.liveText.length / 4)
    return `${s}s${tokens ? ` · ↓ ${tokens} tokens` : ''} · esc to interrupt`
  }

  private set(patch: Partial<NativeState>): void {
    const next = { ...this.state, ...patch }
    if (next.phase !== 'working' && next.phase !== 'asking' && this.tick) {
      window.clearInterval(this.tick)
      this.tick = 0
    }
    this.state = next
    this.composer.input.placeholder =
      next.phase === 'starting'
        ? 'Starting Claude Code… you can type already'
        : next.phase === 'exited'
          ? 'Claude Code stopped — send to pick the session up again'
          : next.phase === 'cli'
            ? 'The session is open in the CLI view — Ctrl+` to come back'
          : next.phase === 'working'
            ? 'Queue a message for when this turn ends'
            : 'Ask Claude…   / commands   @ files   ! shell'
    this.ctx.changed(next)
  }

  get height(): number {
    return this.composer.input.offsetHeight
  }

  get current(): NativeState {
    return this.state
  }

  debug(): {
    phase: NativePhase
    sessionId: string
    pid: number
    model: string
    permissionMode: string
    asks: number
    askKinds: string[]
    counts: Record<string, number>
    live: string
    commands: number
    menu: { kind: string; items: string[]; index: number } | null
    attachments: number
    queue: QueuedMessage[]
    bangContext: number
    input: string
    cli: boolean
    resumable: string
    cwd: string
    models: string[]
    picked: string
    effort: string
    efforts: string[]
    modes: string[]
    context: number | null
    capabilities: string[]
  } {
    return {
      phase: this.state.phase,
      sessionId: this.sessionId,
      pid: this.pid,
      model: this.state.model,
      permissionMode: this.state.permissionMode,
      asks: this.asks.size,
      askKinds: this.asks.kinds(),
      counts: { ...this.counts },
      live: this.liveText,
      commands: this.commands.length,
      menu: this.composer.menuOpen,
      attachments: this.composer.attachmentCount,
      queue: [...this.queue],
      bangContext: this.bangContext.length,
      input: this.composer.input.value,
      cli: this.cli,
      resumable: this.resumableId,
      cwd: this.folder,
      models: this.models.map((m) => m.value),
      picked: this.state.picked,
      effort: this.state.effort,
      efforts: this.efforts,
      modes: this.modes,
      context: this.state.context,
      capabilities: [...this.capabilities],
    }
  }

  dispose(): void {
    this.stopped = true
    for (const u of this.unsubs) u()
    if (this.tick) window.clearInterval(this.tick)
    if (this.liveReq) cancelAnimationFrame(this.liveReq)
    window.ember.claude.stop(this.tabId)
    this.composer.dispose()
    this.asks.el.remove()
  }
}
