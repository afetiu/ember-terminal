import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ShellProfile, EmberConfig } from '@shared/types'
import { SmoothCursor } from '../term/SmoothCursor'
import { ActivityMonitor, type ActivitySource } from './Activity'
import { Scroller } from '../term/Scroller'
import { sound } from '../motion/sound'
import { BlockTracker } from './Blocks'
import { BlockRail } from '../ui/BlockRail'
import { isLightBackground } from '../ui/tone'

/**
 * The grid's background: the theme's own colour at zero alpha, never plain transparent.
 *
 * The window paints the ground, so the grid stays see-through either way, but xterm reads
 * this colour for three things that need the real one: the contrast floor below measures
 * text against it, an OSC 11 query reports it (Claude Code's `auto` theme picks light or
 * dark from that answer), and the WebGL renderer fills a rectangle in it behind every dim,
 * italic or underlined cell. `rgba(0,0,0,0)` made that rectangle black — the black boxes
 * behind Claude's dimmed text on a light theme. The renderer is also patched to honour
 * the alpha (electron.vite.config.ts), so the rectangle is not drawn at all.
 */
function clearGround(background: string): string {
  return /^#[0-9a-f]{6}$/i.test(background) ? `${background}00` : 'rgba(0, 0, 0, 0)'
}

/**
 * Light palettes get xterm's contrast correction; dark ones keep their exact colours.
 * Programs pick colours for a dark terminal — Claude Code's default theme writes pure
 * white and mid-greys in 24-bit — and on paper those are nothing. 4.5 is WCAG AA; dim
 * text is held to half of it, so it still reads as dim.
 */
function contrastFloor(background: string): number {
  return isLightBackground(background) ? 4.5 : 1
}

let seq = 0

export interface SessionEvents {
  onTitle: (session: Session, title: string) => void
  onExit: (session: Session) => void
  /** Return true to claim the keystrokes (used for broadcast-to-all-panes). */
  onInput?: (session: Session, data: string) => boolean
}

/**
 * One tab: an xterm instance, its pty, and its caret.
 *
 * The element stays mounted for the lifetime of the session even while another tab
 * is showing. Tearing down and rebuilding a WebGL terminal on every tab switch is
 * both slow and visually impossible to animate — keeping them all alive is what lets
 * the switch be a real crossfade rather than a swap.
 */
export class Session implements ActivitySource {
  readonly id = `s${++seq}`
  readonly el: HTMLElement
  readonly term: Terminal
  readonly profile: ShellProfile
  readonly activity: ActivityMonitor


  private readonly fit = new FitAddon()
  private cursor: SmoothCursor | null = null
  private webgl: WebglAddon | null = null
  private ro: ResizeObserver | null = null
  private resizeTimer: number | null = null
  private lastSize = { cols: 0, rows: 0 }
  private disposed = false

  title: string
  pid = 0
  exited = false
  /** Diagnostics only — surfaced via window.__ember for smoke tests and support. */
  bytesIn = 0
  /** BEL count: the conventional "I need you" signal from a CLI. */
  bells = 0
  /** Last raw title the shell reported, before prettifying. */
  rawTitle = ''
  /** The agent CLI the shell said it started, until the prompt returns. */
  announcedAgent: string | null = null
  lastOutputAt = 0
  /** When the person last typed, so an echo is never held back by the frame budget. */
  private lastInputAt = 0
  /** Output waiting for the next budgeted frame, and the timer that will flush it. */
  private outPending: string[] = []
  private outTimer: number | null = null
  private lastFlushAt = 0
  /** True while output is arriving continuously with nobody typing: the caret snaps, the budget applies. */
  streaming = false

  /** Working directory, learned from OSC 7 / OSC 9;9 when the shell reports it. */
  cwd = ''
  /** Directory to spawn in. Set before start() to restore or open a project. */
  initialCwd = ''
  /**
   * The tab this pane belongs to. Set before start(), and only meaningful in the v2
   * experience — it is what a Claude session started in this shell uses to address the
   * right panel.
   */
  tabId = ''
  /** Absolute buffer row where the last submitted command's output begins. */
  private markRow = -1
  /** True between pressing Enter and the command going quiet. */
  private running = false
  /** Red SGR seen while the current command ran — the fallback failure signal. */
  private sawError = false
  /** Exit code reported by the shell via OSC 133;D, or null when unavailable. */
  private pendingExit: number | null = null
  /** Printable keystrokes since the last Enter, used to name the command block. */
  private typedSinceEnter = ''
  /** 'ok' | 'fail' for the command that just finished, consumed by the mascot. */
  outcome: 'ok' | 'fail' | null = null
  outcomeAt = 0
  /** When the current burst of work started, for the "Working · 12s" label. */
  workingSince = 0

