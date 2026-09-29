import type { VoiceLine } from '@shared/types'

/**
 * The realtime call, from the app's side.
 *
 * One frame for the whole window, like `Speech`: there is one microphone, and two live
 * calls would fight over it and hear each other. Which tab the call is *for* is
 * bookkeeping kept out here, because the tab decides where `ask_claude` lands.
 *
 * This class carries messages and owns the lifecycle. It deliberately knows nothing about
 * what is said — routing a question to the right session, and deciding what the state
 * strip shows, is the App's business.
 */
export interface RealtimeHooks {
  /**
   * The voice called one of its tools. Resolve with what to hand back as the result.
   *
   * Always resolves, never rejects — see `runTool`. `tabId` is the tab the call belongs
   * to, which is where anything unqualified should land.
   */
  onTool: (tabId: string, name: string, args: Record<string, unknown>) => Promise<string>
  /** Anything worth repainting: connection, who is talking, a new transcript line. */
  onChange: () => void
  /** A line of the conversation, for the strip. */
  onLine: (line: VoiceLine) => void
  /** Something went wrong in a way the user needs to be told about. */
  onError: (message: string) => void
}

export type CallState = 'idle' | 'connecting' | 'live' | 'failed'

export class Realtime {
  readonly el: HTMLIFrameElement

  private ready = false
  private readonly queued: Array<Record<string, unknown>> = []

  /** The tab this call belongs to. Null when there is no call. */
  private tab: string | null = null

  state: CallState = 'idle'
  /** He is talking. */
  hearing = false
  /** It is talking. */
  speaking = false
  /** A question is with Claude right now — the gap the holding line covers. */
  thinking = false

  /** Counters, for the probe. Nothing in the app reads these. */
  readonly stats = {
    ready: false,
    connects: 0,
    asks: 0,
    answers: 0,
    lines: 0,
    notices: 0,
    lastTool: '',
    /** Result of the last `checkMic()`: 'granted', 'NotFoundError', 'NotAllowedError'… */
    mic: '',
    errors: [] as string[],
  }

  constructor(private readonly hooks: RealtimeHooks) {
    this.el = document.createElement('iframe')
    this.el.className = 'ember-realtime'
    this.el.setAttribute('allow', 'microphone; autoplay')
    this.el.setAttribute('aria-hidden', 'true')
    this.el.tabIndex = -1

    window.addEventListener('message', (e) => this.receive(e))
  }

  private origin = ''

  /** Remember where the bridge is. The frame itself loads on the first call or mic check. */
  attach(origin: string): void {
    if (!origin || this.origin) return
    this.origin = origin
  }

  /**
   * Load the frame. Done lazily: a loaded frame is an out-of-process renderer (~95 MB)
   * sitting idle for the hours no call is made; until it loads, requests queue.
   */
  private load(): void {
    if (this.el.src || !this.origin) return
    this.el.src = `${this.origin}/realtime`
  }

  get activeTab(): string | null {
    return this.tab
  }

