/**
 * Slim draggable strip across the top: brand mark on the left, caption buttons on
 * the right. The window is frameless (`titleBarStyle: 'hidden'`), so these are ours
 * to draw — but the OS frame is still present, which is what keeps Snap Layouts,
 * rounded corners and the window shadow working.
 */
import logoUrl from '../assets/logo.png'

/** Lucide-style line icons, drawn in the text colour. */
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

export class TitleBar {
  readonly el: HTMLElement

  constructor(private readonly onToggleSidebar: () => void) {
    this.el = document.createElement('header')
    this.el.className = 'ember-titlebar'

    const brand = document.createElement('div')
    brand.className = 'ember-brand'

    const toggle = document.createElement('button')
    toggle.className = 'ember-sidebar-toggle'
    toggle.title = 'Toggle sidebar  (Ctrl+B · ember sidebar)'
    toggle.setAttribute('aria-label', 'Toggle sidebar')
    toggle.innerHTML = svg('<path d="M4 6h16M4 12h16M4 18h16"/>')
    toggle.addEventListener('click', () => this.onToggleSidebar())

    const mark = document.createElement('img')
    mark.className = 'ember-brand-mark'
    mark.src = logoUrl
    mark.alt = ''
    mark.draggable = false

    const name = document.createElement('span')
    name.className = 'ember-brand-name'
    name.textContent = 'Ember'

    brand.append(toggle, mark, name)

    const drag = document.createElement('div')
    drag.className = 'ember-drag'
    drag.addEventListener('dblclick', () => window.ember.window.toggleMaximize())

    this.el.append(brand, drag, this.buildWindowControls())
  }

  private buildWindowControls(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ember-wincontrols'

    const make = (cls: string, label: string, glyph: string, fn: () => void) => {
      const b = document.createElement('button')
      b.className = `ember-winbtn ${cls}`
      b.setAttribute('aria-label', label)
      b.title = label
      b.innerHTML = glyph
      b.addEventListener('click', fn)
      return b
    }

    // Segoe Fluent Icons — the same glyphs the shell uses for caption buttons.
    wrap.append(
      make('min', 'Minimize', '&#xE921;', () => window.ember.window.minimize()),
      make('max', 'Maximize', '&#xE922;', () => window.ember.window.toggleMaximize()),
      make('close', 'Close', '&#xE8BB;', () => window.ember.window.close()),
    )

    window.ember.window.onMaximizeChange((maximized) => {
      const btn = wrap.querySelector('.ember-winbtn.max')
      if (btn) btn.innerHTML = maximized ? '&#xE923;' : '&#xE922;'
      document.body.classList.toggle('is-maximized', maximized)
    })

    return wrap
  }
}
