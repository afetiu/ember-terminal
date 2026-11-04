import type { CanvasAnnotate, CanvasFeed, CanvasMedia, ClaudeStatus, EmberConfig, EmberCost, PanelPush, ScreenItem } from '@shared/types'
import type { Session } from '../core/Session'
import { Feed, type Todo } from './Feed'
import { escapeHtml, renderMarkdown } from './markdown'
import { docTone } from '../core/docTone'
import { agentSpec } from '@shared/agents'
import type { AgentWrapper } from './AgentWrapper'
import { ClaudeTui } from './ClaudeTui'

/**
 * A tab's canvas: a real shell whose output space becomes a canvas while an agent runs.
 *
 * It starts as a plain PowerShell, drawn exactly as PowerShell draws it. Type `claude` and
 * the real Claude Code starts in that shell, exactly as in any terminal — and the tab puts
 * a canvas over it. The canvas never shows any of Claude Code's screen: the conversation
 * is drawn from the session's own transcript (replies as rich text, diagrams as diagrams,
 * edits as diffs, whatever the session chose to show), and Ember's own composer types into
 * Claude Code's prompt for you (ClaudeTui, an AgentWrapper). Ctrl+` or the Canvas | CLI
 * switch shows or hides the real screen — the same process, so the switch is instant.
 * When Claude Code exits, the tab is the shell again.
 *
 * Codex is still framed the older way: its own input, cut out of its screen, under the
 * canvas. Other agents get the switch and their whole screen.
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

/** Canvas | CLI: the two ways to see an agent tab, as one switch. */
function viewSwitch(cli: boolean): string {
  return (
    `<span class="loom-view-switch" role="group" aria-label="View">` +
    `<button type="button" data-view="canvas" class="${cli ? '' : 'is-on'}" aria-pressed="${!cli}" title="Ember's canvas (Ctrl+\`)">Canvas</button>` +
    `<button type="button" data-view="cli" class="${cli ? 'is-on' : ''}" aria-pressed="${cli}" title="The agent's own screen (Ctrl+\`)">CLI</button>` +
    `</span>`
  )
}

type Mode = 'shell' | 'claude' | 'agent' | 'app' | 'raw'

interface Dock {
  /** First and last viewport rows that stay visible. */
  top: number
  bottom: number
  /** A dialog or a menu rather than the input box: worth drawing the eye to. */
  dialog: boolean
  /** The input box's own rows (the prompt and its continuation lines), when it was found. */
  box: [number, number] | null
  /** The rules that open and close the box, -1 when not on screen. */
  open: number
  close: number
  /** First row of the status lines under the box, when there is no closing rule (Codex). */
  foot?: number
}

