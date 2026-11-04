import { escapeHtml } from '../markdown'
import { docTone } from '../../core/docTone'
import type { LoomView } from '../LoomView'
import { EASE, ICON, div, iconFor, ms, type Piece, type Side } from './shared'

/**
 * The pieces: every object on the canvas — a document, a diagram, a page, a picture — as a
 * titled box. Made here, and everything you can do to one by hand: drag it out of the
 * reply, place it, size it from any edge, minimize it to its bar, take it off, bring it to
 * the front, see through it, and open it full screen with zoom. Where a placed one snaps
 * and how the words make room is snaps.ts.
 */
export class Pieces {
  /** Objects you pinned: they stay where you put them, turn after turn, until removed. */
  readonly pinLayer = div('loom-pins')
  expanded: Piece | null = null
  private z = 10

  // ================================================================ full screen

  readonly modal = div('loom-modal')
  full: { piece: Piece; home: Node; next: Node | null } | null = null
  /** Zoom while full screen: − 100% +, and the same from the wheel (Ctrl or a pinch), + − 0 and a double-click. */
  private readonly zoomBar = div(
    'loom-zoom',
    `<button type="button" data-z="out" title="Zoom out (−)">−</button><button type="button" data-z="reset" class="loom-zoom-pct" title="Back to fit (0)">100%</button><button type="button" data-z="in" title="Zoom in (+)">+</button>`
  )
  private localZoom = 1
  private zoomWired = false

  private readonly titles = new Set<string>()

  constructor(private readonly v: LoomView) {}

  /** Bring a piece above every other floating one. */
  front(piece: Piece): void {
    piece.el.style.zIndex = String(++this.z)
  }

  mountFrame(host: HTMLElement, url: string, minHeight: number, maxHeight = 2400): HTMLIFrameElement {
    const f = document.createElement('iframe')
    f.className = 'loom-frame'
    // Scripts for mermaid and the buttons; the document's own origin for its fetches. No
    // top navigation: a document can never take Ember's window anywhere.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox')
    f.dataset['max'] = String(maxHeight)
    f.style.height = `${minHeight}px`
    // Until the document has drawn, the object shimmers in its own shape.
    host.classList.add('is-loading')
    f.addEventListener('load', () => window.setTimeout(() => host.classList.remove('is-loading'), 160), { once: true })
    // Drawn in the theme on screen: its accent, ink and ground, not the panel's purple.
    f.src = url.includes('?') ? url : `${url}${docTone()}`
    host.appendChild(f)
    this.v.frames.add(f)
    return f
  }

