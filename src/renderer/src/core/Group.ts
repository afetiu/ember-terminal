import { Spring } from '../motion/spring'
import { Panel, type PanelHooks } from '../ui/Panel'
import { NoteView, type NoteHooks } from '../ui/Notes'
import { TodoView, type TodoHooks } from '../ui/Todo'
import { MapView, type MapHooks } from '../ui/MapView'
import { OverviewView, type OverviewHooks } from '../ui/Overview'
import type { Session } from './Session'
import type { ActivitySnapshot, ActivityState } from './Activity'

let seq = 0

/** Smallest a pane may be dragged to, in px. */
const MIN_PANE = 120

/**
 * One sidebar card: a set of terminals sharing the stage, split along one axis with
 * draggable dividers between them.
 *
 * Splits are a single level rather than an arbitrary tree. A tree buys nested
 * quadrants that nobody reaches for, at the cost of every resize becoming a
 * recursive constraint solve — a flat row/column covers "put one next to this and
 * let me drag the seam" and keeps the drag maths to two neighbours.
 */
export class Group {
  readonly id = `g${++seq}`
  readonly el: HTMLElement
  /**
   * The terminals, split among themselves. Separate from `el` so the visualisation
   * panel can sit beside the whole split rather than becoming another pane in it —
   * the panel belongs to the tab, and dragging a seam between two shells must not
   * move it.
   */
  readonly panesEl: HTMLElement
  readonly panes: Session[] = []

  /** Flex-grow weight per pane; only ratios matter. */
  private readonly sizes: number[] = []
  private readonly slots: HTMLElement[] = []
  private focusedId: string | null = null
  private direction: 'row' | 'column' = 'row'

  /** Stage position in percent: 0 centred, ±100 fully off. */
  readonly slide = new Spring(0, { stiffness: 750, damping: 1.0, epsilon: 0.06 })
  /** 0 -> 1 entrance. Critically damped: it arrives at its size without bouncing past it. */
  readonly pop = new Spring(1, { stiffness: 620, damping: 1.0, epsilon: 0.004 })
  /** 0 = split as sized, 1 = focused pane fills the group. */
  readonly zoom = new Spring(0, { stiffness: 380, damping: 1.0, epsilon: 0.002 })
  zoomed = false

  /** Set with F2. Wins over the shell-reported title until cleared. */
  customTitle: string | null = null

  /** The right-hand visualisation surface, in the v2 experience only. */
  panel: Panel | null = null

  /**
   * Writing, in a tab that has no shell in it.
   *
   * Modelled the way the panel is — a surface the tab owns — rather than as a pane,
   * because `panes` is `Session[]` and a note is not a session pretending to be one.
   * A note tab simply has no panes, which the rest of this class already tolerates:
   * `focused` returns null, `aggregate` falls back to idle, and refit/repaint iterate
   * nothing. `customTitle` is what carries the note's name to the sidebar.
   */
  note: NoteView | null = null

  /**
   * Give this tab a note surface. Idempotent, like ensurePanel.
   *
   * In a tab with terminals the notes sit *over* them, the way `claude` takes over the
   * shell it was typed in: the shell is hidden under the note, keeps running, and leaving
   * the notes brings it back exactly as it was. In a split that is the one pane being
   * worked in, not the whole tab — its neighbour stays where it was. In a tab with no
   * terminals the same surface is simply the tab.
   */
  ensureNote(hooks: NoteHooks): NoteView {
    if (this.map) this.hideMap()
    if (this.todo) this.hideTodo()
    if (this.overview) this.hideOverview()
    if (!this.note) {
      this.note = new NoteView(hooks)
      this.cover(this.note.el, true)
    }
    return this.note
  }

  /** Where a surface over the terminals is mounted, while one is. */
  private coverHost: HTMLElement | null = null

