import type { EmberConfig, ThemeConfig } from '@shared/types'
import { AGENTS, type AgentId } from '@shared/agents'
import { AgentPicker, noKeysNote } from './AgentPicker'
import { drawMascot } from './Mascot'

/**
 * The first five minutes.
 *
 * Four steps, each skippable: what Ember is, which agent CLI it runs on (detected, with
 * an Install button for the ones that are missing), how it looks, and the handful of
 * keys worth knowing on day one. It edits the config the same way Settings does — the
 * file, then the watcher — so a choice made here is live the instant it is made, and
 * finishing is nothing more than writing `agent.onboarded`.
 */
export interface OnboardingOptions {
  config: () => EmberConfig
  save: (next: EmberConfig) => void
  themes: () => Promise<ThemeConfig[]>
  runInTab: (command: string, title: string) => void
  /** Finished or skipped. `launch` means start the chosen agent in the current tab. */
  onDone: (launch: AgentId | null) => void
}

const STEPS = ['Welcome', 'Your agent', 'Look', 'Keys'] as const

/** Palettes worth offering first; whichever of these the build has. */
const FEATURED = ['nightfall', 'tokyo night', 'catppuccin mocha', 'rosé pine', 'gruvbox dark', 'nord', 'dracula', 'kanagawa']

export class Onboarding {
  readonly el: HTMLElement
  private readonly card: HTMLElement
  private step = 0
  private picker: AgentPicker | null = null
  private raf = 0
  private launch = true

