export interface SearchHandlers {
  next(query: string): boolean
  previous(query: string): boolean
  clear(): void
  onClose(): void
}

/**
 * Scrollback find bar. Deliberately tiny: an input, a match indicator, and
 * next/previous. Enter advances, Shift+Enter goes back, Escape closes and hands
 * focus back to the terminal — the same muscle memory as every editor.
 */
export class Search {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly status: HTMLElement
  private open = false

  constructor(private readonly handlers: SearchHandlers) {
    this.el = document.createElement('div')
    this.el.className = 'ember-search'

    this.input = document.createElement('input')
    this.input.className = 'ember-search-input'
    this.input.placeholder = 'Find in scrollback…'
    this.input.spellcheck = false

    this.status = document.createElement('span')
    this.status.className = 'ember-search-status'

    const prev = this.button('&#xE70E;', 'Previous match', () => this.step(false))
    const next = this.button('&#xE70D;', 'Next match', () => this.step(true))
    const close = this.button('&#xE8BB;', 'Close', () => this.close())

    this.el.append(this.input, this.status, prev, next, close)

    this.input.addEventListener('input', () => {
      if (!this.input.value) {
        this.handlers.clear()
        this.status.textContent = ''
        return
      }
      this.step(true)
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        this.step(!e.shiftKey)
      }
    })
  }

  private button(glyph: string, label: string, fn: () => void): HTMLElement {
    const b = document.createElement('button')
    b.className = 'ember-search-btn'
    b.innerHTML = glyph
    b.title = label
    b.setAttribute('aria-label', label)
    b.addEventListener('click', fn)
    return b
  }

  private step(forward: boolean): void {
    const q = this.input.value
    if (!q) return
    const found = forward ? this.handlers.next(q) : this.handlers.previous(q)
    this.status.textContent = found ? '' : 'no match'
    this.el.classList.toggle('is-empty', !found)
  }

  get isOpen(): boolean {
    return this.open
  }

  show(seed = ''): void {
    this.open = true
    this.el.classList.add('is-open')
    if (seed) this.input.value = seed
    requestAnimationFrame(() => {
      this.input.focus()
      this.input.select()
    })
    if (this.input.value) this.step(true)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.el.classList.remove('is-open')
    this.handlers.clear()
    this.status.textContent = ''
    this.handlers.onClose()
  }
}
