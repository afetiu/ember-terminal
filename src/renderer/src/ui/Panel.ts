import { Spring } from '../motion/spring'
import { PICK_RUNTIME, PICK_STYLE } from './panelPick'
import type { PanelPush } from '@shared/types'

/**
 * The bit of `<webview>` this file uses.
 *
 * Declared here rather than pulled from Electron's types on purpose: the renderer
 * builds against the DOM alone, which is what keeps it honest about talking to main
 * only through the preload bridge. One structural type is a cheaper price than making
 * the whole renderer aware of Electron.
 */
interface WebviewEl extends HTMLElement {
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
}

/** What the guest hands back when the user clicks something in pick mode. */
interface Pick {
  name?: string
  text?: string
  rect?: { x: number; y: number; w: number; h: number }
  cancelled?: boolean
}

export interface PanelHooks {
  /** The panel's width changed and the tab needs relaying out. */
  onLayout: () => void
  /** Something on the panel wants to say this to the session in the same tab. */
  onSend: (text: string, submit: boolean) => void
  /**
   * The user is dragging the panel's edge. `fraction` is the share of the tab the panel
   * should now take; `done` is true on release, which is when it is worth persisting.
   */
  onResize: (fraction: number, done: boolean) => void
}

/** How often the guest is asked whether the user has clicked yet, while picking. */
const PICK_POLL_MS = 110

/**
 * The visualisation panel: the right half of a v2 tab.
 *
 * It is one webview per tab, reused for every push, rather than one per panel. A panel
 * is usually a page you glance at and replace, and standing up a fresh guest process
 * each time costs about a quarter second of blank white before the first paint — which
 * is the whole impression the panel makes.
 *
 * Width is a spring on the group's flex layout rather than a CSS transition. It shares
 * the ticker with everything else that moves here, so opening the panel carries the same
 * weight as switching a tab, and a push that arrives mid-collapse reverses smoothly
 * instead of queueing behind an animation that has to finish first.
 *
 * It reads in both directions. Content comes in from the session over the bridge;
 * presses and picks go back out the same way, which is what makes the panel somewhere
 * to work rather than somewhere to look.
 */
export class Panel {
  readonly el: HTMLElement
  private readonly frame: WebviewEl
  private readonly titleEl: HTMLElement
  private readonly address: HTMLInputElement
  private readonly chrome: HTMLElement
  private readonly empty: HTMLElement
  private readonly pickBtn: HTMLElement
  private readonly pop: HTMLElement
  private readonly popWhat: HTMLElement
  private readonly popQuote: HTMLElement
  private readonly popBox: HTMLTextAreaElement

  /** 0 collapsed, 1 open. Never a boolean — everything here reads the spring. */
  readonly width = new Spring(0, { stiffness: 420, damping: 1.0, epsilon: 0.0015 })
  private open = false

  /** What is on the panel. One thing: the latest push supersedes whatever was there. */
  private current: PanelPush | null = null
  private origin = ''
  /** The in-flight ask for the origin, so a burst of pushes makes one round trip. */
  private originAsked: Promise<string> | null = null
  private booted = false

  private picking = false
  private pickTimer: number | null = null
  private selection: Pick | null = null

  constructor(
    readonly tabId: string,
    private readonly hooks: PanelHooks
  ) {
    this.el = document.createElement('aside')
    this.el.className = 'ember-panel'
    this.el.dataset['tabId'] = tabId

    this.chrome = document.createElement('header')
    this.chrome.className = 'ember-panel-bar'

    this.titleEl = document.createElement('div')
    this.titleEl.className = 'ember-panel-title'

    this.address = document.createElement('input')
    this.address.className = 'ember-panel-address'
    this.address.spellcheck = false
    this.address.placeholder = 'Address'
    this.address.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const url = this.address.value.trim()
      if (url) this.browse(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    })

    this.pickBtn = this.button('pick', '◎', 'Point at something and ask about it  (Ctrl+Shift+E)', () =>
      this.togglePicking()
    )

