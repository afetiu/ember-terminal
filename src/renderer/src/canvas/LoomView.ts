import type { CanvasAnnotate, CanvasFeed, CanvasMedia, ClaudeStatus, EmberConfig, PanelPush } from '@shared/types'
import type { Session } from '../core/Session'
import { Feed, type Todo } from './Feed'
import { escapeHtml } from './markdown'

/**
 * A Loom tab: a real shell whose output space is a canvas.
 *
 * It starts as a plain PowerShell with its prompt at the bottom of an empty space. Type
 * `claude` and the real Claude Code starts, exactly as it would in any tab — but the
 * conversation is not read off its screen. It is drawn on the canvas from the session's
 * own transcript, with replies as rich text, diagrams as diagrams, edits as diffs,
 * screenshots as pictures, and whatever the session chooses to show (pages, mockups,
 * video, a live browser it can point at) inline where it was shown.
 *
 * Nothing of the CLI is replaced. The bottom of Claude Code's own screen — its input box,
 * slash-command menu, permission prompts, pickers, the mode line — stays on screen as the
 * dock, the real thing, cropped rather than redrawn. Every key goes to the real process.
 * Whatever this view cannot place is shown whole: an unrecognised screen gives the full
 * terminal back, and Ctrl+` flips to it at any time.
 *
 * The crop is CSS on the pane — a clip and a translate — so the terminal keeps its full
 * size, its pty keeps its rows, and Claude Code lays itself out as it always does.
 */

export interface LoomHooks {
  /** Type into the session as the user; `submit` presses Enter. */
  send(text: string, submit: boolean): void
  /** Is this tab the one on screen? */
  isActive(): boolean
  /** Toast-level feedback. */
  toast(text: string): void
}

type Mode = 'shell' | 'claude' | 'app' | 'raw'

interface Dock {
  /** First and last viewport rows that stay visible. */
  top: number
  bottom: number
  /** A dialog or a menu rather than the input box: worth drawing the eye to. */
  dialog: boolean
}

interface Piece {
  el: HTMLElement
  body: HTMLElement
  title: string
  format: string
  frame?: HTMLIFrameElement
}

interface Browser {
  piece: Piece
  view: WebviewTag
  legend: HTMLElement
  ready: Promise<void>
}

/** The parts of Electron's <webview> used here; see Panel.ts for why it is declared locally. */
interface WebviewTag extends HTMLElement {
  getURL(): string
  isLoading(): boolean
  reload(): void
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
}

const RULE_CHARS = /[─━▔═╌╍┄┅┈┉]/g
/** Box junctions: a row with any of these is a table's border, not one of the TUI's rules. */
const JUNCTIONS = /[┼├┤┬┴│╭╮╰╯┌┐└┘║╔╗╚╝╞╡╪]/

export class LoomView {
  readonly el: HTMLElement
  private readonly scroller: HTMLElement
  private readonly feed: Feed
  private readonly sign: HTMLElement
  private readonly steps: HTMLElement
  private readonly live: HTMLElement
  private readonly jump: HTMLElement
  private readonly hint: HTMLElement
  private readonly pop: HTMLElement
  private readonly chip: HTMLElement
  private readonly lightbox: HTMLElement
  private readonly rawPill: HTMLElement

  private mode: Mode = 'shell'
  private raw = false
  private claudeSeen = false
  private dock: Dock | null = null
  private frameReq = 0
  private disposed = false
  private origin = ''
  private readonly frames = new Set<HTMLIFrameElement>()
  private readonly pieces = new Map<string, Piece>()
  private readonly browsers: Browser[] = []
  private expanded: Piece | null = null
  private todos: Todo[] = []
  private stepsTitle = ''
  private stepsOpen = true
  private status: ClaudeStatus | null = null
  private readonly unsubs: Array<() => void> = []

  constructor(
    private readonly tabId: string,
    private readonly panes: HTMLElement,
    private readonly session: Session,
    config: EmberConfig,
    private readonly hooks: LoomHooks
  ) {
    this.el = document.createElement('div')
    this.el.className = 'loom'
    this.el.dataset['tabId'] = tabId
    this.applyTheme(config)

    this.scroller = document.createElement('div')
    this.scroller.className = 'loom-scroll'
    this.feed = new Feed({
      send: (text, submit) => this.hooks.send(text, submit),
      localImage: async (path) => {
        const r = await window.ember.canvas.media(path)
        return 'src' in r ? r.src : null
      },
      diagram: (source) => window.ember.canvas.doc(this.tabId, 'diagram', 'mermaid', source),
      mountFrame: (host, url, min) => this.mountFrame(host, url, min),
      todos: (list) => this.setTodos(list),
      openInline: (url) => void this.openBrowser(url, url, 'open_url'),
      grew: () => this.grew(),
    })
    this.scroller.appendChild(this.feed.el)

    this.hint = div('loom-hint', `<span class="loom-hint-glyph">✻</span><span>Claude is here. Ask below — what it says and shows appears on this canvas.</span>`)
    this.sign = div('loom-sign')
    this.steps = div('loom-steps')
    this.live = div('loom-live')
    this.jump = div('loom-jump', '↓ latest')
    this.pop = div('loom-pop')
    this.chip = div('loom-chip', '? ask')
    this.lightbox = div('loom-lightbox')
    this.rawPill = div('loom-rawpill', '✻ canvas <kbd>Ctrl+`</kbd>')

    this.el.append(this.scroller, this.hint, this.sign, this.steps, this.live, this.jump, this.chip, this.pop, this.lightbox)
    panes.append(this.el, this.rawPill)
    panes.classList.add('has-loom')
    session.el.classList.add('is-loom')

    this.wire()
    this.renderSign()
    this.schedule()
    void window.ember.panel.origin().then((o) => (this.origin = o))
    void window.ember.canvas.watch(tabId)
  }

