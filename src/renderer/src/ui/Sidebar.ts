import type { ActivitySnapshot } from '../core/Activity'
import type { ClaudeStatus, GitStatus } from '@shared/types'
import { ticker } from '../motion/ticker'
import { Spring } from '../motion/spring'
import type { Reaction } from './Mascot'
import { Odometer } from './Odometer'

/**
 * The orchestrator's mark: a hub with three things wired to it.
 *
 * Drawn rather than borrowed from the icon font. Every glyph that was close enough to
 * reach for described the wrong thing — a speech bubble says "chat", a phone says
 * "call", and both are front ends to this rather than what it is. What it *is* is one
 * thing coordinating several others, which is a shape, so it is drawn as one.
 *
 * `currentColor` throughout, so it inherits every state the button already has, and the
 * hub is a separate element so a live call can pulse the centre without touching the
 * spokes.
 */
const ORCH_TITLE = 'Orchestrator  —  hands your sessions work, through your agent CLI  (Ctrl+Shift+M · ember orch)'

const ORCH_MARK = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
  <path d="M8 5.5 L8 3.6 M5.77 9.85 L4.47 10.93 M10.23 9.85 L11.53 10.93"
        stroke="currentColor" stroke-width="1.05" stroke-linecap="round" opacity="0.7"/>
  <circle cx="8" cy="1.9" r="1.5" fill="currentColor" opacity="0.8"/>
  <circle cx="2.7" cy="12.4" r="1.5" fill="currentColor" opacity="0.8"/>
  <circle cx="13.3" cy="12.4" r="1.5" fill="currentColor" opacity="0.8"/>
  <circle class="ember-orch-hub" cx="8" cy="8" r="2.3" fill="currentColor"/>