interface Piece {
  el: HTMLElement
  body: HTMLElement
  title: string
  format: string
  frame?: HTMLIFrameElement
  /** Where a pinned piece is docked; the text keeps clear of that edge. None: it floats. */
  dock?: Side | null
  /** Snapped to an edge: part of the layout there, not floating over it. */
  snap?: Side | null
  /** The file it shows, when it came from show_file (a note can then be edited in place). */
  file?: string
  /** The plan step it was shown during, so the step can carry it. */
  step?: string
  /** Extra menu entries this kind of object has (a page: reload, open outside). */
  extra?: Array<[string, string, () => void]>
  /** Its size while floating, to go back to when it leaves a snap. */
  free?: { w: number; h: number }
  /** A diagram lifted out of a reply: its mermaid source, so the session can edit it. */
  source?: string
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

/** Line icons, drawn in the text colour, so the controls read as part of the terminal. */
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ICON = {
  pin: svg('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
  grip: svg('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  expand: svg('<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>'),
  fold: svg('<path d="M5 12h14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  check: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>'),
  note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>'),
  diagram: svg('<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M7 16v-4"/><path d="M12 16V8"/><path d="M17 16v-7"/>'),
  page: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18"/><path d="M9 21V9"/>'),
  doc: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h6"/>'),
  code: svg('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/>'),
  table: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M3 15h18M12 3v18"/>'),
  terminal: svg('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
  notes: svg('<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5Z"/><path d="M15 3v6h6"/>'),
  sparkle: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
  hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  eye: svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  restore: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  ask: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  reload: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  out: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
}

type Side = 'left' | 'right' | 'top' | 'bottom'

/** The icon a kind of object carries in its title bar and its chip. */
function iconFor(format: string): string {
  return format === 'mermaid' ? ICON.diagram : format === 'view' ? ICON.chart : format === 'html' ? ICON.page : format === 'code' ? ICON.code
    : format === 'url' ? ICON.globe : format === 'media' || format === 'image' ? ICON.image : format === 'table' ? ICON.table : ICON.doc
}

/** One curve and one pace for everything that moves, so it all feels like one thing. */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const ms = (n: number) => (reduced() ? 0 : n)

/** The bar under the input box, and the breathing room inside its frame, in px. */
const BAR_H = 26
const FRAME_PAD = 10
/** The input is at least this many rows tall, prompt at the top, like a text area. */
const INPUT_ROWS = 2
/** How much of another agent's own screen stays visible under the canvas: its input and status. */
const AGENT_ROWS = 10

/** What in a reply can be picked up and placed: diagrams, tables, code, pictures. */
const LIFTABLE = '.loom-diagram, .loom-table, .loom-code, .loom-say img.loom-img, .loom-shelf .loom-figure, .loom-tool-peek .loom-figure'

export class LoomView {
  readonly el: HTMLElement
  private readonly scroller: HTMLElement
  private readonly plan: HTMLElement
  private readonly feed: Feed
  private readonly sign: HTMLElement
  /** The turns as a line of points down the left: click one to go to it. */
  private readonly rail: HTMLElement
  private readonly steps: HTMLElement
  private readonly now: HTMLElement
  /** What Claude has been saying while it works: the last few sentences, newest at the bottom. */
  private readonly trail: HTMLElement
  private readonly activity: HTMLElement
  /** Messages you sent while Claude was busy, waiting their turn. */
  /** The session's subagents, as small pills: what each is on, how long, done or not. */
  private readonly agentsRow: HTMLElement
  private readonly agents = new Map<string, { key: string; agentId?: string; desc: string; type: string; start: number; end?: number; ok?: boolean; action: string; steps: string[]; summary: string }>()
  private trailSeen = 0
  /** Objects you pinned: they stay where you put them, turn after turn, until removed. */
  private readonly pinLayer: HTMLElement
  private readonly pinned = new Set<Piece>()
  private readonly frame: HTMLElement
  private readonly bar: HTMLElement
  private readonly jump: HTMLElement
  private readonly hint: HTMLElement
  private readonly pop: HTMLElement
  /** The notebook: the todo list and notes, in a drawer beside the canvas. */
  private readonly drawer: HTMLElement
  private openTodos = 0
  private readonly ctxMenu: HTMLElement
  private readonly chip: HTMLElement
  private readonly lightbox: HTMLElement
  private readonly rawPill: HTMLElement

  private mode: Mode = 'shell'
  /** "Starting Claude Code…", over the shell until the agent's own screen is up. */
  private readonly starting = div('loom-starting')
  private agentUp = false
  /** The agent last reported to main for this tab, so it is told once per change. */
  private tabAgentSent: string | null = null
  /** The clip last put on the terminal pane. */
  private clipCss = ''
  /** When the tab's current agent started, for finding its session log. */
  private tabAgentSince = Date.now()
  private raw: boolean
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
  private status: ClaudeStatus | null = null
  private readonly unsubs: Array<() => void> = []
  /** What drives the agent on the canvas (Claude Code: ClaudeTui), once one has run in the tab. */
  private wrapper: AgentWrapper | null = null
  /** The model picker, above the bar. */
  private readonly barPick: HTMLElement

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
    // The view the person last chose: the canvas unless they picked the agent's own screen.
    this.raw = config.agentView === 'cli'

    this.scroller = document.createElement('div')
    this.scroller.className = 'loom-scroll'
    this.feed = new Feed({
      send: (text, submit) => this.type(text, submit),
      localImage: async (path) => {
        const r = await window.ember.canvas.media(path)
        return 'src' in r ? r.src : null
      },
      diagram: (source) => window.ember.canvas.doc(this.tabId, 'diagram', 'mermaid', source),
      mountFrame: (host, url, min) => this.mountFrame(host, url, min),
      todos: (list) => this.setTodos(list),
      openInline: (url) => void this.openBrowser(url, url, 'open_url'),
      grew: () => this.grew(),
      replay: (tool, input, at) => void this.replay(tool, input as Record<string, unknown>, at),
      agent: (e) => this.onAgentEvent(e),
      cleared: () => this.onCleared(),
    })
    // Three layers, top to bottom: the plan of the work in progress, the exchange (your
    // words and Claude's latest), and the board — everything Claude has shown, which stays
    // across turns and changes in place. A new turn replaces only the exchange.
    // The plan is drawn here and shown inside an object of its own (see showPlan), not
    // fixed above the exchange: it moves, snaps, minimizes and goes like anything shown.
    this.plan = div('loom-plan')
    this.scroller.append(this.feed.el)

    this.hint = div('loom-hint', `<span class="loom-hint-glyph">✻</span><span class="loom-hint-text">Ask below — what your agent says and shows appears on this canvas.</span>`)
    this.sign = div('loom-sign')
    this.rail = div('loom-rail')
    this.steps = div('loom-steps')
    this.now = div('loom-now')
    this.trail = div('loom-trail')
    // What Claude is doing sits in the turn itself, right under its words and above what
    // it showed: it moves with the content and nothing can sit on it.
    this.activity = div('loom-activity')
    this.agentsRow = div('loom-agents')
    this.activity.append(this.trail, this.now, this.agentsRow)
    this.pinLayer = div('loom-pins')
    this.frame = div('loom-frame-box')
    this.bar = div('loom-bar')
    this.barPick = div('loom-bar-pick')
    this.barPick.setAttribute('role', 'listbox')
    this.jump = div('loom-jump', '↓ latest')
    this.pop = div('loom-pop')
    this.drawer = div('loom-drawer')
    this.ctxMenu = div('loom-menu')
    this.chip = div('loom-chip', '? ask')
    this.lightbox = div('loom-lightbox')
    // Over the agent's own screen: the same bar as on the canvas, so switching views moves nothing.
    this.rawPill = div('loom-rawpill loom-sign', viewSwitch(true))
    // The canvas's size and colours, so the same bar renders the same.
    for (const k of ['--l-font-size', '--l-green', '--l-red', '--l-yellow', '--l-blue', '--l-magenta', '--l-cyan']) {
      const v = this.el.style.getPropertyValue(k)
      if (v) this.rawPill.style.setProperty(k, v)
    }

    // Focusable, so the keyboard can be on the canvas (Ctrl+↑) rather than in the terminal.
    this.el.tabIndex = -1
    this.el.append(this.scroller, this.rail, this.pinLayer, this.hint, this.sign, this.steps, this.jump, this.chip, this.pop, this.ctxMenu, this.drawer, this.lightbox)
    panes.append(this.el, this.frame, this.above, this.bar, this.barPick, this.rawPill)
    panes.classList.add('has-loom')
    session.el.classList.add('is-loom')

    this.wire()
    // Files dropped anywhere on the canvas: pictures attach to the message, others are
    // mentioned by path. Handled here, so the window's own drop (typing paths into the
    // shell) leaves them alone.
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files') && !!this.wrapper && this.mode === 'claude'
    for (const target of [this.el, this.frame, this.above]) {
      target.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      })
      target.addEventListener('drop', (e) => {
        if (!hasFiles(e) || e.defaultPrevented) return
        e.preventDefault()
        this.wrapper?.dropFiles([...(e.dataTransfer?.files ?? [])])
      })
    }
    this.renderSign()
    this.schedule()
    void window.ember.panel.origin().then((o) => (this.origin = o))
    void this.countTodos()
    void window.ember.notes.dir().then((d) => (this.notesDir = d))
    this.unsubs.push(
      window.ember.notes.onChanged((e) => {
        if (e.id.toLowerCase() === 'todo.md') void this.countTodos()
        // Changed elsewhere while the notebook shows it: redraw, unless you are typing in it.
        if (this.drawer.classList.contains('is-on') && !this.drawer.contains(document.activeElement)) void this.renderDrawer()
      })
    )
    this.renderSign()
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
    const ta = this.session.term.textarea
    if (ta) {
      const focus = () => {
        // On the canvas the agent's screen is not where the person types. Whatever put the
        // keyboard there (switching tabs, a click) puts it in Ember's composer instead.
        if (this.wrapper && this.mode === 'claude' && document.activeElement === ta) {
          this.wrapper.input.focus()
          return
        }
        this.frame.classList.toggle('is-focus', document.activeElement === ta)
      }
      ta.addEventListener('focus', focus)
      ta.addEventListener('blur', focus)
      this.unsubs.push(() => {
        ta.removeEventListener('focus', focus)
        ta.removeEventListener('blur', focus)
      })
    }
    this.sign.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-s]')
      if (b?.dataset['s'] === 'notes') {
        if (this.hooks.openPlace) this.hooks.openPlace('todo')
        else this.toggleDrawer()
      }
      else if (b?.dataset['s'] === 'older') this.stepTurn(-1)
      else if (b?.dataset['s'] === 'newer') this.stepTurn(1)
      else if (b?.dataset['s'] === 'now') {
        this.viewing = null
        this.restage()
      } else if (b?.dataset['s'] === 'clear') this.clearScreen()
      else if (b?.dataset['s'] === 'raw') this.setRaw(true)
      else if ((e.target as HTMLElement).closest('[data-view="cli"]')) this.setRaw(true)
    })
    this.bar.addEventListener('click', (e) => {
      if (this.wrapper && this.mode === 'claude') {
        this.barClickClaude(e.target as HTMLElement)
        return
      }
      // The mode chip cycles the permission mode, as Shift+Tab does.
      if ((e.target as HTMLElement).closest('.loom-bar-mode')) {
        window.ember.write(this.session.id, '\x1b[Z')
        this.session.focus()
      }
    })
    this.barPick.addEventListener('mousedown', (e) => e.preventDefault())
    this.barPick.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-model]')
      if (!b || !this.wrapper) return
      this.wrapper.setModel(b.dataset['model'] ?? '')
      this.closeBarPick()
      this.wrapper.input.focus()
    })
    const outsidePick = (e: MouseEvent) => {
      if (!this.barPick.classList.contains('is-on')) return
      const t = e.target as HTMLElement
      if (!this.barPick.contains(t) && !t.closest?.('.loom-bar-pickmodel')) this.closeBarPick()
    }
    window.addEventListener('mousedown', outsidePick, true)
    this.unsubs.push(() => window.removeEventListener('mousedown', outsidePick, true))
    const ro = new ResizeObserver(() => this.schedule())
    ro.observe(this.panes)
    this.unsubs.push(() => ro.disconnect())

    this.unsubs.push(
      window.ember.canvas.onFeed((f: CanvasFeed) => {
        if (f.tabId !== this.tabId) return
        if (f.kind === 'switch') this.feed.switchSession(f.first, f.fresh === true)
        else this.feed.add(f.lines)
        this.hint.classList.toggle('is-gone', !this.feed.isEmpty)
        this.restage()
        this.renderNow()
      }),
      window.ember.canvas.onMedia((m) => {
        if (m.tabId === this.tabId) void this.showMedia(m)
      }),
      window.ember.canvas.onAnnotate((a) => {
        if (a.tabId === this.tabId) void this.annotate(a)
      }),
      window.ember.canvas.onPoint((p) => {
        if (p.tabId && p.tabId !== this.tabId) return
        void this.pointAt(p)
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
      window.ember.canvas.onAgent((a) => {
        if (a.tabId !== this.tabId) return
        const ag = [...this.agents.values()].find((x) => x.agentId === a.agentId)
        if (!ag || ag.end) return
        if (a.action !== ag.action) {
          ag.action = a.action
          ag.steps.push(a.action)
          if (ag.steps.length > 8) ag.steps.shift()
          this.renderAgents()
        }
      }),
      window.ember.canvas.onCost((c) => {
        if (c.tabId !== this.tabId) return
        this.cost = c
        this.barKey = ''
      }),
      window.ember.claude.onStatus((s) => {
        if (s.tabId !== this.tabId) return
        this.status = s
        this.barKey = ''
      })
    )

    const onMessage = (e: MessageEvent) => {
      // Esc pressed inside an object's own frame (a click there took the keyboard into it):
      // the same as Esc on the canvas — off the object, full screen closed, back to typing.
      if ((e.data as { emberKey?: string } | null)?.emberKey === 'Escape') {
        if (this.full) this.fullscreen(this.full.piece, false)
        else if (this.kbd || this.kbdInline) this.kbdLeave()
        else this.session.focus()
        return
      }
      const zoomed = (e.data as { emberZoomed?: number } | null)?.emberZoomed
      if (typeof zoomed === 'number') {
        if (this.full?.piece.frame?.contentWindow === e.source) this.showZoom(zoomed)
        return
      }
      const found = (e.data as { emberFound?: { id: string; rect: { x: number; y: number; w: number; h: number } | null } } | null)?.emberFound
      if (found) {
        this.findWaiters.get(found.id)?.(found.rect)
        return
      }
      const status = (e.data as { emberDocStatus?: { id: string; ok: boolean; error: string; repaired: boolean } } | null)?.emberDocStatus
      if (status && [...this.frames].some((f) => f.contentWindow === e.source)) {
        window.ember.canvas.docStatus(status.id, { ok: status.ok, error: status.error, repaired: status.repaired })
        return
      }
      const todo = (e.data as { emberTodo?: { op: string; text?: string } } | null)?.emberTodo
      if (todo && [...this.frames].some((f) => f.contentWindow === e.source)) {
        void this.todoOp(todo.op, todo.text ?? '')
        return
      }
      const ctx = (e.data as { emberContext?: { x: number; y: number; text?: string; part?: string } } | null)?.emberContext
      if (ctx) {
        for (const f of this.frames) {
          if (f.contentWindow !== e.source) continue
          const r = f.getBoundingClientRect()
          const host = f.closest<HTMLElement>('.loom-piece, .loom-diagram')
          this.raiseFocused()
          for (const p of this.pinned) if (p.el === host) this.raise(p)
          if (host) this.menu(new DOMRect(r.left + ctx.x, r.top + ctx.y, 0, 0), host, ctx.text || undefined, ctx.part || undefined)
        }
        return
      }
      const h = (e.data as { emberDocHeight?: number } | null)?.emberDocHeight
      if (typeof h !== 'number') return
      for (const f of this.frames) {
        if (f.contentWindow !== e.source) continue
        // Sized by hand: the frame fills what it was given and scrolls inside.
        if (f.closest('.loom-piece.is-sized, .loom-liftable.is-sized')) continue
        const max = Number(f.dataset['max'] ?? 2400)
        const stick = this.atBottom()
        f.style.height = `${Math.max(36, Math.min(max, Math.ceil(h)))}px`
        if (stick) this.toBottom()
      }
    }
    window.addEventListener('message', onMessage)
    this.unsubs.push(() => window.removeEventListener('message', onMessage))

    // A click anywhere outside the menu closes it — the terminal, the sidebar, another
    // window. A click inside a diagram or page never reaches this window, but it takes the
    // focus away from it, which says the same thing.
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (this.ctxMenu.classList.contains('is-on') && !(t && this.ctxMenu.contains(t))) this.closeMenu()
      // The ask box goes too, unless something has been written in it.
      if (this.pop.classList.contains('is-on') && !(t && this.pop.contains(t)) && !this.pop.querySelector('textarea')?.value.trim()) this.closeAsk()
    }
    const away = () => {
      this.closeMenu()
      // A click inside a placed diagram or page takes the focus into its frame: that object
      // was just selected, so it comes to the front like any other.
      window.setTimeout(() => this.raiseFocused(), 0)
    }
    window.addEventListener('pointerdown', outside, true)
    this.el.addEventListener('focusin', () => this.raiseFocused())
    window.addEventListener('blur', away)
    this.unsubs.push(() => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', away)
    })

    const onKey = (e: KeyboardEvent) => this.key(e)
    window.addEventListener('keydown', onKey, true)
    this.unsubs.push(() => window.removeEventListener('keydown', onKey, true))

    this.scroller.addEventListener('scroll', () => {
      if (this.atBottom()) this.jump.classList.remove('is-on')
      this.chip.classList.remove('is-on')
    })
    // Not passive: the end of a push that changed the turn must not go on to scroll the new one.
    this.scroller.addEventListener('wheel', (e) => this.wheelTurns(e), { passive: false })
    this.jump.addEventListener('click', () => this.toBottom(true))
    this.rawPill.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-view="canvas"]')) this.setRaw(false)
    })

    this.el.addEventListener('click', (e) => this.click(e))
    this.el.addEventListener('contextmenu', (e) => this.context(e))
    this.el.addEventListener('mouseup', (e) => this.selection(e))
    this.chip.addEventListener('mousedown', (e) => e.preventDefault())
    this.chip.addEventListener('click', () => {
      const text = (window.getSelection()?.toString() ?? '').trim()
      if (text) this.ask(this.chip.getBoundingClientRect(), 'this', text)
      this.chip.classList.remove('is-on')
    })
    this.rail.addEventListener('click', (e) => {
      const dot = (e.target as HTMLElement).closest<HTMLElement>('[data-turn]')
      if (!dot) return
      const turns = this.feed.turns()
      const i = Number(dot.dataset['turn'])
      this.viewing = i >= turns.length - 1 ? null : (turns[i] ?? null)
      this.restage()
      this.session.focus()
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

  /**
   * Codex's input, as its TUI draws it (scripts/probe-agent-screens.mjs): the `›` line and
   * any continuation lines, a blank line, then its status lines ("GPT-6-Astra high · ~",
   * "? for shortcuts"). The slash and @ menus sit just above the prompt; an approval
   * prompt replaces the status lines with numbered choices, and is shown whole.
   */
  private findCodexDock(rows: string[]): Dock | null {
    let last = rows.length - 1
    while (last > 0 && !rows[last]!.trim()) last--
    let p = -1
    for (let y = last; y >= Math.max(0, last - 8); y--) {
      if (/^›\s/.test(rows[y]!) || rows[y] === '›') {
        p = y
        break
      }
    }
    if (p < 0) return null
    let q = p
    while (q + 1 <= last && rows[q + 1]!.trim() && /^\s{2}\S/.test(rows[q + 1]!) && !this.isCodexFooter([rows[q + 1]!])) q++
    const under = rows.slice(q + 1, last + 1)
    const dialog = under.some((r) => /^\s*›?\s*\d+\.\s/.test(r)) || !this.isCodexFooter(under)
    if (dialog) {
      // Something we do not frame (an approval, a picker): the block it sits in, whole.
      let top = p
      while (top - 1 > 3 && rows[top - 1]!.trim() && p - top < 18) top--
      return { top, bottom: last, dialog: true, box: null, open: -1, close: -1 }
    }
    // A menu attached above the prompt: a run of `/command` or `@file` lines, then one blank.
    let top = p
    let y = p - 1
    if (y > 3 && !rows[y]!.trim()) y--
    if (y > 3 && /^[›\s]\s?[/@]\S/.test(rows[y]!)) {
      let n = 0
      while (y > 3 && rows[y]!.trim() && n < 18) {
        y--
        n++
      }
      top = y + 1
    }
    return { top, bottom: last, dialog: false, box: [p, q], open: -1, close: -1, foot: q + 1 }
  }

  /** Codex's status lines: the model and folder, the shortcuts hint, a working line. */
  private isCodexFooter(below: string[]): boolean {
    const lines = below.filter((r) => r.trim())
    if (lines.length > 4) return false
    return lines.every((r) => /·|for shortcuts|esc to interrupt|context left|⚠|working|tab to queue/i.test(r) || r.trim().length < 3)
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

    // Which agent the shell said it started (Ember's shims announce it, and the shell's
    // next prompt says it has gone). Claude Code gets the canvas with Ember's composer;
    // Codex its framed screen under the canvas; any other agent its whole screen.
    const agent = this.session.announcedAgent
    // Told again once the folder is known: an agent started with the shell runs before
    // the first prompt has said where the shell is.
    const told = `${agent ?? ''}|${this.session.cwd}`
    if (told !== this.tabAgentSent) {
      const fresh = (this.tabAgentSent ?? '').split('|')[0] !== (agent ?? '')
      this.tabAgentSent = told
      if (fresh) this.tabAgentSince = Date.now()
      window.ember.canvas.tabAgent(this.tabId, agent && agent !== 'claude' ? agent : null, this.session.cwd || this.session.initialCwd || '', this.tabAgentSince)
    }
    const who = agentSpec(agent ?? 'claude').name.replace(/ (CLI|Code)$/, '')
    const hintText = this.hint.querySelector('.loom-hint-text')
    if (hintText && agent !== 'claude' && !hintText.textContent?.startsWith(who)) hintText.textContent = `${who} is here. Ask below — what it says and shows appears on this canvas.`
    let mode: Mode
    if (agent === 'claude') mode = 'claude'
    else if (agent) mode = agent === 'codex' ? 'agent' : 'app'
    else mode = buf.type === 'alternate' ? 'app' : 'shell'
    // An agent tab opened from Ctrl+K: the shell is covered until the agent's screen is up,
    // or until the shell's prompt shows (the agent exited or could not start: show why).
    if (this.session.startAgent && !this.agentUp) {
      if (mode === 'claude' || mode === 'agent' || this.session.prompts > 0) this.agentUp = true
      if (!this.starting.isConnected && !this.agentUp) {
        this.starting.innerHTML = `<span class="dot"></span><span>Starting ${escapeHtml(agentSpec(this.session.startAgent).name)}…</span>`
        this.panes.appendChild(this.starting)
        window.setTimeout(() => {
          this.agentUp = true
          this.starting.remove()
        }, 25_000)
      }
      if (this.agentUp) this.starting.remove()
    }
    this.claudeState(mode === 'claude')
    if (this.raw && (mode === 'claude' || mode === 'agent' || (mode === 'app' && !!agent))) mode = 'raw'
    if (mode === 'claude') {
      this.layoutClaude()
      return
    }
    if (pane.style.visibility) pane.style.visibility = ''

    let ty = 0
    let clip = 0
    let canvasH = 0
    let dock: Dock | null = null
    let mask = ''
    let frame: { top: number; height: number } | null = null
    let foot: string[] | null = null
    const gap = 4
    const rows = mode === 'agent' ? this.rowsText() : []

    // An agent with a screen profile (Codex) is framed: its own input, cut out of its
    // screen, in Ember's frame, its status lines said again in the bar.
    const codex = mode === 'agent' && agent === 'codex' ? this.findCodexDock(rows) : null
    // The shell is left exactly as PowerShell draws it: prompt at the top, output below.
    if (codex) {
      dock = codex
      const under = dock.foot !== undefined ? rows.slice(dock.foot, dock.bottom + 1) : null
      if (!dock.dialog && dock.box && under && this.isCodexFooter(under)) {
        const [b0, b1] = dock.box
        const boxTopPx = screenTop + b0 * cellH
        const bottomPx = screenTop + (b1 + 1) * cellH
        const frameH = Math.max(bottomPx - boxTopPx, INPUT_ROWS * cellH) + FRAME_PAD * 2
        ty = Math.max(0, paneH - BAR_H - 6 - frameH - boxTopPx + FRAME_PAD)
        const firstPx = Math.min(screenTop + dock.top * cellH, boxTopPx)
        clip = Math.max(0, firstPx - FRAME_PAD - 4)
        canvasH = Math.max(0, clip + ty - 4)
        frame = { top: boxTopPx + ty - FRAME_PAD, height: frameH }
        const typed = (rows[b0] ?? '').replace(/^\s*[❯›>]\s?/, '').trim()
        const empty = b0 === b1 && !typed
        this.frame.classList.toggle('is-empty', empty)
        if (empty) {
          const cw = sr.width / term.cols
          this.frame.style.setProperty('--ph-left', `${(sr.left - pr.left - 10 + cw * 2).toFixed(1)}px`)
          this.frame.style.setProperty('--ph-top', `${FRAME_PAD}px`)
          this.frame.style.setProperty('--ph-h', `${cellH.toFixed(1)}px`)
        }
        mask = `linear-gradient(to bottom, #000 0, #000 ${bottomPx.toFixed(1)}px, transparent ${bottomPx.toFixed(1)}px)`
        foot = under
      } else {
        const topPx = screenTop + dock.top * cellH
        const bottomPx = screenTop + (dock.bottom + 1) * cellH
        ty = Math.max(0, paneH - gap - bottomPx)
        clip = Math.max(0, topPx - 3)
        canvasH = Math.max(0, clip + ty)
      }
    } else if (mode === 'agent') {
      // Another agent's screen is not guessed at: the last rows it drew — its input and
      // status, whatever they look like — are shown whole under the canvas.
      let last = rows.length - 1
      while (last > 0 && !(rows[last] ?? '').trim()) last--
      const first = Math.max(0, last - AGENT_ROWS + 1)
      const topPx = screenTop + first * cellH
      const bottomPx = screenTop + (last + 1) * cellH
      ty = Math.max(0, paneH - gap - bottomPx)
      clip = Math.max(0, topPx - 3)
      canvasH = Math.max(0, clip + ty)
    }

    const showCanvas = mode === 'agent'
    this.setMode(mode, showCanvas)
    // The switch stays while an agent's own screen is shown, whatever it looks like.
    this.rawPill.classList.toggle('is-on', mode === 'raw' || (mode === 'app' && !!agent))
    pane.style.transform = ty ? `translate3d(0, ${ty.toFixed(1)}px, 0)` : ''
    const clipCss = clip ? `inset(${clip.toFixed(1)}px 0 0 0)` : ''
    // (Compared with what was set, not with style.clipPath, which the browser rewrites.)
    if (this.clipCss !== clipCss) {
      this.clipCss = clipCss
      pane.style.clipPath = clipCss
      // Rows just uncovered were drawn while hidden, and the WebGL buffer did not keep
      // them: draw them again, or they stay blank.
      requestAnimationFrame(() => this.session.repaint())
    }
    pane.style.maskImage = mask
    if (showCanvas) this.sizeCanvas(canvasH)
    this.el.classList.toggle('is-dialog', !!dock?.dialog)
    this.dock = dock
    const left = pane.offsetLeft
    const width = pane.offsetWidth
    this.frame.classList.remove('is-native')
    this.frame.classList.toggle('is-on', showCanvas && !!frame)
    this.above.classList.remove('is-on')
    if (showCanvas && frame) {
      Object.assign(this.frame.style, {
        left: `${left + 10}px`,
        width: `${width - 20}px`,
        top: `${(pane.offsetTop + frame.top).toFixed(1)}px`,
        height: `${frame.height.toFixed(1)}px`,
      })
    }
    this.bar.classList.toggle('is-on', showCanvas && !!foot)
    if (showCanvas && foot) {
      Object.assign(this.bar.style, {
        left: `${left + 10}px`,
        width: `${width - 20}px`,
        top: `${(pane.offsetTop + paneH - BAR_H - 2).toFixed(1)}px`,
        height: `${BAR_H}px`,
      })
      this.renderBar(foot)
    }
  }

  /** A new mode: the canvas on or off, the pane told it moved. */
  private setMode(mode: Mode, showCanvas: boolean): void {
    if (mode === this.mode) return
    const was = this.mode
    this.mode = mode
    this.el.classList.toggle('is-on', showCanvas)
    this.panes.dataset['loom'] = mode
    if (showCanvas) this.restage()
    this.renderSign()
    // Leaving the canvas for the agent's own screen: the keyboard goes with it.
    if (was === 'claude' && mode === 'raw' && this.hooks.isActive()) this.session.term.focus()
    // The pane just moved under a new transform and clip (or came out from under the
    // canvas). The WebGL drawing buffer is not preserved across composites (see
    // Session.repaint), so draw every row afresh rather than trusting what was there.
    requestAnimationFrame(() => this.session.repaint())
  }

  private sizeCanvas(px: number): void {
    const h = `${Math.max(0, px).toFixed(1)}px`
    if (this.el.style.height === h) return
    this.el.style.height = h
    for (const p of this.pinned) if (!p.snap) this.settlePin(p)
    this.layoutSnaps(false)
    if (this.pinned.size) this.reflow()
  }

  // ---------------------------------------------------------------- Claude Code on the canvas

  /** Claude Code is running in the tab's shell (announced, and no prompt since). */
  private claudeOn = false

  /** Claude Code started or stopped in the tab's shell: its wrapper is told, made the first time. */
  private claudeState(on: boolean): void {
    if (on === this.claudeOn) return
    this.claudeOn = on
    if (on) {
      if (!this.wrapper) {
        this.wrapper = new ClaudeTui({
          tabId: this.tabId,
          feed: this.feed,
          frame: this.frame,
          above: this.above,
          term: this.session.term,
          write: (d) => window.ember.write(this.session.id, d),
          cwd: () => this.session.cwd || this.session.initialCwd || '',
          inCli: () => this.raw,
          openCli: () => this.setRaw(true),
          changed: () => this.wrapperChanged(),
          cleared: () => {
            this.feed.switchSession(false, true)
            this.hint.classList.toggle('is-gone', !this.feed.isEmpty)
            this.restage()
            this.renderNow()
          },
          relayout: () => this.schedule(),
          toast: (t) => this.hooks.toast(t),
        })
        const input = this.wrapper.input
        const nf = () => this.frame.classList.toggle('is-focus', document.activeElement === input)
        input.addEventListener('focus', nf)
        input.addEventListener('blur', nf)
      } else this.wrapper.started()
      const input = this.wrapper.input
      this.session.focusInstead = () => (this.raw ? this.session.term.focus() : input.focus())
      if (this.hooks.isActive() && !this.raw) requestAnimationFrame(() => input.focus())
    } else {
      this.wrapper?.ended()
      this.session.focusInstead = null
      this.frame.classList.remove('is-on', 'is-native')
      this.above.classList.remove('is-on')
      this.bar.classList.remove('is-on')
      this.closeBarPick()
      // Back to the shell: the keyboard goes to its prompt.
      if (this.hooks.isActive()) requestAnimationFrame(() => this.session.term.focus())
    }
    this.hooks.changed?.()
  }

  /**
   * Claude Code's canvas: nothing of its screen. The canvas takes the tab down to Ember's
   * composer, with the bar under it; the terminal keeps its full size underneath, out of
   * sight, so Claude Code lays itself out as it always does.
   */
  private layoutClaude(): void {
    const w = this.wrapper
    const pane = this.session.el
    const paneH = pane.clientHeight
    if (!paneH || !w) return
    pane.style.visibility = 'hidden'
    pane.style.transform = ''
    if (this.clipCss) {
      this.clipCss = ''
      pane.style.clipPath = ''
    }
    pane.style.maskImage = ''
    this.dock = null
    this.setMode('claude', true)
    this.rawPill.classList.remove('is-on')
    this.el.classList.remove('is-dialog')
    w.screen()
    const left = pane.offsetLeft
    const width = pane.offsetWidth
    const frameH = Math.max(w.input.offsetHeight, 20) + FRAME_PAD * 2
    const frameTop = pane.offsetTop + paneH - BAR_H - 6 - frameH
    this.frame.classList.add('is-on', 'is-native')
    this.frame.classList.remove('is-empty')
    this.above.classList.add('is-on')
    this.bar.classList.add('is-on')
    Object.assign(this.frame.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${frameTop.toFixed(1)}px`, height: `${frameH.toFixed(1)}px` })
    Object.assign(this.above.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${frameTop.toFixed(1)}px` })
    Object.assign(this.bar.style, { left: `${left + 10}px`, width: `${width - 20}px`, top: `${(pane.offsetTop + paneH - BAR_H - 2).toFixed(1)}px`, height: `${BAR_H}px` })
    this.sizeCanvas(frameTop - pane.offsetTop - 8)
    this.renderBarClaude()
    this.claudeHint()
  }

  /** The wrapper's state changed: the working line, the bar, the hint. */
  private wrapperChanged(): void {
    const s = this.wrapper?.state
    if (!s) return
    const was = this.working
    this.working = s.phase === 'working' || !!s.live
    this.spin = s.live ? { ...s.live } : { glyph: '✻', verb: s.phase === 'starting' ? 'Starting…' : 'Working…', detail: '' }
    const hint = this.hint.querySelector('.loom-hint-text')
    if (hint && this.claudeOn)
      hint.textContent = s.phase === 'starting' ? 'Starting Claude Code…' : 'Claude Code is here. Ask below — what it says and shows appears on this canvas.'
    this.claudeHint()
    this.renderNow()
    if (was !== this.working) {
      this.restage()
      this.trail.classList.toggle('is-on', this.working && this.trail.childElementCount > 0)
      if (!this.working) this.clearTrail()
    }
    this.barKey = ''
    if (this.bar.classList.contains('is-on') && this.mode === 'claude') this.renderBarClaude()
    this.hooks.changed?.()
  }

  /** "Claude Code is here": only on an empty canvas with nothing open over it. */
  private claudeHint(): void {
    const w = this.wrapper
    if (!w || !this.claudeOn) return
    const open = w.busy || this.barPick.classList.contains('is-on') || this.ctxMenu.classList.contains('is-on') || this.drawer.classList.contains('is-on')
    this.hint.classList.toggle('is-gone', !this.feed.isEmpty || w.state.phase === 'working' || w.state.phase === 'asking' || open)
  }

  /** The bar: the permission mode (a switch), the model (a picker), context used, what it is doing. */
  private renderBarClaude(): void {
    const s = this.wrapper?.state
    const st = this.status
    const key = `claude|${s?.phase}|${s?.mode}|${s?.model}|${s?.effort}|${st?.at ?? ''}|${this.cost?.tokens ?? ''}`
    if (key === this.barKey) return
    this.barKey = key
    const modes: Record<string, [string, string]> = {
      bypassPermissions: ['bypass', 'is-bypass'],
      acceptEdits: ['accept edits', 'is-edits'],
      plan: ['plan', 'is-plan'],
      auto: ['auto', 'is-auto'],
      dontAsk: ["don't ask", 'is-auto'],
    }
    const [label, cls] = modes[s?.mode ?? ''] ?? ['default', 'is-default']
    const phase =
      s?.phase === 'starting' ? 'starting…' : s?.phase === 'working' ? 'working · esc to interrupt' : s?.phase === 'asking' ? 'waiting for you' : s?.phase === 'exited' ? 'exited' : 'ready'
    const parts: string[] = []
    parts.push(`<button type="button" class="loom-bar-mode ${cls}" title="Permission mode — click or Shift+Tab to cycle"><i></i>${escapeHtml(label)}</button>`)
    const name = st?.model || s?.model || 'Claude Code'
    const size = st?.contextSize && st.contextSize >= 1_000_000 && !/context|1M/i.test(name) ? ' 1M' : ''
    if (this.wrapper?.models().length) parts.push(`<button type="button" class="loom-bar-model loom-bar-pickmodel" title="Model — click to switch">${escapeHtml(name)}${size}<span class="loom-bar-caret">▾</span></button>`)
    else parts.push(`<span class="loom-bar-model">${escapeHtml(name)}${size}</span>`)
    if (s?.effort) parts.push(`<span class="loom-bar-effort" title="Effort (/effort to change)">${escapeHtml(s.effort)}</span>`)
    if (st?.contextPercent != null) {
      const p = Math.max(0, Math.min(100, Math.round(st.contextPercent)))
      parts.push(`<span class="loom-bar-ctx${p >= 80 ? ' is-high' : ''}" title="Context used"><i style="--p:${p}%"></i>${p}%</span>`)
    }
    if (st?.costUsd != null) parts.push(`<span class="loom-bar-cost" title="This session, all of it">$${st.costUsd.toFixed(2)}</span>`)
    parts.push(`<span class="loom-bar-rest">${escapeHtml(phase)}</span>`)
    this.bar.innerHTML = parts.join('')
  }

  private barClickClaude(t: HTMLElement): void {
    const w = this.wrapper
    if (!w) return
    if (t.closest('.loom-bar-mode')) {
      w.cycleMode()
      w.input.focus()
    } else if (t.closest('.loom-bar-pickmodel')) {
      if (this.barPick.classList.contains('is-on')) this.closeBarPick()
      else this.openBarPick(t.closest<HTMLElement>('.loom-bar-pickmodel')!)
    }
  }

  /** The model picker: Claude Code's own list, above the bar. Picking types `/model <it>`. */
  private openBarPick(anchor: HTMLElement): void {
    const w = this.wrapper
    if (!w) return
    const current = (this.status?.model || w.state.model).toLowerCase()
    this.barPick.innerHTML = w
      .models()
      .map((m) => {
        const on = !!current && (m.displayName.toLowerCase() === current || m.value.toLowerCase() === current)
        return (
          `<button type="button" role="option" data-model="${escapeHtml(m.value)}" class="${on ? 'is-on' : ''}" aria-selected="${on}">` +
          `<b>${escapeHtml(m.displayName || m.value)}</b><span>${escapeHtml(m.description ?? '')}</span></button>`
        )
      })
      .join('')
    const pr = this.panes.getBoundingClientRect()
    const ar = anchor.getBoundingClientRect()
    const br = this.bar.getBoundingClientRect()
    this.barPick.style.left = `${Math.max(8, ar.left - pr.left - 8).toFixed(0)}px`
    this.barPick.style.bottom = `${(pr.bottom - br.top + 6).toFixed(0)}px`
    this.barPick.classList.add('is-on')
    this.claudeHint()
  }

  private closeBarPick(): boolean {
    if (!this.barPick.classList.contains('is-on')) return false
    this.barPick.classList.remove('is-on')
    this.claudeHint()
    return true
  }

  /** For the sidebar card: Claude Code in the tab, its folder and the session's name. */
  get claudeCard(): { folder: string; title: string; cli: boolean } | null {
    if (!this.claudeOn || !this.wrapper) return null
    return { folder: this.session.cwd || this.session.initialCwd || '', title: this.wrapper.state.title, cli: this.raw }
  }

  /** Words for the session, as the person: through the composer on Claude's canvas, else typed. */
  private type(text: string, submit: boolean): void {
    if (this.wrapper && this.claudeOn) {
      if (submit) this.wrapper.send(text)
      else this.wrapper.put(text)
      return
    }
    this.hooks.send(text, submit)
  }

  private onAgentEvent(e: Parameters<NonNullable<import('./Feed').FeedContext['agent']>>[0]): void {
    if (e.kind === 'start') {
      if (this.agents.has(e.key)) return
      const t = Date.parse(e.at) || Date.now()
      this.agents.set(e.key, { key: e.key, desc: e.desc, type: e.type, start: t, action: '', steps: [], summary: '' })
    } else if (e.kind === 'id') {
      const ag = this.agents.get(e.key)
      if (ag) ag.agentId = e.agentId
    } else {
      const ag = e.key ? this.agents.get(e.key) : [...this.agents.values()].find((x) => x.agentId === e.agentId)
      if (!ag || ag.end) return
      ag.end = Date.parse(e.at) || Date.now()
      ag.ok = e.ok
      ag.summary = e.summary
    }
    this.renderAgents()
  }

  /**
   * `/clear`: the conversation started over, so does the canvas — the turns (and with them
   * the rail), the plan, the subagents and the trail. Objects you pinned or snapped are yours,
   * not the conversation's, and stay where you put them.
   */
  private onCleared(): void {
    this.viewing = null
    this.shown = null
    this.liveTurn = null
    this.trailTurn = null
    this.trailSeen = 0
    this.clearTrail()
    if (this.expanded && !this.expanded.el.isConnected) this.expanded = null
    for (const [k, p] of this.pieces) {
      if (this.pinned.has(p) || p.el.isConnected) continue
      if (p.frame) this.frames.delete(p.frame)
      this.pieces.delete(k)
    }
    for (let i = this.browsers.length - 1; i >= 0; i--) if (!this.browsers[i]!.piece.el.isConnected) this.browsers.splice(i, 1)
    this.agents.clear()
    this.renderAgents()
    this.setTodos([])
    this.renderRail()
    this.reportScreen()
  }

  private agentTimer = 0

  /** The pills: running ones first; finished ones stay a while as small chips. */
  private renderAgents(): void {
    const now = Date.now()
    const list = [...this.agents.values()].filter((a) => !a.end || now - a.end < 20 * 60_000).slice(-8)
    this.agentsRow.classList.toggle('is-on', list.length > 0)
    const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
    const keep = new Set<string>()
    for (const a of list) {
      keep.add(a.key)
      let pill = this.agentsRow.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.key)}"]`)
      if (!pill) {
        pill = div('loom-agent')
        pill.dataset['k'] = a.key
        pill.addEventListener('click', () => this.agentDetail(a.key, pill!))
        this.agentsRow.appendChild(pill)
      }
      const state = a.end ? (a.ok === false ? 'failed' : 'done') : 'running'
      pill.dataset['state'] = state
      pill.innerHTML =
        `<span class="m"></span><span class="d">${escapeHtml(a.desc)}</span>` +
        (state === 'running' && a.action ? `<span class="a">${escapeHtml(a.action)}</span>` : '') +
        `<span class="t">${dur((a.end ?? now) - a.start)}</span>`
    }
    this.agentsRow.querySelectorAll<HTMLElement>('.loom-agent').forEach((p) => {
      if (!keep.has(p.dataset['k'] ?? '')) p.remove()
    })
    const running = list.some((a) => !a.end)
    if (running && !this.agentTimer) this.agentTimer = window.setInterval(() => this.renderAgents(), 1000)
    if (!running && this.agentTimer) {
      window.clearInterval(this.agentTimer)
      this.agentTimer = 0
    }
  }

  /** One agent's last steps and, once it has finished, what it said. */
  private agentDetail(key: string, pill: HTMLElement): void {
    const a = this.agents.get(key)
    if (!a) return
    const r = pill.getBoundingClientRect()
    const host = this.el.getBoundingClientRect()
    this.pop.innerHTML =
      `<div class="loom-pop-about">${escapeHtml(a.desc)}${a.type ? ` <span style="opacity:.6">· ${escapeHtml(a.type)}</span>` : ''}</div>` +
      (a.steps.length ? `<ol class="loom-agent-steps">${a.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="loom-pop-quote">No steps seen yet.</div>') +
      (a.summary ? `<div class="loom-agent-sum">${renderMarkdown(a.summary).html}</div>` : '')
    this.pop.style.left = `${Math.min(host.width - 380, Math.max(12, r.left - host.left))}px`
    this.pop.style.top = `${Math.min(host.height - 220, r.bottom - host.top + 8)}px`
    this.pop.classList.add('is-on')
  }

  private spin = { glyph: '', verb: '', detail: '' }
  private reelAnim: Animation | null = null
  private nowText = ''

  private trailTurn: HTMLElement | null = null

  /**
   * One more sentence of what Claude is saying while it works. It slides in at the
   * bottom; the ones before it drift up, smaller and fainter, and the oldest leave. The
   * whole trail goes when the turn ends, and the final answer takes its place.
   */
  private narrate(text: string): void {
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line) return
    const first = line.length > 220 ? `${line.slice(0, 217).replace(/\s+\S*$/, '')}…` : line
    const item = div('loom-trail-item', `<span class="loom-trail-dot"></span><span class="loom-trail-text">${escapeHtml(first)}</span>`)
    this.trail.appendChild(item)
    const items = [...this.trail.querySelectorAll<HTMLElement>('.loom-trail-item:not(.is-leaving)')]
    items.forEach((el, i) => {
      const age = items.length - 1 - i
      el.dataset['age'] = String(Math.min(age, 3))
      if (age > 3) {
        el.classList.add('is-leaving')
        window.setTimeout(() => el.remove(), 360)
      }
    })
    this.trail.classList.toggle('is-on', this.working)
  }

  private clearTrail(): void {
    const items = [...this.trail.children] as HTMLElement[]
    for (const el of items) el.classList.add('is-leaving')
    window.setTimeout(() => items.forEach((el) => el.remove()), 360)
  }

  /** One line, large: what the session is doing this moment. It replaces itself; nothing piles up. */
  private renderNow(): void {
    const action = this.working ? this.feed.action || this.spin.verb : ''
    // Always in the turn while it works, plan or no plan: the plan can be in an earlier
    // turn, minimized, removed, or holding a step the agent left "in progress" long ago,
    // and the turn you are looking at must still say what is happening now.
    this.now.classList.toggle('is-on', !!action)
    if (!action) {
      this.nowText = ''
      return
    }
    // One window, one line tall, and a strip inside it that rolls: the new words come up
    // from below as the old ones leave the top, as one piece, like an odometer's wheel.
    let line = this.now.querySelector<HTMLElement>('.loom-now-line')
    if (!line) {
      line = div('loom-now-line', `<span class="loom-now-glyph"></span><span class="loom-reel"><span class="loom-reel-track"></span></span>`)
      this.now.prepend(line)
    }
    const glyph = line.querySelector<HTMLElement>('.loom-now-glyph')!
    if (this.spin.glyph || !glyph.textContent) glyph.textContent = this.spin.glyph || '✻'
    if (action !== this.nowText) {
      const first = !this.nowText
      this.nowText = action
      const track = line.querySelector<HTMLElement>('.loom-reel-track')!
      this.reelAnim?.finish()
      const row = document.createElement('span')
      row.className = 'loom-reel-row'
      row.textContent = action
      track.appendChild(row)
      if (first || track.children.length < 2) {
        while (track.children.length > 1) track.firstElementChild?.remove()
      } else {
        const h = (track.firstElementChild as HTMLElement).offsetHeight
        const a = track.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-h}px)` }], {
          duration: reduced() ? 1 : 460,
          easing: 'cubic-bezier(0.25, 1.25, 0.4, 1)',
        })
        this.reelAnim = a
        a.onfinish = () => {
          while (track.children.length > 1) track.firstElementChild?.remove()
          this.reelAnim = null
        }
      }
    }
    let d = this.now.querySelector<HTMLElement>('.loom-now-detail')
    if (!d) {
      d = div('loom-now-detail')
      this.now.appendChild(d)
    }
    if (d.textContent !== this.spin.detail) d.textContent = this.spin.detail
    this.tickPlan()
  }

  /** Claude Code says it is mid-turn. */
  private working = false

  /** Ctrl+`: the real TUI, whole, or back to the canvas. */
  setRaw(on: boolean): void {
    if (on === this.raw) return
    this.raw = on
    this.hooks.saveView?.(on ? 'cli' : 'canvas')
    // At once, not on the next frame: the switch only shows or hides the screen of the
    // one process both views share, and it should feel like it.
    this.layout()
    this.wrapper?.view(on)
    if (on) this.session.term.focus()
    else this.session.focus()
    this.hooks.changed?.()
  }

  // ================================================================ keys and pointer

  private key(e: KeyboardEvent): void {
    if (this.disposed || !this.hooks.isActive()) return
    if (this.kbd || this.kbdInline) {
      this.kbdKey(e)
      return
    }
    // Ctrl+↑ from the input: into the results, onto the newest object.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'ArrowUp' && (this.mode === 'claude' || this.mode === 'agent')) {
      e.preventDefault()
      e.stopPropagation()
      const list = this.kbdList()
      if (list.length) this.kbdSelect(list[list.length - 1]!)
      else this.hooks.toast('Nothing on this turn to select yet')
      return
    }
    const tgt = e.target as HTMLElement | null
    const inLoomInput =
      tgt?.closest?.('.loom-pop, .loom-note-edit, .loom-picker, .loom-menu, .loom-drawer') != null ||
      (!!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) && !tgt.closest('.xterm'))
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyN' && (this.mode === 'claude' || this.mode === 'agent' || this.mode === 'shell')) {
      e.preventDefault()
      e.stopPropagation()
      if (this.mode === 'claude' || this.mode === 'agent') void this.newSticky()
      else if (this.hooks.openPlace) this.hooks.openPlace('notes')
      else this.toggleDrawer('notes')
      return
    }
    if (e.ctrlKey && !e.altKey && e.code === 'Backquote') {
      if (this.mode === 'claude' || this.mode === 'agent' || this.mode === 'raw') {
        e.preventDefault()
        e.stopPropagation()
        this.setRaw(!this.raw)
      }
      return
    }
    // Ctrl+C with text selected on the canvas copies it — it does not reach Claude Code as
    // an interrupt.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') {
      const sel = window.getSelection()
      const text = (sel?.toString() ?? '').trim()
      if (text && sel?.anchorNode && (this.el.contains(sel.anchorNode) || this.modal.contains(sel.anchorNode))) {
        e.preventDefault()
        e.stopPropagation()
        void navigator.clipboard.writeText(sel.toString())
        this.hooks.toast('Copied')
        return
      }
    }
    if (this.mode !== 'claude' && this.mode !== 'agent') return
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      this.stepTurn(e.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (inLoomInput && e.key !== 'Escape') return
    if (e.key === 'Escape') {
      // Esc is Claude Code's interrupt. Only take it when something of ours is open.
      if (this.closeBarPick() || this.closeOverlays() || (this.wrapper && this.mode === 'claude' && this.wrapper.escape())) {
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
    if (this.drawer.classList.contains('is-on')) {
      this.closeDrawer()
      return true
    }
    if (this.full) {
      this.fullscreen(this.full.piece, false)
      return true
    }
    if (this.ctxMenu.classList.contains('is-on')) {
      this.closeMenu()
      return true
    }
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
    // The click that opened the menu (⋯) reaches here too; it must not close it again.
    if (!t.closest('.loom-menu, [data-p="more"]')) this.closeMenu()
    // A picture from another server, held back until asked for (markdown.ts, remoteImage).
    // This click is the asking: only now does anything request it.
    const remote = t.closest<HTMLElement>('.loom-img-remote')
    if (remote) {
      e.preventDefault()
      e.stopPropagation()
      const img = document.createElement('img')
      img.className = 'loom-img'
      img.alt = remote.dataset['alt'] ?? ''
      img.dataset['zoom'] = '1'
      img.src = remote.dataset['src'] ?? ''
      remote.replaceWith(img)
      return
    }
    const act = t.closest<HTMLElement>('.loom-act')
    if (act) {
      e.preventDefault()
      this.type(act.dataset['send'] ?? act.textContent ?? '', act.dataset['submit'] !== '0')
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
    const host = t.closest<HTMLElement>('.loom-piece, .loom-liftable, [data-ask-label], .loom-figure, .loom-code, .loom-table, .loom-tool, .loom-say')
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
    const sel = (window.getSelection()?.toString() ?? '').trim()
    this.menu(new DOMRect(e.clientX, e.clientY, 0, 0), host, sel || quote, undefined, label)
  }

  /** The object a host element is, as the session knows it: a title and a kind. */
  private objectOf(host: HTMLElement): { label: string; piece: Piece | null; title: string } {
    const piece = [...this.pieces.values(), ...this.pinned].find((p) => p.el === host) ?? null
    if (piece) {
      const kind = piece.format === 'mermaid' ? 'diagram' : piece.format === 'url' ? 'page' : piece.format === 'html' ? 'page' : piece.format
      return { label: `the "${piece.title}" ${kind}`, piece, title: piece.title }
    }
    if (host.classList.contains('loom-liftable')) {
      const title = this.nameObject(host)
      const kind = this.kindOf(host)
      return { label: `the "${title}" ${kind === 'mermaid' ? 'diagram' : kind}`, piece: null, title }
    }
    return { label: host.dataset['askLabel'] ?? 'this', piece: null, title: '' }
  }

  /**
   * The context menu on anything Claude made: ask about it, have it changed, place it on
   * the screen or take it off. Right-click anywhere on it, inside a diagram or page too.
   */
  private menu(at: DOMRect, host: HTMLElement, quote?: string, part?: string, fallback?: string): void {
    const obj = this.objectOf(host)
    const label = obj.title ? obj.label : (fallback ?? obj.label)
    const about = part ? `${label}, the part "${part}"` : label
    const pinned = !!obj.piece && this.pinned.has(obj.piece)
    const canPlace = !pinned && (!!obj.piece || host.classList.contains('loom-liftable'))
    // The actions, as a grid of tiles under the question box.
    const tiles: Array<[string, string, string, () => void]> = []
    if ((quote ?? '').trim()) tiles.unshift(['copy', ICON.note, 'Copy', () => void navigator.clipboard.writeText(quote ?? '').then(() => this.hooks.toast('Copied'))])
    if (obj.piece) tiles.push(['full', ICON.expand, 'Full screen', () => this.fullscreen(obj.piece!, true)])
    if (canPlace)
      tiles.push(['place', ICON.pin, 'Place', () => {
        const p = obj.piece ?? this.liftObject(host)
        if (!p) return
        this.pin(p)
        this.settlePin(p)
      }])
    if (obj.piece) {
      const min = obj.piece.el.classList.contains('is-min')
      tiles.push(['min', min ? ICON.restore : ICON.fold, min ? 'Restore' : 'Minimize', () => this.minimize(obj.piece!)])
    }
    for (const [id, text, run] of obj.piece?.extra ?? []) tiles.push([id, id === 'reload' ? ICON.reload : ICON.out, text.replace('Open in your browser', 'Open outside'), run])
    // Only a real note (a file in the notes folder) can be edited here; any other .md is shown, not edited.
    if (obj.piece?.file && this.notesDir && obj.piece.file.toLowerCase().startsWith(this.notesDir.toLowerCase()) && /\.md$/i.test(obj.piece.file) && !/todo\.md$/i.test(obj.piece.file))
      tiles.push(['edit', ICON.edit, 'Edit note', () => void this.editNote(obj.piece!)])
    const words = (quote ?? '').trim() || (obj.title ? obj.title : '')
    void words
    const keep = (quote ?? '').trim() || obj.piece?.source || (host.classList.contains('loom-say') ? host.innerText : '')
    if (keep) tiles.push(['note', ICON.note, host.classList.contains('loom-say') && !quote ? 'Save answer' : 'Save note', () => void this.saveToNote(keep, obj.title)])
    if (pinned && obj.piece) tiles.push(['remove', ICON.close, 'Remove', () => this.unpin(obj.piece!)])

    this.ctxMenu.innerHTML =
      `<div class="loom-menu-head">${escapeHtml(part ? `${obj.title || label} · ${part}` : obj.title || label)}</div>` +
      `<div class="loom-menu-ask"><textarea rows="1" spellcheck="false" placeholder="${obj.title ? 'Ask about this, or say what to change…' : 'Ask about this…'}"></textarea>` +
      `<div class="loom-menu-hint">${obj.title ? 'A question is answered here · anything else changes it' : 'Answered here, without interrupting the session'}</div></div>` +
      `<div class="loom-menu-answer"></div>` +
      `<div class="loom-menu-grid">${tiles.map(([id, icon, text]) => `<button type="button" data-m="${id}">${icon}<span>${escapeHtml(text)}</span></button>`).join('')}</div>`
    const box = this.ctxMenu.querySelector('textarea')!
    const answer = this.ctxMenu.querySelector<HTMLElement>('.loom-menu-answer')!
    let mode: 'ask' | 'change' = 'ask'
    const _setMode = (m: 'ask' | 'change') => {
      mode = m
      box.placeholder = m === 'change' ? 'What should change? (Enter sends it to the session)' : 'Ask about this…'
      this.ctxMenu.classList.toggle('is-change', m === 'change')
      box.focus()
    }
    void _setMode
    for (const [id, , , run] of tiles) {
      this.ctxMenu.querySelector(`[data-m="${id}"]`)?.addEventListener('click', () => {
        if (id !== 'change') this.closeMenu()
        run()
      })
    }
    box.addEventListener('input', () => {
      box.style.height = 'auto'
      box.style.height = `${Math.min(140, box.scrollHeight)}px`
    })
    box.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeMenu()
        return
      }
      if (e.key !== 'Enter' || e.shiftKey) return
      e.preventDefault()
      const q = box.value.trim()
      if (!q) return
      const quoted = quote ? ` — “${quote.replace(/\s+/g, ' ').slice(0, 600)}”` : ''
      // A question is answered here; anything else is a change, and goes to the session.
      const question = /\?\s*$/.test(q) || /^(what|why|how|when|where|who|which|is|are|was|were|can|could|does|do|did|should|would|will|explain|tell me|describe|summari[sz]e|compare)/i.test(q)
      if (obj.title && !question) mode = 'change'
      if (mode === 'change') {
        this.type(`Change ${about}${quoted}: ${q}. It is on my screen as "${obj.title}" — change it in place (edit_panel, or show_panel with that title); do not make a new one.`, true)
        this.closeMenu()
        return
      }
      // A side question: answered here, in the popup, by a short run of its own.
      box.disabled = true
      answer.classList.add('is-on', 'is-busy')
      answer.innerHTML = `<span class="loom-menu-dots"><i></i><i></i><i></i></span>`
      const source = (quote ?? '').trim() || obj.piece?.source || host.dataset['source'] || (host.innerText ?? '').slice(0, 6000)
      void window.ember.canvas.sideAsk(q, about, source, this.session.cwd || undefined).then((r) => {
        answer.classList.remove('is-busy')
        answer.innerHTML = r.ok && r.text ? renderMarkdown(r.text).html : `<p class="err">${escapeHtml(r.error || 'No answer came back.')}</p>`
        box.disabled = false
        box.value = ''
        box.placeholder = 'Ask a follow-up…'
        box.focus()
      })
    })
    // Over a full-screen object the menu opens above it, in the window's coordinates.
    if (this.full) {
      if (this.ctxMenu.parentElement !== this.modal) this.modal.appendChild(this.ctxMenu)
      this.ctxMenu.classList.add('is-floating')
      this.ctxMenu.style.left = `${Math.min(window.innerWidth - 340, Math.max(8, at.left))}px`
      this.ctxMenu.style.top = `${Math.min(window.innerHeight - 300, Math.max(8, at.top))}px`
    } else {
      if (this.ctxMenu.parentElement !== this.el) this.el.appendChild(this.ctxMenu)
      this.ctxMenu.classList.remove('is-floating')
      const bounds = this.el.getBoundingClientRect()
      this.ctxMenu.style.left = `${Math.min(bounds.width - 340, Math.max(8, at.left - bounds.left))}px`
      this.ctxMenu.style.top = `${Math.min(bounds.height - 260, Math.max(8, at.top - bounds.top))}px`
    }
    this.ctxMenu.classList.remove('is-change')
    this.ctxMenu.classList.add('is-on')
    box.focus()
  }

  private closeMenu(): void {
    this.ctxMenu.classList.remove('is-on')
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

  private ask(at: DOMRect, about: string, quote?: string, mode: 'ask' | 'change' = 'ask', title = ''): void {
    const host = this.el.getBoundingClientRect()
    const change = mode === 'change'
    this.pop.innerHTML =
      `<div class="loom-pop-about">${change ? 'Change' : 'Ask about'} ${escapeHtml(about)}</div>` +
      (quote ? `<div class="loom-pop-quote">${escapeHtml(quote.length > 240 ? `${quote.slice(0, 240)}…` : quote)}</div>` : '') +
      `<textarea rows="2" placeholder="${change ? 'What should change?' : 'What do you want to know?'}" spellcheck="false"></textarea>` +
      `<div class="loom-pop-foot"><span><kbd>Enter</kbd> ${change ? 'change it' : 'ask'}</span><span><kbd>Esc</kbd> close</span></div>`
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
        const quoted = quote ? ` — “${quote.replace(/\s+/g, ' ').slice(0, 600)}”` : ''
        const context = change
          ? `Change ${about}${quoted}: ${q}. It is on my screen as "${title}" — change it in place (edit_panel, or show_panel with that title); do not make a new one.`
          : `About ${about}${quoted} — ${q}`
        this.type(context, true)
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
    // Native mode has no transcript feed to clear the hint; the first message does.
    if (this.claudeOn) this.claudeHint()
    this.restage()
    if (this.pinned.size) this.reflow()
    // The stage starts at the top of the turn, your words first. It follows what is
    // added only once you have gone to its end yourself.
    const s = this.scroller
    if (s.scrollTop > 0 && this.atBottom()) requestAnimationFrame(() => this.toBottom())
    else if (s.scrollHeight - s.scrollTop - s.clientHeight > 56) this.jump.classList.add('is-on')
  }

  // ================================================================ the stage

  private shown: HTMLElement | null = null
  /** A turn you stepped back to; null follows the turn in progress. */
  private viewing: HTMLElement | null = null
  private liveTurn: HTMLElement | null = null

  /** Step through the turns: -1 older, +1 newer. Reaching the newest follows it again. */
  stepTurn(dir: number): void {
    const turns = this.feed.turns()
    if (!turns.length) return
    const at = turns.indexOf(this.shown ?? turns[turns.length - 1]!)
    const next = Math.max(0, Math.min(turns.length - 1, at + dir))
    this.viewing = next === turns.length - 1 ? null : turns[next]!
    this.restage()
  }

  // ---------------------------------------------------------------- the wheel walks the turns
  // The canvas holds one turn, but the chat still reads as one column: scroll past the top
  // of a turn and the one before it comes down, landing at its end; scroll past the bottom
  // and the next comes up. It takes a deliberate push past the edge, and a turn changes at
  // most once per push, so a touchpad's momentum never skips several.
  private wheelPush = 0
  private wheelIdle = 0
  private wheelRest = 0

  private wheelTurns(e: WheelEvent): void {
    if (e.ctrlKey || this.full || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
    const dir = e.deltaY < 0 ? -1 : 1
    // Something inside that scrolls on its own (code, a wide table) gets the wheel first.
    for (let n = e.target as HTMLElement | null; n && n !== this.scroller; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
        if (dir < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return
      }
    }
    const s = this.scroller
    const atEdge = dir < 0 ? s.scrollTop <= 0 : s.scrollTop + s.clientHeight >= s.scrollHeight - 1
    const now = performance.now()
    // Right after a change the wheel is still the same push: let it run out, without
    // scrolling the turn that just arrived (it starts at its top, or its end going back).
    if (now < this.wheelRest) {
      this.wheelRest = now + 260
      e.preventDefault()
      return
    }
    const turns = this.feed.turns()
    const at = turns.indexOf(this.shown ?? turns[turns.length - 1]!)
    const canGo = dir < 0 ? at > 0 : at >= 0 && at < turns.length - 1
    if (!atEdge || !canGo) {
      this.wheelPush = 0
      this.pull(0)
      return
    }
    // Pushing past the edge toward another turn: the wheel is ours, so the event that
    // changes the turn does not then scroll the turn it brought.
    e.preventDefault()
    // Pixels and lines both count, in pixels.
    this.wheelPush += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 40 : 1)
    window.clearTimeout(this.wheelIdle)
    this.wheelIdle = window.setTimeout(() => {
      this.wheelPush = 0
      this.pull(0)
    }, 220)
    const need = 260
    this.pull((dir * Math.min(this.wheelPush, need)) / need)
    if (this.wheelPush < need) return
    this.wheelPush = 0
    this.wheelRest = now + 420
    this.pull(0)
    this.stepTurn(dir)
    // Going back up lands at the end of the earlier turn, as scrolling up a chat would.
    if (dir < 0) s.scrollTop = s.scrollHeight
    const shown = this.shown
    if (shown && !reduced()) {
      shown.classList.remove('is-from-above', 'is-from-below')
      void shown.offsetWidth
      shown.classList.add(dir < 0 ? 'is-from-above' : 'is-from-below')
    }
  }

  /** The rubber-band give while pushing past an edge: -1 up … 1 down, 0 at rest. */
  private pull(p: number): void {
    if (reduced()) return
    const el = this.feed.el
    el.classList.toggle('is-pulling', p !== 0)
    el.style.transform = p ? `translateY(${(-p * 22).toFixed(1)}px)` : ''
  }

  /**
   * The canvas is a stage, not a log: it holds the turn in progress and nothing older.
   * Within it, your words, what Claude says now (its latest words replace the earlier
   * ones), and whatever it has shown. The steps it takes are not listed: the one it is
   * taking is the large line at the foot, and every step is in the real terminal (Ctrl+`).
   */
  private restage(): void {
    const turns = this.feed.turns()
    const newest = turns[turns.length - 1] ?? null
    // A new turn brings you back to now, wherever you were.
    if (newest !== this.liveTurn) {
      this.liveTurn = newest
      this.viewing = null
    }
    if (this.viewing && !this.viewing.isConnected) this.viewing = null
    const live = this.viewing ?? newest
    if (live !== this.shown) {
      this.shown?.classList.remove('is-shown')
      live?.classList.add('is-shown')
      this.shown = live
      this.scroller.scrollTop = 0
      this.jump.classList.remove('is-on')
      this.renderSign()
      queueMicrotask(() => this.reportScreen())
    }
    this.el.classList.toggle('is-past', !!this.viewing)
    if (!live) return
    live.querySelectorAll<HTMLElement>(LIFTABLE).forEach((found) => {
      // A picture is wrapped so it can carry its handle.
      let d = found
      if (d.tagName === 'IMG') {
        if (d.parentElement?.classList.contains('loom-liftable')) return
        const wrap = document.createElement('span')
        wrap.className = 'loom-liftable loom-img-wrap'
        d.replaceWith(wrap)
        wrap.appendChild(d)
        d = wrap
      }
      if (d.dataset['pin'] || d.closest('.loom-piece')) return
      d.dataset['pin'] = '1'
      d.classList.add('loom-liftable')
      const name = this.nameObject(d)
      // One grip only, on "Drag out": the name stays a plain label.
      const lift = div('loom-lift', `<span class="loom-lift-name">${escapeHtml(name)}</span><span class="loom-lift-hint">${ICON.grip}Drag out</span>`)
      lift.title = 'Drag it out of the reply — place it anywhere, or at an edge to snap it. Right-click for more'
      lift.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        d.classList.add('is-peeling')
        const off = () => {
          d.classList.remove('is-peeling')
          window.removeEventListener('pointerup', off, true)
        }
        window.addEventListener('pointerup', off, true)
        this.drag(() => this.liftObject(d), lift, e)
      })
      d.appendChild(lift)
      // Sized where it sits, without taking it out: every edge and corner, as when placed.
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const h = div('loom-rz')
        h.dataset['rz'] = dir
        h.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          this.resizeInlineHost(d, dir, e)
        })
        d.appendChild(h)
      }
    })
    const says = live.querySelectorAll<HTMLElement>(':scope > .loom-say')
    says.forEach((el, i) => {
      const last = i === says.length - 1
      el.classList.toggle('is-current', last)
      // Earlier messages are mostly the agent narrating its steps, and give way to the last
      // one. One that holds a result stays: a long agent often writes its findings, works on,
      // and ends with a short line that refers back to them.
      el.classList.toggle('is-kept', !last && holdsResult(el))
    })
    // A new turn starts a new trail; while it works, each new sentence joins it.
    if (live !== this.trailTurn) {
      this.trailTurn = live
      this.trailSeen = this.viewing ? says.length : 0
      this.clearTrail()
    }
    if (!this.viewing) {
      for (let i = this.trailSeen; i < says.length; i++) this.narrate(says[i]!.innerText)
      this.trailSeen = says.length
    }
    // What is happening now belongs to the newest turn only. An earlier turn you step back
    // to keeps exactly what it had: its words shown, no live line, nothing of the current work.
    for (const t of turns) t.classList.toggle('is-working', this.working && t === newest)
    if (newest) {
      const board = newest.querySelector(':scope > .loom-board')
      if (this.activity.parentElement !== newest || (board && this.activity.nextElementSibling !== board)) newest.insertBefore(this.activity, board)
    }
    this.renderRail()
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
    // Until the document has drawn, the object shimmers in its own shape.
    host.classList.add('is-loading')
    f.addEventListener('load', () => window.setTimeout(() => host.classList.remove('is-loading'), 160), { once: true })
    // Drawn in the theme on screen: its accent, ink and ground, not the panel's purple.
    f.src = url.includes('?') ? url : `${url}${docTone()}`
    host.appendChild(f)
    this.frames.add(f)
    return f
  }

  private makePiece(host: HTMLElement, title: string, format: string, actions: string[] = []): Piece {
    const el = div(`loom-piece is-${format}`)
    el.dataset['title'] = title
    const head = div('loom-piece-head')
    const kind = format === 'url' ? 'page' : format === 'media' ? 'media' : format === 'ask' ? 'question' : format
    // The bar is the title and three quiet controls, shown on hover. Everything else —
    // ask, change, place, see through, reload — is in the menu (⋯ or right-click).
    void actions
    head.title = 'Drag it out of the reply — place it anywhere, or at an edge to snap it there'
    head.innerHTML =
      `<span class="loom-piece-icon">${iconFor(format)}</span>` +
      `<span class="loom-piece-title">${escapeHtml(title)}</span>` +
      `<span class="loom-lift-hint">${ICON.grip}Drag out</span>` +
      `<span class="loom-piece-acts">` +
      `<button type="button" data-p="expand" title="Full screen (Esc to return)">${ICON.expand}</button>` +
      `<button type="button" data-p="fold" class="loom-min-btn" title="Minimize to its bar (double-click the bar)">${ICON.fold}</button>` +
      `<button type="button" data-p="more" title="More">${ICON.more}</button>` +
      `<button type="button" data-p="close" class="loom-close-btn" title="Remove from the screen">${ICON.close}</button></span>`
    const body = div('loom-piece-body')
    el.append(head, body)
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = div('loom-rz')
      h.dataset['rz'] = d
      el.appendChild(h)
    }
    host.appendChild(el)
    const piece: Piece = { el, body, title, format }
    el.addEventListener('pointerdown', (e) => {
      const h = (e.target as HTMLElement).closest<HTMLElement>('.loom-rz')
      if (!h || e.button !== 0) return
      const dir = h.dataset['rz'] ?? 'se'
      if (!this.pinned.has(piece)) {
        // In the reply: any edge or corner sizes it in place.
        e.preventDefault()
        e.stopPropagation()
        this.resizeInline(piece, dir, e)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      this.resize(piece, dir, h, e)
    })
    head.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.minimize(piece)
    })
    el.addEventListener('pointerdown', () => this.raise(piece), true)
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
      // It lifts a little the moment it is held: it can come out of the reply.
      if (!this.pinned.has(piece)) {
        el.classList.add('is-peeling')
        const off = () => {
          el.classList.remove('is-peeling')
          window.removeEventListener('pointerup', off, true)
          window.removeEventListener('pointercancel', off, true)
        }
        window.addEventListener('pointerup', off, true)
        window.addEventListener('pointercancel', off, true)
      }
      this.drag(() => piece, head, e)
    })
    head.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button') && el.parentElement?.classList.contains('is-shelved')) {
        this.focusOn(piece)
        return
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-p]')
      if (!b) return
      const what = b.dataset['p']
      if (what === 'more') this.menu(b.getBoundingClientRect(), el)
      else if (what === 'fade') this.fade(piece)
      else if (what === 'pin') {
        this.pin(piece)
        this.settlePin(piece)
      }
      else if (what === 'close') {
        if (this.pinned.has(piece)) this.unpin(piece)
        else this.dismiss(piece)
      }
      else if (what === 'fold') {
        // From full screen: leave it first, then fold to the bar.
        if (this.full?.piece === piece) {
          this.fullscreen(piece, false)
          window.setTimeout(() => this.minimize(piece, true), 220)
        } else this.minimize(piece)
      }
      else if (what === 'expand') this.fullscreen(piece, this.full?.piece !== piece)
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
      requestAnimationFrame(() => this.reveal(piece.el, 'start'))
    }
  }

  // ================================================================ pinned objects

  /** Lift a piece off the stage and onto the screen, where it was, at a size that leaves room. */
  private pin(piece: Piece, glide = true): void {
    if (this.pinned.has(piece)) return
    const host = this.el.getBoundingClientRect()
    const r = piece.el.getBoundingClientRect()
    const w = Math.round(Math.min(r.width, Math.max(380, host.width * 0.42), host.width - 24))
    if (this.expanded === piece) this.expand(piece, false)
    if (!piece.el.closest('.loom-diagram')) this.heal(piece.el, r.height)
    piece.el.classList.remove('is-folded', 'is-min')
    piece.el.classList.add('is-pinned')
    // Moving a frame reloads its document; the bridge still holds it, so it comes back as it was.
    this.pinLayer.appendChild(piece.el)
    this.pinned.add(piece)
    this.raise(piece)
    this.pinObserver.observe(piece.el)
    // The document reloads in its new place; tell it to fit the box rather than run long.
    const f = piece.frame
    if (f) f.addEventListener('load', () => f.contentWindow?.postMessage({ emberFit: true }, '*'))
    piece.el.style.height = `${Math.round(Math.max(160, Math.min(r.height, host.height - 24)))}px`
    this.place2(piece, r.left - host.left + (r.width - w), r.top - host.top, w)
    this.renderSign()
    if (glide) {
      const n = piece.el.getBoundingClientRect()
      piece.el.animate(
        [
          { transform: `translate(${r.left - n.left}px, ${r.top - n.top}px) scale(${Math.min(1.2, r.width / Math.max(1, n.width))})`, transformOrigin: 'top left', opacity: 0.6 },
          { transform: 'none', transformOrigin: 'top left', opacity: 1 },
        ],
        { duration: ms(340), easing: EASE }
      )
    }
  }

  /**
   * Minimize to the title bar, or back. The height glides; the body stays visible while it
   * closes so nothing blinks, and the text takes the room back once it has.
   */
  private minimize(piece: Piece, on?: boolean): void {
    const el = piece.el
    const head = el.querySelector<HTMLElement>('.loom-piece-head')
    if (!head) return
    const closing = on ?? !el.classList.contains('is-min')
    if (closing === el.classList.contains('is-min')) return
    const pinned = this.pinned.has(piece)
    const from = el.offsetHeight
    let to: number
    if (closing) {
      if (pinned) el.dataset['h'] = String(from)
      to = head.offsetHeight + 2
    } else {
      el.classList.remove('is-min')
      if (pinned) to = Number(el.dataset['h'] ?? 0) || 320
      else {
        el.style.height = ''
        to = el.offsetHeight
      }
    }
    el.style.height = `${to}px`
    el.classList.add('is-animating')
    const btn = head.querySelector('.loom-min-btn')
    if (btn) btn.innerHTML = closing ? ICON.restore : ICON.fold
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ms(300), easing: EASE })
    a.onfinish = () => {
      el.classList.remove('is-animating')
      if (closing) el.classList.add('is-min')
      if (!pinned && !closing) el.style.height = ''
      if (!pinned && closing) el.style.height = ''
      if (piece.snap) this.layoutSnaps()
      this.reflow()
    }
  }

  private place2(piece: Piece, left: number, top: number, width?: number): void {
    const host = this.el.getBoundingClientRect()
    const st = piece.el.style
    if (width) st.width = `${width}px`
    const w = piece.el.offsetWidth || width || 380
    const min = this.railWidth() + 6
    st.left = `${Math.round(Math.max(min, Math.min(host.width - w - 6, left)))}px`
    st.top = `${Math.round(Math.max(this.chromeTop(), Math.min(host.height - 40, top)))}px`
  }

  /** Take a pinned piece off the screen for good. */
  private unpin(piece: Piece, delay = 0): void {
    if (!this.pinned.delete(piece)) return
    this.planClosed(piece)
    if (this.full?.piece === piece) this.fullscreen(piece, false)
    if (piece.snap) {
      this.snaps[piece.snap] = this.snaps[piece.snap].filter((p) => p !== piece)
      piece.snap = null
      window.setTimeout(() => this.layoutSnaps(), ms(delay + 120))
    }
    const out = piece.el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.96) translateY(6px)' },
      ],
      { duration: ms(220), delay: ms(delay), easing: EASE, fill: 'forwards' }
    )
    out.onfinish = () => {
      piece.el.remove()
      this.reflow()
    }
    if (piece.frame) this.frames.delete(piece.frame)
    for (const [k, v] of this.pieces) if (v === piece) this.pieces.delete(k)
    const i = this.browsers.findIndex((b) => b.piece === piece)
    if (i >= 0) this.browsers.splice(i, 1)
    this.pinObserver.unobserve(piece.el)
    this.renderSign()
    this.reflow()
    this.reportScreen()
  }

  /** Take an object off the board: it fades, and the board closes up. */
  private dismiss(piece: Piece): void {
    this.planClosed(piece)
    const el = piece.el
    const h = el.offsetHeight
    const out = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: ms(200), easing: EASE, fill: 'forwards' })
    out.onfinish = () => {
      this.heal(el, h)
      el.remove()
      if (piece.frame) this.frames.delete(piece.frame)
      for (const [k, v] of this.pieces) if (v === piece) this.pieces.delete(k)
      const i = this.browsers.findIndex((b) => b.piece === piece)
      if (i >= 0) this.browsers.splice(i, 1)
      this.reportScreen()
    }
  }

  /** Clear screen: every pinned object goes. What is on the stage stays. */
  clearScreen(): void {
    ;[...this.pinned].forEach((p, i) => this.unpin(p, i * 45))
  }

  /**
   * Drag by the title bar. A piece on the stage is pinned the moment it starts to move,
   * so taking it and putting it somewhere is all it takes. Let go near an edge and it docks
   * there, and the text makes room; anywhere else it floats over the text.
   */
  /**
   * Follow the pointer until it is let go — whatever happens to the element it started on.
   * A full-window shield takes every pointer event for the duration (frames, pages and the
   * live browser included), and the gesture always ends: on release, on cancel, when the
   * window loses focus, or when the pointer leaves the window. Moves are applied once per
   * frame.
   */
  private track(e: PointerEvent, cursor: string, onMove: (ev: PointerEvent) => void, onEnd: () => void): void {
    const shield = div('loom-shield')
    shield.style.cursor = cursor
    document.body.appendChild(shield)
    let last: PointerEvent | null = null
    let raf = 0
    let ended = false
    const flush = () => {
      raf = 0
      if (last && !ended) onMove(last)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      last = ev
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const end = () => {
      if (ended) return
      ended = true
      if (raf) cancelAnimationFrame(raf)
      if (last) onMove(last)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('blur', end)
      document.documentElement.removeEventListener('mouseleave', end)
      shield.remove()
      onEnd()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('blur', end)
    document.documentElement.addEventListener('mouseleave', end)
  }

  /**
   * Drag by the title bar. A piece on the stage is pinned the moment it starts to move,
   * so taking it and putting it somewhere is all it takes. At an edge it snaps there.
   */
  private drag(get: () => Piece | null, _handle: HTMLElement, e: PointerEvent): void {
    const sx = e.clientX
    const sy = e.clientY
    let piece: Piece | null = null
    let snapSide: Side | null = null
    let snapAt = 0
    let lastSlot = ''
    let ox = 0
    let oy = 0
    this.track(
      e,
      'grabbing',
      (ev) => {
        if (!piece) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
          piece = get()
          if (!piece) return
          // No easing while it is held: it follows the pointer exactly.
          piece.el.classList.add('is-dragging')
          this.el.classList.add('is-dragging')
          this.pin(piece, false)
          piece.dock = null
          // Taken out of a snap: back to its own size, and the edge closes up behind it.
          if (piece.snap) this.unsnap(piece)
          piece.el.style.zIndex = String(++this.z)
          const r = piece.el.getBoundingClientRect()
          ox = Math.min(Math.max(sx - r.left, 12), r.width - 12)
          oy = Math.min(Math.max(sy - r.top, 8), 30)
          this.reflow()
        }
        const host = this.el.getBoundingClientRect()
        this.place2(piece, ev.clientX - host.left - ox, ev.clientY - host.top - oy)
        // At an edge: show where it would snap.
        const side = this.snapSideAt(ev.clientX, ev.clientY, piece)
        snapSide = side
        // It goes where the pointer is among what is there already, not at the end.
        const at = side ? this.snapIndexAt(side, ev.clientX, ev.clientY, piece) : 0
        const slot = side ? `${side}:${at}` : ''
        const moved = slot !== lastSlot
        lastSlot = slot
        snapAt = at
        // Leaving the edge: the others close up again.
        if (moved && !side) this.layoutSnaps()
        if (side) {
          const list = this.snaps[side].filter((p) => p !== piece)
          list.splice(snapAt, 0, piece)
          const trial = { ...this.snaps, [side]: list } as Record<Side, Piece[]>
          // The others on that edge move apart to make room, once per new slot.
          if (moved) this.layoutSnaps(true, trial, piece)
          const r = this.snapRects(trial).get(piece)
          if (r) {
            Object.assign(this.preview.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
            if (!this.preview.isConnected) this.el.appendChild(this.preview)
            this.preview.classList.add('is-on')
          }
        } else this.preview.classList.remove('is-on')
      },
      () => {
        this.el.classList.remove('is-dragging')
        this.preview.classList.remove('is-on')
        if (!piece) return
        piece.el.classList.remove('is-dragging')
        if (snapSide) this.snapTo(piece, snapSide, snapAt)
        else this.settlePin(piece)
      }
    )
  }

  private z = 10

  /** An agent's canvas is showing (not the plain shell): its keys are the canvas's. */
  get onCanvas(): boolean {
    return this.mode === 'claude' || this.mode === 'agent' || !!this.kbd || !!this.kbdInline
  }

  /** Whether the session is working right now, for Ember on the phone. */
  get busy(): boolean {
    return this.working
  }

  // ================================================================ snapping

  /** Up to four objects per edge, in order; the edge is split between them. */
  private readonly snaps: Record<Side, Piece[]> = { left: [], right: [], top: [], bottom: [] }
  private static readonly SNAPS_PER_EDGE = 4
  private readonly preview = div('loom-snap-preview')

  /** How deep an edge's snaps are: a third of the width for a side, two fifths of the height for a band. */
  private readonly snapSize: Partial<Record<Side, number>> = {}

  /** The strip across the top that the buttons sit in: nothing is placed over it. */
  private chromeTop(): number {
    const r = this.sign.getBoundingClientRect()
    const host = this.el.getBoundingClientRect()
    return r.height ? Math.round(r.bottom - host.top + 8) : 48
  }

  /** The film strip of turns down the left takes this much; nothing is placed over it. */
  private railWidth(): number {
    return this.rail.classList.contains('is-on') ? 38 : 0
  }

  private snapDepth(side: Side): number {
    const W = this.el.clientWidth
    const H = this.el.clientHeight
    const set = this.snapSize[side]
    if (set) return side === 'left' || side === 'right' ? Math.round(Math.max(240, Math.min(set, W * 0.6))) : Math.round(Math.max(110, Math.min(set, H * 0.7)))
    return side === 'left' || side === 'right' ? Math.round(Math.max(280, Math.min(W * 0.34, W * 0.5))) : Math.round(Math.max(150, Math.min(H * 0.42, H * 0.6)))
  }

  /** Where every snapped object goes, for a given arrangement. Sides take the full height; bands run between them. */
  private snapRects(snaps: Record<Side, Piece[]>): Map<Piece, { left: number; top: number; width: number; height: number }> {
    const W = this.el.clientWidth
    const H = this.el.clientHeight
    const g = 8
    const out = new Map<Piece, { left: number; top: number; width: number; height: number }>()
    const lw = snaps.left.length ? this.snapDepth('left') : 0
    const rw = snaps.right.length ? this.snapDepth('right') : 0
    const rail = this.railWidth()
    // The buttons across the top right take a strip; nothing snaps under them.
    const top0 = this.chromeTop()
    const split = (list: Piece[], total: number) => {
      // A minimized object keeps only its bar; the others share what is left.
      const heads = list.map((p) => (p.el.classList.contains('is-min') ? (p.el.querySelector<HTMLElement>('.loom-piece-head')?.offsetHeight ?? 34) + 2 : 0))
      const open = list.filter((_, i) => !heads[i]).length
      const free = total - (list.length - 1) * g - heads.reduce((a, b) => a + b, 0)
      return list.map((_, i) => heads[i] || Math.max(60, free / Math.max(1, open)))
    }
    for (const side of ['left', 'right'] as const) {
      const list = snaps[side]
      if (!list.length) continue
      const w = side === 'left' ? lw : rw
      const sizes = split(list, H - top0 - g)
      let y = top0
      list.forEach((p, i) => {
        out.set(p, { left: side === 'left' ? rail + g : W - g - w, top: y, width: w, height: sizes[i]! })
        y += sizes[i]! + g
      })
    }
    const x0 = rail + (lw ? g + lw + g : g)
    const x1 = W - (rw ? g + rw + g : g)
    for (const side of ['top', 'bottom'] as const) {
      const list = snaps[side]
      if (!list.length) continue
      const h = this.snapDepth(side)
      const each = (x1 - x0 - (list.length - 1) * g) / list.length
      list.forEach((p, i) => {
        const min = p.el.classList.contains('is-min')
        const ph = min ? (p.el.querySelector<HTMLElement>('.loom-piece-head')?.offsetHeight ?? 34) + 2 : h
        out.set(p, { left: x0 + i * (each + g), top: side === 'top' ? top0 : H - g - ph, width: each, height: ph })
      })
    }
    return out
  }

  /**
   * Put every snapped object where it belongs, gliding there. With a trial arrangement
   * (while one is dragged to an edge) the others make room for it; the dragged one itself
   * stays under the pointer.
   */
  private layoutSnaps(animate = true, snaps = this.snaps, skip?: Piece): void {
    for (const [p, r] of this.snapRects(snaps)) {
      if (p === skip) continue
      const el = p.el
      const from = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
      const to = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      Object.assign(el.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` })
      const moved = Math.abs(from.left - to.left) + Math.abs(from.top - to.top) + Math.abs(from.width - to.width) + Math.abs(from.height - to.height) > 2
      if (animate && moved) {
        el.animate(
          [
            { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
            { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` },
          ],
          { duration: ms(300), easing: EASE }
        )
      }
    }
  }

  /** The edge the pointer is at, if an object dropped there could snap to it. */
  private snapSideAt(x: number, y: number, piece: Piece): Side | null {
    const r = this.el.getBoundingClientRect()
    const gaps: Array<[Side, number]> = [
      ['left', x - r.left],
      ['right', r.right - x],
      ['top', y - r.top],
      ['bottom', r.bottom - y],
    ]
    gaps.sort((a, b) => a[1] - b[1])
    const [side, d] = gaps[0]!
    if (d > 56) return null
    return this.snaps[side].filter((p) => p !== piece).length < LoomView.SNAPS_PER_EDGE ? side : null
  }

  /**
   * Where along an edge a dropped object goes: before the first object whose middle is
   * past the pointer (below it on a side, to its right on a band), so it lands where you
   * let go — above the one already there, between two, or after them.
   */
  private snapIndexAt(side: Side, x: number, y: number, piece: Piece): number {
    const vertical = side === 'left' || side === 'right'
    const list = this.snaps[side].filter((p) => p !== piece)
    const i = list.findIndex((p) => {
      const r = p.el.getBoundingClientRect()
      return vertical ? y < r.top + r.height / 2 : x < r.left + r.width / 2
    })
    return i < 0 ? list.length : i
  }

  private unsnap(piece: Piece): void {
    const side = piece.snap
    if (!side) return
    this.snaps[side] = this.snaps[side].filter((p) => p !== piece)
    piece.snap = null
    piece.el.classList.remove('is-snapped')
    delete piece.el.dataset['snap']
    if (piece.free) {
      piece.el.style.width = `${piece.free.w}px`
      if (!piece.el.classList.contains('is-min')) piece.el.style.height = `${piece.free.h}px`
    }
    this.layoutSnaps()
  }

  /** Snap to an edge, at a place along it (the end when not given). */
  private snapTo(piece: Piece, side: Side, at?: number): void {
    if (!piece.free) piece.free = { w: piece.el.offsetWidth, h: piece.el.offsetHeight }
    piece.snap = side
    piece.dock = side
    piece.el.classList.add('is-snapped')
    piece.el.dataset['snap'] = side
    piece.el.style.zIndex = '1'
    const list = this.snaps[side].filter((p) => p !== piece)
    list.splice(Math.max(0, Math.min(at ?? list.length, list.length)), 0, piece)
    this.snaps[side] = list
    this.layoutSnaps()
    this.reflow()
    this.reportScreen()
  }

  /**
   * Resize from any edge or corner. A floating object grows or shrinks on the side you
   * pull; a snapped one only from its inner edge, which sets how deep its whole edge is.
   * The words are laid out again when you let go.
   */
  /** Size an inline object (a diagram, a table, code) where it sits in the reply. */
  private resizeInlineHost(host: HTMLElement, dir: string, e: PointerEvent): void {
    const frame = host.querySelector<HTMLIFrameElement>(':scope > iframe')
    if (!frame) host.style.overflow = 'auto'
    this.sizeInPlace(host, frame ?? host, dir, e)
  }

  /** Size an object where it sits in the reply: its width in the column, its height. */
  private resizeInline(piece: Piece, dir: string, e: PointerEvent): void {
    const frame = piece.body.querySelector<HTMLIFrameElement>('iframe')
    if (frame) frame.style.height = '100%'
    this.sizeInPlace(piece.el, piece.body, dir, e)
  }

  /**
   * The placed object's resize, inside the reply: the edge you pull follows the pointer.
   * The right edge grows out to the canvas's edge, the bottom one freely; the left and top ones move within the space
   * the object already has (it cannot leave its column or climb over the words above).
   */
  private sizeInPlace(box: HTMLElement, tall: HTMLElement, dir: string, e: PointerEvent): void {
    // Wider than the words if you want: out to the canvas's right edge.
    const col = Math.max(
      box.parentElement?.clientWidth || 0,
      this.scroller.getBoundingClientRect().right - box.getBoundingClientRect().left - 24
    )
    const w0 = box.offsetWidth
    const h0 = tall.offsetHeight
    const ml0 = parseFloat(box.style.marginLeft) || 0
    const mt0 = parseFloat(box.style.marginTop) || 0
    const sx = e.clientX
    const sy = e.clientY
    const clamp = (lo: number, hi: number, v: number) => Math.round(Math.max(lo, Math.min(hi, v)))
    box.classList.add('is-sized', 'is-resizing')
    const cursor = dir === 'n' || dir === 's' ? 'ns-resize' : dir === 'e' || dir === 'w' ? 'ew-resize' : dir === 'ne' || dir === 'sw' ? 'nesw-resize' : 'nwse-resize'
    this.track(
      e,
      cursor,
      (ev) => {
        const dx = ev.clientX - sx
        const dy = ev.clientY - sy
        if (dir.includes('e')) box.style.width = `${clamp(240, col - ml0, w0 + dx)}px`
        if (dir.includes('w')) {
          const w = clamp(240, ml0 + w0, w0 - dx)
          box.style.width = `${w}px`
          box.style.marginLeft = `${ml0 + w0 - w}px`
        }
        if (dir.includes('s')) tall.style.height = `${clamp(80, 2400, h0 + dy)}px`
        if (dir.includes('n')) {
          const h = clamp(80, h0 + mt0, h0 - dy)
          tall.style.height = `${h}px`
          box.style.marginTop = `${mt0 + h0 - h}px`
        }
      },
      () => {
        box.classList.remove('is-resizing')
        this.grew()
      }
    )
  }

  private resize(piece: Piece, dir: string, _handle: HTMLElement, e: PointerEvent): void {
    const el = piece.el
    const W = this.el.clientWidth
    const H = this.el.clientHeight
    const l0 = el.offsetLeft
    const t0 = el.offsetTop
    const w0 = el.offsetWidth
    const h0 = el.offsetHeight
    const minW = 240
    const minH = el.classList.contains('is-min') ? h0 : 90
    const sx = e.clientX
    const sy = e.clientY
    this.el.classList.add('is-dragging')
    el.classList.add('is-resizing')
    const cursor = dir === 'n' || dir === 's' ? 'ns-resize' : dir === 'e' || dir === 'w' ? 'ew-resize' : dir === 'ne' || dir === 'sw' ? 'nesw-resize' : 'nwse-resize'
    this.track(
      e,
      piece.snap ? (piece.snap === 'left' || piece.snap === 'right' ? 'ew-resize' : 'ns-resize') : cursor,
      (ev) => {
        const dx = ev.clientX - sx
        const dy = ev.clientY - sy
        if (piece.snap) {
          const side = piece.snap
          this.snapSize[side] = side === 'left' ? w0 + dx : side === 'right' ? w0 - dx : side === 'top' ? h0 + dy : h0 - dy
          this.layoutSnaps(false)
          return
        }
        let l = l0
        let t = t0
        let w = w0
        let h = h0
        if (dir.includes('e')) w = Math.min(W - l0 - 4, Math.max(minW, w0 + dx))
        if (dir.includes('w')) {
          w = Math.min(l0 + w0 - 4, Math.max(minW, w0 - dx))
          l = l0 + (w0 - w)
        }
        if (dir.includes('s')) h = Math.min(H - t0 - 4, Math.max(minH, h0 + dy))
        if (dir.includes('n')) {
          h = Math.min(t0 + h0 - 4, Math.max(minH, h0 - dy))
          t = t0 + (h0 - h)
        }
        Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` })
      },
      () => {
        this.el.classList.remove('is-dragging')
        el.classList.remove('is-resizing')
        if (!piece.snap) piece.free = { w: el.offsetWidth, h: el.offsetHeight }
        this.reflow()
      }
    )
  }

  // ================================================================ full screen

  private readonly modal = div('loom-modal')
  private full: { piece: Piece; home: Node; next: Node | null } | null = null
  /** Zoom while full screen: − 100% +, and the same from the wheel (Ctrl or a pinch), + − 0 and a double-click. */
  private readonly zoomBar = div(
    'loom-zoom',
    `<button type="button" data-z="out" title="Zoom out (−)">−</button><button type="button" data-z="reset" class="loom-zoom-pct" title="Back to fit (0)">100%</button><button type="button" data-z="in" title="Zoom in (+)">+</button>`
  )
  private localZoom = 1

  private showZoom(z: number): void {
    const pct = this.zoomBar.querySelector('.loom-zoom-pct')
    if (pct) pct.textContent = `${Math.round(z * 100)}%`
  }

  /** Zoom what is full screen: a document zooms itself; anything else is scaled here. */
  private zoomFull(op: 'in' | 'out' | 'reset', at?: { x: number; y: number }, factor?: number): void {
    const piece = this.full?.piece
    if (!piece) return
    if (piece.frame?.contentWindow) {
      piece.frame.contentWindow.postMessage({ emberZoom: op }, '*')
      return
    }
    const body = piece.body
    const inner = body.firstElementChild as HTMLElement | null
    if (!inner) return
    const z0 = this.localZoom
    const z = Math.max(0.5, Math.min(8, op === 'reset' ? 1 : op === 'in' ? z0 * (factor ?? 1.25) : z0 / (factor ?? 1.25)))
    const r = body.getBoundingClientRect()
    const cx = at ? at.x - r.left : r.width / 2
    const cy = at ? at.y - r.top : r.height / 2
    const px = (body.scrollLeft + cx) / z0
    const py = (body.scrollTop + cy) / z0
    this.localZoom = z
    inner.style.transformOrigin = '0 0'
    inner.style.transform = z === 1 ? '' : `scale(${z})`
    body.scrollLeft = px * z - cx
    body.scrollTop = py * z - cy
    this.showZoom(z)
  }

  private zoomWired = false

  private wireZoom(): void {
    if (this.zoomWired) return
    this.zoomWired = true
    this.zoomBar.addEventListener('click', (e) => {
      const op = (e.target as HTMLElement).closest<HTMLElement>('[data-z]')?.dataset['z'] as 'in' | 'out' | 'reset' | undefined
      if (op) this.zoomFull(op)
    })
    this.modal.addEventListener(
      'wheel',
      (e) => {
        if (!this.full || this.full.piece.frame || !(e.ctrlKey || e.metaKey)) return
        e.preventDefault()
        const f = Math.exp(-e.deltaY * 0.0025)
        this.zoomFull(f >= 1 ? 'in' : 'out', { x: e.clientX, y: e.clientY }, f >= 1 ? f : 1 / f)
      },
      { passive: false }
    )
    this.modal.addEventListener('dblclick', (e) => {
      if (!this.full || this.full.piece.frame || !this.full.piece.body.contains(e.target as Node)) return
      this.zoomFull(this.localZoom > 1.01 ? 'reset' : 'in', { x: e.clientX, y: e.clientY }, 2)
    })
    const keys = (e: KeyboardEvent) => {
      if (!this.full || e.ctrlKey || e.altKey || e.metaKey) return
      if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return
      const op = e.key === '+' || e.key === '=' ? 'in' : e.key === '-' || e.key === '_' ? 'out' : e.key === '0' ? 'reset' : null
      if (!op) return
      e.preventDefault()
      e.stopPropagation()
      this.zoomFull(op)
    }
    window.addEventListener('keydown', keys, true)
    this.unsubs.push(() => window.removeEventListener('keydown', keys, true))
  }

  /** One object over everything, as large as the window allows. Esc or a click outside closes it. */
  private fullscreen(piece: Piece, on = !this.full): void {
    if (on) {
      if (this.full) this.fullscreen(this.full.piece, false)
      const home = piece.el.parentNode
      if (!home) return
      this.full = { piece, home, next: piece.el.nextSibling }
      if (!this.modal.isConnected) {
        document.body.appendChild(this.modal)
        this.modal.addEventListener('pointerdown', (e) => {
          if (e.target === this.modal && this.full) this.fullscreen(this.full.piece, false)
        })
      }
      this.modal.appendChild(piece.el)
      this.wireZoom()
      this.localZoom = 1
      this.showZoom(1)
      this.modal.appendChild(this.zoomBar)
      piece.el.classList.add('is-full')
      this.modal.classList.add('is-on')
      const b = piece.el.querySelector('[data-p="expand"]')
      if (b) {
        b.innerHTML = ICON.restore
        b.setAttribute('title', 'Exit full screen (Esc)')
      }
      piece.frame?.addEventListener(
        'load',
        () => {
          piece.frame?.contentWindow?.postMessage({ emberFit: true }, '*')
          piece.frame?.contentWindow?.postMessage({ emberZoom: 'on' }, '*')
        },
        { once: true }
      )
    } else if (this.full && this.full.piece === piece) {
      const { home, next } = this.full
      this.full = null
      const close = this.modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(160), easing: EASE })
      close.onfinish = () => {
        this.modal.classList.remove('is-on')
        this.zoomBar.remove()
        const inner = piece.body.firstElementChild as HTMLElement | null
        if (inner && !piece.frame) inner.style.transform = ''
        piece.el.classList.remove('is-full')
        home.insertBefore(piece.el, next && next.parentNode === home ? next : null)
        const b = piece.el.querySelector('[data-p="expand"]')
        if (b) {
          b.innerHTML = ICON.expand
          b.setAttribute('title', 'Full screen (Esc to return)')
        }
        if (this.pinned.has(piece)) piece.frame?.addEventListener('load', () => piece.frame?.contentWindow?.postMessage({ emberFit: true }, '*'), { once: true })
        this.session.focus()
      }
    }
  }

  /** Whatever placed object holds the focus (its frame, its page) comes to the front. */
  private raiseFocused(): void {
    const active = document.activeElement
    if (!active) return
    for (const p of this.pinned) if (p.el.contains(active)) this.raise(p)
  }

  /** The object you touch comes to the front. */
  private raise(piece: Piece): void {
    if (!this.pinned.has(piece) || piece.snap) return
    piece.el.style.zIndex = String(++this.z)
  }

  /** An object over another can be seen through: 100%, 60%, 30%, and back. */
  private fade(piece: Piece): void {
    const steps = [1, 0.6, 0.3]
    const now = Number(piece.el.dataset['fade'] ?? 1)
    const next = steps[(steps.indexOf(now) + 1) % steps.length]!
    piece.el.dataset['fade'] = String(next)
    piece.el.style.setProperty('--fade', String(next))
    piece.el.classList.toggle('is-faded', next < 1)
    const b = piece.el.querySelector<HTMLElement>('.loom-fade-btn')
    if (b) b.title = next < 1 ? `See through: ${Math.round(next * 100)}% — click for ${Math.round((steps[(steps.indexOf(next) + 1) % steps.length]!) * 100)}%` : 'See through it: 100% → 60% → 30%'
  }

  /** Keep a placed piece inside the canvas (it shrank: the input grew, the window was resized) and lay the text out round it. */
  private settlePin(piece: Piece): void {
    this.place2(piece, piece.el.offsetLeft, piece.el.offsetTop)
    this.reflow()
  }

  private readonly pinObserver = new ResizeObserver(() => {
    if (!this.el.classList.contains('is-dragging')) this.reflow()
  })

  /**
   * Lay the words out round what is placed, once it is put down. The rule is the one you
   * would apply by eye:
   *
   * - an object below where the words end leaves them full width; above where they start,
   *   the same;
   * - an object in the right or left part of the screen takes that side, and the words
   *   run in a column beside it;
   * - a wide object in the middle takes a band, at the top or the bottom, whichever half
   *   it is in.
   *
   * Objects may lie over one another; the words never lie under any of them.
   */
  private reflow(): void {
    const W = this.el.clientWidth
    const H = this.el.clientHeight
    const st = this.scroller.style
    const pins = [...this.pinned]
    const inset = { left: 0, right: 0, top: 0, bottom: 0 }
    if (pins.length && W && H) {
      // Where the words end at full width: their height now, scaled to the full column.
      const colNow = Math.max(1, this.scroller.clientWidth)
      const textH = ((this.shown?.offsetHeight ?? 0) * colNow) / Math.max(1, W - 44) + 40
      let changed = false
      const g = 8
      if (this.snaps.left.length) inset.left = this.railWidth() + this.snapDepth('left') + 2 * g + 6
      if (this.snaps.right.length) inset.right = this.snapDepth('right') + 2 * g + 6
      if (this.snaps.top.length) inset.top = Math.max(...this.snaps.top.map((p) => p.el.offsetTop + p.el.offsetHeight)) + g
      if (this.snaps.bottom.length) inset.bottom = H - Math.min(...this.snaps.bottom.map((p) => p.el.offsetTop)) + g
      // Free objects: the words take the widest clear column between them, so they never
      // run under one. Only when no readable column is left do they go above or below.
      // Only objects beside the words matter: one sitting below where they end leaves them
      // where they are (checked again as the reply grows).
      const hostTop = this.el.getBoundingClientRect().top
      const textEnd = this.shown ? this.shown.getBoundingClientRect().top - hostTop + textH : 0
      const free = pins.filter((p) => !p.snap && !p.el.classList.contains('is-dragging') && p.el.offsetTop < textEnd + 16)
      const lo = inset.left
      const hi = W - inset.right
      const spans = free.map((p) => [Math.max(lo, p.el.offsetLeft - 14), Math.min(hi, p.el.offsetLeft + p.el.offsetWidth + 14)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
      let best: [number, number] = [lo, hi]
      let bestW = -1
      let x = lo
      const gaps: Array<[number, number]> = []
      for (const [a, b] of [...spans, [hi, hi] as [number, number]]) {
        if (a > x) gaps.push([x, a])
        if (a - x > bestW) {
          bestW = a - x
          best = [x, a]
        }
        x = Math.max(x, b)
      }
      // The words keep to the left whenever a readable column is there.
      const leftmost = gaps.find(([a, b]) => b - a >= 420)
      if (leftmost) {
        best = leftmost
        bestW = leftmost[1] - leftmost[0]
      }
      if (!free.length) {
        // nothing free: the snaps alone decide
      } else if (bestW >= 320) {
        inset.left = best[0]
        inset.right = W - best[1]
        for (const p of free) {
          const side: Side = p.el.offsetLeft + p.el.offsetWidth / 2 < (best[0] + best[1]) / 2 ? 'left' : 'right'
          if (p.dock !== side) {
            p.dock = side
            changed = true
          }
        }
      } else {
        for (const p of free) {
          const t = p.el.offsetTop
          const bt = t + p.el.offsetHeight
          const side: Side = t + p.el.offsetHeight / 2 < H / 2 ? 'top' : 'bottom'
          if (side === 'top') inset.top = Math.max(inset.top, bt + 12)
          else inset.bottom = Math.max(inset.bottom, H - t + 12)
          if (p.dock !== side) {
            p.dock = side
            changed = true
          }
        }
      }
      // Never squeeze the words below a readable column or band.
      const spareW = W - 300
      if (inset.left + inset.right > spareW) {
        const k = Math.max(0, spareW) / (inset.left + inset.right)
        inset.left *= k
        inset.right *= k
      }
      const spareH = H - 120
      if (inset.top + inset.bottom > spareH) {
        const k = Math.max(0, spareH) / (inset.top + inset.bottom)
        inset.top *= k
        inset.bottom *= k
      }
      if (changed) this.reportScreen()
    }
    st.left = `${Math.round(inset.left)}px`
    st.right = `${Math.round(inset.right)}px`
    st.top = `${Math.round(inset.top)}px`
    st.bottom = `${Math.round(inset.bottom)}px`
    // The live line and the narration follow the words, so they never sit on an object.
    const es = this.el.style
    es.setProperty('--ins-l', `${Math.round(inset.left)}px`)
    es.setProperty('--ins-r', `${Math.round(inset.right)}px`)
    es.setProperty('--ins-b', `${Math.round(inset.bottom)}px`)
  }

  /** What is lifted out leaves no hole: the space it took closes up, smoothly. */
  private heal(at: HTMLElement, height: number): void {
    if (!at.parentElement || height < 4) return
    const gap = div('loom-heal')
    gap.style.height = `${height}px`
    at.parentElement.insertBefore(gap, at)
    requestAnimationFrame(() => requestAnimationFrame(() => (gap.style.height = '0px')))
    window.setTimeout(() => gap.remove(), 420)
  }

  /** What kind of object a liftable host is. */
  private kindOf(host: HTMLElement): 'mermaid' | 'table' | 'code' | 'image' {
    if (host.classList.contains('loom-diagram')) return 'mermaid'
    if (host.classList.contains('loom-table')) return 'table'
    if (host.classList.contains('loom-code')) return 'code'
    return 'image'
  }

  /** A name for an object in a reply, given once, so you and the session can refer to it. */
  private nameObject(host: HTMLElement): string {
    if (host.dataset['title']) return host.dataset['title']
    const kind = this.kindOf(host)
    if (kind === 'mermaid') return this.nameDiagram(host)
    // A table or code block takes the heading over it, if there is one close by.
    let base: string = kind
    let prev = host.previousElementSibling
    for (let i = 0; prev && i < 3; i++, prev = prev.previousElementSibling) {
      if (/^H[1-4]$/.test(prev.tagName)) {
        base = (prev.textContent ?? '').trim().slice(0, 50) || kind
        break
      }
    }
    if (kind === 'code') base = base === 'code' ? `${(host.querySelector('.loom-code-bar span')?.textContent ?? 'code').trim()} code` : base
    if (kind === 'image') base = (host.querySelector('img')?.getAttribute('alt') ?? '').trim().slice(0, 50) || 'picture'
    const taken = (t: string) => this.pieces.has(t) || this.titles.has(t)
    let t = base
    if (taken(t) || t === kind) {
      let n = 1
      while (taken(`${base} ${n}`)) n++
      t = `${base} ${n}`
    }
    host.dataset['title'] = t
    this.titles.add(t)
    return t
  }

  /**
   * Take an object out of the reply and make it a piece of its own, placed on the screen.
   * A diagram keeps its frame (and the reply keeps an empty, closed-up slot); a table, a
   * code block or a picture moves bodily, and the reply closes up behind it.
   */
  private liftObject(host: HTMLElement): Piece | null {
    if (this.kindOf(host) === 'mermaid') return this.pinDiagram(host)
    const r = host.getBoundingClientRect()
    const kind = this.kindOf(host)
    const title = this.nameObject(host)
    this.heal(host, r.height)
    const piece = this.makePiece(host.parentElement ?? this.scroller, title, kind)
    host.parentElement?.insertBefore(piece.el, host)
    piece.source = kind === 'image' ? host.querySelector('img')?.src : (host.innerText ?? '').slice(0, 8000)
    host.querySelector('.loom-lift')?.remove()
    piece.body.appendChild(host)
    piece.el.style.width = `${Math.max(320, r.width + 2)}px`
    this.pieces.set(title, piece)
    this.pin(piece)
    return piece
  }

  /** A diagram in Claude's words becomes an object of its own when you pin it. */
  private pinDiagram(host: HTMLElement): Piece | null {
    const f = host.querySelector('iframe')
    if (!f) return null
    const r = host.getBoundingClientRect()
    this.heal(host, r.height)
    const title = this.nameObject(host)
    const piece = this.makePiece(host, title, 'mermaid')
    piece.source = host.dataset['source']
    this.pieces.set(title, piece)
    piece.frame = f
    piece.body.appendChild(f)
    piece.el.style.width = `${r.width}px`
    this.pin(piece)
    host.classList.add('is-lifted')
    return piece
  }

  private readonly titles = new Set<string>()

  /** A diagram in a reply, named once, so the user and the session can both refer to it. */
  private nameDiagram(host: HTMLElement): string {
    if (host.dataset['title']) return host.dataset['title']
    const t = this.diagramTitle(host.dataset['source'] ?? '')
    host.dataset['title'] = t
    this.titles.add(t)
    const lift = host.querySelector('.loom-lift-name')
    if (lift) lift.textContent = t
    return t
  }

  /** A name the session can refer to: the diagram's own title, or its kind and a number. */
  private diagramTitle(src: string): string {
    const raw = /^\s*title:?\s+(.+)$/m.exec(src)?.[1] ?? /^\s*(?:pie|gantt|journey|xychart-beta|quadrantChart)\s+title\s+(.+)$/m.exec(src)?.[1]
    const own = raw?.trim().replace(/^["'`]+|["'`]+$/g, '').trim() || undefined
    const kind = /^\s*(\w[\w-]*)/.exec(src.replace(/^---[\s\S]*?---\s*/, ''))?.[1] ?? 'diagram'
    let base = (own ?? `${kind === 'graph' || kind === 'flowchart' ? 'flowchart' : kind}`).trim().slice(0, 60)
    const taken = (t: string) => this.pieces.has(t) || this.titles.has(t)
    if (!own || taken(base)) {
      let n = 1
      while (taken(`${base} ${n}`)) n++
      base = `${base} ${n}`
    }
    return base
  }

  /** Tell main what is placed, so the session's on_screen tool can say. */
  private reportScreen(): void {
    const items: ScreenItem[] = [...this.pinned].map((p) => ({
      title: p.title,
      format: p.format,
      placed: p.dock ?? 'floating',
      ...(p.source ? { source: p.source.slice(0, 8000) } : {}),
    }))
    // And what is on the stage in this turn: pieces shown inline, diagrams in the reply.
    const stage = this.shown
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
  private findPiece(title: string): Piece | undefined {
    const exact = this.pieces.get(title)
    if (exact) return exact
    for (const [t, p] of this.pieces) if (sameTitle(t, title)) return p
    return undefined
  }

  // ================================================================ one thing in focus

  /**
   * The board shows one thing at a time: the object last shown or changed, open; every
   * other one folded to a chip with its name, in a row above. Clicking a chip opens it and
   * folds the one that was open. Placed and snapped objects are yours and are left alone.
   * A new object also belongs to the plan step in progress, so the step can bring it back.
   */
  private focusOn(piece: Piece, fresh = false): void {
    if (fresh && !piece.step) {
      const active = this.plan.querySelector<HTMLElement>('li[data-state="active"]')
      if (active?.dataset['k']) piece.step = active.dataset['k']
    }
    const board = piece.el.closest<HTMLElement>('.loom-board')
    if (!board) return
    for (const slot of board.querySelectorAll<HTMLElement>(':scope > .loom-slot')) {
      const inside = slot.firstElementChild as HTMLElement | null
      if (!inside) continue
      slot.classList.toggle('is-shelved', inside !== piece.el)
    }
    piece.el.classList.remove('is-min')
    piece.el.style.height = ''
    this.tickPlan()
  }

  /** The objects a plan step carries, newest first. */
  private stepPieces(key: string): Piece[] {
    return [...this.pieces.values()].filter((p) => p !== this.planPiece && p.step === key && p.el.isConnected && !this.pinned.has(p)).reverse()
  }

  /**
   * Bring something into view by scrolling the reply up or down, and nothing else. The
   * browser's own scrollIntoView also scrolls every ancestor sideways — the whole canvas
   * slid left under the sidebar when the keyboard picked an object near the right edge.
   */
  private reveal(el: HTMLElement, block: 'nearest' | 'start' | 'center' = 'nearest'): void {
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

  // ================================================================ sticky notes

  /**
   * A sticky note on this session's canvas: a real note (it is on the Notes page too,
   * saying which session it came from), placed on screen and open for typing.
   */
  private async newSticky(): Promise<void> {
    const when = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    // The session's name without its status glyph, as plain words the Notes page can show.
    const from = (document.querySelector(`.ember-card[data-id="${this.tabId}"] .ember-card-title`)?.textContent ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
    const made = await window.ember.notes.create(`# Note, ${when}\n\nFrom the session ${from || 'in Ember'}.\n\n`)
    if (!made) {
      this.hooks.toast('Could not create the note')
      return
    }
    const dir = await window.ember.notes.dir()
    await window.ember.canvas.showFile(this.tabId, `${dir}/${made.id}`, made.title)
    for (let i = 0; i < 40; i++) {
      const piece = this.findPiece(made.title)
      if (piece) {
        piece.el.classList.add('is-sticky')
        const host = this.el.getBoundingClientRect()
        this.pin(piece, false)
        piece.el.style.width = '320px'
        piece.el.style.height = '240px'
        piece.free = { w: 320, h: 240 }
        this.place2(piece, Math.max(24, host.width - 360 - 40 * (this.pinned.size % 4)), 72 + 28 * (this.pinned.size % 4))
        this.settlePin(piece)
        void this.editNote(piece)
        return
      }
      await new Promise((r) => window.setTimeout(r, 75))
    }
  }

  // ================================================================ the canvas from the keyboard

  /** The object the keyboard is on, or null when the keys go to the input. */
  private kbd: Piece | null = null
  /** An object still inline in the reply that the keyboard is on (lifted out when acted on). */
  private kbdInline: HTMLElement | null = null
  private readonly kbdLegend = div('loom-kbd-legend')

  /**
   * The objects the keyboard can reach, in reading order: objects on the canvas and the
   * diagrams, tables and code inline in the turn on screen.
   */
  private kbdList(): HTMLElement[] {
    const pieces = [...this.pieces.values()].map((p) => p.el)
    const inline = this.shown ? [...this.shown.querySelectorAll<HTMLElement>('.loom-liftable')].filter((d) => !d.closest('.loom-piece')) : []
    return [...pieces, ...inline]
      .filter((el) => el.isConnected && el.offsetParent !== null)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return ra.top - rb.top || ra.left - rb.left
      })
  }

  private pieceOf(el: HTMLElement): Piece | null {
    for (const p of this.pieces.values()) if (p.el === el) return p
    return null
  }

  /** The object under the keyboard as a canvas object, lifting an inline one out if need be. */
  private kbdPiece(): Piece | null {
    if (this.kbd) return this.kbd
    const d = this.kbdInline
    if (!d) return null
    const piece = this.liftObject(d)
    if (piece) this.kbdSelect(piece.el)
    return piece
  }

  private kbdSelect(el: HTMLElement): void {
    this.kbd?.el.classList.remove('is-kbd')
    this.kbdInline?.classList.remove('is-kbd')
    const piece = this.pieceOf(el)
    this.kbd = piece
    this.kbdInline = piece ? null : el
    el.classList.add('is-kbd')
    if (piece) this.raise(piece)
    this.reveal(el, 'nearest')
    // Off the terminal, so the keys come here and nothing is typed into the agent.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    this.el.focus({ preventScroll: true })
    this.kbdLegend.innerHTML =
      `<span><b>↑↓</b> choose</span><span><b>Enter</b> full screen</span><span><b>P</b> ${piece && this.pinned.has(piece) ? 'put back' : 'place on screen'}</span>` +
      `<span><b>Shift+arrows</b> snap</span><span><b>Alt+arrows</b> move</span><span><b>Alt+Shift+arrows</b> size</span>` +
      `<span><b>N</b> sticky note</span><span><b>M</b> minimize</span><span><b>Del</b> remove</span><span><b>Space</b> menu</span><span><b>Esc</b> back to typing</span>`
    if (!this.kbdLegend.isConnected) this.el.appendChild(this.kbdLegend)
    this.kbdLegend.classList.add('is-on')
  }

  /** Back to the input: the ring goes, the legend goes, the keys go to the agent again. */
  private kbdLeave(): void {
    this.kbd?.el.classList.remove('is-kbd')
    this.kbdInline?.classList.remove('is-kbd')
    this.kbd = null
    this.kbdInline = null
    this.kbdLegend.classList.remove('is-on')
    this.session.focus()
  }

  private kbdKey(e: KeyboardEvent): void {
    const cur = this.kbd?.el ?? this.kbdInline
    if (!cur || !cur.isConnected) return this.kbdLeave()
    const stop = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    const list = this.kbdList()
    const at = list.indexOf(cur)
    // Moving between objects needs no canvas object; everything else acts on one.
    const k0 = e.key
    if ((k0 === 'ArrowUp' || k0 === 'ArrowDown' || k0 === 'Tab') && !e.altKey && !e.shiftKey) {
      stop()
      const next = list[(at + (k0 === 'ArrowUp' ? -1 : 1) + list.length) % list.length]
      if (next) this.kbdSelect(next)
      return
    }
    if (k0 === 'Tab' && e.shiftKey) {
      stop()
      const next = list[(at - 1 + list.length) % list.length]
      if (next) this.kbdSelect(next)
      return
    }
    if (k0 === 'Escape' && !this.kbd) {
      stop()
      this.kbdLeave()
      return
    }
    if (k0 === ' ' || k0 === '.') {
      stop()
      this.menu(cur.getBoundingClientRect(), cur)
      return
    }
    if ((k0 === 'n' || k0 === 'N') && !e.ctrlKey && !e.altKey) {
      stop()
      this.kbdLeave()
      void this.newSticky()
      return
    }
    if (k0.length === 1 && !e.ctrlKey && !e.metaKey && !/^[pPmMnN]$/.test(k0)) {
      this.kbdLeave()
      return
    }
    const acts = ['Escape', 'Enter', 'Delete', 'Backspace', 'p', 'P', 'm', 'M', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    if (!acts.includes(k0)) return
    if (this.kbdInline && (k0 === 'Delete' || k0 === 'Backspace')) {
      // Part of the reply itself: nothing to take away.
      stop()
      return
    }
    const piece = this.kbdPiece()
    if (!piece) return this.kbdLeave()
    const k = e.key
    const arrow = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight'
    if (k === 'Escape') {
      stop()
      if (this.full?.piece === piece) this.fullscreen(piece, false)
      else this.kbdLeave()
      return
    }
    if (this.full?.piece === piece && k !== 'Enter') return
    if (arrow && e.altKey) {
      stop()
      if (!this.pinned.has(piece)) {
        this.pin(piece, false)
        this.settlePin(piece)
      }
      const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0
      const dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0
      if (piece.snap) this.unsnap(piece)
      if (e.shiftKey) {
        const w = Math.max(240, piece.el.offsetWidth + dx * 40)
        const h = Math.max(90, piece.el.offsetHeight + dy * 40)
        piece.el.style.width = `${w}px`
        piece.el.style.height = `${h}px`
        piece.free = { w, h }
      } else this.place2(piece, piece.el.offsetLeft + dx * 32, piece.el.offsetTop + dy * 32)
      this.reflow()
      this.kbdSelect(piece.el)
      return
    }
    if (arrow && e.shiftKey) {
      stop()
      const side: Side = k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'top' : 'bottom'
      if (piece.snap !== side && this.snaps[side].length >= LoomView.SNAPS_PER_EDGE) {
        this.hooks.toast(`That edge already holds ${LoomView.SNAPS_PER_EDGE}`)
        return
      }
      if (!this.pinned.has(piece)) this.pin(piece, false)
      if (piece.snap) this.unsnap(piece)
      this.snapTo(piece, side)
      this.kbdSelect(piece.el)
      return
    }
    if (k === 'Enter') {
      stop()
      this.fullscreen(piece, this.full?.piece !== piece)
      return
    }
    if (k === 'p' || k === 'P') {
      stop()
      if (this.pinned.has(piece)) this.unpin(piece)
      else {
        this.pin(piece)
        this.settlePin(piece)
      }
      window.setTimeout(() => this.kbdSelect(piece.el), 260)
      return
    }
    if (k === 'm' || k === 'M') {
      stop()
      this.minimize(piece)
      return
    }
    if (k === 'Delete' || k === 'Backspace') {
      stop()
      const rest = list.filter((x) => x !== piece.el)
      if (this.pinned.has(piece)) this.unpin(piece)
      else this.dismiss(piece)
      const next = rest[Math.min(at, rest.length - 1)]
      if (next) this.kbdSelect(next)
      else this.kbdLeave()
      return
    }
  }

  // ================================================================ pointing inside the canvas

  private guide: HTMLElement | null = null
  private guideTimer = 0
  private readonly findWaiters = new Map<string, (r: { x: number; y: number; w: number; h: number } | null) => void>()

  /** Ask a document frame where some text of its is: the smallest thing that holds it. */
  private findInFrame(f: HTMLIFrameElement, text: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
    const id = Math.random().toString(36).slice(2)
    return new Promise((resolve) => {
      const t = window.setTimeout(() => {
        this.findWaiters.delete(id)
        resolve(null)
      }, 1500)
      this.findWaiters.set(id, (r) => {
        window.clearTimeout(t)
        this.findWaiters.delete(id)
        resolve(r)
      })
      f.contentWindow?.postMessage({ emberFind: { id, text } }, '*')
    })
  }

  /**
   * Point at something on the canvas — a node in a diagram, a bar in a chart, a row in a
   * table — with Ember's own pointer, drawn here: it glides there on a gentle curve, a
   * short note appears beside it. The session hears whether it was found.
   */
  private async pointAt(p: { reqId: string; object: string; text: string; say: string; step?: number; steps?: number }): Promise<void> {
    const reply = (r: { ok: boolean; error?: string; found?: string }) => window.ember.canvas.pointed(p.reqId, r)
    const piece = this.findPiece(p.object)
    const inline = piece ? null : [...this.el.querySelectorAll<HTMLElement>('.loom-diagram[data-title], .loom-liftable[data-title]')].find((d) => sameTitle(d.dataset['title'] ?? '', p.object))
    const host = piece?.el ?? inline
    if (!host) return reply({ ok: false, error: `Nothing called "${p.object}" is on the canvas. Call on_screen for the titles.` })
    // Bring it into view: its turn, unfolded, scrolled to.
    const turn = host.closest<HTMLElement>('.loom-turn')
    if (turn && turn !== this.shown && !this.pinned.has(piece!)) {
      const turns = this.feed.turns()
      this.viewing = turn === turns[turns.length - 1] ? null : turn
      this.restage()
    }
    if (piece) {
      this.minimize(piece, false)
      if (!this.pinned.has(piece)) this.focusOn(piece)
    }
    this.reveal(host, 'nearest')
    await new Promise((r) => window.setTimeout(r, 380))
    let target = host.getBoundingClientRect()
    let found = p.object
    const frame = host.querySelector<HTMLIFrameElement>('iframe')
    if (p.text && frame) {
      const r = await this.findInFrame(frame, p.text)
      if (!r) return reply({ ok: false, error: `"${p.text}" was not found in "${p.object}".` })
      const fr = frame.getBoundingClientRect()
      target = new DOMRect(fr.left + r.x, fr.top + r.y, r.w, r.h)
      found = `${p.text} in ${p.object}`
    } else if (p.text) {
      const el = [...host.querySelectorAll<HTMLElement>('*')].filter((e) => (e.textContent ?? '').toLowerCase().includes(p.text.toLowerCase())).sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
      if (!el) return reply({ ok: false, error: `"${p.text}" was not found in "${p.object}".` })
      target = el.getBoundingClientRect()
      found = `${p.text} in ${p.object}`
    }
    this.drawGuide(target, p.say, p.step, p.steps)
    reply({ ok: true, found })
  }

  /** Ember's pointer and its note, on the canvas. */
  private drawGuide(target: DOMRect, say: string, step?: number, steps?: number): void {
    const box = this.el.getBoundingClientRect()
    if (!this.guide) {
      this.guide = div('loom-guide', `<svg class="loom-guide-arrow" viewBox="0 0 28 32" width="26" height="30"><defs><linearGradient id="lgA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7B652"/><stop offset=".55" stop-color="#F2A43A"/><stop offset="1" stop-color="#E07A1F"/></linearGradient></defs><path d="M3 2.5 L24 17.5 L14.2 18.6 L19.6 28.4 L15.4 30.2 L10.2 20.3 L3.4 26.6 Z" fill="url(#lgA)" stroke="rgba(20,12,4,.85)" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="loom-guide-tag">Ember</span><div class="loom-guide-note"></div>`)
      this.el.appendChild(this.guide)
    }
    const g = this.guide
    const tx = target.left - box.left + Math.min(target.width * 0.5, 40)
    const ty = target.top - box.top + target.height * 0.62
    const from = g.classList.contains('is-on') ? { x: Number(g.dataset['x']), y: Number(g.dataset['y']) } : { x: tx - 140, y: ty - 90 }
    g.dataset['x'] = String(tx)
    g.dataset['y'] = String(ty)
    g.classList.add('is-on')
    const dist = Math.hypot(tx - from.x, ty - from.y)
    const ms = reduced() ? 1 : Math.round(Math.max(220, Math.min(650, 180 + dist * 0.45)))
    const mx = (from.x + tx) / 2 + (ty - from.y) * 0.12
    const my = (from.y + ty) / 2 - (tx - from.x) * 0.12
    g.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px)` },
        { transform: `translate(${mx}px, ${my}px)`, offset: 0.5 },
        { transform: `translate(${tx + 3}px, ${ty + 2}px)`, offset: 0.9 },
        { transform: `translate(${tx}px, ${ty}px)` },
      ],
      { duration: ms, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'forwards' }
    )
    const note = g.querySelector<HTMLElement>('.loom-guide-note')!
    note.classList.remove('is-on')
    note.innerHTML = (steps ? `<div class="h">Step ${step ?? 1} of ${steps}</div>` : '') + (say ? `<div>${escapeHtml(say)}</div>` : '')
    // The note sits to the right, or the left when there is no room, never on the target.
    const right = tx + 300 < box.width
    note.classList.toggle('is-left', !right)
    window.setTimeout(() => note.classList.toggle('is-on', !!(say || steps)), ms)
    window.clearTimeout(this.guideTimer)
    this.guideTimer = window.setTimeout(() => g.classList.remove('is-on'), ms + 4000 + (say?.length ?? 0) * 60 + (steps ? 8000 : 0))
  }

  /** In the turn on screen, a link to an object that was changed in the turn it belongs to. */
  private noteUpdate(piece: Piece): void {
    const home = piece.el.closest<HTMLElement>('.loom-turn')
    const turns = this.feed.turns()
    const n = home ? turns.indexOf(home) + 1 : 0
    const turns2 = this.feed.turns()
    const live = turns2[turns2.length - 1]
    if (!live || !home || live === home) return
    const existing = [...live.querySelectorAll<HTMLElement>('.loom-ref')].find((r) => r.dataset['title'] === piece.title)
    if (existing) return
    const ref = div('loom-ref', `${iconFor(piece.format)}<span>Updated <b>${escapeHtml(piece.title)}</b> in turn ${n}</span>${ICON.out}`)
    ref.dataset['title'] = piece.title
    ref.addEventListener('click', () => {
      this.viewing = home === turns[turns.length - 1] ? null : home
      this.restage()
      this.focusOn(piece)
      this.reveal(piece.el, 'nearest')
    })
    const board = live.querySelector(':scope > .loom-board')
    live.insertBefore(ref, board)
  }

  /** A place on the board for a new object: newest first, under the exchange. */
  private boardSlot(): HTMLElement {
    // Each turn has its own board, under its words: what was shown in a turn is part of
    // that turn, and goes when you move to another — only the plan carries across, and
    // anything you placed on the screen.
    const turns = this.feed.turns()
    const turn = turns[turns.length - 1] ?? this.feed.el
    let board = turn.querySelector<HTMLElement>(':scope > .loom-board')
    if (!board) {
      board = div('loom-board is-on')
      turn.appendChild(board)
    }
    const slot = div('loom-slot')
    board.prepend(slot)
    return slot
  }

  // ================================================================ notes and todos

  /** The todo list, changed from the canvas: tick, add. Written to the real Todo.md; the card redraws from it. */
  private async todoOp(op: string, text: string, quiet = false): Promise<void> {
    if (!text.trim()) return
    const body = (await window.ember.notes.read('Todo.md')) ?? ''
    if (op === 'add') {
      await window.ember.notes.save('Todo.md', `${body.replace(/\s*$/, '')}\n- [ ] ${text.trim()}\n`)
      if (!quiet) this.hooks.toast(`Added to Todo — it's in the notebook (Ctrl+Shift+N)`)
      void this.countTodos()
      return
    }
    if (op === 'toggle') {
      const lines = body.split('\n')
      const i = lines.findIndex((l) => /^\s*[-*]\s*\[( |x|X)\]/.test(l) && l.replace(/^\s*[-*]\s*\[( |x|X)\]\s*/, '').trim() === text.trim())
      if (i < 0) return
      lines[i] = /\[ \]/.test(lines[i]!) ? lines[i]!.replace('[ ]', '[x]') : lines[i]!.replace(/\[(x|X)\]/, '[ ]')
      await window.ember.notes.save('Todo.md', lines.join('\n'))
    }
  }

  /** Something on the canvas, kept as a note of its own. */
  private async saveToNote(text: string, title: string): Promise<void> {
    const body = title && !/^#/.test(text.trim()) ? `# ${title}\n\n${text.trim()}\n` : `${text.trim()}\n`
    const made = await window.ember.notes.create(body)
    if (!made) {
      this.hooks.toast('Could not save the note')
      return
    }
    // It opens in the notebook, so you see where it went and can edit it straight away.
    this.openDrawer('notes', made.id)
  }

  /** Edit a note right where it is on the canvas. Saved on Ctrl+S, Esc or leaving it; the object redraws from the file. */
  private async editNote(piece: Piece): Promise<void> {
    if (!piece.file || piece.el.classList.contains('is-editing')) return
    const id = piece.file.split(/[\\/]/).pop() ?? ''
    const text = (await window.ember.notes.read(id)) ?? ''
    const ed = document.createElement('textarea')
    ed.className = 'loom-note-edit'
    ed.spellcheck = false
    ed.value = text
    piece.el.classList.add('is-editing')
    this.minimize(piece, false)
    piece.body.appendChild(ed)
    ed.focus()
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      if (ed.value !== text) await window.ember.notes.save(id, ed.value)
      ed.remove()
      piece.el.classList.remove('is-editing')
    }
    ed.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if ((e.ctrlKey && e.key.toLowerCase() === 's') || e.key === 'Escape') {
        e.preventDefault()
        void close()
      }
    })
    ed.addEventListener('blur', () => void close())
  }

  // ================================================================ the notebook

  /** The notes folder, so a note on the canvas can be told from any other markdown file. */
  private notesDir = ''
  private drawerTab: 'todo' | 'notes' = 'todo'
  private drawerNote: string | null = null

  /** Open the notebook on a tab, or on one note; with `text`, start a new note with it. */
  openDrawer(tab: 'todo' | 'notes', noteId?: string, text?: string): void {
    this.drawerTab = tab
    this.drawerNote = noteId ?? null
    this.drawer.classList.add('is-on')
    this.el.classList.add('has-drawer')
    // Only the notebook icon's state changes; the rest of the bar is left alone.
    this.sign.querySelector('.loom-sign-book')?.classList.add('is-active')
    if (text !== undefined) {
      void window.ember.notes.create(text).then((n) => {
        if (n) this.drawerNote = n.id
        void this.renderDrawer()
      })
      return
    }
    void this.renderDrawer()
  }

  private toggleDrawer(tab?: 'todo' | 'notes'): void {
    if (this.drawer.classList.contains('is-on') && (!tab || tab === this.drawerTab)) this.closeDrawer()
    else this.openDrawer(tab ?? this.drawerTab)
  }

  private closeDrawer(): void {
    this.drawer.classList.remove('is-on')
    window.setTimeout(() => {
      if (!this.drawer.classList.contains('is-on')) this.el.classList.remove('has-drawer')
    }, 420)
    this.renderSign()
    this.session.focus()
  }

  /** The open-todo count on the notebook icon, kept current. */
  private async countTodos(): Promise<void> {
    const body = (await window.ember.notes.read('Todo.md')) ?? ''
    const n = body.split('\n').filter((l) => /^\s*[-*]\s*\[ \]\s*\S/.test(l)).length
    if (n !== this.openTodos) {
      this.openTodos = n
      this.renderSign()
    }
  }

  /**
   * A row of the notebook can be taken out onto the canvas: press, move, and a small card
   * follows the pointer; let go over the canvas and it lands there as an object. A press
   * that does not move is still a click.
   */
  private draggableRow(row: HTMLElement, label: string, drop: (x: number, y: number) => void): void {
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, textarea, a')) return
      const sx = e.clientX
      const sy = e.clientY
      const wait = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return
        stop()
        const ghost = div('loom-drag-ghost', `${ICON.notes}<span>${escapeHtml(label)}</span>`)
        document.body.appendChild(ghost)
        const at = (x: number, y: number) => (ghost.style.transform = `translate(${x + 12}px, ${y + 10}px)`)
        at(ev.clientX, ev.clientY)
        let lx = ev.clientX
        let ly = ev.clientY
        this.track(
          ev,
          'grabbing',
          (m) => {
            lx = m.clientX
            ly = m.clientY
            at(lx, ly)
            const over = this.dropTarget(lx, ly)
            ghost.classList.toggle('is-ok', over)
            this.el.classList.toggle('is-drop', over)
          },
          () => {
            ghost.remove()
            this.el.classList.remove('is-drop')
            if (this.dropTarget(lx, ly)) drop(lx, ly)
          }
        )
      }
      const stop = () => {
        window.removeEventListener('pointermove', wait, true)
        window.removeEventListener('pointerup', stop, true)
      }
      window.addEventListener('pointermove', wait, true)
      window.addEventListener('pointerup', stop, true)
    })
  }

  /** Over the canvas, and not over the notebook itself. */
  private dropTarget(x: number, y: number): boolean {
    const c = this.scroller.getBoundingClientRect()
    const d = this.drawer.getBoundingClientRect()
    const inDrawer = x >= d.left && x <= d.right && y >= d.top && y <= d.bottom
    return !inDrawer && x >= c.left && x <= c.right && y >= c.top && y <= c.bottom
  }

  /** Put a notes-folder file on the canvas, and place it where it was dropped. */
  private async dropFile(path: string, title: string, x: number, y: number): Promise<void> {
    await window.ember.canvas.showFile(this.tabId, path, title)
    for (let i = 0; i < 40; i++) {
      const piece = this.findPiece(title)
      if (piece) {
        const host = this.el.getBoundingClientRect()
        this.pin(piece, false)
        piece.dock = null
        piece.el.style.zIndex = String(++this.z)
        this.place2(piece, x - host.left - 24, y - host.top - 14)
        this.settlePin(piece)
        return
      }
      await new Promise((r) => window.setTimeout(r, 75))
    }
  }

  private async renderDrawer(): Promise<void> {
    if (!this.drawer.classList.contains('is-on')) return
    const tab = this.drawerTab
    const head =
      `<div class="loom-drawer-head"><div class="loom-drawer-tabs">` +
      `<button type="button" data-t="todo" class="${tab === 'todo' ? 'is-on' : ''}">Todo${this.openTodos ? ` <span>${this.openTodos}</span>` : ''}</button>` +
      `<button type="button" data-t="notes" class="${tab === 'notes' ? 'is-on' : ''}">Notes</button></div>` +
      `<button type="button" class="loom-drawer-x" title="Close (Esc)">${ICON.close}</button></div>`
    if (tab === 'todo') {
      const body = (await window.ember.notes.read('Todo.md')) ?? ''
      const items = body
        .split('\n')
        .map((l) => /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m && !!m[2]!.trim())
        .map((m) => ({ text: m[2]!.trim(), done: m[1] !== ' ' }))
      const open = items.filter((i) => !i.done)
      const done = items.filter((i) => i.done)
      const row = (i: { text: string; done: boolean }) =>
        `<li class="${i.done ? 'is-done' : ''}" data-t="${escapeHtml(i.text)}"><button type="button" class="box" title="${i.done ? 'Mark not done' : 'Done'}">${ICON.check}</button><span class="t">${linkify(i.text)}</span>` +
        (i.done ? '' : `<button type="button" class="go" title="Hand this to the session">Do it here</button>`) +
        `</li>`
      this.drawer.innerHTML =
        head +
        `<div class="loom-drawer-body"><div class="loom-drawer-add"><input placeholder="Add a todo…" spellcheck="false"></div>` +
        `<ul class="loom-drawer-todo">${open.map(row).join('') || '<li class="empty">Nothing open. Add one above, or right-click anything → Add as todo.</li>'}</ul>` +
        (done.length ? `<details class="loom-drawer-done"><summary>Done (${done.length})</summary><ul class="loom-drawer-todo">${done.slice(-30).reverse().map(row).join('')}</ul></details>` : '') +
        `</div>`
    } else if (this.drawerNote) {
      const id = this.drawerNote
      const text = (await window.ember.notes.read(id)) ?? ''
      this.drawer.innerHTML =
        head +
        `<div class="loom-drawer-body is-note"><div class="loom-drawer-bar"><button type="button" class="back">${ICON.up} All notes</button>` +
        `<button type="button" class="place" title="Put a live copy on the canvas">${ICON.pin} Put on canvas</button></div>` +
        `<textarea class="loom-drawer-editor" spellcheck="false"></textarea><div class="loom-drawer-saved">Saved as you type</div></div>`
      const ed = this.drawer.querySelector<HTMLTextAreaElement>('.loom-drawer-editor')!
      ed.value = text
      let timer = 0
      ed.addEventListener('input', () => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void window.ember.notes.save(id, ed.value), 500)
      })
      ed.addEventListener('blur', () => void window.ember.notes.save(id, ed.value))
      ed.addEventListener('keydown', (e) => e.stopPropagation())
      this.drawer.querySelector('.back')?.addEventListener('click', () => {
        void window.ember.notes.save(id, ed.value)
        this.drawerNote = null
        void this.renderDrawer()
      })
      this.drawer.querySelector('.place')?.addEventListener('click', async () => {
        await window.ember.notes.save(id, ed.value)
        const dir = await window.ember.notes.dir()
        const n = (await window.ember.notes.list()).find((x) => x.id === id)
        await window.ember.canvas.showFile(this.tabId, `${dir}\\${id}`, n?.title ?? id)
      })
    } else {
      const notes = (await window.ember.notes.list()).filter((n) => !/^todo(\.archive)?\.md$/i.test(n.id)).sort((a, b) => b.modified - a.modified)
      const ago = (t: number) => {
        const m = Math.round((Date.now() - t) / 60000)
        return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
      }
      this.drawer.innerHTML =
        head +
        `<div class="loom-drawer-body"><div class="loom-drawer-add"><input placeholder="Search notes…" spellcheck="false"><button type="button" class="new" title="New note">${ICON.edit}</button></div>` +
        `<ul class="loom-drawer-notes">${notes
          .map((n) => `<li data-id="${escapeHtml(n.id)}"><span class="t">${escapeHtml(n.title)}</span><span class="p">${escapeHtml(n.preview.slice(0, 90))}</span><span class="a">${ago(n.modified)}</span></li>`)
          .join('') || '<li class="empty">No notes yet. Right-click anything → Save to a note.</li>'}</ul></div>`
      const search = this.drawer.querySelector<HTMLInputElement>('.loom-drawer-add input')!
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase()
        this.drawer.querySelectorAll<HTMLElement>('.loom-drawer-notes li[data-id]').forEach((li) => {
          li.hidden = !!q && !(li.textContent ?? '').toLowerCase().includes(q)
        })
      })
      search.addEventListener('keydown', (e) => e.stopPropagation())
      this.drawer.querySelector('.new')?.addEventListener('click', () => this.openDrawer('notes', undefined, '# '))
      this.drawer.querySelectorAll<HTMLElement>('.loom-drawer-notes li[data-id]').forEach((li) => {
        li.addEventListener('click', () => {
          this.drawerNote = li.dataset['id'] ?? null
          void this.renderDrawer()
        })
        const title = li.querySelector('.t')?.textContent ?? li.dataset['id'] ?? ''
        this.draggableRow(li, title, (x, y) => void window.ember.notes.dir().then((dir) => this.dropFile(`${dir}/${li.dataset['id']}`, title, x, y)))
      })
      search.focus()
    }
    // Shared: tabs, close, and the todo list's own controls.
    this.drawer.querySelectorAll<HTMLElement>('.loom-drawer-tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        this.drawerTab = b.dataset['t'] === 'notes' ? 'notes' : 'todo'
        this.drawerNote = null
        void this.renderDrawer()
      })
    )
    this.drawer.querySelector('.loom-drawer-x')?.addEventListener('click', () => this.closeDrawer())
    if (tab === 'todo') {
      const add = this.drawer.querySelector<HTMLInputElement>('.loom-drawer-add input')!
      add.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && add.value.trim()) {
          const t = add.value.trim()
          add.value = ''
          void this.todoOp('add', t, true)
        }
      })
      this.drawer.querySelectorAll<HTMLElement>('.loom-drawer-todo li[data-t]').forEach((li) => {
        li.querySelector('.box')?.addEventListener('click', () => {
          li.classList.toggle('is-done')
          void this.todoOp('toggle', li.dataset['t'] ?? '')
        })
        li.querySelector('.go')?.addEventListener('click', () => {
          this.type(`Do this from my todo list: ${li.dataset['t'] ?? ''}`, true)
          this.closeDrawer()
        })
        // Taken out, a todo brings the live todo list onto the canvas (tickable there).
        this.draggableRow(li, 'Todo', (x, y) => void window.ember.notes.dir().then((dir) => this.dropFile(`${dir}/Todo.md`, 'Todo', x, y)))
      })
      add.focus()
    }
  }

  // ================================================================ a resumed session, rebuilt

  /** When this view started: what the transcript says happened before that is history to rebuild. */
  private readonly bornAt = Date.now()
  /** What was shown by title, so a replayed edit_panel has something to edit. */
  private readonly replayed = new Map<string, { format: string; content: string }>()

  /**
   * A resumed session's transcript has every call it made to Ember's tools, with what it
   * sent. Played back, they put the board, the plan and the objects back as they were.
   * Only history is replayed — what is happening now arrives through the bridge as usual —
   * and nothing with a side effect (a todo added, a note written) is done again.
   */
  private async replay(tool: string, input: Record<string, unknown>, at: string): Promise<void> {
    const t = Date.parse(at)
    if (!t || t > this.bornAt - 3000) return
    const str = (k: string) => String(input[k] ?? '')
    const host = async (title: string, format: 'markdown' | 'mermaid' | 'code' | 'html' | 'view', content: string) => {
      this.replayed.set(title, { format, content })
      const url = await window.ember.canvas.doc(this.tabId, title, format, content)
      const id = /\/doc\/([^/?#]+)/.exec(url)?.[1]
      if (id) this.push({ tabId: this.tabId, title, format, content, id, at: t } as PanelPush)
    }
    try {
      if (tool === 'show_panel') {
        const f = str('format')
        if (f === 'markdown' || f === 'mermaid' || f === 'code' || f === 'html') await host(str('title') || 'Panel', f, str('content'))
      } else if (tool === 'show_view') {
        await host(str('title') || 'View', 'view', JSON.stringify({ view: str('view'), data: input['data'] ?? {} }))
      } else if (tool === 'edit_panel') {
        const was = [...this.replayed.entries()].find(([k]) => sameTitle(k, str('title')))
        if (!was) return
        let content = was[1].content
        for (const e of (input['edits'] as Array<{ find?: string; replace?: string; all?: boolean }>) ?? []) {
          if (!e.find) continue
          content = e.all ? content.split(e.find).join(e.replace ?? '') : content.replace(e.find, () => e.replace ?? '')
        }
        await host(was[0], was[1].format as 'markdown', content)
      } else if (tool === 'show_file') {
        await window.ember.canvas.showFile(this.tabId, str('path'), str('title') || undefined)
      } else if (tool === 'notes' && str('op') === 'show') {
        const dir = await window.ember.notes.dir()
        const n = (await window.ember.notes.list()).find((x) => x.title.toLowerCase() === str('name').toLowerCase())
        if (n) await window.ember.canvas.showFile(this.tabId, `${dir}\\${n.id}`, n.title)
      } else if (tool === 'show_media') {
        const items = []
        for (const it of (input['items'] as Array<{ path?: string; url?: string; caption?: string }>) ?? []) {
          if (it.url) items.push({ src: it.url, kind: /\.(mp4|webm|mov)$/i.test(it.url) ? 'video' : 'image', name: it.url, caption: it.caption })
          else if (it.path) {
            const r = await window.ember.canvas.media(it.path)
            if ('src' in r) items.push({ src: r.src, kind: r.kind, name: r.name, caption: it.caption })
          }
        }
        if (items.length) await this.showMedia({ tabId: this.tabId, title: str('title'), items } as unknown as CanvasMedia)
      } else if (tool === 'show_steps') {
        this.stepsTitle = str('title')
        const steps = (input['steps'] as Array<{ text?: string; status?: string }>) ?? []
        this.setTodos(steps.map((x) => ({ content: String(x.text ?? ''), status: x.status === 'done' ? 'completed' : x.status === 'active' ? 'in_progress' : 'pending' })))
      }
    } catch {
      /* a piece that cannot come back is left out; the rest still do */
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
    const same = this.findPiece(push.title)
    if (same && !same.frame && push.format !== 'ask' && same.el.isConnected) {
      if (!this.pinned.has(same) && this.shown && !this.shown.contains(same.el)) this.noteUpdate(same)
      same.body.innerHTML = ''
      same.frame = this.mountFrame(same.body, `${url}`, 64)
      same.format = push.format
      if (push.format === 'mermaid') same.source = push.content
      if (!this.pinned.has(same)) this.focusOn(same)
      same.el.classList.add('is-updated')
      window.setTimeout(() => same.el.classList.remove('is-updated'), 1600)
      if (this.pinned.has(same)) same.frame.addEventListener('load', () => same.frame?.contentWindow?.postMessage({ emberFit: true }, '*'), { once: true })
      this.reportScreen()
      return
    }
    // Same name, any format: it is that object, changed. Redrawn where it is.
    if (same && same.frame && push.format !== 'ask' && same.el.isConnected) {
      same.format = push.format
      // An object belongs to the turn it was made in, for good: changed later, it changes
      // there, and this turn gets a link to it.
      if (!this.pinned.has(same) && this.shown && !this.shown.contains(same.el)) this.noteUpdate(same)
      same.frame.src = `${url}${docTone()}`
      if (push.format === 'mermaid') same.source = push.content
      this.reportScreen()
      this.minimize(same, false)
      same.el.classList.add('is-updated')
      window.setTimeout(() => same.el.classList.remove('is-updated'), 1600)
      if (!this.pinned.has(same) && !this.visible(same.el)) this.hooks.toast(`Updated: ${push.title}`)
      return
    }
    if (push.format === 'mermaid') {
      const inline = [...this.el.querySelectorAll<HTMLElement>('.loom-diagram[data-title]')].find((d) => sameTitle(d.dataset['title'] ?? '', push.title))
      const f = inline?.querySelector('iframe')
      if (inline && f && !inline.classList.contains('is-lifted')) {
        f.src = `${url}${docTone()}`
        inline.dataset['source'] = push.content
        inline.classList.add('is-updated')
        window.setTimeout(() => inline.classList.remove('is-updated'), 1600)
        this.reportScreen()
        return
      }
    }
    // A question belongs to the exchange; everything else to the board.
    const host = push.format === 'ask' ? this.feed.slotFor('ask_panel') : this.boardSlot()
    const piece = this.makePiece(host, push.title, push.format)
    if (push.file) piece.file = push.file
    piece.frame = this.mountFrame(piece.body, url, push.format === 'html' ? 440 : 64)
    this.pieces.set(push.title, piece)
    if (push.format !== 'ask') this.focusOn(piece, true)
    this.grew()
    this.reportScreen()
  }

  /** clear_panel: fold what is up rather than delete it — it is still part of the story. */
  clear(): void {
    for (const p of this.pieces.values()) if (!this.pinned.has(p)) this.minimize(p, true)
    for (const b of this.browsers) if (!this.pinned.has(b.piece)) this.minimize(b.piece, true)
  }

  private visible(node: HTMLElement): boolean {
    const r = node.getBoundingClientRect()
    const s = this.scroller.getBoundingClientRect()
    return r.bottom > s.top && r.top < s.bottom
  }

  private async showMedia(m: CanvasMedia): Promise<void> {
    await this.settle()
    const host = this.boardSlot()
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
    this.focusOn(piece, true)
    this.grew()
  }

  // ================================================================ the live browser

  private async openBrowser(url: string, title: string, tool: string): Promise<Browser> {
    await this.settle()
    const host = this.boardSlot()
    void tool
    const piece = this.makePiece(host, title || url, 'url')
    const view = document.createElement('webview') as WebviewTag
    view.className = 'loom-web'
    view.setAttribute('allowpopups', 'false')
    // The browser's PDF viewer is a plugin: without this a PDF is a blank page.
    view.setAttribute('plugins', '')
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
    piece.extra = [
      ['reload', 'Reload', () => view.reload()],
      ['out', 'Open in your browser', () => void window.open(view.getURL() || url, '_blank')],
    ]
    const browser: Browser = { piece, view, legend, ready }
    this.browsers.push(browser)
    this.focusOn(piece, true)
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
      this.minimize(b.piece, false)
      if (!this.visible(b.piece.el)) this.reveal(b.piece.el, 'center')
      reply({ ok: true, found: result?.found ?? 0, missing: result?.missing ?? [], url: b.view.getURL() })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // ================================================================ steps, sign

  /** When each step started and finished, so the card can say how long things took. */
  private readonly stepTimes = new Map<string, { start?: number; end?: number }>()
  private planTimer = 0

  /**
   * The plan of the work, as the card at the top of the canvas: every step with its state,
   * a check that draws itself when one is done, the step in progress carrying what Claude
   * is doing right now, how long each took, and a progress line. It is updated, never
   * redrawn — a step that changes animates, the rest stay still — and it stays across
   * turns until the work is done, when it folds to one line you can open again.
   */
  private setTodos(list: Todo[]): void {
    this.todos = list
    const now = Date.now()
    if (!list.length) {
      this.plan.classList.remove('is-on')
      // An empty plan takes it off the screen.
      const p = this.planPiece
      this.planPiece = null
      if (p?.el.isConnected) (this.pinned.has(p) ? this.unpin(p) : this.dismiss(p))
      this.planGone = false
      return
    }
    // A different plan (other steps): start the timings over.
    const key = list.map((t) => t.content).join('\u0001')
    if (this.plan.dataset['key'] !== key) {
      if (!this.plan.dataset['key'] || !list.some((t) => this.stepTimes.has(t.content))) {
        this.stepTimes.clear()
        // A new plan is shown even if the last one was closed.
        this.planGone = false
      }
      this.plan.dataset['key'] = key
    }
    for (const t of list) {
      const st = this.stepTimes.get(t.content) ?? {}
      if (t.status === 'in_progress' && !st.start) st.start = now
      if (t.status === 'completed') {
        st.start ??= now
        st.end ??= now
      }
      if (t.status !== 'completed') delete st.end
      this.stepTimes.set(t.content, st)
    }
    const done = list.filter((t) => t.status === 'completed').length
    const complete = done === list.length

    if (!this.plan.firstChild) {
      this.plan.innerHTML =
        `<div class="loom-plan-head"><span class="loom-plan-title"></span><span class="loom-plan-count"></span><span class="loom-plan-time"></span></div>` +
        `<div class="loom-plan-bar"><i></i></div><ol class="loom-plan-steps"></ol>`
      this.plan.querySelector('.loom-plan-head')?.addEventListener('click', () => {
        if (this.plan.classList.contains('is-complete')) this.plan.classList.toggle('is-open')
      })
    }
    this.plan.querySelector('.loom-plan-title')!.textContent = this.stepsTitle || 'Plan'
    this.plan.querySelector('.loom-plan-count')!.textContent = `${done}/${list.length}`
    ;(this.plan.querySelector('.loom-plan-bar i') as HTMLElement).style.width = `${(done / list.length) * 100}%`

    const ol = this.plan.querySelector('.loom-plan-steps')!
    // Keyed by the step's words: an unchanged step keeps its element, so only what changes moves.
    const existing = new Map<string, HTMLElement>()
    ol.querySelectorAll<HTMLElement>(':scope > li').forEach((li) => existing.set(li.dataset['k'] ?? '', li))
    const keep = new Set<string>()
    list.forEach((t, i) => {
      const k = t.content
      keep.add(k)
      let li = existing.get(k)
      if (!li) {
        li = document.createElement('li')
        li.dataset['k'] = k
        li.innerHTML =
          `<span class="m"><svg viewBox="0 0 20 20" aria-hidden="true"><circle class="ring" cx="10" cy="10" r="8"/><circle class="spin" cx="10" cy="10" r="8"/><path class="tick" d="M6 10.5l2.6 2.6L14 7.6"/></svg></span>` +
          `<span class="body"><span class="text"></span><span class="now"></span></span><span class="dur"></span>`
      }
      const state = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'todo'
      if (li.dataset['state'] && li.dataset['state'] !== state) {
        li.classList.add('is-changing')
        window.setTimeout(() => li?.classList.remove('is-changing'), 700)
      }
      li.dataset['state'] = state
      li.querySelector('.text')!.textContent = state === 'active' && t.activeForm ? t.activeForm : t.content
      if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] ?? null)
    })
    existing.forEach((li, k) => {
      if (!keep.has(k)) li.remove()
    })
    this.plan.classList.toggle('is-complete', complete)
    if (complete) this.plan.classList.remove('is-open')
    this.plan.classList.add('is-on')
    this.showPlan()
    this.tickPlan()
    if (!this.planTimer) this.planTimer = window.setInterval(() => this.tickPlan(), 1000)
  }

  /** The plan's object: made on the first step, kept in view as the work moves on. */
  private planPiece: Piece | null = null
  /** You closed this plan: its updates do not bring it back (a new plan does). */
  private planGone = false

  private showPlan(): void {
    if (this.planGone) return
    const title = this.stepsTitle || 'Plan'
    let p = this.planPiece
    if (!p || !p.el.isConnected) {
      p = this.makePiece(this.boardSlot(), title, 'steps')
      p.body.appendChild(this.plan)
      this.pieces.set(title, p)
      this.planPiece = p
      this.focusOn(p, true)
      this.grew()
      this.reportScreen()
      return
    }
    p.el.querySelector('.loom-piece-title')!.textContent = title
    // Still in an earlier turn's reply: it follows the work to the turn on screen, as the
    // plan always has. Placed on the screen, it stays where it was put.
    const newest = this.feed.turns().at(-1)
    if (!this.pinned.has(p) && newest && !newest.contains(p.el)) {
      const slot = this.boardSlot()
      const old = p.el.parentElement
      slot.appendChild(p.el)
      if (old?.classList.contains('loom-slot') && !old.childElementCount) old.remove()
      this.reportScreen()
    }
  }

  /** The plan's object was removed by hand: leave this plan off the screen. */
  private planClosed(piece: Piece): void {
    if (piece !== this.planPiece) return
    this.planPiece = null
    this.planGone = true
  }

  /** The clocks on the plan, and the live line under the step in progress. */
  private tickPlan(): void {
    if (!this.plan.classList.contains('is-on')) return
    const now = Date.now()
    const dur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
    let first = Infinity
    let last = 0
    this.plan.querySelectorAll<HTMLElement>('.loom-plan-steps > li').forEach((li) => {
      const t = this.stepTimes.get(li.dataset['k'] ?? '')
      const el = li.querySelector('.dur')!
      if (t?.start) first = Math.min(first, t.start)
      if (t?.end) last = Math.max(last, t.end)
      el.textContent = t?.start ? dur((t.end ?? now) - t.start) : ''
      const live = li.querySelector('.now')!
      live.textContent = li.dataset['state'] === 'active' && this.working ? this.nowText : ''
      const carried = this.stepPieces(li.dataset['k'] ?? '')
      let tag = li.querySelector<HTMLElement>('.att')
      if (carried.length) {
        if (!tag) {
          tag = document.createElement('span')
          tag.className = 'att'
          li.querySelector('.body')?.appendChild(tag)
          li.addEventListener('click', () => {
            const top = this.stepPieces(li.dataset['k'] ?? '')[0]
            if (top) {
              const turn = top.el.closest<HTMLElement>('.loom-turn')
              const turns = this.feed.turns()
              if (turn && turn !== this.shown) {
                this.viewing = turn === turns[turns.length - 1] ? null : turn
                this.restage()
              }
              this.focusOn(top)
              this.reveal(top.el, 'nearest')
            }
          })
        }
        tag.textContent = carried.map((p) => p.title).slice(0, 3).join(' · ') + (carried.length > 3 ? ` +${carried.length - 3}` : '')
        li.classList.add('has-att')
      } else if (tag) {
        tag.remove()
        li.classList.remove('has-att')
      }
    })
    const complete = this.plan.classList.contains('is-complete')
    const total = first === Infinity ? 0 : (complete ? last : now) - first
    this.plan.querySelector('.loom-plan-time')!.textContent = total ? `${complete ? 'done · ' : ''}${dur(total)}` : ''
    if (complete && this.planTimer) {
      window.clearInterval(this.planTimer)
      this.planTimer = 0
    }
  }

  private renderSign(): void {
    const n = this.pinned.size
    this.renderRail()
    void n
    this.sign.innerHTML = viewSwitch(false)
    this.rawPill.innerHTML = viewSwitch(true)
  }

  /**
   * One point per turn, oldest at the top, joined by a line that grows as turns are added.
   * The turn on screen is filled; the turn in progress breathes while Claude works on it.
   * Hover shows what you asked.
   */
  private renderRail(): void {
    const turns = this.feed.turns()
    const at = this.shown ? turns.indexOf(this.shown) : turns.length - 1
    this.rail.classList.toggle('is-on', turns.length > 0)
    while (this.rail.children.length > turns.length) this.rail.lastElementChild?.remove()
    turns.forEach((t, i) => {
      let dot = this.rail.children[i] as HTMLElement | undefined
      if (!dot) {
        const b = document.createElement('button')
        b.type = 'button'
        dot = b
        dot.className = 'loom-dot'
        dot.dataset['turn'] = String(i)
        this.rail.appendChild(dot)
      }
      const asked = (t.querySelector('.loom-ask-text, .loom-ask')?.textContent ?? '').replace(/^❯\s*/, '').trim()
      dot.title = `Turn ${i + 1}${asked ? ` — ${asked.slice(0, 90)}${asked.length > 90 ? '…' : ''}` : ''}`
      dot.classList.toggle('is-at', i === at)
      dot.classList.toggle('is-live', i === turns.length - 1)
      dot.classList.toggle('is-working', i === turns.length - 1 && this.working)
    })
    this.rail.classList.toggle('is-working', this.working)
  }

  private barKey = ''
  private cost: EmberCost | null = null

  /**
   * Claude Code's mode line and Ember's status line, said again under the frame: the
   * permission mode as a chip (click it, or Shift+Tab, to cycle), the model, how full
   * the context is, the cost. Whatever else the mode line says is kept, dimmed.
   */
  private renderBar(foot: string[]): void {
    const lines = foot.map((r) => r.trim()).filter(Boolean)
    const modeRe = /shift\+tab|for shortcuts|permissions on|accept edits|plan mode|auto mode|esc to interrupt|for agents/i
    const modeLine = lines.find((r) => modeRe.test(r)) ?? ''
    const key = `${modeLine}|${this.status?.at ?? ''}|${this.cost?.tokens ?? ''}|${this.status ? '' : lines.join('|')}`
    if (key === this.barKey) return
    this.barKey = key

    const modes: Array<[RegExp, string, string]> = [
      [/bypass permissions on/i, 'bypass', 'is-bypass'],
      [/accept edits on/i, 'accept edits', 'is-edits'],
      [/plan mode on/i, 'plan', 'is-plan'],
      [/auto mode on/i, 'auto', 'is-auto'],
      [/manual mode on/i, 'manual', 'is-default'],
    ]
    const hit = modes.find(([re]) => re.test(modeLine))
    const rest = modeLine
      .replace(hit?.[0] ?? /^$/, '')
      .replace(/\(shift\+tab to cycle\)/i, '')
      .replace(/^[^\w(←?]+/u, '')
      .split(/\s+·\s+/)
      .map((x) => x.trim())
      .filter((x) => x && !/^[⏵⏸▶►]+$/u.test(x))
      .join(' · ')

    const parts: string[] = []
    // Another agent's bar: its own status text, without Claude's permission modes.
    const other = !!this.session.announcedAgent && this.session.announcedAgent !== 'claude'
    if (other) {
      const said = lines.filter((r) => !/for shortcuts|^⚠\s*\d*$/.test(r)).map((r) => r.replace(/\s+⚠\s*\d+\s*$/, ''))
      const name = agentSpec(this.session.announcedAgent ?? '').name
      this.bar.innerHTML = `<span class="loom-bar-model">${escapeHtml(name)}</span>${said.length ? `<span class="loom-bar-rest">${escapeHtml(said.join(' · '))}</span>` : ''}`
      return
    }
    parts.push(`<button type="button" class="loom-bar-mode ${hit?.[2] ?? 'is-default'}" title="Permission mode — click or Shift+Tab to cycle"><i></i>${escapeHtml(hit?.[1] ?? 'default')}</button>`)
    const st = this.status
    if (st) {
      const size = st.contextSize && st.contextSize >= 1_000_000 && !/context|1M/i.test(st.model) ? ' 1M' : ''
      parts.push(`<span class="loom-bar-model">${escapeHtml(st.model)}${size}</span>`)
      if (st.contextPercent != null) {
        const p = Math.max(0, Math.min(100, Math.round(st.contextPercent)))
        parts.push(`<span class="loom-bar-ctx${p >= 80 ? ' is-high' : ''}" title="Context used"><i style="--p:${p}%"></i>${p}%</span>`)
      }
      if (st.costUsd != null) parts.push(`<span class="loom-bar-cost" title="This session, all of it">$${st.costUsd.toFixed(2)}</span>`)
    } else {
      const other = lines.filter((r) => r !== modeLine).join(' · ')
      if (other) parts.push(`<span class="loom-bar-model">${escapeHtml(other)}</span>`)
    }
    const c = this.cost
    if (c && c.tokens) {
      const share = st?.costUsd ? ` · ${Math.round((c.usd / st.costUsd) * 100)}%` : ''
      const tip =
        `What Ember's own tools cost this session (estimate):
` +
        `  written into them  ${fmtTokens(c.outTokens)}
` +
        `  re-read while in context  ${fmtTokens(c.carryTokens)}
` +
        `  tool instructions and definitions  ${fmtTokens(c.overheadTokens)}
` +
        `over ${c.calls} calls`
      parts.push(`<span class="loom-bar-ember" title="${escapeHtml(tip)}">Ember ${fmtTokens(c.tokens)} · $${c.usd.toFixed(2)}${share}</span>`)
    }
    parts.push(`<span class="loom-bar-rest">${escapeHtml(rest)}</span>`)
    this.bar.innerHTML = parts.join('')
  }

  /** What this view believes, for probes and for support: `window.__ember.loom()`. */
  // ================================================================ the composer's place

  private readonly above = div('loom-above')

  /** Claude Code is in this tab (on the canvas or in its own view): Alt+V pastes a picture. */
  get isClaude(): boolean {
    return this.claudeOn
  }

  /** Probe-only: hand the canvas transcript lines as if they came from the session's log. */
  feedForProbe(lines: Array<Record<string, unknown>>): void {
    this.feed.add(lines as never)
    this.hint.classList.toggle('is-gone', !this.feed.isEmpty)
    this.restage()
    this.renderNow()
  }

  /** Probe-only: the tab's session moved to another transcript, as main reports it. */
  switchForProbe(first = false, fresh = false): void {
    this.feed.switchSession(first, fresh)
    this.restage()
  }

  debug(): {
    mode: Mode
    raw: boolean
    working: boolean
    dock: Dock | null
    todos: number
    pieces: number
    browsers: number
    turns: number
    says: number
    rows: string[]
    sessionId: string
    wrapper: Record<string, unknown> | null
    claude: boolean
    paneVisible: boolean
    text: string
    hint: boolean
    bar: string
  } {
    return {
      hint: !this.hint.classList.contains('is-gone') && this.el.classList.contains('is-on'),
      bar: this.bar.innerText,
      wrapper: this.wrapper?.debug() ?? null,
      claude: this.claudeOn,
      paneVisible: this.session.el.style.visibility !== 'hidden',
      text: this.feed.el.innerText,
      rows: this.rowsText(),
      sessionId: this.session.id,
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
    this.wrapper?.dispose()
    this.wrapper = null
    this.session.focusInstead = null
    const pane = this.session.el
    pane.style.visibility = ''
    pane.style.transform = ''
    pane.style.clipPath = ''
    pane.style.maskImage = ''
    pane.classList.remove('is-loom')
    this.panes.classList.remove('has-loom')
    delete this.panes.dataset['loom']
    this.el.remove()
    this.frame.remove()
    this.bar.remove()
    this.barPick.remove()
    this.rawPill.remove()
  }
}

function div(cls: string, html?: string): HTMLElement {
  const e = document.createElement('div')
  e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tok` : n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`
}

/** A todo's text: markdown links become short clickable words; everything else stays text. */
function linkify(text: string): string {
  return escapeHtml(text).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label: string, url: string) => `<a class="loom-link" href="${url}">${label}</a>`)
}

/**
 * Whether an agent message is a result rather than narration: it has structure (a table,
 * a list, a heading, code, an object) or it is long. "Let me check the config" is not;
 * a gap list or a go/no-go table is, and must not vanish when the turn ends on a one-liner.
 */
function holdsResult(say: HTMLElement): boolean {
  if (say.querySelector('table, ul, ol, pre, h1, h2, h3, h4, blockquote, img, iframe, .loom-diagram, .loom-liftable')) return true
  return (say.textContent ?? '').trim().length > 320
}

function sameTitle(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  return n(a) === n(b)
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
