/**
 * A note's lines as a list of things to do.
 *
 * Not a second store: the list *is* the note's text, one line per row, task lines in the
 * markdown form every editor already understands — `- [ ] item`, `- [x] item` — and any
 * other line kept as it is (a heading, a blank, a remark). Everything this list does is
 * an edit to that text, handed back through `onChange`, so the file on disk, the plain
 * editor and this view can never disagree about what the list says.
 *
 * Keyboard first: Enter adds an item below, Backspace on an empty one removes it, Alt+↑/↓
 * moves one, Ctrl+Enter ticks it, ↑/↓ walk the list. The mouse can tick and drag. Typing
 * `- ` at the start of a plain line makes it an item; typing `/todo` on a line turns every
 * plain line after it into one.
 */
import { sourceButton } from './SourceIcon'

export interface Row {
  kind: 'task' | 'text'
  done: boolean
  text: string
  /** Where the item came from, kept at the end of its line as `[Jira](https://…)`. */
  link?: { label: string; url: string }
}

const TASK = /^(\s*)- \[([ xX])\] ?(.*)$/
/** A trailing markdown link, or a bare URL, is the item's source rather than its text. */
const LINK = /\s*(?:\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<?(https?:\/\/\S+?)>?)\s*$/

function splitLink(text: string): { text: string; link?: { label: string; url: string } } {
  const m = LINK.exec(text)
  if (!m) return { text }
  const url = m[2] ?? m[3] ?? ''
  let label = m[1] ?? ''
  if (!label) {
    try {
      label = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      label = 'link'
    }
  }
  return { text: text.slice(0, m.index).trimEnd(), link: { label, url } }
}

function joinLink(row: Row): string {
  return row.link ? `${row.text} [${row.link.label}](${row.link.url})` : row.text
}

/**
 * Lines to rows. With `itemsByDefault`, every non-empty line that is not a heading is an
 * item, whatever it was written as — the todo list has no other kind of line — so a line
 * typed plainly, or by a script, still gets its box.
 */
export function parseRows(text: string, itemsByDefault = false): Row[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const m = TASK.exec(line)
    if (m) return { kind: 'task', done: m[2] !== ' ', ...splitLink(m[3] ?? '') }
    if (itemsByDefault && line.trim() && !/^\s*#/.test(line)) {
      return { kind: 'task', done: false, ...splitLink(line.replace(/^\s*[-*]\s+/, '').trim()) }
    }
    return { kind: 'text', done: false, text: line }
  })
}

export function serializeRows(rows: Row[]): string {
  return rows.map((r) => (r.kind === 'task' ? `- [${r.done ? 'x' : ' '}] ${joinLink(r)}` : r.text)).join('\n')
}

/** Does this text have any task in it? Decides whether a note opens as a list. */
export function hasTasks(text: string): boolean {
  return /^\s*- \[[ xX]\] /m.test(text)
}

/**
 * `/todo` on its own line: the line goes, and every non-empty plain line after it
 * becomes an item. Returns null when there is no such line.
 */
export function applyTodoCommand(text: string): string | null {
  const rows = parseRows(text)
  const at = rows.findIndex((r) => r.kind === 'text' && r.text.trim() === '/todo')
  if (at === -1) return null
  rows.splice(at, 1)
  for (let i = at; i < rows.length; i++) {
    const r = rows[i]!
    if (r.kind === 'text' && r.text.trim() && !/^\s*#/.test(r.text)) {
      r.kind = 'task'
      r.done = false
      r.text = r.text.replace(/^\s*[-*]\s+/, '').trim()
    }
  }
  return serializeRows(rows)
}

export interface TaskHooks {
  onChange: (text: string) => void
  /** Escape from the list. */
  onLeave?: () => void
  /** Treat every plain line as an item (the todo list); otherwise only `- [ ]` lines are. */
  itemsByDefault?: boolean
  /** Present on the todo list: hand one item to a new Claude session. */
  onClaude?: (text: string) => void
  /** Open an item's source (the Jira issue, the PR, the mail thread) outside Ember. */
  onOpen?: (url: string) => void
}

export class TaskList {
  readonly el: HTMLElement
  private rows: Row[] = []
  private last = ''
  private dragFrom = -1

