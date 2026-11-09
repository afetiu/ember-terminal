import type { ClaudeLimit, ClaudeUsage, VitalsState } from '@shared/types'

/** The subset of the Battery Status API this widget reads; not in lib.dom. */
interface BatteryLike extends EventTarget {
  level: number
  charging: boolean
}

/**
 * Machine vitals in one quiet line at the very bottom of the sidebar: CPU and
 * memory load, and battery when there is one. CPU/MEM come from the main
 * process; battery from the renderer's own Battery API.
 */
export class Vitals {
  readonly el: HTMLElement
  private readonly cpu: HTMLElement
  private readonly mem: HTMLElement
  private readonly bat: HTMLElement
  /** The plan's windows, on the left so they read as a different kind of number. */
  private readonly plan: HTMLElement
  private readonly unsubs: (() => void)[] = []
  private battery: BatteryLike | null = null
  private usage: ClaudeUsage | null = null
  private showPlan = true

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'ember-vitals'

    // Two rows, set like a small table: a dim caption at the left of each, and the
    // values right-packed in cells of one width so the numbers stand in columns —
    // Claude's windows above, the machine's load below. Six chips do not fit one line
    // of the sidebar, and a plan row with nothing in it takes no height.
    this.plan = document.createElement('div')
    this.plan.className = 'ember-vitals-row ember-vitals-plan is-empty'
    const machine = document.createElement('div')
    machine.className = 'ember-vitals-row'
    this.cpu = this.chip('', '', 'Processor load')
    this.mem = this.chip('', '', 'Memory in use')
    this.bat = this.chip('is-hidden', '', 'Battery')
    machine.append(Vitals.caption('MACHINE'), this.cpu, this.mem, this.bat)

    this.el.append(this.plan, machine)

