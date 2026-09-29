import { ticker } from './ticker'

export type QualityLevel = 'full' | 'reduced' | 'minimal'

/**
 * Watches frame time and sheds effects when the app stops keeping up.
 *
 * Smoothness *is* the satisfaction, so an effect that costs frames is a net loss.
 * Rather than guessing which machine can afford what, measure: a rolling median of
 * frame durations decides the level, and hysteresis stops it oscillating on the
 * boundary. The level is published as a data attribute so CSS can respond too.
 */
class Quality {
  private samples: number[] = []
  private level: QualityLevel = 'full'
  private lastChange = 0
  private listeners = new Set<(level: QualityLevel) => void>()
  private enabled = true

  constructor() {
    // observe, not add: this class measures frames, and measuring must not be the reason
    // frames happen. It samples only while something else is genuinely animating, which
    // is also the only time frame duration means anything.
    ticker.observe((dt) => this.sample(dt))
    document.documentElement.dataset['quality'] = 'full'
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.apply('full')
  }

  get current(): QualityLevel {
    return this.level
  }

  /** True while the app can afford the expensive, purely decorative work. */
  get allowsDecoration(): boolean {
    return this.level === 'full'
  }

  onChange(fn: (level: QualityLevel) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private sample(dt: number): void {
    if (!this.enabled) return
    // Ignore the huge first frame after the loop restarts from idle.
    if (dt > 0.2) return
    this.samples.push(dt * 1000)
    if (this.samples.length < 45) return

    const sorted = [...this.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16
    this.samples = []

    // 60Hz is 16.7ms. Degrade past ~28ms (36fps), recover below ~19ms (52fps).
    let next = this.level
    if (median > 34) next = 'minimal'
    else if (median > 26) next = 'reduced'
    else if (median < 19) next = 'full'

    if (next !== this.level && performance.now() - this.lastChange > 1500) this.apply(next)
  }

  private apply(level: QualityLevel): void {
    this.level = level
    this.lastChange = performance.now()
    document.documentElement.dataset['quality'] = level
    for (const fn of this.listeners) fn(level)
  }
}

export const quality = new Quality()
