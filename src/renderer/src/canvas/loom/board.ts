import type { CanvasAnnotate, CanvasMedia, PanelPush } from '@shared/types'
import { escapeHtml } from '../markdown'
import { docTone } from '../../core/docTone'
import type { LoomView } from '../LoomView'
import { ICON, div, iconFor, sameTitle, sameUrl, type Browser, type Piece, type WebviewTag } from './shared'

/**
 * The board: what the session shows lands here. Each turn has its own board under its
 * words, one thing open at a time; a pushed panel becomes a piece with a document frame in
 * it, or changes the one of that name in place; media and the live browser are pieces too.
 * Also the bridge the documents talk back over (their height, Esc, a right-click inside),
 * and a resumed session's board, rebuilt from its transcript.
 */
export class Board {
  // ================================================================ a resumed session, rebuilt

  /** When this view started: what the transcript says happened before that is history to rebuild. */
  private readonly bornAt = Date.now()
  /** What was shown by title, so a replayed edit_panel has something to edit. */
  private readonly replayed = new Map<string, { format: string; content: string }>()

  constructor(private readonly v: LoomView) {}

  /** A message from a document's frame: Esc, its zoom, its status, a todo, a right-click, its height. */
  frameMessage(e: MessageEvent): void {
    const v = this.v
    // Esc pressed inside an object's own frame (a click there took the keyboard into it):
    // the same as Esc on the canvas — off the object, full screen closed, back to typing.
    if ((e.data as { emberKey?: string } | null)?.emberKey === 'Escape') {
      if (v.objects.full) v.objects.fullscreen(v.objects.full.piece, false)
      else if (v.input.kbd || v.input.kbdInline) v.input.kbdLeave()
      else v.session.focus()
      return
    }
    const zoomed = (e.data as { emberZoomed?: number } | null)?.emberZoomed
    if (typeof zoomed === 'number') {
      if (v.objects.full?.piece.frame?.contentWindow === e.source) v.objects.showZoom(zoomed)
      return
    }
    const status = (e.data as { emberDocStatus?: { id: string; ok: boolean; error: string; repaired: boolean } } | null)?.emberDocStatus
    if (status && [...v.frames].some((f) => f.contentWindow === e.source)) {
      window.ember.canvas.docStatus(status.id, { ok: status.ok, error: status.error, repaired: status.repaired })
      return
    }
    const todo = (e.data as { emberTodo?: { op: string; text?: string } } | null)?.emberTodo
    if (todo && [...v.frames].some((f) => f.contentWindow === e.source)) {
      void v.notebook.todoOp(todo.op, todo.text ?? '')
      return
    }
    const ctx = (e.data as { emberContext?: { x: number; y: number; text?: string; part?: string } } | null)?.emberContext
    if (ctx) {
      for (const f of v.frames) {
        if (f.contentWindow !== e.source) continue
        const r = f.getBoundingClientRect()
        const host = f.closest<HTMLElement>('.loom-piece, .loom-diagram')
        v.objects.raiseFocused()
        for (const p of v.pinned) if (p.el === host) v.objects.raise(p)
        if (host) v.input.menu(new DOMRect(r.left + ctx.x, r.top + ctx.y, 0, 0), host, ctx.text || undefined, ctx.part || undefined)
      }
      return
    }
    const h = (e.data as { emberDocHeight?: number } | null)?.emberDocHeight
    if (typeof h !== 'number') return
    for (const f of v.frames) {
      if (f.contentWindow !== e.source) continue
      // Sized by hand: the frame fills what it was given and scrolls inside.
      if (f.closest('.loom-piece.is-sized, .loom-liftable.is-sized')) continue
      const max = Number(f.dataset['max'] ?? 2400)
      const stick = v.atBottom()
      f.style.height = `${Math.max(36, Math.min(max, Math.ceil(h)))}px`
      if (stick) v.toBottom()
    }
  }

  // ================================================================ one thing in focus

