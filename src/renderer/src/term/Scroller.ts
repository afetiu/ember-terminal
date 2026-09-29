import type { Terminal } from '@xterm/xterm'
import type { ScrollConfig } from '@shared/types'
import { Spring } from '../motion/spring'
import { ticker } from '../motion/ticker'
import { quality } from '../motion/quality'

/**
 * Makes the terminal *content* physical.
 *
 * Two behaviours, both driven from the shared ticker:
 *
 *   - **Momentum + rubber-band.** The wheel adds velocity to a friction model rather
 *     than jumping three lines at a time, and pushing past either end of the
 *     scrollback stretches and springs back instead of stopping dead.
 *   - **Arrival motion.** When the buffer scrolls because new output landed, the
 *     screen is offset by the height of what arrived and springs to zero, so lines
 *     rise into place instead of teleporting.
 *
 * Arrival motion is rate-gated: above a few thousand chars a second it is skipped
 * entirely, because a build log should stay instant and the animation would cost
 * frames exactly when frames are scarcest.
 */
export class Scroller {
  private readonly rise = new Spring(0, { stiffness: 300, damping: 1.0, epsilon: 0.05 })
  private velocity = 0
  private overscroll = 0
  private unsub: (() => void) | null = null
  private lastY = 0
  private cellHeight = 19
  private charsSinceTick = 0
  private rateWindowStart = 0
  private ratePerSec = 0
  private disposed = false

  /** Friction per second applied to wheel momentum. */
  private static readonly FRICTION = 6.5
  /** Below this, momentum is finished. */
  private static readonly MIN_V = 2

  constructor(
    private readonly term: Terminal,
    private readonly viewport: HTMLElement,
    private readonly screen: HTMLElement,
    private config: ScrollConfig,
    private effects: { outputMotion: boolean; outputMotionMaxRate: number },
  ) {
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false })
    this.lastY = this.term.buffer.active.viewportY
  }

  setConfig(config: ScrollConfig, effects: { outputMotion: boolean; outputMotionMaxRate: number }): void {
    this.config = config
    this.effects = effects
  }

  setCellHeight(h: number): void {
    if (h > 0) this.cellHeight = h
  }

  /** Called from Session.write with the size of each chunk, to measure throughput. */
  noteOutput(chars: number): void {
    const now = performance.now()
    if (now - this.rateWindowStart > 500) {
      this.ratePerSec = (this.charsSinceTick * 1000) / Math.max(1, now - this.rateWindowStart)
      this.charsSinceTick = 0
      this.rateWindowStart = now
    }
    this.charsSinceTick += chars
  }

  /**
   * Call after the terminal has rendered. If the viewport moved down because output
   * landed, start the rise.
   */
  noteRender(): void {
    const y = this.term.buffer.active.viewportY
    const delta = y - this.lastY
    this.lastY = y
    if (delta <= 0) return

    if (!this.effects.outputMotion) return
    if (this.ratePerSec > this.effects.outputMotionMaxRate) return
    if (!quality.allowsDecoration) return
    // A jump of many lines is a screen clear or a jump-to-bottom, not an arrival.
    if (delta > 4) return

    this.rise.value = Math.min(delta, 4) * this.cellHeight
    this.rise.velocity = 0
    this.rise.to(0)
    this.start()
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.config.inertia) return
    // Let the terminal's own handler deal with modifier combos (zoom, app scroll).
    if (e.ctrlKey || e.altKey || e.shiftKey) return
    if (this.term.buffer.active.type === 'alternate') return

    e.preventDefault()
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / this.cellHeight
    this.velocity += lines * this.config.speed * 14
    this.start()
  }

  private start(): void {
    if (this.unsub || this.disposed) return
    this.unsub = ticker.add((dt) => this.tick(dt))
  }

  private tick(dt: number): void {
    let busy = false

    // ---- momentum -------------------------------------------------------
    if (Math.abs(this.velocity) > Scroller.MIN_V) {
      busy = true
      const buf = this.term.buffer.active
      const maxY = Math.max(0, buf.baseY)
      const step = (this.velocity * dt) / this.cellHeight

      const nextY = buf.viewportY + step
      if (nextY < 0 || nextY > maxY) {
        // Past an end: convert the remaining momentum into stretch, then bleed it.
        if (this.config.elastic) {
          this.overscroll += this.velocity * dt * 0.22
          this.velocity *= 0.82
        } else {
          this.velocity = 0
        }
        this.term.scrollToLine(Math.max(0, Math.min(maxY, Math.round(nextY))))
      } else {
        this.term.scrollLines(Math.round(step) || (step > 0 ? 1 : -1))
        this.lastY = this.term.buffer.active.viewportY
      }

      this.velocity -= this.velocity * Scroller.FRICTION * dt
      if (Math.abs(this.velocity) <= Scroller.MIN_V) this.velocity = 0
    }

    // ---- rubber-band release --------------------------------------------
    if (Math.abs(this.overscroll) > 0.4) {
      busy = true
      // Critically damped return; clamped so a hard flick cannot tear the layout.
      this.overscroll = Math.max(-90, Math.min(90, this.overscroll))
      this.overscroll -= this.overscroll * Math.min(1, 14 * dt)
    } else {
      this.overscroll = 0
    }

    // ---- arrival rise ----------------------------------------------------
    if (!this.rise.settled) {
      busy = true
      this.rise.step(dt)
    }

    const offset = this.rise.value - this.overscroll
    this.screen.style.transform = offset === 0 ? '' : `translate3d(0, ${offset.toFixed(2)}px, 0)`

    if (!busy) {
      this.screen.style.transform = ''
      this.unsub?.()
      this.unsub = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.viewport.removeEventListener('wheel', this.onWheel)
    this.unsub?.()
    this.unsub = null
  }
}
