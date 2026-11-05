import type { ClaudeStatus, EmberCost } from '@shared/types'
import { agentSpec } from '@shared/agents'
import { escapeHtml } from '../markdown'
import { readTui, type TuiRead } from '../tuiScreen'
import type { LoomView } from '../LoomView'
import { div, type Mode } from './shared'

/** The agents laid out as canvas above, their real CLI below. */
const WRAPPED = new Set(['claude', 'codex'])

/** Rows the CLI keeps over the TUI's bottom area: the one row the conversation may still use. */
export const SPARE = 1
/** The CLI never gets smaller than this, whatever the screen says. */
export const MIN_CLI_ROWS = 4
/** The CLI's height before the agent has drawn its first prompt (its banner, a trust dialog). */
const START_ROWS = 12
/** What the canvas keeps at the least, in px. */
const MIN_CANVAS = 96
/** The seam between the canvas and the CLI, in px. */
export const DIVIDER_H = 9
/** How much of the tab the CLI takes at once when the TUI's bottom area outgrows the CLI. */
const GROWN = 0.7
/** A smaller bottom area must hold this long before the CLI shrinks to it. */
const SHRINK_MS = 300
/** How long the TUI gets to redraw after the box changes size before an unreadable screen counts. */
const REDRAW_MS = 150
/** The gap between the two halves of a kick: long enough for the TUI to see two resizes. */
const KICK_MS = 90
/** How many rows a key that opens a menu (`/`, `@`) adds before the TUI has drawn it. */
const PRE_ROWS = 6
/** The most of the tab a picker or dialog gets. */
const PICKER_SHARE = 0.5

/** A dialog or picker in the prompt's place (not the `/` or `@` list, which follows the typing). */
function isPicker(r: TuiRead): boolean {
  return r.room && !!r.key && r.key !== 'slash menu' && r.key !== 'file menu'
}

/** What the bottom area shows, for holding a height while it shows it: a dialog's name, or "working". */
function floorKey(r: TuiRead): string {
  return r.room ? r.key : r.live ? 'working' : ''
}

/**
 * The agent the tab's shell is running, and the tab's layout while it runs.
 *
 * A wrapped agent (Claude Code, Codex) splits the tab: the canvas above, the agent's real
 * terminal below. The terminal is the tab's own xterm, moved to the bottom box — its PTY is
 * resized to that box, and the TUI redraws itself at that size. Nothing of the terminal is
 * cropped, masked or transformed.
 *
 * The "tight CLI": the box is as tall as the TUI's own bottom area (its working line,
 * queued messages, todo list, the prompt box, the footer — or the picker, dialog or menu it
 * shows) plus one spare row, so the TUI has no room left to draw the conversation: that is
 * the canvas's. tuiScreen.ts measures the area from the screen; `look` sizes the box. When
 * the area outgrows the box (it reaches the top row, or the prompt or dialog is not all on
 * screen) the box grows at once; it shrinks back once the smaller area has held a moment.
 * Ctrl+` gives the CLI the whole tab.
 *
 * Any other agent the tab runs gets the Canvas | CLI switch over its whole screen.
 */
export class AgentHost {
  /** The seam between canvas and CLI: a hairline, nothing to grab (the height is automatic). */
  readonly divider = div('loom-divider', '<span class="loom-divider-line"></span>')
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

  /** The CLI's height now, in rows. */
  wantRows = START_ROWS
  /** The smallest height the TUI's plain idle prompt has needed since the agent started. */
  idleRows = 0
  /** For probes: a height that overrides the measured one (0: measured). */
  forceRows = 0
  private pendingRows = 0
  private pendingSince = 0
  /** The height a dialog needed after a shrink made it outgrow the box: it keeps it while it shows. */
  private floor = { key: '', rows: 0 }
  private lastShrink = { key: '', from: 0, at: 0 }
  /** Grown ahead of a redraw the person's key is about to cause (`/`, `@`, Enter on a command). */
  private preUntil = 0
  private preRows = 0
  /** What the last look at the screen said. */
  read: TuiRead | null = null
  /** Every change of height, for probes: when, from, to and why. */
  readonly sizes: Array<{ t: number; from: number; to: number; why: string }> = []
  private liveAt = 0
  private recheck = 0
  /** When the box last changed size, and whether a look is waiting for the TUI's redraw. */
  private placedAt = 0
  private redrawWait = false
  /** A kick under way: grown one row over, back to `to` at `at` (see `look`). */
  private kick: { at: number; to: number } | null = null
  private kickedAt = 0
  /** Kicks in a row that left the area still scrolled up. */
  private cutKicks = 0

  constructor(private readonly v: LoomView) {
    this.divider.setAttribute('aria-hidden', 'true')
  }