  /**
   * The board shows one thing at a time: the object last shown or changed, open; every
   * other one folded to a chip with its name, in a row above. Clicking a chip opens it and
   * folds the one that was open. Placed and snapped objects are yours and are left alone.
   * A new object also belongs to the plan step in progress, so the step can bring it back.
   */
  focusOn(piece: Piece, fresh = false): void {
    if (fresh && !piece.step) {
      const active = this.v.plan.el.querySelector<HTMLElement>('li[data-state="active"]')
      if (active?.dataset['k']) piece.step = active.dataset['k']
    }
    const board = piece.el.closest<HTMLElement>('.loom-board')
    if (!board) return
    for (const slot of board.querySelectorAll<HTMLElement>(':scope > .loom-slot')) {
      const inside = slot.firstElementChild as HTMLElement | null
      if (!inside) continue
      slot.classList.toggle('is-shelved', inside !== piece.el)
    }
    piece.el.classList.remove('is-min')
    piece.el.style.height = ''
    this.v.plan.tickPlan()
  }

  /** In the turn on screen, a link to an object that was changed in the turn it belongs to. */
  private noteUpdate(piece: Piece): void {
    const v = this.v
    const home = piece.el.closest<HTMLElement>('.loom-turn')
    const turns = v.feed.turns()
    const n = home ? turns.indexOf(home) + 1 : 0
    const turns2 = v.feed.turns()
    const live = turns2[turns2.length - 1]
    if (!live || !home || live === home) return
    const existing = [...live.querySelectorAll<HTMLElement>('.loom-ref')].find((r) => r.dataset['title'] === piece.title)
    if (existing) return
    const ref = div('loom-ref', `${iconFor(piece.format)}<span>Updated <b>${escapeHtml(piece.title)}</b> in turn ${n}</span>${ICON.out}`)
    ref.dataset['title'] = piece.title
    ref.addEventListener('click', () => {
      v.stage.viewing = home === turns[turns.length - 1] ? null : home
      v.stage.restage()
      this.focusOn(piece)
      v.reveal(piece.el, 'nearest')
    })
    const board = live.querySelector(':scope > .loom-board')
    live.insertBefore(ref, board)
  }

  /** A place on the board for a new object: newest first, under the exchange. */
  boardSlot(): HTMLElement {
    // Each turn has its own board, under its words: what was shown in a turn is part of
    // that turn, and goes when you move to another — only the plan carries across, and
    // anything you placed on the screen.
    const turns = this.v.feed.turns()
    const turn = turns[turns.length - 1] ?? this.v.feed.el
    let board = turn.querySelector<HTMLElement>(':scope > .loom-board')
    if (!board) {
      board = div('loom-board is-on')
      turn.appendChild(board)
    }
    const slot = div('loom-slot')
    board.prepend(slot)
    return slot
  }