  constructor(private readonly hooks: TaskHooks) {
    this.el = document.createElement('div')
    this.el.className = 'ember-tasks'
    // Rows are textareas sized to their text; a narrower column rewraps them.
    new ResizeObserver(() => this.growAll()).observe(this.el)
    this.el.addEventListener('dragover', (e) => {
      e.preventDefault()
      const over = this.rowAt(e.clientY)
      for (const r of this.el.children) r.classList.remove('is-drop-before', 'is-drop-after')
      if (!over) return
      const box = over.el.getBoundingClientRect()
      over.el.classList.add(e.clientY < box.top + box.height / 2 ? 'is-drop-before' : 'is-drop-after')
    })
    this.el.addEventListener('drop', (e) => {
      e.preventDefault()
      const over = this.rowAt(e.clientY)
      for (const r of this.el.children) r.classList.remove('is-drop-before', 'is-drop-after')
      if (!over || this.dragFrom < 0) return
      const box = over.el.getBoundingClientRect()
      let to = over.index + (e.clientY < box.top + box.height / 2 ? 0 : 1)
      if (to > this.dragFrom) to--
      this.move(this.dragFrom, to)
      this.dragFrom = -1
    })
  }

  /** Show this text. A no-op when it is what is already showing, so a save echo costs nothing. */
  setText(text: string): void {
    if (text === this.last) return
    this.last = text
    this.rows = parseRows(text, this.hooks.itemsByDefault)
    this.render()
  }

  text(): string {
    return serializeRows(this.rows)
  }

