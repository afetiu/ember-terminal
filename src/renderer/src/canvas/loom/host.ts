import type { ClaudeStatus, EmberCost } from '@shared/types'
import { agentSpec } from '@shared/agents'
import { escapeHtml } from '../markdown'
import type { AgentWrapper } from '../AgentWrapper'
import { ClaudeTui } from '../ClaudeTui'
import type { LoomView } from '../LoomView'
import { AGENT_ROWS, BAR_H, FRAME_PAD, INPUT_ROWS, div, fmtTokens, type Dock, type Mode } from './shared'

/**
 * The agent the tab's shell is running, and where its input sits. Claude Code gets the
 * canvas with Ember's composer (ClaudeTui) and the bar under it; Codex its own input, cut
 * out of its screen and framed under the canvas; any other agent the last rows of its
 * screen. This decides the mode, moves and clips the terminal pane, and lays out the
 * composer's frame and the bar, with the model picker above it.
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
  /** The clip last put on the terminal pane. */
  private clipCss = ''
  /** When the tab's current agent started, for finding its session log. */
  private tabAgentSince = Date.now()
  dock: Dock | null = null
  /** What drives the agent on the canvas (Claude Code: ClaudeTui), once one has run in the tab. */
  wrapper: AgentWrapper | null = null
  /** Claude Code is running in the tab's shell (announced, and no prompt since). */
  claudeOn = false
  /** Claude Code says it is mid-turn. */
  working = false
  status: ClaudeStatus | null = null
  barKey = ''
  cost: EmberCost | null = null

  constructor(private readonly v: LoomView) {
    this.barPick.setAttribute('role', 'listbox')
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
    const screen = pane.querySelector<HTMLElement>('.xterm-screen')
    const paneH = pane.clientHeight
    if (!screen || !paneH || !term.rows) return
    const sr = screen.getBoundingClientRect()
    const pr = pane.getBoundingClientRect()
    const cellH = sr.height / term.rows
    const screenTop = sr.top - pr.top

    // Which agent the shell said it started (Ember's shims announce it, and the shell's
    // next prompt says it has gone). Claude Code gets the canvas with Ember's composer;
    // Codex its framed screen under the canvas; any other agent its whole screen.
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
    const who = agentSpec(agent ?? 'claude').name.replace(/ (CLI|Code)$/, '')
    const hintText = v.hint.querySelector('.loom-hint-text')
    if (hintText && agent !== 'claude' && !hintText.textContent?.startsWith(who)) hintText.textContent = `${who} is here. Ask below — what it says and shows appears on this canvas.`
    let mode: Mode
    if (agent === 'claude') mode = 'claude'
    else if (agent) mode = agent === 'codex' ? 'agent' : 'app'
    else mode = buf.type === 'alternate' ? 'app' : 'shell'
    // An agent tab opened from Ctrl+K: the shell is covered until the agent's screen is up,
    // or until the shell's prompt shows (the agent exited or could not start: show why).
    if (v.session.startAgent && !this.agentUp) {
      if (mode === 'claude' || mode === 'agent' || v.session.prompts > 0) this.agentUp = true
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
    this.claudeState(mode === 'claude')
    if (v.raw && (mode === 'claude' || mode === 'agent' || (mode === 'app' && !!agent))) mode = 'raw'
    if (mode === 'claude') {
      this.layoutClaude()
      return
    }
    if (pane.style.visibility) pane.style.visibility = ''

    let ty = 0
    let clip = 0
    let canvasH = 0
    let dock: Dock | null = null
    let mask = ''
    let frame: { top: number; height: number } | null = null
    let foot: string[] | null = null
    const gap = 4
    const rows = mode === 'agent' ? this.rowsText() : []

    // An agent with a screen profile (Codex) is framed: its own input, cut out of its
    // screen, in Ember's frame, its status lines said again in the bar.
    const codex = mode === 'agent' && agent === 'codex' ? findCodexDock(rows) : null
    // The shell is left exactly as PowerShell draws it: prompt at the top, output below.
    if (codex) {
      dock = codex
      const under = dock.foot !== undefined ? rows.slice(dock.foot, dock.bottom + 1) : null
      if (!dock.dialog && dock.box && under && isCodexFooter(under)) {
        const [b0, b1] = dock.box
        const boxTopPx = screenTop + b0 * cellH
        const bottomPx = screenTop + (b1 + 1) * cellH
        const frameH = Math.max(bottomPx - boxTopPx, INPUT_ROWS * cellH) + FRAME_PAD * 2
        ty = Math.max(0, paneH - BAR_H - 6 - frameH - boxTopPx + FRAME_PAD)
        const firstPx = Math.min(screenTop + dock.top * cellH, boxTopPx)
        clip = Math.max(0, firstPx - FRAME_PAD - 4)
        canvasH = Math.max(0, clip + ty - 4)
        frame = { top: boxTopPx + ty - FRAME_PAD, height: frameH }
        const typed = (rows[b0] ?? '').replace(/^\s*[❯›>]\s?/, '').trim()
        const empty = b0 === b1 && !typed
        this.frame.classList.toggle('is-empty', empty)
        if (empty) {
          const cw = sr.width / term.cols
          this.frame.style.setProperty('--ph-left', `${(sr.left - pr.left - 10 + cw * 2).toFixed(1)}px`)
          this.frame.style.setProperty('--ph-top', `${FRAME_PAD}px`)
          this.frame.style.setProperty('--ph-h', `${cellH.toFixed(1)}px`)
        }
        mask = `linear-gradient(to bottom, #000 0, #000 ${bottomPx.toFixed(1)}px, transparent ${bottomPx.toFixed(1)}px)`
        foot = under
      } else {
        const topPx = screenTop + dock.top * cellH
        const bottomPx = screenTop + (dock.bottom + 1) * cellH
        ty = Math.max(0, paneH - gap - bottomPx)
        clip = Math.max(0, topPx - 3)
        canvasH = Math.max(0, clip + ty)
      }
    } else if (mode === 'agent') {
      // Another agent's screen is not guessed at: the last rows it drew — its input and
      // status, whatever they look like — are shown whole under the canvas.
      let last = rows.length - 1
      while (last > 0 && !(rows[last] ?? '').trim()) last--
      const first = Math.max(0, last - AGENT_ROWS + 1)
      const topPx = screenTop + first * cellH
      const bottomPx = screenTop + (last + 1) * cellH
      ty = Math.max(0, paneH - gap - bottomPx)
      clip = Math.max(0, topPx - 3)
      canvasH = Math.max(0, clip + ty)
    }

    const showCanvas = mode === 'agent'
    v.setMode(mode, showCanvas)
    // The switch stays while an agent's own screen is shown, whatever it looks like.
    v.rawPill.classList.toggle('is-on', mode === 'raw' || (mode === 'app' && !!agent))
    pane.style.transform = ty ? `translate3d(0, ${ty.toFixed(1)}px, 0)` : ''
    const clipCss = clip ? `inset(${clip.toFixed(1)}px 0 0 0)` : ''
    // (Compared with what was set, not with style.clipPath, which the browser rewrites.)
    if (this.clipCss !== clipCss) {
      this.clipCss = clipCss
      pane.style.clipPath = clipCss
      // Rows just uncovered were drawn while hidden, and the WebGL buffer did not keep
      // them: draw them again, or they stay blank.
      requestAnimationFrame(() => v.session.repaint())
    }
    pane.style.maskImage = mask
    if (showCanvas) v.sizeCanvas(canvasH)
    v.el.classList.toggle('is-dialog', !!dock?.dialog)
    this.dock = dock
    const left = pane.offsetLeft
    const width = pane.offsetWidth
    this.frame.classList.remove('is-native')
    this.bar.classList.remove('is-native')
    this.frame.classList.toggle('is-on', showCanvas && !!frame)
    this.above.classList.remove('is-on')
    if (showCanvas && frame) {
      Object.assign(this.frame.style, {
        left: `${left + 10}px`,
        width: `${width - 20}px`,
        top: `${(pane.offsetTop + frame.top).toFixed(1)}px`,
        height: `${frame.height.toFixed(1)}px`,
      })
    }
    this.bar.classList.toggle('is-on', showCanvas && !!foot)
    if (showCanvas && foot) {
      Object.assign(this.bar.style, {
        left: `${left + 10}px`,
        width: `${width - 20}px`,
        top: `${(pane.offsetTop + paneH - BAR_H - 2).toFixed(1)}px`,
        height: `${BAR_H}px`,
      })
      this.renderBar(foot)
    }
  }

  // ---------------------------------------------------------------- Claude Code on the canvas

  /** Claude Code started or stopped in the tab's shell: its wrapper is told, made the first time. */
  private claudeState(on: boolean): void {
    const v = this.v
    if (on === this.claudeOn) return
    this.claudeOn = on
    if (on) {
      if (!this.wrapper) {
        this.wrapper = new ClaudeTui({
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
        })
        const input = this.wrapper.input
        const nf = () => this.frame.classList.toggle('is-focus', document.activeElement === input)
        input.addEventListener('focus', nf)
        input.addEventListener('blur', nf)
      } else this.wrapper.started()
      const input = this.wrapper.input
      v.session.focusInstead = () => (v.raw ? v.session.term.focus() : input.focus())
      if (v.hooks.isActive() && !v.raw) requestAnimationFrame(() => input.focus())
    } else {
      this.wrapper?.ended()
      v.session.focusInstead = null
      this.frame.classList.remove('is-on', 'is-native')
      this.above.classList.remove('is-on')
      this.bar.classList.remove('is-on', 'is-native')
      this.closeBarPick()
      // Back to the shell: the keyboard goes to its prompt.
      if (v.hooks.isActive()) requestAnimationFrame(() => v.session.term.focus())
    }
    v.hooks.changed?.()
  }

  /**
   * Claude Code's canvas: nothing of its screen. The canvas takes the tab down to Ember's
   * composer, with the bar under it; the terminal keeps its full size underneath, out of
   * sight, so Claude Code lays itself out as it always does.
   */
  private layoutClaude(): void {
    const v = this.v
    const w = this.wrapper
    const pane = v.session.el
    const paneH = pane.clientHeight
    if (!paneH || !w) return
    pane.style.visibility = 'hidden'
    pane.style.transform = ''
    if (this.clipCss) {
      this.clipCss = ''
      pane.style.clipPath = ''
    }
    pane.style.maskImage = ''
    this.dock = null
    v.setMode('claude', true)
    v.rawPill.classList.remove('is-on')
    v.el.classList.remove('is-dialog')
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
    this.renderBarClaude()
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
    if (hint && this.claudeOn)
      hint.textContent = s.phase === 'starting' ? 'Starting Claude Code…' : 'Claude Code is here. Ask below — what it says and shows appears on this canvas.'
    this.claudeHint()
    v.stage.renderNow()
    if (was !== this.working) {
      v.stage.restage()
      v.stage.trail.classList.toggle('is-on', this.working && v.stage.trail.childElementCount > 0)
      if (!this.working) v.stage.clearTrail()
    }
    this.barKey = ''
    if (this.bar.classList.contains('is-on') && v.mode === 'claude') this.renderBarClaude()
    v.hooks.changed?.()
  }

  /** "Claude Code is here": only on an empty canvas with nothing open over it. */
  claudeHint(): void {
    const v = this.v
    const w = this.wrapper
    if (!w || !this.claudeOn) return
    const open = w.busy || this.barPick.classList.contains('is-on') || v.input.ctxMenu.classList.contains('is-on') || v.notebook.drawer.classList.contains('is-on')
    v.hint.classList.toggle('is-gone', !v.feed.isEmpty || w.state.phase === 'working' || w.state.phase === 'asking' || open)
  }

  /** The bar: the permission mode (a switch), the model (a picker), context used, what it is doing. */
  private renderBarClaude(): void {
    const s = this.wrapper?.state
    const st = this.status
    const key = `claude|${s?.phase}|${s?.mode}|${s?.model}|${s?.effort}|${st?.at ?? ''}|${this.cost?.tokens ?? ''}`
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
    const phase =
      s?.phase === 'starting' ? 'starting…' : s?.phase === 'working' ? 'working · esc to interrupt' : s?.phase === 'asking' ? 'waiting for you' : s?.phase === 'exited' ? 'exited' : 'ready'
    const parts: string[] = []
    parts.push(`<button type="button" class="loom-bar-mode ${cls}" title="Permission mode — click or Shift+Tab to cycle"><i></i>${escapeHtml(label)}</button>`)
    const name = st?.model || s?.model || 'Claude Code'
    const size = st?.contextSize && st.contextSize >= 1_000_000 && !/context|1M/i.test(name) ? ' 1M' : ''
    if (this.wrapper?.models().length) parts.push(`<button type="button" class="loom-bar-model loom-bar-pickmodel" title="Model — click to switch">${escapeHtml(name)}${size}<span class="loom-bar-caret">▾</span></button>`)
    else parts.push(`<span class="loom-bar-model">${escapeHtml(name)}${size}</span>`)
    if (s?.effort) parts.push(`<span class="loom-bar-effort" title="Effort (/effort to change)">${escapeHtml(s.effort)}</span>`)
    if (st?.contextPercent != null) {
      const p = Math.max(0, Math.min(100, Math.round(st.contextPercent)))
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

  /** The model picker: Claude Code's own list, above the bar. Picking types `/model <it>`. */
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

  /**
   * Claude Code's mode line and Ember's status line, said again under the frame: the
   * permission mode as a chip (click it, or Shift+Tab, to cycle), the model, how full
   * the context is, the cost. Whatever else the mode line says is kept, dimmed.
   */
  private renderBar(foot: string[]): void {
    const v = this.v
    const lines = foot.map((r) => r.trim()).filter(Boolean)
    const modeRe = /shift\+tab|for shortcuts|permissions on|accept edits|plan mode|auto mode|esc to interrupt|for agents/i
    const modeLine = lines.find((r) => modeRe.test(r)) ?? ''
    const key = `${modeLine}|${this.status?.at ?? ''}|${this.cost?.tokens ?? ''}|${this.status ? '' : lines.join('|')}`
    if (key === this.barKey) return
    this.barKey = key

    const modes: Array<[RegExp, string, string]> = [
      [/bypass permissions on/i, 'bypass', 'is-bypass'],
      [/accept edits on/i, 'accept edits', 'is-edits'],
      [/plan mode on/i, 'plan', 'is-plan'],
      [/auto mode on/i, 'auto', 'is-auto'],
      [/manual mode on/i, 'manual', 'is-default'],
    ]
    const hit = modes.find(([re]) => re.test(modeLine))
    const rest = modeLine
      .replace(hit?.[0] ?? /^$/, '')
      .replace(/\(shift\+tab to cycle\)/i, '')
      .replace(/^[^\w(←?]+/u, '')
      .split(/\s+·\s+/)
      .map((x) => x.trim())
      .filter((x) => x && !/^[⏵⏸▶►]+$/u.test(x))
      .join(' · ')

    const parts: string[] = []
    // Another agent's bar: its own status text, without Claude's permission modes.
    const other = !!v.session.announcedAgent && v.session.announcedAgent !== 'claude'
    if (other) {
      const said = lines.filter((r) => !/for shortcuts|^⚠\s*\d*$/.test(r)).map((r) => r.replace(/\s+⚠\s*\d+\s*$/, ''))
      const name = agentSpec(v.session.announcedAgent ?? '').name
      this.bar.innerHTML = `<span class="loom-bar-model">${escapeHtml(name)}</span>${said.length ? `<span class="loom-bar-rest">${escapeHtml(said.join(' · '))}</span>` : ''}`
      return
    }
    parts.push(`<button type="button" class="loom-bar-mode ${hit?.[2] ?? 'is-default'}" title="Permission mode — click or Shift+Tab to cycle"><i></i>${escapeHtml(hit?.[1] ?? 'default')}</button>`)
    const st = this.status
    if (st) {
      const size = st.contextSize && st.contextSize >= 1_000_000 && !/context|1M/i.test(st.model) ? ' 1M' : ''
      parts.push(`<span class="loom-bar-model">${escapeHtml(st.model)}${size}</span>`)
      if (st.contextPercent != null) {
        const p = Math.max(0, Math.min(100, Math.round(st.contextPercent)))
        parts.push(`<span class="loom-bar-ctx${p >= 80 ? ' is-high' : ''}" title="Context used"><i style="--p:${p}%"></i>${p}%</span>`)
      }
      if (st.costUsd != null) parts.push(`<span class="loom-bar-cost" title="This session, all of it">$${st.costUsd.toFixed(2)}</span>`)
    } else {
      const other = lines.filter((r) => r !== modeLine).join(' · ')
      if (other) parts.push(`<span class="loom-bar-model">${escapeHtml(other)}</span>`)
    }
    const c = this.cost
    if (c && c.tokens) {
      const share = st?.costUsd ? ` · ${Math.round((c.usd / st.costUsd) * 100)}%` : ''
      const tip =
        `What Ember's own tools cost this session (estimate):
` +
        `  written into them  ${fmtTokens(c.outTokens)}
` +
        `  re-read while in context  ${fmtTokens(c.carryTokens)}
` +
        `  tool instructions and definitions  ${fmtTokens(c.overheadTokens)}
` +
        `over ${c.calls} calls`
      parts.push(`<span class="loom-bar-ember" title="${escapeHtml(tip)}">Ember ${fmtTokens(c.tokens)} · $${c.usd.toFixed(2)}${share}</span>`)
    }
    parts.push(`<span class="loom-bar-rest">${escapeHtml(rest)}</span>`)
    this.bar.innerHTML = parts.join('')
  }
}

/**
 * Codex's input, as its TUI draws it (scripts/probe-agent-screens.mjs): the `›` line and
 * any continuation lines, a blank line, then its status lines ("GPT-6-Astra high · ~",
 * "? for shortcuts"). The slash and @ menus sit just above the prompt; an approval
 * prompt replaces the status lines with numbered choices, and is shown whole.
 */
export function findCodexDock(rows: string[]): Dock | null {
  let last = rows.length - 1
  while (last > 0 && !rows[last]!.trim()) last--
  let p = -1
  for (let y = last; y >= Math.max(0, last - 8); y--) {
    if (/^›\s/.test(rows[y]!) || rows[y] === '›') {
      p = y
      break
    }
  }
  if (p < 0) return null
  let q = p
  while (q + 1 <= last && rows[q + 1]!.trim() && /^\s{2}\S/.test(rows[q + 1]!) && !isCodexFooter([rows[q + 1]!])) q++
  const under = rows.slice(q + 1, last + 1)
  const dialog = under.some((r) => /^\s*›?\s*\d+\.\s/.test(r)) || !isCodexFooter(under)
  if (dialog) {
    // Something we do not frame (an approval, a picker): the block it sits in, whole.
    let top = p
    while (top - 1 > 3 && rows[top - 1]!.trim() && p - top < 18) top--
    return { top, bottom: last, dialog: true, box: null, open: -1, close: -1 }
  }
  // A menu attached above the prompt: a run of `/command` or `@file` lines, then one blank.
  let top = p
  let y = p - 1
  if (y > 3 && !rows[y]!.trim()) y--
  if (y > 3 && /^[›\s]\s?[/@]\S/.test(rows[y]!)) {
    let n = 0
    while (y > 3 && rows[y]!.trim() && n < 18) {
      y--
      n++
    }
    top = y + 1
  }
  return { top, bottom: last, dialog: false, box: [p, q], open: -1, close: -1, foot: q + 1 }
}

/** Codex's status lines: the model and folder, the shortcuts hint, a working line. */
export function isCodexFooter(below: string[]): boolean {
  const lines = below.filter((r) => r.trim())
  if (lines.length > 4) return false
  return lines.every((r) => /·|for shortcuts|esc to interrupt|context left|⚠|working|tab to queue/i.test(r) || r.trim().length < 3)
}
