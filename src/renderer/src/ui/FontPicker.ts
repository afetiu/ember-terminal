import type { FontOption } from '@shared/types'
import { isMonospace, primaryFamily, quoteFamily } from '../core/fonts'

export interface FontPickerOptions {
  /** Families offered in the list, as reported by the OS. */
  fonts: FontOption[]
  /** Current value: a family name, a CSS stack, or '' when `inherit` is set. */
  value: string
  /** Label for the '' value. Omitting it makes the empty value unreachable. */
  inherit?: string
  onChange(value: string): void
}

/** Glyphs worth seeing before committing to a terminal font. */
const SAMPLE = '0O1lI {} => ~-'

/**
 * The font control in settings.
 *
 * A `<select>` of four hundred families tells you nothing — the point of choosing a
 * font is seeing it, so every row is drawn in the family it names, with the glyphs a
 * terminal actually turns on (zero, one, ligature arrows). Monospaced families sort
 * first because the terminal grid needs one; the rest stay reachable for the chrome.
 *
 * The filter box is also the escape hatch: typing a name nothing matches and pressing
 * Enter commits it verbatim, so a full CSS stack with fallbacks — which is what the
 * config has always held — survives a trip through the picker.
 */
export class FontPicker {
  /**
   * The one menu that can be on screen.
   *
   * App binds Escape on `window` in the capture phase and closes the settings panel
   * with it, which runs before anything this control could listen for — so the panel
   * asks whether an inner surface wants the key first, through here.
   */
  private static current: FontPicker | null = null

  /** Close an open font menu, if there is one. True when it swallowed the key. */
  static dismissOpen(): boolean {
    if (!FontPicker.current) return false
    FontPicker.current.close()
    return true
  }

  readonly el: HTMLElement
  private readonly label: HTMLElement
  private menu: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private list: HTMLElement | null = null
  private observer: IntersectionObserver | null = null
  private rows: HTMLElement[] = []
  private cursor = -1
  private value: string