  makePiece(host: HTMLElement, title: string, format: string, actions: string[] = []): Piece {
    const v = this.v
    const el = div(`loom-piece is-${format}`)
    el.dataset['title'] = title
    const head = div('loom-piece-head')
    const kind = format === 'url' ? 'page' : format === 'media' ? 'media' : format === 'ask' ? 'question' : format
    // The bar is the title and three quiet controls, shown on hover. Everything else —
    // ask, change, place, see through, reload — is in the menu (⋯ or right-click).
    void actions
    head.title = 'Drag it out of the reply — place it anywhere, or at an edge to snap it there'
    head.innerHTML =
      `<span class="loom-piece-icon">${iconFor(format)}</span>` +
      `<span class="loom-piece-title">${escapeHtml(title)}</span>` +
      `<span class="loom-lift-hint">${ICON.grip}Drag out</span>` +
      `<span class="loom-piece-acts">` +
      `<button type="button" data-p="expand" title="Full screen (Esc to return)">${ICON.expand}</button>` +
      `<button type="button" data-p="fold" class="loom-min-btn" title="Minimize to its bar (double-click the bar)">${ICON.fold}</button>` +
      `<button type="button" data-p="more" title="More">${ICON.more}</button>` +
      `<button type="button" data-p="close" class="loom-close-btn" title="Remove from the screen">${ICON.close}</button></span>`
    const body = div('loom-piece-body')
    el.append(head, body)
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = div('loom-rz')
      h.dataset['rz'] = d
      el.appendChild(h)
    }
    host.appendChild(el)
    const piece: Piece = { el, body, title, format }
    el.addEventListener('pointerdown', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('.loom-rz')
      if (!h || e.button !== 0) return
      const dir = h.dataset['rz'] ?? 'se'
      if (!v.pinned.has(piece)) {
        // In the reply: any edge or corner sizes it in place.
        e.preventDefault()
        e.stopPropagation()
        this.resizeInline(piece, dir, e)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      this.resize(piece, dir, h, e)
    })
    head.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.minimize(piece)
    })
    el.addEventListener('pointerdown', () => this.raise(piece), true)
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
      // It lifts a little the moment it is held: it can come out of the reply.
      if (!v.pinned.has(piece)) {
        el.classList.add('is-peeling')
        const off = () => {
          el.classList.remove('is-peeling')
          window.removeEventListener('pointerup', off, true)
          window.removeEventListener('pointercancel', off, true)
        }
        window.addEventListener('pointerup', off, true)
        window.addEventListener('pointercancel', off, true)
      }
      this.drag(() => piece, head, e)
    })
    head.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button') && el.parentElement?.classList.contains('is-shelved')) {
        v.board.focusOn(piece)
        return
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-p]')
      if (!b) return
      const what = b.dataset['p']
      if (what === 'more') v.input.menu(b.getBoundingClientRect(), el)
      else if (what === 'fade') this.fade(piece)
      else if (what === 'pin') {
        this.pin(piece)
        this.settlePin(piece)
      }
      else if (what === 'close') {
        if (v.pinned.has(piece)) this.unpin(piece)
        else this.dismiss(piece)
      }
      else if (what === 'fold') {
        // From full screen: leave it first, then fold to the bar.
        if (this.full?.piece === piece) {
          this.fullscreen(piece, false)
          window.setTimeout(() => this.minimize(piece, true), 220)
        } else this.minimize(piece)
      }
      else if (what === 'expand') this.fullscreen(piece, this.full?.piece !== piece)
      else if (what === 'ask') v.input.ask(b.getBoundingClientRect(), `the "${title}" ${kind}`)
    })
    return piece
  }

  expand(piece: Piece, on: boolean): void {
    if (this.expanded && this.expanded !== piece) this.expanded.el.classList.remove('is-expanded')
    piece.el.classList.toggle('is-expanded', on)
    this.expanded = on ? piece : null
    if (on) {
      piece.el.style.setProperty('--loom-fill', `${Math.max(240, this.v.scroller.clientHeight - 64)}px`)
      requestAnimationFrame(() => this.v.reveal(piece.el, 'start'))
    }
  }

  // ================================================================ pinned objects

  /** Lift a piece off the stage and onto the screen, where it was, at a size that leaves room. */
  pin(piece: Piece, glide = true): void {
    const v = this.v
    if (v.pinned.has(piece)) return
    const host = v.el.getBoundingClientRect()
    const r = piece.el.getBoundingClientRect()
    const w = Math.round(Math.min(r.width, Math.max(380, host.width * 0.42), host.width - 24))
    if (this.expanded === piece) this.expand(piece, false)
    if (!piece.el.closest('.loom-diagram')) this.heal(piece.el, r.height)
    piece.el.classList.remove('is-folded', 'is-min')
    piece.el.classList.add('is-pinned')
    // Moving a frame reloads its document; the bridge still holds it, so it comes back as it was.
    this.pinLayer.appendChild(piece.el)
    v.pinned.add(piece)
    this.raise(piece)
    v.snapping.pinObserver.observe(piece.el)
    // The document reloads in its new place; tell it to fit the box rather than run long.
    const f = piece.frame
    if (f) f.addEventListener('load', () => f.contentWindow?.postMessage({ emberFit: true }, '*'))
    piece.el.style.height = `${Math.round(Math.max(160, Math.min(r.height, host.height - 24)))}px`
    this.place2(piece, r.left - host.left + (r.width - w), r.top - host.top, w)
    v.renderSign()
    if (glide) {
      const n = piece.el.getBoundingClientRect()
      piece.el.animate(
        [
          { transform: `translate(${r.left - n.left}px, ${r.top - n.top}px) scale(${Math.min(1.2, r.width / Math.max(1, n.width))})`, transformOrigin: 'top left', opacity: 0.6 },
          { transform: 'none', transformOrigin: 'top left', opacity: 1 },
        ],
        { duration: ms(340), easing: EASE }
      )
    }
  }

  /**
   * Minimize to the title bar, or back. The height glides; the body stays visible while it
   * closes so nothing blinks, and the text takes the room back once it has.
   */
  minimize(piece: Piece, on?: boolean): void {
    const v = this.v
    const el = piece.el
    const head = el.querySelector<HTMLElement>('.loom-piece-head')
    if (!head) return
    const closing = on ?? !el.classList.contains('is-min')
    if (closing === el.classList.contains('is-min')) return
    const pinned = v.pinned.has(piece)
    const from = el.offsetHeight
    let to: number
    if (closing) {
      if (pinned) el.dataset['h'] = String(from)
      to = head.offsetHeight + 2
    } else {
      el.classList.remove('is-min')
      if (pinned) to = Number(el.dataset['h'] ?? 0) || 320
      else {
        el.style.height = ''
        to = el.offsetHeight
      }
    }
    el.style.height = `${to}px`
    el.classList.add('is-animating')
    const btn = head.querySelector('.loom-min-btn')
    if (btn) btn.innerHTML = closing ? ICON.restore : ICON.fold
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ms(300), easing: EASE })
    a.onfinish = () => {
      el.classList.remove('is-animating')
      if (closing) el.classList.add('is-min')
      if (!pinned && !closing) el.style.height = ''
      if (!pinned && closing) el.style.height = ''
      if (piece.snap) v.snapping.layoutSnaps()
      v.snapping.reflow()
    }
  }

  place2(piece: Piece, left: number, top: number, width?: number): void {
    const v = this.v
    const host = v.el.getBoundingClientRect()
    const st = piece.el.style
    if (width) st.width = `${width}px`
    const w = piece.el.offsetWidth || width || 380
    const min = v.snapping.railWidth() + 6
    st.left = `${Math.round(Math.max(min, Math.min(host.width - w - 6, left)))}px`
    st.top = `${Math.round(Math.max(v.snapping.chromeTop(), Math.min(host.height - 40, top)))}px`
  }

  /** Take a pinned piece off the screen for good. */
  unpin(piece: Piece, delay = 0): void {
    const v = this.v
    if (!v.pinned.delete(piece)) return
    v.plan.planClosed(piece)
    if (this.full?.piece === piece) this.fullscreen(piece, false)
    if (piece.snap) {
      v.snapping.snaps[piece.snap] = v.snapping.snaps[piece.snap].filter((p) => p !== piece)
      piece.snap = null
      window.setTimeout(() => v.snapping.layoutSnaps(), ms(delay + 120))
    }
    const out = piece.el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.96) translateY(6px)' },
      ],
      { duration: ms(220), delay: ms(delay), easing: EASE, fill: 'forwards' }
    )
    out.onfinish = () => {
      piece.el.remove()
      v.snapping.reflow()
    }
    if (piece.frame) v.frames.delete(piece.frame)
    for (const [k, p] of v.pieces) if (p === piece) v.pieces.delete(k)
    const i = v.browsers.findIndex((b) => b.piece === piece)
    if (i >= 0) v.browsers.splice(i, 1)
    v.snapping.pinObserver.unobserve(piece.el)
    v.renderSign()
    v.snapping.reflow()
    v.reportScreen()
  }

  /** Take an object off the board: it fades, and the board closes up. */
  dismiss(piece: Piece): void {
    const v = this.v
    v.plan.planClosed(piece)
    const el = piece.el
    const h = el.offsetHeight
    const out = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: ms(200), easing: EASE, fill: 'forwards' })
    out.onfinish = () => {
      this.heal(el, h)
      el.remove()
      if (piece.frame) v.frames.delete(piece.frame)
      for (const [k, p] of v.pieces) if (p === piece) v.pieces.delete(k)
      const i = v.browsers.findIndex((b) => b.piece === piece)
      if (i >= 0) v.browsers.splice(i, 1)
      v.reportScreen()
    }
  }

  /** Clear screen: every pinned object goes. What is on the stage stays. */
  clearScreen(): void {
    ;[...this.v.pinned].forEach((p, i) => this.unpin(p, i * 45))
  }

  /**
   * Drag by the title bar. A piece on the stage is pinned the moment it starts to move,
   * so taking it and putting it somewhere is all it takes. Let go near an edge and it docks
   * there, and the text makes room; anywhere else it floats over the text.
   */
  /**
   * Follow the pointer until it is let go — whatever happens to the element it started on.
   * A full-window shield takes every pointer event for the duration (frames, pages and the
   * live browser included), and the gesture always ends: on release, on cancel, when the
   * window loses focus, or when the pointer leaves the window. Moves are applied once per
   * frame.
   */
  track(e: PointerEvent, cursor: string, onMove: (ev: PointerEvent) => void, onEnd: () => void): void {
    const shield = div('loom-shield')
    shield.style.cursor = cursor
    document.body.appendChild(shield)
    let last: PointerEvent | null = null
    let raf = 0
    let ended = false
    const flush = () => {
      raf = 0
      if (last && !ended) onMove(last)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      last = ev
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const end = () => {
      if (ended) return
      ended = true
      if (raf) cancelAnimationFrame(raf)
      if (last) onMove(last)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('blur', end)
      document.documentElement.removeEventListener('mouseleave', end)
      shield.remove()
      onEnd()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('blur', end)
    document.documentElement.addEventListener('mouseleave', end)
  }

  /**
   * Drag by the title bar. A piece on the stage is pinned the moment it starts to move,
   * so taking it and putting it somewhere is all it takes. At an edge it snaps there.
   */
  drag(get: () => Piece | null, _handle: HTMLElement, e: PointerEvent): void {
    const v = this.v
    const snapping = v.snapping
    const sx = e.clientX
    const sy = e.clientY
    let piece: Piece | null = null
    let snapSide: Side | null = null
    let snapAt = 0
    let lastSlot = ''
    let ox = 0
    let oy = 0
    this.track(
      e,
      'grabbing',
      (ev) => {
        if (!piece) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
          piece = get()
          if (!piece) return
          // No easing while it is held: it follows the pointer exactly.
          piece.el.classList.add('is-dragging')
          v.el.classList.add('is-dragging')
          this.pin(piece, false)
          piece.dock = null
          // Taken out of a snap: back to its own size, and the edge closes up behind it.
          if (piece.snap) snapping.unsnap(piece)
          piece.el.style.zIndex = String(++this.z)
          const r = piece.el.getBoundingClientRect()
          ox = Math.min(Math.max(sx - r.left, 12), r.width - 12)
          oy = Math.min(Math.max(sy - r.top, 8), 30)
          snapping.reflow()
        }
        const host = v.el.getBoundingClientRect()
        this.place2(piece, ev.clientX - host.left - ox, ev.clientY - host.top - oy)
        // At an edge: show where it would snap.
        const side = snapping.snapSideAt(ev.clientX, ev.clientY, piece)
        snapSide = side
        // It goes where the pointer is among what is there already, not at the end.
        const at = side ? snapping.snapIndexAt(side, ev.clientX, ev.clientY, piece) : 0
        const slot = side ? `${side}:${at}` : ''
        const moved = slot !== lastSlot
        lastSlot = slot
        snapAt = at
        // Leaving the edge: the others close up again.
        if (moved && !side) snapping.layoutSnaps()
        if (side) {
          const list = snapping.snaps[side].filter((p) => p !== piece)
          list.splice(snapAt, 0, piece)
          const trial = { ...snapping.snaps, [side]: list } as Record<Side, Piece[]>
          // The others on that edge move apart to make room, once per new slot.
          if (moved) snapping.layoutSnaps(true, trial, piece)
          const r = snapping.snapRects(trial).get(piece)
          if (r) {
            Object.assign(snapping.preview.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
            if (!snapping.preview.isConnected) v.el.appendChild(snapping.preview)
            snapping.preview.classList.add('is-on')
          }
        } else snapping.preview.classList.remove('is-on')
      },
      () => {
        v.el.classList.remove('is-dragging')
        snapping.preview.classList.remove('is-on')
        if (!piece) return
        piece.el.classList.remove('is-dragging')
        if (snapSide) snapping.snapTo(piece, snapSide, snapAt)
        else this.settlePin(piece)
      }
    )
  }

  /**
   * Resize from any edge or corner. A floating object grows or shrinks on the side you
   * pull; a snapped one only from its inner edge, which sets how deep its whole edge is.
   * The words are laid out again when you let go.
   */
  /** Size an inline object (a diagram, a table, code) where it sits in the reply. */
  resizeInlineHost(host: HTMLElement, dir: string, e: PointerEvent): void {
    const frame = host.querySelector<HTMLIFrameElement>(':scope > iframe')
    if (!frame) host.style.overflow = 'auto'
    this.sizeInPlace(host, frame ?? host, dir, e)
  }

  /** Size an object where it sits in the reply: its width in the column, its height. */
  private resizeInline(piece: Piece, dir: string, e: PointerEvent): void {
    const frame = piece.body.querySelector<HTMLIFrameElement>('iframe')
    if (frame) frame.style.height = '100%'
    this.sizeInPlace(piece.el, piece.body, dir, e)
  }

  /**
   * The placed object's resize, inside the reply: the edge you pull follows the pointer.
   * The right edge grows out to the canvas's edge, the bottom one freely; the left and top ones move within the space
   * the object already has (it cannot leave its column or climb over the words above).
   */
  private sizeInPlace(box: HTMLElement, tall: HTMLElement, dir: string, e: PointerEvent): void {
    // Wider than the words if you want: out to the canvas's right edge.
    const col = Math.max(
      box.parentElement?.clientWidth || 0,
      this.v.scroller.getBoundingClientRect().right - box.getBoundingClientRect().left - 24
    )
    const w0 = box.offsetWidth
    const h0 = tall.offsetHeight
    const ml0 = parseFloat(box.style.marginLeft) || 0
    const mt0 = parseFloat(box.style.marginTop) || 0
    const sx = e.clientX
    const sy = e.clientY
    const clamp = (lo: number, hi: number, v: number) => Math.round(Math.max(lo, Math.min(hi, v)))
    box.classList.add('is-sized', 'is-resizing')
    const cursor = dir === 'n' || dir === 's' ? 'ns-resize' : dir === 'e' || dir === 'w' ? 'ew-resize' : dir === 'ne' || dir === 'sw' ? 'nesw-resize' : 'nwse-resize'
    this.track(
      e,
      cursor,
      (ev) => {
        const dx = ev.clientX - sx
        const dy = ev.clientY - sy
        if (dir.includes('e')) box.style.width = `${clamp(240, col - ml0, w0 + dx)}px`
        if (dir.includes('w')) {
          const w = clamp(240, ml0 + w0, w0 - dx)
          box.style.width = `${w}px`
          box.style.marginLeft = `${ml0 + w0 - w}px`
        }
        if (dir.includes('s')) tall.style.height = `${clamp(80, 2400, h0 + dy)}px`
        if (dir.includes('n')) {
          const h = clamp(80, h0 + mt0, h0 - dy)
          tall.style.height = `${h}px`
          box.style.marginTop = `${mt0 + h0 - h}px`
        }
      },
      () => {
        box.classList.remove('is-resizing')
        this.v.grew()
      }
    )
  }

  private resize(piece: Piece, dir: string, _handle: HTMLElement, e: PointerEvent): void {
    const v = this.v
    const el = piece.el
    const W = v.el.clientWidth
    const H = v.el.clientHeight
    const l0 = el.offsetLeft
    const t0 = el.offsetTop
    const w0 = el.offsetWidth
    const h0 = el.offsetHeight
    const minW = 240
    const minH = el.classList.contains('is-min') ? h0 : 90
    const sx = e.clientX
    const sy = e.clientY
    v.el.classList.add('is-dragging')
    el.classList.add('is-resizing')
    const cursor = dir === 'n' || dir === 's' ? 'ns-resize' : dir === 'e' || dir === 'w' ? 'ew-resize' : dir === 'ne' || dir === 'sw' ? 'nesw-resize' : 'nwse-resize'
    this.track(
      e,
      piece.snap ? (piece.snap === 'left' || piece.snap === 'right' ? 'ew-resize' : 'ns-resize') : cursor,
      (ev) => {
        const dx = ev.clientX - sx
        const dy = ev.clientY - sy
        if (piece.snap) {
          const side = piece.snap
          v.snapping.snapSize[side] = side === 'left' ? w0 + dx : side === 'right' ? w0 - dx : side === 'top' ? h0 + dy : h0 - dy
          v.snapping.layoutSnaps(false)
          return
        }
        let l = l0
        let t = t0
        let w = w0
        let h = h0
        if (dir.includes('e')) w = Math.min(W - l0 - 4, Math.max(minW, w0 + dx))
        if (dir.includes('w')) {
          w = Math.min(l0 + w0 - 4, Math.max(minW, w0 - dx))
          l = l0 + (w0 - w)
        }
        if (dir.includes('s')) h = Math.min(H - t0 - 4, Math.max(minH, h0 + dy))
        if (dir.includes('n')) {
          h = Math.min(t0 + h0 - 4, Math.max(minH, h0 - dy))
          t = t0 + (h0 - h)
        }
        Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` })
      },
      () => {
        v.el.classList.remove('is-dragging')
        el.classList.remove('is-resizing')
        if (!piece.snap) piece.free = { w: el.offsetWidth, h: el.offsetHeight }
        v.snapping.reflow()
      }
    )
  }

  // ---------------------------------------------------------------- full screen and zoom

  showZoom(z: number): void {
    const pct = this.zoomBar.querySelector('.loom-zoom-pct')
    if (pct) pct.textContent = `${Math.round(z * 100)}%`
  }

  /** Zoom what is full screen: a document zooms itself; anything else is scaled here. */
  private zoomFull(op: 'in' | 'out' | 'reset', at?: { x: number; y: number }, factor?: number): void {
    const piece = this.full?.piece
    if (!piece) return
    if (piece.frame?.contentWindow) {
      piece.frame.contentWindow.postMessage({ emberZoom: op }, '*')
      return
    }
    const body = piece.body
    const inner = body.firstElementChild as HTMLElement | null
    if (!inner) return
    const z0 = this.localZoom
    const z = Math.max(0.5, Math.min(8, op === 'reset' ? 1 : op === 'in' ? z0 * (factor ?? 1.25) : z0 / (factor ?? 1.25)))
    const r = body.getBoundingClientRect()
    const cx = at ? at.x - r.left : r.width / 2
    const cy = at ? at.y - r.top : r.height / 2
    const px = (body.scrollLeft + cx) / z0
    const py = (body.scrollTop + cy) / z0
    this.localZoom = z
    inner.style.transformOrigin = '0 0'
    inner.style.transform = z === 1 ? '' : `scale(${z})`
    body.scrollLeft = px * z - cx
    body.scrollTop = py * z - cy
    this.showZoom(z)
  }

  private wireZoom(): void {
    if (this.zoomWired) return
    this.zoomWired = true
    this.zoomBar.addEventListener('click', (e) => {
      const op = (e.target as HTMLElement).closest<HTMLElement>('[data-z]')?.dataset['z'] as 'in' | 'out' | 'reset' | undefined
      if (op) this.zoomFull(op)
    })
    this.modal.addEventListener(
      'wheel',
      (e) => {
        if (!this.full || this.full.piece.frame || !(e.ctrlKey || e.metaKey)) return
        e.preventDefault()
        const f = Math.exp(-e.deltaY * 0.0025)
        this.zoomFull(f >= 1 ? 'in' : 'out', { x: e.clientX, y: e.clientY }, f >= 1 ? f : 1 / f)
      },
      { passive: false }
    )
    this.modal.addEventListener('dblclick', (e) => {
      if (!this.full || this.full.piece.frame || !this.full.piece.body.contains(e.target as Node)) return
      this.zoomFull(this.localZoom > 1.01 ? 'reset' : 'in', { x: e.clientX, y: e.clientY }, 2)
    })
    const keys = (e: KeyboardEvent) => {
      if (!this.full || e.ctrlKey || e.altKey || e.metaKey) return
      if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return
      const op = e.key === '+' || e.key === '=' ? 'in' : e.key === '-' || e.key === '_' ? 'out' : e.key === '0' ? 'reset' : null
      if (!op) return
      e.preventDefault()
      e.stopPropagation()
      this.zoomFull(op)
    }
    window.addEventListener('keydown', keys, true)
    this.v.unsubs.push(() => window.removeEventListener('keydown', keys, true))
  }

  /** One object over everything, as large as the window allows. Esc or a click outside closes it. */
  fullscreen(piece: Piece, on = !this.full): void {
    if (on) {
      if (this.full) this.fullscreen(this.full.piece, false)
      const home = piece.el.parentNode
      if (!home) return
      this.full = { piece, home, next: piece.el.nextSibling }
      if (!this.modal.isConnected) {
        document.body.appendChild(this.modal)
        this.modal.addEventListener('pointerdown', (e) => {
          if (e.target === this.modal && this.full) this.fullscreen(this.full.piece, false)
        })
      }
      this.modal.appendChild(piece.el)
      this.wireZoom()
      this.localZoom = 1
      this.showZoom(1)
      this.modal.appendChild(this.zoomBar)
      piece.el.classList.add('is-full')
      this.modal.classList.add('is-on')
      const b = piece.el.querySelector('[data-p="expand"]')
      if (b) {
        b.innerHTML = ICON.restore
        b.setAttribute('title', 'Exit full screen (Esc)')
      }
      piece.frame?.addEventListener(
        'load',
        () => {
          piece.frame?.contentWindow?.postMessage({ emberFit: true }, '*')
          piece.frame?.contentWindow?.postMessage({ emberZoom: 'on' }, '*')
        },
        { once: true }
      )
    } else if (this.full && this.full.piece === piece) {
      const { home, next } = this.full
      this.full = null
      const close = this.modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(160), easing: EASE })
      close.onfinish = () => {
        this.modal.classList.remove('is-on')
        this.zoomBar.remove()
        const inner = piece.body.firstElementChild as HTMLElement | null
        if (inner && !piece.frame) inner.style.transform = ''
        piece.el.classList.remove('is-full')
        home.insertBefore(piece.el, next && next.parentNode === home ? next : null)
        const b = piece.el.querySelector('[data-p="expand"]')
        if (b) {
          b.innerHTML = ICON.expand
          b.setAttribute('title', 'Full screen (Esc to return)')
        }
        if (this.v.pinned.has(piece)) piece.frame?.addEventListener('load', () => piece.frame?.contentWindow?.postMessage({ emberFit: true }, '*'), { once: true })
        this.v.session.focus()
      }
    }
  }

  /** Whatever placed object holds the focus (its frame, its page) comes to the front. */
  raiseFocused(): void {
    const active = document.activeElement
    if (!active) return
    for (const p of this.v.pinned) if (p.el.contains(active)) this.raise(p)
  }

  /** The object you touch comes to the front. */
  raise(piece: Piece): void {
    if (!this.v.pinned.has(piece) || piece.snap) return
    piece.el.style.zIndex = String(++this.z)
  }

  /** An object over another can be seen through: 100%, 60%, 30%, and back. */
  private fade(piece: Piece): void {
    const steps = [1, 0.6, 0.3]
    const now = Number(piece.el.dataset['fade'] ?? 1)
    const next = steps[(steps.indexOf(now) + 1) % steps.length]!
    piece.el.dataset['fade'] = String(next)
    piece.el.style.setProperty('--fade', String(next))
    piece.el.classList.toggle('is-faded', next < 1)
    const b = piece.el.querySelector<HTMLElement>('.loom-fade-btn')
    if (b) b.title = next < 1 ? `See through: ${Math.round(next * 100)}% — click for ${Math.round((steps[(steps.indexOf(next) + 1) % steps.length]!) * 100)}%` : 'See through it: 100% → 60% → 30%'
  }

  /** Keep a placed piece inside the canvas (it shrank: the input grew, the window was resized) and lay the text out round it. */
  settlePin(piece: Piece): void {
    this.place2(piece, piece.el.offsetLeft, piece.el.offsetTop)
    this.v.snapping.reflow()
  }

  /** What is lifted out leaves no hole: the space it took closes up, smoothly. */
  private heal(at: HTMLElement, height: number): void {
    if (!at.parentElement || height < 4) return
    const gap = div('loom-heal')
    gap.style.height = `${height}px`
    at.parentElement.insertBefore(gap, at)
    requestAnimationFrame(() => requestAnimationFrame(() => (gap.style.height = '0px')))
    window.setTimeout(() => gap.remove(), 420)
  }

  /** What kind of object a liftable host is. */
  kindOf(host: HTMLElement): 'mermaid' | 'table' | 'code' | 'image' {
    if (host.classList.contains('loom-diagram')) return 'mermaid'
    if (host.classList.contains('loom-table')) return 'table'
    if (host.classList.contains('loom-code')) return 'code'
    return 'image'
  }

  /** A name for an object in a reply, given once, so you and the session can refer to it. */
  nameObject(host: HTMLElement): string {
    if (host.dataset['title']) return host.dataset['title']
    const kind = this.kindOf(host)
    if (kind === 'mermaid') return this.nameDiagram(host)
    // A table or code block takes the heading over it, if there is one close by.
    let base: string = kind
    let prev = host.previousElementSibling
    for (let i = 0; prev && i < 3; i++, prev = prev.previousElementSibling) {
      if (/^H[1-4]$/.test(prev.tagName)) {
        base = (prev.textContent ?? '').trim().slice(0, 50) || kind
        break
      }
    }
    if (kind === 'code') base = base === 'code' ? `${(host.querySelector('.loom-code-bar span')?.textContent ?? 'code').trim()} code` : base
    if (kind === 'image') base = (host.querySelector('img')?.getAttribute('alt') ?? '').trim().slice(0, 50) || 'picture'
    const taken = (t: string) => this.v.pieces.has(t) || this.titles.has(t)
    let t = base
    if (taken(t) || t === kind) {
      let n = 1
      while (taken(`${base} ${n}`)) n++
      t = `${base} ${n}`
    }
    host.dataset['title'] = t
    this.titles.add(t)
    return t
  }

  /**
   * Take an object out of the reply and make it a piece of its own, placed on the screen.
   * A diagram keeps its frame (and the reply keeps an empty, closed-up slot); a table, a
   * code block or a picture moves bodily, and the reply closes up behind it.
   */
  liftObject(host: HTMLElement): Piece | null {
    if (this.kindOf(host) === 'mermaid') return this.pinDiagram(host)
    const r = host.getBoundingClientRect()
    const kind = this.kindOf(host)
    const title = this.nameObject(host)
    this.heal(host, r.height)
    const piece = this.makePiece(host.parentElement ?? this.v.scroller, title, kind)
    host.parentElement?.insertBefore(piece.el, host)
    piece.source = kind === 'image' ? host.querySelector('img')?.src : (host.innerText ?? '').slice(0, 8000)
    host.querySelector('.loom-lift')?.remove()
    piece.body.appendChild(host)
    piece.el.style.width = `${Math.max(320, r.width + 2)}px`
    this.v.pieces.set(title, piece)
    this.pin(piece)
    return piece
  }

  /** A diagram in Claude's words becomes an object of its own when you pin it. */
  private pinDiagram(host: HTMLElement): Piece | null {
    const f = host.querySelector('iframe')
    if (!f) return null
    const r = host.getBoundingClientRect()
    this.heal(host, r.height)
    const title = this.nameObject(host)
    const piece = this.makePiece(host, title, 'mermaid')
    piece.source = host.dataset['source']
    this.v.pieces.set(title, piece)
    piece.frame = f
    piece.body.appendChild(f)
    piece.el.style.width = `${r.width}px`
    this.pin(piece)
    host.classList.add('is-lifted')
    return piece
  }

  /** A diagram in a reply, named once, so the user and the session can both refer to it. */
  private nameDiagram(host: HTMLElement): string {
    if (host.dataset['title']) return host.dataset['title']
    const t = this.diagramTitle(host.dataset['source'] ?? '')
    host.dataset['title'] = t
    this.titles.add(t)
    const lift = host.querySelector('.loom-lift-name')
    if (lift) lift.textContent = t
    return t
  }

  /** A name the session can refer to: the diagram's own title, or its kind and a number. */
  private diagramTitle(src: string): string {
    const raw = /^\s*title:?\s+(.+)$/m.exec(src)?.[1] ?? /^\s*(?:pie|gantt|journey|xychart-beta|quadrantChart)\s+title\s+(.+)$/m.exec(src)?.[1]
    const own = raw?.trim().replace(/^["'`]+|["'`]+$/g, '').trim() || undefined
    const kind = /^\s*(\w[\w-]*)/.exec(src.replace(/^---[\s\S]*?---\s*/, ''))?.[1] ?? 'diagram'
    let base = (own ?? `${kind === 'graph' || kind === 'flowchart' ? 'flowchart' : kind}`).trim().slice(0, 60)
    const taken = (t: string) => this.v.pieces.has(t) || this.titles.has(t)
    if (!own || taken(base)) {
      let n = 1
      while (taken(`${base} ${n}`)) n++
      base = `${base} ${n}`
    }
    return base
  }
}
