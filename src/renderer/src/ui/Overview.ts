import type { ActivitySnapshot } from '../core/Activity'
import type { ClaudeStatus, GitStatus, SessionBrief } from '@shared/types'

/**
 * What a todo or notes tab is showing, in the words its own surface would use.
 *
 * A tab holding the list or the notes is not a shell, and a card that described it as
 * one — "PowerShell", "Not a Claude session" — was telling the truth about the wrong
 * thing. The surface answers for itself instead, and the card is built from this.
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
  /** Set when the tab is showing the todo list or the notes; null for a plain shell. */
  surface: SurfaceBrief | null
}

export interface OverviewHooks {
  /** Go to that tab. */
  onActivate: (tabId: string) => void
  /** Type this into that tab's session and press Enter. */
  onSend: (tabId: string, text: string) => void
  /** The tab's title follows the counts. */
  onTitle: (title: string) => void
  /** Leave — back to the shell underneath, when there is one. */
  onClose?: () => void
  /** Say this to the orchestrator — the same conversation the sidebar's card holds. */
  onOrchestrate: (text: string) => void
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

/** The DOM of one row, kept so a refresh writes only the text that changed. */
interface RowNode {
  root: HTMLElement
  dot: HTMLElement
  /** ✓ or ✎ in place of the state dot, on a todo or notes card. */
  mark: HTMLElement
  state: HTMLElement
  title: HTMLElement
  where: HTMLElement
  git: HTMLElement
  claude: HTMLElement
  /** "over PowerShell" — the shell a surface was opened on top of, if there is one. */
  under: HTMLElement
  said: HTMLElement
  when: HTMLElement
  doing: HTMLElement
  /** A thin bar under the chips: how much of the context window the session has used. */
  ctx: HTMLElement
  ctxFill: HTMLElement
  ask: HTMLElement
  input: HTMLInputElement
  sig: string
}

const ORDER: Record<ActivitySnapshot['state'], number> = { attention: 0, working: 1, idle: 2, exited: 3 }

/**
 * Every session on one screen.
 *
 * A surface like the todo list — over the tab that asked for it, or a tab of its own —
 * with a row per session: its state and how long it has been in it, where it is, the
 * last sentence its Claude wrote and the tool it is on, and a box to type into it
 * without going there. The rows sort by what needs you: a question first, then work in
 * progress, then the rest. It is fed from App's own five-times-a-second refresh, the
 * same data the sidebar cards draw, so it never has an opinion of its own to go stale.
 */
export class OverviewView {
  readonly el: HTMLElement
  private readonly countEl: HTMLElement
  private readonly list: HTMLElement
  private readonly empty: HTMLElement
  private readonly nodes = new Map<string, RowNode>()
  private lastTitle = ''
  private disposed = false

  private readonly dockDot: HTMLElement
  private readonly dockSaid: HTMLElement
  private readonly dockDid: HTMLElement
  private readonly dockInput: HTMLInputElement

  /** Put the orchestrator's caret in the line at the bottom. */
  focusOrchestrator(): void {
    this.dockInput.focus()
  }

  private renderDock(orch: OverviewOrch): void {
    this.dockDot.classList.toggle('is-busy', orch.busy)
    const said = orch.busy && !orch.said ? 'Working on it…' : orch.said || 'Nothing said yet. Ask it something, or hand out work.'
    if (this.dockSaid.textContent !== said) this.dockSaid.textContent = said
    this.dockSaid.classList.toggle('is-quiet', !orch.said)
    const did = orch.did.length ? orch.did.join(' · ') : ''
    if (this.dockDid.textContent !== did) this.dockDid.textContent = did
    this.dockDid.hidden = !did
    this.dockInput.placeholder = orch.busy ? 'It is working — you can still say something…' : 'Ask, or hand out work…'
  }