    this.chrome.append(
      this.button('back', '‹', 'Back', () => this.attached && this.frame.canGoBack() && this.frame.goBack()),
      this.button('fwd', '›', 'Forward', () => this.attached && this.frame.canGoForward() && this.frame.goForward()),
      this.button('reload', '⟳', 'Reload', () => this.attached && this.frame.reload()),
      this.titleEl,
      this.address,
      this.pickBtn,
      this.button('close', '✕', 'Collapse', () => this.collapse())
    )

    this.empty = document.createElement('div')
    this.empty.className = 'ember-panel-empty'
    this.empty.textContent = 'Nothing here yet.'

    this.frame = document.createElement('webview') as WebviewEl
    this.frame.className = 'ember-panel-frame'
    // Attributes rather than properties: the webview element reads them at attach
    // time, and setting them afterwards is too late — so `src` is set right before the
    // first attach (see navigate), never here.
    this.frame.setAttribute('allowpopups', 'false')

    this.frame.addEventListener('did-navigate', () => this.syncChrome())
    this.frame.addEventListener('did-navigate-in-page', () => this.syncChrome())
    this.frame.addEventListener('page-title-updated', (e: Event) => {
      if (this.isBrowsing) this.titleEl.textContent = (e as unknown as { title: string }).title
    })
    // A navigation throws the injected picker away with the old document, so it goes
    // back in if the mode is still armed. Otherwise arming it, following a link, and
    // clicking would do nothing and look broken.
    this.frame.addEventListener('did-finish-load', () => {
      if (this.picking) void this.injectPicker()
    })

    this.pop = document.createElement('div')
    this.pop.className = 'ember-pick-pop'
    this.popWhat = document.createElement('div')
    this.popWhat.className = 'ember-pick-what'
    this.popQuote = document.createElement('div')
    this.popQuote.className = 'ember-pick-quote'
    this.popBox = document.createElement('textarea')
    this.popBox.className = 'ember-pick-box'
    this.popBox.rows = 2
    this.popBox.spellcheck = false
    this.popBox.placeholder = 'Ask about this…'
    this.buildPopover()

