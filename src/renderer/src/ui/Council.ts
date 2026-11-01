import { AGENTS, type AgentId, type AgentStatus } from '@shared/agents'
import type { CouncilEvent, CouncilRequest } from '@shared/types'

/**
 * The council sheet (docs/specs/providers.md §4): pick members, rounds and a chair, ask,
 * and watch them answer, debate and conclude — one card per member, the conclusion last.
 *
 * Main runs the rounds on its own clock. A note typed while it runs is sent as a second
 * `start` with the same id (main reads that as "the note for the next round"), so it
 * lands in whichever round begins after it is sent.
 */

type Phase = 'setup' | 'running' | 'done'

interface Seat {
  id: string
  /** round → text */
  said: Map<number, string>
  thinking: boolean
  error?: string
  /** Earlier rounds shown. */
  expanded: boolean
}

const name = (id: string) => AGENTS[id as AgentId]?.name ?? id
const vendor = (id: string) => AGENTS[id as AgentId]?.vendor ?? ''
const roundLabel = (r: number) => (r === 0 ? 'Opening' : `Round ${r}`)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** `**bold**` and `code` inline, built as nodes — the text is never parsed as HTML. */
function inline(into: HTMLElement, text: string): void {
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) into.appendChild(el('strong', undefined, part.slice(2, -2)))
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) into.appendChild(el('code', undefined, part.slice(1, -1)))
    else into.appendChild(document.createTextNode(part))
  }
}

/**
 * An agent's answer. They are asked for plain prose but often write a little markdown,
 * so headings become strong lines and bold/code render; everything else stays text.
 */
function prose(text: string, cls = 'ember-council-prose'): HTMLElement {
  const box = el('div', cls)
  for (const para of text.split(/\n\s*\n/)) {
    const t = para.trim()
    if (!t) continue
    const heading = /^#{1,6}\s+(.*)$/s.exec(t)
    const p = el('p', heading ? 'is-head' : undefined)
    inline(p, heading ? heading[1]!.replace(/\n/g, ' ') : t)
    box.appendChild(p)
  }
  return box
}

export class Council {
  readonly el: HTMLElement
  private readonly sheet: HTMLElement
  private readonly body: HTMLElement
  private readonly foot: HTMLElement
  private readonly titleEl: HTMLElement
  private opened = false
  private phase: Phase = 'setup'
  private cwd = ''

  // Setup
  private statuses: AgentStatus[] | null = null
  private question = ''
  private members = new Set<string>()
  private rounds = 1
  private chair = ''

  // A council
  private req: CouncilRequest | null = null
  private seats = new Map<string, Seat>()
  private status = ''
  private round = 0
  private conclusion: { member: string; text: string } | null = null
  private concluding = false
  private conclusionError = ''
  private note = ''
  private noteSent = ''
  private stopped = false
  private readonly entered = new Set<string>()

