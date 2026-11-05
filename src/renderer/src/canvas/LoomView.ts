import type { CanvasFeed, EmberConfig, PanelPush, ScreenItem } from '@shared/types'
import type { Session } from '../core/Session'
import { Feed } from './Feed'
import { AgentHost } from './loom/host'
import { Board } from './loom/board'
import { CanvasInput } from './loom/input'
import { Notebook } from './loom/notebook'
import { Pieces } from './loom/pieces'
import { Plan } from './loom/plan'
import { Snaps } from './loom/snaps'
import { Stage } from './loom/stage'
import { FrameSleeper } from './loom/frames'
import { div, reduced, viewSwitch, sameTitle, type Browser, type Mode, type Piece } from './loom/shared'
import { pasteIntoTui } from './tuiScreen'

/**
 * A tab's canvas: a real shell whose output space becomes a canvas while an agent runs.
 *
 * It starts as a plain PowerShell, drawn exactly as PowerShell draws it. Type `claude` and
 * the real Claude Code starts in that shell, exactly as in any terminal — and the tab
 * splits: the canvas above, the real CLI below (the same terminal, its PTY resized to the
 * bottom box). The person types into Claude Code's own prompt; the canvas shows the
 * conversation drawn from the session's own transcript (replies as rich text, diagrams as
 * diagrams, edits as diffs, whatever the session chose to show). The CLI grows while it
 * shows a picker or a dialog, and Ctrl+` gives it the whole tab. When Claude Code exits,
 * the tab is the shell again.
 *
 * Codex gets the same layout. Other agents get the switch and their whole screen; no
 * agent's screen is ever cropped.
 *
 * This class is the coordinator: it owns the canvas's element, the feed and the state the
 * parts share (the pieces by title, what is pinned, the frames), wires the events, and
 * hands the work to the parts in ./loom:
 *
 * - host.ts      the agent in the shell, the mode, the split (canvas above, CLI below), the divider, auto-grow
 * - stage.ts     the turn on screen, the rail, the wheel between turns, the live line, trail and subagents
 * - plan.ts      the plan piece
 * - pieces.ts    a piece made, dragged out, placed, sized, minimized, full screen and zoomed
 * - snaps.ts     snapping to the edges, and the words laid out round what is placed
 * - board.ts     what the session shows (panels, media, the live browser), the frames' bridge, replay
 * - input.ts     clicks, the right-click menu and ask box, the selection chip, keys, keyboard navigation
 * - notebook.ts  the todo list and notes drawer, notes edited in place, sticky notes
 *
 * The parts take this view and reach each other through it, never by importing one another.
 */

export interface LoomHooks {
  /** Type into the session as the user; `submit` presses Enter. */
  send(text: string, submit: boolean): void
  /** Is this tab the one on screen? */
  isActive(): boolean
  /** Toast-level feedback. */
  toast(text: string): void
  /** Open the todo list or the notes, as their own tabs. */
  openPlace?(place: 'todo' | 'notes'): void
  /** Remember the view the person chose (canvas or the agent's own screen). */
  saveView?(view: 'canvas' | 'cli'): void
  /** What the tab's card shows changed: an agent came or went, the view, the session's name. */
  changed?(): void
}

export class LoomView {
  readonly el: HTMLElement
  readonly scroller: HTMLElement
  readonly feed: Feed
  readonly hint: HTMLElement
  readonly sign: HTMLElement
  private readonly steps: HTMLElement
  readonly jump: HTMLElement
  readonly rawPill: HTMLElement
  /** Pictures attached to the message being written in the CLI, shown just above the divider. */
  readonly pastedEl: HTMLElement
  private pasted: Array<{ src: string; n: number | null; at: number; goneAt: number; el: HTMLElement }> = []

  // The parts (see the list above).
  readonly host: AgentHost
  readonly stage: Stage
  readonly plan: Plan
  readonly objects: Pieces
  readonly snapping: Snaps
  readonly board: Board
  readonly input: CanvasInput
  readonly notebook: Notebook

