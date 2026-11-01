import { AGENTS, AGENT_IDS, type AgentId, type AgentStatus } from '@shared/agents'
import logoUrl from '../assets/logo.png'

/**
 * The first run, inside the app rather than over it.
 *
 * A new install opens to an empty desk and sets itself up where you can see it: it looks
 * for the agent CLIs already on the machine, checks each one answers (installed and
 * signed in), shares one memory between them, and then says plainly what you have —
 * "You're set up with Claude Code and Codex CLI" — with one button to begin. The full
 * list of agents is not shown here; it lives in Settings for whoever wants another.
 */

export interface FirstRunHooks {
  /** Start a session with this agent (the + button's behaviour), and finish. */
  start: (agent: AgentId) => void
  /** Run a command in a new tab, in the open: an install or a sign-in. */
  runInTab: (command: string, title: string) => void
  /** Settings › Agent, for adding another. */
  openAgents: () => void
  /** Remember the choice (config.agent.default) and that setup is done. */
  finish: (agent: AgentId | null) => void
}

type StepState = 'wait' | 'run' | 'ok' | 'skip'

/** The agents worth offering to someone who has none, in order. */
const STARTERS: AgentId[] = ['claude', 'codex', 'gemini']

export class FirstRun {
  readonly el: HTMLElement
  private readonly steps = [
    { id: 'find', label: 'Looking for coding agents on this computer', state: 'wait' as StepState, note: '' },
    { id: 'check', label: 'Checking they are signed in', state: 'wait' as StepState, note: '' },
    { id: 'share', label: 'Sharing memory and skills between them', state: 'wait' as StepState, note: '' },
  ]
  private ready: AgentId[] = []
  private unsigned: AgentId[] = []
  private chosen: AgentId | null = null
  private phase: 'setup' | 'done' = 'setup'

  constructor(private readonly hooks: FirstRunHooks) {
    this.el = document.createElement('div')
    this.el.className = 'ember-firstrun'
  }

  async run(): Promise<void> {
    this.phase = 'setup'
    this.render()
    const step = (id: string, state: StepState, note = '') => {
      const s = this.steps.find((x) => x.id === id)!
      s.state = state
      s.note = note
      this.render()
    }

    step('find', 'run')
    const statuses: AgentStatus[] = await window.ember.agents.detect(true).catch(() => [])
    const installed = AGENT_IDS.filter((id) => statuses.find((s) => s.id === id)?.installed)
    step('find', 'ok', installed.length ? `Found ${list(installed.map((id) => AGENTS[id].name))}` : 'None found')

    if (installed.length) {
      step('check', 'run')
      const results = await Promise.all(installed.map(async (id) => ({ id, ok: (await window.ember.agents.ping(id).catch(() => ({ ok: false }))).ok })))
      this.ready = results.filter((r) => r.ok).map((r) => r.id)
      this.unsigned = results.filter((r) => !r.ok).map((r) => r.id)
      step('check', 'ok', this.ready.length ? `${list(this.ready.map((id) => AGENTS[id].name))} ${this.ready.length > 1 ? 'are' : 'is'} ready` : 'None answered yet')
    } else step('check', 'skip')

    if (this.ready.length) {
      step('share', 'run')
      const st = await window.ember.brain.sync().catch(() => null)
      step('share', 'ok', st ? `${st.facts} memories, ${st.skills} skills` : '')
    } else step('share', 'skip')

    this.chosen = this.ready[0] ?? null
    await wait(500)
    this.phase = 'done'
    this.render()
  }

