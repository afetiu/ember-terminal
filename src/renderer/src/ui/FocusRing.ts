import { Spring } from '../motion/spring'
import { ticker } from '../motion/ticker'

/**
 * A single ring that travels to whichever pane has focus, rather than a border that
 * blinks on and off per pane. Four springs — x, y, width, height — so moving focus
 * across a split reads as one object relocating.
 *
 * Only shown while a group is actually split; with one pane there is no ambiguity
 * about where input is going, and a permanent outline would just be noise.
 */
export class FocusRing {
  readonly el: HTMLElement
  private readonly x = new Spring(0, { stiffness: 520, damping: 1.0, epsilon: 0.2 })
  private readonly y = new Spring(0, { stiffness: 520, damping: 1.0, epsilon: 0.2 })
  private readonly w = new Spring(0, { stiffness: 520, damping: 1.0, epsilon: 0.2 })
  private readonly h = new Spring(0, { stiffness: 520, damping: 1.0, epsilon: 0.2 })
  private unsub: (() => void) | null = null
  private visible = false
  private first = true

  constructor(private readonly host: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'ember-focus-ring'
    this.host.appendChild(this.el)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.el.classList.remove('is-on')
    this.first = true
  }

  /** Point the ring at a pane. Pass null to hide it. */
  track(target: HTMLElement | null): void {
    if (!target) {
      this.hide()
      return
    }
    const host = this.host.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    const to = { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height }

    if (this.first) {
      this.x.set(to.x)
      this.y.set(to.y)
      this.w.set(to.w)
      this.h.set(to.h)
      this.first = false
      this.paint()
    } else {
      this.x.to(to.x)
      this.y.to(to.y)
      this.w.to(to.w)
      this.h.to(to.h)
    }

    this.visible = true
    this.el.classList.add('is-on')
    this.start()
  }

  private start(): void {
    if (this.unsub) return
    this.unsub = ticker.add((dt) => {
      this.x.step(dt)
      this.y.step(dt)
      this.w.step(dt)
      this.h.step(dt)
      this.paint()
      if (this.x.settled && this.y.settled && this.w.settled && this.h.settled) {
        this.unsub?.()
        this.unsub = null
      }
    })
  }

  private paint(): void {
    this.el.style.transform = `translate3d(${this.x.value.toFixed(1)}px, ${this.y.value.toFixed(1)}px, 0)`
    this.el.style.width = `${Math.max(0, this.w.value).toFixed(1)}px`
    this.el.style.height = `${Math.max(0, this.h.value).toFixed(1)}px`
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.el.remove()
  }
}
