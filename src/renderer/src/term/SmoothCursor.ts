import type { Terminal } from '@xterm/xterm'
import type { CursorConfig } from '@shared/types'
import { Spring2 } from '../motion/spring'
import { ticker } from '../motion/ticker'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Pt {
  x: number
  y: number
}

/** Convex hull (Andrew monotone chain). Only ever 8 points, so cost is irrelevant. */
function hull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function corners(r: Rect): Pt[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [199, 78, 255]
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A caret that travels instead of teleporting.
 *
 * xterm's own cursor is made transparent and this canvas is composited on top of the
 * WebGL grid. Drawing on our own canvas (rather than moving a DOM element) is what
 * makes the trail possible: the smear is the convex hull between where the caret is
 * and where it is heading, which is a real polygon, not something CSS can express.
 *
 * Two springs do the work — a stiff "head" the eye tracks, and a slack "tail" that
 * lags behind it. The gap between them *is* the trail, so it stretches naturally with
 * speed and collapses to nothing when the caret settles, with no special-casing.
 */
export class SmoothCursor {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly head: Spring2
  private readonly tail: Spring2

  private cell = { w: 9, h: 18 }
  private dpr = window.devicePixelRatio || 1
  /**
   * Where the canvas currently sits and how big it is, in CSS px of the screen element.
   * The canvas is only ever as large as the caret, its trail and its glow need — a pane
   * of 2400x1300 CSS px at 150% is seven million pixels, and clearing and compositing
   * that thirty times a second for a breathing caret was most of what the caret cost.
   * A window of a few hundred pixels that rides along with the caret costs nothing.
   */
  private win = { x: 0, y: 0, w: 0, h: 0 }
  private visible = true
  private focused = true
  private windowActive = true
  private unsubTick: (() => void) | null = null
  /** Pre-rendered caret + glow. See headSprite. */
  private sprite: HTMLCanvasElement | null = null
  private spriteKey = ''
  private spritePad = 0
  /** Seconds banked toward the next breathing frame. See the throttle in tick. */
  private pulseAccum = 0
  private ro: ResizeObserver | null = null
  private disposed = false
  private rgb: [number, number, number]
  private elapsed = 0
  private hiddenAt = 0
  private firstPlacement = true

  /** Downward kick applied when a command is submitted, in px. */
  private recoil = 0
  private recoilV = 0
  /** Rolling estimate of caret speed in px/s, used to stretch the trail. */
  private speed = 0

  /** How long the caret must stay hidden before we stop interpolating across it. */
  private static readonly REANCHOR_AFTER_S = 0.25

  constructor(
    private readonly term: Terminal,
    private readonly screenEl: HTMLElement,
    private cfg: CursorConfig,
    accent: string,
  ) {
    this.rgb = hexToRgb(accent)

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'ember-cursor-layer'
    const ctx = this.canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D context unavailable for cursor layer')
    this.ctx = ctx
    this.screenEl.appendChild(this.canvas)

    const springOpts = { stiffness: cfg.stiffness, damping: cfg.damping, epsilon: 0.02 }
    this.head = new Spring2(0, 0, springOpts)
    this.tail = new Spring2(0, 0, { ...springOpts, stiffness: cfg.trailStiffness })

    this.measure()
    this.ro = new ResizeObserver(() => this.measure())
    this.ro.observe(this.screenEl)

    window.addEventListener('focus', this.onWindowFocus)
    window.addEventListener('blur', this.onWindowBlur)

    this.resume()
  }

  get cellSize(): { w: number; h: number } {
    return this.cell
  }

  setAccent(accent: string): void {
    this.rgb = hexToRgb(accent)
  }

  setConfig(cfg: CursorConfig): void {
    this.cfg = cfg
    this.head.x.stiffness = cfg.stiffness
    this.head.y.stiffness = cfg.stiffness
    this.head.x.damping = cfg.damping
    this.head.y.damping = cfg.damping
    this.tail.x.stiffness = cfg.trailStiffness
    this.tail.y.stiffness = cfg.trailStiffness
  }

  setFocused(focused: boolean): void {
    this.focused = focused
  }

  /** Jump the caret to its target without animating — for resize and reflow. */
  snap(): void {
    const p = this.targetPx()
    if (!p) return
    this.head.set(p.x, p.y)
    this.tail.set(p.x, p.y)
  }

  private readonly onWindowFocus = () => {
    this.windowActive = true
    this.resume()
  }

  private readonly onWindowBlur = () => {
    this.windowActive = false
    // Stop burning frames on a window nobody is looking at; draw one final static
    // frame so the caret does not vanish or freeze mid-pulse.
    this.pause()
    this.draw(1)
  }

  private resume(): void {
    if (this.disposed || this.unsubTick) return
    this.unsubTick = ticker.add((dt) => this.tick(dt))
  }

  private pause(): void {
    this.unsubTick?.()
    this.unsubTick = null
  }

  /**
   * Cell metrics come from xterm's render service when available. That is internal
   * API, so there is a geometric fallback: the screen element is exactly cols x rows
   * cells, so dividing gives the same numbers whenever the internals move.
   */
  private measure(): void {
    const internal = (this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core
    const cell = internal?._renderService?.dimensions?.css?.cell
    if (cell && cell.width > 0 && cell.height > 0) {
      this.cell = { w: cell.width, h: cell.height }
    } else if (this.term.cols > 0 && this.term.rows > 0) {
      this.cell = {
        w: this.screenEl.clientWidth / this.term.cols,
        h: this.screenEl.clientHeight / this.term.rows,
      }
    }

    this.dpr = window.devicePixelRatio || 1
    if (this.screenEl.clientWidth === 0 || this.screenEl.clientHeight === 0) return
    // A DPR change invalidates the backing store; forcing a re-place rebuilds it.
    this.win = { x: 0, y: 0, w: 0, h: 0 }
    this.snap()
  }

  /**
   * Move and size the canvas so it covers `rect` (screen CSS px), and aim the context so
   * drawing code keeps using screen coordinates. Sizes are quantised so the backing store
   * is reallocated rarely rather than on every frame the trail stretches by a pixel.
   */
  private place(rect: Rect): void {
    const q = 48
    const x = Math.floor(rect.x / q) * q
    const y = Math.floor(rect.y / q) * q
    const w = Math.ceil((rect.x + rect.w - x) / q) * q
    const h = Math.ceil((rect.y + rect.h - y) / q) * q
    const cur = this.win
    if (w !== cur.w || h !== cur.h) {
      this.canvas.width = Math.max(1, Math.round(w * this.dpr))
      this.canvas.height = Math.max(1, Math.round(h * this.dpr))
      this.canvas.style.width = `${w}px`
      this.canvas.style.height = `${h}px`
    }
    if (x !== cur.x || y !== cur.y) this.canvas.style.transform = `translate3d(${x}px, ${y}px, 0)`
    this.win = { x, y, w, h }
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, -x * this.dpr, -y * this.dpr)
  }

  /** Target caret position in CSS px, or null when the caret is not on screen. */
  private targetPx(): Pt | null {
    const buf = this.term.buffer.active
    const internal = (this.term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean }; _coreService?: { isCursorHidden?: boolean } } })._core
    const hidden = internal?.coreService?.isCursorHidden ?? internal?._coreService?.isCursorHidden ?? false
    if (hidden) return null

    // cursorY is viewport-relative; translating through the absolute row keeps the
    // caret correct while the user is scrolled back through scrollback.
    const screenRow = buf.baseY + buf.cursorY - buf.viewportY
    if (screenRow < 0 || screenRow > this.term.rows - 1) return null

    return { x: buf.cursorX * this.cell.w, y: screenRow * this.cell.h }
  }

  private rectFor(p: Pt): Rect {
    const { w, h } = this.cell
    switch (this.cfg.shape) {
      case 'block':
        return { x: p.x, y: p.y, w, h }
      case 'underline': {
        const bh = Math.max(2, h * 0.12)
        return { x: p.x, y: p.y + h - bh, w, h: bh }
      }
      case 'bar':
      default:
        return { x: p.x, y: p.y, w: Math.max(1.5, w * this.cfg.barWidth), h }
    }
  }

  private tick(dt: number): void {
    this.elapsed += dt
    const target = this.targetPx()

    if (target === null) {
      if (this.visible) {
        this.visible = false
        this.hiddenAt = this.elapsed
        this.clear()
      }
      // Keep integrating toward the last known target while hidden. PSReadLine
      // toggles DECTCEM around every redraw, so the caret is invisible for a frame
      // or two constantly — freezing the springs here would stutter every keystroke.
      this.head.step(dt)
      this.tail.step(dt)
      return
    }

    if (!this.visible) {
      this.visible = true
      // Only re-seat the springs after a *sustained* hide, which means something
      // really did take over the screen (a TUI, an alternate buffer) and a trail
      // drawn across from the old position would be nonsense. A momentary
      // PSReadLine blink must not reset anything.
      if (this.elapsed - this.hiddenAt > SmoothCursor.REANCHOR_AFTER_S) {
        this.head.set(target.x, target.y)
        this.tail.set(target.x, target.y)
      }
    }

    if (this.firstPlacement) {
      this.firstPlacement = false
      this.head.set(target.x, target.y)
      this.tail.set(target.x, target.y)
    }

    this.head.to(target.x, target.y)
    this.tail.to(target.x, target.y)
    const prevX = this.head.x.value
    const prevY = this.head.y.value
    this.head.step(dt)
    this.tail.step(dt)

    // Rolling speed estimate: fast typing should leave a longer comet than a slow
    // cursor drift covering the same distance.
    const moved = Math.hypot(this.head.x.value - prevX, this.head.y.value - prevY)
    const instant = dt > 0 ? moved / dt : 0
    this.speed += (instant - this.speed) * Math.min(1, dt * 12)

    // Recoil: a stiff spring back to rest, integrated alongside everything else.
    if (this.recoil !== 0 || this.recoilV !== 0) {
      const k = 900
      const c = 2 * 1.0 * Math.sqrt(k)
      this.recoilV += (-k * this.recoil - c * this.recoilV) * dt
      this.recoil += this.recoilV * dt
      if (Math.abs(this.recoil) < 0.05 && Math.abs(this.recoilV) < 0.05) {
        this.recoil = 0
        this.recoilV = 0
      }
    }

    // Idle: nothing is moving, so only the breathing pulse needs frames.
    const idle = this.head.settled && this.tail.settled && this.recoil === 0
    const pulse =
      idle && this.cfg.pulsePeriod > 0 && this.focused
        ? 0.72 + 0.28 * (0.5 + 0.5 * Math.cos((this.elapsed / this.cfg.pulsePeriod) * Math.PI * 2))
        : 1

    // Breathing is the one animation that runs indefinitely, so it is the one worth
    // rationing. A 3.2s cosine resolved at 30Hz is indistinguishable from 60Hz and costs
    // half the frames; anything actually moving skips this and draws every frame.
    if (idle && pulse !== 1) {
      this.pulseAccum += dt
      if (this.pulseAccum < 1 / 30) return
      this.pulseAccum = 0
    } else {
      this.pulseAccum = 0
    }

    this.draw(pulse)

    if (idle && (this.cfg.pulsePeriod === 0 || !this.focused || !this.windowActive)) this.pause()
  }

  private clear(): void {
    const ctx = this.ctx
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.restore()
  }

  /**
   * The caret and its glow, pre-rendered.
   *
   * Rebuilt only when the things that change its pixels change — size, colour, glow
   * radius, DPR — which in practice means on a font change or a move to another monitor,
   * not on a frame. The sprite carries `spritePad` of transparent margin on every side so
   * the blur has somewhere to fall; the caller offsets by the same amount.
   */
  private headSprite(w: number, h: number): HTMLCanvasElement | null {
    if (w <= 0 || h <= 0) return null
    const [r, g, b] = this.rgb
    const key = `${w.toFixed(2)}x${h.toFixed(2)}|${this.cfg.glow}|${r},${g},${b}|${this.dpr}`
    if (this.sprite && this.spriteKey === key) return this.sprite

    // Skia's shadow reaches roughly 1.5x the nominal radius before it is invisible.
    const pad = Math.ceil(this.cfg.glow * 1.5) + 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil((w + pad * 2) * this.dpr))
    canvas.height = Math.max(1, Math.ceil((h + pad * 2) * this.dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    if (this.cfg.glow > 0) {
      ctx.shadowColor = `rgba(${r},${g},${b},0.9)`
      ctx.shadowBlur = this.cfg.glow
    }
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.beginPath()
    ctx.roundRect(pad, pad, w, h, Math.min(2, w / 2))
    ctx.fill()

    this.sprite = canvas
    this.spriteKey = key
    this.spritePad = pad
    return canvas
  }

  private draw(alphaScale: number): void {
    const ctx = this.ctx
    this.clear()
    if (!this.visible) return

    const headRect = this.rectFor({ x: this.head.x.value, y: this.head.y.value + this.recoil })
    const tailRect = this.rectFor({ x: this.tail.x.value, y: this.tail.y.value + this.recoil })
    const [r, g, b] = this.rgb

    // The window this frame needs: both rects plus the glow's reach. The sprite has not
    // been built yet on the first frame, so the pad is derived the same way it is there.
    const pad = Math.ceil(this.cfg.glow * 1.5) + 4
    const x0 = Math.min(headRect.x, tailRect.x) - pad
    const y0 = Math.min(headRect.y, tailRect.y) - pad
    const x1 = Math.max(headRect.x + headRect.w, tailRect.x + tailRect.w) + pad
    const y1 = Math.max(headRect.y + headRect.h, tailRect.y + tailRect.h) + pad
    this.place({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    this.clear()


    // Unfocused terminals get a hollow caret and no trail — the standard signal that
    // keystrokes are going somewhere else.
    if (!this.focused) {
      ctx.save()
      ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`
      ctx.lineWidth = 1
      ctx.strokeRect(headRect.x + 0.5, headRect.y + 0.5, Math.max(2, headRect.w) - 1, headRect.h - 1)
      ctx.restore()
      return
    }

    const dx = headRect.x - tailRect.x
    const dy = headRect.y - tailRect.y
    const dist = Math.hypot(dx, dy)

    if (this.cfg.trailOpacity > 0 && dist > 1.2) {
      const poly = hull([...corners(headRect), ...corners(tailRect)])
      const grad = ctx.createLinearGradient(
        tailRect.x + tailRect.w / 2,
        tailRect.y + tailRect.h / 2,
        headRect.x + headRect.w / 2,
        headRect.y + headRect.h / 2,
      )
      // Trail intensity rides on distance *and* speed, so hammering the keyboard
      // leaves a longer comet than the same distance covered slowly.
      const velocityBoost = 1 + Math.min(1.4, this.speed / (this.cell.w * 90))
      const strength = Math.min(1, (dist / (this.cell.w * 8)) * velocityBoost) * this.cfg.trailOpacity
      grad.addColorStop(0, `rgba(${r},${g},${b},0)`)
      grad.addColorStop(1, `rgba(${r},${g},${b},${strength.toFixed(3)})`)

      ctx.save()
      ctx.fillStyle = grad
      ctx.beginPath()
      poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    // The head is the same shape every frame — only its position and alpha change. Drawn
    // directly it cost a `shadowBlur` per frame, which is a real Gaussian blur in Skia and
    // the single most expensive thing this class did; at glow 40, with the idle pulse
    // holding the loop open, it ran 60 times a second forever. Stamped into a sprite once
    // and blitted, the per-frame cost becomes one drawImage.
    const sprite = this.headSprite(headRect.w, headRect.h)
    if (sprite) {
      const pad = this.spritePad
      ctx.save()
      ctx.globalAlpha = alphaScale
      // The destination size must be given explicitly. The sprite's intrinsic size is in
      // device pixels, this context is already scaled by dpr, and the three-argument
      // drawImage would apply that scale a second time — drawing the caret dpr times too
      // large and dpr times too far from where the padding says it should sit. Correct at
      // dpr 1, visibly wrong at 150%.
      ctx.drawImage(sprite, headRect.x - pad, headRect.y - pad, headRect.w + pad * 2, headRect.h + pad * 2)
      ctx.restore()
    }
  }

  /** Acknowledge a submitted command: the caret dips and springs back. */
  submit(): void {
    this.recoilV += this.cell.h * 5
    this.resume()
  }

  /** Call when the caret may have moved while the loop was parked. */
  wake(): void {
    this.resume()
  }

  /**
   * Put the caret where the shell has it with no animation and draw it once, then let
   * the loop park again. Used while output streams: a status line rewriting itself 30
   * times a second would otherwise keep the springs unsettled and this canvas repainting
   * every frame on top of the terminal's.
   */
  settleNow(): void {
    this.snap()
    this.recoil = 0
    this.recoilV = 0
    this.resume()
  }

  /** Introspection for the probe scripts — not used by the app itself. */
  debugState(): Record<string, unknown> {
    return {
      focused: this.focused,
      windowActive: this.windowActive,
      ticking: this.unsubTick !== null,
      visible: this.visible,
      cell: this.cell,
      head: { x: this.head.x.value, y: this.head.y.value },
      tail: { x: this.tail.x.value, y: this.tail.y.value },
      target: { x: this.head.x.target, y: this.head.y.target },
      gap: Math.hypot(this.head.x.value - this.tail.x.value, this.head.y.value - this.tail.y.value),
    }
  }

  /** Pin the focused state so a non-foreground window can still be inspected. */
  forceFocused(value: boolean): void {
    this.focused = value
    this.windowActive = value
    this.resume()
  }

  dispose(): void {
    this.disposed = true
    this.pause()
    this.ro?.disconnect()
    this.ro = null
    window.removeEventListener('focus', this.onWindowFocus)
    window.removeEventListener('blur', this.onWindowBlur)
    this.canvas.remove()
  }
}
