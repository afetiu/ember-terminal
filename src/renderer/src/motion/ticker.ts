type TickFn = (dt: number, now: number) => void

/**
 * One requestAnimationFrame loop for the entire app.
 *
 * Every animated thing subscribes here rather than opening its own rAF. That keeps
 * all motion phase-locked to the same frame — a cursor stepping on a different
 * frame from the tab indicator is exactly what reads as "janky" — and it means the
 * loop stops completely when nothing is moving, so an idle terminal costs 0% CPU.
 */
class Ticker {
  private readonly subs = new Set<TickFn>()
  private readonly observers = new Set<TickFn>()
  private raf = 0
  private last = 0

  add(fn: TickFn): () => void {
    this.subs.add(fn)
    this.start()
    return () => {
      this.subs.delete(fn)
    }
  }

  /**
   * Watch frames without asking for them.
   *
   * An observer runs on every frame the loop was going to run anyway, and is invisible
   * to the liveness check below. This exists because the frame-rate sampler used `add`,
   * and `add` is a request: one permanent subscriber meant `subs.size` was never zero,
   * the loop never stopped, and the "idle terminal costs 0% CPU" promise above was
   * false for the entire life of the app. A thing that only measures motion must not
   * be able to cause it.
   */
  observe(fn: TickFn): () => void {
    this.observers.add(fn)
    return () => {
      this.observers.delete(fn)
    }
  }

  private start(): void {
    if (this.raf !== 0) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private readonly frame = (now: number): void => {
    // Clamp dt: after the window is occluded or the machine stalls, an unclamped
    // delta makes every spring explode on the first frame back.
    const dt = Math.min((now - this.last) / 1000, 1 / 20)
    this.last = now

    for (const fn of this.subs) {
      try {
        fn(dt, now)
      } catch (err) {
        console.error('[ember] ticker subscriber threw', err)
      }
    }
    for (const fn of this.observers) {
      try {
        fn(dt, now)
      } catch (err) {
        console.error('[ember] ticker observer threw', err)
      }
    }

    // Observers deliberately do not count: they watch the loop, they do not hold it open.
    if (this.subs.size === 0) {
      this.raf = 0
      return
    }
    this.raf = requestAnimationFrame(this.frame)
  }
}

export const ticker = new Ticker()

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
