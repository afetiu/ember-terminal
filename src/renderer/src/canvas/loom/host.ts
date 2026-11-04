import type { ClaudeStatus, EmberCost } from '@shared/types'
import { agentSpec } from '@shared/agents'
import { escapeHtml } from '../markdown'
import type { AgentWrapper, WrapperHost } from '../AgentWrapper'
import { ClaudeTui } from '../ClaudeTui'
import { CodexTui } from '../CodexTui'
import type { LoomView } from '../LoomView'
import { BAR_H, FRAME_PAD, div, type Mode } from './shared'

/** The agents with a wrapper: the canvas with Ember's composer over their own screen. */
const WRAPPED = new Set(['claude', 'codex'])

/**
 * The agent the tab's shell is running, and where its input sits. An agent with a wrapper
 * (Claude Code: ClaudeTui, Codex: CodexTui) gets the canvas with Ember's composer and the
 * bar under it, and none of its own screen; any other agent the Canvas | CLI switch over
 * its whole screen. This decides the mode, hides or shows the terminal pane, and lays out
 * the composer's frame and the bar, with the model picker above it.
 */
export class AgentHost {
  /** The frame round the input box, the bar under it, and what sits on the frame's top edge. */
  readonly frame = div('loom-frame-box')
  readonly bar = div('loom-bar')
  /** The model picker, above the bar. */
  readonly barPick = div('loom-bar-pick')
  // ================================================================ the composer's place
  readonly above = div('loom-above')
  /** "Starting Claude Code…", over the shell until the agent's own screen is up. */
  private readonly starting = div('loom-starting')
  private agentUp = false
  /** The agent last reported to main for this tab, so it is told once per change. */
  private tabAgentSent: string | null = null
  /** When the tab's current agent started, for finding its session log. */
  private tabAgentSince = Date.now()
  /** What drives the agent on the canvas, once one has run in the tab. */
  wrapper: AgentWrapper | null = null
  /** The wrapped agent running in the tab's shell (announced, and no prompt since), or null. */
  onAgent: string | null = null
  /** The wrapped agent says it is mid-turn. */
  working = false
  status: ClaudeStatus | null = null
  barKey = ''
  cost: EmberCost | null = null

  constructor(private readonly v: LoomView) {
    this.barPick.setAttribute('role', 'listbox')
  }

  /** Claude Code is running in the tab, on its wrapper. */
  get claudeOn(): boolean {
    return this.onAgent === 'claude'
  }

  /** The agent's name as the canvas says it: "Claude Code", "Codex". */
  private get who(): string {
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
    const pane = v.session.el
    if (!pane.clientHeight || !term.rows) return

    // Which agent the shell said it started (Ember's shims announce it, and the shell's
    // next prompt says it has gone). One with a wrapper gets the canvas with Ember's
    // composer; any other agent the switch over its whole screen.
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
    this.wrapState(wrapped ? agent : null)
    if (v.raw && (mode === 'claude' || (mode === 'app' && !!agent))) mode = 'raw'
    if (mode === 'claude') {
      this.layoutWrapped()
      return
    }
    // The shell, an app or an agent's own screen: the terminal as it is, whole.
    if (pane.style.visibility) pane.style.visibility = ''
    v.setMode(mode, false)
    // The switch stays while an agent's own screen is shown, whatever it looks like.
    v.rawPill.classList.toggle('is-on', mode === 'raw' || (mode === 'app' && !!agent))
    this.frame.classList.remove('is-on', 'is-native')
    this.bar.classList.remove('is-on', 'is-native')
    this.above.classList.remove('is-on')
  }

  // ---------------------------------------------------------------- an agent on its wrapper