  constructor(private readonly hooks: OverviewHooks) {
    this.el = document.createElement('div')
    this.el.className = 'ember-overview'
    this.el.tabIndex = -1

    const head = document.createElement('header')
    head.className = 'ember-todo-head'
    const h = document.createElement('h2')
    h.textContent = 'Overview'
    this.countEl = document.createElement('span')
    this.countEl.className = 'ember-todo-count'
    const status = document.createElement('span')
    status.className = 'ember-todo-status'
    status.textContent = 'live'
    head.append(h, this.countEl, status)
    if (hooks.onClose) {
      const back = document.createElement('button')
      back.className = 'ember-notes-leave'
      back.textContent = 'Back'
      back.title = 'Back to the shell  (Esc)'
      back.addEventListener('click', () => hooks.onClose?.())
      head.append(back)
    }

    this.list = document.createElement('div')
    this.list.className = 'ember-overview-list'

    this.empty = document.createElement('div')
    this.empty.className = 'ember-overview-empty'
    this.empty.textContent = 'No sessions yet.'
    this.empty.hidden = true

    // Under the head: the cards across the whole page, and along the bottom the
    // orchestrator — the one thing that sees all of them — as a single exchange: the
    // last thing it said, and a line to say something back. No history on this page;
    // the sidebar's card keeps that.
    const body = document.createElement('div')
    body.className = 'ember-overview-body'
    const col = document.createElement('div')
    col.className = 'ember-overview-col'
    col.append(this.list, this.empty)

    const dock = document.createElement('div')
    dock.className = 'ember-overview-dock'
    const who = document.createElement('div')
    who.className = 'ember-overview-dock-who'
    this.dockDot = document.createElement('span')
    this.dockDot.className = 'ember-overview-dock-dot'
    const whoName = document.createElement('span')
    whoName.textContent = 'Orchestrator'
    who.append(this.dockDot, whoName)

    const said = document.createElement('div')
    said.className = 'ember-overview-dock-said'
    this.dockSaid = document.createElement('div')
    this.dockSaid.className = 'ember-overview-dock-text is-quiet'
    this.dockSaid.textContent = 'Nothing said yet. Ask it something, or hand out work.'
    this.dockDid = document.createElement('div')
    this.dockDid.className = 'ember-overview-dock-did'
    this.dockDid.hidden = true
    said.append(this.dockSaid, this.dockDid)

    const ask = document.createElement('div')
    ask.className = 'ember-overview-ask is-dock'
    this.dockInput = document.createElement('input')
    this.dockInput.className = 'ember-overview-input'
    this.dockInput.spellcheck = false
    this.dockInput.placeholder = 'Ask, or hand out work…'
    const sendOrch = () => {
      const text = this.dockInput.value.trim()
      if (!text) return
      hooks.onOrchestrate(text)
      this.dockInput.value = ''
    }
    this.dockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.dockInput.value = ''
        this.dockInput.blur()
        return
      }
      if (e.key !== 'Enter') return
      e.preventDefault()
      sendOrch()
    })
    const sendBtn = document.createElement('button')
    sendBtn.className = 'ember-overview-send'
    sendBtn.type = 'button'
    sendBtn.textContent = '↵'
    sendBtn.title = 'Send  (Enter)'
    sendBtn.tabIndex = -1
    sendBtn.addEventListener('click', sendOrch)
    ask.append(this.dockInput, sendBtn)

    dock.append(who, said, ask)
    body.append(col, dock)

    this.el.append(head, body)
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        hooks.onClose?.()
      }
    })
  }

  focus(): void {
    this.el.focus()
  }

  /** Called on every app refresh with every session; only what changed is written. */
  render(rows: OverviewRow[], orch: OverviewOrch): void {
    if (this.disposed) return
    this.renderDock(orch)
    const sorted = [...rows].sort((a, b) => ORDER[a.activity.state] - ORDER[b.activity.state] || a.title.localeCompare(b.title))

    const waiting = sorted.filter((r) => r.activity.state === 'attention').length
    const working = sorted.filter((r) => r.activity.state === 'working').length
    // The list and the notes are on the page but they are not sessions, so they are
    // named rather than counted: "2 sessions · todo · notes".
    const sessions = sorted.filter((r) => !r.surface).length
    const parts = [`${sessions} session${sessions === 1 ? '' : 's'}`]
    if (working) parts.push(`${working} working`)
    if (waiting) parts.push(`${waiting} waiting for you`)
    for (const r of sorted) if (r.surface) parts.push(r.surface.what.toLowerCase())
    const count = parts.join(' · ')
    if (this.countEl.textContent !== count) this.countEl.textContent = count
    // Only on change: the title hook re-syncs the tabs, which renders this again, and a
    // hook that fires on every render is a loop that never reaches the rows.
    const title = waiting ? `Overview · ${waiting}` : 'Overview'
    if (title !== this.lastTitle) {
      this.lastTitle = title
      this.hooks.onTitle(title)
    }
    this.empty.hidden = sorted.length > 0

    const seen = new Set<string>()
    let prev: HTMLElement | null = null
    for (const row of sorted) {
      seen.add(row.tabId)
      let node = this.nodes.get(row.tabId)
      if (!node) {
        node = this.createRow(row)
        this.nodes.set(row.tabId, node)
      }
      this.updateRow(node, row)
      // Keep DOM order equal to sort order without rebuilding: move only when needed.
      const wantAfter: Element | null = prev ? prev.nextElementSibling : this.list.firstElementChild
      if (wantAfter !== node.root) this.list.insertBefore(node.root, wantAfter)
      prev = node.root
    }
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue
      node.root.remove()
      this.nodes.delete(id)
    }
  }

  private createRow(row: OverviewRow): RowNode {
    // A card: state and age on the top line, the session and where it is, its chips,
    // then the sentence with room to wrap, what it is doing, and the box at the foot.
    const root = document.createElement('article')
    root.className = 'ember-overview-card'
    root.dataset['tabId'] = row.tabId
    root.title = 'Go to this session'
    root.addEventListener('click', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return
      this.hooks.onActivate(row.tabId)
    })

    const top = document.createElement('div')
    top.className = 'ember-overview-card-top'
    const dot = document.createElement('span')
    dot.className = 'ember-overview-dot'
    // A mark instead of a state dot on the surface cards: the list and the notes have no
    // state to report, and a dot that never changes colour only looks broken.
    const mark = document.createElement('span')
    mark.className = 'ember-overview-mark'
    mark.hidden = true
    const state = document.createElement('span')
    state.className = 'ember-overview-state'
    const when = document.createElement('span')
    when.className = 'ember-overview-when'
    top.append(dot, mark, state, when)

    const main = document.createElement('div')
    main.className = 'ember-overview-main'

    const titleRow = document.createElement('div')
    titleRow.className = 'ember-overview-title-row'
    const title = document.createElement('span')
    title.className = 'ember-overview-title'
    const where = document.createElement('span')
    where.className = 'ember-overview-where'
    titleRow.append(title, where)

    const chips = document.createElement('div')
    chips.className = 'ember-overview-chips'
    const git = document.createElement('span')
    git.className = 'ember-chip is-git'
    const claude = document.createElement('span')
    claude.className = 'ember-chip is-claude'
    // What a surface is sitting on top of, when it is sitting on anything. A todo tab
    // opened over a shell still has that shell running, and hiding it would lose it.
    const under = document.createElement('span')
    under.className = 'ember-chip is-under'
    under.hidden = true
    chips.append(git, claude, under)

    const said = document.createElement('div')
    said.className = 'ember-overview-text'

    const doing = document.createElement('div')
    doing.className = 'ember-overview-doing'

    const ctx = document.createElement('div')
    ctx.className = 'ember-overview-ctx'
    ctx.hidden = true
    const ctxFill = document.createElement('span')
    ctx.append(ctxFill)

    const ask = document.createElement('div')
    ask.className = 'ember-overview-ask'
    const input = document.createElement('input')
    input.className = 'ember-overview-input'
    input.spellcheck = false
    input.placeholder = 'Type to this session…'
    const send = () => {
      const text = input.value.trim()
      if (!text) return
      this.hooks.onSend(row.tabId, text)
      input.value = ''
      root.classList.add('is-sent')
      window.setTimeout(() => root.classList.remove('is-sent'), 600)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        input.value = ''
        input.blur()
        return
      }
      if (e.key !== 'Enter') return
      e.preventDefault()
      send()
    })
    const sendBtn = document.createElement('button')
    sendBtn.className = 'ember-overview-send'
    sendBtn.type = 'button'
    sendBtn.textContent = '↵'
    sendBtn.title = 'Send  (Enter)'
    sendBtn.tabIndex = -1
    sendBtn.addEventListener('click', send)
    ask.append(input, sendBtn)

    main.append(titleRow, chips, ctx, said, doing, ask)
    root.append(top, main)

    return { root, dot, mark, state, title, where, git, claude, under, said, when, doing, ctx, ctxFill, ask, input, sig: '' }
  }

  private updateRow(node: RowNode, row: OverviewRow): void {
    const a = row.activity
    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text
    }

    node.root.classList.toggle('is-active', row.isActive)
    node.root.dataset['state'] = a.state
    node.root.dataset['attention'] = a.attention ?? ''

    // A todo or notes tab is its own kind of thing and gets its own card. Anything the
    // shell underneath is doing still shows — the dot, `doing`, the box — because a
    // session left working behind the notes is exactly what you opened this page to see.
    const s = row.surface
    node.root.dataset['kind'] = s ? s.kind : 'session'
    node.mark.hidden = !s
    node.dot.hidden = !!s && a.state === 'idle'
    if (s) set(node.mark, s.kind === 'todo' ? '✓' : '✎')

    const stateText =
      a.state === 'attention'
        ? a.attention === 'question'
          ? 'waiting for you'
          : a.attention === 'handoff'
            ? 'handed back'
            : 'rang the bell'
        : a.state === 'working'
          ? `working${a.detail ? ` ${a.detail}` : ''}`
          : a.state === 'exited'
            ? 'exited'
            : row.unread > 0
              ? 'idle · unread'
              : 'idle'
    // The counts are what a surface has instead of a state — unless the shell under it
    // is working or wants you, which outranks knowing how many items are on the list.
    const busy = a.state === 'working' || a.state === 'attention'
    set(node.state, s && !busy ? s.count : stateText)

    set(node.title, s ? s.what : row.title)
    const where = s ? s.where : row.cwd ? basename(row.cwd) : ''
    set(node.where, where)
    node.where.title = s ? s.count : row.cwd

    const git = row.git ? `${row.git.branch}${row.git.dirty ? `*${row.git.dirty}` : ''}` : ''
    set(node.git, git)
    node.git.hidden = !git
    node.git.dataset['dirty'] = String(!!row.git?.dirty)

    const c = row.claude
    const claude = c ? [c.model, c.contextPercent !== null ? `${Math.round(c.contextPercent)}%` : '', c.costUsd !== null ? `$${c.costUsd < 10 ? c.costUsd.toFixed(2) : c.costUsd.toFixed(1)}` : ''].filter(Boolean).join(' · ') : ''
    set(node.claude, claude)
    node.claude.hidden = !claude

    const pct = c?.contextPercent ?? null
    node.ctx.hidden = pct === null
    if (pct !== null) {
      const w = `${Math.max(2, Math.min(100, Math.round(pct)))}%`
      if (node.ctxFill.style.width !== w) node.ctxFill.style.width = w
      node.ctx.dataset['hot'] = String(pct >= 80)
      node.ctx.title = `Context window ${Math.round(pct)}% used${c?.contextSize ? ` of ${Math.round(c.contextSize / 1000)}k` : ''}`
    }

    const b = row.brief
    // A session that has announced itself over the bridge is Claude whatever the
    // terminal looks like; the activity monitor only knows the TUI when it is drawing.
    const isClaude = a.isClaude || b !== null
    // A surface card leads with what the surface holds. On a plain shell tab, the
    // sentence its Claude last wrote; the counts move to the chip row instead.
    const said = s
      ? s.line
      : b?.said || (isClaude ? (b ? 'Nothing said since this view started watching.' : 'Waiting for the session to announce itself.') : 'Not a Claude session.')
    set(node.said, said)
    node.said.classList.toggle('is-quiet', s ? false : !b?.said)
    set(node.when, b?.saidAt ? ago(b.saidAt) : '')

    const under = s && busy ? s.count : s && row.panes > 0 ? `over ${row.title}` : ''
    set(node.under, under)
    node.under.hidden = !under

    const doing = b && b.doing && !b.turnEnded && a.state === 'working' ? `▸ ${b.doing}` : ''
    set(node.doing, doing)
    node.doing.hidden = !doing

    node.ask.hidden = !isClaude || a.state === 'exited'
    node.input.placeholder = a.attention === 'question' ? 'Answer it here…' : 'Type to this session…'
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.el.remove()
  }
}
