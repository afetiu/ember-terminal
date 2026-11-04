import { escapeHtml, renderMarkdown } from '../markdown'
import type { FeedContext } from '../Feed'
import type { LoomView } from '../LoomView'
import { ICON, LIFTABLE, div, holdsResult, reduced } from './shared'

/**
 * The stage: the one turn the canvas holds, and how you move between turns — the rail of
 * points down the left, Ctrl+Shift+↑↓, and the wheel pushed past a turn's edge. With it,
 * what the session is doing right now inside that turn: the large live line, the trail of
 * what it has been saying, and its subagents as pills.
 */
export class Stage {
  /** The turns as a line of points down the left: click one to go to it. */
  readonly rail = div('loom-rail')
  readonly now = div('loom-now')
  /** What Claude has been saying while it works: the last few sentences, newest at the bottom. */
  readonly trail = div('loom-trail')
  // What Claude is doing sits in the turn itself, right under its words and above what
  // it showed: it moves with the content and nothing can sit on it.
  readonly activity = div('loom-activity')
  /** The session's subagents, as small pills: what each is on, how long, done or not. */
  readonly agentsRow = div('loom-agents')
  readonly agents = new Map<string, { key: string; agentId?: string; desc: string; type: string; start: number; end?: number; ok?: boolean; action: string; steps: string[]; summary: string }>()
  trailSeen = 0
  private agentTimer = 0
  spin = { glyph: '', verb: '', detail: '' }
  private reelAnim: Animation | null = null
  nowText = ''
  trailTurn: HTMLElement | null = null

  shown: HTMLElement | null = null
  /** A turn you stepped back to; null follows the turn in progress. */
  viewing: HTMLElement | null = null
  liveTurn: HTMLElement | null = null

  constructor(private readonly v: LoomView) {
    this.activity.append(this.trail, this.now, this.agentsRow)
  }

  onAgentEvent(e: Parameters<NonNullable<FeedContext['agent']>>[0]): void {
    if (e.kind === 'start') {
      if (this.agents.has(e.key)) return
      const t = Date.parse(e.at) || Date.now()
      this.agents.set(e.key, { key: e.key, desc: e.desc, type: e.type, start: t, action: '', steps: [], summary: '' })
    } else if (e.kind === 'id') {
      const ag = this.agents.get(e.key)
      if (ag) ag.agentId = e.agentId
    } else {
      const ag = e.key ? this.agents.get(e.key) : [...this.agents.values()].find((x) => x.agentId === e.agentId)
      if (!ag || ag.end) return
      ag.end = Date.parse(e.at) || Date.now()
      ag.ok = e.ok
      ag.summary = e.summary
    }
    this.renderAgents()
  }

