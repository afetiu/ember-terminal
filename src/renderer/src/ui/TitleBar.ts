/**
 * Slim draggable strip across the top: brand mark on the left, caption buttons on
 * the right. The window is frameless (`titleBarStyle: 'hidden'`), so these are ours
 * to draw — but the OS frame is still present, which is what keeps Snap Layouts,
 * rounded corners and the acrylic backdrop working.
 */
import logoUrl from '../assets/logo.png'

export interface VoiceToggles {
  /** Move between the dark and the light theme of the pair. */
  onMode: () => void
}

/** Lucide-style line icons, drawn in the text colour. */
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const MOON = svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>')
const SUN = svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>')

export class TitleBar {
  readonly el: HTMLElement
  private readonly voice: HTMLElement
  private readonly modeBtn: HTMLButtonElement

  constructor(
    private readonly onToggleSidebar: () => void,
    toggles: VoiceToggles
  ) {
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

    // The window's own controls only: the side panel and its Visualize button are gone —
    // every tab is a Loom canvas, which shows what the session shows, inline.
    this.voice = document.createElement('div')
    this.voice.className = 'ember-voicetoggles'

    // Night and Day: one press between the dark theme and the light one.
    this.modeBtn = this.makeToggle('mode', 'Switch to Day  (ember mode)', MOON, toggles.onMode)

    this.voice.append(this.modeBtn)

    this.el.append(brand, drag, this.voice, this.buildWindowControls())
  }

  private makeToggle(cls: string, label: string, glyph: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = `ember-voicetoggle is-${cls}`
    b.title = label
    b.setAttribute('aria-label', label)
    b.setAttribute('aria-pressed', 'false')
    b.innerHTML = glyph
    b.addEventListener('click', fn)
    return b
  }

  setMode(light: boolean): void {
    const icon = light ? SUN : MOON
    if (this.modeBtn.dataset['icon'] !== (light ? 'sun' : 'moon')) {
      this.modeBtn.innerHTML = icon
      this.modeBtn.dataset['icon'] = light ? 'sun' : 'moon'
    }
    const label = light ? 'Switch to Night  (ember mode)' : 'Switch to Day  (ember mode)'
    this.modeBtn.title = label
    this.modeBtn.setAttribute('aria-label', label)
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