  constructor() {
    this.el = el('div', 'ember-council')
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-modal', 'true')
    this.el.setAttribute('aria-label', 'Council')
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close()
    })

    this.sheet = el('div', 'ember-council-sheet')
    const head = el('header', 'ember-council-head')
    this.titleEl = el('div', 'ember-council-title', 'Council')
    const close = el('button', 'ember-council-x')
    close.type = 'button'
    close.title = 'Close (Esc). A running council keeps going.'
    close.setAttribute('aria-label', 'Close')
    close.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
    close.addEventListener('click', () => this.close())
    head.append(this.titleEl, close)

    this.body = el('div', 'ember-council-body')
    this.foot = el('footer', 'ember-council-foot')
    this.sheet.append(head, this.body, this.foot)
    this.el.appendChild(this.sheet)

    document.addEventListener('keydown', (e) => {
      if (!this.opened) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.close()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && this.phase === 'setup') {
        e.preventDefault()
        this.start()
      }
    }, true)

    window.ember.council.onEvent((ev) => this.onEvent(ev))
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(cwd: string): void {
    if (this.phase === 'setup') this.cwd = cwd
    this.opened = true
    this.el.classList.add('is-open')
    this.render()
    if (this.phase === 'setup') {
      void this.detect()
      requestAnimationFrame(() => this.body.querySelector<HTMLTextAreaElement>('.ember-council-q')?.focus())
    }
  }

  close(): void {
    this.opened = false
    this.el.classList.remove('is-open')
  }

  // -------------------------------------------------------------------- setup

  private async detect(): Promise<void> {
    const list = await window.ember.agents.detect(false).catch(() => [] as AgentStatus[])
    const first = this.statuses === null
    this.statuses = list
    const installed = list.filter((s) => s.installed).map((s) => s.id as string)
    for (const m of [...this.members]) if (!installed.includes(m)) this.members.delete(m)
    if (first && !this.members.size) {
      for (const id of ['claude', 'codex']) if (installed.includes(id)) this.members.add(id)
      if (!this.members.size && installed[0]) this.members.add(installed[0])
    }
    this.fixChair()
    if (this.phase === 'setup') this.render()
  }

  private fixChair(): void {
    if (!this.members.has(this.chair)) this.chair = [...this.members][0] ?? ''
  }

  private orderedMembers(): string[] {
    return (this.statuses ?? []).filter((s) => this.members.has(s.id)).map((s) => s.id as string)
  }

  private canStart(): boolean {
    return !!this.question.trim() && this.members.size > 0
  }

  private start(): void {
    if (!this.canStart()) return
    this.fixChair()
    const req: CouncilRequest = {
      id: `council-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      question: this.question.trim(),
      members: this.orderedMembers(),
      rounds: this.rounds,
      chair: this.chair,
      cwd: this.cwd,
    }
    this.req = req
    this.seats = new Map(req.members.map((m) => [m, { id: m, said: new Map(), thinking: true, expanded: false }]))
    this.status = 'Starting…'
    this.round = 0
    this.conclusion = null
    this.concluding = false
    this.conclusionError = ''
    this.note = ''
    this.noteSent = ''
    this.stopped = false
    this.phase = 'running'
    window.ember.council.start(req)
    this.render()
  }

  private stop(): void {
    if (this.req && this.phase === 'running') {
      this.status = 'Stopping…'
      window.ember.council.stop(this.req.id)
      this.render()
    }
  }

  private reset(): void {
    this.phase = 'setup'
    this.req = null
    this.seats.clear()
    this.render()
    void this.detect()
  }

  private sendNote(): void {
    if (!this.req || this.phase !== 'running') return
    const text = this.note.trim()
    if (!text) return
    window.ember.council.start({ ...this.req, interject: text })
    this.noteSent = text
    this.note = ''
    this.render()
  }

  // -------------------------------------------------------------------- events

  private onEvent(ev: CouncilEvent): void {
    if (!this.req || ev.id !== this.req.id) return
    const seat = ev.member ? this.seats.get(ev.member) : undefined
    switch (ev.kind) {
      case 'status':
        if (ev.text) this.status = ev.text
        if (typeof ev.round === 'number' && ev.round > 0 && !ev.text?.startsWith('Only one')) {
          // A new round began: everyone still seated thinks, and the sent note was read.
          this.round = ev.round
          for (const s of this.seats.values()) if (!s.error) s.thinking = true
          if (ev.text?.includes('your note')) this.noteSent = ''
        } else if (ev.round === -1) {
          this.concluding = true
          for (const s of this.seats.values()) s.thinking = false
        }
        break
      case 'speak':
        if (seat && typeof ev.round === 'number' && ev.text) {
          seat.said.set(ev.round, ev.text)
          seat.thinking = false
        }
        break
      case 'error':
        if (ev.round === -1) {
          this.concluding = false
          this.conclusionError = ev.text ?? 'No conclusion.'
        } else if (seat) {
          seat.error = ev.text ?? 'failed'
          seat.thinking = false
        } else if (ev.text) this.status = ev.text
        break
      case 'conclusion':
        this.concluding = false
        if (ev.text) this.conclusion = { member: ev.member ?? this.req.chair, text: ev.text }
        break
      case 'done':
        this.phase = 'done'
        this.stopped = ev.text === 'stopped'
        this.concluding = false
        for (const s of this.seats.values()) s.thinking = false
        if (!this.stopped && this.conclusion) this.status = 'Done.'
        break
    }
    if (this.opened) this.render()
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    this.titleEl.textContent = this.phase === 'setup' ? 'Council' : this.phase === 'running' ? 'Council in session' : 'Council'
    if (this.phase === 'setup') this.renderSetup()
    else this.renderRun()
  }

  private renderSetup(): void {
    const form = el('div', 'ember-council-setup')

    const qLabel = el('label', 'ember-council-label', 'Question')
    const q = el('textarea', 'ember-council-q')
    q.id = 'ember-council-q'
    qLabel.htmlFor = q.id
    q.rows = 4
    q.placeholder = 'What should the council weigh? Questions about this folder are fine: they can read it, not change it.'
    q.value = this.question
    q.addEventListener('input', () => {
      this.question = q.value
      go.disabled = !this.canStart()
    })
    const where = el('div', 'ember-council-hint', this.cwd ? `Reads ${this.cwd}` : 'Reads your home folder')

    // Members
    const mLabel = el('div', 'ember-council-label', 'Members')
    const chips = el('div', 'ember-council-members')
    chips.setAttribute('role', 'group')
    chips.setAttribute('aria-label', 'Members')
    const installed = (this.statuses ?? []).filter((s) => s.installed)
    if (this.statuses === null) chips.appendChild(el('span', 'ember-council-hint', 'Looking for agents…'))
    else if (!installed.length) chips.appendChild(el('span', 'ember-council-hint', 'No agent CLIs found. Settings › Agent can install one.'))
    else if (installed.length === 1) chips.appendChild(el('span', 'ember-council-hint', 'A council needs two agents to debate. Settings › Agent installs another in a minute.'))
    for (const s of installed) {
      const b = el('button', 'ember-council-member')
      b.type = 'button'
      b.setAttribute('aria-pressed', String(this.members.has(s.id)))
      b.append(el('span', 'ember-council-member-name', name(s.id)), el('span', 'ember-council-member-vendor', vendor(s.id)))
      b.addEventListener('click', () => {
        if (this.members.has(s.id)) this.members.delete(s.id)
        else this.members.add(s.id)
        this.fixChair()
        this.renderSetup()
      })
      chips.appendChild(b)
    }

    // Rounds and chair
    const row = el('div', 'ember-council-row')
    const rBox = el('div', 'ember-council-field')
    rBox.appendChild(el('div', 'ember-council-label', 'Rounds of debate'))
    const stepper = el('div', 'ember-council-stepper')
    const minus = el('button', 'ember-council-step', '−')
    const plus = el('button', 'ember-council-step', '+')
    minus.type = plus.type = 'button'
    minus.setAttribute('aria-label', 'Fewer rounds')
    plus.setAttribute('aria-label', 'More rounds')
    const val = el('span', 'ember-council-step-val', String(this.rounds))
    val.setAttribute('aria-live', 'polite')
    minus.disabled = this.rounds <= 0
    plus.disabled = this.rounds >= 3
    minus.addEventListener('click', () => {
      this.rounds = Math.max(0, this.rounds - 1)
      this.renderSetup()
    })
    plus.addEventListener('click', () => {
      this.rounds = Math.min(3, this.rounds + 1)
      this.renderSetup()
    })
    stepper.append(minus, val, plus)
    rBox.append(stepper, el('div', 'ember-council-hint', this.rounds === 0 ? 'Opening positions only' : `${this.rounds} after the openings`))

    const cBox = el('div', 'ember-council-field')
    const cLabel = el('label', 'ember-council-label', 'Chair')
    const chair = el('select', 'ember-council-select')
    chair.id = 'ember-council-chair'
    cLabel.htmlFor = chair.id
    for (const id of this.orderedMembers()) {
      const o = el('option', undefined, name(id))
      o.value = id
      o.selected = id === this.chair
      chair.appendChild(o)
    }
    chair.disabled = this.members.size === 0
    chair.addEventListener('change', () => (this.chair = chair.value))
    cBox.append(cLabel, chair, el('div', 'ember-council-hint', 'Writes the conclusion'))
    row.append(rBox, cBox)

    form.append(qLabel, q, where, mLabel, chips, row)
    this.body.replaceChildren(form)

    const go = el('button', 'ember-council-btn is-primary', 'Start')
    go.type = 'button'
    go.title = 'Start (Ctrl+Enter)'
    go.disabled = !this.canStart()
    go.addEventListener('click', () => this.start())
    const note = el('span', 'ember-council-hint', 'Read-only. Each agent runs on its own sign-in.')
    this.foot.replaceChildren(note, go)
  }

  private renderRun(): void {
    const req = this.req!
    const keepScroll = this.body.scrollTop
    // Events repaint the sheet; whoever is typing a note keeps their caret.
    const active = document.activeElement
    const typing = active instanceof HTMLTextAreaElement && active.classList.contains('ember-council-note-input')
    const caret = typing ? [active.selectionStart, active.selectionEnd] : null
    const wrap = el('div', 'ember-council-run')

    const q = el('div', 'ember-council-question', req.question)
    const line = el('div', 'ember-council-status')
    line.setAttribute('aria-live', 'polite')
    if (this.phase === 'running') line.appendChild(el('span', 'ember-council-spin'))
    line.appendChild(el('span', undefined, this.status))

    const grid = el('div', 'ember-council-grid')
    for (const id of req.members) grid.appendChild(this.card(this.seats.get(id)!))

    wrap.append(q, line, grid)

    // A note for the next round, while there is one still to come.
    if (this.phase === 'running' && req.rounds > 0 && this.round < req.rounds && !this.concluding) {
      const box = el('div', 'ember-council-note')
      const ta = el('textarea', 'ember-council-note-input')
      ta.rows = 2
      ta.placeholder = 'Add a note for the next round'
      ta.setAttribute('aria-label', 'Add a note for the next round')
      ta.value = this.note
      const send = el('button', 'ember-council-btn', 'Add note')
      send.type = 'button'
      send.disabled = !this.note.trim()
      ta.addEventListener('input', () => {
        this.note = ta.value
        send.disabled = !ta.value.trim()
      })
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          this.sendNote()
        }
      })
      send.addEventListener('click', () => this.sendNote())
      const hint = el(
        'div',
        'ember-council-hint',
        this.noteSent ? `Everyone reads this in round ${this.round + 1}: “${this.noteSent}”` : `Everyone reads it in round ${this.round + 1}.`
      )
      const r = el('div', 'ember-council-note-row')
      r.append(ta, send)
      box.append(r, hint)
      wrap.appendChild(box)
    }

    if (this.concluding || this.conclusion || this.conclusionError) wrap.appendChild(this.conclusionCard())

    this.body.replaceChildren(wrap)
    this.body.scrollTop = keepScroll
    if (caret) {
      const ta = this.body.querySelector<HTMLTextAreaElement>('.ember-council-note-input')
      ta?.focus()
      ta?.setSelectionRange(caret[0], caret[1])
    }

    const btns: HTMLElement[] = []
    if (this.phase === 'running') {
      const stop = el('button', 'ember-council-btn', 'Stop')
      stop.type = 'button'
      stop.addEventListener('click', () => this.stop())
      btns.push(stop)
    } else {
      const again = el('button', 'ember-council-btn is-primary', 'New council')
      again.type = 'button'
      again.addEventListener('click', () => this.reset())
      btns.push(again)
    }
    const meta = el(
      'span',
      'ember-council-hint',
      `${req.members.length} ${req.members.length === 1 ? 'member' : 'members'} · ${req.rounds} ${req.rounds === 1 ? 'round' : 'rounds'} · chaired by ${name(req.chair)}`
    )
    this.foot.replaceChildren(meta, ...btns)
  }

  private card(seat: Seat): HTMLElement {
    const card = el('article', 'ember-council-card')
    // Enter once; later repaints of the same card must not replay it.
    const key = `${this.req?.id}:${seat.id}`
    if (!this.entered.has(key)) {
      this.entered.add(key)
      card.classList.add('is-new')
    }
    card.classList.toggle('is-thinking', seat.thinking)
    card.classList.toggle('is-error', !!seat.error)

    const head = el('header', 'ember-council-card-head')
    const who = el('div', 'ember-council-who')
    who.append(el('span', 'ember-council-who-name', name(seat.id)), el('span', 'ember-council-who-vendor', vendor(seat.id)))
    const chips = el('div', 'ember-council-chips')
    const rounds = [...seat.said.keys()].sort((a, b) => a - b)
    for (const r of rounds) chips.appendChild(el('span', 'ember-council-chip', r === 0 ? 'Open' : `R${r}`))
    if (seat.thinking) chips.appendChild(el('span', 'ember-council-chip is-live', this.round === 0 ? 'Open' : `R${this.round}`))
    head.append(who, chips)
    card.appendChild(head)

    const latest = rounds[rounds.length - 1]
    if (seat.thinking) {
      const t = el('div', 'ember-council-thinking')
      t.append(el('span', 'ember-council-spin'), el('span', undefined, latest === undefined ? 'Thinking…' : 'Reading the others…'))
      card.appendChild(t)
    }
    if (latest !== undefined) {
      if (!seat.thinking) card.appendChild(el('div', 'ember-council-round', roundLabel(latest)))
      card.appendChild(prose(seat.said.get(latest)!))
    }
    if (seat.error) card.appendChild(el('div', 'ember-council-err', seat.error))

    const earlier = rounds.slice(0, -1)
    if (earlier.length) {
      const toggle = el('button', 'ember-council-more', seat.expanded ? 'Hide earlier rounds' : `Earlier rounds (${earlier.length})`)
      toggle.type = 'button'
      toggle.setAttribute('aria-expanded', String(seat.expanded))
      toggle.addEventListener('click', () => {
        seat.expanded = !seat.expanded
        this.render()
      })
      card.appendChild(toggle)
      if (seat.expanded) {
        const past = el('div', 'ember-council-past')
        for (const r of [...earlier].reverse()) {
          past.append(el('div', 'ember-council-round', roundLabel(r)), prose(seat.said.get(r)!))
        }
        card.appendChild(past)
      }
    }
    return card
  }

  private conclusionCard(): HTMLElement {
    const card = el('section', 'ember-council-conclusion')
    const key = `${this.req?.id}:conclusion`
    if (!this.entered.has(key)) {
      this.entered.add(key)
      card.classList.add('is-new')
    }
    const head = el('header', 'ember-council-card-head')
    const who = el('div', 'ember-council-who')
    who.append(
      el('span', 'ember-council-who-name', 'Conclusion'),
      el('span', 'ember-council-who-vendor', `by ${name(this.conclusion?.member ?? this.req!.chair)}`)
    )
    head.appendChild(who)
    card.appendChild(head)
    if (this.concluding) {
      const t = el('div', 'ember-council-thinking')
      t.append(el('span', 'ember-council-spin'), el('span', undefined, 'Writing the conclusion…'))
      card.appendChild(t)
    } else if (this.conclusion) {
      card.appendChild(prose(this.conclusion.text))
      const actions = el('div', 'ember-council-actions')
      const copy = el('button', 'ember-council-btn', 'Copy')
      copy.type = 'button'
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(this.conclusion!.text).then(() => {
          copy.textContent = 'Copied'
          setTimeout(() => (copy.textContent = 'Copy'), 1400)
        })
      })
      const canvas = el('button', 'ember-council-btn', 'Put on canvas')
      canvas.type = 'button'
      canvas.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('ember:council:canvas', { detail: this.toMarkdown() }))
        canvas.textContent = 'On the canvas'
        canvas.disabled = true
      })
      actions.append(copy, canvas)
      card.appendChild(actions)
    }
    if (this.conclusionError) card.appendChild(el('div', 'ember-council-err', this.conclusionError))
    return card
  }

  /** The council as a canvas document: question, conclusion, then each member's last word. */
  private toMarkdown(): { title: string; markdown: string } {
    const req = this.req!
    const short = req.question.replace(/\s+/g, ' ').trim()
    const title = `Council: ${short.length > 60 ? `${short.slice(0, 59)}…` : short}`
    const parts = [`**Question.** ${req.question.trim()}`, '']
    if (this.conclusion) parts.push(`## Conclusion`, `*${name(this.conclusion.member)}, chair*`, '', this.conclusion.text, '')
    parts.push('## Positions', '')
    for (const id of req.members) {
      const seat = this.seats.get(id)
      if (!seat) continue
      const rounds = [...seat.said.keys()].sort((a, b) => a - b)
      const last = rounds[rounds.length - 1]
      parts.push(`### ${name(id)}`)
      if (last === undefined) parts.push(seat.error ? `*Did not answer: ${seat.error}*` : '*No answer.*', '')
      else parts.push(`*${roundLabel(last)}*`, '', seat.said.get(last)!, '')
    }
    return { title, markdown: parts.join('\n').trim() }
  }
}