    this.unsubs.push(window.ember.vitals.onState((s) => this.renderVitals(s)))
    void window.ember.vitals.state().then((s) => this.renderVitals(s))
    this.wireBattery()
    this.wireUsage()
  }

  // ---------- the plan's limits ----------

  private wireUsage(): void {
    this.unsubs.push(window.ember.usage.onState((u) => this.renderUsage(u)))
    void window.ember.usage.state().then((u) => this.renderUsage(u))
    this.unsubs.push(
      window.ember.onConfigChange((c) => {
        this.showPlan = c.claude.usageLimits
        if (this.usage) this.renderUsage(this.usage)
      })
    )
    void window.ember.getConfig().then((c) => {
      this.showPlan = c.claude.usageLimits
      if (this.usage) this.renderUsage(this.usage)
    })
  }

  /**
   * One chip per window: `5H 4%`, `WK 29%`, and a model-scoped weekly as its name.
   * Rebuilt on every state, which is once a minute — not worth a signature.
   */
  private renderUsage(u: ClaudeUsage): void {
    this.usage = u
    const cells: HTMLElement[] = []

    if (this.showPlan && !u.limits.length && u.at) {
      const el = this.chip('is-plan is-stale', 'PLAN ?', u.error === 'signed-out' ? 'Run `claude` and sign in to see plan usage' : `Plan usage unavailable: ${u.error ?? 'no data'}. Click to retry`)
      el.addEventListener('click', () => window.ember.usage.refresh())
      cells.push(el)
    } else if (this.showPlan) {
      for (const l of u.limits.slice(0, 3)) {
        const el = this.chip('is-plan', '', Vitals.describe(l, u))
        Vitals.fill(el, Vitals.tag(l), l.percent)
        el.classList.toggle('is-warn', l.percent >= 75 && l.percent < 90)
        el.classList.toggle('is-low', l.percent >= 90)
        el.classList.toggle('is-stale', !u.ok)
        el.addEventListener('click', () => window.ember.usage.refresh())
        cells.push(el)
      }
    }

    this.plan.classList.toggle('is-empty', cells.length === 0)
    this.plan.replaceChildren(Vitals.caption('CLAUDE'), ...cells)
  }

  /** The row's name, in the margin. */
  private static caption(text: string): HTMLElement {
    const el = document.createElement('span')
    el.className = 'ember-vitals-cap'
    el.textContent = text
    return el
  }

  private static tag(l: ClaudeLimit): string {
    if (l.label === 'session') return '5H'
    if (l.label === 'weekly') return 'WK'
    return l.label.toUpperCase().slice(0, 6)
  }

  private static describe(l: ClaudeLimit, u: ClaudeUsage): string {
    const what = l.label === 'session' ? 'Session limit (5 hours)' : l.label === 'weekly' ? 'Weekly limit' : `Weekly limit for ${l.label}`
    const reset = l.resetsAt ? ` · resets ${Vitals.until(l.resetsAt)}` : ''
    const plan = u.plan ? ` · ${u.plan} plan` : ''
    const stale = u.ok ? '' : ` · last fetched ${Vitals.ago(u.at)}${u.error ? ` (${u.error})` : ''}`
    return `${what}: ${l.percent}% used${reset}${plan}${stale}. Click to refresh`
  }

  private static until(at: number): string {
    const ms = at - Date.now()
    const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (ms <= 0) return 'now'
    const h = Math.floor(ms / 3_600_000)
    const m = Math.round((ms % 3_600_000) / 60_000)
    if (h >= 24) return `in ${Math.round(h / 24)}d (${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${time})`
    return `in ${h ? `${h}h ` : ''}${m}m (${time})`
  }

  private static ago(at: number): string {
    const m = Math.round((Date.now() - at) / 60_000)
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
  }

  private chip(extra: string, text: string, title: string): HTMLElement {
    const el = document.createElement('span')
    el.className = `ember-vitals-chip${extra ? ` ${extra}` : ''}`
    el.textContent = text
    el.title = title
    return el
  }

  private renderVitals(s: VitalsState): void {
    Vitals.fill(this.cpu, 'CPU', s.cpu)
    Vitals.fill(this.mem, 'MEM', s.mem)
  }

  /**
   * A reading as `KEY 40%`: the key, a meter and the number. The text reads the same as
   * it always did; the meter is hidden where a look has no use for one (Basalt) and drawn
   * as a thin track where it does.
   */
  private static fill(el: HTMLElement, key: string, percent: number): void {
    const text = `${key} ${percent}%`
    if (el.textContent === text) return
    const k = document.createElement('span')
    k.className = 'ember-vitals-k'
    k.textContent = key
    const bar = document.createElement('span')
    bar.className = 'ember-vitals-bar'
    bar.style.setProperty('--v', String(Math.max(0, Math.min(100, percent)) / 100))
    const v = document.createElement('span')
    v.className = 'ember-vitals-v'
    v.textContent = `${percent}%`
    el.replaceChildren(k, ' ', bar, v)
  }

  private wireBattery(): void {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }
    if (!nav.getBattery) return
    void nav
      .getBattery()
      .then((b) => {
        this.battery = b
        const update = () => this.renderBattery()
        b.addEventListener('levelchange', update)
        b.addEventListener('chargingchange', update)
        this.unsubs.push(() => {
          b.removeEventListener('levelchange', update)
          b.removeEventListener('chargingchange', update)
        })
        update()
      })
      .catch(() => {
        /* no battery information — the chip just stays hidden */
      })
  }

  private renderBattery(): void {
    const b = this.battery
    // A desktop PSU reports "full and charging" forever; that is not a battery
    // worth a chip.
    const show = !!b && !(b.charging && b.level >= 0.99)
    this.bat.classList.toggle('is-hidden', !show)
    if (!b || !show) return
    const pct = Math.round(b.level * 100)
    Vitals.fill(this.bat, b.charging ? 'CHG' : 'BAT', pct)
    this.bat.classList.toggle('is-low', !b.charging && pct <= 20)
  }

  dispose(): void {
    for (const u of this.unsubs) u()
    this.unsubs.length = 0
  }
}
