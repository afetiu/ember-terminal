import type { SoundConfig } from '@shared/types'

export type Cue = 'switch' | 'open' | 'close' | 'split' | 'attention' | 'failure' | 'toggle'

/**
 * Synthesised UI sound. No asset files: every cue is a couple of oscillators and an
 * envelope, which keeps the bundle unchanged and lets each cue be tuned as numbers.
 *
 * The set has two voices, split by how often you hear a cue:
 *
 *   - **Frequent cues stay plain sine.** `switch` fires dozens of times an hour, so it
 *     is a single short note with no interval. An interval is a gesture the ear keeps
 *     following, which is right for `attention` and wrong for something that lands
 *     while you are mid-thought.
 *   - **Rare cues get a vintage-hardware voice**: pulse waves through a low-pass, with
 *     a band-passed noise click standing in for a physical contact closing. Raw square
 *     waves sound like a smoke alarm; the filter is what makes them read as circuitry.
 *
 * Everything is tuned to one note collection (A, C, D, E, G) so the mechanical cues and
 * the musical ones sit in the same key rather than clashing.
 *
 * Two rules keep interface sound tolerable: every cue is short and low-gain, so it
 * reads as texture rather than signal; and repeats are rate-limited per cue, so a
 * burst of events cannot turn into a buzz.
 */
class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private config: SoundConfig = { enabled: true, volume: 1 }
  private lastAt = new Map<Cue, number>()

  configure(config: SoundConfig): void {
    this.config = config
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(config.enabled ? config.volume : 0, this.ctx.currentTime, 0.02)
    }
  }

  /**
   * Browsers refuse to start audio before a gesture, so the context is created
   * lazily on the first cue that follows one and resumed if it was suspended.
   */
  private ensure(): AudioContext | null {
    if (!this.config.enabled) return null
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = this.config.volume
        this.master.connect(this.ctx.destination)
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private tone(
    freq: number,
    duration: number,
    opts: {
      type?: OscillatorType
      gain?: number
      delay?: number
      sweepTo?: number
      /** Low-pass corner in Hz. Omit for an unfiltered tone. */
      cutoff?: number
      detune?: number
    } = {},
  ): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return

    const t0 = ctx.currentTime + (opts.delay ?? 0)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = opts.type ?? 'square'
    osc.frequency.setValueAtTime(freq, t0)
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.sweepTo), t0 + duration)
    if (opts.detune) osc.detune.value = opts.detune

    // Short attack, exponential tail — a linear release reads as a click.
    const peak = opts.gain ?? 0.2
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

    if (opts.cutoff) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = opts.cutoff
      osc.connect(lp)
      lp.connect(gain)
    } else {
      osc.connect(gain)
    }
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + duration + 0.03)
  }

  /** Band-passed noise burst: the sound of a physical contact closing. */
  private click(duration: number, gainValue: number, freq: number, delay = 0): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return

    const t0 = ctx.currentTime + delay
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration))
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    // Squared decay: a contact snaps shut, it does not fade linearly.
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2

    const src = ctx.createBufferSource()
    src.buffer = buffer
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = freq
    bp.Q.value = 1.1
    const gain = ctx.createGain()
    gain.gain.value = gainValue

    src.connect(bp)
    bp.connect(gain)
    gain.connect(master)
    src.start(t0)
  }

  play(cue: Cue): void {
    if (!this.ensure()) return

    // Rate-limit per cue so rapid repeats stay musical instead of buzzing.
    const now = performance.now()
    const minGap = cue === 'switch' ? 60 : 90
    if (now - (this.lastAt.get(cue) ?? 0) < minGap) return
    this.lastAt.set(cue, now)

    switch (cue) {
      case 'switch':
        // One short C6, no interval. Chosen by repetition test: an interval is a
        // gesture the ear keeps following, and after forty of them that is fatigue.
        this.tone(1046, 0.045, { type: 'sine', gain: 0.1 })
        break
      case 'attention':
        // The only melodic cue, and the only one meant to interrupt you.
        this.tone(523, 0.1, { type: 'sine', gain: 0.2 })
        this.tone(659, 0.1, { type: 'sine', gain: 0.2, delay: 0.075 })
        this.tone(880, 0.24, { type: 'sine', gain: 0.22, delay: 0.15 })
        break
      case 'open':
        // Channel up: contact, then A4 to E5.
        this.click(0.01, 0.18, 1500)
        this.tone(440, 0.055, { gain: 0.15, cutoff: 2200 })
        this.tone(659, 0.075, { gain: 0.13, cutoff: 2600, delay: 0.055 })
        break
      case 'close':
        // Channel down: the same movement inverted, with a damped thud under it.
        this.tone(659, 0.05, { gain: 0.13, cutoff: 2200 })
        this.tone(330, 0.09, { gain: 0.15, cutoff: 1700, delay: 0.05, sweepTo: 247 })
        this.click(0.06, 0.2, 320, 0.05)
        break
      case 'split':
        // Two identical contacts: one became two.
        this.click(0.012, 0.24, 1900)
        this.tone(587, 0.045, { gain: 0.12, cutoff: 2400 })
        this.click(0.012, 0.24, 1900, 0.075)
        this.tone(587, 0.045, { gain: 0.12, cutoff: 2400, delay: 0.075 })
        break
      case 'failure':
        // Deliberately outside the key, and detuned so it beats: a dull electrical
        // fault rather than a note.
        this.tone(155, 0.24, { gain: 0.17, cutoff: 900 })
        this.tone(164, 0.24, { gain: 0.13, cutoff: 900, detune: -8 })
        break
      case 'toggle':
        this.tone(440, 0.06, { gain: 0.16, cutoff: 2600 })
        break
    }
  }
}

export const sound = new SoundEngine()