  /** The CLI is taller than its idle prompt: the TUI shows more than the plain prompt. */
  get grown(): boolean {
    return this.wantRows > Math.max(this.idleRows, MIN_CLI_ROWS) + 1
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
    this.wantRows = START_ROWS
    this.idleRows = 0
    this.preUntil = 0
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

  /** The most rows the CLI can have: the tab less the canvas's least. */
  private mostRows(): number {
    const { h, pad } = this.cell()
    return Math.max(MIN_CLI_ROWS, Math.floor((this.v.panes.clientHeight - MIN_CANVAS - DIVIDER_H - pad) / h))
  }

  /** The rows for a share of the tab. */
  private shareRows(share: number): number {
    const { h, pad } = this.cell()
    return Math.max(MIN_CLI_ROWS, Math.min(this.mostRows(), Math.floor((this.v.panes.clientHeight * share - pad) / h)))
  }

  /** The CLI's height in px for `rows` rows, kept inside what the tab can give. */
  private cliPx(rows: number): number {
    const { h, pad } = this.cell()
    const r = Math.max(MIN_CLI_ROWS, Math.min(this.mostRows(), rows))
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
    const cli = this.cliPx(this.wantRows)
    const top = Math.max(0, total - cli)
    this.place(top)
    this.divider.classList.add('is-on')
    this.divider.style.top = `${(top - DIVIDER_H).toFixed(1)}px`
    v.sizeCanvas(top - DIVIDER_H)
  }

  /**
   * Where the terminal's box starts. The pane keeps its left, right and bottom at the tab's
   * edges; only its top moves. The terminal is fitted to the new box at once (not on the
   * resize observer's debounce), so the PTY is the box's size from the same frame: a growth
   * reaches the TUI a frame later, and the box never shows rows the PTY does not have.
   */
  private place(top: number): void {
    const v = this.v
    const pane = v.session.el
    const px = top > 0 ? `${top.toFixed(1)}px` : ''
    if (pane.style.top === px) return
    pane.style.top = px
    this.placedAt = performance.now()
    if (top > 0) v.session.applyFit()
  }

  /** The height the screen asks for now, and why. */
  private measure(r: TuiRead): { rows: number; why: string } {
    const term = this.v.session.term
    const most = this.mostRows()
    const big = this.shareRows(GROWN)
    if (this.forceRows) return { rows: this.forceRows, why: 'forced' }
    let rows: number
    let why = r.why || 'bottom area'
    // Nothing recognisable (a fresh start, a half-drawn redraw): the height stays.
    if (!r.dock && !r.cut) return { rows: this.promptSeen ? this.wantRows : Math.max(this.wantRows, START_ROWS), why: 'unchanged' }
    // Part of it is out of view, or its top is nowhere to be found — unless the box has only
    // just changed size and the TUI's redraw is still on its way (a shorter screen makes
    // Claude Code draw it all again, and halfway through it reads as cut).
    if (r.cut && performance.now() - this.placedAt < REDRAW_MS) {
      this.redrawWait = true
      return { rows: this.wantRows, why: 'waiting for the redraw' }
    }
    if (!r.dock) rows = term.rows >= big ? most : big
    else rows = r.dock + SPARE
    // What outgrew the box once when it was shrunk (a dialog, the working area) keeps the
    // height it had then, while it shows: no shrinking and growing in turn.
    const fk = floorKey(r)
    if (fk && this.floor.key === fk) rows = Math.max(rows, this.floor.rows)
    // A picker sizes its list to the screen: room given makes it longer, which would ask for
    // more again. It never gets more than a fixed share of the tab, and the measure brings it
    // down to what it draws at that height (its title to its footer, nothing above).
    if (isPicker(r)) rows = Math.min(rows, this.shareRows(PICKER_SHARE))
    // A key the person just pressed is about to open a menu: room for it now, so the TUI
    // draws it into a box it already fits (the measure trims what it did not need).
    if (Date.now() < this.preUntil && !r.room) {
      rows = Math.max(rows, Math.min(big, this.preRows))
      why = 'pre-grown'
    }
    return { rows, why }
  }

  /**
   * Read the agent's screen and size the CLI to its bottom area. More room is given at once;
   * less only once the smaller area has held for SHRINK_MS (a redraw can show a half-drawn
   * screen, and a menu filtering as you type changes height with every key).
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
    this.redrawWait = false
    const m = this.measure(r)
    let target = Math.max(MIN_CLI_ROWS, Math.min(this.mostRows(), m.rows))
    const fk = floorKey(r)
    if (fk !== this.floor.key) this.floor = { key: '', rows: 0 }
    // Grown again right after a shrink, for the same thing: that shrink was one too many.
    if (target > this.wantRows && fk && this.lastShrink.key === fk && now - this.lastShrink.at < 1500 && !this.forceRows) {
      this.floor = { key: fk, rows: Math.max(this.floor.rows, this.lastShrink.from) }
      target = Math.max(target, this.floor.rows)
    }
    if (target !== this.pendingRows) {
      this.pendingRows = target
      this.pendingSince = now
    }
    const held = now - this.pendingSince
    const resize = (to: number, why: string) => {
      this.sizes.push({ t: performance.now(), from: this.wantRows, to, why })
      if (this.sizes.length > 300) this.sizes.splice(0, this.sizes.length - 300)
      this.wantRows = to
    }
    if (!r.cut) this.cutKicks = 0
    let done = !!this.kick && now < this.kick.at && target <= this.wantRows
    if (this.kick && now >= this.kick.at) {
      // The second half of a kick: one row less, which makes the TUI lay its bottom area out
      // afresh (not needed if the area has grown into the row meanwhile).
      const k = this.kick
      this.kick = null
      if (target <= k.to) {
        resize(Math.max(target, k.to), 'kick: redraw')
        done = true
      }
    }
    if (done) {
      /* the kick is under way, or just made */
    } else if (r.cut && r.dock && !this.forceRows && target <= this.wantRows && !this.kick && now - this.kickedAt > 400 && !(isPicker(r) && this.cutKicks >= 3)) {
      // The bottom area fits, but its top has scrolled out of view (it outgrew the box for a
      // moment): Claude Code's classic screen draws it again in place only when the screen
      // gets shorter. One row more, then back — and if that has not done it twice over, a
      // good deal more, which the shrink after brings back down.
      this.kickedAt = now
      this.cutKicks++
      const to = Math.max(target, this.wantRows)
      if (this.cutKicks > 2 && !isPicker(r)) resize(Math.max(to + 1, this.shareRows(GROWN)), 'kick: still scrolled up')
      else {
        this.kick = { at: now + KICK_MS, to }
        resize(to + 1, 'kick: scrolled up')
      }
    } else if (target !== this.wantRows && (target > this.wantRows || held >= SHRINK_MS)) {
      if (target > this.wantRows && r.cut && !this.forceRows) {
        // Grown because part of the bottom area had scrolled away: a row over, then back, so
        // the TUI draws it whole at the new height (a taller screen alone does not redraw it).
        this.kickedAt = now
        this.kick = { at: now + KICK_MS, to: target }
        resize(target + 1, m.why)
      } else {
        if (target < this.wantRows) this.lastShrink = { key: fk, from: this.wantRows, at: now }
        this.kick = null
        resize(target, m.why)
      }
    }
    // The plain idle prompt's own height, once it has held: what "grown" is measured against.
    if (r.prompt && !r.room && !r.cut && !r.live && target === this.wantRows && held >= SHRINK_MS) this.idleRows = this.idleRows ? Math.min(this.idleRows, target) : target
    // A still screen draws nothing that would call again: look once more while it waits.
    window.clearTimeout(this.recheck)
    if (this.kick) this.recheck = window.setTimeout(() => v.schedule(), Math.max(0, this.kick.at - now) + 5)
    else if (target !== this.wantRows) this.recheck = window.setTimeout(() => v.schedule(), SHRINK_MS - held + 10)
    else if (this.redrawWait) this.recheck = window.setTimeout(() => v.schedule(), REDRAW_MS + 10)
    // Still cut, on a screen that may draw nothing more: look again, the kick above will act.
    else if (r.cut && !this.forceRows) this.recheck = window.setTimeout(() => v.schedule(), Math.max(60, 410 - (now - this.kickedAt)))
    else if (this.live || now < this.preUntil) this.recheck = window.setTimeout(() => v.schedule(), 250)
  }

  /**
   * A key the person typed into the TUI, before the TUI has seen it. One that is about to
   * open a menu or a picker (`/` or `@` into an empty prompt, Enter on a `/command`) grows
   * the CLI now, so the TUI draws the menu at a size it already fits in.
   */
  keyDown(e: KeyboardEvent): void {
    if (!this.onAgent || this.v.raw || this.v.mode !== 'claude' || !this.read?.prompt) return
    const text = this.read.text.trim()
    let pre = 0
    if ((e.key === '/' || e.key === '@') && !e.ctrlKey && !e.altKey && !text) pre = PRE_ROWS
    else if (e.key === 'Enter' && !e.shiftKey && /^\/[\w:.-]+$/.test(text)) pre = PRE_ROWS
    // Codex leaves its working line out when the box has no row for it (nothing on screen
    // says a turn is on): a message sent gets the rows for it now, and keeps them once drawn.
    else if (e.key === 'Enter' && !e.shiftKey && this.onAgent === 'codex' && text) pre = 3
    if (!pre) return
    // Keys in a row (Enter on each queued message) do not add up.
    if (Date.now() >= this.preUntil) this.preRows = this.wantRows + pre
    this.preUntil = Date.now() + (pre === PRE_ROWS ? 700 : 2500)
    this.layoutSplit()
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

  /** For probes: hold the CLI at `rows` (0: measured again). */
  setRows(rows: number): void {
    this.forceRows = Math.max(0, Math.round(rows))
    this.v.schedule()
  }

  dispose(): void {
    window.clearTimeout(this.recheck)
    this.divider.remove()
    this.starting.remove()
  }
}
