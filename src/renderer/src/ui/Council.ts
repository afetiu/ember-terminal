import { AGENTS, type AgentId, type AgentStatus } from '@shared/agents'
import type { CouncilEvent, CouncilRequest } from '@shared/types'

/**
 * The council (docs/specs/providers.md §4), laid out as a canvas page: a calm stage that
 * shows the question, each round's answers as glass cards side by side, and the chair's
 * conclusion last; and one composer docked at the bottom, framed like the canvas input,
 * with the members, rounds and chair as chips under the text.
 *
 * Main runs the rounds on its own clock. Typing in the composer while it runs is a note:
 * it is sent as a second `start` with the same id (main reads that as "the note for the
 * next round"), so it lands in whichever round begins after it is sent.
 */

type Phase = 'setup' | 'running' | 'done'

interface Seat {
  id: string
  /** round → text */
  said: Map<number, string>
  thinking: boolean
  error?: string
  /** The round the error happened in. */
  errorRound?: number
}

/** The session that asked, when the council was invited from one. */
export interface CouncilOrigin {
  tabId: string
  name: string
}

const name = (id: string) => AGENTS[id as AgentId]?.name ?? id
const vendor = (id: string) => AGENTS[id as AgentId]?.vendor ?? ''
const roundLabel = (r: number) => (r === 0 ? 'Opening' : `Round ${r}`)
const sectionLabel = (r: number) => (r === 0 ? 'Openings' : `Round ${r}`)
const roundsLabel = (n: number) => (n === 0 ? 'Openings only' : `${n} ${n === 1 ? 'round' : 'rounds'}`)
const MAX_ROUNDS = 3

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

const CHEVRON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ARROW =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5v-9M3 6l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SQUARE = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'

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
  // Line by line: headings, bulleted and numbered lists, and runs of ordinary lines as
  // paragraphs. Lists were the gap — "- a - b - c" ran together into one paragraph.
  let para: string[] = []
  let list: HTMLElement | null = null
  const flushPara = () => {
    const t = para.join(' ').trim()
    para = []
    if (!t) return
    const p = el('p')
    inline(p, t)
    box.appendChild(p)
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const bullet = /^[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      const tag = bullet ? 'ul' : 'ol'
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = el(tag, 'ember-council-list')
        box.appendChild(list)
      }
      const li = el('li')
      inline(li, (bullet ?? numbered)![1]!)
      list.appendChild(li)
      continue
    }
    list = null
    if (!line) {
      flushPara()
      continue
    }
    if (heading) {
      flushPara()
      const p = el('p', 'is-head')
      inline(p, heading[1]!)
      box.appendChild(p)
      continue
    }
    para.push(line)
  }
  flushPara()
  return box
}

export class Council {
  readonly el: HTMLElement
  private readonly stage: HTMLElement
  private readonly flow: HTMLElement
  private readonly frame: HTMLElement
  private readonly input: HTMLTextAreaElement
  private readonly tools: HTMLElement
  private readonly bar: HTMLElement
  private opened = false
  private phase: Phase = 'setup'
  private cwd = ''
  private origin: CouncilOrigin | null = null

  // Setup
  private statuses: AgentStatus[] | null = null
  private detecting: Promise<void> | null = null
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
  /** Sent, not yet read by a round. Main keeps only the last one sent. */
  private notePending = ''
  /** round → the note that round read */
  private notes = new Map<number, string>()
  private stopped = false
  private questionOpen = false
  /** `${round}:${member}` cards from earlier rounds shown in full. */
  private readonly unfolded = new Set<string>()
  private readonly entered = new Set<string>()

