import type { BrainStatus, EmberConfig } from '@shared/types'
import { AgentPicker } from './AgentPicker'
import { PHONE_LINK } from '../phone/flag'

type FieldKind = 'range' | 'toggle' | 'select' | 'number' | 'text' | 'preset'

/**
 * The two ends of the look/speed trade, as measured rather than guessed.
 *
 * Everything in `fast` was on the profile of an idle Ember. The breathing caret was worth
 * about twelve points of a core on its own, because an animation that never ends is the
 * one thing that stops the frame loop ever stopping; the trail and the output rise are
 * cheaper but pull in the same direction. Nothing here changes what the terminal *says*,
 * only how much motion it spends saying it.
 */
const PRESETS: Record<'full' | 'fast', Record<string, unknown>> = {
  full: {
    'cursor.pulsePeriod': 3.2,
    'cursor.trailOpacity': 1,
    'cursor.glow': 40,
    'effects.outputMotion': true,
  },
  fast: {
    'cursor.pulsePeriod': 0,
    'cursor.trailOpacity': 0,
    'cursor.glow': 0,
    'effects.outputMotion': false,
  },
}

interface Field {
  path: string
  label: string
  kind: FieldKind
  hint?: string
  min?: number
  max?: number
  step?: number
  options?: string[]
}

interface Section {
  title: string
  /** Which tab of the panel this section sits under. */
  tab: SettingsTab
  fields: Field[]
  /** Shown only while Labs is on. */
  labsOnly?: boolean
}

/**
 * The panel's tabs, in order. There is no look to pick: Ember has one (Basalt), with its own
 * faces (Archivo, DM Mono). Text keeps the size and spacing, for eyes that need them.
 */
const ALL_TABS = ['Text', 'Motion', 'Agent', 'Behaviour', 'Labs'] as const
export type SettingsTab = (typeof ALL_TABS)[number]
/** Labs holds only the phone link, so it goes when that is switched off. */
export const SETTINGS_TABS: readonly SettingsTab[] = PHONE_LINK ? ALL_TABS : ALL_TABS.filter((t) => t !== 'Labs')


/** Read/write a dotted path on the config object. */
function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj)
}

function set(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  const last = keys.pop()!
  let cur: Record<string, unknown> = obj
  for (const k of keys) cur = cur[k] as Record<string, unknown>
  cur[last] = value
}

/**
 * The preferences panel.
 *
 * It edits a copy of the config and writes the whole thing to disk; the existing file
 * watcher is what applies it. That means the settings UI has no privileged path into
 * the running app — it is exactly as powerful as editing the JSON by hand, so the two
 * can never disagree, and every control gets live preview for free.
 *
 * Writes are debounced because dragging a slider fires continuously and each write
 * round-trips through the watcher.
 */
export class Settings {
  readonly el: HTMLElement
  private readonly body: HTMLElement
  private draft: EmberConfig | null = null
  private open = false
  private saveTimer: number | null = null
  /** Lower-cased filter text. Empty means show everything. */
  private query = ''
  /** The tab showing. A filter looks across all of them. */
  private tab: SettingsTab = 'Text'
  private readonly tabsEl: HTMLElement
  /** Settings › Agent's list; made on first view, and looked at again every open. */
  private agents: AgentPicker | null = null

