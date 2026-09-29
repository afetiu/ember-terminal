import type { SurfaceBrief } from './Overview'
import { TaskList } from './Tasks'

/** "just now", "14m ago", "yesterday" — the same clock the notes list uses. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export interface TodoHooks {
  /** The tab's title follows the count of open items. */
  onTitle: (title: string) => void
  /** Leave the list — back to the shell underneath, when there is one. */
  onClose?: () => void
  /** Open Settings at the Todo tab: which sources this machine checks. */
  onSources?: () => void
  /** Hand one item to a new Claude session. */
  onClaude?: (text: string) => void
  /** Open an item's source outside Ember. */
  onOpen?: (url: string) => void
}

/**
 * The todo list, as its own surface.
 *
 * Not a note. It has one job and one shape: a list of things to do, every line an item,
 * with the checker that fills it from mail and Slack and the time it last ran. It is
 * stored as `Todo.md` beside the notes — a plain file, `- [ ] item` per line, so `todo add`
 * from any shell, a Claude session and any editor all write the same thing — but it is
 * kept out of the notes list and opened by its own command, shortcut and badge.
 *
 * Every non-empty line is an item. Typing is the whole interaction: Enter for the next
 * one, Backspace on an empty one to drop it, Alt+↑/↓ or a drag to reorder, Ctrl+Enter or
 * the box to tick. Saves 300ms after the last change; the file is the state.
 */
export class TodoView {
  readonly el: HTMLElement
  private readonly list: TaskList
  private readonly countEl: HTMLElement
  private readonly status: HTMLElement
  private readonly checkBtn: HTMLButtonElement
  private readonly clearBtn: HTMLButtonElement
  private readonly report: HTMLElement
  /** Under the list: the archive's count as a quiet toggle, and the archive itself. */
  private readonly foot: HTMLElement
  private readonly archiveToggle: HTMLButtonElement
  private readonly archiveEl: HTMLElement
  private text = ''
  private lastSaved = ''
  private archive = ''
  private archiveOpen = false
  private saveTimer: number | null = null
  private checking = false
  private disposed = false

  constructor(private readonly hooks: TodoHooks) {
    this.el = document.createElement('div')
    this.el.className = 'ember-todo'

    const head = document.createElement('header')
    head.className = 'ember-todo-head'


    const h = document.createElement('h2')
    h.textContent = 'Todo'
    this.countEl = document.createElement('span')
    this.countEl.className = 'ember-todo-count'

    this.status = document.createElement('span')
    this.status.className = 'ember-todo-status'

    this.checkBtn = document.createElement('button')
    this.checkBtn.className = 'ember-notes-check'
    this.checkBtn.textContent = 'Check todos'
    this.checkBtn.title = 'Go through your sources with Claude: add what needs doing, tick what is done  (todo check)'
    this.checkBtn.addEventListener('click', () => void this.checkTodos())

    const sources = document.createElement('button')
    sources.className = 'ember-notes-leave ember-todo-sources'
    sources.textContent = 'Manage sources'
    sources.title = 'Where Check todos looks on this machine  (todo sources)'
    sources.hidden = !hooks.onSources
    sources.addEventListener('click', () => hooks.onSources?.())

    // Only there when there is something ticked to clear. It archives rather than
    // deletes: a done thing is still a record of a done thing.
    this.clearBtn = document.createElement('button')
    this.clearBtn.className = 'ember-notes-leave ember-todo-clear'
    this.clearBtn.textContent = 'Clear done'
    this.clearBtn.title = 'Move the ticked items to the archive  (clear done)'
    this.clearBtn.hidden = true
    this.clearBtn.addEventListener('click', () => this.clearDone())

    head.append(h, this.countEl, this.status, this.clearBtn, sources, this.checkBtn)

    this.report = document.createElement('div')
    this.report.className = 'ember-notes-report'
    this.report.hidden = true
    this.report.title = 'Click to dismiss'
    this.report.addEventListener('click', () => (this.report.hidden = true))

    this.foot = document.createElement('div')
    this.foot.className = 'ember-todo-foot'
    this.foot.hidden = true
    this.archiveToggle = document.createElement('button')
    this.archiveToggle.className = 'ember-todo-archive-toggle'
    this.archiveToggle.addEventListener('click', () => this.toggleArchive())
    this.archiveEl = document.createElement('div')
    this.archiveEl.className = 'ember-todo-archive'
    this.archiveEl.hidden = true
    this.foot.append(this.archiveToggle, this.archiveEl)

    this.list = new TaskList({
      itemsByDefault: true,
      ...(hooks.onClaude ? { onClaude: hooks.onClaude } : {}),
      ...(hooks.onOpen ? { onOpen: hooks.onOpen } : {}),
      onChange: (text) => {
        this.text = text
        this.countItems()
        this.queueSave()
      },
      onLeave: () => hooks.onClose?.(),
    })

    this.el.append(head, this.report, this.list.el, this.foot)
  }

