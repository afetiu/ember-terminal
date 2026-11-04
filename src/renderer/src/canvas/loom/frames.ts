/**
 * Frames that sleep. Every diagram, document and page on the canvas is an iframe with a
 * document of its own (a diagram's carries mermaid), and the canvas shows one turn at a
 * time: a long conversation kept every earlier turn's frames loaded, out of sight, for
 * good — 30 diagrams were 30 live documents. Here a static frame (a diagram, a markdown or
 * code document) loads when it first comes near the screen, and one that has been away
 * from it for a while is unloaded, keeping its size, and loads again on approach.
 *
 * Never put to sleep: a page or anything that can hold what you did in it (html, a view, a
 * live browser, a question), anything placed, snapped or full screen, a frame with the
 * keyboard. Those stay exactly as they were.
 */

/** How far off screen a frame still counts as near: it is loaded before it shows. */
const NEAR = '800px 0px'
/** How long a frame must have been away before it is unloaded. */
const AWAY_MS = 10_000
const BLANK = 'about:blank'

interface FrameState {
  /** The document it shows (or will, once near). */
  url: string
  asleep: boolean
  timer: number
}

export class FrameSleeper {
  private readonly state = new WeakMap<HTMLIFrameElement, FrameState>()
  private readonly io = new IntersectionObserver((entries) => {
    for (const e of entries) this.seen(e.target as HTMLIFrameElement, e.isIntersecting)
  }, { rootMargin: NEAR })
  /** For probes: how many frames are unloaded right now, and how many times one woke. */
  asleep = 0
  wakes = 0

  /**
   * Show `url` in `f`: at once for a frame that must keep its state, or when it first
   * comes near the screen for a static one.
   */
  load(f: HTMLIFrameElement, url: string): void {
    const s: FrameState = { url, asleep: true, timer: 0 }
    this.state.set(f, s)
    this.asleep++
    this.io.observe(f)
    // Not yet in the document, or not a static one: it loads as every frame always did.
    // The observer still hears about it; it simply never qualifies for sleep.
    if (!f.isConnected || !this.sleepable(f)) this.wake(f, s)
  }

  private seen(f: HTMLIFrameElement, near: boolean): void {
    const s = this.state.get(f)
    if (!s) return
    if (!f.isConnected) {
      this.forget(f, s)
      return
    }
    window.clearTimeout(s.timer)
    s.timer = 0
    if (near) {
      if (s.asleep) this.wake(f, s)
      return
    }
    if (s.asleep) return
    s.timer = window.setTimeout(() => {
      s.timer = 0
      if (f.isConnected && this.sleepable(f)) this.sleep(f, s)
    }, AWAY_MS)
  }

  private wake(f: HTMLIFrameElement, s: FrameState): void {
    s.asleep = false
    this.asleep--
    // Something else gave it a document meanwhile (an update to the diagram): that stands.
    if (f.getAttribute('src') && f.getAttribute('src') !== BLANK) return
    if (f.dataset['slept']) {
      this.wakes++
      // The shimmer of a loading object, in the size it had.
      const host = f.parentElement
      host?.classList.add('is-loading')
      f.addEventListener('load', () => window.setTimeout(() => host?.classList.remove('is-loading'), 160), { once: true })
    }
    f.src = s.url
  }

  private sleep(f: HTMLIFrameElement, s: FrameState): void {
    const now = f.getAttribute('src') ?? ''
    if (now && now !== BLANK) s.url = now
    s.asleep = true
    this.asleep++
    f.dataset['slept'] = '1'
    // Its height stays as the document last set it, so nothing around it moves.
    f.src = BLANK
  }

  private forget(f: HTMLIFrameElement, s: FrameState): void {
    window.clearTimeout(s.timer)
    if (s.asleep) this.asleep--
    this.state.delete(f)
    this.io.unobserve(f)
  }

  /** A diagram or a static document, in the flow of a turn, that nobody is using. */
  private sleepable(f: HTMLIFrameElement): boolean {
    if (document.activeElement === f) return false
    if (f.closest('.loom-pins, .loom-modal, .is-sized')) return false
    const piece = f.closest<HTMLElement>('.loom-piece')
    if (piece) return piece.classList.contains('is-mermaid') || piece.classList.contains('is-markdown') || piece.classList.contains('is-code')
    return !!f.closest('.loom-diagram')
  }

  /** The document a frame shows, asleep or not — what to compare when the same thing is shown again. */
  urlOf(f: HTMLIFrameElement): string {
    return this.state.get(f)?.url ?? f.src
  }

  dispose(): void {
    this.io.disconnect()
  }
}
