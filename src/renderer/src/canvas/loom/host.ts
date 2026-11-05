import type { ClaudeStatus, EmberCost } from '@shared/types'
import { agentSpec } from '@shared/agents'
import { escapeHtml } from '../markdown'
import { readLive, type LiveRead } from '../liveRead'
import { LiveView } from '../liveView'
import type { LoomView } from '../LoomView'
import { div, type Mode } from './shared'

/** The agents laid out as canvas above, their real CLI's live area below. */
const WRAPPED = new Set(['claude', 'codex'])

/** What the canvas keeps at the least, in px. */
const MIN_CANVAS = 96
/** The seam between the canvas and the CLI, in px. */
export const DIVIDER_H = 9

/**
 * The agent the tab's shell is running, and the tab's layout while it runs.
 *
 * A wrapped agent (Claude Code, Codex) splits the tab: the canvas above, the CLI's live area
 * below (docs/specs/stream-engine.md). The tab's real terminal stays the whole tab — its PTY
 * is never resized for the split, so the TUI draws every menu, picker and dialog at full
 * size — and keeps the keyboard, but is not seen while the canvas is on. The stream engine
 * says which of its rows are the live area (the prompt, menus, dialogs, the queue, the
 * working line, the status lines); the box at the bottom (liveView.ts) shows exactly those
 * rows, as many as there are, on complete frames. Ctrl+` shows the real terminal, whole tab.
 *
 * A full-screen (alternate screen) TUI can't be split: the real terminal, whole tab.
 * Any other agent the tab runs gets the Canvas | CLI switch over its whole screen.
 */
export class AgentHost {
  /** The seam between canvas and CLI: a hairline, nothing to grab (the height is the CLI's). */
  readonly divider = div('loom-divider', '<span class="loom-divider-line"></span>')
  /** "Starting Claude Code…", over the shell until the agent's own screen is up. */
  private readonly starting = div('loom-starting')
  /** The CLI box: the live area of the real terminal. */
  readonly liveView: LiveView
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
  live: LiveRead['live'] = null
  /** The agent's plain prompt has been on screen since it started. */
  promptSeen = false
  status: ClaudeStatus | null = null
  cost: EmberCost | null = null
  /** The session's name (`/rename`), from Claude Code's hooks. */
  title = ''
  /** What the last look at the live area said. */
  read: LiveRead | null = null
  private liveAt = 0
  private recheck = 0
  /** The box's height last laid out, in px (0: not split). */
  private boxPx = 0
  private readonly v: LoomView

  constructor(v: LoomView, cursorColor: string) {
    this.v = v
    this.divider.setAttribute('aria-hidden', 'true')
    this.liveView = new LiveView(v.session, cursorColor)
    // The box drew a frame of another height: the canvas and the seam follow in the same frame.
    this.liveView.onDrawn = () => {
      if (this.v.mode === 'claude' && !this.v.raw) this.fit()
    }
    this.liveView.onHeight = () => this.v.schedule()
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
    // A full-screen TUI has no live area to split off: its whole screen.
    if (wrapped && buf.type !== 'alternate') mode = 'claude'
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
    this.unsplit()
    this.divider.classList.remove('is-on')
    v.setMode(mode, false)
    // The switch stays while an agent's own screen is shown, whatever it looks like.
    v.rawPill.classList.toggle('is-on', mode === 'raw' || (mode === 'app' && !!agent))
    // Still read in the full CLI, so the canvas's working line is right on coming back.
    if (wrapped) this.look()
  }

  // ---------------------------------------------------------------- the agent comes and goes

  private agentChanged(agent: string | null): void {
    const v = this.v
    if (agent === this.onAgent) return
    this.onAgent = agent
    if (!agent) v.clearPasted()
    this.promptSeen = false
    this.liveView.start(agent)
    this.setLive(null)
    // The keyboard stays in the terminal: the person types into the agent's own prompt.
    if (v.hooks.isActive()) requestAnimationFrame(() => v.session.term.focus())
    this.hint()
    v.hooks.changed?.()
  }

  // ---------------------------------------------------------------- canvas above, CLI below