  /** Read the file and show it. */
  async load(): Promise<void> {
    const body = await window.ember.todo.read()
    this.text = body
    this.lastSaved = body
    this.list.setText(body)
    this.countItems()
    void this.loadArchive()
    void window.ember.notes.todoState().then((st) => {
      if (this.disposed || this.checking) return
      const at = st.lastCheckedAt ? Date.parse(st.lastCheckedAt) : NaN
      this.status.textContent = Number.isFinite(at) ? `checked ${ago(at)}` : 'never checked'
    })
  }

  /** The file changed under us — `todo add` from a shell, the checker, another editor. */
  async external(): Promise<void> {
    if (this.disposed) return
    // `todo clear done` from a shell writes the archive too; whichever file changed,
    // the archive is cheap to read again.
    void this.loadArchive()
    if (this.text !== this.lastSaved) return
    const body = await window.ember.todo.read()
    if (body === this.text) return
    this.text = body
    this.lastSaved = body
    this.list.setText(body)
    this.countItems()
  }

  focus(): void {
    this.list.focus()
  }

  /**
   * The list as the overview's card shows it.
   *
   * Read off the same text the list is drawn from, so the card cannot disagree with the
   * page: the overview refreshes five times a second and simply asks again.
   */
  summary(): SurfaceBrief {
    // An item can carry a link back to where it came from. On a card it is one line of
    // prose, so the link reads as its words rather than as its markup.
    const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '')
    const lines = this.text.split('\n')
    const open = lines.filter((l) => /^\s*- \[ \] \S/.test(l)).map((l) => plain(l.replace(/^\s*- \[ \] /, '').trim()))
    const done = lines.filter((l) => /^\s*- \[[xX]\] \S/.test(l)).length
    return {
      kind: 'todo',
      what: 'Todo',
      count: open.length ? `${open.length} open${done ? ` · ${done} done` : ''}` : done ? `all ${done} done` : 'empty',
      where: 'todo.md',
      line: open[0] ? `Next: ${open[0]}` : done ? 'Everything on the list is ticked.' : 'Nothing on the list yet.',
    }
  }

  private countItems(): void {
    const open = this.text.split('\n').filter((l) => /^\s*- \[ \] \S/.test(l)).length
    const done = this.text.split('\n').filter((l) => /^\s*- \[[xX]\] \S/.test(l)).length
    this.countEl.textContent = open ? `${open} open${done ? ` · ${done} done` : ''}` : done ? `all ${done} done` : ''
    this.clearBtn.hidden = done === 0
    this.hooks.onTitle(open ? `Todo · ${open}` : 'Todo')
  }

  private queueSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flush(), 300)
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.disposed || this.text === this.lastSaved) return
    const body = this.text
    const ok = await window.ember.todo.write(body)
    if (ok) this.lastSaved = body
  }

  /** Run `/check-todos` in the local Claude and show what it said; items arrive (and get ticked) by themselves. */
  async checkTodos(): Promise<void> {
    if (this.checking) return
    this.checking = true
    this.checkBtn.disabled = true
    this.checkBtn.textContent = 'Checking…'
    this.status.textContent = 'going through your sources with Claude, a minute or two'
    this.report.hidden = true
    try {
      const r = await window.ember.notes.checkTodos()
      this.report.textContent = r.ok ? r.output || 'Nothing new to do.' : `Could not run the check: ${r.error ?? 'unknown error'}`
      this.report.classList.toggle('is-error', !r.ok)
      this.report.hidden = false
      this.status.textContent = r.ok ? 'checked just now' : ''
    } finally {
      this.checking = false
      this.checkBtn.disabled = false
      this.checkBtn.textContent = 'Check todos'
    }
  }

  /** `add <text>`: one more open item at the end. */
  add(text: string): string {
    const t = text.trim()
    if (!t) throw new Error('add what?')
    const body = this.text.replace(/\s+$/, '')
    this.text = `${body ? `${body}\n` : ''}- [ ] ${t}`
    this.list.setText(this.text)
    this.countItems()
    this.queueSave()
    return `Added: ${t}`
  }

  /** `done <words>`: tick the first open item containing the words. */
  done(words: string): string {
    const q = words.trim().toLowerCase()
    if (!q) throw new Error('done which? give a few words of it')
    const lines = this.text.split('\n')
    const i = lines.findIndex((l) => /^\s*- \[ \] /.test(l) && l.toLowerCase().includes(q))
    if (i === -1) throw new Error(`no open item contains "${words.trim()}"`)
    lines[i] = lines[i]!.replace('- [ ] ', '- [x] ')
    this.text = lines.join('\n')
    this.list.setText(this.text)
    this.countItems()
    this.queueSave()
    return `Done: ${lines[i]!.replace(/^\s*- \[x\] /, '')}`
  }

  /**
   * `clear done`: the ticked items leave the list for the archive, under today's date.
   * Archived rather than deleted — a done thing is still a record, and the checker reads
   * the archive so it never adds one back.
   */
  clearDone(): string {
    const lines = this.text.split('\n')
    const done = lines.filter((l) => /^\s*- \[[xX]\] /.test(l)).map((l) => l.replace(/^\s*- \[[xX]\] /, ''))
    if (!done.length) return 'nothing ticked'
    this.archive = TodoView.archiveAdd(this.archive, done)
    void window.ember.todo.writeArchive(this.archive)
    this.text = lines.filter((l) => !/^\s*- \[[xX]\] /.test(l)).join('\n')
    this.list.setText(this.text)
    this.countItems()
    this.queueSave()
    this.renderArchive()
    this.status.textContent = `archived ${done.length}`
    return `Archived ${done.length} done item${done.length === 1 ? '' : 's'}`
  }

  // ---------- the archive ----------

  private async loadArchive(): Promise<void> {
    const body = await window.ember.todo.readArchive()
    if (this.disposed || body === this.archive) return
    this.archive = body
    this.renderArchive()
  }

  /** `archive`: show or hide the archive under the list. */
  toggleArchive(): string {
    if (!TodoView.archived(this.archive).length) return 'nothing archived yet'
    this.archiveOpen = !this.archiveOpen
    this.renderArchive()
    return this.archiveOpen ? 'Showing the archive' : 'Archive hidden'
  }

  /** A line of the archive back to the list, open. */
  private restore(day: string, text: string): void {
    const lines = this.archive.split('\n')
    let inDay = false
    const i = lines.findIndex((l) => {
      if (/^## /.test(l)) inDay = l.slice(3).trim() === day
      return inDay && /^\s*- \[[xX]\] /.test(l) && l.replace(/^\s*- \[[xX]\] /, '') === text
    })
    if (i === -1) return
    lines.splice(i, 1)
    // A day with nothing left under it goes too.
    this.archive = lines
      .join('\n')
      .replace(/^## [^\n]*\n(?=(?:\s*\n)*(?:## |$))/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+/, '')
    void window.ember.todo.writeArchive(this.archive)
    this.add(text)
    this.renderArchive()
  }

  /**
   * The footer: a count that opens the archive, and the archive as days of ticked lines,
   * dim, each with a way back. Nothing when there is nothing archived.
   */
  private renderArchive(): void {
    const days = TodoView.archived(this.archive)
    const n = days.reduce((sum, d) => sum + d.items.length, 0)
    this.foot.hidden = n === 0
    if (!n) {
      this.archiveOpen = false
      this.archiveEl.hidden = true
      return
    }
    this.archiveToggle.textContent = `${this.archiveOpen ? '▾' : '▸'} archive · ${n}`
    this.archiveToggle.title = this.archiveOpen ? 'Hide the archive  (archive)' : 'Things cleared from the list, by day  (archive)'
    this.archiveEl.hidden = !this.archiveOpen
    if (!this.archiveOpen) return

    this.archiveEl.replaceChildren()
    for (const day of days) {
      const h = document.createElement('div')
      h.className = 'ember-todo-archive-day'
      h.textContent = TodoView.dayLabel(day.day)
      this.archiveEl.appendChild(h)
      for (const item of day.items) {
        const row = document.createElement('div')
        row.className = 'ember-todo-archive-item'
        const text = document.createElement('span')
        text.textContent = item
        const back = document.createElement('button')
        back.className = 'ember-todo-archive-back'
        back.textContent = '↩'
        back.title = 'Back to the list, open'
        back.addEventListener('click', () => this.restore(day.day, item))
        row.append(text, back)
        this.archiveEl.appendChild(row)
      }
    }
  }

  /** `## 2026-09-04` sections, in file order (newest first), each with its items. */
  private static archived(body: string): { day: string; items: string[] }[] {
    const days: { day: string; items: string[] }[] = []
    let cur: { day: string; items: string[] } | null = null
    for (const line of body.split('\n')) {
      const h = /^## (.+)$/.exec(line)
      if (h) {
        cur = { day: h[1]!.trim(), items: [] }
        days.push(cur)
        continue
      }
      const m = /^\s*- \[[xX]\] (.*)$/.exec(line)
      if (m && m[1]!.trim()) {
        if (!cur) {
          cur = { day: 'earlier', items: [] }
          days.push(cur)
        }
        cur.items.push(m[1]!)
      }
    }
    return days.filter((d) => d.items.length)
  }

  /** Items under today's heading, added if the top of the file is another day. */
  private static archiveAdd(body: string, items: string[]): string {
    const today = TodoView.today()
    const rest = body.replace(/^\s+/, '')
    const lines = items.map((t) => `- [x] ${t}`).join('\n')
    const head = `## ${today}\n`
    return rest.startsWith(head) ? `${head}${lines}\n${rest.slice(head.length)}` : `${head}${lines}\n${rest ? `\n${rest}` : ''}`
  }

  private static today(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  private static dayLabel(day: string): string {
    if (day === TodoView.today()) return 'today'
    const t = Date.parse(day)
    if (!Number.isFinite(t)) return day
    const days = Math.round((Date.now() - t) / 86_400_000)
    if (days === 1) return 'yesterday'
    return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  }

  /** `dismiss <words>`: the first open item containing the words leaves the list, unticked. */
  dismiss(words: string): string {
    const q = words.trim().toLowerCase()
    if (!q) throw new Error('dismiss which? give a few words of it')
    const lines = this.text.split('\n')
    const i = lines.findIndex((l) => /^\s*- \[ \] /.test(l) && l.toLowerCase().includes(q))
    if (i === -1) throw new Error(`no open item contains "${words.trim()}"`)
    const [gone] = lines.splice(i, 1)
    this.text = lines.join('\n')
    this.list.setText(this.text)
    this.countItems()
    this.queueSave()
    return `Dismissed: ${gone!.replace(/^\s*- \[ \] /, '')}`
  }

  /** `open <words>`: the source of the first open item containing the words. */
  openSource(words: string): string {
    const q = words.trim().toLowerCase()
    const line = this.text.split('\n').find((l) => /^\s*- \[[ xX]\] /.test(l) && (!q || l.toLowerCase().includes(q)))
    if (!line) throw new Error(q ? `no item contains "${words.trim()}"` : 'open which? give a few words of it')
    const m = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*$|(https?:\/\/\S+)\s*$/.exec(line)
    const url = m?.[2] ?? m?.[3]
    if (!url) throw new Error('that item has no source link')
    this.hooks.onOpen?.(url)
    return `Opening ${url}`
  }

  /** `claude <words>`: the first open item containing the words goes to a new session. */
  handOff(words: string): string {
    const q = words.trim().toLowerCase()
    if (!q) throw new Error('claude which item? give a few words of it')
    const line = this.text.split('\n').find((l) => /^\s*- \[ \] /.test(l) && l.toLowerCase().includes(q))
    if (!line) throw new Error(`no open item contains "${words.trim()}"`)
    const item = line.replace(/^\s*- \[ \] /, '')
    this.hooks.onClaude?.(item)
    return `Claude is starting on: ${item}`
  }

  leave(): void {
    this.hooks.onClose?.()
  }

  dispose(): void {
    void this.flush()
    this.disposed = true
    this.el.remove()
  }
}
