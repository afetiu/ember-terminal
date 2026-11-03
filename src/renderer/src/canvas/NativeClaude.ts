import type { ClaudeEvent } from '@shared/types'
import type { Feed } from './Feed'
import { escapeHtml } from './markdown'

/**
 * A Claude tab the canvas drives itself (Settings › Agent › "Canvas drives Claude directly").
 *
 * Main runs Claude Code in its structured mode (src/main/claudeHost.ts) and passes on what
 * it says. This is the tab's end of that: the input box, the messages fed to the canvas as
 * the transcript would have fed them, the reply drawn as it is written, the questions
 * Claude Code asks before a tool runs. Nothing is read off a screen and nothing is typed
 * into one; the tab's shell stays a plain shell underneath.
 *
 * Phase 1 of docs/specs/canvas-native.md: plain text in, replies out, interrupt, and a
 * minimal Allow / Deny for permissions. Menus, pictures, the queue and the bar's switches
 * come later.
 */

type Json = Record<string, unknown>

export type NativePhase = 'starting' | 'idle' | 'working' | 'asking' | 'exited'

export interface NativeState {
  phase: NativePhase
  /** The model's id as Claude Code reports it, once a turn has started. */
  model: string
  permissionMode: string
  /** "12s · ↓ 340 tokens", while it works. */
  detail: string
}

export interface NativeContext {
  feed: Feed
  /** Where the input goes: the frame the TUI's prompt sat in. */
  frame: HTMLElement
  /** Where questions go: right above the input. */
  above: HTMLElement
  /** Something about the session changed: phase, model, the working line. */
  changed(state: NativeState): void
  /** The input's height may have changed. */
  relayout(): void
  /** The feed got something to show. */
  grew(): void
  toast(text: string): void
}

/** Tools whose question the canvas cannot draw yet (Phase 3): turned down with a reason, so the turn moves on. */
const NOT_YET: Record<string, string> = {
  AskUserQuestion: "Ember's canvas cannot show multiple-choice questions yet. Ask the user in plain text instead.",
}

export class NativeClaude {
  readonly input: HTMLTextAreaElement
  private readonly asks = document.createElement('div')
  private readonly unsubs: Array<() => void> = []
  private state: NativeState = { phase: 'starting', model: '', permissionMode: '', detail: '' }
  private sessionId = ''
  private pid = 0
  private liveText = ''
  private liveReq = 0
  private startedAt = 0
  private tick = 0
  private stderr = ''
  private stopped = false
  private readonly cards = new Map<string, HTMLElement>()
  /** For probes: what this tab's process has said, by kind. */
  private readonly counts: Record<string, number> = {}

