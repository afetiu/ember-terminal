import type { ActivitySnapshot } from '../core/Activity'
import type { ActivityEntry, ClaudeStatus, ClaudeUsage, GitStatus, NoteMeta, SessionBrief } from '@shared/types'

/**
 * What a todo or notes tab is showing, in the words its own surface would use.
 *
 * A tab holding the list or the notes is not a shell, and a card that described it as
 * one — "PowerShell", "Not a Claude session" — was telling the truth about the wrong
 * thing. The surface answers for itself instead.
 */
export interface SurfaceBrief {
  kind: 'todo' | 'notes'
  /** The name on the card. */
  what: string
  /** The counts, where a session card carries its state: "4 open · 2 done". */
  count: string
  /** Beside the name: where the surface is, not where a shell is. */
  where: string
  /** The one line worth reading from it: the next item, or the note being written. */
  line: string
}

/** One option of a picker a session is showing: "1. Yes". */
export interface OverviewChoice {
  key: string
  label: string
  selected: boolean
}

/** One session, as the overview sees it. Built by App from what it already tracks. */
export interface OverviewRow {
  tabId: string
  title: string
  cwd: string
  git: GitStatus | null
  url: string | null
  activity: ActivitySnapshot
  claude: ClaudeStatus | null
  brief: SessionBrief | null
  unread: number
  isActive: boolean
  panes: number
  /** A theme colour of its own, so its lines in the log can be told apart at a glance. */
  hue: string
  /**
   * While it waits on a picker: the bottom of its screen, as text. The question a
   * permission prompt asks is drawn by the TUI and never written to the transcript, so
   * the screen is the only place it exists.
   */
  screen: string[] | null
  choices: OverviewChoice[]
}

export interface OverviewHooks {
  /** Go to that tab. */
  onActivate: (tabId: string) => void
  /** Type this into that tab's session and press Enter. */
  onSend: (tabId: string, text: string) => void
  /** Press these keys in that tab's session, exactly — a picker's number, Enter, Esc. */
  onKeys: (tabId: string, data: string) => void
  /** The tab's title follows the counts. */
  onTitle: (title: string) => void
  /** Leave — back to the shell underneath, or the session you came from. */
  onClose?: () => void
  /** Say this to the orchestrator — the same conversation the sidebar's card holds. */
  onOrchestrate: (text: string) => void
  onOpenTodo: () => void
  onOpenNotes: (id?: string) => void
  onNewNote: () => void
  /** The overview wrote the todo file; whoever counts it should count again. */
  onTodoChanged?: () => void
}

/** The orchestrator as the page shows it: its last reply and nothing older. */
export interface OverviewOrch {
  said: string
  did: string[]
  busy: boolean
}

/** "just now", "3m ago" — for the sentence's age. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/** 1234 -> "1.2k", 1234567 -> "1.23M". */
function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function money(n: number): string {
  return `$${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)}`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Enough markdown to read a reply by: fences, inline code, bold, headings, bullets.
 * Everything is escaped first and only these tags are introduced, so model text never
 * reaches the page as markup. Links read as their words; nothing here navigates.
 */
function mdLite(src: string): string {
  const blocks = src.split(/```/)
  return blocks
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${esc(part.replace(/^[^\n]*\n/, '').replace(/\n$/, ''))}</pre>`
      return esc(part)
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,6}\s+(.+)$/gm, '<b class="h">$1</b>')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })
    .filter(Boolean)
    .join('\n')
}

/** The mark each kind of action gets in the log. Plain glyphs; the font has them all. */
const GLYPH: Record<ActivityEntry['kind'], string> = {
  edit: '✎',
  write: '+',
  read: '·',
  search: '⌕',
  run: '$',
  agent: '⇢',
  web: '↗',
  tool: '◇',
  done: '✓',
}

/** What "changes only" keeps: the things that move the work, not the looking around. */
const CHANGE_KINDS = new Set<ActivityEntry['kind']>(['edit', 'write', 'run', 'agent', 'done'])

/** The DOM of one card, kept so a refresh writes only the text that changed. */
interface CardNode {
  root: HTMLElement
  dot: HTMLElement
  title: HTMLElement
  where: HTMLElement
  pill: HTMLElement
  expand: HTMLButtonElement
  said: HTMLElement
  full: HTMLElement
  fullSig: string
  screen: HTMLElement
  screenSig: string
  keys: HTMLElement
  keysSig: string
  doing: HTMLElement
  meta: HTMLElement
  metaSig: string
  ctx: HTMLElement
  ctxFill: HTMLElement
  recent: HTMLElement
  recentSig: string
  ask: HTMLElement
  input: HTMLInputElement
}

interface Tile {
  root: HTMLElement
  value: HTMLElement
  sub: HTMLElement
}

interface TodoItem {
  line: string
  text: string
}

/**
 * Every session on one screen, built to be worked from rather than glanced at.
 *
 * Along the top, the numbers that say how the day is going — sessions, tokens, spend,
 * lines changed, the fullest context, the plan. Below, a card per session in tab
 * order (it never reshuffles under your cursor): who it is, what it last said, what it
 * is doing, and a box to type into it. A card that wants you grows: a picker shows the
 * session's own screen with its options as buttons, a finished turn shows the whole
 * reply. Any card opens up in place to read everything without leaving the page.
 *
 * Down the side, the todo list and the notes, live and tickable, and under them a quiet
 * log of everything every session did — one line an action, newest at the bottom.
 */