  /**
   * A resumed session's transcript has every call it made to Ember's tools, with what it
   * sent. Played back, they put the board, the plan and the objects back as they were.
   * Only history is replayed — what is happening now arrives through the bridge as usual —
   * and nothing with a side effect (a todo added, a note written) is done again.
   */
  async replay(tool: string, input: Record<string, unknown>, at: string): Promise<void> {
    const v = this.v
    const t = Date.parse(at)
    if (!t || t > this.bornAt - 3000) return
    const str = (k: string) => String(input[k] ?? '')
    const host = async (title: string, format: 'markdown' | 'mermaid' | 'code' | 'html' | 'view', content: string) => {
      this.replayed.set(title, { format, content })
      const url = await window.ember.canvas.doc(v.tabId, title, format, content)
      const id = /\/doc\/([^/?#]+)/.exec(url)?.[1]
      if (id) this.push({ tabId: v.tabId, title, format, content, id, at: t } as PanelPush)
    }
    try {
      if (tool === 'show_panel') {
        const f = str('format')
        if (f === 'markdown' || f === 'mermaid' || f === 'code' || f === 'html') await host(str('title') || 'Panel', f, str('content'))
      } else if (tool === 'show_view') {
        await host(str('title') || 'View', 'view', JSON.stringify({ view: str('view'), data: input['data'] ?? {} }))
      } else if (tool === 'edit_panel') {
        const was = [...this.replayed.entries()].find(([k]) => sameTitle(k, str('title')))
        if (!was) return
        let content = was[1].content
        for (const e of (input['edits'] as Array<{ find?: string; replace?: string; all?: boolean }>) ?? []) {
          if (!e.find) continue
          content = e.all ? content.split(e.find).join(e.replace ?? '') : content.replace(e.find, () => e.replace ?? '')
        }
        await host(was[0], was[1].format as 'markdown', content)
      } else if (tool === 'show_file') {
        await window.ember.canvas.showFile(v.tabId, str('path'), str('title') || undefined)
      } else if (tool === 'notes' && str('op') === 'show') {
        const dir = await window.ember.notes.dir()
        const n = (await window.ember.notes.list()).find((x) => x.title.toLowerCase() === str('name').toLowerCase())
        if (n) await window.ember.canvas.showFile(v.tabId, `${dir}\\${n.id}`, n.title)
      } else if (tool === 'show_media') {
        const items = []
        for (const it of (input['items'] as Array<{ path?: string; url?: string; caption?: string }>) ?? []) {
          if (it.url) items.push({ src: it.url, kind: /\.(mp4|webm|mov)$/i.test(it.url) ? 'video' : 'image', name: it.url, caption: it.caption })
          else if (it.path) {
            const r = await window.ember.canvas.media(it.path)
            if ('src' in r) items.push({ src: r.src, kind: r.kind, name: r.name, caption: it.caption })
          }
        }
        if (items.length) await this.showMedia({ tabId: v.tabId, title: str('title'), items } as unknown as CanvasMedia)
      } else if (tool === 'show_steps') {
        v.plan.stepsTitle = str('title')
        const steps = (input['steps'] as Array<{ text?: string; status?: string }>) ?? []
        v.plan.setTodos(steps.map((x) => ({ content: String(x.text ?? ''), status: x.status === 'done' ? 'completed' : x.status === 'active' ? 'in_progress' : 'pending' })))
      }
    } catch {
      /* a piece that cannot come back is left out; the rest still do */
    }
  }

  /** Before placing a piece, catch the feed up, so the piece lands after the call that made it. */
  private async settle(): Promise<void> {
    try {
      await window.ember.canvas.drain(this.v.tabId)
    } catch {
      /* placement falls back to the end of the turn */
    }
  }

  /** A pushed panel: a document inline, or a live page. */
  push(push: PanelPush): void {
    void this.place(push)
  }

  private async place(push: PanelPush): Promise<void> {
    const v = this.v
    const objects = v.objects
    await this.settle()
    if (push.format === 'url') {
      await this.openBrowser(push.content, push.title, 'open_url')
      return
    }
    if (!v.origin) v.origin = await window.ember.panel.origin()
    const url = `${v.origin}/doc/${push.id}`
    const same = v.findPiece(push.title)
    const shown = v.stage.shown
    if (same && !same.frame && push.format !== 'ask' && same.el.isConnected) {
      if (!v.pinned.has(same) && shown && !shown.contains(same.el)) this.noteUpdate(same)
      same.body.innerHTML = ''
      same.frame = objects.mountFrame(same.body, `${url}`, 64)
      same.format = push.format
      if (push.format === 'mermaid') same.source = push.content
      if (!v.pinned.has(same)) this.focusOn(same)
      same.el.classList.add('is-updated')
      window.setTimeout(() => same.el.classList.remove('is-updated'), 1600)
      if (v.pinned.has(same)) same.frame.addEventListener('load', () => same.frame?.contentWindow?.postMessage({ emberFit: true }, '*'), { once: true })
      v.reportScreen()
      return
    }
    // Same name, any format: it is that object, changed. Redrawn where it is.
    if (same && same.frame && push.format !== 'ask' && same.el.isConnected) {
      same.format = push.format
      // An object belongs to the turn it was made in, for good: changed later, it changes
      // there, and this turn gets a link to it.
      if (!v.pinned.has(same) && shown && !shown.contains(same.el)) this.noteUpdate(same)
      same.frame.src = `${url}${docTone()}`
      if (push.format === 'mermaid') same.source = push.content
      v.reportScreen()
      objects.minimize(same, false)
      same.el.classList.add('is-updated')
      window.setTimeout(() => same.el.classList.remove('is-updated'), 1600)
      if (!v.pinned.has(same) && !v.visible(same.el)) v.hooks.toast(`Updated: ${push.title}`)
      return
    }
    if (push.format === 'mermaid') {
      const inline = [...v.el.querySelectorAll<HTMLElement>('.loom-diagram[data-title]')].find((d) => sameTitle(d.dataset['title'] ?? '', push.title))
      const f = inline?.querySelector('iframe')
      if (inline && f && !inline.classList.contains('is-lifted')) {
        f.src = `${url}${docTone()}`
        inline.dataset['source'] = push.content
        inline.classList.add('is-updated')
        window.setTimeout(() => inline.classList.remove('is-updated'), 1600)
        v.reportScreen()
        return
      }
    }
    // A question belongs to the exchange; everything else to the board.
    const host = push.format === 'ask' ? v.feed.slotFor('ask_panel') : this.boardSlot()
    const piece = objects.makePiece(host, push.title, push.format)
    if (push.file) piece.file = push.file
    piece.frame = objects.mountFrame(piece.body, url, push.format === 'html' ? 440 : 64)
    v.pieces.set(push.title, piece)
    if (push.format !== 'ask') this.focusOn(piece, true)
    v.grew()
    v.reportScreen()
  }

  /** clear_panel: fold what is up rather than delete it — it is still part of the story. */
  clear(): void {
    const v = this.v
    for (const p of v.pieces.values()) if (!v.pinned.has(p)) v.objects.minimize(p, true)
    for (const b of v.browsers) if (!v.pinned.has(b.piece)) v.objects.minimize(b.piece, true)
  }

  async showMedia(m: CanvasMedia): Promise<void> {
    await this.settle()
    const host = this.boardSlot()
    const piece = this.v.objects.makePiece(host, m.title || (m.items.length === 1 ? m.items[0]!.name : `${m.items.length} items`), 'media')
    const grid = div(`loom-media${m.items.length > 1 ? ' is-grid' : ''}`)
    for (const item of m.items) {
      const fig = div('loom-figure')
      fig.dataset['askLabel'] = `this ${item.kind} (${item.caption ?? item.name})`
      if (item.kind === 'video') {
        const v = document.createElement('video')
        v.src = item.src
        v.controls = true
        v.autoplay = true
        v.muted = true
        v.loop = true
        v.playsInline = true
        fig.appendChild(v)
      } else if (item.kind === 'audio') {
        const a = document.createElement('audio')
        a.src = item.src
        a.controls = true
        fig.appendChild(a)
      } else {
        const img = document.createElement('img')
        img.src = item.src
        img.alt = item.caption ?? item.name
        img.dataset['zoom'] = '1'
        fig.appendChild(img)
      }
      if (item.caption) fig.appendChild(div('loom-caption', escapeHtml(item.caption)))
      grid.appendChild(fig)
    }
    piece.body.appendChild(grid)
    this.focusOn(piece, true)
    this.v.grew()
  }

  // ================================================================ the live browser

  async openBrowser(url: string, title: string, tool: string): Promise<Browser> {
    await this.settle()
    const host = this.boardSlot()
    void tool
    const piece = this.v.objects.makePiece(host, title || url, 'url')
    const view = document.createElement('webview') as WebviewTag
    view.className = 'loom-web'
    view.setAttribute('allowpopups', 'false')
    // The browser's PDF viewer is a plugin: without this a PDF is a blank page.
    view.setAttribute('plugins', '')
    view.setAttribute('src', url)
    const legend = div('loom-legend')
    piece.body.append(view, legend)
    const ready = new Promise<void>((resolve) => {
      view.addEventListener('dom-ready', () => resolve(), { once: true })
      window.setTimeout(resolve, 10_000)
    })
    view.addEventListener('page-title-updated', (e: Event) => {
      const t = (e as unknown as { title: string }).title
      const el = piece.el.querySelector('.loom-piece-title')
      if (t && el) el.textContent = t
    })
    piece.extra = [
      ['reload', 'Reload', () => view.reload()],
      ['out', 'Open in your browser', () => void window.open(view.getURL() || url, '_blank')],
    ]
    const browser: Browser = { piece, view, legend, ready }
    this.v.browsers.push(browser)
    this.focusOn(piece, true)
    this.v.grew()
    return browser
  }

  /** Wait until the page has finished loading, within reason. */
  private async loaded(b: Browser): Promise<void> {
    await b.ready
    if (!b.view.isLoading()) return
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      b.view.addEventListener('did-stop-loading', done, { once: true })
      window.setTimeout(done, 8000)
    })
  }

