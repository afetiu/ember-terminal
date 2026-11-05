import type { ClaudeStatus, EmberCost } from '@shared/types'
import { agentSpec } from '@shared/agents'
import { escapeHtml } from '../markdown'
import { readTui, type TuiRead } from '../tuiScreen'
import type { LoomView } from '../LoomView'
import { div, reduced, type Mode } from './shared'

/** The agents laid out as canvas above, their real CLI below. */
const WRAPPED = new Set(['claude', 'codex'])

/** The CLI's height when nobody has chosen one, in rows. */
export const DEFAULT_CLI_ROWS = 15
/** The CLI never gets smaller than this: its prompt and footer always fit. */
export const MIN_CLI_ROWS = 10
/** What the canvas keeps at the least, in px. */
const MIN_CANVAS = 96
/** The divider's height: the line and its grab area. */
export const DIVIDER_H = 9
/** How much of the tab the CLI takes while the TUI shows a picker or a dialog. */
const GROWN = 0.7
/** Rows of the conversation kept above the TUI's bottom area when that area grows it. */
const HEADROOM = 3
const ROWS_KEY = 'ember.cliRows'

function savedRows(): number {
  try {
    const n = Number(window.localStorage.getItem(ROWS_KEY))
    return Number.isFinite(n) && n >= MIN_CLI_ROWS ? Math.round(n) : DEFAULT_CLI_ROWS
  } catch {
    return DEFAULT_CLI_ROWS
  }
}

function saveRows(n: number): void {
  try {
    if (n === DEFAULT_CLI_ROWS) window.localStorage.removeItem(ROWS_KEY)
    else window.localStorage.setItem(ROWS_KEY, String(n))
  } catch {
    /* remembered for this run only */
  }
}

/**
 * The agent the tab's shell is running, and the tab's layout while it runs.
 *
 * A wrapped agent (Claude Code, Codex) splits the tab: the canvas above, the agent's real
 * terminal below, with a divider between. The terminal is the tab's own xterm, moved to the
 * bottom box — its PTY is resized to that box, and the TUI redraws itself at that size.
 * Nothing of the terminal is cropped, masked or transformed.
 *
 * The CLI's height is the person's (the divider, remembered), except while the TUI shows
 * more than its plain prompt — a picker, a permission prompt, a question, a menu — when it
 * grows to most of the tab and goes back once the prompt is plain again (tuiScreen.ts
 * decides). Ctrl+` gives the CLI the whole tab.
 *
 * Any other agent the tab runs gets the Canvas | CLI switch over its whole screen.
 */
export class AgentHost {
  readonly divider = div('loom-divider', '<span class="loom-divider-line"></span><span class="loom-divider-grip"></span>')
  /** "Starting Claude Code…", over the shell until the agent's own screen is up. */
  private readonly starting = div('loom-starting')
  private agentUp = false
  /** The agent last reported to main for this tab, so it is told once per change. */
  private tabAgentSent: string | null = null
  /** When the tab's current agent started, for finding its session log. */
  private tabAgentSince = Date.now()
  /** The wrapped agent running in the tab's shell (announced, and no prompt since), or null. */
  onAgent: string | null = null
  /** The agent is mid-turn (its working line is on screen). */
  working = false
  /** The working line, as the agent draws it. */
  live: TuiRead['live'] = null
  /** The agent's plain prompt has been on screen since it started. */
  promptSeen = false
  status: ClaudeStatus | null = null
  cost: EmberCost | null = null
  /** The session's name (`/rename`), from Claude Code's hooks. */
  title = ''

  /** The CLI's height the person chose, in rows. */
  userRows = savedRows()
  /** The CLI's height now, in rows: the person's, or more while the TUI needs it. */
  wantRows = this.userRows
  private pendingRows = 0
  private mostHeld = false
  private pendingSince = 0
  /** What the last look at the screen said. */
  read: TuiRead | null = null
  private liveAt = 0
  private recheck = 0
  /** A drag in progress: the CLI's height follows the pointer. */
  private dragPx = 0
  /** A drag made while grown: stays until the TUI is plain again, then the person's height is back. */
  private heldPx = 0
  /** The pane's last top, so a change is known (and animated). */
  private lastTop = -1

