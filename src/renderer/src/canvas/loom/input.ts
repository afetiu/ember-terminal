import { escapeHtml, renderMarkdown } from '../markdown'
import type { LoomView } from '../LoomView'
import { ICON, SNAPS_PER_EDGE, div, type Piece, type Side } from './shared'
import { isQuestion } from './question'

/**
 * The pointer and the keyboard on the canvas. Clicks (buttons in replies, links, copy,
 * pictures), the right-click menu on anything Claude made — ask about it, have it changed,
 * place it, take it off — the "? ask" chip on a selection and its ask box, the picture
 * lightbox, the canvas's keys, and moving between objects from the keyboard (Ctrl+↑).
 */
export class CanvasInput {
  readonly pop = div('loom-pop')
  readonly ctxMenu = div('loom-menu')
  readonly chip = div('loom-chip', '? ask')
  readonly lightbox = div('loom-lightbox')

  // ================================================================ the canvas from the keyboard

  /** The object the keyboard is on, or null when the keys go to the input. */
  kbd: Piece | null = null
  /** An object still inline in the reply that the keyboard is on (lifted out when acted on). */
  kbdInline: HTMLElement | null = null
  private readonly kbdLegend = div('loom-kbd-legend')

  constructor(private readonly v: LoomView) {}

  // ================================================================ keys and pointer