  /**
   * Lay a surface over the terminals. `inPane` puts it over the focused pane only when
   * the tab is split — what a note or the todo list wants, since they were asked for in
   * one shell. The overview and the map are about everything, and take the whole tab.
   */
  private cover(el: HTMLElement, inPane: boolean): void {
    const slot = inPane && this.isSplit ? this.slots[this.panes.findIndex((p) => p.id === this.focused?.id)] : undefined
    const host = slot ?? this.panesEl
    host.appendChild(el)
    if (this.panes.length > 0) {
      host.classList.add('has-note')
      this.coverHost = host
      this.titleBefore = this.customTitle
    }
  }

  /** Give the terminals back after `cover`. */
  private uncover(): void {
    this.coverHost?.classList.remove('has-note')
    this.coverHost = null
    if (this.panes.length > 0) {
      this.customTitle = this.titleBefore
      this.titleBefore = null
      this.refit()
    }
  }

  /** What the tab was called before a note took it over, to put back afterwards. */
  private titleBefore: string | null = null

  /** The todo list, over this tab's terminals or as the tab itself. Its own thing, not a note. */
  todo: TodoView | null = null

  /** Every session at a glance, over this tab's terminals or as the tab itself. */
  overview: OverviewView | null = null

  ensureOverview(hooks: OverviewHooks): OverviewView {
    if (this.map) this.hideMap()
    if (this.note) this.hideNote()
    if (this.todo) this.hideTodo()
    if (!this.overview) {
      this.overview = new OverviewView(hooks)
      this.cover(this.overview.el, false)
    }
    return this.overview
  }

  hideOverview(): void {
    if (!this.overview) return
    this.overview.dispose()
    this.overview = null
    this.uncover()
  }

  get isOverview(): boolean {
    return this.overview !== null
  }

  ensureTodo(hooks: TodoHooks): TodoView {
    if (this.map) this.hideMap()
    if (this.note) this.hideNote()
    if (this.overview) this.hideOverview()
    if (!this.todo) {
      this.todo = new TodoView(hooks)
      this.cover(this.todo.el, true)
    }
    return this.todo
  }

  hideTodo(): void {
    if (!this.todo) return
    this.todo.dispose()
    this.todo = null
    this.uncover()
  }

  get isTodo(): boolean {
    return this.todo !== null
  }

  /** The architecture map, over this tab's terminals or as the tab itself. */
  map: MapView | null = null

  ensureMap(hooks: MapHooks): MapView {
    if (this.note) this.hideNote()
    if (this.todo) this.hideTodo()
    if (this.overview) this.hideOverview()
    if (!this.map) {
      this.map = new MapView(hooks)
      this.cover(this.map.el, false)
    }
    return this.map
  }

  hideMap(): void {
    if (!this.map) return
    this.map.dispose()
    this.map = null
    this.uncover()
  }

  get isMap(): boolean {
    return this.map !== null
  }

  /** Take the notes off a shell tab and give it back its title and its terminals. */
  hideNote(): void {
    if (!this.note) return
    this.note.dispose()
    this.note = null
    this.uncover()
  }

  /** True when this tab is showing writing right now — its own, or over its terminals. */
  get isNote(): boolean {
    return this.note !== null
  }

  private parked = false

  /**
   * Take the terminals out of layout while the tab is off-screen, and put them back the
   * moment it is coming on. See App.applyPaneStyles for why. Coming back, every pane
   * re-fits: its element had no size while parked, so anything measured in between is
   * stale, and xterm's own fit is what sets it right.
   */
  setParked(parked: boolean): void {
    if (parked === this.parked) return
    this.parked = parked
    this.panesEl.style.display = parked ? 'none' : ''
    if (!parked) for (const p of this.panes) p.applyFit()
  }

  /**
   * Give this tab a panel. Idempotent, because switching to v2 walks every open tab
   * and a tab that already has one must keep whatever is on it.
   */
  ensurePanel(hooks: PanelHooks): Panel {
    this.watchStage()
    if (!this.panel) {
      this.panel = new Panel(this.id, hooks)
      // Closed means no width, from the first frame: applyPanel only runs while the motion
      // loop does, and a panel created at rest otherwise sat at its natural ~300px.
      this.panel.el.style.flex = '0 0 0px'
      this.el.appendChild(this.panel.el)
    }
    return this.panel
  }

  /** Drop the panel. Its content is gone; the terminals are untouched. */
  removePanel(): void {
    this.panel?.dispose()
    this.panel = null
  }