  async annotate(a: CanvasAnnotate): Promise<void> {
    const v = this.v
    const reply = (r: Parameters<typeof window.ember.canvas.annotated>[1]) => window.ember.canvas.annotated(a.reqId, r)
    try {
      let b = v.browsers[v.browsers.length - 1]
      if (a.url && (!b || !sameUrl(b.view.getURL(), a.url))) b = await this.openBrowser(a.url, a.url, 'annotate')
      if (!b) return reply({ ok: false, error: 'No page is open on the canvas. Call open_url first, or pass url.' })
      await this.loaded(b)
      const marks = a.clear ? null : a.marks
      const result = (await b.view.executeJavaScript(`(${MARK_SCRIPT})(${JSON.stringify(marks)})`)) as { found: number; missing: string[] }
      b.legend.innerHTML = marks
        ? marks
            .map((m, i) => (m.note ? `<div class="loom-legend-row"><span class="n">${escapeHtml(m.label || String(i + 1))}</span>${escapeHtml(m.note)}</div>` : ''))
            .join('')
        : ''
      v.objects.minimize(b.piece, false)
      if (!v.visible(b.piece.el)) v.reveal(b.piece.el, 'center')
      reply({ ok: true, found: result?.found ?? 0, missing: result?.missing ?? [], url: b.view.getURL() })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * Runs inside the page. Finds each mark by selector or by visible text, and draws a box,
 * a label and its note over it in document coordinates, on one layer that the next call
 * replaces. Returns what it found so the agent knows what it actually pointed at.
 */
const MARK_SCRIPT = String(function mark(marks: Array<{ selector?: string; text?: string; label?: string; note?: string }> | null) {
  const ID = '__ember_marks__'
  document.getElementById(ID)?.remove()
  if (!marks) return { found: 0, missing: [] }
  const layer = document.createElement('div')
  layer.id = ID
  layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none'
  const style = document.createElement('style')
  style.textContent =
    '@keyframes __emberPulse{0%{box-shadow:0 0 0 0 rgba(255,122,61,.6)}100%{box-shadow:0 0 0 16px rgba(255,122,61,0)}}'
  layer.appendChild(style)
  document.documentElement.appendChild(layer)
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const byText = (t: string): Element | null => {
    const want = t.trim().toLowerCase()
    let best: Element | null = null
    let bestLen = Infinity
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (!visible(el)) continue
      const h = el as HTMLElement & { value?: string }
      const text = (h.innerText || h.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().toLowerCase()
      if (!text || !text.includes(want)) continue
      if (text.length < bestLen) {
        best = el
        bestLen = text.length
      }
    }
    return best
  }
  const found: Array<{ el: Element; m: { label?: string; note?: string }; n: number }> = []
  const missing: string[] = []
  marks.forEach((m, i) => {
    let el: Element | null = null
    try {
      if (m.selector) el = Array.from(document.querySelectorAll(m.selector)).find(visible) ?? document.querySelector(m.selector)
    } catch {
      /* not a valid selector; try the text */
    }
    if (!el && m.text) el = byText(m.text)
    if (!el) missing.push(m.selector || m.text || `#${i + 1}`)
    else found.push({ el, m, n: found.length + 1 })
  })
  for (const { el, m, n } of found) {
    const r = el.getBoundingClientRect()
    const x = r.left + scrollX
    const y = r.top + scrollY
    const box = document.createElement('div')
    box.style.cssText = `position:absolute;left:${x - 5}px;top:${y - 5}px;width:${r.width + 10}px;height:${r.height + 10}px;border:2px solid #ff7a3d;border-radius:8px;background:rgba(255,122,61,.07);animation:__emberPulse 1.3s ease-out 3`
    const tag = document.createElement('div')
    tag.textContent = m.label || String(n)
    tag.style.cssText = `position:absolute;left:${x - 5}px;top:${Math.max(0, y - 30)}px;background:#ff7a3d;color:#1a0d05;font:700 12px/1 system-ui,sans-serif;padding:6px 9px;border-radius:7px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35)`
    layer.append(box, tag)
    if (m.note) {
      const note = document.createElement('div')
      note.textContent = m.note
      const right = x + r.width + 16
      const fits = right + 280 < scrollX + innerWidth
      note.style.cssText = `position:absolute;left:${fits ? right : x - 5}px;top:${fits ? y - 4 : y + r.height + 12}px;max-width:270px;background:#1a1624;color:#f1ecfa;border:1px solid #ff7a3d;font:13px/1.45 system-ui,sans-serif;padding:8px 11px;border-radius:9px;box-shadow:0 12px 32px rgba(0,0,0,.45)`
      layer.appendChild(note)
    }
  }
  found[0]?.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return { found: found.length, missing }
})
