/**
 * Slim draggable strip across the top: brand mark on the left, caption buttons on
 * the right. The window is frameless (`titleBarStyle: 'hidden'`), so these are ours
 * to draw — but the OS frame is still present, which is what keeps Snap Layouts,
 * rounded corners and the acrylic backdrop working.
 */
import logoUrl from '../assets/logo.png'

export interface VoiceToggles {
  /** Show or hide the visualisation panel on the tab you are looking at. */
  onPanel: () => void
  /** Ask the Claude session in this tab to put what it is on about onto the panel. */
  onVisualize: () => void
}

export class TitleBar {
  readonly el: HTMLElement
  private readonly voice: HTMLElement
  private readonly panelBtn: HTMLButtonElement
  private readonly visualizeBtn: HTMLButtonElement

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
    toggle.innerHTML = '&#xE700;'
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

    // Up here rather than over the terminal: anything floating on the grid ends up on
    // top of whatever the CLI is drawing, which is exactly what the orb did before it
    // was taken out. (The orchestrator's own button used to sit here too; it moved to
    // the sidebar, next to the sessions it runs and on the edge its column opens from.)
    this.voice = document.createElement('div')
    this.voice.className = 'ember-voicetoggles'

    // The panel switch sits up here rather than inside the panel, because the one state
    // it has to be reachable from is the one where the panel is a zero-width strip with
    // nothing on it to press. In a flex wrapper, not directly in the bar: the title bar
    // stretches its children, so a fixed-height button parked in it aligns to the top.
    this.panelBtn = this.makeToggle(
      'panel',
      'Show or hide the panel  (Ctrl+Shift+J)',
      '&#xE90D;',
      toggles.onPanel
    )
    this.panelBtn.classList.add('ember-paneltoggle')

    // "Visualize": one press types `/visualize` into the tab's Claude session, which puts
    // whatever is being discussed onto the panel. Shown only while a Claude is running in
    // the focused pane; a shell has nothing to visualise.
    this.visualizeBtn = document.createElement('button')
    this.visualizeBtn.className = 'ember-visualize is-hidden'
    this.visualizeBtn.title = 'Ask Claude to put this on the panel  (ember visualize)'
    this.visualizeBtn.setAttribute('aria-label', 'Visualize this')
    this.visualizeBtn.innerHTML = '<span class="ember-visualize-mark">&#xE9D2;</span><span>Visualize</span>'
    this.visualizeBtn.addEventListener('click', toggles.onVisualize)

    this.voice.append(this.visualizeBtn, this.panelBtn)

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

  /**
   * The panel switch.
   *
   * `unseen` is the case that earns the button its place: a background session pushed
   * something while the panel was closed, and without a mark here the only evidence
   * would be a strip of nothing at the edge of the window.
   */
  /** The Visualize button exists only while a Claude session has the focused pane. */
  setVisualize(available: boolean): void {
    this.visualizeBtn.classList.toggle('is-hidden', !available)
  }

  setPanel(state: { available: boolean; open: boolean; unseen: boolean }): void {
    this.panelBtn.classList.toggle('is-hidden', !state.available)
    this.panelBtn.classList.toggle('is-on', state.open)
    this.panelBtn.classList.toggle('has-unseen', state.unseen)
    this.panelBtn.setAttribute('aria-pressed', String(state.open))
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