    // The webview is not in the document until the first push or navigation: an
    // attached <webview> is a renderer process (~90 MB) per tab, panel open or not.
    this.el.append(this.chrome, this.empty, this.pop, this.grip())
    // Warm, not awaited: the answer is wanted before the first push, but a panel built
    // *by* that push cannot wait for it here — see whereDocsLive.
    void this.whereDocsLive()
  }

  /**
   * The panel's left edge, as something you can take hold of.
   *
   * It is invisible until the pointer is over it, so the seam between terminal and
   * panel stays a seam rather than a bar. Dragging it sets the same `panel.width`
   * setting the Settings slider does, so the change survives a restart and applies to
   * every tab, which is what a split you have chosen by hand should do.
   *
   * The pointer spends the drag over the webview, which is another process and would
   * take the events for itself; pointer capture on the grip keeps them here, and the
   * `is-resizing` class turns the frame's pointer events off for the duration as belt
   * and braces.
   */
  private grip(): HTMLElement {
    const g = document.createElement('div')
    g.className = 'ember-panel-grip'
    g.title = 'Drag to resize the panel'
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.open) return
      e.preventDefault()
      g.setPointerCapture(e.pointerId)
      g.classList.add('is-dragging')
      this.el.classList.add('is-resizing')
      document.body.classList.add('is-resizing')
      this.closePopover()

      // The tab the panel sits in. Its right edge, less the panel's own right margin, is
      // where the panel ends; where the pointer is, is where the user wants it to start.
      const stage = this.el.parentElement ?? this.el
      let raf = 0
      let last = -1

      const fractionAt = (clientX: number): number => {
        const r = stage.getBoundingClientRect()
        if (r.width <= 0) return last
        const px = r.right - 8 - clientX
        return Math.min(0.8, Math.max(0.2, px / r.width))
      }

      const move = (ev: PointerEvent) => {
        const f = fractionAt(ev.clientX)
        if (f < 0 || Math.abs(f - last) < 0.001) return
        last = f
        // One layout per frame, however many pointer events arrive between them: every
        // application is a cross-process resize of the webview.
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          this.hooks.onResize(last, false)
        })
      }

      const up = (ev: PointerEvent) => {
        g.releasePointerCapture(ev.pointerId)
        g.classList.remove('is-dragging')
        this.el.classList.remove('is-resizing')
        document.body.classList.remove('is-resizing')
        g.removeEventListener('pointermove', move)
        g.removeEventListener('pointerup', up)
        g.removeEventListener('pointercancel', up)
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        const f = fractionAt(ev.clientX)
        if (f >= 0) this.hooks.onResize(f, true)
      }

      g.addEventListener('pointermove', move)
      g.addEventListener('pointerup', up)
      g.addEventListener('pointercancel', up)
    })
    return g
  }

  /**
   * Where the bridge serves panel documents from.
   *
   * Asked for once and remembered, but the asking crosses to main and back, and a panel
   * is very often built by the very push it is about to show — the tab's panel is created
   * lazily, so the first visualisation of a session constructs it and pushes into it in
   * the same breath. That first push used to navigate to `/doc/<id>` with no origin in
   * front of it, which is not an http url, so the navigation was dropped and the panel
   * opened blank; the next push, by which time the answer had arrived, worked. That was
   * the "blank the first time" bug, and awaiting this is the fix.
   *
   * An empty answer means the bridge had no port yet, so it is not cached: the next push
   * asks again rather than the panel being blank for the life of the tab.
   */
  private whereDocsLive(): Promise<string> {
    if (this.origin) return Promise.resolve(this.origin)
    if (!this.originAsked) {
      this.originAsked = window.ember.panel
        .origin()
        .then((o) => {
          this.origin = o
          if (!o) this.originAsked = null
          return o
        })
        .catch(() => {
          this.originAsked = null
          return ''
        })
    }
    return this.originAsked
  }

  private button(name: string, glyph: string, title: string, run: () => void): HTMLElement {
    const b = document.createElement('button')
    b.className = `ember-panel-btn is-${name}`
    b.textContent = glyph
    b.title = title
    b.tabIndex = -1
    b.addEventListener('click', (e) => {
      e.preventDefault()
      run()
    })
    return b
  }

  private get isBrowsing(): boolean {
    return this.current?.format === 'url'
  }

  /**
   * Show a pushed panel, opening the surface if it is closed.
   *
   * There used to be a stack here, with ↑/↓ in the bar to walk it. Nobody could tell
   * what the arrows did, because a panel is something you glance at and replace, not a
   * history you page through; the latest push is the panel.
   */
  push(push: PanelPush, autoOpen: boolean): void {
    this.current = push
    this.show()
    if (autoOpen && !this.open) this.expand()
  }

  private show(): void {
    const push = this.current
    if (!push) return
    // Whatever was being pointed at belonged to the document being replaced.
    this.closePopover()
    this.empty.style.display = 'none'
    this.titleEl.textContent = push.title
    this.el.classList.toggle('is-browsing', push.format === 'url')

    if (push.format === 'url') {
      this.browse(push.content)
      return
    }
    // Every non-url panel is a document the bridge already holds; the webview fetches
    // it by id rather than being handed a blob, so the content never crosses into this
    // process at all.
    void this.showDoc(push)
  }

  /**
   * Point the webview at a pushed document.
   *
   * Async only because the origin may not have arrived yet. `current` is re-checked after
   * the wait: a push that landed in the meantime owns the panel, and this one is stale.
   */
  private async showDoc(push: PanelPush): Promise<void> {
    const origin = await this.whereDocsLive()
    if (this.current !== push) return
    if (!origin) {
      // Nothing to load from. Say so rather than showing the blank that used to be here.
      this.empty.textContent = 'The panel bridge is not listening yet.'
      this.empty.style.display = ''
      return
    }
    // The page is drawn in main, which cannot see the theme, so it is told which way it faces.
    const tone = document.body.classList.contains('is-light') ? '?tone=light' : ''
    this.navigate(`${origin}/doc/${push.id}${tone}`)
  }

  /** Redraw the document for a theme that turned from light to dark, or back, under it. */
  retone(): void {
    if (this.current && this.current.format !== 'url') void this.showDoc(this.current)
  }

  private browse(url: string): void {
    this.el.classList.add('is-browsing')
    this.address.value = url
    this.navigate(url)
  }

  /** Put the webview in the document (and so spawn its process) the first time it is needed. */
  private attach(): void {
    if (this.attached) return
    this.attached = true
    this.el.insertBefore(this.frame, this.pop)
  }
  private attached = false

  private navigate(url: string): void {
    if (!url.startsWith('http')) return
    this.booted = true
    this.frame.setAttribute('src', url)
    this.attach()
  }

  private syncChrome(): void {
    if (!this.booted || !this.attached) return
    const url = this.frame.getURL()
    if (this.isBrowsing && url && !url.startsWith('about:')) this.address.value = url
    this.chrome.classList.toggle('can-back', this.frame.canGoBack())
    this.chrome.classList.toggle('can-fwd', this.frame.canGoForward())
  }

  // ---------- picking ----------

  /**
   * Arm or disarm "point at something and talk about it".
   *
   * A mode rather than a modifier chord. The pointer is inside a guest process while
   * you are over the panel, so a held key would have to be observed in two places and
   * kept in sync across the boundary; a button whose state Ember owns cannot drift.
   */
  togglePicking(): void {
    if (this.picking) this.stopPicking()
    else void this.startPicking()
  }

  private async startPicking(): Promise<void> {
    if (!this.hasContent) return
    if (!this.open) this.expand()
    this.picking = true
    this.el.classList.add('is-picking')
    this.pickBtn.classList.add('is-on')
    this.closePopover()
    await this.injectPicker()
    if (this.pickTimer === null) this.pickTimer = window.setInterval(() => void this.poll(), PICK_POLL_MS)
  }

  private stopPicking(): void {
    this.picking = false
    this.el.classList.remove('is-picking')
    this.pickBtn.classList.remove('is-on')
    if (this.pickTimer !== null) {
      window.clearInterval(this.pickTimer)
      this.pickTimer = null
    }
    if (this.attached) void this.frame.executeJavaScript('window.__emberPick && window.__emberPick.off()').catch(() => {})
  }

  private async injectPicker(): Promise<void> {
    try {
      await this.frame.executeJavaScript(PICK_STYLE)
      await this.frame.executeJavaScript(PICK_RUNTIME)
    } catch {
      // A guest that will not take script is one we cannot pick in — an error page,
      // or a site with a policy against it. The mode simply does nothing there.
      this.stopPicking()
    }
  }

  private async poll(): Promise<void> {
    if (!this.picking) return
    let pick: Pick | null = null
    try {
      pick = (await this.frame.executeJavaScript('window.__emberPick && window.__emberPick.take()')) as Pick | null
    } catch {
      return
    }
    if (!pick) return

    // The guest disarms itself the moment something is clicked, so the mode ends here
    // whether the click was a pick or an Escape.
    this.stopPicking()
    if (pick.cancelled || !pick.text) return
    this.selection = pick
    this.openPopover(pick)
  }

  // ---------- the popover ----------

  private buildPopover(): void {
    const bar = document.createElement('div')
    bar.className = 'ember-pick-bar'
    const close = document.createElement('button')
    close.className = 'ember-pick-x'
    close.textContent = '✕'
    close.tabIndex = -1
    close.addEventListener('click', () => this.closePopover())
    bar.append(this.popWhat, close)

    // The three things anyone actually says about a thing they just pointed at. They
    // send immediately — having to press the chip and then press Send would make them
    // slower than typing the sentence.
    const quick = document.createElement('div')
    quick.className = 'ember-pick-quick'
    for (const [label, prompt] of [
      ['Explain', 'Explain this.'],
      ['Change', 'Change this — walk me through what that would take.'],
      ['Where from?', 'Where does this come from in the code?'],
    ] as const) {
      const b = document.createElement('button')
      b.className = 'ember-pick-chip'
      b.textContent = label
      b.tabIndex = -1
      b.addEventListener('click', () => this.sendSelection(prompt))
      quick.append(b)
    }

    this.popBox.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closePopover()
        return
      }
      if (e.key !== 'Enter' || e.shiftKey) return
      e.preventDefault()
      this.sendSelection(this.popBox.value)
    })

    const send = document.createElement('button')
    send.className = 'ember-pick-send'
    send.textContent = 'Send'
    send.addEventListener('click', () => this.sendSelection(this.popBox.value))

    const row = document.createElement('div')
    row.className = 'ember-pick-row'
    row.append(this.popBox, send)

    this.pop.append(bar, this.popQuote, quick, row)
  }

  private openPopover(pick: Pick): void {
    this.popWhat.textContent = pick.name ?? 'selection'
    this.popQuote.textContent = pick.text ?? ''
    this.popBox.value = ''
    this.el.classList.add('has-pick')
    this.placePopover(pick.rect)
    this.popBox.focus()
  }

  /**
   * Sit the popover under what was clicked, and inside the panel.
   *
   * The rect arrives in the guest's viewport coordinates, so it is offset by where the
   * webview sits in the panel. Clamping matters more than the anchor does: a popover
   * half off the edge of a narrow panel is worse than one a few pixels from the thing
   * it belongs to.
   */
  private placePopover(rect: Pick['rect']): void {
    const host = this.el.getBoundingClientRect()
    const view = this.attached ? this.frame.getBoundingClientRect() : host
    const dx = view.left - host.left
    const dy = view.top - host.top

    const width = Math.min(340, Math.max(220, host.width - 24))
    this.pop.style.width = `${width}px`

    const wantedX = dx + (rect?.x ?? 0)
    const wantedY = dy + (rect?.y ?? 0) + (rect?.h ?? 0) + 8
    const left = Math.max(8, Math.min(host.width - width - 8, wantedX))

    // Measured after the width is set, because the quote wraps and the height is not
    // knowable before it does.
    const height = this.pop.offsetHeight || 190
    const flip = wantedY + height > host.height - 8
    const top = flip
      ? Math.max(8, dy + (rect?.y ?? 0) - height - 8)
      : Math.min(host.height - height - 8, wantedY)

    this.pop.style.left = `${Math.round(left)}px`
    this.pop.style.top = `${Math.round(Math.max(8, top))}px`
  }

  private closePopover(): void {
    this.el.classList.remove('has-pick')
    this.selection = null
  }

  /**
   * Send what was picked plus what was said about it, as one line.
   *
   * The two are joined here rather than left to the model to correlate, because by the
   * time the message arrives the panel may already be showing something else — the
   * quoted text is the only durable record of what "this" meant.
   */
  private sendSelection(prompt: string): void {
    const text = prompt.trim()
    const pick = this.selection
    if (!text || !pick) return
    const quoted = (pick.text ?? '').replace(/\s+/g, ' ').trim()
    this.hooks.onSend(`On the panel, ${pick.name ?? 'this'} — "${quoted}": ${text}`, true)
    this.closePopover()
  }

  // ---------- open / close ----------

  expand(): void {
    if (this.open) return
    this.open = true
    this.el.classList.add('is-open')
    this.width.to(1)
    this.hooks.onLayout()
  }

  collapse(): void {
    if (!this.open) return
    this.open = false
    if (this.picking) this.stopPicking()
    this.closePopover()
    this.el.classList.remove('is-open')
    this.width.to(0)
    this.hooks.onLayout()
  }

  toggle(): void {
    if (this.open) this.collapse()
    else this.expand()
  }

  get isOpen(): boolean {
    return this.open
  }

  get hasContent(): boolean {
    return this.current !== null
  }

  get isPicking(): boolean {
    return this.picking
  }

  clear(): void {
    this.current = null
    if (this.picking) this.stopPicking()
    this.closePopover()
    this.empty.textContent = 'Nothing here yet.'
    this.empty.style.display = ''
    this.titleEl.textContent = ''
    this.address.value = ''
    this.el.classList.remove('is-browsing')
    if (this.attached) this.frame.setAttribute('src', 'about:blank')
    this.collapse()
  }

  /** Driven from the app's motion loop. Returns true while the spring is still moving. */
  step_(dt: number): boolean {
    if (this.width.settled) return false
    this.width.step(dt)
    return true
  }

  focus(): void {
    if (this.attached) this.frame.focus()
  }

  dispose(): void {
    if (this.pickTimer !== null) window.clearInterval(this.pickTimer)
    this.el.remove()
  }
}