export class OverviewView {
  readonly el: HTMLElement
  private readonly summaryEl: HTMLElement
  private readonly grid: HTMLElement
  private readonly empty: HTMLElement
  private readonly nodes = new Map<string, CardNode>()
  private readonly expanded = new Set<string>()
  /**
   * The reply each card was last seen with. A reply that came in after that is unread,
   * and an unread reply stays open on its card until you touch the card — a finished
   * turn is the content you most need to see, and it should not fold away on a timer.
   */
  private readonly seenSaid = new Map<string, number>()
  private lastTitle = ''
  private disposed = false
  private readonly unsubs: Array<() => void> = []
  private rows: OverviewRow[] = []

  private readonly tiles: Record<'sessions' | 'tokens' | 'spend' | 'changes' | 'context' | 'plan' | 'pace', Tile>
  private readonly spark: SVGPathElement
  private readonly sparkArea: SVGPathElement

  private readonly dockDot: HTMLElement
  private readonly dockSaid: HTMLElement
  private readonly dockDid: HTMLElement
  private readonly dockInput: HTMLInputElement

  private readonly todoList: HTMLElement
  private readonly todoCount: HTMLElement
  private readonly todoInput: HTMLInputElement
  private todoItems: TodoItem[] = []
  private readonly notesList: HTMLElement

  private readonly logEl: HTMLElement
  private readonly logFilterBtn: HTMLButtonElement
  private log: ActivityEntry[] = []
  private logChangesOnly = true
  /** Bumped when the log changes, so expanded cards rebuild their recent lines only then. */
  private logVersion = 0
  private renderedLogVersion = -1

