import type { EmberConfig, FontOption, ThemeConfig } from '@shared/types'
import { FontPicker } from './FontPicker'
import { AgentPicker, noKeysNote } from './AgentPicker'

type FieldKind = 'range' | 'toggle' | 'select' | 'number' | 'text' | 'color' | 'font' | 'secret' | 'preset'

/**
 * The two ends of the look/speed trade, as measured rather than guessed.
 *
 * Everything in `fast` was on the profile of an idle Ember. The breathing caret was worth
 * about twelve points of a core on its own, because an animation that never ends is the
 * one thing that stops the frame loop ever stopping; the trail and the output rise are
 * cheaper but pull in the same direction. Nothing here changes what the terminal *says*,
 * only how much motion it spends saying it.
 *
 * Window opacity is deliberately absent. It measured free (66.4% against 66.9% at 20 and
 * 100), so there is no reason to make anyone give up the glass for speed they will not get.
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
  /** For 'font': the label shown for the empty value. Omit to require a font. */
  inherit?: string
  /** For 'secret': which provider's key this field edits. */
  provider?: 'openai' | 'anthropic'
}

interface Section {
  title: string
  /** Which tab of the panel this section sits under. */
  tab: SettingsTab
  fields: Field[]
  /** Shown only while Labs is on. */
  labsOnly?: boolean
}