  focus(index = -1): void {
    const inputs = this.el.querySelectorAll<HTMLTextAreaElement>('.ember-task-text')
    const el = inputs[index < 0 ? inputs.length - 1 : Math.min(index, inputs.length - 1)]
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

  private emit(): void {
    this.last = this.text()
    this.hooks.onChange(this.last)
  }

  private rowAt(y: number): { el: HTMLElement; index: number } | null {
    const els = [...this.el.children] as HTMLElement[]
    for (const [index, el] of els.entries()) {
      const b = el.getBoundingClientRect()
      if (y >= b.top && y <= b.bottom) return { el, index }
    }
    const lastEl = els.at(-1)
    return lastEl ? { el: lastEl, index: els.length - 1 } : null
  }

  private move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.rows.length || to >= this.rows.length) return
    const [row] = this.rows.splice(from, 1)
    this.rows.splice(to, 0, row!)
    this.render()
    this.emit()
    this.focus(to)
  }

  private render(): void {
    this.el.replaceChildren()
    this.rows.forEach((row, i) => this.el.appendChild(this.rowEl(row, i)))
    if (!this.rows.length) this.el.appendChild(this.rowEl({ kind: 'task', done: false, text: '' }, 0))
    this.growAll()
  }

  /** A row is as tall as its text: one line usually, more when an item runs long. */
  private static grow(area: HTMLTextAreaElement): void {
    area.style.height = 'auto'
    area.style.height = `${area.scrollHeight}px`
  }

  private growAll(): void {
    // After layout: a textarea that is not in the document yet measures nothing.
    requestAnimationFrame(() => {
      for (const a of this.el.querySelectorAll<HTMLTextAreaElement>('.ember-task-text')) TaskList.grow(a)
    })
  }

  private rowEl(row: Row, i: number): HTMLElement {
    const el = document.createElement('div')
    el.className = `ember-task is-${row.kind}${row.done ? ' is-done' : ''}${row.kind === 'text' && /^\s*#/.test(row.text) ? ' is-heading' : ''}${row.kind === 'text' && !row.text.trim() ? ' is-blank' : ''}`
    el.draggable = true
    el.addEventListener('dragstart', (e) => {
      this.dragFrom = i
      el.classList.add('is-dragging')
      e.dataTransfer?.setData('text/plain', row.text)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    el.addEventListener('dragend', () => {
      el.classList.remove('is-dragging')
      for (const r of this.el.children) r.classList.remove('is-drop-before', 'is-drop-after')
    })

    const grip = document.createElement('span')
    grip.className = 'ember-task-grip'
    grip.textContent = '⋮⋮'
    grip.title = 'Drag to reorder  ·  Alt+↑/↓'

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'ember-task-box'
    box.checked = row.done
    box.tabIndex = -1
    box.hidden = row.kind !== 'task'
    box.addEventListener('change', () => {
      row.done = box.checked
      el.classList.toggle('is-done', row.done)
      this.emit()
    })

    // A textarea rather than an input, so a long item wraps instead of running off the
    // right edge; Enter is caught below, so it still never holds a newline.
    const input = document.createElement('textarea')
    input.className = 'ember-task-text'
    input.rows = 1
    input.value = row.text
    input.spellcheck = false
    input.placeholder = row.kind === 'task' ? 'Something to do' : ''
    input.addEventListener('input', () => {
      TaskList.grow(input)
      row.text = input.value
      // On the todo list every line is an item: typing into a blank spacer line makes
      // one, box and all, rather than leaving a bare line without a box.
      if (this.hooks.itemsByDefault && row.kind === 'text' && input.value.trim() && !/^\s*#/.test(input.value)) {
        const caret = input.selectionStart ?? input.value.length
        row.kind = 'task'
        this.render()
        this.emit()
        this.focus(i)
        this.el.querySelectorAll<HTMLTextAreaElement>('.ember-task-text')[i]?.setSelectionRange(caret, caret)
        return
      }
      // `- ` at the start of a plain line is asking to be an item.
      if (row.kind === 'text' && /^\s*(- |\[\] )/.test(input.value)) {
        row.kind = 'task'
        row.text = input.value.replace(/^\s*(- |\[\] )/, '')
        this.render()
        this.emit()
        this.focus(i)
        return
      }
      // `/todo` on a line converts everything under it.
      if (row.kind === 'text' && input.value.trim() === '/todo') {
        const converted = applyTodoCommand(this.text())
        if (converted !== null) {
          this.rows = parseRows(converted, this.hooks.itemsByDefault)
          this.render()
          this.emit()
          this.focus(Math.min(i, this.rows.length - 1))
          return
        }
      }
      this.emit()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey && row.kind === 'task') {
        e.preventDefault()
        box.checked = !box.checked
        box.dispatchEvent(new Event('change'))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        // Split at the caret, as an editor would: the tail becomes the new item.
        const at = input.selectionStart ?? input.value.length
        const tail = input.value.slice(at)
        row.text = input.value.slice(0, at)
        this.rows.splice(i + 1, 0, { kind: row.kind === 'task' || !row.text.trim() || this.hooks.itemsByDefault ? 'task' : 'text', done: false, text: tail })
        this.render()
        this.emit()
        this.focus(i + 1)
        const next = this.el.querySelectorAll<HTMLTextAreaElement>('.ember-task-text')[i + 1]
        next?.setSelectionRange(0, 0)
      } else if (e.key === 'Backspace' && input.value === '' && this.rows.length > 1) {
        e.preventDefault()
        this.rows.splice(i, 1)
        this.render()
        this.emit()
        this.focus(Math.max(0, i - 1))
      } else if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault()
        this.move(i, i - 1)
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault()
        this.move(i, i + 1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.focus(Math.max(0, i - 1))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.focus(Math.min(this.rows.length - 1, i + 1))
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        this.hooks.onLeave?.()
      }
    })

    el.append(grip, box, input)

    // After the text, at the row's end: where the item came from, and the way to hand
    // it to a session. Always there, so the row's structure is the same whether or
    // not the pointer is on it. No dismiss: this is a text editor, delete the line.
    if (row.kind === 'task') {
      const meta = document.createElement('span')
      meta.className = 'ember-task-meta'
      if (row.link && this.hooks.onOpen) meta.appendChild(sourceButton(row.link.url, this.hooks.onOpen))
      if (this.hooks.onClaude && !row.done) {
        const go = document.createElement('button')
        go.className = 'ember-task-go'
        go.innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3 4.5 6.5 8 3 11.5M8 12h5"/></svg>'
        go.appendChild(document.createTextNode('Start a session'))
        go.title = 'A new tab with a Claude session on this item  (claude <words>)'
        go.tabIndex = -1
        go.addEventListener('mousedown', (e) => e.preventDefault())
        go.addEventListener('click', () => this.hooks.onClaude?.(row.link ? `${row.text} (${row.link.url})` : row.text))
        meta.appendChild(go)
      }
      if (meta.childElementCount) el.appendChild(meta)
    }
    return el
  }
}