  /** A wrapped agent started or stopped in the tab's shell: its wrapper is told, made the first time. */
  private wrapState(agent: string | null): void {
    const v = this.v
    if (agent === this.onAgent) return
    if (this.onAgent) this.wrapper?.ended()
    this.onAgent = agent
    if (agent) {
      if (this.wrapper && this.wrapper.agent !== agent) {
        this.wrapper.dispose()
        this.wrapper = null
      }
      if (!this.wrapper) {
        const host: WrapperHost = {
          tabId: v.tabId,
          feed: v.feed,
          frame: this.frame,
          above: this.above,
          term: v.session.term,
          write: (d) => window.ember.write(v.session.id, d),
          cwd: () => v.session.cwd || v.session.initialCwd || '',
          inCli: () => v.raw,
          openCli: () => v.setRaw(true),
          changed: () => this.wrapperChanged(),
          cleared: () => {
            v.feed.switchSession(false, true)
            v.hint.classList.toggle('is-gone', !v.feed.isEmpty)
            v.stage.restage()
            v.stage.renderNow()
          },
          relayout: () => v.schedule(),
          toast: (t) => v.hooks.toast(t),
        }
        this.wrapper = agent === 'codex' ? new CodexTui(host) : new ClaudeTui(host)
        // Said once it is ours: the wrapper's first state came before `this.wrapper` was set,
        // and the canvas went on saying "Claude Code is here" through the whole start.
        this.wrapperChanged()
        const input = this.wrapper.input
        const nf = () => this.frame.classList.toggle('is-focus', document.activeElement === input)
        input.addEventListener('focus', nf)
        input.addEventListener('blur', nf)
      } else this.wrapper.started()
      const input = this.wrapper.input
      v.session.focusInstead = () => (v.raw ? v.session.term.focus() : input.focus())
      if (v.hooks.isActive() && !v.raw) requestAnimationFrame(() => input.focus())
    } else {
      v.session.focusInstead = null
      this.frame.classList.remove('is-on', 'is-native')
      this.above.classList.remove('is-on')
      this.bar.classList.remove('is-on', 'is-native')
      this.closeBarPick()
      // Back to the shell: the keyboard goes to its prompt.
      if (v.hooks.isActive()) requestAnimationFrame(() => v.session.term.focus())
    }
    this.barKey = ''
    v.hooks.changed?.()
  }