  private render(): void {
    if (this.phase === 'setup') {
      this.el.innerHTML =
        `<div class="ember-firstrun-card">` +
        `<img class="ember-firstrun-mark is-pulse" src="${logoUrl}" alt="" aria-hidden="true">` +
        `<h1>Setting up Ember</h1>` +
        `<ol class="ember-firstrun-steps">${this.steps
          .map((s) => `<li class="is-${s.state}"><span class="i" aria-hidden="true"></span><span class="t">${esc(s.label)}</span>${s.note ? `<span class="n">${esc(s.note)}</span>` : ''}</li>`)
          .join('')}</ol>` +
        `</div>`
      return
    }

    const card = document.createElement('div')
    card.className = 'ember-firstrun-card is-done'
    const mark = document.createElement('img')
    mark.className = 'ember-firstrun-mark'
    mark.src = logoUrl
    mark.alt = ''
    const h = document.createElement('h1')
    const p = document.createElement('p')
    p.className = 'ember-firstrun-lead'
    const actions = document.createElement('div')
    actions.className = 'ember-firstrun-actions'
    card.append(mark, h, p)

    if (this.ready.length) {
      h.textContent = `You're set up with ${list(this.ready.map((id) => AGENTS[id].name))}.`
      p.textContent =
        this.ready.length > 1
          ? 'Ember uses them directly, with the sign-in you already have. They share one memory, so switching between them in any session keeps what they know.'
          : 'Ember uses it directly, with the sign-in you already have.'
      if (this.ready.length > 1) {
        const pick = document.createElement('div')
        pick.className = 'ember-firstrun-pick'
        pick.innerHTML = `<span>New sessions start with</span>`
        for (const id of this.ready) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = id === this.chosen ? 'is-on' : ''
          b.textContent = AGENTS[id].name
          b.addEventListener('click', () => {
            this.chosen = id
            this.render()
          })
          pick.appendChild(b)
        }
        card.appendChild(pick)
      }
      const go = button('Start your first session', 'is-primary', () => {
        this.hooks.finish(this.chosen)
        this.hooks.start(this.chosen!)
      })
      actions.appendChild(go)
    } else if (this.unsigned.length) {
      const names = list(this.unsigned.map((id) => AGENTS[id].name))
      h.textContent = `${names} ${this.unsigned.length > 1 ? 'need' : 'needs'} you to sign in.`
      p.textContent = 'Ember found it on this computer, but it did not answer yet. Sign in once, then come back here.'
      for (const id of this.unsigned) actions.appendChild(button(`Sign in to ${AGENTS[id].name}`, 'is-primary', () => this.hooks.runInTab(AGENTS[id].login, AGENTS[id].name)))
      actions.appendChild(button('Check again', '', () => void this.run()))
    } else {
      h.textContent = 'No coding agent on this computer yet.'
      p.textContent = 'Ember runs the agent you already use, on your own plan. Install one — it opens in a tab so you can watch — then check again.'
      for (const id of STARTERS) actions.appendChild(button(`Install ${AGENTS[id].name}`, id === 'claude' ? 'is-primary' : '', () => this.hooks.runInTab(AGENTS[id].install.command, `Install ${AGENTS[id].name}`)))
      actions.appendChild(button('Check again', '', () => void this.run()))
    }
    card.appendChild(actions)

    // Found but not answering, next to ones that work: a quiet line, not a blocker.
    if (this.ready.length && this.unsigned.length) {
      const also = document.createElement('p')
      also.className = 'ember-firstrun-also'
      also.textContent = `${list(this.unsigned.map((id) => AGENTS[id].name))} ${this.unsigned.length > 1 ? 'are' : 'is'} installed but not signed in. `
      for (const id of this.unsigned) {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = `Sign in to ${AGENTS[id].name}`
        b.addEventListener('click', () => this.hooks.runInTab(AGENTS[id].login, AGENTS[id].name))
        also.appendChild(b)
      }
      card.appendChild(also)
    }

    const foot = document.createElement('div')
    foot.className = 'ember-firstrun-foot'
    const more = document.createElement('button')
    more.type = 'button'
    more.textContent = 'Add another agent'
    more.addEventListener('click', () => this.hooks.openAgents())
    const skip = document.createElement('button')
    skip.type = 'button'
    skip.textContent = 'Just open a terminal'
    skip.addEventListener('click', () => this.hooks.finish(this.chosen))
    foot.append(more, skip)
    card.appendChild(foot)
    this.el.replaceChildren(card)
  }
}

function button(label: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `ember-firstrun-btn ${cls}`.trim()
  b.textContent = label
  b.addEventListener('click', fn)
  return b
}

function list(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '')
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}