  constructor(private readonly hooks: OverviewHooks) {
    this.el = document.createElement('div')
    this.el.className = 'ember-overview'
    this.el.tabIndex = -1
    try {
      this.logChangesOnly = localStorage.getItem('ember.overview.log') !== 'all'
    } catch {
      /* private storage is a convenience */
    }

    // ---- head: the name, a sentence of counts, and the way back ----
    const head = document.createElement('header')
    head.className = 'ember-ov-head'
    const h = document.createElement('h2')
    h.textContent = 'Overview'
    this.summaryEl = document.createElement('span')
    this.summaryEl.className = 'ember-ov-summary'
    const live = document.createElement('span')
    live.className = 'ember-ov-live'
    live.textContent = 'live'
    head.append(h, this.summaryEl, live)
    if (hooks.onClose) {
      const back = document.createElement('button')
      back.className = 'ember-ov-back'
      back.textContent = 'Back'
      back.title = 'Back  (Esc)'
      back.addEventListener('click', () => hooks.onClose?.())
      head.append(back)
    }

    // ---- the numbers ----
    const kpis = document.createElement('div')
    kpis.className = 'ember-ov-kpis'
    const tile = (key: string, label: string, hint: string): Tile => {
      const root = document.createElement('div')
      root.className = 'ember-ov-kpi'
      root.dataset['k'] = key
      root.title = hint
      const l = document.createElement('span')
      l.className = 'ember-ov-kpi-label'
      l.textContent = label
      const value = document.createElement('span')
      value.className = 'ember-ov-kpi-value'
      const sub = document.createElement('span')
      sub.className = 'ember-ov-kpi-sub'
      root.append(l, value, sub)
      kpis.append(root)
      return { root, value, sub }
    }
    this.tiles = {
      sessions: tile('sessions', 'Sessions', 'Claude sessions open in Ember'),
      tokens: tile('tokens', 'Tokens', 'Every token the open sessions have processed: input, cache and output'),
      spend: tile('spend', 'Spend', 'What the open sessions report through their status line'),
      changes: tile('changes', 'Changes', 'Lines added and removed by the sessions’ edit calls'),
      context: tile('context', 'Context', 'The fullest context window — a session near 100% is about to compact'),
      plan: tile('plan', 'Plan', 'Your plan’s usage windows'),
      pace: tile('pace', 'Pace', 'Actions across every session over the last hour'),
    }
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 100 24')
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.classList.add('ember-ov-spark')
    this.sparkArea = document.createElementNS(NS, 'path')
    this.sparkArea.classList.add('is-area')
    this.spark = document.createElementNS(NS, 'path')
    this.spark.classList.add('is-line')
    svg.append(this.sparkArea, this.spark)
    this.tiles.pace.value.replaceWith(svg)
    this.tiles.pace.value = svg as unknown as HTMLElement

    // ---- the cards ----
    const main = document.createElement('div')
    main.className = 'ember-ov-main'
    this.grid = document.createElement('div')
    this.grid.className = 'ember-ov-grid'
    this.empty = document.createElement('div')
    this.empty.className = 'ember-ov-empty'
    this.empty.textContent = 'No sessions yet. Ctrl+Shift+T opens one.'
    this.empty.hidden = true
    const scroller = document.createElement('div')
    scroller.className = 'ember-ov-scroll'
    scroller.append(this.grid, this.empty)

    // ---- the orchestrator: one exchange, never a log ----
    const dock = document.createElement('div')
    dock.className = 'ember-ov-dock'
    this.dockDot = document.createElement('span')
    this.dockDot.className = 'ember-ov-dock-dot'
    const who = document.createElement('span')
    who.className = 'ember-ov-dock-who'
    who.append(this.dockDot, document.createTextNode('Orchestrator'))
    this.dockSaid = document.createElement('span')
    this.dockSaid.className = 'ember-ov-dock-said is-quiet'
    this.dockDid = document.createElement('span')
    this.dockDid.className = 'ember-ov-dock-did'
    this.dockDid.hidden = true
    const said = document.createElement('div')
    said.className = 'ember-ov-dock-text'
    said.append(this.dockSaid, this.dockDid)
    const dockAsk = this.composer('Ask, or hand out work…', (text) => hooks.onOrchestrate(text))
    this.dockInput = dockAsk.input
    dockAsk.root.classList.add('is-dock')
    dock.append(who, said, dockAsk.root)
    main.append(scroller, dock)

    // ---- the rail: todo, notes, log ----
    const rail = document.createElement('aside')
    rail.className = 'ember-ov-rail'

    const todo = this.section('Todo', 'Open the list  (Ctrl+Shift+D)', () => hooks.onOpenTodo())
    this.todoCount = todo.count
    this.todoList = document.createElement('div')
    this.todoList.className = 'ember-ov-todo'
    const add = this.composer('Add to the list…', (text) => void this.addTodo(text))
    this.todoInput = add.input
    add.root.classList.add('is-rail')
    todo.root.append(this.todoList, add.root)

    const notes = this.section('Notes', 'All notes', () => hooks.onOpenNotes())
    const newNote = document.createElement('button')
    newNote.className = 'ember-ov-sec-btn'
    newNote.type = 'button'
    newNote.textContent = '+'
    newNote.title = 'New note'
    newNote.addEventListener('click', () => hooks.onNewNote())
    notes.head.insertBefore(newNote, notes.open)
    this.notesList = document.createElement('div')
    this.notesList.className = 'ember-ov-notes'
    notes.root.append(this.notesList)

    const logSec = this.section('Activity', '', null)
    logSec.root.classList.add('is-log')
    this.logFilterBtn = document.createElement('button')
    this.logFilterBtn.className = 'ember-ov-sec-btn is-filter'
    this.logFilterBtn.type = 'button'
    this.logFilterBtn.addEventListener('click', () => {
      this.logChangesOnly = !this.logChangesOnly
      try {
        localStorage.setItem('ember.overview.log', this.logChangesOnly ? 'changes' : 'all')
      } catch {
        /* see above */
      }
      this.renderLog(true)
    })
    logSec.head.append(this.logFilterBtn)
    this.logEl = document.createElement('div')
    this.logEl.className = 'ember-ov-log'
    logSec.root.append(this.logEl)

    rail.append(todo.root, notes.root, logSec.root)

    const body = document.createElement('div')
    body.className = 'ember-ov-body'
    body.append(main, rail)
    this.el.append(head, kpis, body)

    this.el.addEventListener('keydown', (e) => this.onKey(e))

    // The rail reads the files itself, like the todo surface does: the overview shows
    // the list whether or not a todo tab is open anywhere.
    void this.loadTodo()
    void this.loadNotes()
    let pending: number | null = null
    this.unsubs.push(
      window.ember.notes.onChanged(() => {
        if (pending !== null) window.clearTimeout(pending)
        pending = window.setTimeout(() => {
          pending = null
          void this.loadTodo()
          void this.loadNotes()
        }, 120)
      })
    )
    void window.ember.overview.activity().then((all) => {
      if (this.disposed) return
      this.log = all
      this.logVersion++
      this.renderLog(true)
    })
    this.unsubs.push(
      window.ember.overview.onActivity((more) => {
        this.log.push(...more)
        this.log.sort((a, b) => a.at - b.at)
        if (this.log.length > 600) this.log.splice(0, this.log.length - 600)
        this.logVersion++
        this.renderLog(false)
      })
    )
  }

  /** Put the orchestrator's caret in the line at the bottom. */
  focusOrchestrator(): void {
    this.dockInput.focus()
  }

  focus(): void {
    this.el.focus()
  }

  // ---------- building blocks ----------

  private section(name: string, openTitle: string, onOpen: (() => void) | null) {
    const root = document.createElement('section')
    root.className = 'ember-ov-sec'
    const head = document.createElement('div')
    head.className = 'ember-ov-sec-head'
    const label = document.createElement('span')
    label.className = 'ember-ov-sec-name'
    label.textContent = name
    const count = document.createElement('span')
    count.className = 'ember-ov-sec-count'
    head.append(label, count)
    const open = document.createElement('button')
    open.className = 'ember-ov-sec-btn'
    open.type = 'button'
    open.textContent = '↗'
    open.title = openTitle
    open.hidden = !onOpen
    if (onOpen) open.addEventListener('click', onOpen)
    head.append(open)
    root.append(head)
    return { root, head, count, open }
  }

