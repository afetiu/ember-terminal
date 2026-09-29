import type { NoteMeta } from '@shared/types'
import type { SurfaceBrief } from './Overview'
import { TaskList, applyTodoCommand, hasTasks } from './Tasks'

/** "just now", "14m", "yesterday", "12 Aug" — a list is scanned, not read. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

export interface NoteHooks {
  /** The tab's title follows the note's first line. */
  onTitle: (title: string) => void
  /**
   * Leave the notes altogether. Present when the notes are showing over a shell — the
   * shell is what they return to — and absent in a tab that is only notes.
   */
  onClose?: () => void
}

/**
 * A tab that holds writing instead of a shell.
 *
 * Two states in one surface: a list of every note newest-first, and an editor for one of
 * them. They are one class rather than two because moving between them is the whole
 * interaction — open, read, escape back, open another — and splitting it would mean an
 * owner coordinating which is on screen.
 *
 * The editor autosaves. There is no save key, no dirty dot and no "unsaved changes"
 * prompt, because those exist to protect work from being lost and the way to protect
 * work is to write it down. What is on screen is what is on disk, within 400ms.
 *
 * The file is the note (see main/notes.ts), so renaming happens by editing the first
 * line and the id can change under a save. That is why `save` returns the id back.
 */
export class NoteView {
  readonly el: HTMLElement
  private readonly listEl: HTMLElement
  private readonly editEl: HTMLElement
  private readonly search: HTMLInputElement
  private readonly rows: HTMLElement
  private readonly area: HTMLTextAreaElement
  /**
   * The same text as `area`, as a list of things to do. A note whose lines are task items
   * opens here; the plain editor is one click away and edits the same text. The textarea
   * stays the source of truth for saving, whichever is showing.
   */
  private readonly tasks: TaskList
  private readonly modeBtn: HTMLButtonElement
  private view: 'text' | 'tasks' = 'text'
  private readonly status: HTMLElement
  private readonly countEl: HTMLElement

  private notes: NoteMeta[] = []
  private query = ''
  private openId: string | null = null
  private saveTimer: number | null = null
  private lastSaved = ''
  private disposed = false

