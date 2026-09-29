import type { ClaudeLimit, ClaudeUsage, DeskState, VitalsState } from '@shared/types'

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
  /** Computer use: shown only once a Claude has driven the desktop in this run. */
  private readonly desk: HTMLElement
  private readonly deskState: HTMLElement
  private readonly deskWhat: HTMLElement
  private readonly deskSwitch: HTMLElement
  private deskHalted = false
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

    // Computer use, under the machine: state, what Claude is doing, and the switch.
    // The switch is the same one the overlay's pill and `desk halt` throw.
    this.desk = document.createElement('div')
    this.desk.className = 'ember-vitals-row ember-vitals-desk is-empty'
    this.deskState = this.chip('is-desk-state', '', 'Computer use')
    this.deskWhat = this.chip('is-desk-what', '', '')
    this.deskSwitch = this.chip('is-desk-switch', 'STOP', 'Stop Claude using the computer')
    this.deskSwitch.setAttribute('role', 'button')
    this.deskSwitch.addEventListener('click', () => {
      if (this.deskHalted) window.ember.desk.resume()
      else window.ember.desk.halt()
    })
    this.desk.append(Vitals.caption('COMPUTER'), this.deskState, this.deskWhat, this.deskSwitch)
    this.el.append(this.plan, machine, this.desk)

    this.unsubs.push(window.ember.vitals.onState((s) => this.renderVitals(s)))
    void window.ember.vitals.state().then((s) => this.renderVitals(s))
    this.unsubs.push(window.ember.desk.onState((s) => this.renderDesk(s)))
    void window.ember.desk.state().then((s) => this.renderDesk(s))
    this.wireBattery()
    this.wireUsage()
  }

  // ---------- computer use ----------

  private renderDesk(s: DeskState): void {
    this.deskHalted = s.halted
    // Nothing to say until something has happened: a fresh app shows two rows, not three.
    const show = s.halted || s.running || !!s.last || (s.ready !== 'off' && s.ready !== 'ok')
    this.desk.classList.toggle('is-empty', !show)
    if (!show) return

    const text = s.halted
      ? 'HALTED'
      : s.busy
        ? '● BUSY'
        : s.running
          ? 'IDLE'
          : s.ready === 'installing'
            ? 'SETUP…'
            : s.ready === 'starting'
              ? 'STARTING'
              : s.ready === 'off'
                ? 'OFF'
                : 'N/A'
    if (this.deskState.textContent !== text) this.deskState.textContent = text
    this.deskState.classList.toggle('is-desk-busy', s.busy && !s.halted)
    this.deskState.classList.toggle('is-desk-halted', s.halted)
    this.deskState.classList.toggle('is-low', s.ready === 'no-python' || s.ready === 'no-deps' || s.ready === 'failed')
    this.deskState.title = s.halted
      ? 'Computer use is stopped. Press RESUME to allow it again'
      : s.message
        ? `Computer use: ${s.message}`
        : s.running
          ? 'A Claude in one of the tabs can drive the desktop'
          : 'Computer use'

    const what = s.halted ? '' : (s.last?.label ?? s.message ?? '')
    if (this.deskWhat.textContent !== what) this.deskWhat.textContent = what
    this.deskWhat.title = what

    const label = s.halted ? 'RESUME' : 'STOP'
    if (this.deskSwitch.textContent !== label) this.deskSwitch.textContent = label
    this.deskSwitch.classList.toggle('is-resume', s.halted)
    this.deskSwitch.title = s.halted ? 'Allow computer use again' : 'Stop Claude using the computer, now'
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
        const el = this.chip('is-plan', `${Vitals.tag(l)} ${l.percent}%`, Vitals.describe(l, u))
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
    const cpu = `CPU ${s.cpu}%`
    const mem = `MEM ${s.mem}%`
    if (this.cpu.textContent !== cpu) this.cpu.textContent = cpu
    if (this.mem.textContent !== mem) this.mem.textContent = mem
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
    const text = `${b.charging ? 'CHG' : 'BAT'} ${pct}%`
    if (this.bat.textContent !== text) this.bat.textContent = text
    this.bat.classList.toggle('is-low', !b.charging && pct <= 20)
  }

  dispose(): void {
    for (const u of this.unsubs) u()
    this.unsubs.length = 0
  }
}