  private composer(placeholder: string, onSend: (text: string) => void): { root: HTMLElement; input: HTMLInputElement } {
    const root = document.createElement('div')
    root.className = 'ember-ov-ask'
    const input = document.createElement('input')
    input.className = 'ember-ov-input'
    input.spellcheck = false
    input.placeholder = placeholder
    const send = () => {
      const text = input.value.trim()
      if (!text) return
      onSend(text)
      input.value = ''
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        if (input.value) input.value = ''
        else (input.closest('.ember-ov-card') as HTMLElement | null)?.focus() ?? this.el.focus()
        return
      }
      if (e.key !== 'Enter') return
      e.preventDefault()
      send()
    })
    const btn = document.createElement('button')
    btn.className = 'ember-ov-send'
    btn.type = 'button'
    btn.textContent = '↵'
    btn.title = 'Send  (Enter)'
    btn.tabIndex = -1
    btn.addEventListener('click', send)
    root.append(input, btn)
    return { root, input }
  }

  // ---------- keyboard ----------

  /**
   * Arrows walk the cards, Enter goes to one, Space opens it up in place, and typing
   * on a focused card starts an answer in its box — the page can be driven without
   * the mouse, the way the rest of Ember can.
   */
  private onKey(e: KeyboardEvent): void {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
    const card = t instanceof HTMLElement ? (t.closest('.ember-ov-card') as HTMLElement | null) : null
    if (e.key === 'Escape') {
      e.preventDefault()
      if (card) this.el.focus()
      else this.hooks.onClose?.()
      return
    }
    const cards = [...this.grid.querySelectorAll<HTMLElement>('.ember-ov-card')]
    if (!cards.length) return
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault()
      if (!card) return void cards[0]!.focus()
      const i = cards.indexOf(card)
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
      // Up and down move by a row: the card whose left edge lines up, or the nearest.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const r = card.getBoundingClientRect()
        const below = cards
          .filter((c) => (step > 0 ? c.getBoundingClientRect().top > r.bottom - 4 : c.getBoundingClientRect().bottom < r.top + 4))
          .sort((a, b) => {
            const da = Math.abs(a.getBoundingClientRect().top - r.top) * 4 + Math.abs(a.getBoundingClientRect().left - r.left)
            const db = Math.abs(b.getBoundingClientRect().top - r.top) * 4 + Math.abs(b.getBoundingClientRect().left - r.left)
            return da - db
          })
        if (below[0]) below[0].focus()
        return
      }
      cards[(i + step + cards.length) % cards.length]!.focus()
      return
    }
    if (!card) return
    const id = card.dataset['tabId']!
    if (e.key === 'Enter') {
      e.preventDefault()
      this.hooks.onActivate(id)
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      this.toggleExpand(id)
      return
    }
    // A printable key on a focused card: the start of an answer.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const node = this.nodes.get(id)
      if (node && !node.ask.hidden) node.input.focus()
    }
  }

  private toggleExpand(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    const node = this.nodes.get(id)
    const row = this.rows.find((r) => r.tabId === id)
    if (node && row) {
      node.fullSig = ''
      node.recentSig = ''
      this.updateCard(node, row)
      node.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  // ---------- render ----------

  private renderDock(orch: OverviewOrch): void {
    this.dockDot.classList.toggle('is-busy', orch.busy)
    const said = orch.busy && !orch.said ? 'Working on it…' : orch.said || 'Nothing said yet. Ask it something, or hand out work.'
    if (this.dockSaid.textContent !== said) this.dockSaid.textContent = said
    this.dockSaid.title = orch.said
    this.dockSaid.classList.toggle('is-quiet', !orch.said)
    const did = orch.did.length ? orch.did.join(' · ') : ''
    if (this.dockDid.textContent !== did) this.dockDid.textContent = did
    this.dockDid.hidden = !did
    this.dockInput.placeholder = orch.busy ? 'It is working — you can still say something…' : 'Ask the orchestrator, or hand out work…'
  }

  /** Called on every app refresh with every session; only what changed is written. */
  render(rows: OverviewRow[], orch: OverviewOrch, plan: ClaudeUsage | null): void {
    if (this.disposed) return
    this.rows = rows
    this.renderDock(orch)

    const waiting = rows.filter((r) => r.activity.state === 'attention').length
    const working = rows.filter((r) => r.activity.state === 'working').length
    const parts = [`${rows.length} session${rows.length === 1 ? '' : 's'}`]
    if (working) parts.push(`${working} working`)
    if (waiting) parts.push(`${waiting} need${waiting === 1 ? 's' : ''} you`)
    const summary = parts.join(' · ')
    if (this.summaryEl.textContent !== summary) this.summaryEl.textContent = summary
    // Only on change: the title hook re-syncs the tabs, which renders this again, and a
    // hook that fires on every render is a loop that never reaches the cards.
    const title = waiting ? `Overview · ${waiting}` : 'Overview'
    if (title !== this.lastTitle) {
      this.lastTitle = title
      this.hooks.onTitle(title)
    }
    this.renderKpis(rows, plan)
    this.empty.hidden = rows.length > 0

    const seen = new Set<string>()
    let prev: HTMLElement | null = null
    for (const row of rows) {
      seen.add(row.tabId)
      let node = this.nodes.get(row.tabId)
      if (!node) {
        node = this.createCard(row)
        this.nodes.set(row.tabId, node)
      }
      this.updateCard(node, row)
      // Tab order, kept without rebuilding: move a node only when it is out of place.
      const want: Element | null = prev ? prev.nextElementSibling : this.grid.firstElementChild
      if (want !== node.root) this.grid.insertBefore(node.root, want)
      prev = node.root
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue
      node.root.remove()
      this.nodes.delete(id)
      this.expanded.delete(id)
    }
    // Session names in the log follow renames.
    if (this.renderedLogVersion !== this.logVersion) this.renderLog(false)
  }

  private renderKpis(rows: OverviewRow[], plan: ClaudeUsage | null): void {
    const set = (el: Element, text: string) => {
      if (el.textContent !== text) el.textContent = text
    }
    const t = this.tiles
    const claude = rows.filter((r) => r.brief || r.activity.isClaude)
    const working = rows.filter((r) => r.activity.state === 'working').length
    const waiting = rows.filter((r) => r.activity.state === 'attention').length
    set(t.sessions.value, String(rows.length))
    set(t.sessions.sub, [working ? `${working} working` : '', waiting ? `${waiting} waiting` : '', !working && !waiting ? `${claude.length} Claude` : ''].filter(Boolean).join(' · '))
    t.sessions.root.dataset['hot'] = String(waiting > 0)

    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let added = 0
    let removed = 0
    let files = 0
    let edits = 0
    for (const r of rows) {
      const b = r.brief
      if (!b) continue
      input += b.tokens.input
      output += b.tokens.output
      cacheRead += b.tokens.cacheRead
      cacheWrite += b.tokens.cacheWrite
      added += b.edits.added
      removed += b.edits.removed
      files += b.edits.files
      edits += b.edits.count
    }
    const total = input + output + cacheRead + cacheWrite
    const fed = input + cacheRead + cacheWrite
    set(t.tokens.value, total ? compact(total) : '—')
    set(t.tokens.sub, total ? `${compact(output)} out · ${fed ? Math.round((cacheRead / fed) * 100) : 0}% cached` : 'no transcripts yet')

    const costs = rows.map((r) => r.claude?.costUsd).filter((c): c is number => typeof c === 'number')
    set(t.spend.value, costs.length ? money(costs.reduce((a, b) => a + b, 0)) : '—')
    set(t.spend.sub, costs.length ? `${costs.length} session${costs.length === 1 ? '' : 's'} reporting` : 'status line off')

    set(t.changes.value, edits ? `+${compact(added)} −${compact(removed)}` : '—')
    set(t.changes.sub, edits ? `${files} file${files === 1 ? '' : 's'} · ${edits} edit${edits === 1 ? '' : 's'}` : 'nothing edited yet')

    let fullest: OverviewRow | null = null
    for (const r of rows) {
      const p = r.claude?.contextPercent
      if (typeof p === 'number' && (!fullest || p > (fullest.claude?.contextPercent ?? -1))) fullest = r
    }
    const pct = fullest?.claude?.contextPercent ?? null
    set(t.context.value, pct !== null ? `${Math.round(pct)}%` : '—')
    set(t.context.sub, fullest ? fullest.title : 'no status line')
    t.context.root.dataset['hot'] = String(pct !== null && pct >= 80)

    const limits = plan?.ok ? plan.limits : []
    t.plan.root.hidden = limits.length === 0
    if (limits.length) {
      const first = limits[0]!
      set(t.plan.value, `${Math.round(first.percent)}%`)
      const resets = first.resetsAt ? ` · resets ${clock(first.resetsAt)}` : ''
      const others = limits
        .slice(1, 2)
        .map((l) => `${l.label === 'weekly' ? 'week' : l.label} ${Math.round(l.percent)}%`)
        .join(' · ')
      set(t.plan.sub, `${first.label === 'session' ? '5h' : first.label}${resets}${others ? ` · ${others}` : ''}`)
      t.plan.root.dataset['hot'] = String(first.percent >= 80)
    }

    // The last hour in twenty slices of three minutes.
    const now = Date.now()
    const buckets = new Array<number>(20).fill(0)
    let hour = 0
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!
      const age = now - e.at
      if (age > 3_600_000) break
      if (age < 0) continue
      hour++
      buckets[19 - Math.min(19, Math.floor(age / 180_000))]!++
    }
    const max = Math.max(1, ...buckets)
    const pts = buckets.map((v, i) => `${((i / 19) * 100).toFixed(1)},${(22 - (v / max) * 19).toFixed(1)}`)
    const line = `M${pts.join(' L')}`
    if (this.spark.getAttribute('d') !== line) {
      this.spark.setAttribute('d', line)
      this.sparkArea.setAttribute('d', `${line} L100,24 L0,24 Z`)
    }
    set(t.pace.sub, hour ? `${hour} action${hour === 1 ? '' : 's'} this hour` : 'quiet this hour')
  }

  private createCard(row: OverviewRow): CardNode {
    const root = document.createElement('article')
    root.className = 'ember-ov-card'
    root.tabIndex = 0
    root.dataset['tabId'] = row.tabId
    const markSeen = () => {
      const b = this.rows.find((r) => r.tabId === row.tabId)?.brief
      if (b) this.seenSaid.set(row.tabId, b.saidAt)
    }
    root.addEventListener('focusin', (e) => {
      if (e.target instanceof HTMLInputElement) markSeen()
    })
    root.addEventListener('pointerdown', markSeen)
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      // Reading areas and controls are for staying; the rest of the card is for going.
      if (t.closest('button, input, .ember-ov-full, .ember-ov-screen, .ember-ov-recent')) return
      if (window.getSelection()?.toString()) return
      this.hooks.onActivate(row.tabId)
    })

    const top = document.createElement('div')
    top.className = 'ember-ov-card-top'
    const dot = document.createElement('span')
    dot.className = 'ember-ov-dot'
    const title = document.createElement('span')
    title.className = 'ember-ov-title'
    const where = document.createElement('span')
    where.className = 'ember-ov-where'
    const pill = document.createElement('span')
    pill.className = 'ember-ov-pill'
    const expand = document.createElement('button')
    expand.className = 'ember-ov-expand'
    expand.type = 'button'
    expand.addEventListener('click', () => this.toggleExpand(row.tabId))
    top.append(dot, title, where, pill, expand)

    const said = document.createElement('div')
    said.className = 'ember-ov-said'
    const full = document.createElement('div')
    full.className = 'ember-ov-full'
    full.hidden = true
    const screen = document.createElement('pre')
    screen.className = 'ember-ov-screen'
    screen.hidden = true
    const keys = document.createElement('div')
    keys.className = 'ember-ov-keys'
    keys.hidden = true
    const doing = document.createElement('div')
    doing.className = 'ember-ov-doing'
    doing.hidden = true
    const recent = document.createElement('div')
    recent.className = 'ember-ov-recent'
    recent.hidden = true

    const foot = document.createElement('div')
    foot.className = 'ember-ov-foot'
    const meta = document.createElement('span')
    meta.className = 'ember-ov-meta'
    const ctx = document.createElement('span')
    ctx.className = 'ember-ov-ctx'
    ctx.hidden = true
    const ctxFill = document.createElement('span')
    ctx.append(ctxFill)
    foot.append(meta, ctx)

    const ask = this.composer('Type to this session…', (text) => {
      this.hooks.onSend(row.tabId, text)
      root.classList.add('is-sent')
      window.setTimeout(() => root.classList.remove('is-sent'), 600)
    })

    root.append(top, said, full, screen, keys, doing, recent, foot, ask.root)
    return {
      root,
      dot,
      title,
      where,
      pill,
      expand,
      said,
      full,
      fullSig: '',
      screen,
      screenSig: '',
      keys,
      keysSig: '',
      doing,
      meta,
      metaSig: '',
      ctx,
      ctxFill,
      recent,
      recentSig: '',
      ask: ask.root,
      input: ask.input,
    }
  }

  private updateCard(node: CardNode, row: OverviewRow): void {
    const a = row.activity
    const b = row.brief
    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text
    }
    const isClaude = a.isClaude || b !== null
    const open = this.expanded.has(row.tabId)
    const question = a.state === 'attention' && a.attention === 'question' && !!row.screen?.length
    const handoff = a.state === 'attention' && a.attention === 'handoff'
    // First sight of a card counts as seen; so does being in its tab.
    if (!this.seenSaid.has(row.tabId) || row.isActive) this.seenSaid.set(row.tabId, b?.saidAt ?? 0)
    const unread = !!b?.saidAt && b.turnEnded && b.saidAt > (this.seenSaid.get(row.tabId) ?? 0)
    node.root.classList.toggle('is-unread', unread && a.state !== 'working')

    node.root.classList.toggle('is-active', row.isActive)
    node.root.classList.toggle('is-open', open)
    node.root.dataset['state'] = a.state
    node.root.dataset['attention'] = a.attention ?? ''
    node.root.dataset['claude'] = String(isClaude)
    node.root.style.setProperty('--hue', row.hue)

    set(node.title, row.title)
    set(node.where, row.cwd ? basename(row.cwd) : '')
    node.where.title = row.cwd

    const pill =
      a.state === 'attention'
        ? a.attention === 'question'
          ? 'needs you'
          : a.attention === 'handoff'
            ? 'your turn'
            : 'rang'
        : a.state === 'working'
          ? a.detail || 'working'
          : a.state === 'exited'
            ? 'exited'
            : unread
              ? 'new reply'
              : b?.saidAt
              ? ago(b.saidAt)
              : row.unread > 0
                ? 'unread'
                : ''
    set(node.pill, pill)
    node.pill.hidden = !pill
    set(node.expand, open ? '⤡' : '⤢')
    node.expand.title = open ? 'Fold it back  (Space)' : 'Open it up here  (Space)'

    // What it said: one clamped sentence normally, the whole reply when the card is open
    // or the turn has just come back to you — that reply is the thing you need to read.
    const showFull = (open || handoff || (unread && a.state !== 'working')) && !!b?.full
    const said = b?.said || (isClaude ? (b ? 'Nothing said yet.' : 'Waiting for the session to announce itself.') : 'A shell, not a Claude session.')
    set(node.said, said)
    node.said.hidden = showFull || question
    node.said.classList.toggle('is-quiet', !b?.said)
    node.full.hidden = !showFull
    if (showFull) {
      const sig = `${b!.saidAt}:${b!.full.length}`
      if (sig !== node.fullSig) {
        node.fullSig = sig
        node.full.innerHTML = mdLite(b!.full)
      }
    }

    // The picker it is waiting on, as its own screen draws it, and its options as keys.
    node.screen.hidden = !question
    if (question) {
      const text = row.screen!.join('\n')
      if (text !== node.screenSig) {
        node.screenSig = text
        node.screen.textContent = text
      }
    }
    const keysSig = question ? row.choices.map((c) => `${c.key}${c.selected ? '*' : ''}${c.label}`).join('|') : ''
    node.keys.hidden = !question
    if (keysSig !== node.keysSig) {
      node.keysSig = keysSig
      node.keys.replaceChildren()
      if (question) {
        for (const c of row.choices) {
          const k = document.createElement('button')
          k.type = 'button'
          k.className = 'ember-ov-key'
          k.classList.toggle('is-selected', c.selected)
          const n = document.createElement('kbd')
          n.textContent = c.key
          k.append(n, document.createTextNode(c.label))
          k.title = `Press ${c.key} in ${row.title}`
          k.addEventListener('click', () => this.hooks.onKeys(row.tabId, c.key))
          node.keys.append(k)
        }
        for (const [label, data, hint] of [
          ['Enter', '\r', 'Confirm the highlighted option'],
          ['Esc', '\x1b', 'Cancel'],
        ] as const) {
          const k = document.createElement('button')
          k.type = 'button'
          k.className = 'ember-ov-key is-plain'
          k.textContent = label
          k.title = hint
          k.addEventListener('click', () => this.hooks.onKeys(row.tabId, data))
          node.keys.append(k)
        }
      }
    }

    const doing = b && b.doing && !b.turnEnded && a.state === 'working' ? b.doing : ''
    set(node.doing, doing)
    node.doing.hidden = !doing

    // The foot: one quiet line of facts, and the context as a bar.
    const c = row.claude
    const bits: string[] = []
    if (row.git) bits.push(`${row.git.branch}${row.git.dirty ? ` *${row.git.dirty}` : ''}`)
    if (c?.model) bits.push(c.model)
    if (b) {
      const tok = b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheWrite
      if (tok) bits.push(`${compact(tok)} tok`)
      if (b.edits.count) bits.push(`+${b.edits.added} −${b.edits.removed}`)
    }
    if (c?.costUsd !== null && c?.costUsd !== undefined) bits.push(money(c.costUsd))
    const metaSig = bits.join(' · ')
    if (metaSig !== node.metaSig) {
      node.metaSig = metaSig
      node.meta.textContent = metaSig
    }
    const pct = c?.contextPercent ?? null
    node.ctx.hidden = pct === null
    if (pct !== null) {
      const w = `${Math.max(3, Math.min(100, Math.round(pct)))}%`
      if (node.ctxFill.style.width !== w) node.ctxFill.style.width = w
      node.ctx.dataset['hot'] = String(pct >= 80)
      node.ctx.title = `Context ${Math.round(pct)}% used${c?.contextSize ? ` of ${Math.round(c.contextSize / 1000)}k` : ''}`
    }

    // Opened up: the last few things it did, from the log.
    node.recent.hidden = !open
    if (open) {
      const mine = this.log.filter((e) => e.tabId === row.tabId && e.kind !== 'read').slice(-8)
      const sig = `${this.logVersion}:${mine.length}`
      if (sig !== node.recentSig) {
        node.recentSig = sig
        node.recent.replaceChildren(
          ...(mine.length
            ? mine.map((e) => this.logLine(e, false))
            : [Object.assign(document.createElement('div'), { className: 'ember-ov-log-empty', textContent: 'Nothing done yet that the log saw.' })])
        )
      }
    }

    node.ask.hidden = !isClaude || a.state === 'exited'
    node.input.placeholder = question ? 'Or type an answer…' : handoff ? 'Reply…' : 'Type to this session…'
  }

  // ---------- the log ----------

  private logLine(e: ActivityEntry, withWho: boolean): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ember-ov-log-line'
    line.dataset['kind'] = e.kind
    const row = this.rows.find((r) => r.tabId === e.tabId)
    const when = document.createElement('span')
    when.className = 'ember-ov-log-when'
    when.textContent = clock(e.at)
    const who = document.createElement('span')
    who.className = 'ember-ov-log-who'
    if (withWho) {
      who.textContent = row?.title ?? 'closed'
      if (row) who.style.setProperty('--hue', row.hue)
      else who.classList.add('is-gone')
    }
    const g = document.createElement('span')
    g.className = 'ember-ov-log-glyph'
    g.textContent = GLYPH[e.kind]
    const what = document.createElement('span')
    what.className = 'ember-ov-log-what'
    what.textContent = e.text
    line.append(when, who, g, what)
    if (e.added || e.removed) {
      const d = document.createElement('span')
      d.className = 'ember-ov-log-delta'
      const plus = document.createElement('i')
      plus.textContent = `+${e.added}`
      d.append(plus)
      if (e.removed) {
        const minus = document.createElement('i')
        minus.className = 'is-minus'
        minus.textContent = `−${e.removed}`
        d.append(minus)
      }
      line.append(d)
    }
    line.title = [row?.title, e.detail || e.text, new Date(e.at).toLocaleTimeString()].filter(Boolean).join('\n')
    if (row) line.addEventListener('click', () => this.hooks.onActivate(e.tabId))
    return line
  }

  /**
   * Newest at the bottom, the way a terminal reads. Stays pinned to the bottom unless you
   * have scrolled up to read something, and the session's name is written only when it
   * changes from the line above — runs of one session read as one block.
   */
  private renderLog(rebuild: boolean): void {
    if (this.disposed) return
    this.renderedLogVersion = this.logVersion
    this.logFilterBtn.textContent = this.logChangesOnly ? 'changes' : 'all'
    this.logFilterBtn.title = this.logChangesOnly ? 'Showing edits, commands and finished turns. Click to show everything.' : 'Showing everything, reads included. Click for changes only.'
    const pinned = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 24
    const shown = this.log.filter((e) => !this.logChangesOnly || CHANGE_KINDS.has(e.kind)).slice(-220)
    // Cheap enough to rebuild outright at this size; done only when something changed.
    const frag = document.createDocumentFragment()
    let prevTab = ''
    for (const e of shown) {
      frag.append(this.logLine(e, e.tabId !== prevTab))
      prevTab = e.tabId
    }
    if (!shown.length) {
      const none = document.createElement('div')
      none.className = 'ember-ov-log-empty'
      none.textContent = 'When a session edits, runs or finishes something, it shows up here.'
      frag.append(none)
    }
    this.logEl.replaceChildren(frag)
    if (pinned || rebuild) this.logEl.scrollTop = this.logEl.scrollHeight
  }

  // ---------- todo and notes ----------

  private async loadTodo(): Promise<void> {
    let text = ''
    try {
      text = await window.ember.todo.read()
    } catch {
      return
    }
    if (this.disposed) return
    // The trailing link is where the item came from ("[Mail](…)"); the list shows it as
    // an icon, and on one line here it would only read as a stray word.
    const plain = (s: string) =>
      s
        .replace(/\s*\[[^\]]+\]\([^)]*\)\s*$/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*`]/g, '')
        .trim()
    const lines = text.split('\n')
    this.todoItems = lines.filter((l) => /^\s*- \[ \] \S/.test(l)).map((line) => ({ line, text: plain(line.replace(/^\s*- \[ \] /, '')) }))
    const done = lines.filter((l) => /^\s*- \[[xX]\] \S/.test(l)).length
    this.todoCount.textContent = this.todoItems.length ? `${this.todoItems.length} open` : done ? 'all done' : ''
    const shown = this.todoItems.slice(0, 7)
    this.todoList.replaceChildren(
      ...shown.map((item) => {
        const row = document.createElement('div')
        row.className = 'ember-ov-todo-item'
        const box = document.createElement('button')
        box.type = 'button'
        box.className = 'ember-ov-todo-box'
        box.title = 'Tick it off'
        box.addEventListener('click', () => {
          row.classList.add('is-done')
          void this.tickTodo(item.line)
        })
        const t = document.createElement('span')
        t.className = 'ember-ov-todo-text'
        t.textContent = item.text
        t.title = item.text
        t.addEventListener('click', () => this.hooks.onOpenTodo())
        row.append(box, t)
        return row
      })
    )
    if (this.todoItems.length > shown.length) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'ember-ov-more'
      more.textContent = `${this.todoItems.length - shown.length} more`
      more.addEventListener('click', () => this.hooks.onOpenTodo())
      this.todoList.append(more)
    }
    if (!this.todoItems.length) {
      const none = document.createElement('div')
      none.className = 'ember-ov-rail-empty'
      none.textContent = done ? 'Everything on the list is ticked.' : 'Nothing on the list.'
      this.todoList.append(none)
    }
  }

  /** Tick one item in the file, found by its exact line, read fresh so nothing is written over. */
  private async tickTodo(line: string): Promise<void> {
    const text = await window.ember.todo.read()
    const lines = text.split('\n')
    const i = lines.indexOf(line)
    if (i === -1) return void this.loadTodo()
    lines[i] = line.replace('- [ ] ', '- [x] ')
    await window.ember.todo.write(lines.join('\n'))
    this.hooks.onTodoChanged?.()
    await this.loadTodo()
  }

  private async addTodo(item: string): Promise<void> {
    const text = await window.ember.todo.read()
    const sep = text.endsWith('\n') || text.length === 0 ? '' : '\n'
    await window.ember.todo.write(`${text}${sep}- [ ] ${item.replace(/\s*\n\s*/g, ' ')}\n`)
    this.hooks.onTodoChanged?.()
    await this.loadTodo()
    this.todoInput.focus()
  }

  private async loadNotes(): Promise<void> {
    let notes: NoteMeta[] = []
    try {
      notes = await window.ember.notes.list()
    } catch {
      return
    }
    if (this.disposed) return
    const recent = notes
      .filter((n) => !/^todo(\.archive)?\.md$/i.test(n.id))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 5)
    this.notesList.replaceChildren(
      ...recent.map((n) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'ember-ov-note'
        const t = document.createElement('span')
        t.className = 'ember-ov-note-title'
        t.textContent = n.title || n.id
        const p = document.createElement('span')
        p.className = 'ember-ov-note-preview'
        p.textContent = n.preview
        const w = document.createElement('span')
        w.className = 'ember-ov-note-when'
        w.textContent = ago(n.modified)
        row.append(t, w, p)
        row.title = n.title || n.id
        row.addEventListener('click', () => this.hooks.onOpenNotes(n.id))
        return row
      })
    )
    if (!recent.length) {
      const none = document.createElement('div')
      none.className = 'ember-ov-rail-empty'
      none.textContent = 'No notes yet.'
      this.notesList.append(none)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const u of this.unsubs) u()
    this.el.remove()
  }
}