  // ================================================================ wiring

  private wire(): void {
    const term = this.session.term
    const sub = (d: { dispose(): void }) => this.unsubs.push(() => d.dispose())
    sub(term.onRender(() => this.schedule()))
    sub(term.onResize(() => this.schedule()))
    sub(term.buffer.onBufferChange(() => this.schedule()))
    sub(term.onCursorMove(() => this.schedule()))
    const ro = new ResizeObserver(() => this.schedule())
    ro.observe(this.panes)
    this.unsubs.push(() => ro.disconnect())

    this.unsubs.push(
      window.ember.canvas.onFeed((f: CanvasFeed) => {
        if (f.tabId !== this.tabId) return
        if (f.kind === 'switch') this.feed.switchSession(f.first)
        else this.feed.add(f.lines)
        this.hint.classList.toggle('is-gone', !this.feed.isEmpty)
      }),
      window.ember.canvas.onMedia((m) => {
        if (m.tabId === this.tabId) void this.showMedia(m)
      }),
      window.ember.canvas.onAnnotate((a) => {
        if (a.tabId === this.tabId) void this.annotate(a)
      }),
      window.ember.canvas.onSteps((s) => {
        if (s.tabId !== this.tabId) return
        this.stepsTitle = s.title
        this.setTodos(
          s.steps.map((x) => ({
            content: x.text,
            status: x.status === 'done' ? 'completed' : x.status === 'active' ? 'in_progress' : 'pending',
          }))
        )
      }),
      window.ember.claude.onStatus((s) => {
        if (s.tabId !== this.tabId) return
        this.status = s
        this.renderSign()
      })
    )

    const onMessage = (e: MessageEvent) => {
      const h = (e.data as { emberDocHeight?: number } | null)?.emberDocHeight
      if (typeof h !== 'number') return
      for (const f of this.frames) {
        if (f.contentWindow !== e.source) continue
        const max = Number(f.dataset['max'] ?? 2400)
        const stick = this.atBottom()
        f.style.height = `${Math.max(36, Math.min(max, Math.ceil(h)))}px`
        if (stick) this.toBottom()
      }
    }
    window.addEventListener('message', onMessage)
    this.unsubs.push(() => window.removeEventListener('message', onMessage))

    const onKey = (e: KeyboardEvent) => this.key(e)
    window.addEventListener('keydown', onKey, true)
    this.unsubs.push(() => window.removeEventListener('keydown', onKey, true))

    this.scroller.addEventListener('scroll', () => {
      if (this.atBottom()) this.jump.classList.remove('is-on')
      this.chip.classList.remove('is-on')
    })
    this.jump.addEventListener('click', () => this.toBottom(true))
    this.rawPill.addEventListener('click', () => this.setRaw(false))

    this.el.addEventListener('click', (e) => this.click(e))
    this.el.addEventListener('contextmenu', (e) => this.context(e))
    this.el.addEventListener('mouseup', (e) => this.selection(e))
    this.chip.addEventListener('mousedown', (e) => e.preventDefault())
    this.chip.addEventListener('click', () => {
      const text = (window.getSelection()?.toString() ?? '').trim()
      if (text) this.ask(this.chip.getBoundingClientRect(), 'this', text)
      this.chip.classList.remove('is-on')
    })
    this.lightbox.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.loom-lightbox-ask')) return
      this.lightbox.classList.remove('is-on')
    })
  }

  private applyTheme(config: EmberConfig): void {
    const t = config.theme
    const s = this.el.style
    s.setProperty('--l-green', t.green)
    s.setProperty('--l-red', t.red)
    s.setProperty('--l-yellow', t.yellow)
    s.setProperty('--l-blue', t.blue)
    s.setProperty('--l-magenta', t.magenta)
    s.setProperty('--l-cyan', t.cyan)
    s.setProperty('--l-font-size', `${config.font.size}px`)
  }

  // ================================================================ the dock

  private schedule(): void {
    if (this.frameReq || this.disposed) return
    this.frameReq = requestAnimationFrame(() => {
      this.frameReq = 0
      this.layout()
    })
  }

  private rowsText(): string[] {
    const buf = this.session.term.buffer.active
    const out: string[] = []
    for (let y = 0; y < this.session.term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return out
  }

  /** Is what is on the alternate screen Claude Code? Its logo, or its input box. */
  private looksLikeClaude(rows: string[]): boolean {
    if (rows.slice(0, 8).some((r) => /Claude Code v\d/.test(r))) return true
    return this.findDock(rows)?.dialog === false
  }

  /**
   * One of Claude Code's own rules: a line across the screen and nothing else, bar the
   * effort indicator that rides inside a picker's top rule. A markdown table drawn in the
   * conversation has rules too, but always with junctions in them.
   */
  private isRule(row: string): boolean {
    const cols = this.session.term.cols
    if ((row.match(RULE_CHARS)?.length ?? 0) < cols * 0.6) return false
    if (JUNCTIONS.test(row)) return false
    return row.replace(RULE_CHARS, '').trim().length <= 40
  }

  /**
   * Which rows of Claude Code's screen are the part you work with.
   *
   * Measured against 2.1's full-screen layout (scripts/probe-loom-screens): the input box
   * is a rule, the `❯` line(s), a rule, and the mode line under it; the slash menu and
   * the effort indicator sit directly above the first rule. A permission prompt replaces
   * all of that with a rule followed by the dialog. A picker (/model) starts at a rule of
   * `▔`. Anything else is not recognised, and the caller shows the whole screen.
   */
  private findDock(rows: string[]): Dock | null {
    const rules: number[] = []
    for (let y = 1; y < rows.length; y++) if (this.isRule(rows[y]!)) rules.push(y)
    if (!rules.length) return null
    let last = rows.length - 1
    while (last > 0 && !rows[last]!.trim()) last--
    const low = rules[rules.length - 1]!

    // The input box: a rule, the `❯` line directly under it, its continuation lines,
    // and the closing rule. The prompt echoes in the conversation start with `❯` too,
    // but never directly under a rule.
    let top = low
    let dialog = true
    const prev = rules.length > 1 ? rules[rules.length - 2]! : -1
    if (prev >= 0 && low - prev <= 18 && /^\s?❯/.test(rows[prev + 1] ?? '')) {
      top = prev
      dialog = false
    }
    if (dialog && /^\s*❯/.test(rows[low + 1] ?? '') && last - low <= 3) {
      // A single rule with the prompt under it: an input box whose top rule scrolled off.
      dialog = false
    }
    if (dialog) {
      // The `❯` line directly above the lowest rule, with no rule between: the input box,
      // its top rule not recognised (drawn differently, or not there). A dialog's own `❯`
      // marks its choices, under its rule, never above it. Without this the dock would
      // be cropped to the bottom rule and the prompt line hidden.
      for (let y = low - 1; y > 3 && low - y <= 18 && rows[y]!.trim(); y--) {
        if (!/^\s?❯/.test(rows[y]!)) continue
        top = (rows[y - 1]!.match(RULE_CHARS)?.length ?? 0) >= 8 ? y - 1 : y
        dialog = false
        break
      }
    }
    // What hangs off the top of the input box: the slash and @ menus, the effort line.
    if (!dialog) {
      let n = 0
      while (top - 1 > 3 && n < 16) {
        const r = rows[top - 1]!
        if (!r.trim()) break
        const attached = /^\s{2}[/@#]\S/.test(r) || /^\s{2}\S.*\S\s{3,}\S/.test(r) || /^\s{24,}\S/.test(r)
        if (!attached) break
        top--
        n++
      }
    }
    return { top, bottom: Math.max(last, low), dialog }
  }

  private layout(): void {
    if (this.disposed) return
    const term = this.session.term
    const buf = term.buffer.active
    const pane = this.session.el
    const screen = pane.querySelector<HTMLElement>('.xterm-screen')
    const paneH = pane.clientHeight
    if (!screen || !paneH || !term.rows) return
    const sr = screen.getBoundingClientRect()
    const pr = pane.getBoundingClientRect()
    const cellH = sr.height / term.rows
    const screenTop = sr.top - pr.top
    const rows = this.rowsText()

    let mode: Mode
    if (buf.type === 'alternate') {
      if (!this.claudeSeen && this.looksLikeClaude(rows)) this.claudeSeen = true
      mode = this.claudeSeen ? 'claude' : 'app'
    } else {
      this.claudeSeen = false
      mode = 'shell'
    }
    if (this.raw && mode === 'claude') mode = 'raw'
    if (mode !== 'raw' && this.raw && mode !== 'claude') this.raw = false

    let ty = 0
    let clip = 0
    let canvasH = 0
    let dock: Dock | null = null
    const gap = 4

    if (mode === 'shell') {
      // Bottom-anchored: until the screen fills, the prompt sits at the bottom of the
      // space and the output grows upward into it, the way a conversation does.
      if (buf.baseY === 0 && buf.viewportY === 0) {
        let lastRow = buf.cursorY
        for (let y = rows.length - 1; y > lastRow; y--) {
          if (rows[y]!.trim()) {
            lastRow = y
            break
          }
        }
        ty = Math.max(0, paneH - gap - (screenTop + (lastRow + 1) * cellH))
      }
    } else if (mode === 'claude') {
      dock = this.findDock(rows)
      if (dock) {
        const topPx = screenTop + dock.top * cellH
        const bottomPx = screenTop + (dock.bottom + 1) * cellH
        ty = Math.max(0, paneH - gap - bottomPx)
        clip = Math.max(0, topPx - 3)
        canvasH = Math.max(0, clip + ty)
      } else {
        // Not a screen we know: show all of it. Nothing of the CLI is ever hidden by guessing.
        mode = 'app'
      }
    }

    const showCanvas = mode === 'claude'
    if (mode !== this.mode) {
      this.mode = mode
      this.el.classList.toggle('is-on', showCanvas)
      this.rawPill.classList.toggle('is-on', mode === 'raw')
      this.panes.dataset['loom'] = mode
      if (showCanvas) this.toBottom()
      this.renderSign()
      // The pane just moved under a new transform and clip. The WebGL drawing buffer is
      // not preserved across composites (see Session.repaint), so draw every row afresh
      // rather than trusting what was there.
      requestAnimationFrame(() => this.session.repaint())
    }
    pane.style.transform = ty ? `translate3d(0, ${ty.toFixed(1)}px, 0)` : ''
    pane.style.clipPath = clip ? `inset(${clip.toFixed(1)}px 0 0 0)` : ''
    if (showCanvas) {
      const stick = this.atBottom()
      this.el.style.height = `${canvasH.toFixed(1)}px`
      if (stick) this.toBottom()
    }
    this.el.classList.toggle('is-dialog', !!dock?.dialog)
    this.dock = dock
    if (showCanvas) this.readLive(rows, dock)
  }

  /**
   * Claude Code's own spinner line — "✶ Pondering… (12s · esc to interrupt)" — mirrored
   * at the foot of the canvas. The transcript only grows when a block is complete; this is
   * what says the session is alive in between.
   */
  private readLive(rows: string[], dock: Dock | null): void {
    // Mid-turn, Claude Code keeps a spinner row just above its input box: one verb and an
    // ellipsis, then the details — "✢ Whisking… (4s · ↓ 88 tokens · thinking)". Finished,
    // the same row reads "✻ Churned for 3s · done 4:17 PM", with no ellipsis. The mode
    // line's "esc to interrupt" would say the same, but Ember's status line takes its place.
    let found = ''
    const end = dock ? dock.top : rows.length
    for (let y = end - 1; y >= 0 && y >= end - 16; y--) {
      const r = rows[y]!.trim()
      if (/^\S\s+[A-Z][a-z]+(?:-[a-z]+)?…(?:\s|$)/.test(r)) {
        found = r
        break
      }
    }
    if (!found && dock && rows.slice(dock.top, dock.bottom + 1).some((r) => /esc to interrupt/i.test(r))) found = '· working…'
    this.working = !!found
    if (found) {
      const glyph = found.slice(0, 1)
      const rest = found.slice(1).trim()
      this.live.innerHTML = `<span class="loom-live-glyph">${escapeHtml(glyph)}</span><span>${escapeHtml(rest)}</span>`
    }
    this.live.classList.toggle('is-on', !!found)
  }

  /** Claude Code says it is mid-turn. */
  private working = false

  /** Ctrl+`: the real TUI, whole, or back to the canvas. */
  setRaw(on: boolean): void {
    this.raw = on
    this.schedule()
    if (!on) this.session.focus()
  }

  // ================================================================ keys and pointer

  private key(e: KeyboardEvent): void {
    if (this.disposed || !this.hooks.isActive()) return
    const inLoomInput = (e.target as HTMLElement | null)?.closest?.('.loom-pop') != null
    if (e.ctrlKey && !e.altKey && e.code === 'Backquote') {
      if (this.mode === 'claude' || this.mode === 'raw') {
        e.preventDefault()
        e.stopPropagation()
        this.setRaw(!this.raw)
      }
      return
    }
    if (this.mode !== 'claude') return
    if (e.key === 'Escape') {
      // Esc is Claude Code's interrupt. Only take it when something of ours is open.
      if (this.closeOverlays()) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (inLoomInput) return
    if ((e.key === 'PageUp' || e.key === 'PageDown') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      this.scroller.scrollBy({ top: (e.key === 'PageUp' ? -1 : 1) * this.scroller.clientHeight * 0.85, behavior: 'smooth' })
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Home') this.scroller.scrollTo({ top: 0, behavior: 'smooth' })
      else this.toBottom(true)
      return
    }
    // Typing anywhere on the canvas types into the prompt.
    const target = e.target as HTMLElement | null
    if (target && this.el.contains(target) && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.session.focus()
    }
  }

  private closeOverlays(): boolean {
    if (this.lightbox.classList.contains('is-on')) {
      this.lightbox.classList.remove('is-on')
      return true
    }
    if (this.pop.classList.contains('is-on')) {
      this.closeAsk()
      return true
    }
    if (this.expanded) {
      this.expand(this.expanded, false)
      return true
    }
    return false
  }

  private click(e: MouseEvent): void {
    const t = e.target as HTMLElement
    const act = t.closest<HTMLElement>('.loom-act')
    if (act) {
      e.preventDefault()
      this.hooks.send(act.dataset['send'] ?? act.textContent ?? '', act.dataset['submit'] !== '0')
      act.classList.add('is-pressed')
      return
    }
    const link = t.closest<HTMLAnchorElement>('a.loom-link')
    if (link) {
      e.preventDefault()
      const href = link.getAttribute('href') ?? ''
      // A local server is something to look at here; anything else is the browser's.
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(href) && !e.ctrlKey) void this.openBrowser(href, href, 'open_url')
      else window.open(href, '_blank')
      return
    }
    const copy = t.closest<HTMLElement>('.loom-copy')
    if (copy) {
      const code = copy.closest('.loom-code')?.querySelector('code')?.textContent ?? ''
      void navigator.clipboard.writeText(code).then(() => {
        copy.textContent = 'copied'
        window.setTimeout(() => (copy.textContent = 'copy'), 1200)
      })
      return
    }
    const img = t.closest<HTMLImageElement>('img[data-zoom]')
    if (img && img.src) {
      this.zoom(img.src, img.alt)
      return
    }
    // A click that selected nothing hands the keyboard back to the prompt.
    const interactive = t.closest('button, a, input, textarea, iframe, webview, video, audio, summary, .loom-pop, .loom-steps')
    if (!interactive && !(window.getSelection()?.toString() ?? '').trim()) this.session.focus()
  }

  /** Right-click anything with a picture, a diagram or a piece in it: ask about that. */
  private context(e: MouseEvent): void {
    const t = e.target as HTMLElement
    const host = t.closest<HTMLElement>('[data-ask-label], .loom-piece, .loom-figure, .loom-code, .loom-table, .loom-tool')
    if (!host) return
    e.preventDefault()
    const label =
      host.dataset['askLabel'] ??
      (host.classList.contains('loom-piece')
        ? `the "${host.dataset['title'] ?? 'piece'}"`
        : host.classList.contains('loom-code')
          ? 'this code'
          : host.classList.contains('loom-table')
            ? 'this table'
            : host.classList.contains('loom-tool')
              ? `this step (${(host.querySelector('.loom-tool-name')?.textContent ?? '').trim()} ${(host.querySelector('.loom-tool-arg')?.textContent ?? '').trim()})`
              : 'this')
    const quote = host.classList.contains('loom-code') || host.classList.contains('loom-table') ? (host.innerText ?? '').slice(0, 500) : undefined
    this.ask(new DOMRect(e.clientX, e.clientY, 0, 0), label, quote)
  }

  private selection(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.loom-pop, .loom-chip')) return
    window.setTimeout(() => {
      const sel = window.getSelection()
      const text = (sel?.toString() ?? '').trim()
      if (!sel || text.length < 2 || !sel.rangeCount || !this.scroller.contains(sel.anchorNode)) {
        this.chip.classList.remove('is-on')
        return
      }
      const r = sel.getRangeAt(0).getBoundingClientRect()
      const host = this.el.getBoundingClientRect()
      this.chip.style.left = `${Math.min(host.width - 80, Math.max(8, r.right - host.left - 30))}px`
      this.chip.style.top = `${Math.max(8, r.bottom - host.top + 6)}px`
      this.chip.classList.add('is-on')
    }, 0)
  }

  // ================================================================ ask about this

  private ask(at: DOMRect, about: string, quote?: string): void {
    const host = this.el.getBoundingClientRect()
    this.pop.innerHTML =
      `<div class="loom-pop-about">Ask about ${escapeHtml(about)}</div>` +
      (quote ? `<div class="loom-pop-quote">${escapeHtml(quote.length > 240 ? `${quote.slice(0, 240)}…` : quote)}</div>` : '') +
      `<textarea rows="2" placeholder="What do you want to know?" spellcheck="false"></textarea>` +
      `<div class="loom-pop-foot"><span><kbd>Enter</kbd> ask</span><span><kbd>Esc</kbd> close</span></div>`
    const box = this.pop.querySelector('textarea')!
    box.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeAsk()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const q = box.value.trim()
        if (!q) return
        const context = quote ? `About ${about} — “${quote.replace(/\s+/g, ' ').slice(0, 600)}” — ${q}` : `About ${about}: ${q}`
        this.hooks.send(context, true)
        this.closeAsk()
        this.toBottom(true)
      }
    })
    const w = 360
    this.pop.style.left = `${Math.min(host.width - w - 12, Math.max(12, at.left - host.left))}px`
    this.pop.style.top = `${Math.min(host.height - 170, Math.max(12, at.bottom - host.top + 8))}px`
    this.pop.classList.add('is-on')
    box.focus()
  }

  private closeAsk(): void {
    this.pop.classList.remove('is-on')
    this.pop.innerHTML = ''
    this.session.focus()
  }

  private zoom(src: string, alt: string): void {
    this.lightbox.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><button type="button" class="loom-lightbox-ask">? ask about this</button>`
    this.lightbox.querySelector('.loom-lightbox-ask')?.addEventListener('click', (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      this.lightbox.classList.remove('is-on')
      this.ask(r, `this image${alt ? ` (${alt})` : ''}`)
    })
    this.lightbox.classList.add('is-on')
  }

  // ================================================================ scrolling

  private atBottom(): boolean {
    const s = this.scroller
    return s.scrollHeight - s.scrollTop - s.clientHeight < 56
  }

  private toBottom(smooth = false): void {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    this.jump.classList.remove('is-on')
  }

  private grew(): void {
    if (this.atBottom() || this.feed.isEmpty) {
      requestAnimationFrame(() => this.toBottom())
    } else this.jump.classList.add('is-on')
  }

  // ================================================================ pieces

  private mountFrame(host: HTMLElement, url: string, minHeight: number, maxHeight = 2400): HTMLIFrameElement {
    const f = document.createElement('iframe')
    f.className = 'loom-frame'
    // Scripts for mermaid and the buttons; the document's own origin for its fetches. No
    // top navigation: a document can never take Ember's window anywhere.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox')
    f.dataset['max'] = String(maxHeight)
    f.style.height = `${minHeight}px`
    f.src = url
    host.appendChild(f)
    this.frames.add(f)
    return f
  }

  private makePiece(host: HTMLElement, title: string, format: string, actions: string[] = []): Piece {
    const el = div(`loom-piece is-${format}`)
    el.dataset['title'] = title
    const head = div('loom-piece-head')
    const kind = format === 'url' ? 'page' : format === 'media' ? 'media' : format === 'ask' ? 'question' : format
    head.innerHTML =
      `<span class="loom-piece-kind">${escapeHtml(kind)}</span><span class="loom-piece-title">${escapeHtml(title)}</span>` +
      `<span class="loom-piece-acts">${actions.join('')}<button type="button" data-p="ask" title="Ask about this">?</button><button type="button" data-p="expand" title="Fill the canvas (Esc to return)">⤢</button><button type="button" data-p="fold" title="Fold">–</button></span>`
    const body = div('loom-piece-body')
    el.append(head, body)
    host.appendChild(el)
    const piece: Piece = { el, body, title, format }
    head.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-p]')
      if (!b) return
      const what = b.dataset['p']
      if (what === 'fold') el.classList.toggle('is-folded')
      else if (what === 'expand') this.expand(piece, this.expanded !== piece)
      else if (what === 'ask') this.ask(b.getBoundingClientRect(), `the "${title}" ${kind}`)
    })
    return piece
  }

  private expand(piece: Piece, on: boolean): void {
    if (this.expanded && this.expanded !== piece) this.expanded.el.classList.remove('is-expanded')
    piece.el.classList.toggle('is-expanded', on)
    this.expanded = on ? piece : null
    if (on) {
      piece.el.style.setProperty('--loom-fill', `${Math.max(240, this.scroller.clientHeight - 64)}px`)
      requestAnimationFrame(() => piece.el.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    }
  }

  /** Before placing a piece, catch the feed up, so the piece lands after the call that made it. */
  private async settle(): Promise<void> {
    try {
      await window.ember.canvas.drain(this.tabId)
    } catch {
      /* placement falls back to the end of the turn */
    }
  }

  /** A pushed panel: a document inline, or a live page. */
  push(push: PanelPush): void {
    void this.place(push)
  }

  private async place(push: PanelPush): Promise<void> {
    await this.settle()
    if (push.format === 'url') {
      await this.openBrowser(push.content, push.title, 'open_url')
      return
    }
    if (!this.origin) this.origin = await window.ember.panel.origin()
    const url = `${this.origin}/doc/${push.id}`
    const same = this.pieces.get(push.title)
    if (same && same.frame && same.format === push.format && push.format !== 'ask' && same.el.isConnected) {
      same.frame.src = url
      same.el.classList.remove('is-folded')
      same.el.classList.add('is-updated')
      window.setTimeout(() => same.el.classList.remove('is-updated'), 1600)
      if (!this.visible(same.el)) this.hooks.toast(`Updated: ${push.title}`)
      return
    }
    const host = this.feed.slotFor(push.format === 'ask' ? 'ask_panel' : 'show_panel')
    const piece = this.makePiece(host, push.title, push.format)
    piece.frame = this.mountFrame(piece.body, url, push.format === 'html' ? 440 : 64)
    this.pieces.set(push.title, piece)
    this.grew()
  }

  /** clear_panel: fold what is up rather than delete it — it is still part of the story. */
  clear(): void {
    for (const p of this.pieces.values()) p.el.classList.add('is-folded')
    for (const b of this.browsers) b.piece.el.classList.add('is-folded')
  }

  private visible(node: HTMLElement): boolean {
    const r = node.getBoundingClientRect()
    const s = this.scroller.getBoundingClientRect()
    return r.bottom > s.top && r.top < s.bottom
  }

  private async showMedia(m: CanvasMedia): Promise<void> {
    await this.settle()
    const host = this.feed.slotFor('show_media')
    const piece = this.makePiece(host, m.title || (m.items.length === 1 ? m.items[0]!.name : `${m.items.length} items`), 'media')
    const grid = div(`loom-media${m.items.length > 1 ? ' is-grid' : ''}`)
    for (const item of m.items) {
      const fig = div('loom-figure')
      fig.dataset['askLabel'] = `this ${item.kind} (${item.caption ?? item.name})`
      if (item.kind === 'video') {
        const v = document.createElement('video')
        v.src = item.src
        v.controls = true
        v.autoplay = true
        v.muted = true
        v.loop = true
        v.playsInline = true
        fig.appendChild(v)
      } else if (item.kind === 'audio') {
        const a = document.createElement('audio')
        a.src = item.src
        a.controls = true
        fig.appendChild(a)
      } else {
        const img = document.createElement('img')
        img.src = item.src
        img.alt = item.caption ?? item.name
        img.dataset['zoom'] = '1'
        fig.appendChild(img)
      }
      if (item.caption) fig.appendChild(div('loom-caption', escapeHtml(item.caption)))
      grid.appendChild(fig)
    }
    piece.body.appendChild(grid)
    this.grew()
  }

  // ================================================================ the live browser

  private async openBrowser(url: string, title: string, tool: string): Promise<Browser> {
    await this.settle()
    const host = this.feed.slotFor(tool)
    const piece = this.makePiece(host, title || url, 'url', [
      `<button type="button" data-b="reload" title="Reload">⟳</button>`,
      `<button type="button" data-b="out" title="Open in your browser">↗</button>`,
    ])
    const view = document.createElement('webview') as WebviewTag
    view.className = 'loom-web'
    view.setAttribute('allowpopups', 'false')
    view.setAttribute('src', url)
    const legend = div('loom-legend')
    piece.body.append(view, legend)
    const ready = new Promise<void>((resolve) => {
      view.addEventListener('dom-ready', () => resolve(), { once: true })
      window.setTimeout(resolve, 10_000)
    })
    view.addEventListener('page-title-updated', (e: Event) => {
      const t = (e as unknown as { title: string }).title
      const el = piece.el.querySelector('.loom-piece-title')
      if (t && el) el.textContent = t
    })
    piece.el.querySelector('.loom-piece-head')?.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-b]')
      if (!b) return
      if (b.dataset['b'] === 'reload') view.reload()
      else window.open(view.getURL() || url, '_blank')
    })
    const browser: Browser = { piece, view, legend, ready }
    this.browsers.push(browser)
    this.grew()
    return browser
  }

  /** Wait until the page has finished loading, within reason. */
  private async loaded(b: Browser): Promise<void> {
    await b.ready
    if (!b.view.isLoading()) return
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      b.view.addEventListener('did-stop-loading', done, { once: true })
      window.setTimeout(done, 8000)
    })
  }

  private async annotate(a: CanvasAnnotate): Promise<void> {
    const reply = (r: Parameters<typeof window.ember.canvas.annotated>[1]) => window.ember.canvas.annotated(a.reqId, r)
    try {
      let b = this.browsers[this.browsers.length - 1]
      if (a.url && (!b || !sameUrl(b.view.getURL(), a.url))) b = await this.openBrowser(a.url, a.url, 'annotate')
      if (!b) return reply({ ok: false, error: 'No page is open on the canvas. Call open_url first, or pass url.' })
      await this.loaded(b)
      const marks = a.clear ? null : a.marks
      const result = (await b.view.executeJavaScript(`(${MARK_SCRIPT})(${JSON.stringify(marks)})`)) as { found: number; missing: string[] }
      b.legend.innerHTML = marks
        ? marks
            .map((m, i) => (m.note ? `<div class="loom-legend-row"><span class="n">${escapeHtml(m.label || String(i + 1))}</span>${escapeHtml(m.note)}</div>` : ''))
            .join('')
        : ''
      b.piece.el.classList.remove('is-folded')
      if (!this.visible(b.piece.el)) b.piece.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      reply({ ok: true, found: result?.found ?? 0, missing: result?.missing ?? [], url: b.view.getURL() })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // ================================================================ steps, sign

  private setTodos(list: Todo[]): void {
    this.todos = list
    const done = list.filter((t) => t.status === 'completed').length
    if (!list.length) {
      this.steps.classList.remove('is-on')
      return
    }
    const rows = list
      .map((t) => {
        const cls = t.status === 'completed' ? 'is-done' : t.status === 'in_progress' ? 'is-now' : ''
        const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◆' : '○'
        const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content
        return `<li class="${cls}"><span class="m">${mark}</span><span>${escapeHtml(text)}</span></li>`
      })
      .join('')
    this.steps.innerHTML = `<button type="button" class="loom-steps-head"><span>${escapeHtml(this.stepsTitle || 'Steps')}</span><span class="c">${done}/${list.length}</span></button><ol>${rows}</ol>`
    this.steps.querySelector('.loom-steps-head')?.addEventListener('click', () => {
      this.stepsOpen = !this.stepsOpen
      this.steps.classList.toggle('is-folded', !this.stepsOpen)
    })
    this.steps.classList.toggle('is-folded', !this.stepsOpen)
    this.steps.classList.toggle('is-complete', done === list.length)
    this.steps.classList.add('is-on')
  }

  private renderSign(): void {
    const s = this.status
    const bits = ['claude']
    if (s?.model) bits.push(s.model)
    if (s?.contextPercent != null) bits.push(`${Math.round(s.contextPercent)}%`)
    this.sign.innerHTML = `<span class="loom-sign-glyph">✻</span><span>${escapeHtml(bits.join(' · '))}</span><button type="button" title="The real terminal (Ctrl+\`)">⌨</button>`
    this.sign.querySelector('button')?.addEventListener('click', () => this.setRaw(true))
  }

  /** What this view believes, for probes and for support: `window.__ember.loom()`. */
  debug(): { mode: Mode; raw: boolean; working: boolean; dock: Dock | null; todos: number; pieces: number; browsers: number; turns: number; says: number } {
    return {
      mode: this.mode,
      working: this.working,
      says: this.feed.el.querySelectorAll('.loom-say').length,
      raw: this.raw,
      dock: this.dock,
      todos: this.todos.length,
      pieces: this.pieces.size,
      browsers: this.browsers.length,
      turns: this.feed.el.querySelectorAll('.loom-turn').length,
    }
  }

  // ================================================================

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameReq) cancelAnimationFrame(this.frameReq)
    for (const u of this.unsubs) u()
    window.ember.canvas.unwatch(this.tabId)
    const pane = this.session.el
    pane.style.transform = ''
    pane.style.clipPath = ''
    pane.classList.remove('is-loom')
    this.panes.classList.remove('has-loom')
    delete this.panes.dataset['loom']
    this.el.remove()
    this.rawPill.remove()
  }
}

function div(cls: string, html?: string): HTMLElement {
  const e = document.createElement('div')
  e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * Runs inside the page. Finds each mark by selector or by visible text, and draws a box,
 * a label and its note over it in document coordinates, on one layer that the next call
 * replaces. Returns what it found so the agent knows what it actually pointed at.
 */
const MARK_SCRIPT = String(function mark(marks: Array<{ selector?: string; text?: string; label?: string; note?: string }> | null) {
  const ID = '__ember_marks__'
  document.getElementById(ID)?.remove()
  if (!marks) return { found: 0, missing: [] }
  const layer = document.createElement('div')
  layer.id = ID
  layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none'
  const style = document.createElement('style')
  style.textContent =
    '@keyframes __emberPulse{0%{box-shadow:0 0 0 0 rgba(255,122,61,.6)}100%{box-shadow:0 0 0 16px rgba(255,122,61,0)}}'
  layer.appendChild(style)
  document.documentElement.appendChild(layer)
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const byText = (t: string): Element | null => {
    const want = t.trim().toLowerCase()
    let best: Element | null = null
    let bestLen = Infinity
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (!visible(el)) continue
      const h = el as HTMLElement & { value?: string }
      const text = (h.innerText || h.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().toLowerCase()
      if (!text || !text.includes(want)) continue
      if (text.length < bestLen) {
        best = el
        bestLen = text.length
      }
    }
    return best
  }
  const found: Array<{ el: Element; m: { label?: string; note?: string }; n: number }> = []
  const missing: string[] = []
  marks.forEach((m, i) => {
    let el: Element | null = null
    try {
      if (m.selector) el = Array.from(document.querySelectorAll(m.selector)).find(visible) ?? document.querySelector(m.selector)
    } catch {
      /* not a valid selector; try the text */
    }
    if (!el && m.text) el = byText(m.text)
    if (!el) missing.push(m.selector || m.text || `#${i + 1}`)
    else found.push({ el, m, n: found.length + 1 })
  })
  for (const { el, m, n } of found) {
    const r = el.getBoundingClientRect()
    const x = r.left + scrollX
    const y = r.top + scrollY
    const box = document.createElement('div')
    box.style.cssText = `position:absolute;left:${x - 5}px;top:${y - 5}px;width:${r.width + 10}px;height:${r.height + 10}px;border:2px solid #ff7a3d;border-radius:8px;background:rgba(255,122,61,.07);animation:__emberPulse 1.3s ease-out 3`
    const tag = document.createElement('div')
    tag.textContent = m.label || String(n)
    tag.style.cssText = `position:absolute;left:${x - 5}px;top:${Math.max(0, y - 30)}px;background:#ff7a3d;color:#1a0d05;font:700 12px/1 system-ui,sans-serif;padding:6px 9px;border-radius:7px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35)`
    layer.append(box, tag)
    if (m.note) {
      const note = document.createElement('div')
      note.textContent = m.note
      const right = x + r.width + 16
      const fits = right + 280 < scrollX + innerWidth
      note.style.cssText = `position:absolute;left:${fits ? right : x - 5}px;top:${fits ? y - 4 : y + r.height + 12}px;max-width:270px;background:#1a1624;color:#f1ecfa;border:1px solid #ff7a3d;font:13px/1.45 system-ui,sans-serif;padding:8px 11px;border-radius:9px;box-shadow:0 12px 32px rgba(0,0,0,.45)`
      layer.appendChild(note)
    }
  }
  found[0]?.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return { found: found.length, missing }
})