</svg>`

/** The three things that are places rather than sessions. */
export type Place = 'todo' | 'notes' | 'map'

/**
 * The places' marks. Drawn, 16px, `currentColor`, the same stroke as the orchestrator's,
 * so the row reads as one set and follows every state the button has.
 */
const PLACES: Array<{ id: Place; label: string; title: string; svg: string }> = [
  {
    id: 'todo',
    label: 'Todo',
    title: 'Todo list  (Ctrl+Shift+D · ember todo)',
    svg: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
  },
  {
    id: 'notes',
    label: 'Notes',
    title: 'Notes  (ember notes)',
    svg: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>',
  },
  {
    id: 'map',
    label: 'Map',
    title: 'Architecture map  (Ctrl+Shift+G · ember map)',
    svg: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7.2 8.2l3.6 7.6M16.8 8.2l-3.6 7.6"/>',
  },
]

export interface CardModel {
  id: string
  title: string
  subtitle: string
  accent: string
  /** What the tab holds. A Claude session is a shell that a Claude took over; a note or the todo list is neither. */
  kind: 'shell' | 'note' | 'todo' | 'map'
  activity: ActivitySnapshot
  /** >1 when the card holds a split. */
  paneCount: number
  /** Short-lived response to the command that just finished. */
  reaction: Reaction | null
  /** Branch + dirty count for this session's cwd, when it is a repo. */
  git: GitStatus | null
  /** Most recent dev-server URL seen in the output. */
  url: string | null
  /** Characters produced since this card was last looked at. */
  unread: number
  /** What the Claude session in this tab last reported through its status line. */
  claude: ClaudeStatus | null
}

export interface SidebarHandlers {
  /** Open the orchestrator. It lives beside the sessions because it is the thing that runs them. */
  onOrchestrator(): void
  /** The provider chip: which agent a new session starts with. */
  onProvider(anchor: HTMLElement): void
  onSelect(id: string): void
  onClose(id: string): void
  onNew(): void
  onRename(id: string, title: string): void
  onReorder(ids: string[]): void
  /** Go to one of the places. */
  onPlace(place: Place): void
}

interface CardNode {
  root: HTMLElement
  title: HTMLElement
  /**
   * The status line, one element per character, so a ticking timer turns the digit
   * that changed and leaves the rest of the line alone.
   */
  status: Odometer
  /** Set by the probe hook, so the 5Hz render loop stops overwriting a driven value. */
  statusPinned: boolean
  /** The row itself — dot included — which hides entirely when there is nothing to say. */
  statusRow: HTMLElement
  meta: HTMLElement
  metaSignature: string
  close: HTMLElement
  model: CardModel
  /** 0..1 progress of the press-and-hold close gesture. */
  hold: number
  holding: boolean
}

/**
 * Vertical session list.
 *
 * Cards rather than tabs because each one carries real state — what it is running
 * and whether it wants you — and that does not fit in a 200px horizontal strip. The
 * badge is a live canvas so a glance down the column tells you which session is
 * thinking, which is done, and which is blocked on a question.
 */
export class Sidebar {
  /** How long the close button must be held before the session actually closes. */
  private static readonly HOLD_S = 0.5

  readonly el: HTMLElement
  private readonly list: HTMLElement
  private readonly orchBtn: HTMLButtonElement
  private readonly providerBtn: HTMLButtonElement
  private readonly navBtns = new Map<Place, { btn: HTMLButtonElement; badge: HTMLElement }>()
  private navSig = ''
  private readonly nodes = new Map<string, CardNode>()

  /**
   * The selection, as a thing.
   *
   * The active card used to be a background colour that switched on: a state, not an
   * event. The plate is one element behind the cards that *travels* to the chosen tab —
   * it stretches along the way it is going, overshoots a little and snaps back, and the
   * card it lands on gets a small push towards the stage, the way a drawer settles when
   * it closes. Selecting a tab becomes something that visibly happens.
   */
  private readonly plate: HTMLElement
  private readonly plateY = new Spring(0, { stiffness: 540, damping: 0.72, epsilon: 0.15 })
  private plateBox = { x: -1, w: -1, h: -1 }
  private plateShown = false
  private plateMoving = false
  private activeId: string | null = null

  private unsubTick: (() => void) | null = null
  private elapsed = 0

  constructor(private readonly handlers: SidebarHandlers) {
    this.el = document.createElement('nav')
    this.el.className = 'ember-sidebar'
    this.el.setAttribute('role', 'tablist')

    const head = document.createElement('div')
    head.className = 'ember-sidebar-head'

    const label = document.createElement('span')
    label.className = 'ember-sidebar-title'
    label.textContent = 'Sessions'

    const add = document.createElement('button')
    add.className = 'ember-newtab'
    add.title = 'New session  (Ctrl+Shift+T · ember new)'
    add.setAttribute('aria-label', 'New session')
    add.textContent = '+'
    add.addEventListener('click', () => this.handlers.onNew())

    // The orchestrator opens from here, next to the sessions it works with, rather than
    // from the title bar: it is a column that slides out beside this one, and the thing
    // that opens a column should sit on the edge it comes out of.
    this.orchBtn = document.createElement('button')
    this.orchBtn.className = 'ember-voicetoggle is-orch ember-sidebar-orch'
    this.orchBtn.title = ORCH_TITLE
    this.orchBtn.setAttribute('aria-label', 'Orchestrator')
    this.orchBtn.setAttribute('aria-pressed', 'false')
    this.orchBtn.innerHTML = ORCH_MARK
    this.orchBtn.addEventListener('click', () => this.handlers.onOrchestrator())

    add.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
    // Which agent a new session starts with — the + beside it opens Loom running it.
    this.providerBtn = document.createElement('button')
    this.providerBtn.type = 'button'
    this.providerBtn.className = 'ember-provider'
    this.providerBtn.title = 'The agent new sessions start with. Click to choose, or add more.'
    this.providerBtn.addEventListener('click', () => this.handlers.onProvider(this.providerBtn))
    // Where the orchestrator was: the council, your agents debating one question.
    this.orchBtn.title = 'Council — have your agents debate a question'
    this.orchBtn.setAttribute('aria-label', 'Council')
    head.append(label, this.providerBtn, this.orchBtn, add)

    // The places — todo, notes, map — as one quiet row of icons at the foot of the column.
    // The column is the session list; the places are a click away, never in its way.
    const nav = document.createElement('div')
    nav.className = 'ember-places'
    nav.setAttribute('role', 'toolbar')
    nav.setAttribute('aria-label', 'Places')
    for (const p of PLACES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ember-place'
      btn.dataset['place'] = p.id
      btn.title = p.title
      btn.setAttribute('aria-label', p.label)
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p.svg}</svg>`
      const name = document.createElement('span')
      name.className = 'ember-place-name'
      name.textContent = p.label
      const badge = document.createElement('span')
      badge.className = 'ember-place-badge'
      badge.hidden = true
      btn.append(name, badge)
      btn.addEventListener('click', () => this.handlers.onPlace(p.id))
      nav.append(btn)
      this.navBtns.set(p.id, { btn, badge })
    }
    this.list = document.createElement('div')
    this.list.className = 'ember-cards'

    this.plate = document.createElement('div')
    this.plate.className = 'ember-card-plate'
    this.plate.addEventListener('animationend', () => this.plate.classList.remove('is-landed'))
    this.list.appendChild(this.plate)

    this.el.append(head, this.list, nav)
  }

  /**
   * Whether any badge needs frames right now.
   *
   * The sidebar used to hold the animation loop open for the life of the process, so the
   * whole app rendered at 60Hz forever to bob a 38px sprite — and on a glass window every
   * one of those frames is a full-window composite through the blur. A resting session
   * dozes at a pace the 5Hz activity tick can carry (see `render`); only work, attention,
   * a reaction and the hold-to-close ring move fast enough to need the ticker.
   */
  private needsFrames(): boolean {
    if (!this.plateY.settled) return true
    for (const node of this.nodes.values()) {
      if (node.holding || node.hold > 0) return true
    }
    return false
  }

  /** Point the plate at the active card; travel if the target changed. */
  private aimPlate(activeId: string | null): void {
    const node = activeId ? this.nodes.get(activeId) : null
    if (!node) {
      this.plate.style.opacity = '0'
      this.plateShown = false
      this.activeId = activeId
      return
    }
    const root = node.root
    const x = root.offsetLeft
    const y = root.offsetTop
    const w = root.offsetWidth
    const h = root.offsetHeight
    if (w === 0 || h === 0) return

    if (x !== this.plateBox.x || w !== this.plateBox.w || h !== this.plateBox.h) {
      this.plateBox = { x, w, h }
      this.plate.style.left = `${x}px`
      this.plate.style.width = `${w}px`
      this.plate.style.height = `${h}px`
    }

    const changed = this.activeId !== activeId
    this.activeId = activeId
    if (!this.plateShown) {
      // First appearance: in place, no journey to make.
      this.plateShown = true
      this.plateY.set(y)
      this.paintPlate(0)
      this.plate.style.opacity = '1'
      return
    }
    if (changed) {
      // Only the plate moves. The card's own contents stay exactly where they are.
      this.plateY.to(y)
      this.ensureTicking()
    } else if (Math.abs(this.plateY.target - y) > 0.5) {
      // The list moved under it — a card left, or was dragged — follow without ceremony.
      this.plateY.to(y)
      this.ensureTicking()
    }
  }

  /**
   * Draw the plate at its current position, stretched along its direction of travel.
   * Squash-and-stretch is what makes a moving thing read as having mass: the leading
   * edge reaches ahead in proportion to speed and everything relaxes back on arrival.
   */
  private paintPlate(velocity: number): void {
    const stretch = Math.min(0.3, Math.abs(velocity) / 2400)
    this.plate.style.transformOrigin = velocity >= 0 ? 'top' : 'bottom'
    this.plate.style.transform = `translate3d(0, ${this.plateY.value.toFixed(2)}px, 0) scaleY(${(1 + stretch).toFixed(3)})`
  }

  /**
   * Re-place the selection plate now, from layout, without a journey.
   *
   * Called every frame while the column's width is animating: the cards change width
   * under the plate, and a plate re-aimed at 5Hz visibly trailed them.
   */
  syncPlateNow(): void {
    this.aimPlate(this.activeId)
  }

  /**
   * Put the orchestrator's element under the session list.
   *
   * It lives in this column because it runs these sessions, and under the list rather
   * than in its place because handing work to a session means looking at the sessions
   * while you do it. The list gives up height for it (see .ember-sidebar.has-orch).
   */
  mountBelowCards(el: HTMLElement): void {
    this.list.insertAdjacentElement('afterend', el)
  }

  /**
   * Which place is on stage, and the count worth a badge: how many items are open on
   * the list.
   */
  renderNav(active: Place | null, counts: Partial<Record<Place, number>>): void {
    const sig = `${active}|${counts.todo ?? 0}`
    if (sig === this.navSig) return
    this.navSig = sig
    for (const [id, { btn, badge }] of this.navBtns) {
      btn.classList.toggle('is-active', id === active)
      btn.setAttribute('aria-pressed', String(id === active))
      const n = counts[id] ?? 0
      badge.hidden = n <= 0
      badge.textContent = n > 99 ? '99+' : String(n)
    }
  }

  render(cards: CardModel[], activeId: string | null): void {
    const seen = new Set<string>()

    for (const [index, card] of cards.entries()) {
      seen.add(card.id)
      let node = this.nodes.get(card.id)
      if (!node) {
        node = this.createCard(card)
        this.nodes.set(card.id, node)
        this.list.appendChild(node.root)
      }
      node.model = card
      if (node.title.textContent !== card.title) node.title.textContent = card.title

      this.renderMeta(node, card)

      // The mascot says what the session is doing; repeating it in words underneath
      // was both redundant and the part that went stale first, so the line now carries
      // only what a picture cannot: how long it has been at it, and how many panes.
      const parts: string[] = []
      if (card.activity.detail) parts.push(card.activity.detail)
      if (card.paneCount > 1) parts.push(`${card.paneCount} panes`)
      const statusText = parts.join(' · ')
      node.root.title = card.activity.label
      // A resting session has nothing to add, so the whole line gets out of the way
      // rather than leaving a lone dot floating under the title.
      node.statusRow.classList.toggle('is-quiet', !statusText && card.activity.state !== 'attention')
      if (!node.statusPinned) node.status.set(statusText)

      // Position comes from flex `order`, not DOM order, so a reorder never has to
      // move nodes around (which would restart their transitions).
      if (!node.root.classList.contains('is-dragging')) node.root.style.order = String(index)

      node.root.style.setProperty('--card-accent', card.accent)
      node.root.dataset['state'] = card.activity.state
      node.root.dataset['attention'] = card.activity.attention ?? ''
      node.root.classList.toggle('is-active', card.id === activeId)
      node.root.classList.toggle('is-claude', card.activity.isClaude)
    }

    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue
      this.nodes.delete(id)
      this.collapse(node.root)
    }

    this.aimPlate(activeId)

    if (this.needsFrames()) this.ensureTicking()
  }

  /**
   * The third line of a card: branch, dev-server URL, unread marker. Built as a
   * signature-compared string so a 5Hz refresh does not rebuild DOM every tick.
   */
  private renderMeta(node: CardNode, card: CardModel): void {
    const git = card.git ? `${card.git.branch}${card.git.dirty ? `*${card.git.dirty}` : ''}` : ''
    const claude = `${card.claude?.model ?? ''}|${card.claude?.contextPercent === null || !card.claude ? '' : Math.round(card.claude.contextPercent)}`
    const signature = `${git}|${card.url ?? ''}|${card.unread > 0}|${claude}`
    if (signature === node.metaSignature) return
    node.metaSignature = signature

    node.meta.replaceChildren()
    node.root.classList.toggle('has-unread', card.unread > 0)
    const bits: string[] = []
    if (card.claude?.model) bits.push(card.claude.model)
    if (card.claude && card.claude.contextPercent !== null) bits.push(`${Math.round(card.claude.contextPercent)}%`)
    if (git) bits.push(git)
    if (bits.length) {
      const el = document.createElement('span')
      el.className = 'ember-card-metatext'
      el.dataset['hot'] = String((card.claude?.contextPercent ?? 0) >= 80)
      el.textContent = bits.join(' · ')
      if (card.claude) el.title = Sidebar.claudeTitle(card.claude)
      node.meta.appendChild(el)
    }
    if (card.url) {
      const el = document.createElement('button')
      el.className = 'ember-card-link'
      el.textContent = card.url.replace(/^https?:\/\//, '')
      el.title = `Open ${card.url}`
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        window.open(card.url!, '_blank')
      })
      node.meta.appendChild(el)
    }
  }

  private static claudeTitle(s: ClaudeStatus): string {
    const bits: string[] = []
    if (s.contextPercent !== null) {
      const size = s.contextSize ? ` of ${Math.round(s.contextSize / 1000)}k` : ''
      bits.push(`context ${Math.round(s.contextPercent)}%${size}`)
    }
    if (s.costUsd !== null) bits.push(`$${s.costUsd.toFixed(3)} this session`)
    if (s.durationMs !== null) bits.push(`${Math.round(s.durationMs / 60_000)} min`)
    if (s.cacheWarm !== null) bits.push(`cache ${s.cacheWarm ? 'warm' : 'cold'}`)
    return `Claude${s.model ? ` (${s.model})` : ''}: ${bits.join(' · ')}`
  }

  private createCard(card: CardModel): CardNode {
    const root = document.createElement('div')
    root.className = 'ember-card is-entering'
    root.dataset['id'] = card.id
    root.setAttribute('role', 'tab')

    // The state as a dot: working (the accent, breathing), waiting for you (amber), resting.
    const badge = document.createElement('span')
    badge.className = 'ember-card-state'

    const body = document.createElement('div')
    body.className = 'ember-card-body'
    const title = document.createElement('div')
    title.className = 'ember-card-title'
    title.textContent = card.title
    const status = document.createElement('div')
    status.className = 'ember-card-status'
    const dot = document.createElement('span')
    dot.className = 'ember-card-dot'
    const statusText = new Odometer('ember-card-statustext')
    statusText.set(card.activity.detail)
    status.append(dot, statusText.el)
    const meta = document.createElement('div')
    meta.className = 'ember-card-meta'
    body.append(title, status, meta)

    const close = document.createElement('button')
    close.className = 'ember-card-close'
    close.setAttribute('aria-label', `Hold to close ${card.title}`)
    close.title = 'Hold to close'
    close.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    // Deliberately no click handler: closing a terminal is destructive and a stray
    // click should never do it. The gesture is press-and-hold, driven in tick().
    close.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      const node = this.nodes.get(card.id)
      if (!node) return
      node.holding = true
      try {
        close.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic pointers (and some devices) have no capturable id; the hold
        // still works, it just won't track outside the button.
      }
      this.ensureTicking()
    })
    const release = (e: Event) => {
      e.stopPropagation()
      const node = this.nodes.get(card.id)
      if (node) node.holding = false
    }
    close.addEventListener('pointerup', release)
    close.addEventListener('pointercancel', release)
    close.addEventListener('lostpointercapture', release)
    close.addEventListener('click', (e) => e.stopPropagation())

    root.append(badge, body, close)
    root.addEventListener('click', () => this.handlers.onSelect(card.id))
    this.wireReorder(root, card.id)
    root.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.ember-card-close')) return
      this.beginRename(card.id)
    })
    root.addEventListener('auxclick', (e) => {
      if ((e as MouseEvent).button === 1) this.handlers.onClose(card.id)
    })

    requestAnimationFrame(() => root.classList.remove('is-entering'))

    return {
      root,
      title,
      status: statusText,
      statusPinned: false,
      statusRow: status,
      meta,
      metaSignature: '',
      close,
      model: card,
      hold: 0,
      holding: false,
    }
  }

  /** The orchestrator's button: whether the column is open, and whether it is working. */
  /** Show which agent new sessions start with. */
  setProvider(name: string): void {
    this.providerBtn.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="n"></span><span class="c" aria-hidden="true">▾</span>`
    ;(this.providerBtn.querySelector('.n') as HTMLElement).textContent = name
    this.providerBtn.setAttribute('aria-label', `New sessions start ${name}. Choose another agent.`)
  }

  setOrchestrator(state: { available: boolean; open: boolean; thinking: boolean }): void {
    // The button opens the council now; the orchestrator's state no longer shows on it.
    void state
    void ORCH_TITLE
  }

  /**
   * Write straight to a card's status line and hold it there.
   *
   * For looking at the roll without waiting out a real session, and for the probe,
   * which has to see a known sequence of values to tell "one digit turned" from "the
   * line moved". Pinning is what stops the 5Hz render loop putting the real state back
   * between two frames of the animation being measured.
   */
  pinStatus(id: string, text: string): boolean {
    const node = this.nodes.get(id)
    if (!node) return false
    node.statusPinned = true
    node.statusRow.classList.remove('is-quiet')
    node.status.set(text)
    return true
  }

  /**
   * Drag a card to reorder. The dragged card follows the pointer while its
   * neighbours slide out of the way (their transitions do the easing), and it drops
   * back into the flow on release.
   */
  private wireReorder(root: HTMLElement, id: string): void {
    let startY = 0
    let dragging = false
    let order: string[] = []

    const onMove = (e: PointerEvent) => {
      const dy = e.clientY - startY
      if (!dragging && Math.abs(dy) < 6) return
      if (!dragging) {
        dragging = true
        root.classList.add('is-dragging')
        // Seed from the current *visual* order, not the Map's insertion order —
        // after a previous reorder those two no longer agree.
        order = [...this.nodes.entries()]
          .sort((a, b) => (Number(a[1].root.style.order) || 0) - (Number(b[1].root.style.order) || 0))
          .map(([cardId]) => cardId)
      }
      root.style.transform = `translateY(${dy}px) scale(1.03)`

      const step = root.offsetHeight + 6
      const from = order.indexOf(id)
      const to = Math.max(0, Math.min(order.length - 1, from + Math.round(dy / step)))
      if (to !== from) {
        order.splice(to, 0, ...order.splice(from, 1))
        startY += (to - from) * step
        root.style.transform = `translateY(${e.clientY - startY}px) scale(1.03)`
        for (const [i, oid] of order.entries()) {
          const n = this.nodes.get(oid)
          if (n && n.root !== root) n.root.style.order = String(i)
        }
        root.style.order = String(order.indexOf(id))
        this.handlers.onReorder(order)
      }
    }

    // Window-level: the card can be redrawn under the pointer (its status ticks while an
    // agent works), and a drag that lost its element's capture would never end.
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('blur', onUp)
      if (dragging) {
        dragging = false
        root.classList.remove('is-dragging')
        root.style.transform = ''
        // Swallow the click that would otherwise select the card we just dropped.
        root.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true })
      }
    }

    root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.ember-card-close, .ember-card-rename')) return
      if (e.button !== 0) return
      startY = e.clientY
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
      window.addEventListener('blur', onUp)
    })
  }

  /** Swap the title for an input. Enter or blur commits, Escape reverts. */
  beginRename(id: string): void {
    const node = this.nodes.get(id)
    if (!node || node.root.querySelector('.ember-card-rename')) return

    const input = document.createElement('input')
    input.className = 'ember-card-rename'
    input.value = node.model.title
    input.spellcheck = false
    node.title.style.display = 'none'
    node.title.parentElement?.insertBefore(input, node.title)

    let done = false
    const finish = (commit: boolean) => {
      if (done) return
      done = true
      const value = input.value.trim()
      input.remove()
      node.title.style.display = ''
      if (commit) this.handlers.onRename(id, value)
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('dblclick', (e) => e.stopPropagation())

    requestAnimationFrame(() => {
      input.focus()
      input.select()
    })
  }

  private ensureTicking(): void {
    if (!this.unsubTick) this.unsubTick = ticker.add((dt) => this.tick(dt))
  }

  private collapse(node: HTMLElement): void {
    node.style.height = `${node.offsetHeight}px`
    node.classList.add('is-leaving')
    requestAnimationFrame(() => {
      node.style.height = '0px'
      node.style.marginBottom = '0px'
    })
    const done = () => node.remove()
    node.addEventListener('transitionend', done, { once: true })
    window.setTimeout(done, 420)
  }

  private tick(dt: number): void {
    this.elapsed += dt

    if (!this.plateY.settled) {
      this.plateMoving = true
      this.plateY.step(dt)
      this.paintPlate(this.plateY.velocity)
    } else if (this.plateMoving) {
      // One last frame with no stretch, so it comes to rest as the shape of the card —
      // and the contact: a spark along the join with the stage, once, as it lands.
      this.plateMoving = false
      this.plateY.set(this.plateY.target)
      this.paintPlate(0)
      this.plate.classList.remove('is-landed')
      void this.plate.offsetWidth
      this.plate.classList.add('is-landed')
    }

    // Press-and-hold to close. Filling forward takes HOLD_S; releasing early rewinds
    // roughly three times faster, so an accidental tap snaps back rather than
    // lingering as a half-full ring.
    for (const [id, node] of this.nodes) {
      const before = node.hold
      node.hold = node.holding
        ? Math.min(1, node.hold + dt / Sidebar.HOLD_S)
        : Math.max(0, node.hold - (dt / Sidebar.HOLD_S) * 3)

      if (node.hold !== before) node.close.style.setProperty('--hold', node.hold.toFixed(3))
      // Only touch the class when it changes. Toggling it to the value it already has,
      // every frame, on every card, was a style recalc and a compositor commit per frame
      // for the whole window — ~120 a second while any session worked.
      const holding = node.hold > 0.02
      if (node.close.classList.contains('is-holding') !== holding) node.close.classList.toggle('is-holding', holding)

      if (node.hold >= 1 && before < 1) {
        node.holding = false
        node.hold = 0
        node.close.style.setProperty('--hold', '0')
        this.handlers.onClose(id)
      }
    }

    // Nothing left that needs frames: let the loop stop. `render` restarts it the moment
    // a session goes to work or asks for you.
    if (!this.needsFrames()) {
      this.unsubTick?.()
      this.unsubTick = null
    }
  }


  dispose(): void {
    this.unsubTick?.()
    this.unsubTick = null
  }
}