  /** The pills: running ones first; finished ones stay a while as small chips. */
  renderAgents(): void {
    const now = Date.now()
    const list = [...this.agents.values()].filter((a) => !a.end || now - a.end < 20 * 60_000).slice(-8)
    this.agentsRow.classList.toggle('is-on', list.length > 0)
    const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
    const keep = new Set<string>()
    for (const a of list) {
      keep.add(a.key)
      let pill = this.agentsRow.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.key)}"]`)
      if (!pill) {
        pill = div('loom-agent')
        pill.dataset['k'] = a.key
        pill.addEventListener('click', () => this.agentDetail(a.key, pill!))
        this.agentsRow.appendChild(pill)
      }
      const state = a.end ? (a.ok === false ? 'failed' : 'done') : 'running'
      pill.dataset['state'] = state
      pill.innerHTML =
        `<span class="m"></span><span class="d">${escapeHtml(a.desc)}</span>` +
        (state === 'running' && a.action ? `<span class="a">${escapeHtml(a.action)}</span>` : '') +
        `<span class="t">${dur((a.end ?? now) - a.start)}</span>`
    }
    this.agentsRow.querySelectorAll<HTMLElement>('.loom-agent').forEach((p) => {
      if (!keep.has(p.dataset['k'] ?? '')) p.remove()
    })
    const running = list.some((a) => !a.end)
    if (running && !this.agentTimer) this.agentTimer = window.setInterval(() => this.renderAgents(), 1000)
    if (!running && this.agentTimer) {
      window.clearInterval(this.agentTimer)
      this.agentTimer = 0
    }
  }

  /** One agent's last steps and, once it has finished, what it said. */
  private agentDetail(key: string, pill: HTMLElement): void {
    const a = this.agents.get(key)
    if (!a) return
    const pop = this.v.input.pop
    const r = pill.getBoundingClientRect()
    const host = this.v.el.getBoundingClientRect()
    pop.innerHTML =
      `<div class="loom-pop-about">${escapeHtml(a.desc)}${a.type ? ` <span style="opacity:.6">· ${escapeHtml(a.type)}</span>` : ''}</div>` +
      (a.steps.length ? `<ol class="loom-agent-steps">${a.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="loom-pop-quote">No steps seen yet.</div>') +
      (a.summary ? `<div class="loom-agent-sum">${renderMarkdown(a.summary).html}</div>` : '')
    pop.style.left = `${Math.min(host.width - 380, Math.max(12, r.left - host.left))}px`
    pop.style.top = `${Math.min(host.height - 220, r.bottom - host.top + 8)}px`
    pop.classList.add('is-on')
  }

  /**
   * One more sentence of what Claude is saying while it works. It slides in at the
   * bottom; the ones before it drift up, smaller and fainter, and the oldest leave. The
   * whole trail goes when the turn ends, and the final answer takes its place.
   */
  private narrate(text: string): void {
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line) return
    const first = line.length > 220 ? `${line.slice(0, 217).replace(/\s+\S*$/, '')}…` : line
    const item = div('loom-trail-item', `<span class="loom-trail-dot"></span><span class="loom-trail-text">${escapeHtml(first)}</span>`)
    this.trail.appendChild(item)
    const items = [...this.trail.querySelectorAll<HTMLElement>('.loom-trail-item:not(.is-leaving)')]
    items.forEach((el, i) => {
      const age = items.length - 1 - i
      el.dataset['age'] = String(Math.min(age, 3))
      if (age > 3) {
        el.classList.add('is-leaving')
        window.setTimeout(() => el.remove(), 360)
      }
    })
    this.trail.classList.toggle('is-on', this.v.host.working)
  }

  clearTrail(): void {
    const items = [...this.trail.children] as HTMLElement[]
    for (const el of items) el.classList.add('is-leaving')
    window.setTimeout(() => items.forEach((el) => el.remove()), 360)
  }

  /** One line, large: what the session is doing this moment. It replaces itself; nothing piles up. */
  renderNow(): void {
    const action = this.v.host.working ? this.v.feed.action || this.spin.verb : ''
    // Always in the turn while it works, plan or no plan: the plan can be in an earlier
    // turn, minimized, removed, or holding a step the agent left "in progress" long ago,
    // and the turn you are looking at must still say what is happening now.
    this.now.classList.toggle('is-on', !!action)
    if (!action) {
      this.nowText = ''
      return
    }
    // One window, one line tall, and a strip inside it that rolls: the new words come up
    // from below as the old ones leave the top, as one piece, like an odometer's wheel.
    let line = this.now.querySelector<HTMLElement>('.loom-now-line')
    if (!line) {
      line = div('loom-now-line', `<span class="loom-now-glyph"></span><span class="loom-reel"><span class="loom-reel-track"></span></span>`)
      this.now.prepend(line)
    }
    const glyph = line.querySelector<HTMLElement>('.loom-now-glyph')!
    if (this.spin.glyph || !glyph.textContent) glyph.textContent = this.spin.glyph || '✻'
    if (action !== this.nowText) {
      const first = !this.nowText
      this.nowText = action
      const track = line.querySelector<HTMLElement>('.loom-reel-track')!
      this.reelAnim?.finish()
      const row = document.createElement('span')
      row.className = 'loom-reel-row'
      row.textContent = action
      track.appendChild(row)
      if (first || track.children.length < 2) {
        while (track.children.length > 1) track.firstElementChild?.remove()
      } else {
        const h = (track.firstElementChild as HTMLElement).offsetHeight
        const a = track.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-h}px)` }], {
          duration: reduced() ? 1 : 460,
          easing: 'cubic-bezier(0.25, 1.25, 0.4, 1)',
        })
        this.reelAnim = a
        a.onfinish = () => {
          while (track.children.length > 1) track.firstElementChild?.remove()
          this.reelAnim = null
        }
      }
    }
    let d = this.now.querySelector<HTMLElement>('.loom-now-detail')
    if (!d) {
      d = div('loom-now-detail')
      this.now.appendChild(d)
    }
    if (d.textContent !== this.spin.detail) d.textContent = this.spin.detail
    this.v.plan.tickPlan()
  }

  /** `/clear`: the turns, the trail and the subagents start over (see LoomView.onCleared). */
  cleared(): void {
    this.viewing = null
    this.shown = null
    this.liveTurn = null
    this.trailTurn = null
    this.trailSeen = 0
    this.clearTrail()
  }

  // ================================================================ the stage

  /** Step through the turns: -1 older, +1 newer. Reaching the newest follows it again. */
  stepTurn(dir: number): void {
    const turns = this.v.feed.turns()
    if (!turns.length) return
    const at = turns.indexOf(this.shown ?? turns[turns.length - 1]!)
    const next = Math.max(0, Math.min(turns.length - 1, at + dir))
    this.viewing = next === turns.length - 1 ? null : turns[next]!
    this.restage()
  }

  // ---------------------------------------------------------------- the wheel walks the turns
  // The canvas holds one turn, but the chat still reads as one column: scroll past the top
  // of a turn and the one before it comes down, landing at its end; scroll past the bottom
  // and the next comes up. It takes a deliberate push past the edge, and a turn changes at
  // most once per push, so a touchpad's momentum never skips several.
  private wheelPush = 0
  private wheelIdle = 0
  private wheelRest = 0

  wheelTurns(e: WheelEvent): void {
    const v = this.v
    if (e.ctrlKey || v.objects.full || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
    const dir = e.deltaY < 0 ? -1 : 1
    // Something inside that scrolls on its own (code, a wide table) gets the wheel first.
    for (let n = e.target as HTMLElement | null; n && n !== v.scroller; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
        if (dir < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return
      }
    }
    const s = v.scroller
    const atEdge = dir < 0 ? s.scrollTop <= 0 : s.scrollTop + s.clientHeight >= s.scrollHeight - 1
    const now = performance.now()
    // Right after a change the wheel is still the same push: let it run out, without
    // scrolling the turn that just arrived (it starts at its top, or its end going back).
    if (now < this.wheelRest) {
      this.wheelRest = now + 260
      e.preventDefault()
      return
    }
    const turns = v.feed.turns()
    const at = turns.indexOf(this.shown ?? turns[turns.length - 1]!)
    const canGo = dir < 0 ? at > 0 : at >= 0 && at < turns.length - 1
    if (!atEdge || !canGo) {
      this.wheelPush = 0
      this.pull(0)
      return
    }
    // Pushing past the edge toward another turn: the wheel is ours, so the event that
    // changes the turn does not then scroll the turn it brought.
    e.preventDefault()
    // Pixels and lines both count, in pixels.
    this.wheelPush += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 40 : 1)
    window.clearTimeout(this.wheelIdle)
    this.wheelIdle = window.setTimeout(() => {
      this.wheelPush = 0
      this.pull(0)
    }, 220)
    const need = 260
    this.pull((dir * Math.min(this.wheelPush, need)) / need)
    if (this.wheelPush < need) return
    this.wheelPush = 0
    this.wheelRest = now + 420
    this.pull(0)
    this.stepTurn(dir)
    // Going back up lands at the end of the earlier turn, as scrolling up a chat would.
    if (dir < 0) s.scrollTop = s.scrollHeight
    const shown = this.shown
    if (shown && !reduced()) {
      shown.classList.remove('is-from-above', 'is-from-below')
      void shown.offsetWidth
      shown.classList.add(dir < 0 ? 'is-from-above' : 'is-from-below')
    }
  }

  /** The rubber-band give while pushing past an edge: -1 up … 1 down, 0 at rest. */
  private pull(p: number): void {
    if (reduced()) return
    const el = this.v.feed.el
    el.classList.toggle('is-pulling', p !== 0)
    el.style.transform = p ? `translateY(${(-p * 22).toFixed(1)}px)` : ''
  }

  /**
   * The canvas is a stage, not a log: it holds the turn in progress and nothing older.
   * Within it, your words, what Claude says now (its latest words replace the earlier
   * ones), and whatever it has shown. The steps it takes are not listed: the one it is
   * taking is the large line at the foot, and every step is in the real terminal (Ctrl+`).
   */
  restage(): void {
    const v = this.v
    const turns = v.feed.turns()
    const newest = turns[turns.length - 1] ?? null
    // A new turn brings you back to now, wherever you were.
    if (newest !== this.liveTurn) {
      this.liveTurn = newest
      this.viewing = null
    }
    if (this.viewing && !this.viewing.isConnected) this.viewing = null
    const live = this.viewing ?? newest
    if (live !== this.shown) {
      this.shown?.classList.remove('is-shown')
      live?.classList.add('is-shown')
      this.shown = live
      v.scroller.scrollTop = 0
      v.jump.classList.remove('is-on')
      v.renderSign()
      queueMicrotask(() => v.reportScreen())
    }
    v.el.classList.toggle('is-past', !!this.viewing)
    if (!live) return
    live.querySelectorAll<HTMLElement>(LIFTABLE).forEach((found) => {
      // A picture is wrapped so it can carry its handle.
      let d = found
      if (d.tagName === 'IMG') {
        if (d.parentElement?.classList.contains('loom-liftable')) return
        const wrap = document.createElement('span')
        wrap.className = 'loom-liftable loom-img-wrap'
        d.replaceWith(wrap)
        wrap.appendChild(d)
        d = wrap
      }
      if (d.dataset['pin'] || d.closest('.loom-piece')) return
      d.dataset['pin'] = '1'
      d.classList.add('loom-liftable')
      const name = v.objects.nameObject(d)
      // One grip only, on "Drag out": the name stays a plain label.
      const lift = div('loom-lift', `<span class="loom-lift-name">${escapeHtml(name)}</span><span class="loom-lift-hint">${ICON.grip}Drag out</span>`)
      lift.title = 'Drag it out of the reply — place it anywhere, or at an edge to snap it. Right-click for more'
      lift.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        d.classList.add('is-peeling')
        const off = () => {
          d.classList.remove('is-peeling')
          window.removeEventListener('pointerup', off, true)
        }
        window.addEventListener('pointerup', off, true)
        v.objects.drag(() => v.objects.liftObject(d), lift, e)
      })
      d.appendChild(lift)
      // Sized where it sits, without taking it out: every edge and corner, as when placed.
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const h = div('loom-rz')
        h.dataset['rz'] = dir
        h.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          v.objects.resizeInlineHost(d, dir, e)
        })
        d.appendChild(h)
      }
    })
    const says = live.querySelectorAll<HTMLElement>(':scope > .loom-say')
    says.forEach((el, i) => {
      const last = i === says.length - 1
      el.classList.toggle('is-current', last)
      // Earlier messages are mostly the agent narrating its steps, and give way to the last
      // one. One that holds a result stays: a long agent often writes its findings, works on,
      // and ends with a short line that refers back to them.
      el.classList.toggle('is-kept', !last && holdsResult(el))
    })
    // A new turn starts a new trail; while it works, each new sentence joins it.
    if (live !== this.trailTurn) {
      this.trailTurn = live
      this.trailSeen = this.viewing ? says.length : 0
      this.clearTrail()
    }
    if (!this.viewing) {
      for (let i = this.trailSeen; i < says.length; i++) this.narrate(says[i]!.innerText)
      this.trailSeen = says.length
    }
    // What is happening now belongs to the newest turn only. An earlier turn you step back
    // to keeps exactly what it had: its words shown, no live line, nothing of the current work.
    for (const t of turns) t.classList.toggle('is-working', v.host.working && t === newest)
    if (newest) {
      const board = newest.querySelector(':scope > .loom-board')
      if (this.activity.parentElement !== newest || (board && this.activity.nextElementSibling !== board)) newest.insertBefore(this.activity, board)
    }
    this.renderRail()
  }

  /**
   * One point per turn, oldest at the top, joined by a line that grows as turns are added.
   * The turn on screen is filled; the turn in progress breathes while Claude works on it.
   * Hover shows what you asked.
   */
  renderRail(): void {
    const turns = this.v.feed.turns()
    const working = this.v.host.working
    const at = this.shown ? turns.indexOf(this.shown) : turns.length - 1
    this.rail.classList.toggle('is-on', turns.length > 0)
    while (this.rail.children.length > turns.length) this.rail.lastElementChild?.remove()
    turns.forEach((t, i) => {
      let dot = this.rail.children[i] as HTMLElement | undefined
      if (!dot) {
        const b = document.createElement('button')
        b.type = 'button'
        dot = b
        dot.className = 'loom-dot'
        dot.dataset['turn'] = String(i)
        this.rail.appendChild(dot)
      }
      const asked = (t.querySelector('.loom-ask-text, .loom-ask')?.textContent ?? '').replace(/^❯\s*/, '').trim()
      dot.title = `Turn ${i + 1}${asked ? ` — ${asked.slice(0, 90)}${asked.length > 90 ? '…' : ''}` : ''}`
      dot.classList.toggle('is-at', i === at)
      dot.classList.toggle('is-live', i === turns.length - 1)
      dot.classList.toggle('is-working', i === turns.length - 1 && working)
    })
    this.rail.classList.toggle('is-working', working)
  }
}