  constructor(private readonly opts: OnboardingOptions) {
    this.el = document.createElement('div')
    this.el.className = 'ember-onboard'
    this.card = document.createElement('div')
    this.card.className = 'ember-onboard-card'
    this.el.appendChild(this.card)
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.finish(false)
    })
  }

  show(): void {
    this.step = 0
    document.body.appendChild(this.el)
    requestAnimationFrame(() => this.el.classList.add('is-open'))
    this.render()
  }

  private close(): void {
    cancelAnimationFrame(this.raf)
    this.el.classList.remove('is-open')
    window.setTimeout(() => this.el.remove(), 220)
  }

  private patch(fn: (c: EmberConfig) => void): void {
    const next = structuredClone(this.opts.config())
    fn(next)
    this.opts.save(next)
  }

  private finish(launch: boolean): void {
    const agent = this.opts.config().agent.default
    this.patch((c) => {
      c.agent.onboarded = true
    })
    this.close()
    this.opts.onDone(launch ? agent : null)
  }

  private render(): void {
    cancelAnimationFrame(this.raf)
    const dots = document.createElement('div')
    dots.className = 'ember-onboard-dots'
    STEPS.forEach((name, i) => {
      const d = document.createElement('button')
      d.className = 'ember-onboard-dot'
      d.classList.toggle('is-current', i === this.step)
      d.classList.toggle('is-done', i < this.step)
      d.title = name
      d.addEventListener('click', () => {
        this.step = i
        this.render()
      })
      dots.appendChild(d)
    })

    const body = document.createElement('div')
    body.className = 'ember-onboard-body'
    switch (this.step) {
      case 0:
        this.welcome(body)
        break
      case 1:
        this.agent(body)
        break
      case 2:
        void this.look(body)
        break
      default:
        this.keys(body)
    }

    const nav = document.createElement('div')
    nav.className = 'ember-onboard-nav'
    const skip = document.createElement('button')
    skip.className = 'ember-onboard-btn is-quiet'
    skip.textContent = 'Skip setup'
    skip.addEventListener('click', () => this.finish(false))
    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    nav.append(skip, spacer)
    if (this.step > 0) {
      const back = document.createElement('button')
      back.className = 'ember-onboard-btn is-quiet'
      back.textContent = 'Back'
      back.addEventListener('click', () => {
        this.step--
        this.render()
      })
      nav.appendChild(back)
    }
    const next = document.createElement('button')
    next.className = 'ember-onboard-btn is-primary'
    const last = this.step === STEPS.length - 1
    next.textContent = this.step === 0 ? 'Get started' : last ? 'Start working' : 'Next'
    next.addEventListener('click', () => {
      if (last) return this.finish(this.launch)
      this.step++
      this.render()
    })
    nav.appendChild(next)

    this.card.replaceChildren(dots, body, nav)
    next.focus()
  }

  private welcome(body: HTMLElement): void {
    const canvas = document.createElement('canvas')
    canvas.className = 'ember-onboard-mascot'
    const size = 88
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = canvas.style.height = `${size}px`
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    const t0 = performance.now()
    const tick = () => {
      const t = (performance.now() - t0) / 1000
      ctx.clearRect(0, 0, size, size)
      // Working for a few seconds, then it looks up at you: that is the whole pitch.
      const mood = t % 7 < 4.5 ? { state: 'working' as const, attention: null } : { state: 'attention' as const, attention: 'handoff' as const }
      drawMascot(ctx, size, mood, t, 0)
      this.raf = requestAnimationFrame(tick)
    }
    tick()

    const h = document.createElement('h1')
    h.textContent = 'Welcome to Ember'
    const lead = document.createElement('p')
    lead.className = 'ember-onboard-lead'
    lead.textContent =
      'A terminal for working alongside coding agents. Your shell stays exactly as it is — Ember adds a place to see every session at once, a panel the agent can draw on, and a living map of your projects.'
    const list = document.createElement('ul')
    list.className = 'ember-onboard-points'
    for (const [title, text] of [
      ['Every session as a card', 'Cinder tells you which ones are working, which are done, and which are waiting on you.'],
      ['A panel beside the terminal', 'Your agent puts diagrams, tables and mockups there — and buttons that answer back.'],
      ['The map', 'Ctrl+Shift+G: an architecture map of a project that the agent keeps up to date.'],
      ['Your CLI, your plan', 'Claude Code, Codex, Gemini, Cursor, OpenCode or Copilot. No API keys, ever.'],
    ]) {
      const li = document.createElement('li')
      const b = document.createElement('strong')
      b.textContent = title!
      li.append(b, document.createTextNode(` ${text}`))
      list.appendChild(li)
    }
    body.append(canvas, h, lead, list)
  }

  private agent(body: HTMLElement): void {
    const h = document.createElement('h2')
    h.textContent = 'Which agent do you work with?'
    const lead = document.createElement('p')
    lead.className = 'ember-onboard-lead'
    lead.textContent =
      'Ember runs any of these in its tabs. The one you pick here is also the one Ember asks when it builds a map or checks your todos. You can change it any time in Settings › Agent.'
    this.picker ??= new AgentPicker({
      chosen: this.opts.config().agent.default,
      onChoose: (id) =>
        this.patch((c) => {
          c.agent.default = id
        }),
      runInTab: (command, title) => this.opts.runInTab(command, title),
    })
    const picker = this.picker
    void picker.refresh().then(() => {
      // The default is Claude Code; on a machine without it, pick what is there instead.
      const chosen = this.opts.config().agent.default
      const installed = picker.firstInstalled()
      if (installed && !picker.isInstalled(chosen)) {
        this.patch((c) => {
          c.agent.default = installed
        })
        picker.setChosen(installed)
      }
    })
    body.append(h, lead, noKeysNote(), this.picker.el)
  }

  private async look(body: HTMLElement): Promise<void> {
    const h = document.createElement('h2')
    h.textContent = 'Make it yours'
    const lead = document.createElement('p')
    lead.className = 'ember-onboard-lead'
    lead.textContent = 'A few of the 49 palettes. Every one re-tints the whole window. # in the command palette has the rest.'
    const grid = document.createElement('div')
    grid.className = 'ember-onboard-themes'
    body.append(h, lead, grid)

    const all = await this.opts.themes().catch(() => [] as ThemeConfig[])
    const fold = (s: string) => s.toLowerCase()
    const picks: ThemeConfig[] = []
    for (const want of FEATURED) {
      const t = all.find((x) => fold(x.name).includes(want))
      if (t && !picks.includes(t)) picks.push(t)
    }
    for (const t of all) if (picks.length < 8 && !picks.includes(t)) picks.push(t)

    const draw = () => {
      grid.replaceChildren()
      const current = this.opts.config().theme.name
      for (const t of picks.slice(0, 8)) {
        const b = document.createElement('button')
        b.className = 'ember-onboard-theme'
        b.classList.toggle('is-current', t.name === current)
        b.style.background = t.background
        b.style.color = t.foreground
        const sw = document.createElement('span')
        sw.className = 'ember-onboard-swatch'
        for (const c of [t.red, t.yellow, t.green, t.cyan, t.blue, t.magenta]) {
          const i = document.createElement('i')
          i.style.background = c
          sw.appendChild(i)
        }
        const name = document.createElement('span')
        name.textContent = t.name
        b.append(sw, name)
        b.addEventListener('click', () => {
          this.patch((c) => {
            c.theme = structuredClone(t)
          })
          window.setTimeout(draw, 60)
        })
        grid.appendChild(b)
      }
    }
    draw()

    const motion = document.createElement('label')
    motion.className = 'ember-onboard-toggle'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'ember-toggle'
    box.checked = this.opts.config().cursor.pulsePeriod > 0
    box.addEventListener('change', () =>
      this.patch((c) => {
        c.cursor.pulsePeriod = box.checked ? 3.2 : 0
        c.cursor.trailOpacity = box.checked ? 1 : 0
        c.effects.outputMotion = box.checked
      })
    )
    const text = document.createElement('span')
    text.textContent = 'Full motion — the travelling caret, its trail and the breathing glow. Off is lighter on an older laptop.'
    motion.append(box, text)
    body.appendChild(motion)
  }

  private keys(body: HTMLElement): void {
    const agent = AGENTS[this.opts.config().agent.default]
    const h = document.createElement('h2')
    h.textContent = 'Six keys and you know Ember'
    const grid = document.createElement('div')
    grid.className = 'ember-onboard-keys'
    for (const [keys, what] of [
      ['Ctrl K', 'The command palette. Every action Ember has, by name.'],
      ['Ctrl Shift T', 'A new session. Alt Shift + and − split the one you are in.'],
      ['Ctrl Shift J', 'The panel beside the terminal, where your agent draws.'],
      ['Ctrl Shift G', 'The map: a living architecture view of a project.'],
      ['Ctrl Shift S', 'Overview: every session and what it last said.'],
      ['F1', 'Every shortcut. Ctrl , opens Settings.'],
    ]) {
      const k = document.createElement('div')
      k.className = 'ember-onboard-key'
      const kbd = document.createElement('div')
      for (const part of keys!.split(' ')) {
        const el = document.createElement('kbd')
        el.textContent = part
        kbd.appendChild(el)
      }
      const p = document.createElement('p')
      p.textContent = what!
      k.append(kbd, p)
      grid.appendChild(k)
    }
    const launch = document.createElement('label')
    launch.className = 'ember-onboard-toggle'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'ember-toggle'
    box.checked = this.launch
    box.addEventListener('change', () => (this.launch = box.checked))
    const text = document.createElement('span')
    text.textContent = `Start ${agent.name} in this tab when I finish`
    launch.append(box, text)
    const tip = document.createElement('p')
    tip.className = 'ember-onboard-lead'
    tip.textContent = `Tip: every command also works from the shell — try \`ember\` for the list. Inside ${agent.name}, ask it to “show me” something and watch the panel.`
    body.append(h, grid, launch, tip)
  }
}