  private readonly search = new SearchAddon()
  private readonly serialize = new SerializeAddon()
  private scroller: Scroller | null = null
  readonly blocks: BlockTracker
  private rail: BlockRail | null = null

  /** Dev-server URLs seen in this session's output, most recent last. */
  readonly urls: string[] = []
  /** Port from the most recent EADDRINUSE, for the rescue action. */
  busyPort = 0
  /** Characters produced since this session was last looked at. */
  unread = 0

  constructor(
    private readonly config: EmberConfig,
    profile: ShellProfile,
    private readonly events: SessionEvents,
  ) {
    this.profile = profile
    this.title = profile.name

    this.el = document.createElement('div')
    this.el.className = 'ember-pane'
    this.el.dataset['sessionId'] = this.id

    const { font, theme, window: win } = config
    this.term = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      // OSC 8 hyperlinks — the ones Claude Code prints for PRs and files. xterm's own
      // handler shows a "could be dangerous" confirm, opens a blank window and then sets
      // its address, so main's window-open hook sees "about:blank" and refuses it and
      // nothing opens. Hand the real URI to window.open, the path plain URLs already
      // take (see the web-links addon below); main lets http(s) out to the browser.
      linkHandler: { activate: (_e, uri) => void window.open(uri, '_blank') },
      fontFamily: font.family,
      fontSize: font.size,
      fontWeight: String(font.weight) as never,
      fontWeightBold: '600' as never,
      lineHeight: font.lineHeight,
      letterSpacing: font.letterSpacing,
      scrollback: config.scrollback,
      cursorBlink: false,
      // Our canvas layer draws the caret; xterm's own must not paint at all.
      cursorInactiveStyle: 'none',
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: contrastFloor(theme.background),
      theme: {
        background: clearGround(theme.background),
        foreground: theme.foreground,
        cursor: 'rgba(0, 0, 0, 0)',
        cursorAccent: 'rgba(0, 0, 0, 0)',
        selectionBackground: theme.selectionBackground,
        black: theme.black,
        red: theme.red,
        green: theme.green,
        yellow: theme.yellow,
        blue: theme.blue,
        magenta: theme.magenta,
        cyan: theme.cyan,
        white: theme.white,
        brightBlack: theme.brightBlack,
        brightRed: theme.brightRed,
        brightGreen: theme.brightGreen,
        brightYellow: theme.brightYellow,
        brightBlue: theme.brightBlue,
        brightMagenta: theme.brightMagenta,
        brightCyan: theme.brightCyan,
        brightWhite: theme.brightWhite,
      },
    })

    // Padding goes on `.xterm`, never on this pane.
    //
    // FitAddon derives rows/cols from `getComputedStyle(parentElement).height`, which
    // under `box-sizing: border-box` reports the *border-box* height — padding
    // included. Padding the pane therefore made fit believe it had 34px more room
    // than it did and hand the pty two extra rows, so the grid overflowed its own
    // container and the last rows rendered off-screen. FitAddon does explicitly
    // subtract `.xterm`'s own padding, so putting it there makes the maths correct.
    this.el.style.setProperty(
      '--pane-pad',
      `${win.padding.top}px ${win.padding.right}px ${win.padding.bottom}px ${win.padding.left}px`,
    )

    this.activity = new ActivityMonitor(this)
    this.blocks = new BlockTracker(this.term)
  }

  bufferType(): 'normal' | 'alternate' {
    return this.term.buffer.active.type
  }

  visibleText(): string {
    return this.dumpViewport()
  }

  private prepared = false

  /**
   * Everything that is expensive and needs no shell: open xterm, bring up the WebGL
   * renderer (a GPU context and a glyph atlas — the 150 to 270ms that used to land in
   * the first frame of a new tab's entrance), fit, and wire the caret and handlers.
   * Idempotent, so a session prepared ahead of time as a spare costs nothing more when
   * it is finally started. `el` must be in the tree.
   */
  prepare(): void {
    if (this.prepared) return
    this.prepared = true
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
    this.term.loadAddon(this.serialize)
    // Explicit handler: the addon's default opens a blank window and then sets
    // location.href, so main's window-open hook would see "about:blank" instead of
    // the link — which Windows answers with the "find an app in the Store" dialog.
    // Passing the real URI through window.open lands it in the system browser.
    this.term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
    this.term.loadAddon(new ClipboardAddon())

    const unicode = new Unicode11Addon()
    this.term.loadAddon(unicode)
    this.term.unicode.activeVersion = '11'

    this.term.open(this.el)

    try {
      // Escape hatch for measurement: the WebGL renderer is the last thing between an
      // idle Ember and an idle machine that has not been ruled out, and ruling it out
      // means running without it. Read from the URL because a probe can set that
      // without touching config on disk.
      if (new URLSearchParams(location.search).has('noWebgl')) throw new Error('disabled for probing')
      const webgl = new WebglAddon()
      // If the GPU process dies, xterm keeps working on the DOM renderer. Dropping
      // the addon rather than letting it throw keeps the tab usable.
      webgl.onContextLoss(() => {
        webgl.dispose()
        this.webgl = null
      })
      this.term.loadAddon(webgl)
      this.webgl = webgl
    } catch (err) {
      console.warn('[ember] WebGL renderer unavailable, falling back to DOM', err)
    }

    this.fit.fit()

    const screen = this.el.querySelector<HTMLElement>('.xterm-screen')
    if (screen) {
      this.cursor = new SmoothCursor(this.term, screen, this.config.cursor, this.profile.accent ?? this.config.theme.cursor)
    }

    const viewport = this.el.querySelector<HTMLElement>('.xterm-viewport')
    if (screen && viewport) {
      this.scroller = new Scroller(this.term, viewport, screen, this.config.scroll, this.config.effects)
    }

    this.rail = new BlockRail(this.el, this.term, this.blocks, (b) => this.jumpToRow(b.markRow))

    // Keystrokes go straight to the pty. Nothing in the animation layer sits on this
    // path — the caret is decoration drawn after the fact, never a gate on input.
    // Shells that emit a cwd sequence let us restore the right directory later.
    // OSC 7 carries a file:// URL; OSC 9;9 is the Windows Terminal convention.
    this.term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*\/(.+)$/.exec(data)
      if (m?.[1]) this.cwd = decodeURIComponent(m[1]).replace(/\//g, '\\')
      return false
    })
    // OSC 133;D;<code> — the shell reporting the exit status of what just ran. This
    // is authoritative, unlike inferring failure from red output.
    this.term.parser.registerOscHandler(133, (data) => {
      const m = /^D;(-?\d+)/.exec(data)
      if (m?.[1] !== undefined) {
        this.pendingExit = Number(m[1])
        // The prompt is back, so whatever agent the shim started has exited.
        this.announcedAgent = null
      }
      // Ember's shims name the agent CLI they are about to run (otherAgentShims). A title
      // would do, except that an npm .cmd wrapper resets the console title as it starts.
      const a = /^E;ember-agent=([a-z-]+)/.exec(data)
      if (a?.[1]) this.announcedAgent = a[1]
      return false
    })
    this.term.parser.registerOscHandler(9, (data) => {
      const m = /^9;(.+)$/.exec(data)
      if (m?.[1]) this.cwd = m[1].replace(/^"|"$/g, '')
      return false
    })

    this.term.onData((data) => {
      this.lastInputAt = performance.now()
      // Watching the user's own Enter is what makes "copy last output" work without
      // shell integration: we know exactly which row the output starts on.
      // Text and its Enter often arrive in the same chunk (any paste does this), so
      // split at the newline rather than treating the whole chunk as one or the
      // other — otherwise the command text is dropped exactly when we need it.
      const enterAt = data.indexOf('\r')
      if (enterAt >= 0) {
        this.typedSinceEnter += Session.sanitizeTyped(data.slice(0, enterAt))
        // A second Enter means the previous command's prompt already came back, so
        // finalise it rather than orphaning it as permanently "running".
        if (this.running) this.settleCommand()
        const buf = this.term.buffer.active
        this.markRow = buf.baseY + buf.cursorY
        this.running = true
        this.sawError = false
        this.workingSince = performance.now()
        this.cursor?.submit()
        this.blocks.begin(this.markRow, this.typedSinceEnter.trim())
        this.typedSinceEnter = Session.sanitizeTyped(data.slice(enterAt + 1))
      } else {
        this.typedSinceEnter += Session.sanitizeTyped(data)
        if (this.typedSinceEnter.length > 4096) this.typedSinceEnter = this.typedSinceEnter.slice(-4096)
      }
      if (!this.events.onInput?.(this, data)) window.ember.write(this.id, data)
      this.cursor?.wake()
    })
    this.term.onBinary((data) => {
      window.ember.write(this.id, data)
    })
    this.term.onTitleChange((title) => {
      this.rawTitle = title
      const pretty = this.prettyTitle(title)
      if (pretty === null || pretty === this.title) return
      this.title = pretty
      this.events.onTitle(this, this.title)
    })
    this.term.onResize(() => this.cursor?.snap())
    this.term.onRender(() => {
      this.cursor?.wake()
      this.scroller?.noteRender()
      this.blocks.refreshOpenCommand()
      this.rail?.update()
    })
    this.term.onScroll(() => this.rail?.update())
    this.term.onScroll(() => this.cursor?.wake())

    this.suppressBuiltInCursor()
  }

  /** Mount into the DOM and start the shell. Must be called after `el` is in the tree. */
  async start(): Promise<void> {
    this.prepare()
    // A spare was fitted to the holding pen; fit to the slot it actually landed in.
    try {
      this.fit.fit()
    } catch {
      /* not laid out yet; the resize observer will */
    }
    const { cols, rows } = this.term
    this.lastSize = { cols, rows }
    const result = await window.ember.spawn({
      sessionId: this.id,
      profileId: this.profile.id,
      cols,
      rows,
      ...(this.initialCwd ? { cwd: this.initialCwd } : {}),
      ...(this.tabId ? { tabId: this.tabId } : {}),
    })
    if (this.initialCwd) this.cwd = this.initialCwd
    this.pid = result.pid

    this.ro = new ResizeObserver(() => this.scheduleFit())
    this.ro.observe(this.el)
  }

  /** A fit the observer asked for while motion had them held. */
  get owesFit(): boolean {
    return this.fitOwed
  }

  /** Called by SessionManager when the pty for this id produces output. */
  write(data: string): void {
    if (this.disposed) return
    this.bytesIn += data.length
    this.lastOutputAt = performance.now()
    // indexOf is a native scan; the hand-rolled charCodeAt loop this replaces walked
    // every byte of every chunk in JS, and the overwhelming majority of chunks contain
    // no BEL at all. Same answer, and it stops showing up in a profile.
    for (let i = data.indexOf('\x07'); i !== -1; i = data.indexOf('\x07', i + 1)) this.bells++
    // Red foreground while a command runs is the most reliable failure signal
    // available without shell integration: PowerShell paints its errors red.
    if (this.running && !this.sawError && Session.hasRedForeground(data)) this.sawError = true
    this.scroller?.noteOutput(data.length)
    this.unread += data.length
    this.scanOutput(data)
    this.enqueue(data)
  }

  /**
   * The frame budget. Every chunk used to go straight to xterm, and xterm draws a frame
   * per chunk: a status line ticking 30 times a second cost 30 full-window frames a
   * second — ~80% of a core in the compositor and GPU process. Output that arrives
   * continuously while nobody is typing is now parsed as it comes but *shown* at most
   * STREAM_FPS times a second, which is what Windows Terminal does. An echoed keystroke,
   * or the first chunk after a pause, still goes through immediately, so latency where it
   * is felt is untouched.
   */
  private static readonly STREAM_FPS = 15
  private static readonly INPUT_GRACE_MS = 500
  private static readonly STREAM_GAP_MS = 150

  private enqueue(data: string): void {
    const now = performance.now()
    const typing = now - this.lastInputAt < Session.INPUT_GRACE_MS
    const afterPause = now - this.lastFlushAt > Session.STREAM_GAP_MS && this.outTimer === null
    if (typing || afterPause) {
      this.flushOut(data, false)
      return
    }
    this.outPending.push(data)
    if (this.outTimer === null) {
      const due = Math.max(0, this.lastFlushAt + 1000 / Session.STREAM_FPS - now)
      this.outTimer = window.setTimeout(() => {
        this.outTimer = null
        this.flushOut('', true)
      }, due)
    }
  }

  private flushOut(extra: string, streaming: boolean): void {
    if (this.outTimer !== null) {
      window.clearTimeout(this.outTimer)
      this.outTimer = null
    }
    const data = this.outPending.length ? this.outPending.join('') + extra : extra
    this.outPending.length = 0
    if (!data) return
    this.lastFlushAt = performance.now()
    this.streaming = streaming
    const n = data.length
    // Ack only once xterm has actually parsed the chunk, so backpressure reflects
    // real render progress rather than how fast IPC can deliver bytes.
    this.term.write(data, () => {
      window.ember.ack(this.id, n)
      // While output streams the caret jumps to where the shell put it instead of
      // springing there: a moving target every frame kept the caret's own canvas
      // redrawing at the display rate on top of xterm's frames.
      if (streaming) this.cursor?.settleNow()
      else this.cursor?.wake()
    })
  }

  markExited(code: number): void {
    this.exited = true
    this.term.write(`\r\n\x1b[38;5;240m[process exited with code ${code}]\x1b[0m\r\n`)
    this.events.onExit(this)
  }

  /**
   * While anything on the stage is in motion, no pane refits.
   *
   * A refit is the heaviest thing a pane does — xterm re-renders every row and the pty is
   * resized — and the resize observer fires it 40ms into a slide, which put a 60 to 100ms
   * frame in the middle of every panel and column animation. Held, the observer's call is
   * remembered and made good the moment motion stops, when nobody is watching a frame.
   */
  static frozen = false
  private fitOwed = false

  private scheduleFit(): void {
    if (Session.frozen) {
      this.fitOwed = true
      return
    }
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    // Debounce: dragging a window edge fires this continuously, and every ConPTY
    // resize makes the shell redraw its prompt.
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null
      this.applyFit()
    }, 40)
  }

  /** Config that arrived while the pane was parked, to apply once it has a size again. */
  private pendingConfig: EmberConfig | null = null

  applyFit(): void {
    this.fitOwed = false
    if (this.disposed || this.el.clientWidth === 0 || this.el.clientHeight === 0) return
    if (this.pendingConfig) {
      const cfg = this.pendingConfig
      this.pendingConfig = null
      this.applyConfig(cfg)
      return
    }
    try {
      this.fit.fit()
    } catch {
      return
    }
    const { cols, rows } = this.term
    if (cols === this.lastSize.cols && rows === this.lastSize.rows) return
    this.lastSize = { cols, rows }
    window.ember.resize(this.id, cols, rows)
    this.cursor?.snap()
    if (this.cursor) this.scroller?.setCellHeight(this.cursor.cellSize.h)
  }

  /**
   * Redraw every row, whether or not xterm thinks it is damaged.
   *
   * The WebGL renderer only draws when something is damaged, and its context is created
   * with `preserveDrawingBuffer: false` — the addon's default, which we take. That
   * combination means the pixels a switched-to pane is showing are pixels nobody has
   * drawn since the last composite, and after a composite the contents of that buffer
   * are formally undefined. Usually they survive. When they do not you get the newest
   * output over the wreckage of the old, two screens legible at once, exactly as
   * reported. Anything that damages every row — a scroll, a resize — puts it right,
   * which is why it looked like it was fixing itself.
   *
   * Damaging every row forces a complete draw, so the frames either side of a switch
   * are ones this app painted rather than ones it hoped were still there.
   *
   * Measured, so it is not re-derived: xterm's intersection observer is *not* the
   * mechanism. It pauses rendering and drops damage while paused, but a pane parked at
   * -60% still intersects the viewport, so it never pauses — scripts/probe-switch-repaint.mjs
   * watches a backgrounded canvas keep changing.
   */
  repaint(): void {
    if (this.disposed || this.term.rows < 1) return
    this.term.refresh(0, this.term.rows - 1)
  }

  /**
   * ConPTY reports the console title, which for PowerShell is the full executable
   * path (and "Administrator: " when elevated). That is useless in a 200px tab, so
   * fall back to the profile name unless the shell set something meaningful — which
   * is what makes `$Host.UI.RawUI.WindowTitle = 'deploy'` show up as the tab label.
   */
  private prettyTitle(raw: string): string | null {
    const title = raw.replace(/^Administrator:\s*/i, '').trim()
    // null means "this title carries no information, keep what we had".
    //
    // ConPTY resets the console title to the executable path at various points during
    // a session, not just at startup. Falling back to the profile name on those made
    // a correct card title flip back to "PowerShell 7" at random moments — which is
    // exactly the intermittency that looked like the rename not sticking.
    if (!title) return null
    if (/[\\/]/.test(title) && /\.exe$/i.test(title)) return null
    return title
  }

  /**
   * Stop xterm painting its own caret, so ours is the only one on screen.
   *
   * There is no `cursorStyle: 'none'`, and the WebGL renderer discards alpha on
   * `theme.cursor` — a fully transparent colour comes out as an opaque black block
   * (verified with scripts/probe-cursor.mjs). What *is* supported is
   * `cursorInactiveStyle: 'none'`, which applies whenever xterm believes it is not
   * focused. So we let the textarea keep real DOM focus — keystrokes, IME and
   * clipboard all keep working normally — and hand xterm a synthetic blur so its
   * renderer takes the inactive path and draws nothing.
   *
   * Cost: xterm will not report focus in/out to the shell (DEC mode 1004). No
   * PowerShell tooling uses that, and the trade is a caret we fully control.
   */
  private suppressBuiltInCursor(): void {
    const textarea = this.term.textarea
    if (!textarea) return

    this.term.options.cursorInactiveStyle = 'none'

    const deceive = () => textarea.dispatchEvent(new FocusEvent('blur'))
    textarea.addEventListener('focus', () => {
      this.cursor?.setFocused(true)
      this.cursor?.wake()
      // After xterm's own focus handler has run, not before.
      queueMicrotask(deceive)
    })
    // Real focus loss is observed on the document, since the textarea's own blur
    // event is now ambiguous (we fire it ourselves).
    document.addEventListener('focusin', () => {
      const mine = document.activeElement === textarea
      this.cursor?.setFocused(mine)
      if (mine) this.cursor?.wake()
    })
    window.addEventListener('blur', () => this.cursor?.setFocused(false))
    window.addEventListener('focus', () => this.cursor?.setFocused(document.activeElement === textarea))

    if (document.activeElement === textarea) {
      this.cursor?.setFocused(true)
      queueMicrotask(deceive)
    }
  }

  /**
   * Called when output has gone quiet: settles the outcome of the command that was
   * running, which the mascot reacts to.
   */
  settleCommand(): void {
    if (!this.running) return
    this.running = false
    // Prefer the shell's own exit status; fall back to the red-output heuristic when
    // shell integration is off or the shell does not report one (cmd.exe).
    // The red-output heuristic is meaningless inside Claude Code: it paints diffs,
    // warnings and the errors it is busy fixing in red all turn long, so every turn
    // ended in a failure shudder and a chime. A Claude turn that ends is just done.
    const isClaude = this.activity.current.isClaude
    this.outcome =
      this.pendingExit !== null
        ? this.pendingExit === 0
          ? 'ok'
          : 'fail'
        : this.sawError && !isClaude
          ? 'fail'
          : 'ok'
    this.pendingExit = null
    this.outcomeAt = performance.now()
    this.blocks.end(this.outcome, this.promptHeight())
    // A finished command is not serving anything, so its URLs stop being useful. A
    // real dev server never reaches here — it keeps the command running.
    this.urls.length = 0
    this.busyPort = this.outcome === 'fail' ? this.busyPort : 0
    // Only failures make a sound, and only for commands slow enough that you had time
    // to look away. A chime on every successful Enter is noise, not information.
    if (this.outcome === 'fail' && performance.now() - this.workingSince > 1200) sound.play('failure')
  }

  /**
   * Does this chunk set a red foreground anywhere?
   *
   * Errors are the one thing shells reliably colour, but they do not agree on how:
   * PowerShell 7 defaults to bright red (91), `$PSStyle` can be set to 256-colour or
   * truecolour, and tools bring their own palettes. Matching only 31/91 missed most
   * real failures, so every SGR is parsed and any red-dominant foreground counts.
   */
  /**
   * Keep only the printable part of keystrokes.
   *
   * Escape sequences here are navigation (arrows, history recall), not text — and
   * xterm also sends unprompted replies such as the Device Attributes response
   * `ESC [ ?1;2c`, which was otherwise captured as if it were a typed command.
   */
  private static sanitizeTyped(s: string): string {
    return s
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-_]?/g, '')
      .replace(/[\x00-\x1f\x7f]/g, '')
  }

  private static hasRedForeground(data: string): boolean {
    // matchAll allocates a match object per SGR sequence, and output that carries no
    // escape at all is common enough to be worth the early out.
    if (!data.includes('\x1b[')) return false
    for (const m of data.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const parts = (m[1] ?? '').split(';').map(Number)
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        if (p === 31 || p === 91) return true
        if (p === 38 && parts[i + 1] === 5) {
          // 256-colour: the red ramp plus the two red-ish system slots.
          const n = parts[i + 2] ?? -1
          if (n === 1 || n === 9 || (n >= 196 && n <= 224 && (n - 196) % 36 < 6)) return true
          i += 2
        } else if (p === 38 && parts[i + 1] === 2) {
          const [r, g, b] = [parts[i + 2] ?? 0, parts[i + 3] ?? 0, parts[i + 4] ?? 0]
          if (r > 140 && g < r * 0.6 && b < r * 0.6) return true
          i += 4
        }
      }
    }
    return false
  }

  /**
   * Watch output for two things worth acting on: a dev server announcing its URL, and
   * a port collision. Both are pure string matches on the stream, so they cost
   * nothing and work for any tool that prints in the conventional shape.
   */
  private scanOutput(data: string): void {
    // Two native substring probes before any of the work below. This runs on every chunk
    // the pty produces — hundreds a second while a model streams — and almost none of
    // them contain a URL or a port complaint. Without the guards, each one paid for a
    // regex split of the whole chunk plus two regex tests per line; with them, the
    // common case is two indexOf calls that fail.
    const mayHaveUrl = data.includes('http')
    const mayHavePortClash = data.includes('use') || data.includes('USE')
    if (!mayHaveUrl && !mayHavePortClash) return

    // A localhost URL only means "dev server" under three conditions, all of which
    // matter: it has to arrive while a command is actually running (a URL printed at
    // an idle prompt is not serving anything), the line has to read like a server
    // announcing itself, and it must not be an MCP/agent endpoint — those are how a
    // fresh Claude session was wrongly showing a :3001 chip with no project open.
    if (this.running && mayHaveUrl) {
      for (const line of data.split(/\r?\n/)) {
        if (/\bmcp\b|agentlink|websocket|ws:\/\//i.test(line)) continue
        if (!/local|network|listening|running at|ready in|ready on|server|preview|serving|available|➜|→/i.test(line)) continue
        for (const m of line.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/gi)) {
          const found = m[0].replace(/[).,'"\]]+$/, '').replace('0.0.0.0', 'localhost')
          if (this.urls.includes(found)) continue
          this.urls.push(found)
          if (this.urls.length > 3) this.urls.shift()
        }
      }
    }

    if (mayHavePortClash && /EADDRINUSE|address already in use|is already in use/i.test(data)) {
      const port = /:(\d{2,5})\b/.exec(data) ?? /port\s+(\d{2,5})/i.exec(data)
      if (port?.[1]) this.busyPort = Number(port[1])
    }
  }

  /** Explicit return to a plain interactive terminal. */
  private static readonly MODE_RESET =
    '\x1b[?1049l' + // leave the alternate screen buffer
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' + // all mouse tracking off
    '\x1b[?1004l' + // focus reporting off
    '\x1b[?2004l' + // bracketed paste off
    '\x1b[?7h' + // wrap back on
    '\x1b[?25h' // cursor visible

  /** Put a terminal left in a strange state by a crashed TUI back to normal. */
  resetModes(): void {
    this.term.write(Session.MODE_RESET)
    window.ember.write(this.id, '')
  }

  /** Called when this session becomes visible. */
  markRead(): void {
    this.unread = 0
  }

  /** Scroll so a block's command line sits at the top of the viewport. */
  jumpToRow(row: number): void {
    this.term.scrollToLine(Math.max(0, row))
    this.cursor?.wake()
  }

  /**
   * How many lines the prompt occupies, measured rather than assumed: count the
   * non-empty lines directly above the command we ran (oh-my-posh draws two). Used to
   * trim the prompt that reappears under a command's output.
   */
  private promptHeight(): number {
    const buf = this.term.buffer.active
    if (this.markRow < 0) return 0
    let n = 0
    for (let row = this.markRow - 1; row >= 0 && n < 4; row--) {
      if (!buf.getLine(row)?.translateToString(true).trim()) break
      n++
    }
    return n
  }

  /** Text produced by the last submitted command, excluding the command line itself. */
  lastOutputText(): string {
    const buf = this.term.buffer.active
    if (this.markRow < 0) return ''
    const end = buf.baseY + buf.cursorY
    const lines: string[] = []
    for (let row = this.markRow + 1; row < end; row++) {
      lines.push(buf.getLine(row)?.translateToString(true) ?? '')
    }

    for (let i = 0; i < this.promptHeight() && lines.length; i++) lines.pop()

    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
    return lines.join('\n')
  }

  findNext(query: string): boolean {
    return query ? this.search.findNext(query, { incremental: false }) : false
  }

  findPrevious(query: string): boolean {
    return query ? this.search.findPrevious(query, { incremental: false }) : false
  }

  clearSearch(): void {
    this.search.clearDecorations()
  }

  /** Hot-apply an edited config without dropping the shell. */
  applyConfig(config: EmberConfig): void {
    // xterm measures the font the moment a font option changes. A parked pane has no size,
    // so the measurement would come back as zero cells and stick until the next font
    // change — hold the config until the pane is back in layout and apply it then.
    if (this.el.clientWidth === 0 || this.el.clientHeight === 0) {
      this.pendingConfig = config
      return
    }
    const { font, theme, window: win } = config
    this.term.options.fontFamily = font.family
    this.term.options.fontSize = font.size
    this.term.options.fontWeight = String(font.weight) as never
    this.term.options.lineHeight = font.lineHeight
    this.term.options.letterSpacing = font.letterSpacing
    this.term.options.scrollback = config.scrollback
    this.term.options.minimumContrastRatio = contrastFloor(theme.background)
    this.term.options.theme = {
      background: clearGround(theme.background),
      foreground: theme.foreground,
      cursor: 'rgba(0, 0, 0, 0)',
      cursorAccent: 'rgba(0, 0, 0, 0)',
      selectionBackground: theme.selectionBackground,
      black: theme.black,
      red: theme.red,
      green: theme.green,
      yellow: theme.yellow,
      blue: theme.blue,
      magenta: theme.magenta,
      cyan: theme.cyan,
      white: theme.white,
      brightBlack: theme.brightBlack,
      brightRed: theme.brightRed,
      brightGreen: theme.brightGreen,
      brightYellow: theme.brightYellow,
      brightBlue: theme.brightBlue,
      brightMagenta: theme.brightMagenta,
      brightCyan: theme.brightCyan,
      brightWhite: theme.brightWhite,
    }
    this.el.style.setProperty(
      '--pane-pad',
      `${win.padding.top}px ${win.padding.right}px ${win.padding.bottom}px ${win.padding.left}px`,
    )
    this.cursor?.setConfig(config.cursor)
    this.cursor?.setAccent(this.profile.accent ?? theme.cursor)
    this.scroller?.setConfig(config.scroll, config.effects)
    this.applyFit()
    this.cursor?.snap()
  }

  /** Caret internals, for probe scripts. */
  cursorState(): Record<string, unknown> | null {
    return this.cursor?.debugState() ?? null
  }

  forceCursorFocus(value: boolean): void {
    this.cursor?.forceFocused(value)
  }

  /** Plain-text dump of the visible viewport, for diagnostics. */
  dumpViewport(): string {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < this.term.rows; i++) {
      lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
    }
    return lines.join('\n').replace(/\n+$/, '')
  }

  focus(): void {
    this.term.focus()
    this.cursor?.setFocused(true)
    this.cursor?.wake()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    this.ro?.disconnect()
    this.rail?.dispose()
    this.scroller?.dispose()
    this.cursor?.dispose()
    this.webgl?.dispose()
    this.term.dispose()
    window.ember.kill(this.id)
    this.el.remove()
  }
}
