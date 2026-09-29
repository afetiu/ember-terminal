export interface SpringOptions {
  /** Angular stiffness. ~200 = languid, ~900 = snappy, ~2000 = nearly instant. */
  stiffness: number
  /** Damping ratio. 1 = critically damped, <1 overshoots, >1 sluggish. */
  damping: number
  /** Below this distance (and matching velocity) the spring snaps and reports settled. */
  epsilon?: number
}

/**
 * Damped harmonic oscillator integrated with semi-implicit Euler at a fixed
 * sub-timestep.
 *
 * Duration-based easing is the wrong tool for a caret: keystrokes retarget the
 * animation mid-flight, and restarting an ease each time produces a visible stutter.
 * A spring absorbs a new target by carrying its existing velocity through, which is
 * what makes fast typing read as one continuous glide rather than a series of hops.
 */
export class Spring {
  value: number
  target: number
  velocity = 0

  stiffness: number
  damping: number
  private readonly epsilon: number

  constructor(initial: number, opts: SpringOptions) {
    this.value = initial
    this.target = initial
    this.stiffness = opts.stiffness
    this.damping = opts.damping
    this.epsilon = opts.epsilon ?? 0.05
  }

  /** Retarget without losing momentum. */
  to(target: number): void {
    this.target = target
  }

  /** Teleport — used on resize/reflow, where interpolating would look like a glitch. */
  set(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  get settled(): boolean {
    return Math.abs(this.value - this.target) < this.epsilon && Math.abs(this.velocity) < this.epsilon
  }

  step(dt: number): number {
    if (this.settled) {
      this.value = this.target
      this.velocity = 0
      return this.value
    }

    // c = 2ζ√k for unit mass. Sub-stepping keeps stiff springs stable when the
    // frame budget slips (a 900-stiffness spring diverges at a single 30ms step).
    const c = 2 * this.damping * Math.sqrt(this.stiffness)
    const maxStep = 1 / 240
    let remaining = dt

    while (remaining > 0) {
      const h = Math.min(remaining, maxStep)
      const accel = -this.stiffness * (this.value - this.target) - c * this.velocity
      this.velocity += accel * h
      this.value += this.velocity * h
      remaining -= h
    }

    return this.value
  }
}

/** Two springs that share a config, for animating a point. */
export class Spring2 {
  readonly x: Spring
  readonly y: Spring

  constructor(x: number, y: number, opts: SpringOptions) {
    this.x = new Spring(x, opts)
    this.y = new Spring(y, opts)
  }

  to(x: number, y: number): void {
    this.x.to(x)
    this.y.to(y)
  }

  set(x: number, y: number): void {
    this.x.set(x)
    this.y.set(y)
  }

  step(dt: number): void {
    this.x.step(dt)
    this.y.step(dt)
  }

  get settled(): boolean {
    return this.x.settled && this.y.settled
  }
}