  private static readonly SECTIONS: Section[] = [
    {
      title: 'Speed',
      tab: 'Motion',
      fields: [
        {
          path: '',
          label: 'Motion',
          kind: 'preset',
          hint: 'Fast stops the animations that never end; the text is identical either way',
        },
      ],
    },
    {
      title: 'Caret',
      tab: 'Motion',
      fields: [
        { path: 'cursor.shape', label: 'Shape', kind: 'select', options: ['bar', 'block', 'underline'] },
        { path: 'cursor.stiffness', label: 'Travel speed', kind: 'range', min: 150, max: 2200, step: 10, hint: 'higher is snappier' },
        { path: 'cursor.damping', label: 'Overshoot', kind: 'range', min: 0.4, max: 1, step: 0.01, hint: '1.0 = none' },
        { path: 'cursor.trailStiffness', label: 'Trail length', kind: 'range', min: 80, max: 900, step: 10, hint: 'lower is longer' },
        { path: 'cursor.trailOpacity', label: 'Trail strength', kind: 'range', min: 0, max: 1, step: 0.05 },
        { path: 'cursor.glow', label: 'Glow', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'cursor.pulsePeriod', label: 'Idle breathing', kind: 'range', min: 0, max: 8, step: 0.1, hint: '0 disables' },
      ],
    },
    {
      title: 'Motion',
      tab: 'Motion',
      fields: [
        { path: 'motion.slideStiffness', label: 'Session switch speed', kind: 'range', min: 200, max: 2000, step: 10 },
        { path: 'motion.slideDamping', label: 'Switch overshoot', kind: 'range', min: 0.5, max: 1, step: 0.01, hint: '1.0 = none' },
        { path: 'motion.switchBlur', label: 'Switch blur', kind: 'range', min: 0, max: 20, step: 1 },
        { path: 'motion.scale', label: 'Overall speed', kind: 'range', min: 0, max: 2, step: 0.05, hint: '0 = instant' },
      ],
    },
    {
      title: 'Text',
      tab: 'Text',
      fields: [
        { path: 'font.size', label: 'Size', kind: 'range', min: 8, max: 28, step: 1 },
        { path: 'font.lineHeight', label: 'Line height', kind: 'range', min: 1, max: 2, step: 0.02 },
        { path: 'scrollback', label: 'Scrollback lines', kind: 'number', min: 500, max: 100000, step: 500 },
      ],
    },
    {
      title: 'Window',
      tab: 'Text',
      fields: [
        { path: 'window.sidebarWidth', label: 'Sidebar width', kind: 'range', min: 160, max: 420, step: 4 },
        { path: 'window.padding.top', label: 'Padding top', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'window.padding.bottom', label: 'Padding bottom', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'window.padding.left', label: 'Padding left', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'window.padding.right', label: 'Padding right', kind: 'range', min: 0, max: 40, step: 1 },
      ],
    },
    {
      title: 'Effects',
      tab: 'Text',
      fields: [
        { path: 'effects.outputMotion', label: 'Output rises into place', kind: 'toggle' },
        { path: 'effects.adaptive', label: 'Shed effects when slow', kind: 'toggle' },
      ],
    },
    {
      title: 'Sound',
      tab: 'Behaviour',
      fields: [
        { path: 'sound.enabled', label: 'Enabled', kind: 'toggle' },
        { path: 'sound.volume', label: 'Volume', kind: 'range', min: 0, max: 1, step: 0.05 },
      ],
    },
    {
      title: 'Scrolling',
      tab: 'Motion',
      fields: [
        { path: 'scroll.inertia', label: 'Momentum', kind: 'toggle' },
        { path: 'scroll.elastic', label: 'Rubber-band ends', kind: 'toggle' },
        { path: 'scroll.speed', label: 'Wheel speed', kind: 'range', min: 1, max: 10, step: 1 },
      ],
    },
    {
      title: 'Panel',
      tab: 'Agent',
      fields: [
        {
          path: 'panel.width',
          label: 'Panel width',
          kind: 'range',
          min: 0.2,
          max: 0.7,
          step: 0.02,
          hint: 'share of the tab the panel takes when open',
        },
        { path: 'panel.autoOpen', label: 'Open the panel on first use', kind: 'toggle' },
        {
          path: 'claude.usageLimits',
          label: 'Plan usage in the sidebar',
          kind: 'toggle',
          hint: 'the 5-hour and weekly limits, polled every minute from Anthropic with the login Claude Code already has. Off by default',
        },
        {
          path: 'claude.statusLine',
          label: 'Status line on Claude sessions',
          kind: 'toggle',
          hint: 'context and cost under the session, and on its card. New sessions only',
        },
      ],
    },
    {
      title: 'Labs',
      tab: 'Labs',
      fields: [
        {
          path: 'labs.enabled',
          label: 'Labs',
          kind: 'toggle',
          hint: 'the phone link, which goes through a relay Deep Answer Labs runs. Experimental',
        },
      ],
    },
    {
      title: 'Behaviour',
      tab: 'Behaviour',
      fields: [
        {
          path: 'shellIntegration',
          label: 'Shell integration',
          kind: 'toggle',
          hint: 'reports cwd + exit status; needed for the git badge and task runner',
        },
        {
          path: 'updates.check',
          label: 'Check for updates',
          kind: 'toggle',
          hint: 'asks GitHub for the latest release at start and every 6 hours. Clicking the version still checks',
        },
      ],
    },
  ]