  /**
   * Lay the panel out beside the terminals.
   *
   * Width is a percentage of the tab rather than a pixel figure so the split survives
   * a window resize, and the panes take the remainder by growing into it — which means
   * xterm only refits when the spring stops, not on every frame of the slide.
   */
  /** The stage's width, kept by a ResizeObserver so no frame has to ask layout for it. */
  private stageW = 0
  /** True while the panel is travelling as an overlay rather than sitting in the flow. */
  private panelMoving = false
  /** The width the panel is heading for, fixed for the duration of one movement. */
  private panelPx = 0

  /** The panel's full width for a stage this wide. */
  private panelWanted(fraction: number): number {
    const stage = this.stageW
    // A share of the tab, with a floor. The share alone is right until something else
    // takes a column — with the orchestrator open too, 42% of what was left came to
    // 200px, which is not a width you can read a diagram or a table in. Below that the
    // panel takes a fixed minimum and the terminal gives up the difference, because when
    // you have deliberately opened a panel it is the thing you are looking at.
    return stage > 0 ? Math.max(fraction * stage, Math.min(Group.MIN_PANEL_PX, stage * 0.6)) : 0
  }

  /**
   * Place the panel for this frame.
   *
   * The panel used to open by animating its flex-basis, which relaid out the whole tab on
   * every frame: the terminals were resized sixty times a second and, worse, so was the
   * webview — a cross-process resize per frame, which is what made the slide stutter.
   *
   * Now the panel travels as an overlay. While the spring runs it is absolutely
   * positioned at its final width and moved with a transform, which the compositor does
   * without asking layout for anything. Layout happens exactly once, and always under
   * cover: opening, the terminals keep their width until the panel has landed and then
   * shrink behind it; closing, they widen at the first frame behind the still-covering
   * panel and are already in place when it slides away. Nothing the eye can see ever
   * reflows mid-motion.
   */
  applyPanel(fraction: number): void {
    const p = this.panel
    if (!p) return
    const v = p.width.value
    const moving = !p.width.settled

    if (moving && !this.panelMoving) {
      // Take off: fix the destination width and leave the flow.
      this.panelMoving = true
      this.panelPx = this.panelWanted(fraction)
      p.el.style.width = `${this.panelPx.toFixed(1)}px`
      p.el.style.flex = ''
      p.el.classList.add('is-moving')
    }

    if (this.panelMoving) {
      const px = this.panelPx
      p.el.style.transform = `translate3d(${((1 - v) * px).toFixed(1)}px, 0, 0)`
      if (!moving) {
        // Land: back into the flow at the width it was travelling at (or at nothing).
        this.panelMoving = false
        p.el.classList.remove('is-moving')
        p.el.style.transform = ''
        p.el.style.width = ''
        p.el.style.flex = `0 0 ${(v > 0.5 ? px : 0).toFixed(1)}px`
      }
    } else if (v > 0.5) {
      // At rest and open: follow the stage if it was resized underneath.
      const px = this.panelWanted(fraction)
      if (Math.abs(px - this.panelPx) > 0.5) {
        this.panelPx = px
        p.el.style.flex = `0 0 ${px.toFixed(1)}px`
      }
    } else if (p.el.style.flex !== '0 0 0px') {
      // At rest and closed: no width at all. Without this a fresh panel took its natural
      // width — the empty message's — and quietly cost the terminal 300px.
      p.el.style.flex = '0 0 0px'
    }
    p.el.style.pointerEvents = v > 0.02 ? 'auto' : 'none'
  }

  /** Narrowest the panel is allowed to get before the terminal starts paying instead. */
  private static readonly MIN_PANEL_PX = 300
  private stageRo: ResizeObserver | null = null

