interface Shortcut {
  keys: string
  what: string
}

interface Group {
  title: string
  items: Shortcut[]
}

/**
 * Every binding on one screen.
 *
 * There are enough shortcuts now that they are undiscoverable without this, and a
 * palette entry is not a substitute — you cannot search for a key you do not know
 * exists. Deliberately a flat reference rather than an interactive editor.
 */
export class Cheatsheet {
  readonly el: HTMLElement
  private open = false

  private static readonly GROUPS: Group[] = [
    {
      title: 'Essentials',
      items: [
        { keys: 'Ctrl K', what: 'Command line: new, o, split, todo, note, theme, del…' },
        { keys: 'Ctrl Shift P', what: 'The same' },
        { keys: 'Ctrl Shift D', what: 'Todo list over this tab, and back' },
        { keys: '>', what: '…run a command in this pane' },
        { keys: '@', what: '…open a project' },
        { keys: '!', what: '…run a package.json / Makefile task' },
        { keys: '?', what: '…search every open session' },
        { keys: '#', what: '…switch theme' },
        { keys: 'F1', what: 'This cheatsheet' },
        { keys: 'Ctrl ,', what: 'Settings' },
      ],
    },
    {
      title: 'Sessions',
      items: [
        { keys: 'Ctrl Shift T', what: 'New session' },
        { keys: 'Ctrl Shift W', what: 'Close focused pane' },
        { keys: 'F2', what: 'Rename session' },
        { keys: 'Ctrl Tab', what: 'Next session' },
        { keys: 'Ctrl Shift Tab', what: 'Previous session' },
        { keys: 'Ctrl Alt 1…9', what: 'Jump to session' },
        { keys: 'hold ×', what: 'Close (half a second)' },
      ],
    },
    {
      title: 'Splits',
      items: [
        { keys: 'Alt Shift +', what: 'Split right' },
        { keys: 'Alt Shift -', what: 'Split down' },
        { keys: 'Alt ← → ↑ ↓', what: 'Move between panes' },
        { keys: 'Ctrl Shift Z', what: 'Zoom focused pane' },
        { keys: 'Ctrl Shift A', what: 'Broadcast input to all panes' },
      ],
    },
    {
      title: 'Navigating output',
      items: [
        { keys: 'Ctrl ↑ / ↓', what: 'Previous / next command' },
        { keys: 'Ctrl F', what: 'Find in scrollback' },
        { keys: 'Ctrl Shift O', what: 'Copy last command output' },
        { keys: 'click a rail tick', what: 'Jump to that command' },
      ],
    },
    {
      title: 'View',
      items: [
        { keys: 'Ctrl B', what: 'Toggle sidebar' },
        { keys: 'Ctrl Shift Enter', what: 'Zen mode (hide all chrome)' },
        { keys: 'Ctrl Shift C / V', what: 'Copy / paste' },
      ],
    },
    {
      title: 'Panel & voice',
      items: [
        { keys: 'Ctrl Shift J', what: 'Show / hide the panel' },
        { keys: 'Ctrl Shift E', what: 'Point at something on the panel' },
        { keys: 'click a button', what: 'Sends it to this session' },
        { keys: 'Ctrl Shift M', what: 'Orchestrator — write to it' },
        { keys: 'Ctrl Shift L', what: '…or call it and talk' },
        { keys: 'Esc', what: 'Hang up (only while on a call)' },
      ],
    },
  ]

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'ember-cheatsheet'

    const panel = document.createElement('div')
    panel.className = 'ember-cheatsheet-panel'

    const head = document.createElement('header')
    const h = document.createElement('h2')
    h.textContent = 'Keyboard shortcuts'
    const hint = document.createElement('span')
    hint.textContent = 'Esc to close'
    head.append(h, hint)
    panel.appendChild(head)

    const grid = document.createElement('div')
    grid.className = 'ember-cheatsheet-grid'
    for (const group of Cheatsheet.GROUPS) {
      const col = document.createElement('section')
      const title = document.createElement('h3')
      title.textContent = group.title
      col.appendChild(title)
      for (const item of group.items) {
        const row = document.createElement('div')
        row.className = 'ember-cheatsheet-row'
        const keys = document.createElement('span')
        keys.className = 'ember-keys'
        for (const k of item.keys.split(' ')) {
          const kbd = document.createElement('kbd')
          kbd.textContent = k
          keys.appendChild(kbd)
        }
        const what = document.createElement('span')
        what.className = 'ember-cheatsheet-what'
        what.textContent = item.what
        row.append(keys, what)
        col.appendChild(row)
      }
      grid.appendChild(col)
    }
    panel.appendChild(grid)
    this.el.appendChild(panel)
    document.body.appendChild(this.el)

    this.el.addEventListener('mousedown', () => this.close())
  }

  get isOpen(): boolean {
    return this.open
  }

  toggle(): void {
    this.open = !this.open
    this.el.classList.toggle('is-open', this.open)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.el.classList.remove('is-open')
  }
}