  /** The terminal's row height and its padding, in CSS px. */
  private cell(): { h: number; padTop: number; padBottom: number } {
    const term = this.v.session.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } }
    let h = term._core?._renderService?.dimensions?.css?.cell?.height ?? 0
    if (!h) h = (this.v.session.term.options.fontSize ?? 14) * (this.v.session.term.options.lineHeight ?? 1.2) * 1.2
    const x = this.v.session.term.element
    let padTop = 0
    let padBottom = 0
    if (x) {
      const cs = getComputedStyle(x)
      padTop = parseFloat(cs.paddingTop) || 0
      padBottom = parseFloat(cs.paddingBottom) || 0
    }
    return { h, padTop, padBottom }
  }

  private layoutSplit(): void {
    const v = this.v
    if (!v.panes.clientHeight) return
    v.setMode('claude', true)
    v.rawPill.classList.remove('is-on')
    // The real terminal: the whole tab, its PTY the whole tab's size, not seen.
    this.place(0)
    v.session.el.classList.add('is-under')
    const lv = this.liveView
    if (!lv.el.isConnected) v.panes.appendChild(lv.el)
    const { h, padTop, padBottom } = this.cell()
    // As many rows as the live area has, up to all the tab but the canvas's least: a picker
    // Claude sizes to the screen (/mcp) is shown whole, its selection and footer included.
    lv.setCap(Math.floor((v.panes.clientHeight - MIN_CANVAS - DIVIDER_H - padTop - padBottom) / h))
    lv.show(true)
    this.look()
    this.fit()
  }

  /** The box as tall as the rows it drew; the canvas and the seam above it. */
  private fit(): void {
    const v = this.v
    const total = v.panes.clientHeight
    if (!total) return
    const lv = this.liveView
    const { h, padTop, padBottom } = this.cell()
    const x = v.session.term.element
    const rows = lv.shown.rows
    const most = Math.max(0, total - MIN_CANVAS - DIVIDER_H)
    const px = rows ? Math.min(most, rows * h + padTop + padBottom) : 0
    if (x) {
      const cs = getComputedStyle(x)
      const pad = `${padTop}px ${cs.paddingRight} ${padBottom}px ${cs.paddingLeft}`
      if (lv.el.style.padding !== pad) lv.el.style.padding = pad
    }
    // Exactly over the real terminal's columns: the pane's left edge and width.
    const pr = v.session.el.getBoundingClientRect()
    const gr = v.panes.getBoundingClientRect()
    const left = `${(pr.left - gr.left).toFixed(1)}px`
    const width = `${pr.width.toFixed(1)}px`
    if (lv.el.style.left !== left) lv.el.style.left = left
    if (lv.el.style.width !== width) lv.el.style.width = width
    if (px !== this.boxPx) {
      this.boxPx = px
      lv.el.style.height = `${px.toFixed(1)}px`
    }
    const top = total - px
    this.divider.classList.toggle('is-on', px > 0)
    this.divider.classList.toggle('is-more', lv.shown.total > lv.shown.rows)
    this.divider.style.top = `${(top - DIVIDER_H).toFixed(1)}px`
    v.sizeCanvas(px > 0 ? top - DIVIDER_H : total)
  }

  /** Not split: the real terminal seen again, the box away. */
  private unsplit(): void {
    this.place(0)
    this.v.session.el.classList.remove('is-under')
    this.liveView.show(false)
    this.boxPx = 0
  }

  /** Where the real terminal's box starts: the whole tab, always (0). */
  private place(top: number): void {
    const v = this.v
    const pane = v.session.el
    const px = top > 0 ? `${top.toFixed(1)}px` : ''
    if (pane.style.top === px) return
    pane.style.top = px
    v.session.applyFit()
  }

  /** Read the live area for the canvas: the working line, the pictures' marks, the prompt. */
  look(): void {
    const v = this.v
    if (!this.onAgent) return
    const r = readLive(this.liveView.liveRows(), this.onAgent)
    this.read = r
    const now = Date.now()
    if (r.prompt && !this.promptSeen) {
      this.promptSeen = true
      this.hint()
    }
    if (r.live) this.liveAt = now
    if (r.prompt) v.syncPasted(r.marks)
    this.setLive(r.live ?? (now - this.liveAt < 1500 ? this.live : null))
    window.clearTimeout(this.recheck)
    if (this.live) this.recheck = window.setTimeout(() => v.schedule(), 250)
  }

  private setLive(live: LiveRead['live']): void {
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

  dispose(): void {
    window.clearTimeout(this.recheck)
    this.liveView.dispose()
    this.v.session.el.classList.remove('is-under')
    this.divider.remove()
    this.starting.remove()
  }
}
