import type { CallState } from './Realtime'

/**
 * The orchestrator, as something you can see and write to.
 *
 * The agent itself is not this class — it is the shared history plus the tool loop in
 * `App`, which the voice and this panel both drive. This is one of its two front ends,
 * and it exists because the other one only works when you are alone: in an office you
 * cannot talk to it, and an assistant you can only reach by speaking is an assistant you
 * cannot reach most of the working day.
 *
 * Both channels write into the same conversation, so a thread started out loud continues
 * in text without re-explaining anything, and the panel is where a call is visible —
 * whether one is up, and the one button that starts or ends it.
 */

export interface OrchestratorHooks {
  /** Send typed text as a turn. Resolves when the whole turn (including tools) is done. */
  onSend: (text: string) => Promise<void>
  /** Start or end the call. */
  onToggleCall: () => void
  onClose: () => void
}

export type Speaker = 'you' | 'agent' | 'system'

export interface Turn {
  who: Speaker
  text: string
  /** Set on an agent turn that used tools, so the work it did is visible. */
  did?: string[]
  /** Spoken rather than typed. Worth showing, so the two channels are distinguishable. */
  spoken?: boolean
}

export class Orchestrator {
  readonly el: HTMLElement
  private readonly log: HTMLElement
  private readonly box: HTMLTextAreaElement
  private readonly callBtn: HTMLButtonElement
  private readonly pill: HTMLElement
  private readonly sendBtn: HTMLButtonElement

  private open = false
  private busy = false

  constructor(private readonly hooks: OrchestratorHooks) {
    this.el = document.createElement('aside')
    this.el.className = 'ember-orch'

    // ---- header: what this is, and whether a call is up ----
    const head = document.createElement('header')
    head.className = 'ember-orch-head'

    const title = document.createElement('div')
    title.className = 'ember-orch-title'
    title.textContent = 'Orchestrator'

    this.pill = document.createElement('span')
    this.pill.className = 'ember-orch-pill'

    this.callBtn = document.createElement('button')
    this.callBtn.className = 'ember-orch-call'
    this.callBtn.addEventListener('click', () => this.hooks.onToggleCall())

    const close = document.createElement('button')
    close.className = 'ember-orch-x'
    close.textContent = '✕'
    close.title = 'Close  (Ctrl+Shift+M)'
    close.tabIndex = -1
    close.addEventListener('click', () => this.hooks.onClose())

    head.append(title, this.pill, this.callBtn, close)

    // ---- the conversation ----
    this.log = document.createElement('div')
    this.log.className = 'ember-orch-log'

    // ---- composer ----
    const foot = document.createElement('form')
    foot.className = 'ember-orch-foot'
    foot.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submit()
    })

    this.box = document.createElement('textarea')
    this.box.className = 'ember-orch-box'
    this.box.rows = 1
    this.box.placeholder = 'Ask, or hand out work…'
    this.box.spellcheck = false
    this.box.addEventListener('input', () => this.grow())
    this.box.addEventListener('keydown', (e) => {
      // Enter sends, Shift+Enter is a newline — the bargain every chat box makes, and the
      // one already in his fingers from the panel's ask boxes.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        void this.submit()
      }
      // Escape closes rather than reaching the terminal underneath.
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.hooks.onClose()
      }
    })

    this.sendBtn = document.createElement('button')
    this.sendBtn.className = 'ember-orch-send'
    this.sendBtn.type = 'submit'
    this.sendBtn.textContent = 'Send'

    foot.append(this.box, this.sendBtn)
    this.el.append(head, this.log, foot)
    this.empty()
  }

  private empty(): void {
    const hint = document.createElement('div')
    hint.className = 'ember-orch-empty'
    hint.textContent = 'Ask, or hand out work. It sees every session.'
    this.log.appendChild(hint)
  }

  private grow(): void {
    this.box.style.height = 'auto'
    this.box.style.height = `${Math.min(160, this.box.scrollHeight)}px`
  }

  private async submit(): Promise<void> {
    const text = this.box.value.trim()
    if (!text || this.busy) return
    this.box.value = ''
    this.grow()
    await this.hooks.onSend(text)
  }

  // ---------------------------------------------------------------- rendering

  /**
   * Paint the whole conversation.
   *
   * Rebuilt rather than appended because turns are *revised* — an agent turn grows tool
   * results as its loop runs, and a spoken turn is corrected when the final transcript
   * arrives. Diffing that costs more than redrawing a list nobody will ever scroll for
   * hours.
   */
  render(turns: Turn[], busy: boolean): void {
    this.busy = busy
    this.sendBtn.disabled = busy
    this.el.classList.toggle('is-busy', busy)

    this.log.textContent = ''
    if (!turns.length) {
      this.empty()
      return
    }

    for (const t of turns) {
      const row = document.createElement('div')
      row.className = `ember-orch-turn is-${t.who}${t.spoken ? ' is-spoken' : ''}`

      if (t.did?.length) {
        const did = document.createElement('div')
        did.className = 'ember-orch-did'
        did.textContent = t.did.join(' · ')
        row.appendChild(did)
      }

      const body = document.createElement('div')
      body.className = 'ember-orch-text'
      body.textContent = t.text
      row.appendChild(body)
      this.log.appendChild(row)
    }

    if (busy) {
      const think = document.createElement('div')
      think.className = 'ember-orch-turn is-agent is-thinking'
      think.textContent = 'working…'
      this.log.appendChild(think)
    }

    this.log.scrollTop = this.log.scrollHeight
  }

  /** The call, made visible. This panel is where its state actually lives on screen. */
  setCall(state: CallState, hearing: boolean, speaking: boolean): void {
    const live = state === 'live'
    this.el.classList.toggle('is-oncall', live)
    this.pill.className = `ember-orch-pill is-${state}`
    this.pill.textContent =
      state === 'live'
        ? hearing
          ? 'listening'
          : speaking
            ? 'speaking'
            : 'on a call'
        : state === 'connecting'
          ? 'connecting…'
          : state === 'failed'
            ? 'call failed'
            : ''
    this.callBtn.textContent = live || state === 'connecting' ? 'Hang up' : 'Call'
    this.callBtn.title = live || state === 'connecting' ? 'End the call  (Ctrl+Shift+L)' : 'Talk to it  (Ctrl+Shift+L)'
    this.callBtn.classList.toggle('is-live', live)
  }

  // ---------------------------------------------------------------- open/close

  get isOpen(): boolean {
    return this.open
  }

  show(): void {
    this.open = true
    this.el.classList.add('is-open')
    // The whole reason to open it is to type; landing the caret anywhere else would mean
    // a second action for something that should be one.
    window.setTimeout(() => this.box.focus(), 60)
  }

  hide(): void {
    this.open = false
    this.el.classList.remove('is-open')
  }

  toggle(): void {
    if (this.open) this.hide()
    else this.show()
  }
}
