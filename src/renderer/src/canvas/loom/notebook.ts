import { escapeHtml } from '../markdown'
import type { LoomView } from '../LoomView'
import { ICON, div, linkify, type Piece } from './shared'

/**
 * Notes and todos on the canvas: the notebook drawer beside it (the todo list and the
 * notes, edited there), a note edited in place on the canvas, something on the canvas
 * kept as a note, sticky notes (Ctrl+Shift+N), and rows of the notebook dragged out onto
 * the canvas. Everything is the real Todo.md and the real notes folder.
 */
export class Notebook {
  /** The notebook: the todo list and notes, in a drawer beside the canvas. */
  readonly drawer = div('loom-drawer')
  openTodos = 0
  /** The notes folder, so a note on the canvas can be told from any other markdown file. */
  notesDir = ''
  private drawerTab: 'todo' | 'notes' = 'todo'
  private drawerNote: string | null = null

  constructor(private readonly v: LoomView) {}

  // ================================================================ sticky notes

  /**
   * A sticky note on this session's canvas: a real note (it is on the Notes page too,
   * saying which session it came from), placed on screen and open for typing.
   */
  async newSticky(): Promise<void> {
    const v = this.v
    const when = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    // The session's name without its status glyph, as plain words the Notes page can show.
    const from = (document.querySelector(`.ember-card[data-id="${v.tabId}"] .ember-card-title`)?.textContent ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
    const made = await window.ember.notes.create(`# Note, ${when}\n\nFrom the session ${from || 'in Ember'}.\n\n`)
    if (!made) {
      v.hooks.toast('Could not create the note')
      return
    }
    const dir = await window.ember.notes.dir()
    await window.ember.canvas.showFile(v.tabId, `${dir}/${made.id}`, made.title)
    for (let i = 0; i < 40; i++) {
      const piece = v.findPiece(made.title)
      if (piece) {
        piece.el.classList.add('is-sticky')
        const host = v.el.getBoundingClientRect()
        v.objects.pin(piece, false)
        piece.el.style.width = '320px'
        piece.el.style.height = '240px'
        piece.free = { w: 320, h: 240 }
        v.objects.place2(piece, Math.max(24, host.width - 360 - 40 * (v.pinned.size % 4)), 72 + 28 * (v.pinned.size % 4))
        v.objects.settlePin(piece)
        void this.editNote(piece)
        return
      }
      await new Promise((r) => window.setTimeout(r, 75))
    }
  }

  // ================================================================ notes and todos

  /** The todo list, changed from the canvas: tick, add. Written to the real Todo.md; the card redraws from it. */
  async todoOp(op: string, text: string, quiet = false): Promise<void> {
    if (!text.trim()) return
    const body = (await window.ember.notes.read('Todo.md')) ?? ''
    if (op === 'add') {
      await window.ember.notes.save('Todo.md', `${body.replace(/\s*$/, '')}\n- [ ] ${text.trim()}\n`)
      if (!quiet) this.v.hooks.toast(`Added to Todo — it's in the notebook (Ctrl+Shift+N)`)
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
  async saveToNote(text: string, title: string): Promise<void> {
    const body = title && !/^#/.test(text.trim()) ? `# ${title}\n\n${text.trim()}\n` : `${text.trim()}\n`
    const made = await window.ember.notes.create(body)
    if (!made) {
      this.v.hooks.toast('Could not save the note')
      return
    }
    // It opens in the notebook, so you see where it went and can edit it straight away.
    this.openDrawer('notes', made.id)
  }

  /** Edit a note right where it is on the canvas. Saved on Ctrl+S, Esc or leaving it; the object redraws from the file. */
  async editNote(piece: Piece): Promise<void> {
    if (!piece.file || piece.el.classList.contains('is-editing')) return
    const id = piece.file.split(/[\\/]/).pop() ?? ''
    const text = (await window.ember.notes.read(id)) ?? ''
    const ed = document.createElement('textarea')
    ed.className = 'loom-note-edit'
    ed.spellcheck = false
    ed.value = text
    piece.el.classList.add('is-editing')
    this.v.objects.minimize(piece, false)
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

  /** Open the notebook on a tab, or on one note; with `text`, start a new note with it. */
  openDrawer(tab: 'todo' | 'notes', noteId?: string, text?: string): void {
    this.drawerTab = tab
    this.drawerNote = noteId ?? null
    this.drawer.classList.add('is-on')
    this.v.el.classList.add('has-drawer')
    // Only the notebook icon's state changes; the rest of the bar is left alone.
    this.v.sign.querySelector('.loom-sign-book')?.classList.add('is-active')
    if (text !== undefined) {
      void window.ember.notes.create(text).then((n) => {
        if (n) this.drawerNote = n.id
        void this.renderDrawer()
      })
      return
    }
    void this.renderDrawer()
  }

  toggleDrawer(tab?: 'todo' | 'notes'): void {
    if (this.drawer.classList.contains('is-on') && (!tab || tab === this.drawerTab)) this.closeDrawer()
    else this.openDrawer(tab ?? this.drawerTab)
  }

  closeDrawer(): void {
    this.drawer.classList.remove('is-on')
    window.setTimeout(() => {
      if (!this.drawer.classList.contains('is-on')) this.v.el.classList.remove('has-drawer')
    }, 420)
    this.v.renderSign()
    this.v.session.focus()
  }

  /** The open-todo count on the notebook icon, kept current. */
  async countTodos(): Promise<void> {
    const body = (await window.ember.notes.read('Todo.md')) ?? ''
    const n = body.split('\n').filter((l) => /^\s*[-*]\s*\[ \]\s*\S/.test(l)).length
    if (n !== this.openTodos) {
      this.openTodos = n
      this.v.renderSign()
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
        this.v.objects.track(
          ev,
          'grabbing',
          (m) => {
            lx = m.clientX
            ly = m.clientY
            at(lx, ly)
            const over = this.dropTarget(lx, ly)
            ghost.classList.toggle('is-ok', over)
            this.v.el.classList.toggle('is-drop', over)
          },
          () => {
            ghost.remove()
            this.v.el.classList.remove('is-drop')
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
    const c = this.v.scroller.getBoundingClientRect()
    const d = this.drawer.getBoundingClientRect()
    const inDrawer = x >= d.left && x <= d.right && y >= d.top && y <= d.bottom
    return !inDrawer && x >= c.left && x <= c.right && y >= c.top && y <= c.bottom
  }

  /** Put a notes-folder file on the canvas, and place it where it was dropped. */
  private async dropFile(path: string, title: string, x: number, y: number): Promise<void> {
    const v = this.v
    await window.ember.canvas.showFile(v.tabId, path, title)
    for (let i = 0; i < 40; i++) {
      const piece = v.findPiece(title)
      if (piece) {
        const host = v.el.getBoundingClientRect()
        v.objects.pin(piece, false)
        piece.dock = null
        v.objects.front(piece)
        v.objects.place2(piece, x - host.left - 24, y - host.top - 14)
        v.objects.settlePin(piece)
        return
      }
      await new Promise((r) => window.setTimeout(r, 75))
    }
  }

  async renderDrawer(): Promise<void> {
    const v = this.v
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
        await window.ember.canvas.showFile(v.tabId, `${dir}\\${id}`, n?.title ?? id)
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
          v.type(`Do this from my todo list: ${li.dataset['t'] ?? ''}`, true)
          this.closeDrawer()
        })
        // Taken out, a todo brings the live todo list onto the canvas (tickable there).
        this.draggableRow(li, 'Todo', (x, y) => void window.ember.notes.dir().then((dir) => this.dropFile(`${dir}/Todo.md`, 'Todo', x, y)))
      })
      add.focus()
    }
  }
}