  key(e: KeyboardEvent): void {
    const v = this.v
    if (v.disposed || !v.hooks.isActive()) return
    if (this.kbd || this.kbdInline) {
      this.kbdKey(e)
      return
    }
    const inTerm = !!(e.target as HTMLElement | null)?.closest?.('.xterm')
    // Ctrl+` in the terminal or on the canvas: the CLI takes the whole tab, or gives it back.
    if (e.ctrlKey && !e.altKey && e.code === 'Backquote') {
      if (v.mode === 'claude' || v.mode === 'raw') {
        e.preventDefault()
        e.stopPropagation()
        v.setRaw(!v.raw)
      }
      return
    }
    // Ctrl+↑ from the prompt: into the canvas, onto the newest object.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'ArrowUp' && v.mode === 'claude') {
      e.preventDefault()
      e.stopPropagation()
      const list = this.kbdList()
      if (list.length) this.kbdSelect(list[list.length - 1]!)
      else v.hooks.toast('Nothing on this turn to select yet')
      return
    }
    const tgt = e.target as HTMLElement | null
    const inLoomInput =
      tgt?.closest?.('.loom-pop, .loom-note-edit, .loom-picker, .loom-menu, .loom-drawer, .loom-answers') != null ||
      (!!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) && !tgt.closest('.xterm'))
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyN' && (v.mode === 'claude' || v.mode === 'shell')) {
      e.preventDefault()
      e.stopPropagation()
      if (v.mode === 'claude') void v.notebook.newSticky()
      else if (v.hooks.openPlace) v.hooks.openPlace('notes')
      else v.notebook.toggleDrawer('notes')
      return
    }
    if (v.mode === 'claude' && e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      v.stage.stepTurn(e.key === 'ArrowUp' ? -1 : 1)
      return
    }
    // Every other key typed in the agent's terminal is the agent's: Esc, PageUp, Ctrl+C.
    if (inTerm) return
    // Ctrl+C with text selected on the canvas copies it — it does not reach Claude Code as
    // an interrupt.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') {
      const sel = window.getSelection()
      const text = (sel?.toString() ?? '').trim()
      if (text && sel?.anchorNode && (v.el.contains(sel.anchorNode) || v.objects.modal.contains(sel.anchorNode))) {
        e.preventDefault()
        e.stopPropagation()
        void navigator.clipboard.writeText(sel.toString())
        v.hooks.toast('Copied')
        return
      }
    }
    if (v.mode !== 'claude') return
    if (inLoomInput && e.key !== 'Escape') return
    if (e.key === 'Escape') {
      // On the canvas, Esc closes what is open there, or else gives the keyboard back to the
      // agent's prompt. It never reaches the agent as its interrupt from here.
      if (this.closeOverlays()) {
        e.preventDefault()
        e.stopPropagation()
      } else if (tgt === document.body || (tgt && v.el.contains(tgt))) v.session.focus()
      return
    }

    if (inLoomInput) return
    if ((e.key === 'PageUp' || e.key === 'PageDown') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      v.scroller.scrollBy({ top: (e.key === 'PageUp' ? -1 : 1) * v.scroller.clientHeight * 0.85, behavior: 'smooth' })
      return
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Home') v.scroller.scrollTo({ top: 0, behavior: 'smooth' })
      else v.toBottom(true)
      return
    }
    // Typing anywhere on the canvas types into the prompt.
    const target = e.target as HTMLElement | null
    if (target && (target === document.body || v.el.contains(target)) && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      v.session.focus()
    }
  }

  private closeOverlays(): boolean {
    const v = this.v
    if (v.notebook.drawer.classList.contains('is-on')) {
      v.notebook.closeDrawer()
      return true
    }
    if (v.objects.full) {
      v.objects.fullscreen(v.objects.full.piece, false)
      return true
    }
    if (this.ctxMenu.classList.contains('is-on')) {
      this.closeMenu()
      return true
    }
    if (this.lightbox.classList.contains('is-on')) {
      this.lightbox.classList.remove('is-on')
      return true
    }
    if (this.pop.classList.contains('is-on')) {
      this.closeAsk()
      return true
    }
    if (v.objects.expanded) {
      v.objects.expand(v.objects.expanded, false)
      return true
    }
    return false
  }

  click(e: MouseEvent): void {
    const v = this.v
    const t = e.target as HTMLElement
    // The click that opened the menu (⋯) reaches here too; it must not close it again.
    if (!t.closest('.loom-menu, [data-p="more"]')) this.closeMenu()
    // A picture from another server, held back until asked for (markdown.ts, remoteImage).
    // This click is the asking: only now does anything request it.
    const remote = t.closest<HTMLElement>('.loom-img-remote')
    if (remote) {
      e.preventDefault()
      e.stopPropagation()
      const img = document.createElement('img')
      img.className = 'loom-img'
      img.alt = remote.dataset['alt'] ?? ''
      img.dataset['zoom'] = '1'
      img.src = remote.dataset['src'] ?? ''
      remote.replaceWith(img)
      return
    }
    const act = t.closest<HTMLElement>('.loom-act')
    if (act) {
      e.preventDefault()
      v.type(act.dataset['send'] ?? act.textContent ?? '', act.dataset['submit'] !== '0')
      act.classList.add('is-pressed')
      return
    }
    const link = t.closest<HTMLAnchorElement>('a.loom-link')
    if (link) {
      e.preventDefault()
      const href = link.getAttribute('href') ?? ''
      // A local server is something to look at here; anything else is the browser's.
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(href) && !e.ctrlKey) void v.board.openBrowser(href, href, 'open_url')
      else window.open(href, '_blank')
      return
    }
    const copy = t.closest<HTMLElement>('.loom-copy')
    if (copy) {
      const code = copy.closest('.loom-code')?.querySelector('code')?.textContent ?? ''
      void navigator.clipboard.writeText(code).then(() => {
        copy.textContent = 'copied'
        window.setTimeout(() => (copy.textContent = 'copy'), 1200)
      })
      return
    }
    const img = t.closest<HTMLImageElement>('img[data-zoom]')
    if (img && img.src) {
      this.zoom(img.src, img.alt)
      return
    }
    // A click that selected nothing hands the keyboard back to the prompt.
    const interactive = t.closest('button, a, input, textarea, iframe, webview, video, audio, summary, .loom-pop, .loom-steps, .loom-answers')
    if (!interactive && !(window.getSelection()?.toString() ?? '').trim()) v.session.focus()
  }

  /** Right-click anything with a picture, a diagram or a piece in it: ask about that. */
  context(e: MouseEvent): void {
    const t = e.target as HTMLElement
    const host = t.closest<HTMLElement>('.loom-piece, .loom-liftable, [data-ask-label], .loom-figure, .loom-code, .loom-table, .loom-tool, .loom-say')
    if (!host) return
    e.preventDefault()
    const label =
      host.dataset['askLabel'] ??
      (host.classList.contains('loom-piece')
        ? `the "${host.dataset['title'] ?? 'piece'}"`
        : host.classList.contains('loom-code')
          ? 'this code'
          : host.classList.contains('loom-table')
            ? 'this table'
            : host.classList.contains('loom-tool')
              ? `this step (${(host.querySelector('.loom-tool-name')?.textContent ?? '').trim()} ${(host.querySelector('.loom-tool-arg')?.textContent ?? '').trim()})`
              : 'this')
    const quote = host.classList.contains('loom-code') || host.classList.contains('loom-table') ? (host.innerText ?? '').slice(0, 500) : undefined
    const sel = (window.getSelection()?.toString() ?? '').trim()
    this.menu(new DOMRect(e.clientX, e.clientY, 0, 0), host, sel || quote, undefined, label)
  }

  /** The object a host element is, as the session knows it: a title and a kind. */
  private objectOf(host: HTMLElement): { label: string; piece: Piece | null; title: string } {
    const v = this.v
    const piece = [...v.pieces.values(), ...v.pinned].find((p) => p.el === host) ?? null
    if (piece) {
      const kind = piece.format === 'mermaid' ? 'diagram' : piece.format === 'url' ? 'page' : piece.format === 'html' ? 'page' : piece.format
      return { label: `the "${piece.title}" ${kind}`, piece, title: piece.title }
    }
    if (host.classList.contains('loom-liftable')) {
      const title = v.objects.nameObject(host)
      const kind = v.objects.kindOf(host)
      return { label: `the "${title}" ${kind === 'mermaid' ? 'diagram' : kind}`, piece: null, title }
    }
    return { label: host.dataset['askLabel'] ?? 'this', piece: null, title: '' }
  }

  /**
   * The context menu on anything Claude made: ask about it, have it changed, place it on
   * the screen or take it off. Right-click anywhere on it, inside a diagram or page too.
   */
  menu(at: DOMRect, host: HTMLElement, quote?: string, part?: string, fallback?: string): void {
    const v = this.v
    const objects = v.objects
    const obj = this.objectOf(host)
    const label = obj.title ? obj.label : (fallback ?? obj.label)
    const about = part ? `${label}, the part "${part}"` : label
    const pinned = !!obj.piece && v.pinned.has(obj.piece)
    const canPlace = !pinned && (!!obj.piece || host.classList.contains('loom-liftable'))
    // The actions, as a grid of tiles under the question box.
    const tiles: Array<[string, string, string, () => void]> = []
    if ((quote ?? '').trim()) tiles.unshift(['copy', ICON.note, 'Copy', () => void navigator.clipboard.writeText(quote ?? '').then(() => v.hooks.toast('Copied'))])
    if (obj.piece) tiles.push(['full', ICON.expand, 'Full screen', () => objects.fullscreen(obj.piece!, true)])
    if (canPlace)
      tiles.push(['place', ICON.pin, 'Place', () => {
        const p = obj.piece ?? objects.liftObject(host)
        if (!p) return
        objects.pin(p)
        objects.settlePin(p)
      }])
    if (obj.piece) {
      const min = obj.piece.el.classList.contains('is-min')
      tiles.push(['min', min ? ICON.restore : ICON.fold, min ? 'Restore' : 'Minimize', () => objects.minimize(obj.piece!)])
    }
    for (const [id, text, run] of obj.piece?.extra ?? []) tiles.push([id, id === 'reload' ? ICON.reload : ICON.out, text.replace('Open in your browser', 'Open outside'), run])
    // Only a real note (a file in the notes folder) can be edited here; any other .md is shown, not edited.
    const notesDir = v.notebook.notesDir
    if (obj.piece?.file && notesDir && obj.piece.file.toLowerCase().startsWith(notesDir.toLowerCase()) && /\.md$/i.test(obj.piece.file) && !/todo\.md$/i.test(obj.piece.file))
      tiles.push(['edit', ICON.edit, 'Edit note', () => void v.notebook.editNote(obj.piece!)])
    const words = (quote ?? '').trim() || (obj.title ? obj.title : '')
    void words
    const keep = (quote ?? '').trim() || obj.piece?.source || (host.classList.contains('loom-say') ? host.innerText : '')
    if (keep) tiles.push(['note', ICON.note, host.classList.contains('loom-say') && !quote ? 'Save answer' : 'Save note', () => void v.notebook.saveToNote(keep, obj.title)])
    if (pinned && obj.piece) tiles.push(['remove', ICON.close, 'Remove', () => objects.unpin(obj.piece!)])

    this.ctxMenu.innerHTML =
      `<div class="loom-menu-head">${escapeHtml(part ? `${obj.title || label} · ${part}` : obj.title || label)}</div>` +
      `<div class="loom-menu-ask"><textarea rows="1" spellcheck="false" placeholder="${obj.title ? 'Ask about this, or say what to change…' : 'Ask about this…'}"></textarea>` +
      `<div class="loom-menu-hint">${obj.title ? 'A question is answered here · anything else changes it' : 'Answered here, without interrupting the session'}</div></div>` +
      `<div class="loom-menu-answer"></div>` +
      `<div class="loom-menu-grid">${tiles.map(([id, icon, text]) => `<button type="button" data-m="${id}">${icon}<span>${escapeHtml(text)}</span></button>`).join('')}</div>`
    const box = this.ctxMenu.querySelector('textarea')!
    const answer = this.ctxMenu.querySelector<HTMLElement>('.loom-menu-answer')!
    let mode: 'ask' | 'change' = 'ask'
    const _setMode = (m: 'ask' | 'change') => {
      mode = m
      box.placeholder = m === 'change' ? 'What should change? (Enter sends it to the session)' : 'Ask about this…'
      this.ctxMenu.classList.toggle('is-change', m === 'change')
      box.focus()
    }
    void _setMode
    for (const [id, , , run] of tiles) {
      this.ctxMenu.querySelector(`[data-m="${id}"]`)?.addEventListener('click', () => {
        if (id !== 'change') this.closeMenu()
        run()
      })
    }
    box.addEventListener('input', () => {
      box.style.height = 'auto'
      box.style.height = `${Math.min(140, box.scrollHeight)}px`
    })
    box.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeMenu()
        return
      }
      if (e.key !== 'Enter' || e.shiftKey) return
      e.preventDefault()
      const q = box.value.trim()
      if (!q) return
      const quoted = quote ? ` — “${quote.replace(/\s+/g, ' ').slice(0, 600)}”` : ''
      // A question is answered here; anything else is a change, and goes to the session.
      const question = isQuestion(q)
      if (obj.title && !question) mode = 'change'
      if (mode === 'change') {
        v.type(`Change ${about}${quoted}: ${q}. It is on my screen as "${obj.title}" — change it in place (edit_panel, or show_panel with that title); do not make a new one.`, true)
        this.closeMenu()
        return
      }
      // A side question: answered here, in the popup, by a short run of its own.
      box.disabled = true
      answer.classList.add('is-on', 'is-busy')
      answer.innerHTML = `<span class="loom-menu-dots"><i></i><i></i><i></i></span>`
      const source = (quote ?? '').trim() || obj.piece?.source || host.dataset['source'] || (host.innerText ?? '').slice(0, 6000)
      void window.ember.canvas.sideAsk(q, about, source, v.session.cwd || undefined).then((r) => {
        answer.classList.remove('is-busy')
        answer.innerHTML = r.ok && r.text ? renderMarkdown(r.text).html : `<p class="err">${escapeHtml(r.error || 'No answer came back.')}</p>`
        box.disabled = false
        box.value = ''
        box.placeholder = 'Ask a follow-up…'
        box.focus()
      })
    })
    // Over a full-screen object the menu opens above it, in the window's coordinates.
    if (objects.full) {
      if (this.ctxMenu.parentElement !== objects.modal) objects.modal.appendChild(this.ctxMenu)
      this.ctxMenu.classList.add('is-floating')
      this.ctxMenu.style.left = `${Math.min(window.innerWidth - 340, Math.max(8, at.left))}px`
      this.ctxMenu.style.top = `${Math.min(window.innerHeight - 300, Math.max(8, at.top))}px`
    } else {
      if (this.ctxMenu.parentElement !== v.el) v.el.appendChild(this.ctxMenu)
      this.ctxMenu.classList.remove('is-floating')
      const bounds = v.el.getBoundingClientRect()
      this.ctxMenu.style.left = `${Math.min(bounds.width - 340, Math.max(8, at.left - bounds.left))}px`
      this.ctxMenu.style.top = `${Math.min(bounds.height - 260, Math.max(8, at.top - bounds.top))}px`
    }
    this.ctxMenu.classList.remove('is-change')
    this.ctxMenu.classList.add('is-on')
    box.focus()
  }

  closeMenu(): void {
    this.ctxMenu.classList.remove('is-on')
  }

  selection(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.loom-pop, .loom-chip')) return
    window.setTimeout(() => {
      const sel = window.getSelection()
      const text = (sel?.toString() ?? '').trim()
      if (!sel || text.length < 2 || !sel.rangeCount || !this.v.scroller.contains(sel.anchorNode)) {
        this.chip.classList.remove('is-on')
        return
      }
      const r = sel.getRangeAt(0).getBoundingClientRect()
      const host = this.v.el.getBoundingClientRect()
      this.chip.style.left = `${Math.min(host.width - 80, Math.max(8, r.right - host.left - 30))}px`
      this.chip.style.top = `${Math.max(8, r.bottom - host.top + 6)}px`
      this.chip.classList.add('is-on')
    }, 0)
  }

  // ================================================================ ask about this

  ask(at: DOMRect, about: string, quote?: string, mode: 'ask' | 'change' = 'ask', title = ''): void {
    const v = this.v
    const host = v.el.getBoundingClientRect()
    const change = mode === 'change'
    this.pop.innerHTML =
      `<div class="loom-pop-about">${change ? 'Change' : 'Ask about'} ${escapeHtml(about)}</div>` +
      (quote ? `<div class="loom-pop-quote">${escapeHtml(quote.length > 240 ? `${quote.slice(0, 240)}…` : quote)}</div>` : '') +
      `<textarea rows="2" placeholder="${change ? 'What should change?' : 'What do you want to know?'}" spellcheck="false"></textarea>` +
      `<div class="loom-pop-foot"><span><kbd>Enter</kbd> ${change ? 'change it' : 'ask'}</span><span><kbd>Esc</kbd> close</span></div>`
    const box = this.pop.querySelector('textarea')!
    box.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeAsk()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const q = box.value.trim()
        if (!q) return
        const quoted = quote ? ` — “${quote.replace(/\s+/g, ' ').slice(0, 600)}”` : ''
        const context = change
          ? `Change ${about}${quoted}: ${q}. It is on my screen as "${title}" — change it in place (edit_panel, or show_panel with that title); do not make a new one.`
          : `About ${about}${quoted} — ${q}`
        v.type(context, true)
        this.closeAsk()
        v.toBottom(true)
      }
    })
    const w = 360
    this.pop.style.left = `${Math.min(host.width - w - 12, Math.max(12, at.left - host.left))}px`
    this.pop.style.top = `${Math.min(host.height - 170, Math.max(12, at.bottom - host.top + 8))}px`
    this.pop.classList.add('is-on')
    box.focus()
  }

  closeAsk(): void {
    this.pop.classList.remove('is-on')
    this.pop.innerHTML = ''
    this.v.session.focus()
  }

  zoom(src: string, alt: string): void {
    this.lightbox.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><button type="button" class="loom-lightbox-ask">? ask about this</button>`
    this.lightbox.querySelector('.loom-lightbox-ask')?.addEventListener('click', (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      this.lightbox.classList.remove('is-on')
      this.ask(r, `this image${alt ? ` (${alt})` : ''}`)
    })
    this.lightbox.classList.add('is-on')
  }

  // ---------------------------------------------------------------- keyboard navigation

  /**
   * The objects the keyboard can reach, in reading order: objects on the canvas and the
   * diagrams, tables and code inline in the turn on screen.
   */
  private kbdList(): HTMLElement[] {
    const v = this.v
    const pieces = [...v.pieces.values()].map((p) => p.el)
    const shown = v.stage.shown
    const inline = shown ? [...shown.querySelectorAll<HTMLElement>('.loom-liftable')].filter((d) => !d.closest('.loom-piece')) : []
    return [...pieces, ...inline]
      .filter((el) => el.isConnected && el.offsetParent !== null)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return ra.top - rb.top || ra.left - rb.left
      })
  }

  private pieceOf(el: HTMLElement): Piece | null {
    for (const p of this.v.pieces.values()) if (p.el === el) return p
    return null
  }

  /** The object under the keyboard as a canvas object, lifting an inline one out if need be. */
  private kbdPiece(): Piece | null {
    if (this.kbd) return this.kbd
    const d = this.kbdInline
    if (!d) return null
    const piece = this.v.objects.liftObject(d)
    if (piece) this.kbdSelect(piece.el)
    return piece
  }

  private kbdSelect(el: HTMLElement): void {
    const v = this.v
    this.kbd?.el.classList.remove('is-kbd')
    this.kbdInline?.classList.remove('is-kbd')
    const piece = this.pieceOf(el)
    this.kbd = piece
    this.kbdInline = piece ? null : el
    el.classList.add('is-kbd')
    if (piece) v.objects.raise(piece)
    v.reveal(el, 'nearest')
    // Off the terminal, so the keys come here and nothing is typed into the agent.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    v.el.focus({ preventScroll: true })
    this.kbdLegend.innerHTML =
      `<span><b>↑↓</b> choose</span><span><b>Enter</b> full screen</span><span><b>P</b> ${piece && v.pinned.has(piece) ? 'put back' : 'place on screen'}</span>` +
      `<span><b>Shift+arrows</b> snap</span><span><b>Alt+arrows</b> move</span><span><b>Alt+Shift+arrows</b> size</span>` +
      `<span><b>N</b> sticky note</span><span><b>M</b> minimize</span><span><b>Del</b> remove</span><span><b>Space</b> menu</span><span><b>Esc</b> back to typing</span>`
    if (!this.kbdLegend.isConnected) v.el.appendChild(this.kbdLegend)
    this.kbdLegend.classList.add('is-on')
  }

  /** Back to the input: the ring goes, the legend goes, the keys go to the agent again. */
  kbdLeave(): void {
    this.kbd?.el.classList.remove('is-kbd')
    this.kbdInline?.classList.remove('is-kbd')
    this.kbd = null
    this.kbdInline = null
    this.kbdLegend.classList.remove('is-on')
    this.v.session.focus()
  }

  private kbdKey(e: KeyboardEvent): void {
    const v = this.v
    const objects = v.objects
    const cur = this.kbd?.el ?? this.kbdInline
    if (!cur || !cur.isConnected) return this.kbdLeave()
    const stop = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    const list = this.kbdList()
    const at = list.indexOf(cur)
    // Moving between objects needs no canvas object; everything else acts on one.
    const k0 = e.key
    if ((k0 === 'ArrowUp' || k0 === 'ArrowDown' || k0 === 'Tab') && !e.altKey && !e.shiftKey) {
      stop()
      const next = list[(at + (k0 === 'ArrowUp' ? -1 : 1) + list.length) % list.length]
      if (next) this.kbdSelect(next)
      return
    }
    if (k0 === 'Tab' && e.shiftKey) {
      stop()
      const next = list[(at - 1 + list.length) % list.length]
      if (next) this.kbdSelect(next)
      return
    }
    if (k0 === 'Escape' && !this.kbd) {
      stop()
      this.kbdLeave()
      return
    }
    if (k0 === ' ' || k0 === '.') {
      stop()
      this.menu(cur.getBoundingClientRect(), cur)
      return
    }
    if ((k0 === 'n' || k0 === 'N') && !e.ctrlKey && !e.altKey) {
      stop()
      this.kbdLeave()
      void v.notebook.newSticky()
      return
    }
    if (k0.length === 1 && !e.ctrlKey && !e.metaKey && !/^[pPmMnN]$/.test(k0)) {
      this.kbdLeave()
      return
    }
    const acts = ['Escape', 'Enter', 'Delete', 'Backspace', 'p', 'P', 'm', 'M', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    if (!acts.includes(k0)) return
    if (this.kbdInline && (k0 === 'Delete' || k0 === 'Backspace')) {
      // Part of the reply itself: nothing to take away.
      stop()
      return
    }
    const piece = this.kbdPiece()
    if (!piece) return this.kbdLeave()
    const k = e.key
    const arrow = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight'
    if (k === 'Escape') {
      stop()
      if (objects.full?.piece === piece) objects.fullscreen(piece, false)
      else this.kbdLeave()
      return
    }
    if (objects.full?.piece === piece && k !== 'Enter') return
    if (arrow && e.altKey) {
      stop()
      if (!v.pinned.has(piece)) {
        objects.pin(piece, false)
        objects.settlePin(piece)
      }
      const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0
      const dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0
      if (piece.snap) v.snapping.unsnap(piece)
      if (e.shiftKey) {
        const w = Math.max(240, piece.el.offsetWidth + dx * 40)
        const h = Math.max(90, piece.el.offsetHeight + dy * 40)
        piece.el.style.width = `${w}px`
        piece.el.style.height = `${h}px`
        piece.free = { w, h }
      } else objects.place2(piece, piece.el.offsetLeft + dx * 32, piece.el.offsetTop + dy * 32)
      v.snapping.reflow()
      this.kbdSelect(piece.el)
      return
    }
    if (arrow && e.shiftKey) {
      stop()
      const side: Side = k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'top' : 'bottom'
      if (piece.snap !== side && v.snapping.snaps[side].length >= SNAPS_PER_EDGE) {
        v.hooks.toast(`That edge already holds ${SNAPS_PER_EDGE}`)
        return
      }
      if (!v.pinned.has(piece)) objects.pin(piece, false)
      if (piece.snap) v.snapping.unsnap(piece)
      v.snapping.snapTo(piece, side)
      this.kbdSelect(piece.el)
      return
    }
    if (k === 'Enter') {
      stop()
      objects.fullscreen(piece, objects.full?.piece !== piece)
      return
    }
    if (k === 'p' || k === 'P') {
      stop()
      if (v.pinned.has(piece)) objects.unpin(piece)
      else {
        objects.pin(piece)
        objects.settlePin(piece)
      }
      window.setTimeout(() => this.kbdSelect(piece.el), 260)
      return
    }
    if (k === 'm' || k === 'M') {
      stop()
      objects.minimize(piece)
      return
    }
    if (k === 'Delete' || k === 'Backspace') {
      stop()
      const rest = list.filter((x) => x !== piece.el)
      if (v.pinned.has(piece)) objects.unpin(piece)
      else objects.dismiss(piece)
      const next = rest[Math.min(at, rest.length - 1)]
      if (next) this.kbdSelect(next)
      else this.kbdLeave()
      return
    }
  }
}