  private readonly onDocDown = (e: PointerEvent) => {
    const t = e.target as Node
    if (!this.el.contains(t) && !this.menu?.contains(t)) this.close()
  }
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.menu) return
    if (e.key === 'Escape') {
      // The settings overlay closes on Escape too; the innermost surface wins.
      e.stopPropagation()
      e.preventDefault()
      this.close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      this.move(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = this.rows[this.cursor]
      const typed = this.input?.value.trim() ?? ''
      if (row) this.commit(row.dataset['value'] ?? '')
      else if (typed) this.commit(typed)
      else this.close()
    }
  }
  private readonly reposition = () => this.position()

  constructor(private readonly opts: FontPickerOptions) {
    this.value = opts.value
    this.el = document.createElement('button')
    this.el.className = 'ember-fontpick'
    this.el.setAttribute('type', 'button')

    this.label = document.createElement('span')
    this.label.className = 'ember-fontpick-value'
    const caret = document.createElement('i')
    caret.className = 'ember-fontpick-caret'
    caret.textContent = '⌄'
    this.el.append(this.label, caret)
    this.el.addEventListener('click', (e) => {
      e.preventDefault()
      if (this.menu) this.close()
      else this.open()
    })
    this.paint()
  }

  private paint(): void {
    const family = primaryFamily(this.value)
    this.label.textContent = family || this.opts.inherit || 'Default'
    this.label.style.fontFamily = family ? quoteFamily(family) : 'var(--ui-font)'
    this.el.title = this.value || this.opts.inherit || ''
    this.el.classList.toggle('is-inherited', !family)
  }

  private commit(next: string): void {
    this.value = next
    this.paint()
    this.close()
    this.opts.onChange(next)
  }

  private open(): void {
    FontPicker.current?.close()
    const menu = document.createElement('div')
    menu.className = 'ember-fontpick-menu'

    const input = document.createElement('input')
    input.className = 'ember-fontpick-filter'
    input.placeholder = 'Filter fonts, or type any family…'
    input.spellcheck = false
    input.autocomplete = 'off'
    input.addEventListener('input', () => this.fill())

    const list = document.createElement('div')
    list.className = 'ember-fontpick-list'

    menu.append(input, list)
    document.body.appendChild(menu)
    this.menu = menu
    this.input = input
    this.list = list

    // Previews are the expensive part — a family only costs a face to load once its
    // row is actually on screen.
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const row = entry.target as HTMLElement
          const family = row.dataset['family']
          if (family) row.style.fontFamily = quoteFamily(family)
          this.observer?.unobserve(row)
        }
      },
      { root: list, rootMargin: '160px' },
    )

    this.position()
    this.fill()
    menu.classList.add('is-open')
    FontPicker.current = this
    document.addEventListener('pointerdown', this.onDocDown, true)
    document.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.reposition)
    // The settings body scrolls under a fixed menu, so follow it rather than float.
    document.addEventListener('scroll', this.reposition, true)
    requestAnimationFrame(() => input.focus())
  }

  private close(): void {
    if (!this.menu) return
    if (FontPicker.current === this) FontPicker.current = null
    document.removeEventListener('pointerdown', this.onDocDown, true)
    document.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.reposition)
    document.removeEventListener('scroll', this.reposition, true)
    this.observer?.disconnect()
    this.observer = null
    this.menu.remove()
    this.menu = null
    this.input = null
    this.list = null
    this.rows = []
    this.cursor = -1
  }

  private position(): void {
    if (!this.menu) return
    const r = this.el.getBoundingClientRect()
    const height = Math.min(340, window.innerHeight - 32)
    const width = Math.max(280, r.width)
    // Flip above the control when there is not room below it.
    const below = window.innerHeight - r.bottom - 12
    const top = below >= height ? r.bottom + 6 : Math.max(12, r.top - height - 6)
    this.menu.style.top = `${top}px`
    this.menu.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`
    this.menu.style.width = `${width}px`
    this.menu.style.maxHeight = `${height}px`
  }

  private fill(): void {
    if (!this.list) return
    const query = (this.input?.value ?? '').trim().toLowerCase()
    const matches = this.opts.fonts.filter((f) => !query || f.family.toLowerCase().includes(query))
    const mono = matches.filter((f) => isMonospace(f.family))
    const rest = matches.filter((f) => !isMonospace(f.family))

    this.list.replaceChildren()
    this.rows = []

    if (this.opts.inherit && !query) {
      this.list.appendChild(this.buildRow('', this.opts.inherit))
    }
    if (mono.length) {
      this.list.appendChild(this.buildHeader('Monospaced'))
      for (const f of mono) this.list.appendChild(this.buildRow(f.family, f.family, f))
    }
    if (rest.length) {
      this.list.appendChild(this.buildHeader('All fonts'))
      for (const f of rest) this.list.appendChild(this.buildRow(f.family, f.family, f))
    }
    if (!matches.length) {
      const note = document.createElement('div')
      note.className = 'ember-fontpick-note'
      note.textContent = query ? `Press Enter to use “${this.input?.value.trim()}” anyway` : 'No fonts found'
      this.list.appendChild(note)
    }

    // Land on whatever is already selected, so opening and pressing Enter is a no-op.
    const current = this.rows.findIndex((r) => r.dataset['value'] === this.value)
    this.cursor = current >= 0 ? current : this.rows.length ? 0 : -1
    this.highlight(current >= 0)
  }

  private buildHeader(text: string): HTMLElement {
    const h = document.createElement('div')
    h.className = 'ember-fontpick-group'
    h.textContent = text
    return h
  }

  private buildRow(value: string, text: string, font?: FontOption): HTMLElement {
    const row = document.createElement('div')
    row.className = 'ember-fontpick-row'
    row.dataset['value'] = value
    row.classList.toggle('is-current', value === this.value)

    const name = document.createElement('span')
    name.className = 'ember-fontpick-name'
    name.textContent = text

    row.appendChild(name)

    if (font) {
      row.dataset['family'] = value
      const sample = document.createElement('span')
      sample.className = 'ember-fontpick-sample'
      sample.textContent = SAMPLE
      row.appendChild(sample)
      // A family the machine does not have would silently preview as the fallback,
      // which is exactly the surprise the picker exists to prevent. The OS list is
      // what decides that — measuring the preview cannot tell a missing font from
      // one with no Latin glyphs to measure.
      if (!font.installed) {
        row.classList.add('is-missing')
        row.title = `${value} is not installed here — text falls back to another font`
      }
      this.observer?.observe(row)
    }

    row.addEventListener('mouseenter', () => {
      this.cursor = this.rows.indexOf(row)
      this.highlight(false)
    })
    row.addEventListener('click', () => this.commit(value))
    this.rows.push(row)
    return row
  }

  private move(delta: number): void {
    if (!this.rows.length) return
    this.cursor = (this.cursor + delta + this.rows.length) % this.rows.length
    this.highlight(true)
  }

  private highlight(scroll: boolean): void {
    this.rows.forEach((row, i) => row.classList.toggle('is-active', i === this.cursor))
    if (scroll) this.rows[this.cursor]?.scrollIntoView({ block: 'nearest' })
  }
}
