import type { LoomView } from '../LoomView'
import { EASE, SNAPS_PER_EDGE, div, ms, type Piece, type Side } from './shared'

/**
 * Where placed objects go: snapped to an edge (up to four per edge, the edge split between
 * them, in the order they were dropped), or floating. And how the words are laid out round
 * them once they are put down, so the words never lie under any of them.
 */
export class Snaps {
  /** Up to four objects per edge, in order; the edge is split between them. */
  snaps: Record<Side, Piece[]> = { left: [], right: [], top: [], bottom: [] }
  readonly preview = div('loom-snap-preview')

  /** How deep an edge's snaps are: a third of the width for a side, two fifths of the height for a band. */
  readonly snapSize: Partial<Record<Side, number>> = {}

  readonly pinObserver = new ResizeObserver(() => {
    if (!this.v.el.classList.contains('is-dragging')) this.reflow()
  })

  constructor(private readonly v: LoomView) {}

  /** The strip across the top that the buttons sit in: nothing is placed over it. */
  chromeTop(): number {
    const r = this.v.sign.getBoundingClientRect()
    const host = this.v.el.getBoundingClientRect()
    return r.height ? Math.round(r.bottom - host.top + 8) : 48
  }

  /** The film strip of turns down the left takes this much; nothing is placed over it. */
  railWidth(): number {
    return this.v.stage.rail.classList.contains('is-on') ? 38 : 0
  }

  private snapDepth(side: Side): number {
    const W = this.v.el.clientWidth
    const H = this.v.el.clientHeight
    const set = this.snapSize[side]
    if (set) return side === 'left' || side === 'right' ? Math.round(Math.max(240, Math.min(set, W * 0.6))) : Math.round(Math.max(110, Math.min(set, H * 0.7)))
    return side === 'left' || side === 'right' ? Math.round(Math.max(280, Math.min(W * 0.34, W * 0.5))) : Math.round(Math.max(150, Math.min(H * 0.42, H * 0.6)))
  }

  /** Where every snapped object goes, for a given arrangement. Sides take the full height; bands run between them. */
  snapRects(snaps: Record<Side, Piece[]>): Map<Piece, { left: number; top: number; width: number; height: number }> {
    const W = this.v.el.clientWidth
    const H = this.v.el.clientHeight
    const g = 8
    const out = new Map<Piece, { left: number; top: number; width: number; height: number }>()
    const lw = snaps.left.length ? this.snapDepth('left') : 0
    const rw = snaps.right.length ? this.snapDepth('right') : 0
    const rail = this.railWidth()
    // The buttons across the top right take a strip; nothing snaps under them.
    const top0 = this.chromeTop()
    const split = (list: Piece[], total: number) => {
      // A minimized object keeps only its bar; the others share what is left.
      const heads = list.map((p) => (p.el.classList.contains('is-min') ? (p.el.querySelector<HTMLElement>('.loom-piece-head')?.offsetHeight ?? 34) + 2 : 0))
      const open = list.filter((_, i) => !heads[i]).length
      const free = total - (list.length - 1) * g - heads.reduce((a, b) => a + b, 0)
      return list.map((_, i) => heads[i] || Math.max(60, free / Math.max(1, open)))
    }
    for (const side of ['left', 'right'] as const) {
      const list = snaps[side]
      if (!list.length) continue
      const w = side === 'left' ? lw : rw
      const sizes = split(list, H - top0 - g)
      let y = top0
      list.forEach((p, i) => {
        out.set(p, { left: side === 'left' ? rail + g : W - g - w, top: y, width: w, height: sizes[i]! })
        y += sizes[i]! + g
      })
    }
    const x0 = rail + (lw ? g + lw + g : g)
    const x1 = W - (rw ? g + rw + g : g)
    for (const side of ['top', 'bottom'] as const) {
      const list = snaps[side]
      if (!list.length) continue
      const h = this.snapDepth(side)
      const each = (x1 - x0 - (list.length - 1) * g) / list.length
      list.forEach((p, i) => {
        const min = p.el.classList.contains('is-min')
        const ph = min ? (p.el.querySelector<HTMLElement>('.loom-piece-head')?.offsetHeight ?? 34) + 2 : h
        out.set(p, { left: x0 + i * (each + g), top: side === 'top' ? top0 : H - g - ph, width: each, height: ph })
      })
    }
    return out
  }