  mode: Mode = 'shell'
  raw: boolean
  private frameReq = 0
  disposed = false
  origin = ''
  readonly frames = new Set<HTMLIFrameElement>()
  /** Loads frames as they come near the screen and unloads static ones long away from it. */
  readonly sleeper = new FrameSleeper()
  /** Everything shown, by title. */
  readonly pieces = new Map<string, Piece>()
  /** Objects you pinned: they stay where you put them, turn after turn, until removed. */
  readonly pinned = new Set<Piece>()
  readonly browsers: Browser[] = []
  readonly unsubs: Array<() => void> = []

  constructor(
    readonly tabId: string,
    readonly panes: HTMLElement,
    readonly session: Session,
    config: EmberConfig,
    readonly hooks: LoomHooks
  ) {
    this.el = document.createElement('div')
    this.el.className = 'loom'
    this.el.dataset['tabId'] = tabId
    this.applyTheme(config)
    // The view the person last chose: the canvas unless they picked the agent's own screen.
    this.raw = config.agentView === 'cli'

    this.host = new AgentHost(this)
    this.stage = new Stage(this)
    this.plan = new Plan(this)
    this.objects = new Pieces(this)
    this.snapping = new Snaps(this)
    this.board = new Board(this)
    this.input = new CanvasInput(this)
    this.notebook = new Notebook(this)

    this.scroller = document.createElement('div')
    this.scroller.className = 'loom-scroll'
    this.feed = new Feed({
      send: (text, submit) => this.type(text, submit),
      localImage: async (path) => {
        const r = await window.ember.canvas.media(path)
        return 'src' in r ? r.src : null
      },
      diagram: (source) => window.ember.canvas.doc(this.tabId, 'diagram', 'mermaid', source),
      mountFrame: (host, url, min) => this.objects.mountFrame(host, url, min),
      todos: (list) => this.plan.setTodos(list),
      openInline: (url) => void this.board.openBrowser(url, url, 'open_url'),
      grew: () => this.grew(),
      replay: (tool, input, at) => void this.board.replay(tool, input as Record<string, unknown>, at),
      agent: (e) => this.stage.onAgentEvent(e),
      cleared: () => this.onCleared(),
    })
    // Three layers, top to bottom: the plan of the work in progress, the exchange (your
    // words and Claude's latest), and the board — everything Claude has shown, which stays
    // across turns and changes in place. A new turn replaces only the exchange.
    this.scroller.append(this.feed.el)

    this.hint = div('loom-hint', `<span class="loom-hint-glyph">✻</span><span class="loom-hint-text">What your agent says and shows appears on this canvas.</span>`)
    this.sign = div('loom-sign')
    this.steps = div('loom-steps')
    this.jump = div('loom-jump', '↓ latest')
    this.pastedEl = div('loom-pasted')
    // Over the agent's own screen: the same bar as on the canvas, so switching views moves nothing.
    this.rawPill = div('loom-rawpill loom-sign', viewSwitch(true))
    // The canvas's size and colours, so the same bar renders the same.
    for (const k of ['--l-font-size', '--l-green', '--l-red', '--l-yellow', '--l-blue', '--l-magenta', '--l-cyan']) {
      const v = this.el.style.getPropertyValue(k)
      if (v) this.rawPill.style.setProperty(k, v)
    }

    const { input, host } = this
    // Focusable, so the keyboard can be on the canvas (Ctrl+↑) rather than in the terminal.
    this.el.tabIndex = -1
    this.el.append(this.scroller, this.stage.rail, this.objects.pinLayer, this.hint, this.sign, this.steps, this.jump, this.pastedEl, input.chip, input.pop, input.ctxMenu, this.notebook.drawer, input.lightbox)
    panes.append(this.el, host.divider, this.rawPill)
    panes.classList.add('has-loom')
    session.el.classList.add('is-loom')

    this.wire()
    // Files dropped on the canvas: their paths go into the agent's prompt, as a drop on its
    // terminal would put them. Handled here, so the window's own drop leaves them alone.
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files') && !!this.host.onAgent && this.mode === 'claude'
    this.el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })
    this.el.addEventListener('drop', (e) => {
      if (!hasFiles(e) || e.defaultPrevented) return
      e.preventDefault()
      this.dropFiles([...(e.dataTransfer?.files ?? [])])
    })
    this.pastedEl.addEventListener('click', (e) => {
      const img = (e.target as HTMLElement).closest('.loom-pasted-item')?.querySelector('img')
      if (img) this.input.zoom(img.src, img.alt)
    })
    this.renderSign()
    this.schedule()
    void window.ember.panel.origin().then((o) => (this.origin = o))
    void this.notebook.countTodos()
    void window.ember.notes.dir().then((d) => (this.notebook.notesDir = d))
    this.unsubs.push(
      window.ember.notes.onChanged((e) => {
        if (e.id.toLowerCase() === 'todo.md') void this.notebook.countTodos()
        // Changed elsewhere while the notebook shows it: redraw, unless you are typing in it.
        if (this.notebook.drawer.classList.contains('is-on') && !this.notebook.drawer.contains(document.activeElement)) void this.notebook.renderDrawer()
      })
    )
    this.renderSign()
    void window.ember.canvas.watch(tabId)
  }

  // ================================================================ wiring

  private wire(): void {
    const { host, stage, input, objects } = this
    const term = this.session.term
    const sub = (d: { dispose(): void }) => this.unsubs.push(() => d.dispose())
    sub(term.onRender(() => this.schedule()))
    sub(term.onResize(() => this.schedule()))
    sub(term.buffer.onBufferChange(() => this.schedule()))
    sub(term.onCursorMove(() => this.schedule()))
    this.sign.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-s]')
      if (b?.dataset['s'] === 'notes') {
        if (this.hooks.openPlace) this.hooks.openPlace('todo')
        else this.notebook.toggleDrawer()
      }
      else if (b?.dataset['s'] === 'older') stage.stepTurn(-1)
      else if (b?.dataset['s'] === 'newer') stage.stepTurn(1)
      else if (b?.dataset['s'] === 'now') {
        stage.viewing = null
        stage.restage()
      } else if (b?.dataset['s'] === 'clear') this.clearScreen()
      else if (b?.dataset['s'] === 'raw') this.setRaw(true)
      else if ((e.target as HTMLElement).closest('[data-view="cli"]')) this.setRaw(true)
    })
    const ro = new ResizeObserver(() => this.schedule())
    ro.observe(this.panes)
    this.unsubs.push(() => ro.disconnect())

    this.unsubs.push(
      window.ember.canvas.onFeed((f: CanvasFeed) => {
        if (f.tabId !== this.tabId) return
        if (f.kind === 'switch') this.feed.switchSession(f.first, f.fresh === true)
        else {
          // The session's name (`/rename`), for the tab's card.
          for (const l of f.lines as unknown as Array<Record<string, unknown>>) {
            if (l['type'] === 'custom-title' && typeof l['customTitle'] === 'string' && l['customTitle'] !== this.host.title) {
              this.host.title = l['customTitle']
              this.hooks.changed?.()
            }
          }
          this.feed.add(f.lines)
        }
        this.hint.classList.toggle('is-gone', !this.feed.isEmpty)
        stage.restage()
        stage.renderNow()
      }),
      window.ember.canvas.onMedia((m) => {
        if (m.tabId === this.tabId) void this.board.showMedia(m)
      }),
      window.ember.canvas.onAnnotate((a) => {
        if (a.tabId === this.tabId) void this.board.annotate(a)
      }),
      window.ember.canvas.onSteps((s) => {
        if (s.tabId !== this.tabId) return
        this.plan.stepsTitle = s.title
        this.plan.setTodos(
          s.steps.map((x) => ({
            content: x.text,
            status: x.status === 'done' ? 'completed' : x.status === 'active' ? 'in_progress' : 'pending',
          }))
        )
      }),
      window.ember.canvas.onAgent((a) => {
        if (a.tabId !== this.tabId) return
        const ag = [...stage.agents.values()].find((x) => x.agentId === a.agentId)
        if (!ag || ag.end) return
        if (a.action !== ag.action) {
          ag.action = a.action
          ag.steps.push(a.action)
          if (ag.steps.length > 8) ag.steps.shift()
          stage.renderAgents()
        }
      }),
      window.ember.canvas.onCost((c) => {
        if (c.tabId === this.tabId) host.cost = c
      }),
      window.ember.claude.onStatus((s) => {
        if (s.tabId === this.tabId) host.status = s
      }),
      // The session's name (`/rename`): Claude Code's hooks carry it, for the tab's card.
      window.ember.hooks.onEvent((e) => {
        if (e.tabId !== this.tabId) return
        const t = (e.input as Record<string, unknown>)['session_title']
        if (typeof t === 'string' && t && t !== host.title) {
          host.title = t
          this.hooks.changed?.()
        }
      })
    )

    const onMessage = (e: MessageEvent) => this.board.frameMessage(e)
    window.addEventListener('message', onMessage)
    this.unsubs.push(() => window.removeEventListener('message', onMessage))

    // A click anywhere outside the menu closes it — the terminal, the sidebar, another
    // window. A click inside a diagram or page never reaches this window, but it takes the
    // focus away from it, which says the same thing.
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (input.ctxMenu.classList.contains('is-on') && !(t && input.ctxMenu.contains(t))) input.closeMenu()
      // The ask box goes too, unless something has been written in it.
      if (input.pop.classList.contains('is-on') && !(t && input.pop.contains(t)) && !input.pop.querySelector('textarea')?.value.trim()) input.closeAsk()
    }
    const away = () => {
      input.closeMenu()
      // A click inside a placed diagram or page takes the focus into its frame: that object
      // was just selected, so it comes to the front like any other.
      window.setTimeout(() => objects.raiseFocused(), 0)
    }
    window.addEventListener('pointerdown', outside, true)
    this.el.addEventListener('focusin', () => objects.raiseFocused())
    window.addEventListener('blur', away)
    this.unsubs.push(() => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', away)
    })

    const onKey = (e: KeyboardEvent) => input.key(e)
    window.addEventListener('keydown', onKey, true)
    this.unsubs.push(() => window.removeEventListener('keydown', onKey, true))

    this.scroller.addEventListener('scroll', () => {
      if (this.atBottom()) this.jump.classList.remove('is-on')
      input.chip.classList.remove('is-on')
    })
    // Not passive: the end of a push that changed the turn must not go on to scroll the new one.
    this.scroller.addEventListener('wheel', (e) => stage.wheelTurns(e), { passive: false })
    this.jump.addEventListener('click', () => this.toBottom(true))
    this.rawPill.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-view="canvas"]')) this.setRaw(false)
    })

    this.el.addEventListener('click', (e) => input.click(e))
    this.el.addEventListener('contextmenu', (e) => input.context(e))
    this.el.addEventListener('mouseup', (e) => input.selection(e))
    input.chip.addEventListener('mousedown', (e) => e.preventDefault())
    input.chip.addEventListener('click', () => {
      const text = (window.getSelection()?.toString() ?? '').trim()
      if (text) input.ask(input.chip.getBoundingClientRect(), 'this', text)
      input.chip.classList.remove('is-on')
    })
    stage.rail.addEventListener('click', (e) => {
      const dot = (e.target as HTMLElement).closest<HTMLElement>('[data-turn]')
      if (!dot) return
      const turns = this.feed.turns()
      const i = Number(dot.dataset['turn'])
      stage.viewing = i >= turns.length - 1 ? null : (turns[i] ?? null)
      stage.restage()
      this.session.focus()
    })
    input.lightbox.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.loom-lightbox-ask')) return
      input.lightbox.classList.remove('is-on')
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

  // ================================================================ layout

  schedule(): void {
    if (this.frameReq || this.disposed) return
    this.frameReq = requestAnimationFrame(() => {
      this.frameReq = 0
      this.host.layout()
    })
  }

  /** A new mode: the canvas on or off, the pane told it moved. */
  setMode(mode: Mode, showCanvas: boolean): void {
    if (mode === this.mode) return
    const was = this.mode
    this.mode = mode
    this.el.classList.toggle('is-on', showCanvas)
    this.panes.dataset['loom'] = mode
    if (showCanvas) this.stage.restage()
    this.renderSign()
    void was
    // The pane just moved (to the bottom box, or back to the whole tab). The WebGL drawing
    // buffer is not preserved across composites (see Session.repaint), so draw every row
    // afresh rather than trusting what was there.
    requestAnimationFrame(() => this.session.repaint())
  }

  sizeCanvas(px: number): void {
    const h = `${Math.max(0, px).toFixed(1)}px`
    if (this.el.style.height === h) return
    this.el.style.height = h
    for (const p of this.pinned) if (!p.snap) this.objects.settlePin(p)
    this.snapping.layoutSnaps(false)
    if (this.pinned.size) this.snapping.reflow()
  }

  /** The tab's card while an agent runs in it: the agent in a folder, not the shell. */
  get claudeCard(): { folder: string; title: string; agent: string; cli: boolean } | null {
    if (!this.host.onAgent) return null
    return { folder: this.session.cwd || this.session.initialCwd || '', title: this.host.title, agent: this.host.who, cli: this.raw }
  }

  /**
   * Words for the session, as the person: pasted into the agent's own prompt (and Enter,
   * when `submit`), and the keyboard back in its terminal. With no agent, typed into the shell.
   */
  type(text: string, submit: boolean): void {
    if (this.host.onAgent) {
      void pasteIntoTui((d) => window.ember.write(this.session.id, d), text, submit)
      // After the click that sent it has settled (a card focuses its own parts on the way).
      if (this.hooks.isActive()) window.setTimeout(() => this.session.term.focus(), 60)
      return
    }
    this.hooks.send(text, submit)
  }

  /**
   * `/clear`: the conversation started over, so does the canvas — the turns (and with them
   * the rail), the plan, the subagents and the trail. Objects you pinned or snapped are yours,
   * not the conversation's, and stay where you put them.
   */
  private onCleared(): void {
    this.stage.cleared()
    if (this.objects.expanded && !this.objects.expanded.el.isConnected) this.objects.expanded = null
    for (const [k, p] of this.pieces) {
      if (this.pinned.has(p) || p.el.isConnected) continue
      if (p.frame) this.frames.delete(p.frame)
      this.pieces.delete(k)
    }
    for (let i = this.browsers.length - 1; i >= 0; i--) if (!this.browsers[i]!.piece.el.isConnected) this.browsers.splice(i, 1)
    this.stage.agents.clear()
    this.stage.renderAgents()
    this.plan.setTodos([])
    this.stage.renderRail()
    this.reportScreen()
  }

  /**
   * Files dropped on the tab while an agent runs: their paths go into its prompt, the way a
   * drop on a terminal puts them (Claude Code makes an image's path an `[Image #n]`), and a
   * picture gets its thumbnail above the divider.
   */
  dropFiles(files: File[]): void {
    const paths = files.map((f) => window.ember.platform.pathForFile(f)).filter(Boolean)
    if (!paths.length) return
    for (const f of files) if (f.type.startsWith('image/')) this.addPasted(URL.createObjectURL(f))
    this.type(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + ' ', false)
  }

  /**
   * A picture went to the agent's prompt (Ctrl+V, a drop). Its thumbnail waits for the TUI's
   * own mark (`[Image #n]`, read from the prompt rows) and is labelled with it; it goes when
   * the mark leaves the prompt (sent: the turn on the canvas shows it then, or deleted).
   */
  addPasted(src: string): void {
    const el = div('loom-pasted-item')
    el.innerHTML = `<img alt="Pasted image"><span>Image</span>`
    el.querySelector('img')!.src = src
    el.title = 'Attached in the CLI — click to see it'
    this.pasted.push({ src, n: null, at: Date.now(), goneAt: 0, el })
    this.pastedEl.appendChild(el)
    this.pastedEl.classList.add('is-on')
    this.schedule()
  }

  /** The prompt's `[Image #n]` marks, as the screen shows them now. */
  syncPasted(marks: number[]): void {
    if (!this.pasted.length) return
    const now = Date.now()
    const taken = new Set(this.pasted.map((p) => p.n).filter((n) => n != null))
    for (const p of this.pasted) {
      if (p.n == null) {
        const free = marks.filter((m) => !taken.has(m)).sort((a, b) => a - b)[0]
        if (free != null) {
          p.n = free
          taken.add(free)
          p.el.querySelector('span')!.textContent = `Image #${free}`
          p.el.querySelector('img')!.alt = `Image #${free}`
        }
      }
      if (p.n != null) p.goneAt = marks.includes(p.n) ? 0 : p.goneAt || now
    }
    const keep = this.pasted.filter((p) => (p.n == null ? now - p.at < 8000 : !p.goneAt || now - p.goneAt < 600))
    for (const p of this.pasted) {
      if (keep.includes(p)) continue
      p.el.remove()
      if (p.src.startsWith('blob:')) window.setTimeout(() => URL.revokeObjectURL(p.src), 30_000)
    }
    this.pasted = keep
    this.pastedEl.classList.toggle('is-on', keep.length > 0)
  }

  /** The agent left: its attachments went with it. */
  clearPasted(): void {
    for (const p of this.pasted) {
      p.el.remove()
      if (p.src.startsWith('blob:')) URL.revokeObjectURL(p.src)
    }
    this.pasted = []
    this.pastedEl.classList.remove('is-on')
  }

  /** For probes: the thumbnails waiting above the divider, by their labels. */
  get pastedLabels(): string[] {
    return this.pasted.map((p) => (p.n == null ? 'Image' : `Image #${p.n}`))
  }

  /** Ctrl+`: the real TUI, whole, or back to the canvas. */
  setRaw(on: boolean): void {
    if (on === this.raw) return
    this.raw = on
    this.hooks.saveView?.(on ? 'cli' : 'canvas')
    // At once, not on the next frame: the switch only shows or hides the screen of the
    // one process both views share, and it should feel like it.
    this.host.layout()
    this.session.term.focus()
    this.hooks.changed?.()
  }

  /** An agent's canvas is showing (not the plain shell): its keys are the canvas's. */
  get onCanvas(): boolean {
    return this.mode === 'claude' || !!this.input.kbd || !!this.input.kbdInline
  }

  /** Whether the session is working right now, for Ember on the phone. */
  get busy(): boolean {
    return this.host.working
  }

  /** Step through the turns: -1 older, +1 newer. Reaching the newest follows it again. */
  stepTurn(dir: number): void {
    this.stage.stepTurn(dir)
  }

  /** Clear screen: every pinned object goes. What is on the stage stays. */
  clearScreen(): void {
    this.objects.clearScreen()
  }

  /** Open the notebook on a tab, or on one note; with `text`, start a new note with it. */
  openDrawer(tab: 'todo' | 'notes', noteId?: string, text?: string): void {
    this.notebook.openDrawer(tab, noteId, text)
  }

  /** A pushed panel: a document inline, or a live page. */
  push(push: PanelPush): void {
    this.board.push(push)
  }

  /** clear_panel: fold what is up rather than delete it — it is still part of the story. */
  clear(): void {
    this.board.clear()
  }

  // ================================================================ scrolling

  atBottom(): boolean {
    const s = this.scroller
    return s.scrollHeight - s.scrollTop - s.clientHeight < 56
  }

  toBottom(smooth = false): void {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    this.jump.classList.remove('is-on')
  }

  grew(): void {
    if (this.host.onAgent) this.host.hint()
    this.stage.restage()
    if (this.pinned.size) this.snapping.reflow()
    // The stage starts at the top of the turn, your words first. It follows what is
    // added only once you have gone to its end yourself.
    const s = this.scroller
    if (s.scrollTop > 0 && this.atBottom()) requestAnimationFrame(() => this.toBottom())
    else if (s.scrollHeight - s.scrollTop - s.clientHeight > 56) this.jump.classList.add('is-on')
  }

  /**
   * Bring something into view by scrolling the reply up or down, and nothing else. The
   * browser's own scrollIntoView also scrolls every ancestor sideways — the whole canvas
   * slid left under the sidebar when the keyboard picked an object near the right edge.
   */
  reveal(el: HTMLElement, block: 'nearest' | 'start' | 'center' = 'nearest'): void {
    if (this.scroller.contains(el)) {
      const sr = this.scroller.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      let d = 0
      if (block === 'start') d = r.top - sr.top - 12
      else if (block === 'center') d = r.top + r.height / 2 - (sr.top + sr.height / 2)
      else if (r.top < sr.top) d = r.top - sr.top - 12
      else if (r.bottom > sr.bottom) d = Math.min(r.bottom - sr.bottom + 12, r.top - sr.top - 12)
      if (d) this.scroller.scrollBy({ top: d, behavior: reduced() ? 'auto' : 'smooth' })
    }
    // Anything that did slide sideways goes back.
    for (const n of [this.el, this.panes, this.panes.parentElement, this.scroller]) if (n && n.scrollLeft) n.scrollLeft = 0
  }

  visible(node: HTMLElement): boolean {
    const r = node.getBoundingClientRect()
    const s = this.scroller.getBoundingClientRect()
    return r.bottom > s.top && r.top < s.bottom
  }

  /** Tell main what is placed, so the session's on_screen tool can say. */
  reportScreen(): void {
    const items: ScreenItem[] = [...this.pinned].map((p) => ({
      title: p.title,
      format: p.format,
      placed: p.dock ?? 'floating',
      ...(p.source ? { source: p.source.slice(0, 8000) } : {}),
    }))
    // And what is on the stage in this turn: pieces shown inline, diagrams in the reply.
    const stage = this.stage.shown
    if (stage) {
      for (const p of this.pieces.values()) {
        if (this.pinned.has(p) || !stage.contains(p.el)) continue
        items.push({ title: p.title, format: p.format, placed: 'on the board', ...(p.source ? { source: p.source.slice(0, 8000) } : {}) })
      }
      stage.querySelectorAll<HTMLElement>('.loom-diagram[data-title]:not(.is-lifted)').forEach((d) => {
        items.push({ title: d.dataset['title']!, format: 'mermaid', placed: 'in the reply', source: (d.dataset['source'] ?? '').slice(0, 8000) })
      })
    }
    window.ember.canvas.screen(this.tabId, items)
  }

  /** An object by name, forgiving quotes, spacing and case — the session rarely echoes a title byte for byte. */
  findPiece(title: string): Piece | undefined {
    const exact = this.pieces.get(title)
    if (exact) return exact
    for (const [t, p] of this.pieces) if (sameTitle(t, title)) return p
    return undefined
  }

  // ================================================================ steps, sign

  renderSign(): void {
    const n = this.pinned.size
    this.stage.renderRail()
    void n
    this.sign.innerHTML = viewSwitch(false)
    this.rawPill.innerHTML = viewSwitch(true)
  }

  /** Claude Code is in this tab (split or full CLI): Ctrl+V with a picture is its Alt+V. */

  get isClaude(): boolean {
    return this.host.claudeOn
  }

  /** Probe-only: hand the canvas transcript lines as if they came from the session's log. */
  feedForProbe(lines: Array<Record<string, unknown>>): void {
    this.feed.add(lines as never)
    this.hint.classList.toggle('is-gone', !this.feed.isEmpty)
    this.stage.restage()
    this.stage.renderNow()
  }

  /** Probe-only: the tab's session moved to another transcript, as main reports it. */
  switchForProbe(first = false, fresh = false): void {
    this.feed.switchSession(first, fresh)
    this.stage.restage()
  }

  /** What this view believes, for probes and for support: `window.__ember.loom()`. */
  debug(): {
    mode: Mode
    raw: boolean
    working: boolean
    agent: string | null
    todos: number
    pieces: number
    browsers: number
    turns: number
    says: number
    rows: string[]
    sessionId: string
    cli: Record<string, unknown>
    claude: boolean
    paneVisible: boolean
    text: string
    hint: boolean
  } {
    const term = this.session.term
    const pane = this.session.el
    const x = term.element
    const cs = getComputedStyle(pane)
    const xs = x ? getComputedStyle(x) : null
    return {
      hint: !this.hint.classList.contains('is-gone') && this.el.classList.contains('is-on'),
      cli: {
        rows: term.rows,
        cols: term.cols,
        pty: this.session.ptySize,
        cellH: (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core?._renderService?.dimensions?.css?.cell?.height ?? 0,
        padY: x ? (parseFloat(getComputedStyle(x).paddingTop) || 0) + (parseFloat(getComputedStyle(x).paddingBottom) || 0) : 0,
        need: this.host.read?.need ?? 0,
        wantRows: this.host.wantRows,
        paneTop: pane.offsetTop,
        paneH: pane.clientHeight,
        paneW: pane.clientWidth,
        xtermH: x?.clientHeight ?? 0,
        screenH: (x?.querySelector('.xterm-screen') as HTMLElement | null)?.offsetHeight ?? 0,
        canvasH: this.el.clientHeight,
        canvasOn: this.el.classList.contains('is-on'),
        grown: this.host.grown,
        userRows: this.host.userRows,
        why: this.host.read?.why ?? '',
        prompt: this.host.read?.prompt ?? false,
        promptSeen: this.host.promptSeen,
        live: this.host.live,
        transform: cs.transform,
        clipPath: cs.clipPath,
        mask: cs.maskImage,
        visibility: cs.visibility,
        xtermTransform: xs?.transform ?? '',
        xtermClip: xs?.clipPath ?? '',
        focusInTerm: document.activeElement === term.textarea,
        title: this.host.title,
        pasted: this.pastedLabels,
      },
      claude: this.host.claudeOn,
      paneVisible: this.session.el.style.visibility !== 'hidden',
      text: this.feed.el.innerText,
      rows: this.host.rowsText(),
      sessionId: this.session.id,
      mode: this.mode,
      working: this.host.working,
      says: this.feed.el.querySelectorAll('.loom-say').length,
      raw: this.raw,
      agent: this.host.onAgent,
      todos: this.plan.todos.length,
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
    this.sleeper.dispose()
    for (const u of this.unsubs) u()
    window.ember.canvas.unwatch(this.tabId)
    const pane = this.session.el
    pane.style.top = ''
    pane.classList.remove('is-loom', 'is-gliding')
    this.panes.classList.remove('has-loom')
    delete this.panes.dataset['loom']
    this.el.remove()
    this.host.dispose()
    this.rawPill.remove()
  }
}