  get isLive(): boolean {
    return this.state === 'live'
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Start a call for a tab.
   *
   * The secret is minted per call rather than per app run: it is short-lived by design,
   * and one that was fetched when Ember started would be dead by the time anyone pressed
   * the button.
   */
  async start(tabId: string, voice: string, model: string): Promise<void> {
    this.load()
    if (this.state === 'connecting' || this.state === 'live') this.stop()

    this.tab = tabId
    this.state = 'connecting'
    this.hooks.onChange()

    const auth = await window.ember.voice.secret(voice, model)
    if (!auth.ok || !auth.secret) {
      this.state = 'failed'
      this.tab = null
      const why = auth.error ?? 'no session'
      this.stats.errors.push(why)
      this.hooks.onError(why)
      this.hooks.onChange()
      return
    }

    this.stats.connects++
    this.send({ action: 'connect', auth })
  }

  stop(): void {
    const tab = this.tab
    this.send({ action: 'disconnect' })
    // Whatever Claude is chewing on belongs to a call that no longer exists. Left alone
    // it would resolve into a dead channel and hold the tab's slot against the next call.
    if (tab) window.ember.voice.cancel(tab)
    this.tab = null
    this.state = 'idle'
    this.hearing = this.speaking = this.thinking = false
    this.hooks.onChange()
  }

  toggle(tabId: string, voice: string, model: string): void {
    if (this.state !== 'idle' && this.tab === tabId) this.stop()
    else void this.start(tabId, voice, model)
  }

  /** Cut the voice off mid-sentence without ending the call. */
  hush(): void {
    this.send({ action: 'hush' })
  }

  /**
   * Ask the page whether Ember lets it have the microphone, and stash the answer.
   *
   * For the probe. The page has to do this itself — it is cross-origin, so anything
   * outside calling `getUserMedia` on its behalf gets a SecurityError and learns nothing
   * about the permission it was trying to test.
   */
  checkMic(): void {
    this.load()
    this.stats.mic = ''
    this.send({ action: 'miccheck' })
  }

  // ---------------------------------------------------------------- messages

  private send(msg: Record<string, unknown>): void {
    if (!this.ready) {
      this.queued.push(msg)
      return
    }
    this.el.contentWindow?.postMessage({ __ember: 'ember-realtime', ...msg }, '*')
  }

  private receive(e: MessageEvent): void {
    const m = e.data as Record<string, unknown> | null
    if (!m || m['__emberRealtime'] !== true) return

    switch (m['type']) {
      case 'ready':
        this.ready = true
        this.stats.ready = true
        for (const msg of this.queued.splice(0)) this.send(msg)
        break

      case 'up':
        this.state = 'live'
        this.hooks.onChange()
        break

      case 'down':
        // Only a surprise disconnect matters here; a deliberate stop() already reset us.
        if (this.state !== 'idle') {
          this.state = 'idle'
          this.tab = null
          this.hearing = this.speaking = this.thinking = false
          this.hooks.onChange()
        }
        break

      case 'connection':
        if (m['state'] === 'failed') {
          this.state = 'failed'
          this.hooks.onError('the call dropped')
          this.hooks.onChange()
        }
        break

      case 'listening':
        this.hearing = m['on'] === true
        this.hooks.onChange()
        break

      case 'speaking':
        this.speaking = m['on'] === true
        this.hooks.onChange()
        break

      case 'said': {
        const text = String(m['text'] ?? '').trim()
        if (!text) break
        this.stats.lines++
        this.hooks.onLine({ who: m['who'] === 'user' ? 'user' : 'voice', text })
        break
      }

      case 'tool':
        void this.runTool(
          String(m['id'] ?? ''),
          String(m['name'] ?? ''),
          (m['args'] as Record<string, unknown>) ?? {}
        )
        break

      case 'miccheck':
        this.stats.mic = String(m['result'] ?? '')
        break

      case 'error': {
        const why = `${String(m['where'])}: ${String(m['message'])}`
        this.stats.errors.push(why)
        console.warn(`[ember] realtime ${why}`)
        // A microphone or connection failure ends the call; a session-level complaint
        // usually does not, and killing the call over one would be worse than the error.
        if (m['where'] === 'microphone' || m['where'] === 'connect') {
          this.state = 'failed'
          this.tab = null
          this.hooks.onError(why)
        }
        this.hooks.onChange()
        break
      }
    }
  }

  /**
   * Run one tool call and hand the result back.
   *
   * A result always goes back, including for failures: the model is holding the floor
   * waiting for this string, and a tool call that never returns leaves the call silent
   * with nothing to recover from. An error phrased as a sentence is something it can say
   * out loud; an exception is a dead call.
   *
   * Only the slow tools raise `thinking`. Flagging a 20ms `list_sessions` as thinking
   * would make the status light flicker on every turn and mean nothing.
   */
  private async runTool(id: string, name: string, args: Record<string, unknown>): Promise<void> {
    const tab = this.tab
    if (!tab || !id) return

    this.stats.asks++
    this.stats.lastTool = name
    const slow = name === 'ask_claude'
    if (slow) {
      this.thinking = true
      this.hooks.onChange()
    }

    let text: string
    try {
      text = await this.hooks.onTool(tab, name, args)
    } catch (err) {
      text = `That did not work: ${(err as Error).message}`
    }

    if (slow) this.thinking = false
    this.stats.answers++
    this.hooks.onChange()
    this.send({ action: 'answer', id, text })
  }

  /**
   * Tell the voice something it did not ask about — a dispatched session has finished.
   *
   * `speak` is the difference between a colleague and a nuisance. It goes in as context
   * either way; a reply is only prompted when nobody is mid-sentence, so a background job
   * completing never talks over the user.
   */
  notice(text: string): void {
    if (!this.isLive || !text) return
    this.stats.notices++
    this.send({ action: 'notice', text, speak: !this.speaking && !this.hearing })
  }

  /**
   * Set the state the chrome reads, without a connection behind it. Diagnostics only —
   * see `pretendCall` in `App.exposeDiagnostics`.
   */
  pretend(state: CallState, tabId: string | null): void {
    this.state = state
    this.tab = tabId
    this.hooks.onChange()
  }

  /** A tab that has gone away takes its call with it. */
  forget(tabId: string): void {
    if (this.tab === tabId) this.stop()
  }

  dispose(): void {
    this.stop()
    this.el.remove()
  }
}