  /**
   * Put every snapped object where it belongs, gliding there. With a trial arrangement
   * (while one is dragged to an edge) the others make room for it; the dragged one itself
   * stays under the pointer.
   */
  layoutSnaps(animate = true, snaps = this.snaps, skip?: Piece): void {
    for (const [p, r] of this.snapRects(snaps)) {
      if (p === skip) continue
      const el = p.el
      const from = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
      const to = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      Object.assign(el.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` })
      const moved = Math.abs(from.left - to.left) + Math.abs(from.top - to.top) + Math.abs(from.width - to.width) + Math.abs(from.height - to.height) > 2
      if (animate && moved) {
        el.animate(
          [
            { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
            { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` },
          ],
          { duration: ms(300), easing: EASE }
        )
      }
    }
  }

  /** The edge the pointer is at, if an object dropped there could snap to it. */
  snapSideAt(x: number, y: number, piece: Piece): Side | null {
    const r = this.v.el.getBoundingClientRect()
    const gaps: Array<[Side, number]> = [
      ['left', x - r.left],
      ['right', r.right - x],
      ['top', y - r.top],
      ['bottom', r.bottom - y],
    ]
    gaps.sort((a, b) => a[1] - b[1])
    const [side, d] = gaps[0]!
    if (d > 56) return null
    return this.snaps[side].filter((p) => p !== piece).length < SNAPS_PER_EDGE ? side : null
  }

  /**
   * Where along an edge a dropped object goes: before the first object whose middle is
   * past the pointer (below it on a side, to its right on a band), so it lands where you
   * let go — above the one already there, between two, or after them.
   */
  snapIndexAt(side: Side, x: number, y: number, piece: Piece): number {
    const vertical = side === 'left' || side === 'right'
    const list = this.snaps[side].filter((p) => p !== piece)
    const i = list.findIndex((p) => {
      const r = p.el.getBoundingClientRect()
      return vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2
    })
    return i < 0 ? list.length : i
  }

  unsnap(piece: Piece): void {
    const side = piece.snap
    if (!side) return
    this.snaps[side] = this.snaps[side].filter((p) => p !== piece)
    piece.snap = null
    piece.el.classList.remove('is-snapped')
    delete piece.el.dataset['snap']
    if (piece.free) {
      piece.el.style.width = `${piece.free.w}px`
      if (!piece.el.classList.contains('is-min')) piece.el.style.height = `${piece.free.h}px`
    }
    this.layoutSnaps()
  }

  /** Snap to an edge, at a place along it (the end when not given). */
  snapTo(piece: Piece, side: Side, at?: number): void {
    if (!piece.free) piece.free = { w: piece.el.offsetWidth, h: piece.el.offsetHeight }
    piece.snap = side
    piece.dock = side
    piece.el.classList.add('is-snapped')
    piece.el.dataset['snap'] = side
    piece.el.style.zIndex = '1'
    const list = this.snaps[side].filter((p) => p !== piece)
    list.splice(Math.max(0, Math.min(at ?? list.length, list.length)), 0, piece)
    this.snaps[side] = list
    this.layoutSnaps()
    this.reflow()
    this.v.reportScreen()
  }

  /**
   * Lay the words out round what is placed, once it is put down. The rule is the one you
   * would apply by eye:
   *
   * - an object below where the words end leaves them full width; above where they start,
   *   the same;
   * - an object in the right or left part of the screen takes that side, and the words
   *   run in a column beside it;
   * - a wide object in the middle takes a band, at the top or the bottom, whichever half
   *   it is in.
   *
   * Objects may lie over one another; the words never lie under any of them.
   */
  reflow(): void {
    const v = this.v
    const W = v.el.clientWidth
    const H = v.el.clientHeight
    const st = v.scroller.style
    const pins = [...v.pinned]
    const shown = v.stage.shown
    const inset = { left: 0, right: 0, top: 0, bottom: 0 }
    if (pins.length && W && H) {
      // Where the words end at full width: their height now, scaled to the full column.
      const colNow = Math.max(1, v.scroller.clientWidth)
      const textH = ((shown?.offsetHeight ?? 0) * colNow) / Math.max(1, W - 44) + 40
      let changed = false
      const g = 8
      if (this.snaps.left.length) inset.left = this.railWidth() + this.snapDepth('left') + 2 * g + 6
      if (this.snaps.right.length) inset.right = this.snapDepth('right') + 2 * g + 6
      if (this.snaps.top.length) inset.top = Math.max(...this.snaps.top.map((p) => p.el.offsetTop + p.el.offsetHeight)) + g
      if (this.snaps.bottom.length) inset.bottom = H - Math.min(...this.snaps.bottom.map((p) => p.el.offsetTop)) + g
      // Free objects: the words take the widest clear column between them, so they never
      // run under one. Only when no readable column is left do they go above or below.
      // Only objects beside the words matter: one sitting below where they end leaves them
      // where they are (checked again as the reply grows).
      const hostTop = v.el.getBoundingClientRect().top
      const textEnd = shown ? shown.getBoundingClientRect().top - hostTop + textH : 0
      const free = pins.filter((p) => !p.snap && !p.el.classList.contains('is-dragging') && p.el.offsetTop < textEnd + 16)
      const lo = inset.left
      const hi = W - inset.right
      const spans = free.map((p) => [Math.max(lo, p.el.offsetLeft - 14), Math.min(hi, p.el.offsetLeft + p.el.offsetWidth + 14)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
      let best: [number, number] = [lo, hi]
      let bestW = -1
      let x = lo
      const gaps: Array<[number, number]> = []
      for (const [a, b] of [...spans, [hi, hi] as [number, number]]) {
        if (a > x) gaps.push([x, a])
        if (a - x > bestW) {
          bestW = a - x
          best = [x, a]
        }
        x = Math.max(x, b)
      }
      // The words keep to the left whenever a readable column is there.
      const leftmost = gaps.find(([a, b]) => b - a >= 420)
      if (leftmost) {
        best = leftmost
        bestW = leftmost[1] - leftmost[0]
      }
      if (!free.length) {
        // nothing free: the snaps alone decide
      } else if (bestW >= 320) {
        inset.left = best[0]
        inset.right = W - best[1]
        for (const p of free) {
          const side: Side = p.el.offsetLeft + p.el.offsetWidth / 2 < (best[0] + best[1]) / 2 ? 'left' : 'right'
          if (p.dock !== side) {
            p.dock = side
            changed = true
          }
        }
      } else {
        for (const p of free) {
          const t = p.el.offsetTop
          const bt = t + p.el.offsetHeight
          const side: Side = t + p.el.offsetHeight / 2 < H / 2 ? 'top' : 'bottom'
          if (side === 'top') inset.top = Math.max(inset.top, bt + 12)
          else inset.bottom = Math.max(inset.bottom, H - t + 12)
          if (p.dock !== side) {
            p.dock = side
            changed = true
          }
        }
      }
      // Never squeeze the words below a readable column or band.
      const spareW = W - 300
      if (inset.left + inset.right > spareW) {
        const k = Math.max(0, spareW) / (inset.left + inset.right)
        inset.left *= k
        inset.right *= k
      }
      const spareH = H - 120
      if (inset.top + inset.bottom > spareH) {
        const k = Math.max(0, spareH) / (inset.top + inset.bottom)
        inset.top *= k
        inset.bottom *= k
      }
      if (changed) v.reportScreen()
    }
    st.left = `${Math.round(inset.left)}px`
    st.right = `${Math.round(inset.right)}px`
    st.top = `${Math.round(inset.top)}px`
    st.bottom = `${Math.round(inset.bottom)}px`
    // The live line and the narration follow the words, so they never sit on an object.
    const es = v.el.style
    es.setProperty('--ins-l', `${Math.round(inset.left)}px`)
    es.setProperty('--ins-r', `${Math.round(inset.right)}px`)
    es.setProperty('--ins-b', `${Math.round(inset.bottom)}px`)
  }
}