  constructor() {
    this.el = el('div', 'ember-council')
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', 'Council')
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el && !this.el.classList.contains('is-tab')) this.close()
    })

    // Overlay mode only; as a tab, the tab's own close does this.
    const close = button('ember-council-x', '', () => this.close())
    close.title = 'Close (Esc). A running council keeps going.'
    close.setAttribute('aria-label', 'Close')
    close.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'

    // The stage.
    this.stage = el('div', 'ember-council-stage')
    this.flow = el('div', 'ember-council-flow')
    this.stage.appendChild(this.flow)

    // The composer: one input, framed like the canvas input, the settings as chips in it.
    const dock = el('div', 'ember-council-dock')
    this.frame = el('div', 'ember-council-frame')
    this.input = el('textarea', 'ember-council-input')
    this.input.rows = 1
    this.input.setAttribute('aria-label', 'Question for the council')
    this.input.addEventListener('input', () => this.onType())
    this.input.addEventListener('keydown', (e) => this.onInputKey(e))
    this.input.addEventListener('focus', () => this.frame.classList.add('is-focus'))
    this.input.addEventListener('blur', () => this.frame.classList.remove('is-focus'))
    this.tools = el('div', 'ember-council-tools')
    this.frame.append(this.input, this.tools)
    // A click on the frame's empty space is a click in the input.
    this.frame.addEventListener('mousedown', (e) => {
      if (e.target === this.frame || e.target === this.tools) {
        e.preventDefault()
        this.input.focus()
      }
    })
    this.bar = el('div', 'ember-council-bar')
    dock.append(this.frame, this.bar)

    this.el.append(close, this.stage, dock)

    document.addEventListener(
      'keydown',
      (e) => {
        // Only while it is on screen: as a tab, it sits in the stack behind other tabs.
        if (!this.opened || this.el.offsetParent === null) return
        if (e.key === 'Escape') {
          if (this.el.classList.contains('is-tab')) return
          e.preventDefault()
          e.stopPropagation()
          this.close()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && this.phase !== 'running') {
          e.preventDefault()
          this.start()
        }
      },
      true
    )

    window.ember.council.onEvent((ev) => this.onEvent(ev))
    this.render()
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(cwd: string): void {
    if (this.phase !== 'running') this.cwd = cwd
    this.opened = true
    this.el.classList.add('is-open')
    this.render()
    if (this.phase !== 'running') void this.detect()
    requestAnimationFrame(() => {
      if (!this.input.disabled) this.input.focus()
    })
  }

  close(): void {
    // A tab closes the way every tab does; the council inside it stays.
    if (this.el.classList.contains('is-tab')) return
    this.opened = false
    this.el.classList.remove('is-open')
  }

  /**
   * Ask from a session: open, fill the question, and start at once with the default
   * members, rounds and chair. The conclusion can then be sent back to `origin`.
   */
  startWith(question: string, cwd: string, origin?: CouncilOrigin): void {
    if (this.phase === 'running' && this.req) window.ember.council.stop(this.req.id)
    this.phase = 'setup'
    this.req = null
    this.seats.clear()
    this.origin = origin ?? null
    this.question = question
    this.open(cwd)
    void this.detect().then(() => {
      this.defaults()
      this.start(true)
    })
  }

  // -------------------------------------------------------------------- setup

  private detect(): Promise<void> {
    this.detecting ??= (async () => {
      const list = await window.ember.agents.detect(false).catch(() => [] as AgentStatus[])
      const first = this.statuses === null
      this.statuses = list
      const installed = this.installed()
      for (const m of [...this.members]) if (!installed.includes(m)) this.members.delete(m)
      if (first && !this.members.size) this.defaults()
      this.fixChair()
      this.detecting = null
      if (this.phase !== 'running') this.renderComposer()
    })()
    return this.detecting
  }

  private installed(): string[] {
    return (this.statuses ?? []).filter((s) => s.installed).map((s) => s.id as string)
  }

  /** Claude Code and Codex when they are there, else the first agent found; one round. */
  private defaults(): void {
    const installed = this.installed()
    this.members.clear()
    for (const id of ['claude', 'codex']) if (installed.includes(id)) this.members.add(id)
    if (!this.members.size && installed[0]) this.members.add(installed[0])
    this.rounds = 1
    this.chair = ''
    this.fixChair()
  }

  private fixChair(): void {
    if (!this.members.has(this.chair)) this.chair = this.orderedMembers()[0] ?? [...this.members][0] ?? ''
  }

  private orderedMembers(): string[] {
    return (this.statuses ?? []).filter((s) => this.members.has(s.id)).map((s) => s.id as string)
  }

  private canStart(): boolean {
    return !!this.question.trim() && this.members.size > 0
  }

  /** `fromSession`: started by `startWith`, so the origin stays; a council you start here has none. */
  private start(fromSession = false): void {
    if (this.phase === 'running' || !this.canStart()) return
    if (!fromSession) this.origin = null
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
    this.seats = new Map(req.members.map((m) => [m, { id: m, said: new Map(), thinking: true }]))
    this.status = 'Starting…'
    this.round = 0
    this.conclusion = null
    this.concluding = false
    this.conclusionError = ''
    this.note = ''
    this.notePending = ''
    this.notes.clear()
    this.unfolded.clear()
    this.stopped = false
    this.questionOpen = false
    this.question = ''
    this.phase = 'running'
    window.ember.council.start(req)
    this.stage.scrollTop = 0
    this.render()
  }

  private stop(): void {
    if (this.req && this.phase === 'running') {
      this.status = 'Stopping…'
      window.ember.council.stop(this.req.id)
      this.render()
    }
  }

  /** New council: back to the empty stage, the composer ready. */
  private reset(): void {
    this.phase = 'setup'
    this.req = null
    this.origin = null
    this.seats.clear()
    this.question = ''
    this.render()
    void this.detect()
    this.input.focus()
  }

  /** Whether a note typed now still reaches a round. */
  private canNote(): boolean {
    const req = this.req
    return !!req && this.phase === 'running' && req.rounds > 0 && this.round < req.rounds && !this.concluding
  }

  private sendNote(): void {
    if (!this.req || !this.canNote()) return
    const text = this.note.trim()
    if (!text) return
    window.ember.council.start({ ...this.req, interject: text })
    this.notePending = text
    this.note = ''
    this.render()
  }

  // -------------------------------------------------------------------- the composer

  private onType(): void {
    if (this.phase === 'running') this.note = this.input.value
    else this.question = this.input.value
    this.grow()
    this.renderAction()
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    // Ctrl+Enter is the document-level handler's.
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    if (this.phase === 'running') this.sendNote()
    else this.start()
  }

  /** The input grows with what is typed, up to a third of the page. */
  private grow(): void {
    const ta = this.input
    ta.style.height = 'auto'
    const max = Math.max(120, Math.round((this.el.clientHeight || window.innerHeight) * 0.34))
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'
  }

  private renderComposer(): void {
    const running = this.phase === 'running'
    const value = running ? this.note : this.question
    if (this.input.value !== value) this.input.value = value

    if (running) {
      const noting = this.canNote()
      this.input.disabled = !noting
      this.input.placeholder = noting
        ? `Add a note for round ${this.round + 1}…`
        : this.concluding
          ? 'The chair is writing the conclusion…'
          : 'This is the last round; the chair concludes next.'
      this.input.setAttribute('aria-label', 'Add a note for the next round')
    } else {
      this.input.disabled = false
      this.input.placeholder = this.phase === 'done' ? 'Ask the council another question…' : 'Ask the council a question…'
      this.input.setAttribute('aria-label', 'Question for the council')
    }
    this.frame.classList.toggle('is-running', running)
    this.frame.classList.toggle('is-disabled', this.input.disabled)
    this.renderTools()
    this.renderBar()
    this.grow()
  }

  private renderTools(): void {
    // A rebuilt chip keeps the keyboard focus it had.
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key
    const left = el('div', 'ember-council-chips')
    if (this.phase === 'running' && this.req) {
      const req = this.req
      left.appendChild(
        el(
          'span',
          'ember-council-summary',
          `${req.members.map(name).join(', ')} · ${roundsLabel(req.rounds)} · chaired by ${name(req.chair)}`
        )
      )
    } else {
      left.setAttribute('role', 'group')
      left.setAttribute('aria-label', 'Members, rounds and chair')
      const installed = (this.statuses ?? []).filter((s) => s.installed)
      if (this.statuses === null) left.appendChild(el('span', 'ember-council-summary', 'Looking for agents…'))
      else if (!installed.length) left.appendChild(el('span', 'ember-council-summary', 'No agent CLIs found. Settings › Agent can install one.'))
      for (const s of installed) {
        const on = this.members.has(s.id)
        const b = button('ember-council-chip is-member', '', () => {
          if (this.members.has(s.id)) this.members.delete(s.id)
          else this.members.add(s.id)
          this.fixChair()
          this.renderComposer()
        })
        b.dataset.key = `m:${s.id}`
        b.setAttribute('aria-pressed', String(on))
        b.title = `${on ? 'Remove' : 'Add'} ${name(s.id)} (${vendor(s.id)})`
        b.append(el('span', 'ember-council-chip-dot'), el('span', undefined, name(s.id)))
        left.appendChild(b)
      }
      if (installed.length) {
        left.appendChild(
          this.selectChip(
            'r',
            'Rounds of debate after the openings',
            '',
            Array.from({ length: MAX_ROUNDS + 1 }, (_, n) => ({ value: String(n), label: roundsLabel(n) })),
            String(this.rounds),
            (v) => (this.rounds = Math.max(0, Math.min(MAX_ROUNDS, Number(v) || 0)))
          )
        )
        const chairs = this.orderedMembers()
        const chair = this.selectChip(
          'c',
          'Chair: writes the conclusion',
          'Chair',
          chairs.map((id) => ({ value: id, label: name(id) })),
          this.chair,
          (v) => (this.chair = v)
        )
        if (!chairs.length) chair.classList.add('is-disabled')
        left.appendChild(chair)
      }
      if (installed.length === 1) left.appendChild(el('span', 'ember-council-summary', 'Two agents make a debate; Settings › Agent installs another.'))
    }
    const right = el('div', 'ember-council-acts')
    this.tools.replaceChildren(left, right)
    this.renderAction()
    if (focusKey) this.tools.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus()
  }

  /** A native select dressed as a chip: keyboard and screen readers get the real thing. */
  private selectChip(
    key: string,
    label: string,
    prefix: string,
    options: Array<{ value: string; label: string }>,
    value: string,
    onChange: (v: string) => void
  ): HTMLElement {
    const chip = el('label', 'ember-council-chip is-select')
    chip.title = label
    if (prefix) chip.appendChild(el('span', 'ember-council-chip-pre', prefix))
    const sel = el('select')
    sel.dataset.key = key
    sel.setAttribute('aria-label', label)
    for (const o of options) {
      const opt = el('option', undefined, o.label)
      opt.value = o.value
      opt.selected = o.value === value
      sel.appendChild(opt)
    }
    sel.disabled = !options.length
    sel.addEventListener('change', () => {
      onChange(sel.value)
      this.renderComposer()
    })
    const chev = el('span', 'ember-council-chip-chev')
    chev.innerHTML = CHEVRON
    chip.append(sel, chev)
    return chip
  }

  /** The button at the end of the frame: Start, Add note, Stop, New council. */
  private renderAction(): void {
    const acts = this.tools.querySelector('.ember-council-acts')
    if (!acts) return
    const btns: HTMLElement[] = []
    if (this.phase === 'running') {
      if (this.canNote()) {
        const add = button('ember-council-btn', 'Add note', () => this.sendNote())
        add.disabled = !this.note.trim()
        btns.push(add)
      }
      const stop = button('ember-council-btn is-stop', '', () => this.stop())
      stop.innerHTML = `${SQUARE}<span>Stop</span>`
      stop.title = 'Stop the council'
      stop.disabled = this.status === 'Stopping…'
      btns.push(stop)
    } else {
      if (this.phase === 'done') btns.push(button('ember-council-btn', 'New council', () => this.reset()))
      const go = button('ember-council-go', '', () => this.start())
      go.innerHTML = ARROW
      go.title = 'Start (Enter)'
      go.setAttribute('aria-label', 'Start the council')
      go.disabled = !this.canStart()
      btns.push(go)
    }
    acts.replaceChildren(...btns)
  }

  private renderBar(): void {
    const where = this.cwd ? `reads ${this.cwd}` : 'reads your home folder'
    const left = el('span', 'ember-council-bar-info', `Read-only · each agent runs on its own sign-in · ${where}`)
    left.title = left.textContent ?? ''
    let keys: string
    if (this.phase === 'running') keys = this.canNote() ? '↵ add note · ⇧↵ new line' : ''
    else keys = '↵ start · ⇧↵ new line'
    const right = el('span', 'ember-council-bar-keys', keys)
    this.bar.replaceChildren(left, right)
  }

  // -------------------------------------------------------------------- events

  private onEvent(ev: CouncilEvent): void {
    if (!this.req || ev.id !== this.req.id) return
    const seat = ev.member ? this.seats.get(ev.member) : undefined
    switch (ev.kind) {
      case 'status':
        if (ev.text) this.status = ev.text
        if (typeof ev.round === 'number' && ev.round > 0 && !ev.text?.startsWith('Only one')) {
          // A new round began: everyone still seated thinks, and a sent note was read.
          this.round = ev.round
          for (const s of this.seats.values()) if (!s.error) s.thinking = true
          if (ev.text?.includes('your note') && this.notePending) {
            this.notes.set(ev.round, this.notePending)
            this.notePending = ''
          }
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
          seat.errorRound = typeof ev.round === 'number' ? ev.round : this.round
          seat.thinking = false
        } else if (ev.text) this.status = ev.text
        break
      case 'conclusion':
        this.concluding = false
        if (ev.text) this.conclusion = { member: ev.member ?? this.req.chair, text: ev.text }
        break
      case 'done': {
        this.phase = 'done'
        this.stopped = ev.text === 'stopped'
        this.concluding = false
        for (const s of this.seats.values()) s.thinking = false
        if (!this.stopped && this.conclusion) this.status = 'Done.'
        // Whatever was typed as a note is kept, as the start of the next question.
        this.question = this.note
        this.note = ''
        break
      }
    }
    this.render()
  }

  // -------------------------------------------------------------------- the stage

  private render(): void {
    this.el.classList.toggle('is-empty', !this.req)
    this.renderStage()
    this.renderComposer()
  }

  private renderStage(): void {
    const s = this.stage
    // Follow the council down while you are at the bottom; leave you where you are if you scrolled up to read.
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 48
    const keep = s.scrollTop

    if (!this.req) {
      const empty = el('div', 'ember-council-empty')
      empty.append(
        el('div', 'ember-council-empty-title', 'Council'),
        el('p', 'ember-council-empty-line', 'Ask a question below — your agents answer, read each other, and the chair concludes.')
      )
      this.flow.replaceChildren(empty)
      return
    }

    const req = this.req
    const parts: HTMLElement[] = [this.questionLine(req)]

    const last = this.round
    for (let r = 0; r <= last; r++) {
      const sec = this.roundSection(r, r < last || !!this.conclusion || this.concluding)
      if (sec) parts.push(sec)
    }
    if (this.notePending) {
      const n = this.noteLine(this.notePending, `Read in round ${this.round + 1}`)
      n.classList.add('is-pending')
      parts.push(n)
    }

    if (this.concluding || this.conclusion || this.conclusionError) parts.push(this.conclusionSection())

    // The live line, the canvas's "now": what the council is doing, while nothing else says it.
    const showStatus = this.phase === 'running' ? !this.concluding : !this.conclusion && !!this.status
    if (showStatus && this.status) {
      const line = el('div', 'ember-council-now')
      line.setAttribute('role', 'status')
      if (this.phase === 'running') line.appendChild(el('span', 'ember-council-spin'))
      line.appendChild(el('span', undefined, this.stopped ? 'Stopped.' : this.status))
      parts.push(line)
    }

    this.flow.replaceChildren(...parts)
    s.scrollTop = atBottom ? s.scrollHeight : keep
  }

  /** The question, as your line of the turn: small, dim, folded when it is long. */
  private questionLine(req: CouncilRequest): HTMLElement {
    const box = el('div', 'ember-council-ask')
    this.enterOnce(box, `${req.id}:q`)
    box.appendChild(el('span', 'ember-council-ask-dot'))
    const text = el('div', 'ember-council-ask-text', req.question)
    const long = req.question.length > 360 || req.question.split('\n').length > 4
    if (long && !this.questionOpen) text.classList.add('is-clamped')
    const body = el('div', 'ember-council-ask-body')
    body.appendChild(text)
    if (long) {
      const more = button('ember-council-more', this.questionOpen ? 'Show less' : 'Show all', () => {
        this.questionOpen = !this.questionOpen
        this.renderStage()
      })
      more.setAttribute('aria-expanded', String(this.questionOpen))
      body.appendChild(more)
    }
    box.appendChild(body)
    return box
  }

  private noteLine(text: string, label: string): HTMLElement {
    const line = el('div', 'ember-council-ask is-note')
    line.append(el('span', 'ember-council-ask-dot'))
    const body = el('div', 'ember-council-ask-body')
    body.append(el('span', 'ember-council-note-tag', label), el('div', 'ember-council-ask-text', text))
    line.appendChild(body)
    return line
  }

  /** A round: its label as a seam, the note it read, the members' answers side by side. */
  private roundSection(r: number, past: boolean): HTMLElement | null {
    const req = this.req!
    const ids = req.members.filter((id) => {
      const s = this.seats.get(id)!
      return s.said.has(r) || (s.thinking && this.round === r) || (s.error !== undefined && s.errorRound === r)
    })
    const note = this.notes.get(r)
    if (!ids.length && !note) return null
    const sec = el('section', 'ember-council-round')
    sec.setAttribute('aria-label', sectionLabel(r))
    const seam = el('h3', 'ember-council-seam', sectionLabel(r))
    this.enterOnce(seam, `${req.id}:r${r}`)
    sec.appendChild(seam)
    if (note) sec.appendChild(this.noteLine(note, 'Your note'))
    const grid = el('div', 'ember-council-grid')
    grid.dataset.n = String(Math.min(ids.length, 3))
    ids.forEach((id, i) => grid.appendChild(this.card(this.seats.get(id)!, r, past, i)))
    sec.appendChild(grid)
    return sec
  }

  private card(seat: Seat, r: number, past: boolean, i: number): HTMLElement {
    const card = el('article', 'ember-council-card')
    // Enter once; later repaints of the same card must not replay it.
    if (this.enterOnce(card, `${this.req?.id}:${r}:${seat.id}`)) card.style.animationDelay = `${i * 60}ms`
    const text = seat.said.get(r)
    const thinking = text === undefined && seat.thinking && this.round === r
    const error = text === undefined && seat.errorRound === r ? seat.error : undefined
    card.classList.toggle('is-thinking', thinking)
    card.classList.toggle('is-error', !!error)

    const head = el('header', 'ember-council-card-head')
    const who = el('div', 'ember-council-who')
    who.append(el('span', 'ember-council-who-name', name(seat.id)), el('span', 'ember-council-who-vendor', vendor(seat.id)))
    head.appendChild(who)
    if (thinking) head.appendChild(el('span', 'ember-council-spin'))
    card.appendChild(head)

    if (thinking) {
      const t = el('div', 'ember-council-thinking')
      t.setAttribute('aria-label', r === 0 ? 'Thinking' : 'Reading the others')
      for (let k = 0; k < 3; k++) t.appendChild(el('span', 'ember-council-shimmer'))
      card.append(t, el('div', 'ember-council-thinking-label', r === 0 ? 'Thinking…' : 'Reading the others…'))
    } else if (text !== undefined) {
      const key = `${r}:${seat.id}`
      const folded = past && !this.unfolded.has(key) && text.length > 420
      const p = prose(text)
      if (folded) p.classList.add('is-clamped')
      card.appendChild(p)
      if (past && text.length > 420) {
        const more = button('ember-council-more', folded ? 'Show all' : 'Show less', () => {
          if (this.unfolded.has(key)) this.unfolded.delete(key)
          else this.unfolded.add(key)
          this.renderStage()
        })
        more.setAttribute('aria-expanded', String(!folded))
        card.appendChild(more)
      }
    }
    if (error) card.appendChild(el('div', 'ember-council-err', error))
    return card
  }

  private conclusionSection(): HTMLElement {
    const sec = el('section', 'ember-council-round is-conclusion')
    const seam = el('h3', 'ember-council-seam', 'Conclusion')
    this.enterOnce(seam, `${this.req?.id}:cseam`)
    sec.append(seam, this.conclusionCard())
    return sec
  }

  private conclusionCard(): HTMLElement {
    const card = el('article', 'ember-council-conclusion')
    this.enterOnce(card, `${this.req?.id}:conclusion`)
    const head = el('header', 'ember-council-card-head')
    const who = el('div', 'ember-council-who')
    who.append(
      el('span', 'ember-council-who-name', name(this.conclusion?.member ?? this.req!.chair)),
      el('span', 'ember-council-who-vendor', 'chair')
    )
    head.appendChild(who)
    if (this.concluding) head.appendChild(el('span', 'ember-council-spin'))
    card.appendChild(head)

    if (this.concluding) {
      const t = el('div', 'ember-council-thinking')
      t.setAttribute('aria-label', 'Writing the conclusion')
      for (let k = 0; k < 3; k++) t.appendChild(el('span', 'ember-council-shimmer'))
      card.append(t, el('div', 'ember-council-thinking-label', 'Writing the conclusion…'))
    } else if (this.conclusion) {
      card.appendChild(prose(this.conclusion.text, 'ember-council-prose is-conclusion'))
      const actions = el('div', 'ember-council-actions')
      const copy = button('ember-council-btn', 'Copy', () => {
        void navigator.clipboard.writeText(this.conclusion!.text).then(() => {
          copy.textContent = 'Copied'
          setTimeout(() => (copy.textContent = 'Copy'), 1400)
        })
      })
      const canvas = button('ember-council-btn', 'Put on canvas', () => {
        window.dispatchEvent(new CustomEvent('ember:council:canvas', { detail: this.toMarkdown() }))
        canvas.textContent = 'On the canvas'
        canvas.disabled = true
      })
      actions.append(copy, canvas)
      const origin = this.origin
      if (origin) {
        const back = button('ember-council-btn is-primary', `Send to ${origin.name}`, () => {
          window.dispatchEvent(new CustomEvent('ember:council:handback', { detail: { tabId: origin.tabId, ...this.toMarkdown() } }))
          back.textContent = `Sent to ${origin.name}`
          back.disabled = true
        })
        actions.prepend(back)
      }
      card.appendChild(actions)
    }
    if (this.conclusionError) card.appendChild(el('div', 'ember-council-err', this.conclusionError))
    return card
  }

  /** Mark `node` to animate in, the first time `key` is shown. True when it is new. */
  private enterOnce(node: HTMLElement, key: string): boolean {
    if (this.entered.has(key)) return false
    this.entered.add(key)
    node.classList.add('is-new')
    return true
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
