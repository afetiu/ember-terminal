import { TaskList } from './Tasks'

export interface TodoHooks {
  /** The tab's title follows the count of open items. */
  onTitle: (title: string) => void
  /** Leave the list — back to the shell underneath, when there is one. */
  onClose?: () => void
  /** Hand one item to a new Claude session. */
  onClaude?: (text: string) => void
  /** Open an item's source outside Ember. */
  onOpen?: (url: string) => void
}

/**
 * The todo list, as its own surface.
 *
 * Not a note. It has one job and one shape: a list of things to do, every line an item.
 * It is stored as `Todo.md` beside the notes — a plain file, `- [ ] item` per line, so `todo add`
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
  private readonly clearBtn: HTMLButtonElement
  /** Under the list: the archive's count as a quiet toggle, and the archive itself. */
  private readonly foot: HTMLElement
  private readonly archiveToggle: HTMLButtonElement
  private readonly archiveEl: HTMLElement
  private text = ''
  private lastSaved = ''
  private archive = ''
  private archiveOpen = false
  private saveTimer: number | null = null
  private disposed = false
  /** The daily check: once a day, the open items one at a time. */
  private readonly review: HTMLElement
  private reviewAt = -1
  private reviewKeys: ((e: KeyboardEvent) => void) | null = null

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

    // Only there when there is something ticked to clear. It archives rather than
    // deletes: a done thing is still a record of a done thing.
    this.clearBtn = document.createElement('button')
    this.clearBtn.className = 'ember-notes-leave ember-todo-clear'
    this.clearBtn.textContent = 'Clear done'
    this.clearBtn.title = 'Move the ticked items to the archive  (clear done)'
    this.clearBtn.hidden = true
    this.clearBtn.addEventListener('click', () => this.clearDone())

    head.append(h, this.countEl, this.status, this.clearBtn)

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

    this.review = document.createElement('section')
    this.review.className = 'ember-todo-review'
    this.review.hidden = true

    this.el.append(head, this.review, this.list.el, this.foot)
  }

  // ---------------------------------------------------------------- the daily check

  private static readonly REVIEWED = 'ember.todo.reviewed'

  private openItems(): string[] {
    return this.text
      .split('\n')
      .filter((l) => /^\s*- \[ \] \S/.test(l))
      .map((l) => l.replace(/^\s*- \[ \] /, ''))
  }

  /** The first visit of the day: what is open, what got done since the last check. */
  private offerReview(): void {
    let last = ''
    try {
      last = localStorage.getItem(TodoView.REVIEWED) ?? ''
    } catch {
      /* no storage: offer every time, which is harmless */
    }
    const today = TodoView.today()
    const open = this.openItems()
    if (last === today || !open.length) {
      this.review.hidden = true
      return
    }
    const done = TodoView.archived(this.archive)
      .filter((d) => !last || d.day > last)
      .reduce((n, d) => n + d.items.length, 0)
    this.review.hidden = false
    this.review.innerHTML =
      `<div class="ember-todo-review-head"><strong>Today</strong><span>${open.length} open${done ? ` · ${done} done since your last check` : ''}</span></div>` +
      `<div class="ember-todo-review-acts"><button type="button" class="is-primary" data-r="go">Go through them</button><button type="button" data-r="skip">Not now</button></div>`
    this.review.querySelector('[data-r="go"]')?.addEventListener('click', () => this.reviewStep(0))
    this.review.querySelector('[data-r="skip"]')?.addEventListener('click', () => this.reviewEnd(false))
  }

  /** One item, large, with single keys: D done, K keep, L later, Del drop, Esc stop. */
  private reviewStep(i: number): void {
    const open = this.openItems()
    if (i >= open.length) return this.reviewEnd(true)
    this.reviewAt = i
    const item = open[i]!
    this.review.innerHTML =
      `<div class="ember-todo-review-head"><strong>Today</strong><span>${i + 1} of ${open.length}</span></div>` +
      `<div class="ember-todo-review-item"></div>` +
      `<div class="ember-todo-review-acts">` +
      `<button type="button" data-r="done"><b>D</b> Done</button><button type="button" data-r="keep"><b>K</b> Keep</button>` +
      `<button type="button" data-r="later"><b>L</b> Later</button><button type="button" data-r="drop"><b>Del</b> Drop</button>` +
      `<button type="button" data-r="stop"><b>Esc</b> Stop</button></div>`
    this.review.querySelector<HTMLElement>('.ember-todo-review-item')!.textContent = item
    const act = (what: string) => {
      if (what === 'stop') return this.reviewEnd(false)
      if (what === 'keep') return this.reviewStep(i + 1)
      const lines = this.text.split('\n')
      const at = lines.findIndex((l) => /^\s*- \[ \] /.test(l) && l.replace(/^\s*- \[ \] /, '') === item)
      if (at < 0) return this.reviewStep(i + 1)
      if (what === 'done') lines[at] = lines[at]!.replace('- [ ] ', '- [x] ')
      else if (what === 'drop') lines.splice(at, 1)
      else if (what === 'later') {
        const [line] = lines.splice(at, 1)
        let last = lines.length - 1
        while (last > 0 && !lines[last]!.trim()) last--
        lines.splice(last + 1, 0, line!)
      }
      this.text = lines.join('\n')
      this.list.setText(this.text)
      this.countItems()
      this.queueSave()
      // Done, dropped or moved: the next item is now at the same place.
      this.reviewStep(what === 'later' && i < this.openItems().length - 1 ? i : what === 'later' ? i + 1 : i)
    }
    this.review.querySelectorAll<HTMLElement>('[data-r]').forEach((b) => b.addEventListener('click', () => act(b.dataset['r']!)))
    if (!this.reviewKeys) {
      this.reviewKeys = (e: KeyboardEvent) => {
        if (this.review.hidden || this.reviewAt < 0 || this.el.offsetParent === null) return
        const k = e.key.toLowerCase()
        const map: Record<string, string> = { d: 'done', k: 'keep', l: 'later', delete: 'drop', escape: 'stop' }
        const what = map[k]
        if (!what || (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return
        e.preventDefault()
        e.stopPropagation()
        const btn = this.review.querySelector<HTMLElement>(`[data-r="${what}"]`)
        btn?.click()
      }
      window.addEventListener('keydown', this.reviewKeys, true)
    }
  }

  private reviewEnd(finished: boolean): void {
    this.reviewAt = -1
    try {
      localStorage.setItem(TodoView.REVIEWED, TodoView.today())
    } catch {
      /* fine */
    }
    if (!finished) {
      this.review.hidden = true
      return
    }
    this.review.innerHTML = `<div class="ember-todo-review-head"><strong>Today</strong><span>All gone through. See you tomorrow.</span></div>`
    window.setTimeout(() => (this.review.hidden = true), 2200)
  }

  /** Read the file and show it. */
  async load(): Promise<void> {
    const body = await window.ember.todo.read()
    this.text = body
    this.lastSaved = body
    this.list.setText(body)
    this.countItems()
    await this.loadArchive()
    this.offerReview()
  }

  /** The file changed under us — `todo add` from a shell, an agent, another editor. */
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
   * Archived rather than deleted — a done thing is still a record.
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
    if (this.reviewKeys) window.removeEventListener('keydown', this.reviewKeys, true)
    void this.flush()
    this.disposed = true
    this.el.remove()
  }
}