  constructor(
    private readonly onSave: (next: EmberConfig) => void,
    private readonly runInTab: (command: string, title: string) => void = () => {},
  ) {
    this.el = document.createElement('div')
    this.el.className = 'ember-settings'

    const panel = document.createElement('div')
    panel.className = 'ember-settings-panel'

    const head = document.createElement('header')
    head.className = 'ember-settings-head'
    const title = document.createElement('h2')
    title.textContent = 'Settings'
    const path = document.createElement('span')
    path.className = 'ember-settings-path'
    path.textContent = '~/.ember/config.json'
    // Two-step, because this throws away every tweak and there is no undo. The button
    // becomes its own confirmation rather than opening a dialog.
    const reset = document.createElement('button')
    reset.className = 'ember-settings-reset'
    reset.textContent = 'Reset to defaults'
    let armed = false
    let armTimer: number | null = null
    const disarm = () => {
      armed = false
      reset.classList.remove('is-armed')
      reset.textContent = 'Reset to defaults'
    }
    reset.addEventListener('click', async () => {
      if (!armed) {
        armed = true
        reset.classList.add('is-armed')
        reset.textContent = 'Reset everything?'
        if (armTimer !== null) window.clearTimeout(armTimer)
        armTimer = window.setTimeout(disarm, 3500)
        return
      }
      if (armTimer !== null) window.clearTimeout(armTimer)
      disarm()
      this.draft = structuredClone(await window.ember.defaultConfig())
      this.flush()
      this.build()
    })

    // Ten sections and roughly forty controls: past the point where scanning beats
    // scrolling. Matches on the label, the hint and the section title, so "key", "size"
    // and "sound" all land somewhere useful.
    const filter = document.createElement('input')
    filter.type = 'search'
    filter.className = 'ember-settings-filter'
    filter.placeholder = 'Filter settings'
    filter.autocomplete = 'off'
    filter.spellcheck = false
    filter.addEventListener('input', () => {
      this.query = filter.value.trim().toLowerCase()
      this.build()
    })
    // Esc clears the filter before it closes the panel — losing a search you are mid-way
    // through because you wanted to unfocus the box is a small, repeated annoyance.
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && filter.value) {
        e.stopPropagation()
        filter.value = ''
        this.query = ''
        this.build()
      }
    })

    const close = document.createElement('button')
    close.className = 'ember-settings-close'
    close.innerHTML = '&#xE8BB;'
    close.title = 'Close  (Esc)'
    close.addEventListener('click', () => this.close())
    head.append(title, path, filter, reset, close)

    // Five tabs rather than one long scroll: a setting is found by what it is about, and
    // the filter box still searches across all of them at once.
    this.tabsEl = document.createElement('nav')
    this.tabsEl.className = 'ember-settings-tabs'
    for (const tab of SETTINGS_TABS) {
      const b = document.createElement('button')
      b.className = 'ember-settings-tab'
      b.textContent = tab
      b.dataset['tab'] = tab
      b.addEventListener('click', () => {
        this.tab = tab
        this.build()
      })
      this.tabsEl.appendChild(b)
    }

    this.body = document.createElement('div')
    this.body.className = 'ember-settings-body'

    panel.append(head, this.tabsEl, this.body)
    this.el.appendChild(panel)
    document.body.appendChild(this.el)

    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close()
    })
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    })
  }

  get isOpen(): boolean {
    return this.open
  }

  async show(config: EmberConfig, tab?: SettingsTab): Promise<void> {
    if (tab) this.tab = tab
    this.draft = structuredClone(config)
    // Look for agent CLIs again on every open: one may have been installed since.
    if (this.agents && this.tab === 'Agent') void this.agents.refresh()
    this.build()
    this.open = true
    this.el.classList.add('is-open')
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.el.classList.remove('is-open')
    this.flush()
  }

  toggle(config: EmberConfig, tab?: SettingsTab): void {
    if (this.open && !tab) this.close()
    else void this.show(config, tab)
  }

  /** Keep the panel in step when the config changes underneath it. */
  sync(config: EmberConfig): void {
    if (!this.open || this.saveTimer !== null) return
    this.draft = structuredClone(config)
  }

  private queueSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    // Dragging a slider fires continuously; each write round-trips through the file
    // watcher, so coalesce them.
    this.saveTimer = window.setTimeout(() => this.flush(), 140)
  }

  private flush(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.draft) this.onSave(this.draft)
  }

  private build(): void {
    this.body.replaceChildren()
    if (!this.draft) return

    // A filter searches every tab; the strip steps aside so the results are not hidden
    // behind a tab that is not the current one.
    this.tabsEl.hidden = !!this.query
    for (const b of this.tabsEl.children) b.classList.toggle('is-current', (b as HTMLElement).dataset['tab'] === this.tab)
    this.body.scrollTop = 0

    if (!this.query && this.tab === 'Agent') this.body.appendChild(this.buildAgents())

    let shown = 0
    for (const section of Settings.SECTIONS) {
      if (!this.query && section.tab !== this.tab) continue
      if (section.labsOnly && !this.draft.labs?.enabled) continue
      const fields = this.matching(section)
      if (!fields.length) continue
      shown++
      this.body.appendChild(this.buildSection({ ...section, fields }))
    }

    if (this.query && shown === 0) {
      const empty = document.createElement('p')
      empty.className = 'ember-settings-empty'
      empty.textContent = `Nothing matches “${this.query}”`
      this.body.appendChild(empty)
    }
  }

  /**
   * The fields of a section that survive the current filter.
   *
   * A section whose own title matches keeps all of its fields, so typing "window" gives
   * the whole Window group rather than the handful of rows with "window" in their label.
   */
  private matching(section: Section): Field[] {
    if (!this.query) return section.fields
    if (section.title.toLowerCase().includes(this.query)) return section.fields
    return section.fields.filter((f) =>
      `${f.label} ${f.hint ?? ''} ${f.path}`.toLowerCase().includes(this.query),
    )
  }

  private buildAgents(): HTMLElement {
    const wrap = document.createElement('section')
    wrap.className = 'ember-settings-section'
    const h = document.createElement('h3')
    h.textContent = 'Your agent'
    if (!this.agents) {
      this.agents = new AgentPicker({
        chosen: this.draft!.agent.default,
        onChoose: (id) => {
          if (!this.draft) return
          this.draft.agent.default = id
          this.queueSave()
        },
        runInTab: (command, title) => {
          this.close()
          this.runInTab(command, title)
        },
      })
    }
    wrap.append(h, this.agents.el, this.buildBrain())
    return wrap
  }

  /**
   * Shared knowledge: one memory, instructions and skills for every agent, so switching
   * agents does not mean switching what the agent knows.
   */
  private buildBrain(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'ember-brain'
    const h = document.createElement('h3')
    h.textContent = 'Shared knowledge'
    const lead = document.createElement('p')
    lead.className = 'ember-brain-lead'
    lead.textContent =
      'Every agent works from the same memory, instructions and skills, so switching agents does not switch what it knows. Ember keeps them in its own folder and writes only a marked section into each agent’s file, after a backup.'
    const on = document.createElement('label')
    on.className = 'ember-brain-on'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = this.draft?.brain?.sync !== false
    cb.addEventListener('change', () => {
      if (!this.draft) return
      this.draft.brain = { sync: cb.checked }
      this.queueSave()
    })
    on.append(cb, document.createTextNode(' Keep my agents on the same knowledge'))
    const list = document.createElement('div')
    list.className = 'ember-brain-list'
    const sync = document.createElement('button')
    sync.className = 'ember-agents-btn'
    sync.textContent = 'Sync now'
    const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', qwen: 'Qwen Code', opencode: 'OpenCode' }
    const paint = (st: BrainStatus) => {
      const rows = st.agents
        .filter((a) => a.present)
        .map((a) => `<div class="r"><span>${NAMES[a.agent] ?? a.agent}</span><span class="${a.synced ? 'ok' : ''}">${a.synced ? 'instructions ✓ · memory ✓' : 'not synced yet'}${a.skills !== null ? ` · skills ${a.skills}/${st.skills}` : ''}</span></div>`)
      list.innerHTML =
        `<div class="sum">${st.facts} facts in memory · ${st.skills} skills${st.syncedAt ? ` · synced ${new Date(st.syncedAt).toLocaleString()}` : ''}</div>` +
        (rows.join('') || '<div class="r">No agent folders found yet.</div>')
    }
    sync.addEventListener('click', () => {
      sync.disabled = true
      sync.textContent = 'Syncing…'
      void window.ember.brain.sync().then((st) => {
        paint(st)
        sync.disabled = false
        sync.textContent = 'Sync now'
      })
    })
    void window.ember.brain.status().then(paint)
    box.append(h, lead, on, list, sync)
    return box
  }

  private buildSection(section: Section): HTMLElement {
    const wrap = document.createElement('section')
    wrap.className = 'ember-settings-section'
    const h = document.createElement('h3')
    h.textContent = section.title
    wrap.appendChild(h)

    for (const field of section.fields) {
      const row = document.createElement('label')
      row.className = 'ember-settings-row'

      const text = document.createElement('span')
      text.className = 'ember-settings-label'
      text.textContent = field.label
      if (field.hint) {
        const hint = document.createElement('em')
        hint.textContent = field.hint
        text.appendChild(hint)
      }

      const control = this.buildControl(field)
      row.append(text, control)
      wrap.appendChild(row)
    }
    return wrap
  }

  private buildControl(field: Field): HTMLElement {
    const value = get(this.draft, field.path)
    const commit = (v: unknown) => {
      if (!this.draft) return
      set(this.draft as unknown as Record<string, unknown>, field.path, v)
      this.queueSave()
      // Labs decides which sections exist, so turning it on has to show them.
      if (field.path === 'labs.enabled') this.build()
    }

    if (field.kind === 'toggle') {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.className = 'ember-toggle'
      input.checked = Boolean(value)
      input.addEventListener('change', () => commit(input.checked))
      return input
    }

    if (field.kind === 'select') {
      const sel = document.createElement('select')
      sel.className = 'ember-select'
      for (const opt of field.options ?? []) {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt
        sel.appendChild(o)
      }
      sel.value = String(value)
      sel.addEventListener('change', () => commit(sel.value))
      return sel
    }

    if (field.kind === 'preset') {
      const wrap = document.createElement('span')
      wrap.className = 'ember-preset'
      for (const name of ['full', 'fast'] as const) {
        const b = document.createElement('button')
        b.className = 'ember-preset-btn'
        b.textContent = name === 'full' ? 'Full' : 'Fast'
        // "Current" is derived from the values, not stored, so hand-editing the config or
        // moving one slider afterwards cannot leave a preset button lying about the state.
        b.classList.toggle(
          'is-current',
          Object.entries(PRESETS[name]).every(([p, v]) => get(this.draft, p) === v),
        )
        b.addEventListener('click', () => {
          if (!this.draft) return
          for (const [p, v] of Object.entries(PRESETS[name])) {
            set(this.draft as unknown as Record<string, unknown>, p, v)
          }
          this.flush()
          this.build()
        })
        wrap.appendChild(b)
      }
      return wrap
    }

    if (field.kind === 'text') {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'ember-input'
      input.value = String(value ?? '')
      input.addEventListener('input', () => commit(input.value))
      return input
    }

    if (field.kind === 'number') {
      const input = document.createElement('input')
      input.type = 'number'
      input.className = 'ember-input is-number'
      input.min = String(field.min ?? 0)
      input.max = String(field.max ?? 1e9)
      input.step = String(field.step ?? 1)
      input.value = String(value ?? 0)
      input.addEventListener('input', () => commit(Number(input.value)))
      return input
    }

    // range
    const wrap = document.createElement('span')
    wrap.className = 'ember-range'
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(field.min ?? 0)
    input.max = String(field.max ?? 1)
    input.step = String(field.step ?? 0.01)
    input.value = String(value ?? 0)
    const out = document.createElement('output')
    out.textContent = String(value ?? 0)
    input.addEventListener('input', () => {
      out.textContent = input.value
      commit(Number(input.value))
    })
    wrap.append(input, out)
    return wrap
  }
}