/** The panel's tabs, in order. Theme is part of Look; the rest are the sections below. */
export const SETTINGS_TABS = ['Look', 'Motion', 'Agent', 'Todo', 'Behaviour', 'Labs'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/** What the panel is allowed to know about the stored key: that it exists, and its tail. */
interface SecretState {
  configured: boolean
  path: string
  hint: string
}

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
  private themes: ThemeConfig[] = []
  private fonts: FontOption[] = []
  private fontsReady: Promise<FontOption[]> | null = null
  private open = false
  private saveTimer: number | null = null
  /** Per-provider key status: on disk or not, and its last four. Never the key. */
  private secrets = new Map<string, SecretState>()
  /** Lower-cased filter text. Empty means show everything. */
  private query = ''
  /** The tab showing. A filter looks across all of them. */
  private tab: SettingsTab = 'Look'
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
      tab: 'Look',
      fields: [
        {
          path: 'font.family',
          label: 'Font',
          kind: 'font',
          hint: 'the whole window — chrome and terminal alike',
        },
        {
          path: 'font.uiFamily',
          label: 'Interface font',
          kind: 'font',
          inherit: 'Same as app font',
          hint: 'chrome only, when the terminal wants a different one',
        },
        { path: 'font.size', label: 'Size', kind: 'range', min: 8, max: 28, step: 1 },
        { path: 'font.weight', label: 'Weight', kind: 'range', min: 100, max: 700, step: 100 },
        { path: 'font.lineHeight', label: 'Line height', kind: 'range', min: 1, max: 2, step: 0.02 },
        { path: 'scrollback', label: 'Scrollback lines', kind: 'number', min: 500, max: 100000, step: 500 },
      ],
    },
    {
      title: 'Window',
      tab: 'Look',
      fields: [
        { path: 'window.opacity', label: 'Opacity', kind: 'range', min: 20, max: 100, step: 1 },
        { path: 'window.material', label: 'Backdrop', kind: 'select', options: ['acrylic', 'mica', 'tabbed', 'none'] },
        {
          path: 'window.inactiveOpacity',
          label: 'Opacity when inactive',
          kind: 'range',
          min: 20,
          max: 100,
          step: 1,
          hint: 'Windows hides the blur off-focus',
        },
        { path: 'window.sidebarWidth', label: 'Sidebar width', kind: 'range', min: 160, max: 420, step: 4 },
        { path: 'window.padding.top', label: 'Padding top', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'window.padding.bottom', label: 'Padding bottom', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'window.padding.left', label: 'Padding left', kind: 'range', min: 0, max: 40, step: 1 },
        { path: 'window.padding.right', label: 'Padding right', kind: 'range', min: 0, max: 40, step: 1 },
      ],
    },
    {
      title: 'Effects',
      tab: 'Look',
      fields: [
        { path: 'effects.glow', label: 'Glow', kind: 'range', min: 0, max: 1, step: 0.02 },
        { path: 'effects.scanlines', label: 'Scanlines', kind: 'range', min: 0, max: 0.4, step: 0.01 },
        { path: 'effects.vignette', label: 'Vignette', kind: 'range', min: 0, max: 1, step: 0.02 },
        { path: 'effects.ambient', label: 'React to output', kind: 'toggle' },
        { path: 'effects.outputMotion', label: 'Output rises into place', kind: 'toggle' },
        { path: 'effects.adaptive', label: 'Shed effects when slow', kind: 'toggle' },
      ],
    },
    {
      title: 'Todo',
      tab: 'Todo',
      fields: [
        { path: 'todo.gmail', label: 'Check Gmail', kind: 'toggle', hint: 'needs the Gmail connector in Claude' },
        { path: 'todo.outlook', label: 'Check Outlook', kind: 'toggle', hint: 'needs a Microsoft 365 tool in Claude' },
        { path: 'todo.slack', label: 'Check Slack', kind: 'toggle', hint: 'needs a Slack tool in Claude' },
        { path: 'todo.jira', label: 'Check Jira', kind: 'toggle', hint: 'needs the Atlassian connector in Claude' },
        { path: 'todo.github', label: 'Check GitHub', kind: 'toggle', hint: 'uses the gh CLI, signed in on this machine' },
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
          hint: 'the 5-hour and weekly limits, polled every minute with the login Claude Code already has',
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
          hint: 'the voice call and the key-based orchestrator. These need API keys of their own, unlike the rest of Ember',
        },
      ],
    },
    {
      title: 'Keys & voice',
      tab: 'Labs',
      labsOnly: true,
      fields: [
        {
          // Not a config path — this one writes to ~/.ember/secrets.json. See buildSecret.
          path: 'openai.key',
          label: 'OpenAI key',
          kind: 'secret',
          provider: 'openai',
          hint: 'the voice — hearing and speaking. Stored outside config.json',
        },
        {
          path: 'anthropic.key',
          label: 'Anthropic key',
          kind: 'secret',
          provider: 'anthropic',
          hint: 'the orchestrator’s actual thinking. Without it the voice has nothing to say',
        },
        {
          path: 'voice.realtime.model',
          label: 'Call model',
          kind: 'select',
          options: ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'],
          hint: 'Ctrl+Shift+L talks to this session. ~$3/hour, or about a third of that on mini',
        },
        {
          path: 'voice.realtime.voice',
          label: 'Call voice',
          kind: 'select',
          options: ['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
          hint: 'OpenAI realtime voices',
        },
        {
          path: 'voice.realtime.textModel',
          label: 'Written model',
          kind: 'select',
          options: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5'],
          hint: 'Ctrl+Shift+M writes to the same agent — same crew, same conversation',
        },
        {
          path: 'voice.realtime.showTranscript',
          label: 'Show what was said on a call',
          kind: 'toggle',
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
    // scrolling. Matches on the label, the hint and the section title, so "key", "opacity"
    // and "voice" all land somewhere useful.
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

    // Warm the font list well after launch: it costs a process on Windows, and the
    // first thing the app owes the user is a terminal, not a settings panel.
    window.setTimeout(() => void this.loadFonts(), 3000)
  }

  get isOpen(): boolean {
    return this.open
  }

  /**
   * Enumerating installed fonts shells out to the OS, so it is done once and warmed
   * in the background — the panel must never sit waiting on a PowerShell start-up
   * the first time it is opened. A failed attempt is retried on the next open
   * rather than cached as "this machine has no fonts".
   */
  private loadFonts(): Promise<FontOption[]> {
    this.fontsReady ??= window.ember.listFonts().catch(() => {
      this.fontsReady = null
      return [] as FontOption[]
    })
    return this.fontsReady
  }

  async show(config: EmberConfig, tab?: SettingsTab): Promise<void> {
    if (tab) this.tab = tab
    this.draft = structuredClone(config)
    if (!this.themes.length) this.themes = await window.ember.listThemes()
    this.fonts = await this.loadFonts()
    // Read every open rather than once: the file can be hand-edited, and a panel that
    // says "not set" over a key that is set would send you looking in the wrong place.
    for (const p of ['openai', 'anthropic'] as const) {
      const st = await window.ember.secret.status(p).catch(() => null)
      if (st) this.secrets.set(p, st)
    }
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

    // With a few dozen palettes the grid is the one place worth searching by name, so
    // "dracula" narrows it to Dracula the same way "theme" shows the whole set.
    const themes = this.query || this.tab === 'Look' ? this.matchingThemes() : []
    if (themes.length) this.body.appendChild(this.buildThemes(themes))

    if (!this.query && this.tab === 'Agent') this.body.appendChild(this.buildAgents())

    let shown = themes.length ? 1 : 0
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

  /**
   * The palettes that survive the current filter.
   *
   * An empty search shows all of them; otherwise a palette matches on its own name, and
   * the word "theme" still brings up the whole set. Names are folded to plain ASCII first
   * so "rose pine" finds Rosé Pine.
   */
  private matchingThemes(): ThemeConfig[] {
    if (!this.query) return this.themes
    if ('theme'.includes(this.query)) return this.themes
    const fold = (s: string): string =>
      s
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
    const q = fold(this.query)
    return this.themes.filter((t) => fold(t.name).includes(q))
  }

  private buildThemes(themes: ThemeConfig[]): HTMLElement {
    const wrap = document.createElement('section')
    wrap.className = 'ember-settings-section'
    const h = document.createElement('h3')
    h.textContent = 'Theme'
    const count = document.createElement('span')
    count.className = 'ember-settings-count'
    count.textContent = String(themes.length)
    h.appendChild(count)
    wrap.appendChild(h)

    const grid = document.createElement('div')
    grid.className = 'ember-theme-grid'
    for (const theme of themes) {
      const b = document.createElement('button')
      b.className = 'ember-theme'
      b.classList.toggle('is-current', theme.name === this.draft?.theme.name)
      b.title = theme.name

      const swatch = document.createElement('span')
      swatch.className = 'ember-theme-swatch'
      swatch.style.background = theme.background
      for (const c of [theme.cursor, theme.green, theme.yellow, theme.blue]) {
        const dot = document.createElement('i')
        dot.style.background = c
        swatch.appendChild(dot)
      }
      const name = document.createElement('span')
      name.className = 'ember-theme-name'
      name.textContent = theme.name

      b.append(swatch, name)
      b.addEventListener('click', () => {
        if (!this.draft) return
        this.draft.theme = structuredClone(theme)
        this.flush()
        this.build()
      })
      if (b.classList.contains('is-current')) {
        // The grid scrolls, so the palette in use has to be brought into view or a
        // reopened panel looks like nothing is selected.
        requestAnimationFrame(() => b.scrollIntoView({ block: 'nearest' }))
      }
      grid.appendChild(b)
    }
    wrap.appendChild(grid)
    return wrap
  }

  /** Which CLI Ember runs on, and the promise that it needs no key. */
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
    wrap.append(h, noKeysNote(), this.agents.el)
    return wrap
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

  /**
   * The OpenAI key field.
   *
   * The one control here that does not edit the config draft. The key belongs in
   * `secrets.json`, not `config.json`: the latter is watched, broadcast to every
   * renderer, shown by path at the top of this panel, and wiped by "Reset to defaults" —
   * four separate reasons a credential should not be in it.
   *
   * So it writes straight through IPC, and reads back only `configured` and the last four
   * characters. There is deliberately no way to see the stored key again: if you cannot
   * remember which one you pasted, replace it.
   */
  private buildSecret(provider: 'openai' | 'anthropic'): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'ember-secret'
    const state = () => this.secrets.get(provider) ?? null

    const input = document.createElement('input')
    input.type = 'password'
    input.className = 'ember-input'
    input.autocomplete = 'off'
    input.spellcheck = false
    const placeholder = () => {
      const st = state()
      return st?.configured ? `stored — ends ${st.hint}` : provider === 'openai' ? 'sk-…' : 'sk-ant-…'
    }
    input.placeholder = placeholder()

    const action = document.createElement('button')
    action.className = 'ember-secret-save'
    action.textContent = 'Save'
    action.disabled = true

    const status = document.createElement('em')
    status.className = 'ember-secret-status'

    const apply = async (key: string, done: string): Promise<void> => {
      action.disabled = true
      const res = await window.ember.secret.set(provider, key).catch(() => null)
      if (!res?.ok) {
        status.textContent = `could not write ${state()?.path ?? 'secrets.json'}`
        action.disabled = false
        return
      }
      this.secrets.set(provider, { path: state()?.path ?? '', configured: res.configured, hint: res.hint })
      input.value = ''
      input.placeholder = placeholder()
      status.textContent = done
      window.setTimeout(() => {
        if (status.textContent === done) status.textContent = ''
      }, 4000)
      this.renderSecretClear(wrap, input, status, provider)
    }

    input.addEventListener('input', () => {
      action.disabled = !input.value.trim()
      status.textContent = ''
    })
    input.addEventListener('keydown', (e) => {
      // Enter is what you reach for after pasting; the button is for people who don't.
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault()
        void apply(input.value, 'saved')
      }
    })
    action.addEventListener('click', () => void apply(input.value, 'saved'))

    wrap.append(input, action, status)
    this.renderSecretClear(wrap, input, status, provider)
    return wrap
  }

  /** The Clear button only exists while there is something to clear. */
  private renderSecretClear(
    wrap: HTMLElement,
    input: HTMLInputElement,
    status: HTMLElement,
    provider: 'openai' | 'anthropic',
  ): void {
    wrap.querySelector('.ember-secret-clear')?.remove()
    if (!this.secrets.get(provider)?.configured) return
    const clear = document.createElement('button')
    clear.className = 'ember-secret-clear'
    clear.textContent = 'Clear'
    clear.addEventListener('click', async () => {
      const res = await window.ember.secret.set(provider, '').catch(() => null)
      if (!res?.ok) return
      const prev = this.secrets.get(provider)
      this.secrets.set(provider, { path: prev?.path ?? '', configured: res.configured, hint: res.hint })
      input.placeholder = provider === 'openai' ? 'sk-…' : 'sk-ant-…'
      status.textContent = 'cleared'
      clear.remove()
    })
    wrap.insertBefore(clear, status)
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

    if (field.kind === 'font') {
      const picker = new FontPicker({
        fonts: this.fonts,
        value: String(value ?? ''),
        ...(field.inherit ? { inherit: field.inherit } : {}),
        // Fonts are not dragged, so there is nothing to coalesce — write immediately
        // and let the watcher re-font the app while the panel is still open.
        onChange: (next) => {
          commit(next)
          this.flush()
        },
      })
      return picker.el
    }

    if (field.kind === 'secret') return this.buildSecret(field.provider ?? 'openai')

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