  /**
   * The wrapped agent's canvas: nothing of its screen. The canvas takes the tab down to
   * Ember's composer, with the bar under it; the terminal keeps its full size underneath,
   * out of sight, so the agent lays itself out as it always does.
   */
  private layoutWrapped(): void {
    const v = this.v
    const w = this.wrapper
    const pane = v.session.el
    const paneH = pane.clientHeight
    if (!paneH || !w) return
    pane.style.visibility = 'hidden'
    v.setMode('claude', true)
    v.rawPill.classList.remove('is-on')
    w.screen()
    const left = pane.offsetLeft
    const width = pane.offsetWidth
    const frameH = Math.max(w.input.offsetHeight, 20) + FRAME_PAD * 2
    const frameTop = pane.offsetTop + paneH - BAR_H - 6 - frameH
    this.frame.classList.add('is-on', 'is-native')
    this.frame.classList.remove('is-empty')
    this.above.classList.add('is-on')
    this.bar.classList.add('is-on', 'is-native')
    Object.assign(this.frame.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${frameTop.toFixed(1)}px`, height: `${frameH.toFixed(1)}px` })
    Object.assign(this.above.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${frameTop.toFixed(1)}px` })
    Object.assign(this.bar.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${(pane.offsetTop + paneH - BAR_H - 2).toFixed(1)}px`, height: `${BAR_H}px` })
    v.sizeCanvas(frameTop - pane.offsetTop - 8)
    this.renderBarWrapped()
    this.claudeHint()
  }

  /** The wrapper's state changed: the working line, the bar, the hint. */
  private wrapperChanged(): void {
    const v = this.v
    const s = this.wrapper?.state
    if (!s) return
    const was = this.working
    this.working = s.phase === 'working' || !!s.live
    v.stage.spin = s.live ? { ...s.live } : { glyph: '✻', verb: s.phase === 'starting' ? 'Starting…' : 'Working…', detail: '' }
    const hint = v.hint.querySelector('.loom-hint-text')
    if (hint && this.onAgent)
      hint.textContent = s.phase === 'starting' ? s.boot || `Starting ${this.who}…` : `${this.who} is here. Ask below — what it says and shows appears on this canvas.`
    this.claudeHint()
    v.stage.renderNow()
    if (was !== this.working) {
      v.stage.restage()
      v.stage.trail.classList.toggle('is-on', this.working && v.stage.trail.childElementCount > 0)
      if (!this.working) v.stage.clearTrail()
    }
    this.barKey = ''
    if (this.bar.classList.contains('is-on') && v.mode === 'claude') this.renderBarWrapped()
    v.hooks.changed?.()
  }

  /** "Claude Code is here": only on an empty canvas with nothing open over it. */
  claudeHint(): void {
    const v = this.v
    const w = this.wrapper
    if (!w || !this.onAgent) return
    const open = w.busy || this.barPick.classList.contains('is-on') || v.input.ctxMenu.classList.contains('is-on') || v.notebook.drawer.classList.contains('is-on')
    v.hint.classList.toggle('is-gone', !v.feed.isEmpty || w.state.phase === 'working' || w.state.phase === 'asking' || open || w.away)
  }

  /** The bar: the mode (a switch), the model (a picker), context used, what it is doing. */
  private renderBarWrapped(): void {
    const s = this.wrapper?.state
    // Claude Code's status line reports for its own tab only.
    const st = this.claudeOn ? this.status : null
    const away = !!this.wrapper?.away
    const key = `${this.onAgent}|${away}|${s?.phase}|${s?.boot ?? ''}|${s?.mode}|${s?.model}|${s?.effort}|${s?.context ?? ''}|${st?.at ?? ''}|${this.cost?.tokens ?? ''}`
    if (key === this.barKey) return
    this.barKey = key
    const modes: Record<string, [string, string]> = {
      bypassPermissions: ['bypass', 'is-bypass'],
      acceptEdits: ['accept edits', 'is-edits'],
      plan: ['plan', 'is-plan'],
      auto: ['auto', 'is-auto'],
      dontAsk: ["don't ask", 'is-auto'],
    }
    const [label, cls] = modes[s?.mode ?? ''] ?? ['default', 'is-default']
    const phase = away
      ? 'in the CLI'
      : s?.phase === 'starting'
        ? s.boot ? s.boot.replace(/^Starting [^·]+ · /, 'starting · ') : 'starting…'
        : s?.phase === 'working' ? 'working · esc to interrupt' : s?.phase === 'asking' ? 'waiting for you' : s?.phase === 'exited' ? 'exited' : 'ready'
    const parts: string[] = []
    const what = this.claudeOn ? 'Permission mode' : 'Mode'
    parts.push(`<button type="button" class="loom-bar-mode ${cls}" title="${what} — click or Shift+Tab to cycle"><i></i>${escapeHtml(label)}</button>`)
    const name = st?.model || s?.model || this.who
    const size = st?.contextSize && st.contextSize >= 1_000_000 && !/context|1M/i.test(name) ? ' 1M' : ''
    if (this.wrapper?.models().length) parts.push(`<button type="button" class="loom-bar-model loom-bar-pickmodel" title="Model — click to switch">${escapeHtml(name)}${size}<span class="loom-bar-caret">▾</span></button>`)
    else parts.push(`<span class="loom-bar-model">${escapeHtml(name)}${size}</span>`)
    if (s?.effort) parts.push(`<span class="loom-bar-effort" title="Effort (/effort to change)">${escapeHtml(s.effort)}</span>`)
    const ctx = st?.contextPercent ?? s?.context
    if (ctx != null) {
      const p = Math.max(0, Math.min(100, Math.round(ctx)))
      parts.push(`<span class="loom-bar-ctx${p >= 80 ? ' is-high' : ''}" title="Context used"><i style="--p:${p}%"></i>${p}%</span>`)
    }
    if (st?.costUsd != null) parts.push(`<span class="loom-bar-cost" title="This session, all of it">$${st.costUsd.toFixed(2)}</span>`)
    parts.push(`<span class="loom-bar-rest">${escapeHtml(phase)}</span>`)
    this.bar.innerHTML = parts.join('')
  }

  barClickClaude(t: HTMLElement): void {
    const w = this.wrapper
    if (!w) return
    if (t.closest('.loom-bar-mode')) {
      w.cycleMode()
      w.input.focus()
    } else if (t.closest('.loom-bar-pickmodel')) {
      if (this.barPick.classList.contains('is-on')) this.closeBarPick()
      else this.openBarPick(t.closest<HTMLElement>('.loom-bar-pickmodel')!)
    }
  }

  /** The model picker: the agent's own list, above the bar. Picking types `/model <it>`. */
  private openBarPick(anchor: HTMLElement): void {
    const w = this.wrapper
    if (!w) return
    const current = (this.status?.model || w.state.model).toLowerCase()
    this.barPick.innerHTML = w
      .models()
      .map((m) => {
        const on = !!current && (m.displayName.toLowerCase() === current || m.value.toLowerCase() === current)
        return (
          `<button type="button" role="option" data-model="${escapeHtml(m.value)}" class="${on ? 'is-on' : ''}" aria-selected="${on}">` +
          `<b>${escapeHtml(m.displayName || m.value)}</b><span>${escapeHtml(m.description ?? '')}</span></button>`
        )
      })
      .join('')
    const pr = this.v.panes.getBoundingClientRect()
    const ar = anchor.getBoundingClientRect()
    const br = this.bar.getBoundingClientRect()
    this.barPick.style.left = `${Math.max(8, ar.left - pr.left - 8).toFixed(0)}px`
    this.barPick.style.bottom = `${(pr.bottom - br.top + 6).toFixed(0)}px`
    this.barPick.classList.add('is-on')
    this.claudeHint()
  }

  closeBarPick(): boolean {
    if (!this.barPick.classList.contains('is-on')) return false
    this.barPick.classList.remove('is-on')
    this.claudeHint()
    return true
  }
}
