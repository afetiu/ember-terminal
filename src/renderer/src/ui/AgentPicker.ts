import { AGENTS, AGENT_IDS, type AgentId, type AgentStatus } from '@shared/agents'

/**
 * The agent CLIs, as a list you choose from.
 *
 * Shared by Settings › Agent and the onboarding, so the two can never describe the
 * choice differently. Each row says whether the CLI is on this machine and offers the
 * one next step that makes sense: Install when it is missing, Sign in and Test when it
 * is there. Install and Sign in run in a new tab, in the open, so the person watches the
 * real installer rather than trusting a spinner.
 */
export interface AgentPickerOptions {
  chosen: AgentId
  onChoose(id: AgentId): void
  /** Run a command in a fresh tab, titled. */
  runInTab(command: string, title: string): void
  /** Check every agent found on this machine at once (one short headless question each). */
  autoTest?: boolean
}

export class AgentPicker {
  readonly el: HTMLElement
  private statuses: AgentStatus[] = []
  private chosen: AgentId
  private readonly tests = new Map<AgentId, string>()
  private loading = true

  constructor(private readonly opts: AgentPickerOptions) {
    this.chosen = opts.chosen
    this.el = document.createElement('div')
    this.el.className = 'ember-agents'
    this.render()
    void this.refresh()
  }

  /** Look again — after an install, most usefully. */
  async refresh(): Promise<void> {
    this.loading = true
    this.render()
    this.statuses = await window.ember.agents.detect(true).catch(() => [])
    this.loading = false
    this.render()
    if (this.opts.autoTest) for (const s of this.statuses) if (s.installed && !this.tests.has(s.id)) this.test(s.id)
  }

  /** One short headless question: proves it is installed and signed in, the way Ember will use it. */
  private test(id: AgentId): void {
    this.tests.set(id, 'Checking it answers…')
    this.render()
    void window.ember.agents.ping(id).then((r) => {
      this.tests.set(id, r.ok ? `Connected — answered in ${(r.ms / 1000).toFixed(1)}s. Ready to use.` : `Found, but it did not answer: ${(r.error ?? 'unknown error').slice(0, 140)}. Sign in, then Test.`)
      this.render()
    })
  }

  get installedCount(): number {
    return this.statuses.filter((s) => s.installed).length
  }

  /** The first installed CLI, for when the chosen one is not on this machine. */
  firstInstalled(): AgentId | null {
    return this.statuses.find((s) => s.installed)?.id ?? null
  }

  isInstalled(id: AgentId): boolean {
    return !!this.status(id)?.installed
  }

  setChosen(id: AgentId): void {
    this.chosen = id
    this.render()
  }

  private status(id: AgentId): AgentStatus | undefined {
    return this.statuses.find((s) => s.id === id)
  }

  private render(): void {
    const list = document.createElement('div')
    list.className = 'ember-agents-list'
    // What is already on this machine comes first, said plainly: Ember uses it directly,
    // with the sign-in it already has. The rest are there to add.
    const found = this.loading ? [] : AGENT_IDS.filter((id) => this.status(id)?.installed)
    const rest = AGENT_IDS.filter((id) => !found.includes(id))
    if (found.length) {
      const names = found.map((id) => AGENTS[id].name)
      const said = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
      const head = document.createElement('div')
      head.className = 'ember-agents-found'
      head.innerHTML = `<strong>On this computer: ${said}.</strong> Ember connects to ${names.length > 1 ? 'them' : 'it'} directly, with the sign-in you already have — nothing to install.`
      list.appendChild(head)
      for (const id of found) list.appendChild(this.row(id))
      const more = document.createElement('div')
      more.className = 'ember-agents-group'
      more.textContent = 'More agents you can add'
      list.appendChild(more)
    }
    for (const id of rest) list.appendChild(this.row(id))

    const foot = document.createElement('div')
    foot.className = 'ember-agents-foot'
    const refresh = document.createElement('button')
    refresh.className = 'ember-agents-btn is-quiet'
    refresh.textContent = this.loading ? 'Looking…' : 'Look again'
    refresh.disabled = this.loading
    refresh.addEventListener('click', () => void this.refresh())
    const note = document.createElement('span')
    note.textContent = 'Installed one in a tab? Look again once it finishes.'
    foot.append(note, refresh)

    this.el.replaceChildren(list, foot)
  }

  private row(id: AgentId): HTMLElement {
    const spec = AGENTS[id]
    const st = this.status(id)
    const row = document.createElement('div')
    row.className = 'ember-agent'
    row.classList.toggle('is-chosen', id === this.chosen)
    row.classList.toggle('is-missing', !this.loading && !st?.installed)

    const pick = document.createElement('button')
    pick.className = 'ember-agent-pick'
    pick.setAttribute('role', 'radio')
    pick.setAttribute('aria-checked', String(id === this.chosen))
    pick.title = `Start new sessions with ${spec.name}`
    pick.addEventListener('click', () => {
      this.chosen = id
      this.opts.onChoose(id)
      this.render()
    })

    const text = document.createElement('div')
    text.className = 'ember-agent-text'
    const name = document.createElement('div')
    name.className = 'ember-agent-name'
    name.textContent = spec.name
    const vendor = document.createElement('span')
    vendor.className = 'ember-agent-vendor'
    vendor.textContent = spec.vendor
    const badge = document.createElement('span')
    badge.className = 'ember-agent-badge'
    if (this.loading) badge.textContent = '…'
    else if (st?.installed) {
      badge.textContent = st.version ? `v${st.version}` : 'installed'
      badge.classList.add('is-ok')
    } else badge.textContent = 'not installed'
    name.append(vendor, badge)
    const blurb = document.createElement('div')
    blurb.className = 'ember-agent-blurb'
    blurb.textContent = this.tests.get(id) ?? spec.blurb
    text.append(name, blurb)
    // How to get it signed in — most useful exactly when it is installed and not yet working.
    if (spec.setup) {
      const how = document.createElement('div')
      how.className = 'ember-agent-setup'
      how.textContent = spec.setup
      text.appendChild(how)
    }

    const actions = document.createElement('div')
    actions.className = 'ember-agent-actions'
    const btn = (label: string, title: string, fn: () => void, quiet = false) => {
      const b = document.createElement('button')
      b.className = 'ember-agents-btn'
      if (quiet) b.classList.add('is-quiet')
      b.textContent = label
      b.title = title
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        fn()
      })
      actions.appendChild(b)
      return b
    }
    if (!this.loading && !st?.installed) {
      btn('Install', `${spec.install.command}${spec.install.needs ? `\nNeeds ${spec.install.needs}` : ''}`, () =>
        this.opts.runInTab(spec.install.command, `Install ${spec.name}`)
      )
    } else if (st?.installed) {
      btn('Sign in', `Runs ${spec.login} in a new tab`, () => this.opts.runInTab(spec.login, spec.name), true)
      btn('Test', 'Ask it one short question, headless, the way Ember will', () => this.test(id))
    }
    const docs = document.createElement('a')
    docs.className = 'ember-agents-link'
    docs.href = spec.homepage
    docs.target = '_blank'
    docs.rel = 'noreferrer'
    docs.textContent = 'About'
    actions.appendChild(docs)

    row.addEventListener('click', () => pick.click())
    row.append(pick, text, actions)
    return row
  }
}