  constructor(private readonly hooks: NoteHooks) {
    this.el = document.createElement('div')
    this.el.className = 'ember-notes'

    // ---- list -------------------------------------------------------------
    this.listEl = document.createElement('div')
    this.listEl.className = 'ember-notes-list'

    const head = document.createElement('header')
    head.className = 'ember-notes-head'
    const h = document.createElement('h2')
    h.textContent = 'Notes'
    this.countEl = document.createElement('span')
    this.countEl.className = 'ember-notes-count'

    this.search = document.createElement('input')
    this.search.type = 'search'
    this.search.className = 'ember-notes-search'
    this.search.placeholder = 'Search notes'
    this.search.autocomplete = 'off'
    this.search.spellcheck = false
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase()
      this.renderRows()
    })
    // Enter opens the top hit, so searching and opening is one gesture rather than a
    // search followed by a reach for the mouse.
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.filtered()[0]
        if (first) void this.open(first.id)
      } else if (e.key === 'Escape' && this.search.value) {
        e.stopPropagation()
        this.search.value = ''
        this.query = ''
        this.renderRows()
      } else if (e.key === 'Escape' && this.hooks.onClose) {
        // Esc on an empty search leaves the notes, back to the shell they cover.
        e.stopPropagation()
        void this.flush().then(() => this.hooks.onClose?.())
      }
    })

    const add = document.createElement('button')
    add.className = 'ember-notes-new'
    add.textContent = 'New note'
    add.addEventListener('click', () => void this.create())

    // The way back to the shell underneath, when there is one. Esc does the same.

    const reveal = document.createElement('button')
    reveal.className = 'ember-notes-reveal'
    reveal.textContent = 'Open folder'
    reveal.title = 'These are ordinary .md files — Notepad opens them too'
    reveal.addEventListener('click', () => window.ember.notes.reveal())

    head.append(h, this.countEl, this.search, add, reveal)

    this.rows = document.createElement('div')
    this.rows.className = 'ember-notes-rows'
    this.listEl.append(head, this.rows)

    // ---- editor -----------------------------------------------------------
    this.editEl = document.createElement('div')
    this.editEl.className = 'ember-notes-edit'

    const bar = document.createElement('header')
    bar.className = 'ember-notes-bar'
    const back = document.createElement('button')
    back.className = 'ember-notes-back'
    back.textContent = '← All notes'
    back.addEventListener('click', () => void this.showList())
    this.status = document.createElement('span')
    this.status.className = 'ember-notes-status'

    const inFolder = document.createElement('button')
    inFolder.className = 'ember-notes-reveal'
    inFolder.textContent = 'Show file'
    inFolder.addEventListener('click', () => {
      if (this.openId) window.ember.notes.reveal(this.openId)
    })

    // Two-step, because a note is writing and there is no undo for a deleted one. It
    // goes to the recycle bin regardless, so the second click is a speed bump rather
    // than the only thing standing between you and the loss.
    const del = document.createElement('button')
    del.className = 'ember-notes-delete'
    del.textContent = 'Delete'
    let armed = false
    let armTimer: number | null = null
    const disarm = () => {
      armed = false
      del.classList.remove('is-armed')
      del.textContent = 'Delete'
    }
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true
        del.classList.add('is-armed')
        del.textContent = 'Delete note?'
        if (armTimer !== null) window.clearTimeout(armTimer)
        armTimer = window.setTimeout(disarm, 3500)
        return
      }
      if (armTimer !== null) window.clearTimeout(armTimer)
      disarm()
      if (!this.openId) return
      await this.deleteOpen()
    })

    // Text or list. A note with items in it opens as a list; this is the way back to the
    // plain text of it, and forward again.
    this.modeBtn = document.createElement('button')
    this.modeBtn.className = 'ember-notes-mode'
    this.modeBtn.addEventListener('click', () => this.setView(this.view === 'tasks' ? 'text' : 'tasks'))

    bar.append(back, this.status, this.modeBtn, inFolder, del)

    this.area = document.createElement('textarea')
    this.area.className = 'ember-notes-area'
    this.area.spellcheck = false
    this.area.placeholder = 'Write. The first line becomes the title, and the file name.'
    this.area.addEventListener('input', () => {
      // `/todo` on its own line in the plain editor: convert what follows and show the list.
      if (/^\s*\/todo\s*$/m.test(this.area.value)) {
        const converted = applyTodoCommand(this.area.value)
        if (converted !== null) {
          this.area.value = converted
          this.queueSave()
          this.setView('tasks')
          return
        }
      }
      this.queueSave()
    })
    this.area.addEventListener('keydown', (e) => {
      // Esc returns to the list, but only from a note that is already safe on disk.
      if (e.key === 'Escape') {
        e.stopPropagation()
        void this.showList()
      }
    })
    // Leaving the tab, the window, or the app should not wait out the debounce.
    this.area.addEventListener('blur', () => void this.flush())

    this.tasks = new TaskList({
      onChange: (text) => {
        this.area.value = text
        this.queueSave()
      },
      onLeave: () => void this.showList(),
    })

    this.editEl.append(bar, this.area, this.tasks.el)
    this.setView('text')
    this.el.append(this.listEl, this.editEl)
    this.el.dataset['mode'] = 'list'
  }

  /** Focus whatever is on screen, so a freshly opened tab takes typing immediately. */
  focus(): void {
    if (this.el.dataset['mode'] !== 'edit') this.search.focus()
    else if (this.view === 'tasks') this.tasks.focus()
    else this.area.focus()
  }

  /**
   * The notes as the overview's card shows them.
   *
   * Whichever note is open leads, because that is what the tab is doing; with none open
   * the card is the list, and names the most recently touched note so the card says
   * something rather than only counting.
   */
  summary(): SurfaceBrief {
    const n = this.notes.length
    const open = this.openId ? this.notes.find((x) => x.id === this.openId) : null
    const latest = this.notes[0]
    const writing = open ? titleOfBody(this.area.value) || open.title || 'Untitled note' : ''
    return {
      kind: 'notes',
      what: 'Notes',
      count: n ? `${n} note${n === 1 ? '' : 's'}` : 'no notes yet',
      where: open ? 'writing' : 'the list',
      line: writing
        ? `Writing: ${writing}`
        : latest
          ? `Last touched: ${latest.title || '(empty note)'}`
          : 'Nothing written yet.',
    }
  }

  setView(view: 'text' | 'tasks'): void {
    this.view = view
    this.editEl.dataset['view'] = view
    this.modeBtn.textContent = view === 'tasks' ? 'Text' : 'List'
    this.modeBtn.title = view === 'tasks' ? 'Edit as plain text' : 'Show as a list of items  (type /todo to convert)'
    if (view === 'tasks') this.tasks.setText(this.area.value)
  }

  async showList(): Promise<void> {
    await this.flush()
    this.openId = null
    this.el.dataset['mode'] = 'list'
    this.hooks.onTitle('Notes')
    await this.refresh()
    this.search.focus()
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    this.notes = await window.ember.notes.list()
    this.renderRows()
  }

  private filtered(): NoteMeta[] {
    if (!this.query) return this.notes
    return this.notes.filter((n) => `${n.title} ${n.preview}`.toLowerCase().includes(this.query))
  }

  private renderRows(): void {
    const list = this.filtered()
    this.countEl.textContent = this.notes.length ? `${this.notes.length}` : ''
    this.rows.replaceChildren()

    if (!list.length) {
      const empty = document.createElement('p')
      empty.className = 'ember-notes-empty'
      empty.textContent = this.notes.length
        ? `Nothing matches “${this.query}”`
        : 'No notes yet. “New note”, or type note in any shell.'
      this.rows.appendChild(empty)
      return
    }

    for (const n of list) {
      const row = document.createElement('button')
      row.className = 'ember-notes-row'
      row.addEventListener('click', () => void this.open(n.id))

      const title = document.createElement('span')
      title.className = 'ember-notes-title'
      title.textContent = n.title || '(empty note)'

      const when = document.createElement('span')
      when.className = 'ember-notes-when'
      when.textContent = ago(n.modified)
      when.title = new Date(n.modified).toLocaleString()

      const preview = document.createElement('span')
      preview.className = 'ember-notes-preview'
      preview.textContent = n.preview

      row.append(title, when, preview)
      this.rows.appendChild(row)
    }
  }

  async create(body = ''): Promise<void> {
    const meta = await window.ember.notes.create(body)
    if (!meta) return
    await this.refresh()
    await this.open(meta.id)
  }

  /**
   * Something else wrote a note — a Claude session through the bridge, or the folder
   * itself. The list simply re-reads. An open note reloads only when it is not carrying
   * unsaved typing, because the one thing worse than a stale view is losing a sentence
   * to a refresh; a dirty editor keeps what you typed and the next autosave wins.
   */
  async external(e: { id: string; was?: string; deleted?: boolean }): Promise<void> {
    if (this.disposed) return
    if (this.el.dataset['mode'] !== 'edit') {
      await this.refresh()
      return
    }
    const mine = this.openId !== null && (e.id === this.openId || e.was === this.openId)
    if (!mine) return
    if (e.deleted) {
      this.openId = null
      await this.showList()
      return
    }
    if (this.area.value !== this.lastSaved) return
    const body = await window.ember.notes.read(e.id)
    if (body === null) return
    // The folder watcher also reports this tab's own saves. Re-setting a textarea's value
    // to what it already holds is not free: it throws away the undo stack.
    if (body === this.area.value) {
      this.openId = e.id
      return
    }
    const at = this.area.selectionStart
    this.openId = e.id
    this.lastSaved = body
    this.area.value = body
    this.area.setSelectionRange(Math.min(at, body.length), Math.min(at, body.length))
    // Something else — a `todo add` from a shell, a Claude session — changed the list.
    if (this.view === 'tasks') this.tasks.setText(body)
    this.hooks.onTitle(titleOfBody(body) || 'Note')
  }

  async open(id: string): Promise<void> {
    await this.flush()
    const body = await window.ember.notes.read(id)
    if (body === null) {
      // Deleted or renamed underneath us — the list is the honest thing to show.
      await this.showList()
      return
    }
    this.openId = id
    this.lastSaved = body
    this.area.value = body
    this.el.dataset['mode'] = 'edit'
    this.status.textContent = ''
    this.hooks.onTitle(titleOfBody(body) || 'Note')
    // A note made of items opens as a list; anything else as text. Either way the caret
    // lands at the end, which is where you left off.
    this.setView(hasTasks(body) ? 'tasks' : 'text')
    if (this.view === 'tasks') {
      this.tasks.focus()
    } else {
      this.area.focus()
      const at = body.length
      this.area.setSelectionRange(at, at)
    }
  }

  private queueSave(): void {
    this.hooks.onTitle(titleOfBody(this.area.value) || 'Note')
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flush(), 400)
  }

  /** Write now if there is anything to write. Safe to call when there is not. */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.openId || this.disposed) return
    const body = this.area.value
    if (body === this.lastSaved) return

    const res = await window.ember.notes.save(this.openId, body)
    if (!res.ok) {
      this.status.textContent = res.error ? `not saved — ${res.error}` : 'not saved'
      return
    }
    this.lastSaved = body
    // The id follows the title, so a rename lands here rather than orphaning the editor.
    this.openId = res.id
    this.status.textContent = 'saved'
    window.setTimeout(() => {
      if (this.status.textContent === 'saved') this.status.textContent = ''
    }, 1500)
  }

  get isEditing(): boolean {
    return this.el.dataset['mode'] === 'edit'
  }

  /** Bin the open note (the recycle bin, so it is recoverable) and show the list. */
  async deleteOpen(): Promise<string> {
    if (!this.openId) throw new Error('no note is open here; del <name> works from the list')
    const id = this.openId
    const title = titleOfBody(this.area.value) || id
    // Cancel the pending autosave first, or it recreates the file we just binned.
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    await window.ember.notes.remove(id)
    this.openId = null
    void this.showList()
    return `Deleted ${title}`
  }

  /** A note by its title or file name, or a unique part of either. */
  private async find(q: string): Promise<NoteMeta> {
    await this.refresh()
    const want = q.trim().toLowerCase()
    if (!want) throw new Error('which note? give a few words of its title')
    const by = (f: (n: NoteMeta) => boolean) => this.notes.filter(f)
    const hits = by((n) => n.title.toLowerCase() === want || n.id.toLowerCase() === want).length
      ? by((n) => n.title.toLowerCase() === want || n.id.toLowerCase() === want)
      : by((n) => n.title.toLowerCase().includes(want) || n.id.toLowerCase().includes(want))
    if (!hits.length) throw new Error(`no note matches "${q}"`)
    if (hits.length > 1) throw new Error(`"${q}" matches ${hits.length} notes: ${hits.map((n) => n.title).join(', ')}`)
    return hits[0]!
  }

  async openNamed(q: string): Promise<string> {
    const n = await this.find(q)
    await this.open(n.id)
    return n.title
  }

  /** `del <name>` from the list; bare `del` while editing bins the open note. */
  async deleteNamed(q: string): Promise<string> {
    if (!q.trim()) return this.deleteOpen()
    const n = await this.find(q)
    if (n.id === this.openId) return this.deleteOpen()
    await window.ember.notes.remove(n.id)
    await this.refresh()
    return `Deleted ${n.title}`
  }

  /** One step out: the editor goes back to the list, the list goes back to the shell. */
  leave(): void {
    if (this.isEditing) void this.showList()
    else this.hooks.onClose?.()
  }

  reveal(): void {
    window.ember.notes.reveal(this.openId ?? undefined)
  }

  dispose(): void {
    void this.flush()
    this.disposed = true
    this.el.remove()
  }
}

/** Mirrors titleOf in main/notes.ts — the first line is the title. */
function titleOfBody(body: string): string {
  for (const line of body.split(/\r?\n/, 40)) {
    const t = line.replace(/^#{1,6}\s*/, '').trim()
    if (t) return t.slice(0, 120)
  }
  return ''
}