  constructor(private readonly v: LoomView) {
    this.wireDivider()
  }

  /** The CLI is taller than the person's height: the TUI needs it. */
  get grown(): boolean {
    return this.wantRows > this.userRows
  }

  /** Claude Code is running in the tab. */
  get claudeOn(): boolean {
    return this.onAgent === 'claude'
  }

  /** The agent's name as the canvas says it: "Claude Code", "Codex". */
  get who(): string {
    return agentSpec(this.onAgent ?? 'claude').name.replace(/ CLI$/, '')
  }

  rowsText(): string[] {
    const buf = this.v.session.term.buffer.active
    const out: string[] = []
    for (let y = 0; y < this.v.session.term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return out
  }

  layout(): void {
    const v = this.v
    if (v.disposed) return
    const term = v.session.term
    const buf = term.buffer.active
    if (!v.panes.clientHeight || !term.rows) return

    // Which agent the shell said it started (Ember's shims announce it, and the shell's
    // next prompt says it has gone).
    const agent = v.session.announcedAgent
    // Told again once the folder is known: an agent started with the shell runs before
    // the first prompt has said where the shell is.
    const told = `${agent ?? ''}|${v.session.cwd}`
    if (told !== this.tabAgentSent) {
      const fresh = (this.tabAgentSent ?? '').split('|')[0] !== (agent ?? '')
      this.tabAgentSent = told
      if (fresh) this.tabAgentSince = Date.now()
      window.ember.canvas.tabAgent(v.tabId, agent && agent !== 'claude' ? agent : null, v.session.cwd || v.session.initialCwd || '', this.tabAgentSince)
    }
    const wrapped = !!agent && WRAPPED.has(agent)
    let mode: Mode
    if (wrapped) mode = 'claude'
    else if (agent) mode = 'app'
    else mode = buf.type === 'alternate' ? 'app' : 'shell'
    // An agent tab opened from Ctrl+K: the shell is covered until the agent's screen is up,
    // or until the shell's prompt shows (the agent exited or could not start: show why).
    if (v.session.startAgent && !this.agentUp) {
      if (mode === 'claude' || v.session.prompts > 0) this.agentUp = true
      if (!this.starting.isConnected && !this.agentUp) {
        this.starting.innerHTML = `<span class="dot"></span><span>Starting ${escapeHtml(agentSpec(v.session.startAgent).name)}…</span>`
        v.panes.appendChild(this.starting)
        window.setTimeout(() => {
          this.agentUp = true
          this.starting.remove()
        }, 25_000)
      }
      if (this.agentUp) this.starting.remove()
    }
    this.agentChanged(wrapped ? agent : null)
    if (v.raw && (mode === 'claude' || (mode === 'app' && !!agent))) mode = 'raw'
    v.session.setStill(wrapped)
    if (mode === 'claude') {
      this.layoutSplit()
      return
    }
    // The shell, an app or an agent's whole screen: the terminal as it is, the whole tab.
    this.place(0)
    this.divider.classList.remove('is-on')
    v.setMode(mode, false)
    // The switch stays while an agent's own screen is shown, whatever it looks like.
    v.rawPill.classList.toggle('is-on', mode === 'raw' || (mode === 'app' && !!agent))
    // Still read in the full CLI, so the canvas's working line is right on coming back.
    if (mode === 'raw' && wrapped) this.look()
  }

  // ---------------------------------------------------------------- the agent comes and goes

  private agentChanged(agent: string | null): void {
    const v = this.v
    if (agent === this.onAgent) return
    this.onAgent = agent
    if (!agent) v.clearPasted()
    this.promptSeen = false
    this.wantRows = this.userRows
    this.heldPx = 0
    this.setLive(null)
    // The keyboard stays in the terminal: the person types into the agent's own prompt.
    if (v.hooks.isActive()) requestAnimationFrame(() => v.session.term.focus())
    this.hint()
    v.hooks.changed?.()
  }

  // ---------------------------------------------------------------- canvas above, CLI below

  /** The terminal's row height and its padding, in CSS px. */
  private cell(): { h: number; pad: number } {
    const term = this.v.session.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } }
    let h = term._core?._renderService?.dimensions?.css?.cell?.height ?? 0
    if (!h) h = (this.v.session.term.options.fontSize ?? 14) * (this.v.session.term.options.lineHeight ?? 1.2) * 1.2
    const x = this.v.session.term.element
    let pad = 0
    if (x) {
      const cs = getComputedStyle(x)
      pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    }
    return { h, pad }
  }

  /** The CLI's height in px for `rows` rows, kept inside what the tab can give. */
  private cliPx(rows: number, total: number): number {
    const { h, pad } = this.cell()
    const most = Math.max(MIN_CLI_ROWS, Math.floor((total - MIN_CANVAS - DIVIDER_H - pad) / h))
    const r = Math.max(MIN_CLI_ROWS, Math.min(most, rows))
    // Half a pixel to spare, so the fit never rounds a row away.
    return r * h + pad + 0.5
  }

  private layoutSplit(): void {
    const v = this.v
    const total = v.panes.clientHeight
    if (!total) return
    v.setMode('claude', true)
    v.rawPill.classList.remove('is-on')
    this.look()
    const { h, pad } = this.cell()
    let rows = this.wantRows
    if (this.dragPx) rows = Math.round((this.dragPx - pad) / h)
    else if (this.heldPx) rows = Math.round((this.heldPx - pad) / h)
    const cli = this.cliPx(rows, total)
    const top = Math.max(0, total - cli)
    this.place(top)
    this.divider.classList.add('is-on')
    this.divider.style.top = `${(top - DIVIDER_H).toFixed(1)}px`
    v.sizeCanvas(top - DIVIDER_H)
  }

  /**
   * Where the terminal's box starts. The pane keeps its left, right and bottom at the tab's
   * edges; only its top moves, and the session's own resize observer fits the terminal to
   * the box and resizes the PTY. A change glides (unless dragged, or motion is reduced).
   */
  private place(top: number): void {
    const v = this.v
    const pane = v.session.el
    const px = top > 0 ? `${top.toFixed(1)}px` : ''
    if (pane.style.top === px) return
    const glide = !this.dragPx && this.lastTop > 0 && top > 0 && !reduced()
    v.el.classList.toggle('is-gliding', glide)
    this.divider.classList.toggle('is-gliding', glide)
    pane.classList.toggle('is-gliding', glide)
    pane.style.top = px
    this.lastTop = top
  }

  /**
   * Read the agent's screen and decide the CLI's height. A picker or a dialog gets most of
   * the tab; the bottom area (working line, todo list, queued messages, the prompt, its
   * footer) gets at least its own rows and a few of the conversation above. More room is
   * given as soon as the screen has held still a moment (a redraw can show a half-drawn
   * screen); it is taken back only once the smaller need has held for a little while.
   */
  look(): void {
    const v = this.v
    if (!this.onAgent) return
    const r = readTui(v.session.term, this.onAgent)
    this.read = r
    const now = Date.now()
    if (r.prompt && !this.promptSeen) {
      this.promptSeen = true
      this.hint()
    }
    if (r.live) this.liveAt = now
    if (r.prompt) v.syncPasted(r.marks)
    this.setLive(r.live ?? (now - this.liveAt < 1500 ? this.live : null))
    // Before the first prompt only a dialog counts (a fresh `claude` draws nothing for a moment).
    const room = r.room || (this.promptSeen && !r.prompt)
    const { h, pad } = this.cell()
    const total = v.panes.clientHeight
    let target = this.userRows
    // A long prompt that filled its box keeps all the room while it stays long: at a
    // smaller height the box would fill again and the two would take turns.
    this.mostHeld = !!r.most || (this.mostHeld && r.why.startsWith('long prompt'))
    if (this.mostHeld) target = Math.max(target, Math.floor((total - pad) / h))
    else if (room) target = Math.max(target, Math.floor((total * GROWN - pad) / h))
    else if (r.need) target = Math.max(target, r.need + HEADROOM)
    if (target !== this.pendingRows) {
      this.pendingRows = target
      this.pendingSince = now
    }
    const held = now - this.pendingSince
    if (target !== this.wantRows && held >= (target > this.wantRows ? 120 : 350)) {
      this.wantRows = target
      // A size dragged while grown lasts until the TUI is plain again.
      if (target === this.userRows) this.heldPx = 0
      v.schedule()
    }
    // A still screen draws nothing that would call again: look once more while it waits.
    const pending = target !== this.wantRows || !!this.live
    window.clearTimeout(this.recheck)
    if (pending) this.recheck = window.setTimeout(() => v.schedule(), target > this.wantRows ? 130 : 380)
  }

  private setLive(live: TuiRead['live']): void {
    const v = this.v
    if (JSON.stringify(live) === JSON.stringify(this.live) && this.working === !!live) return
    const was = this.working
    this.live = live
    this.working = !!live
    v.stage.spin = live ? { ...live } : { glyph: '✻', verb: 'Working…', detail: '' }
    v.stage.renderNow()
    if (was !== this.working) {
      v.stage.restage()
      v.stage.trail.classList.toggle('is-on', this.working && v.stage.trail.childElementCount > 0)
      if (!this.working) v.stage.clearTrail()
      this.hint()
      v.hooks.changed?.()
    }
  }

  /** The words on an empty canvas while the agent runs. */
  hint(): void {
    const v = this.v
    const text = v.hint.querySelector('.loom-hint-text')
    if (text && this.onAgent)
      text.textContent = this.promptSeen ? `${this.who} is below. What it says and shows appears here.` : `${this.who} is starting…`
    const open = v.input.ctxMenu.classList.contains('is-on') || v.notebook.drawer.classList.contains('is-on')
    v.hint.classList.toggle('is-gone', !v.feed.isEmpty || this.working || open)
  }

  // ---------------------------------------------------------------- the divider

  private wireDivider(): void {
    const d = this.divider
    d.setAttribute('role', 'separator')
    d.setAttribute('aria-orientation', 'horizontal')
    d.title = 'Drag to size the CLI · double-click to reset'
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      d.setPointerCapture(e.pointerId)
      d.classList.add('is-dragging')
      document.body.classList.add('is-resizing')
      const total = this.v.panes.clientHeight
      const pr = this.v.panes.getBoundingClientRect()
      const move = (ev: PointerEvent) => {
        const cli = Math.max(0, pr.bottom - ev.clientY - DIVIDER_H / 2)
        this.dragPx = Math.max(this.cliPx(MIN_CLI_ROWS, total), Math.min(cli, total - MIN_CANVAS - DIVIDER_H))
        this.v.schedule()
      }
      const up = () => {
        d.removeEventListener('pointermove', move)
        d.removeEventListener('pointerup', up)
        d.removeEventListener('pointercancel', up)
        d.classList.remove('is-dragging')
        document.body.classList.remove('is-resizing')
        if (this.dragPx) {
          const { h, pad } = this.cell()
          const rows = Math.max(MIN_CLI_ROWS, Math.round((this.dragPx - pad) / h))
          // Sized while a picker had it grown: that size holds until the picker goes; the
          // person's own height is what they set with nothing grown.
          if (this.grown) this.heldPx = this.dragPx
          else {
            this.userRows = this.wantRows = rows
            saveRows(rows)
          }
          this.dragPx = 0
          this.v.schedule()
        }
        this.v.session.term.focus()
      }
      d.addEventListener('pointermove', move)
      d.addEventListener('pointerup', up)
      d.addEventListener('pointercancel', up)
    })
    d.addEventListener('dblclick', () => this.resetSize())
  }

  /** The CLI back to its default height. */
  resetSize(): void {
    this.userRows = this.wantRows = DEFAULT_CLI_ROWS
    this.heldPx = 0
    saveRows(DEFAULT_CLI_ROWS)
    this.v.schedule()
    this.v.session.term.focus()
  }

  /** For probes and the keyboard: the person's CLI height, in rows. */
  setRows(rows: number): void {
    this.userRows = this.wantRows = Math.max(MIN_CLI_ROWS, Math.round(rows))
    saveRows(this.userRows)
    this.v.schedule()
  }

  dispose(): void {
    window.clearTimeout(this.recheck)
    this.divider.remove()
    this.starting.remove()
  }
}