  constructor(
    private readonly tabId: string,
    private readonly cwd: string | undefined,
    private readonly ctx: NativeContext
  ) {
    this.input = document.createElement('textarea')
    this.input.className = 'loom-native-input'
    this.input.rows = 1
    this.input.spellcheck = false
    this.input.placeholder = 'Ask Claude…'
    this.input.setAttribute('aria-label', 'Message Claude')
    ctx.frame.appendChild(this.input)
    this.asks.className = 'loom-asks'
    ctx.above.prepend(this.asks)

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
        e.preventDefault()
        this.submit()
      }
    })
    this.input.addEventListener('input', () => this.fit())
    // A click anywhere in the frame is a click in the input.
    const toInput = (e: MouseEvent) => {
      if (e.target === this.input) return
      e.preventDefault()
      this.input.focus()
    }
    ctx.frame.addEventListener('mousedown', toInput)
    this.unsubs.push(() => ctx.frame.removeEventListener('mousedown', toInput))
    this.unsubs.push(window.ember.claude.onEvent((e) => e.tabId === this.tabId && this.onEvent(e)))
    void this.start()
  }

  // ------------------------------------------------------------- process

  private async start(resume?: string): Promise<void> {
    this.set({ phase: 'starting' })
    const r = await window.ember.claude.start(this.tabId, { ...(this.cwd ? { cwd: this.cwd } : {}), ...(resume ? { resume } : {}) })
    if (!r.ok) {
      this.ctx.feed.notice(r.error ?? 'Claude Code could not start', true)
      this.set({ phase: 'exited' })
      return
    }
    this.sessionId = r.sessionId ?? ''
    this.pid = r.pid ?? 0
  }

  /** Enter: one message to Claude. A session that stopped is picked up again first. */
  private submit(): void {
    const text = this.input.value.trim()
    if (!text) return
    this.send(text)
    this.input.value = ''
    this.fit()
  }

  send(text: string): void {
    if (this.state.phase === 'exited') void this.start(this.sessionId || undefined)
    window.ember.claude.send(this.tabId, text)
    if (this.state.phase !== 'asking') this.working()
  }

  /** Esc: say no to an open question, or stop the turn. False when there was nothing to stop. */
  escape(): boolean {
    const open = [...this.cards.keys()].pop()
    if (open) {
      this.deny(open, 'The user said no.')
      return true
    }
    if (this.state.phase !== 'working') return false
    void window.ember.claude.interrupt(this.tabId).then((r) => {
      if (!r.ok) this.ctx.toast(`Could not interrupt: ${r.error ?? 'no answer'}`)
    })
    return true
  }

  // ------------------------------------------------------------- what it says

  private onEvent(e: ClaudeEvent): void {
    this.counts[e.kind] = (this.counts[e.kind] ?? 0) + 1
    switch (e.kind) {
      case 'ready': {
        const mode = String(e.info['permissionMode'] ?? '')
        this.set({ phase: this.state.phase === 'starting' ? 'idle' : this.state.phase, ...(mode ? { permissionMode: mode } : {}) })
        return
      }
      case 'message':
        this.message(e.msg)
        return
      case 'ask':
        this.ask(e.requestId, e.request)
        return
      case 'cancel':
        this.closeCard(e.requestId)
        return
      case 'stderr':
        this.stderr = (this.stderr + '\n' + e.text).slice(-1500)
        return
      case 'error':
        this.ctx.feed.notice(e.text, true)
        return
      case 'exit': {
        for (const id of [...this.cards.keys()]) this.closeCard(id)
        this.flushLive('')
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
    if (type === 'system') {
      const sub = msg['subtype']
      if (sub === 'init') {
        this.set({ model: String(msg['model'] ?? ''), permissionMode: String(msg['permissionMode'] ?? this.state.permissionMode) })
      } else if (sub === 'status') {
        if (typeof msg['permissionMode'] === 'string') this.set({ permissionMode: msg['permissionMode'] })
        if (msg['status'] === 'requesting' && this.state.phase !== 'asking') this.working()
      } else if (sub === 'compact_boundary') {
        this.ctx.feed.add([this.line(msg)])
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
      this.idle()
    }
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

  // ------------------------------------------------------------- permission

  /**
   * Claude Code wants to run a tool and the person's settings say to ask. A plain card
   * over the input: what it wants to do, Allow or Deny. It stays until answered — an
   * unanswered question holds the turn — and Esc is Deny.
   */
  private ask(requestId: string, req: Json): void {
    const tool = String(req['tool_name'] ?? '')
    const notYet = NOT_YET[tool]
    if (notYet) {
      window.ember.claude.answer(this.tabId, requestId, { behavior: 'deny', message: notYet })
      return
    }
    const input = (req['input'] ?? {}) as Json
    const name = String(req['display_name'] ?? req['title'] ?? tool)
    const what = describe(input, String(req['description'] ?? ''))
    const why = String(req['decision_reason'] ?? '')
    const card = document.createElement('div')
    card.className = 'loom-ask-card'
    card.dataset['req'] = requestId
    card.innerHTML =
      `<div class="loom-ask-card-head"><span class="loom-ask-card-dot"></span>Claude wants to use <b>${escapeHtml(name)}</b></div>` +
      (what ? `<pre class="loom-ask-card-what">${escapeHtml(what)}</pre>` : '') +
      (why ? `<div class="loom-ask-card-why">${escapeHtml(why.slice(0, 300))}</div>` : '') +
      `<div class="loom-ask-card-acts"><button type="button" data-a="allow" class="is-primary">Allow</button><button type="button" data-a="deny">Deny</button><span class="loom-ask-card-keys">Esc to deny</span></div>`
    card.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('button[data-a]')?.dataset['a']
      if (a === 'allow') this.allow(requestId, input)
      else if (a === 'deny') this.deny(requestId, 'The user said no.')
    })
    this.cards.set(requestId, card)
    this.asks.appendChild(card)
    this.asks.classList.add('has-items')
    this.set({ phase: 'asking' })
    this.ctx.relayout()
  }

  private allow(requestId: string, input: Json): void {
    window.ember.claude.answer(this.tabId, requestId, { behavior: 'allow', updatedInput: input })
    this.closeCard(requestId)
  }

  private deny(requestId: string, message: string): void {
    window.ember.claude.answer(this.tabId, requestId, { behavior: 'deny', message })
    this.closeCard(requestId)
  }

  private closeCard(requestId: string): void {
    this.cards.get(requestId)?.remove()
    this.cards.delete(requestId)
    this.asks.classList.toggle('has-items', this.cards.size > 0)
    if (!this.cards.size && this.state.phase === 'asking') this.working()
    this.ctx.relayout()
    this.input.focus()
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
    this.set({ phase: this.cards.size ? 'asking' : 'idle', detail: '' })
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
    this.input.placeholder = next.phase === 'starting' ? 'Starting Claude Code… you can type already' : next.phase === 'exited' ? 'Claude Code stopped — send to pick the session up again' : 'Ask Claude…'
    this.ctx.changed(next)
  }

  /** The input grows with what is written, up to a point, then scrolls. */
  private fit(): void {
    this.input.style.height = 'auto'
    const line = parseFloat(getComputedStyle(this.input).lineHeight) || 20
    this.input.style.height = `${Math.min(this.input.scrollHeight, line * 8)}px`
    this.ctx.relayout()
  }

  get height(): number {
    return this.input.offsetHeight
  }

  get current(): NativeState {
    return this.state
  }

  debug(): { phase: NativePhase; sessionId: string; pid: number; model: string; asks: number; counts: Record<string, number>; live: string } {
    return { phase: this.state.phase, sessionId: this.sessionId, pid: this.pid, model: this.state.model, asks: this.cards.size, counts: { ...this.counts }, live: this.liveText }
  }

  dispose(): void {
    this.stopped = true
    for (const u of this.unsubs) u()
    if (this.tick) window.clearInterval(this.tick)
    if (this.liveReq) cancelAnimationFrame(this.liveReq)
    window.ember.claude.stop(this.tabId)
    this.input.remove()
    this.asks.remove()
  }
}

/** What a tool is about to do, in a line or a few: the command, the file, the address. */
function describe(input: Json, description: string): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (s('command')) return s('command').slice(0, 1200)
  if (s('file_path')) return s('file_path')
  if (s('url')) return s('url')
  if (s('plan')) return s('plan').slice(0, 1200)
  if (description) return description
  try {
    const json = JSON.stringify(input, null, 2)
    return json === '{}' ? '' : json.slice(0, 800)
  } catch {
    return ''
  }
}
