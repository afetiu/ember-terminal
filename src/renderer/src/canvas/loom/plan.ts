import type { Todo } from '../Feed'
import type { LoomView } from '../LoomView'
import { div, type Piece } from './shared'

/**
 * The plan of the work in progress, as an object of its own on the board: it moves, snaps,
 * minimizes and goes like anything shown. Fed by the session's todo list (TodoWrite) or by
 * show_steps; each step carries the objects shown while it was in progress.
 */
export class Plan {
  // The plan is drawn here and shown inside an object of its own (see showPlan), not
  // fixed above the exchange: it moves, snaps, minimizes and goes like anything shown.
  readonly el = div('loom-plan')
  todos: Todo[] = []
  stepsTitle = ''
  /** When each step started and finished, so the card can say how long things took. */
  private readonly stepTimes = new Map<string, { start?: number; end?: number }>()
  private planTimer = 0
  /** The plan's object: made on the first step, kept in view as the work moves on. */
  planPiece: Piece | null = null
  /** You closed this plan: its updates do not bring it back (a new plan does). */
  private planGone = false

  constructor(private readonly v: LoomView) {}

  /**
   * The plan of the work, as the card at the top of the canvas: every step with its state,
   * a check that draws itself when one is done, the step in progress carrying what Claude
   * is doing right now, how long each took, and a progress line. It is updated, never
   * redrawn — a step that changes animates, the rest stay still — and it stays across
   * turns until the work is done, when it folds to one line you can open again.
   */
  setTodos(list: Todo[]): void {
    const v = this.v
    const plan = this.el
    this.todos = list
    const now = Date.now()
    if (!list.length) {
      plan.classList.remove('is-on')
      // An empty plan takes it off the screen.
      const p = this.planPiece
      this.planPiece = null
      if (p?.el.isConnected) (v.pinned.has(p) ? v.objects.unpin(p) : v.objects.dismiss(p))
      this.planGone = false
      return
    }
    // A different plan (other steps): start the timings over.
    const key = list.map((t) => t.content).join('\u0001')
    if (plan.dataset['key'] !== key) {
      if (!plan.dataset['key'] || !list.some((t) => this.stepTimes.has(t.content))) {
        this.stepTimes.clear()
        // A new plan is shown even if the last one was closed.
        this.planGone = false
      }
      plan.dataset['key'] = key
    }
    for (const t of list) {
      const st = this.stepTimes.get(t.content) ?? {}
      if (t.status === 'in_progress' && !st.start) st.start = now
      if (t.status === 'completed') {
        st.start ??= now
        st.end ??= now
      }
      if (t.status !== 'completed') delete st.end
      this.stepTimes.set(t.content, st)
    }
    const done = list.filter((t) => t.status === 'completed').length
    const complete = done === list.length

    if (!plan.firstChild) {
      plan.innerHTML =
        `<div class="loom-plan-head"><span class="loom-plan-title"></span><span class="loom-plan-count"></span><span class="loom-plan-time"></span></div>` +
        `<div class="loom-plan-bar"><i></i></div><ol class="loom-plan-steps"></ol>`
      plan.querySelector('.loom-plan-head')?.addEventListener('click', () => {
        if (plan.classList.contains('is-complete')) plan.classList.toggle('is-open')
      })
    }
    plan.querySelector('.loom-plan-title')!.textContent = this.stepsTitle || 'Plan'
    plan.querySelector('.loom-plan-count')!.textContent = `${done}/${list.length}`
    ;(plan.querySelector('.loom-plan-bar i') as HTMLElement).style.width = `${(done / list.length) * 100}%`

    const ol = plan.querySelector('.loom-plan-steps')!
    // Keyed by the step's words: an unchanged step keeps its element, so only what changes moves.
    const existing = new Map<string, HTMLElement>()
    ol.querySelectorAll<HTMLElement>(':scope > li').forEach((li) => existing.set(li.dataset['k'] ?? '', li))
    const keep = new Set<string>()
    list.forEach((t, i) => {
      const k = t.content
      keep.add(k)
      let li = existing.get(k)
      if (!li) {
        li = document.createElement('li')
        li.dataset['k'] = k
        li.innerHTML =
          `<span class="m"><svg viewBox="0 0 20 20" aria-hidden="true"><circle class="ring" cx="10" cy="10" r="8"/><circle class="spin" cx="10" cy="10" r="8"/><path class="tick" d="M6 10.5l2.6 2.6L14 7.6"/></svg></span>` +
          `<span class="body"><span class="text"></span><span class="now"></span></span><span class="dur"></span>`
      }
      const state = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'todo'
      if (li.dataset['state'] && li.dataset['state'] !== state) {
        li.classList.add('is-changing')
        window.setTimeout(() => li?.classList.remove('is-changing'), 700)
      }
      li.dataset['state'] = state
      li.querySelector('.text')!.textContent = state === 'active' && t.activeForm ? t.activeForm : t.content
      if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] ?? null)
    })
    existing.forEach((li, k) => {
      if (!keep.has(k)) li.remove()
    })
    plan.classList.toggle('is-complete', complete)
    if (complete) plan.classList.remove('is-open')
    plan.classList.add('is-on')
    this.showPlan()
    this.tickPlan()
    if (!this.planTimer) this.planTimer = window.setInterval(() => this.tickPlan(), 1000)
  }

  private showPlan(): void {
    const v = this.v
    if (this.planGone) return
    const title = this.stepsTitle || 'Plan'
    let p = this.planPiece
    if (!p || !p.el.isConnected) {
      p = v.objects.makePiece(v.board.boardSlot(), title, 'steps')
      p.body.appendChild(this.el)
      v.pieces.set(title, p)
      this.planPiece = p
      v.board.focusOn(p, true)
      v.grew()
      v.reportScreen()
      return
    }
    p.el.querySelector('.loom-piece-title')!.textContent = title
    // Still in an earlier turn's reply: it follows the work to the turn on screen, as the
    // plan always has. Placed on the screen, it stays where it was put.
    const newest = v.feed.turns().at(-1)
    if (!v.pinned.has(p) && newest && !newest.contains(p.el)) {
      const slot = v.board.boardSlot()
      const old = p.el.parentElement
      slot.appendChild(p.el)
      if (old?.classList.contains('loom-slot') && !old.childElementCount) old.remove()
      v.reportScreen()
    }
  }

  /** The plan's object was removed by hand: leave this plan off the screen. */
  planClosed(piece: Piece): void {
    if (piece !== this.planPiece) return
    this.planPiece = null
    this.planGone = true
  }

  /** The objects a plan step carries, newest first. */
  stepPieces(key: string): Piece[] {
    const v = this.v
    return [...v.pieces.values()].filter((p) => p !== this.planPiece && p.step === key && p.el.isConnected && !v.pinned.has(p)).reverse()
  }

  /** The clocks on the plan, and the live line under the step in progress. */
  tickPlan(): void {
    const v = this.v
    const plan = this.el
    if (!plan.classList.contains('is-on')) return
    const now = Date.now()
    const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
    let first = Infinity
    let last = 0
    plan.querySelectorAll<HTMLElement>('.loom-plan-steps > li').forEach((li) => {
      const t = this.stepTimes.get(li.dataset['k'] ?? '')
      const el = li.querySelector('.dur')!
      if (t?.start) first = Math.min(first, t.start)
      if (t?.end) last = Math.max(last, t.end)
      el.textContent = t?.start ? dur((t.end ?? now) - t.start) : ''
      const live = li.querySelector('.now')!
      live.textContent = li.dataset['state'] === 'active' && v.host.working ? v.stage.nowText : ''
      const carried = this.stepPieces(li.dataset['k'] ?? '')
      let tag = li.querySelector<HTMLElement>('.att')
      if (carried.length) {
        if (!tag) {
          tag = document.createElement('span')
          tag.className = 'att'
          li.querySelector('.body')?.appendChild(tag)
          li.addEventListener('click', () => {
            const top = this.stepPieces(li.dataset['k'] ?? '')[0]
            if (top) {
              const turn = top.el.closest<HTMLElement>('.loom-turn')
              const turns = v.feed.turns()
              if (turn && turn !== v.stage.shown) {
                v.stage.viewing = turn === turns[turns.length - 1] ? null : turn
                v.stage.restage()
              }
              v.board.focusOn(top)
              v.reveal(top.el, 'nearest')
            }
          })
        }
        tag.textContent = carried.map((p) => p.title).slice(0, 3).join(' · ') + (carried.length > 3 ? ` +${carried.length - 3}` : '')
        li.classList.add('has-att')
      } else if (tag) {
        tag.remove()
        li.classList.remove('has-att')
      }
    })
    const complete = plan.classList.contains('is-complete')
    const total = first === Infinity ? 0 : (complete ? last : now) - first
    plan.querySelector('.loom-plan-time')!.textContent = total ? `${complete ? 'done · ' : ''}${dur(total)}` : ''
    if (complete && this.planTimer) {
      window.clearInterval(this.planTimer)
      this.planTimer = 0
    }
  }
}