  /** Watch the stage's width once, instead of reading it from layout every frame. */
  private watchStage(): void {
    if (this.stageRo) return
    this.stageW = this.el.clientWidth
    this.stageRo = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? this.el.clientWidth
      if (w > 0) this.stageW = w
    })
    this.stageRo.observe(this.el)
  }

  /** What the sidebar should show for this group. */
  get displayTitle(): string {
    return this.customTitle ?? this.focused?.title ?? 'Session'
  }

  constructor(private readonly onFocusChange: (group: Group) => void) {
    this.el = document.createElement('section')
    this.el.className = 'ember-group'
    this.el.dataset['groupId'] = this.id

    this.panesEl = document.createElement('div')
    this.panesEl.className = 'ember-group-panes'
    this.el.appendChild(this.panesEl)
  }

  get focused(): Session | null {
    return this.panes.find((p) => p.id === this.focusedId) ?? this.panes[0] ?? null
  }

  get isSplit(): boolean {
    return this.panes.length > 1
  }

  add(session: Session, direction?: 'row' | 'column'): void {
    if (direction && this.panes.length <= 1) this.direction = direction
    this.panesEl.dataset['dir'] = this.direction

    const slot = document.createElement('div')
    slot.className = 'ember-slot'
    slot.appendChild(session.el)

    if (this.panes.length > 0) {
      this.panesEl.appendChild(this.makeDivider(this.panes.length - 1))
    }
    this.panesEl.appendChild(slot)

    this.panes.push(session)
    this.slots.push(slot)
    this.sizes.push(1)
    this.focusedId = session.id

    session.el.addEventListener('mousedown', () => this.focus(session.id), true)
    this.applySizes()
  }

  remove(sessionId: string): Session | null {
    const idx = this.panes.findIndex((p) => p.id === sessionId)
    if (idx === -1) return null
    const [session] = this.panes.splice(idx, 1)
    const [slot] = this.slots.splice(idx, 1)
    this.sizes.splice(idx, 1)
    // A note or the todo list over this pane goes with it, not into limbo.
    if (slot && slot === this.coverHost) {
      this.hideNote()
      this.hideTodo()
    }
    slot?.remove()

    // Rebuild dividers rather than trying to patch indices around the hole.
    this.panesEl.querySelectorAll('.ember-divider').forEach((d) => d.remove())
    this.slots.forEach((s, i) => {
      if (i > 0) this.panesEl.insertBefore(this.makeDivider(i - 1), s)
    })

    if (this.focusedId === sessionId) this.focusedId = this.panes[Math.min(idx, this.panes.length - 1)]?.id ?? null
    this.applySizes()
    return session ?? null
  }

  focus(sessionId: string): void {
    if (this.focusedId === sessionId) return
    this.focusedId = sessionId
    this.refreshFocusClasses()
    this.onFocusChange(this)
  }

  focusFirst(): void {
    // A tab showing a note or the todo list takes typing there, not into the shell under it.
    if (this.todo) {
      this.todo.focus()
      return
    }
    if (this.map) {
      this.map.focus()
      return
    }
    if (this.overview) {
      this.overview.focus()
      return
    }
    if (this.note) {
      this.note.focus()
      return
    }
    const target = this.focused
    if (!target) return
    this.focusedId = target.id
    this.refreshFocusClasses()
    target.focus()
  }

  private refreshFocusClasses(): void {
    for (const p of this.panes) p.el.classList.toggle('is-focused', p.id === this.focusedId && this.isSplit)
  }

  private makeDivider(index: number): HTMLElement {
    const d = document.createElement('div')
    d.className = 'ember-divider'
    d.dataset['index'] = String(index)
    d.addEventListener('pointerdown', (e) => this.beginDrag(e, index))
    return d
  }

  private beginDrag(e: PointerEvent, index: number): void {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    target.classList.add('is-dragging')
    document.body.classList.add('is-resizing')

    const horizontal = this.direction === 'row'
    const a = this.slots[index]
    const b = this.slots[index + 1]
    if (!a || !b) return

    const aStart = horizontal ? a.getBoundingClientRect().width : a.getBoundingClientRect().height
    const bStart = horizontal ? b.getBoundingClientRect().width : b.getBoundingClientRect().height
    const total = aStart + bStart
    const weightTotal = (this.sizes[index] ?? 1) + (this.sizes[index + 1] ?? 1)
    const origin = horizontal ? e.clientX : e.clientY

    const move = (ev: PointerEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - origin
      const wanted = aStart + delta
      const aPx = Math.min(total - MIN_PANE, Math.max(MIN_PANE, wanted))

      // Past the minimum the seam resists instead of stopping dead: the excess is
      // shown at a fraction of its real distance and springs back on release.
      const excess = wanted - aPx
      const resist = excess === 0 ? 0 : Math.sign(excess) * Math.min(46, Math.abs(excess) * 0.28)
      target.style.transform = resist
        ? horizontal
          ? `translateX(${resist.toFixed(1)}px)`
          : `translateY(${resist.toFixed(1)}px)`
        : ''

      this.sizes[index] = (aPx / total) * weightTotal
      this.sizes[index + 1] = weightTotal - this.sizes[index]!
      this.applySizes()
    }

    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId)
      target.classList.remove('is-dragging')
      // Let CSS spring the resisted offset back to zero.
      target.style.transform = ''
      document.body.classList.remove('is-resizing')
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      // Refit once at the end: every intermediate resize would make ConPTY redraw
      // the prompt, which is both expensive and visually noisy while dragging.
      this.refit()
    }

    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  /** Zoom the focused pane to fill the group, or restore the split. */
  toggleZoom(): void {
    if (!this.isSplit) return
    this.zoomed = !this.zoomed
    this.zoom.to(this.zoomed ? 1 : 0)
  }

  private applySizes(): void {
    this.panesEl.dataset['dir'] = this.direction
    const z = this.zoom.value
    const focusedIdx = this.panes.findIndex((p) => p.id === this.focused?.id)

    this.slots.forEach((slot, i) => {
      const base = this.sizes[i] ?? 1
      // Interpolating flex-grow is what makes zoom a smooth expansion rather than a
      // hard swap; the tiny floor keeps collapsed panes laid out (and thus fittable)
      // instead of being torn down and rebuilt.
      const target = i === focusedIdx ? Math.max(1, this.panes.length) : 0.0001
      slot.style.flexGrow = String(base * (1 - z) + target * z)
    })

    for (const d of this.panesEl.querySelectorAll<HTMLElement>('.ember-divider')) {
      d.style.opacity = String(1 - z)
      d.style.pointerEvents = z > 0.5 ? 'none' : 'auto'
    }
    this.panesEl.classList.toggle('is-zoomed', this.zoomed)
    this.refreshFocusClasses()
  }

  /** Called from the app's motion loop while the zoom spring is running. */
  stepZoom(dt: number): boolean {
    if (this.zoom.settled) return false
    this.zoom.step(dt)
    this.applySizes()
    return true
  }

  refit(): void {
    for (const p of this.panes) p.applyFit()
  }

  repaint(): void {
    for (const p of this.panes) p.repaint()
  }

  /** Worst state across the group, so a card can't hide a pane that needs you. */
  aggregate(now: number): ActivitySnapshot {
    const snaps = this.panes.map((p) => p.activity.update(now))
    const rank: Record<ActivityState, number> = { attention: 3, working: 2, idle: 1, exited: 0 }
    let best: ActivitySnapshot = snaps[0] ?? {
      state: 'idle',
      isClaude: false,
      fullscreenApp: false,
      attention: null,
      label: 'Idle',
      detail: '',
    }
    for (const s of snaps) if (rank[s.state] > rank[best.state]) best = s
    const focused = this.focused
    return {
      ...best,
      isClaude: focused ? (focused.activity.current.isClaude ?? best.isClaude) : best.isClaude,
    }
  }

  setDirection(dir: 'row' | 'column'): void {
    this.direction = dir
    this.applySizes()
  }

  acknowledge(): void {
    for (const p of this.panes) p.activity.acknowledge()
  }

  dispose(): void {
    for (const p of this.panes) p.dispose()
    this.panes.length = 0
    this.removePanel()
    // Disposing flushes any unsaved edit before the element goes; closing a note tab
    // must not be a way to lose the last thing typed into it.
    this.note?.dispose()
    this.note = null
    this.todo?.dispose()
    this.todo = null
    this.map?.dispose()
    this.map = null
    this.el.remove()
  }
}
