import type { ClaudeImage } from '@shared/types'
import { escapeHtml } from './markdown'

/**
 * The input of a Claude tab the canvas drives itself (native mode): Ember's own box where
 * Claude Code's prompt used to be, and what sits right above it — pictures waiting to go,
 * messages waiting for the turn, the `/` and `@` menus.
 *
 * Phase 2 of docs/specs/canvas-native.md. It knows nothing about the process: it says what
 * the person sent, and asks its owner for the command list and file suggestions.
 */

export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}

/** A picture attached to the message being written. */
export interface Attachment {
  image: ClaudeImage
  /** For the thumbnail. */
  url: string
}

export interface QueuedMessage {
  uuid: string
  text: string
  images: number
}

export interface ComposerContext {
  frame: HTMLElement
  above: HTMLElement
  /** What `/` offers: the commands Claude Code reported. */
  commands(): SlashCommand[]
  /** What `@` offers for a query: paths relative to the session's folder. */
  files(query: string): Promise<string[]>
  /** Enter. The composer is cleared after. */
  submit(text: string, images: Attachment[]): void
  sendNow(uuid: string): void
  cancel(uuid: string): void
  toast(text: string): void
  relayout(): void
}

/**
 * Commands that only exist in Claude Code's own screen (protocol reference §7): pickers and
 * dialogs this channel has no data for. Offered in the menu so they are not a mystery, and
 * opened in the CLI view rather than sent. `args` = with arguments they work here.
 */
export const TUI_ONLY: Record<string, { description: string; args?: boolean }> = {
  login: { description: 'Sign in to your Anthropic account' },
  logout: { description: 'Sign out' },
  resume: { description: 'Pick a conversation to resume' },
  permissions: { description: 'Allow and deny rules' },
  hooks: { description: 'Hook configuration' },
  agents: { description: 'Manage agent configurations' },
  mcp: { description: 'Manage MCP servers', args: true },
  config: { description: 'Settings', args: true },
  memory: { description: 'Edit memory files' },
  ide: { description: 'Connect to an IDE' },
  vim: { description: 'Vim editing mode' },
  'terminal-setup': { description: 'Terminal key bindings' },
  statusline: { description: 'Status line setup' },
  bug: { description: 'Report a bug' },
  exit: { description: 'Exit the CLI' },
}

/** Whether a message is one of those, with what it would need here. */
export function tuiOnly(text: string): string | null {
  const m = /^\/([\w:-]+)(\s+\S[\s\S]*)?$/.exec(text.trim())
  if (!m) return null
  const spec = TUI_ONLY[m[1]!]
  if (!spec) return null
  if (spec.args && m[2]) return null
  return m[1]!
}

/** The largest picture sent as it is; bigger ones are scaled down first (the API takes 5 MB). */
const MAX_IMAGE_BYTES = 3_700_000
const MAX_EDGE = 2000
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

type MenuItem = { label: string; detail: string; insert: string; dir?: boolean; cli?: boolean; hint?: string }

export class Composer {
  readonly input: HTMLTextAreaElement
  private readonly attachEl = document.createElement('div')
  private readonly queueEl = document.createElement('div')
  private readonly menuEl = document.createElement('div')
  private attachments: Attachment[] = []
  private queued: QueuedMessage[] = []
  /** What was sent, newest last, for Up on an empty box. */
  private readonly history: string[] = []
  private recall = -1
  private menu: { kind: 'slash' | 'file'; items: MenuItem[]; index: number; start: number; query: string } | null = null
  private fileTimer = 0
  private fileSeq = 0
  private readonly unsubs: Array<() => void> = []

  constructor(private readonly ctx: ComposerContext) {
    this.input = document.createElement('textarea')
    this.input.className = 'loom-native-input'
    this.input.rows = 1
    this.input.spellcheck = false
    this.input.placeholder = 'Ask Claude…'
    this.input.setAttribute('aria-label', 'Message Claude')
    ctx.frame.appendChild(this.input)

    this.queueEl.className = 'loom-queue loom-native-queue'
    this.attachEl.className = 'loom-attach'
    this.menuEl.className = 'loom-native-menu'
    this.menuEl.setAttribute('role', 'listbox')
    ctx.above.append(this.queueEl, this.attachEl, this.menuEl)

    this.input.addEventListener('keydown', (e) => this.key(e))
    this.input.addEventListener('input', () => {
      this.recall = -1
      this.fit()
      this.updateMenu()
    })
    this.input.addEventListener('click', () => this.updateMenu())
    this.input.addEventListener('blur', () => window.setTimeout(() => document.activeElement !== this.input && this.closeMenu(), 150))
    this.input.addEventListener('paste', (e) => this.paste(e))

    // A click anywhere in the frame is a click in the input.
    const toInput = (e: MouseEvent) => {
      if (e.target === this.input) return
      e.preventDefault()
      this.input.focus()
    }
    ctx.frame.addEventListener('mousedown', toInput)
    this.unsubs.push(() => ctx.frame.removeEventListener('mousedown', toInput))

    this.menuEl.addEventListener('mousedown', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')
      if (!row || !this.menu) return
      e.preventDefault()
      this.menu.index = Number(row.dataset['i'])
      this.pick(false)
    })
    this.attachEl.addEventListener('click', (e) => {
      const x = (e.target as HTMLElement).closest<HTMLElement>('[data-x]')
      if (!x) return
      this.removeAttachment(Number(x.dataset['x']))
      this.input.focus()
    })
    this.queueEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-q]')
      if (!b) return
      const uuid = b.closest<HTMLElement>('[data-uuid]')?.dataset['uuid'] ?? ''
      if (b.dataset['q'] === 'now') this.ctx.sendNow(uuid)
      else this.ctx.cancel(uuid)
      this.input.focus()
    })
  }

  // ------------------------------------------------------------- keys

  private key(e: KeyboardEvent): void {
    if (e.isComposing) return
    const m = this.menu
    if (m && m.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        m.index = (m.index + (e.key === 'ArrowDown' ? 1 : -1) + m.items.length) % m.items.length
        this.renderMenu()
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        this.pick(e.key === 'Enter')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      this.submit()
      return
    }
    // Up on an empty box (or on one still showing what Up brought back) recalls what was sent.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && this.history.length) {
      const showing = this.recall >= 0 && this.input.value === this.history[this.recall]
      if (!this.input.value || showing) {
        if (e.key === 'ArrowDown' && !showing) return
        e.preventDefault()
        let i = showing ? this.recall + (e.key === 'ArrowUp' ? -1 : 1) : this.history.length - 1
        if (i >= this.history.length) {
          this.recall = -1
          this.set('')
          return
        }
        i = Math.max(0, i)
        this.recall = i
        this.set(this.history[i]!)
      }
    }
    if (e.key === 'Backspace' && !this.input.value && this.attachments.length) {
      e.preventDefault()
      this.removeAttachment(this.attachments.length - 1)
    }
  }

  private submit(): void {
    const text = this.input.value.replace(/\s+$/, '')
    if (!text.trim() && !this.attachments.length) return
    this.closeMenu()
    if (text.trim()) {
      if (this.history[this.history.length - 1] !== text) this.history.push(text)
      if (this.history.length > 100) this.history.shift()
    }
    const images = this.attachments
    this.attachments = []
    this.renderAttachments()
    this.recall = -1
    this.set('')
    this.ctx.submit(text.trim(), images)
    // The thumbnails' object URLs are not needed once the message is drawn from base64.
    window.setTimeout(() => images.forEach((a) => URL.revokeObjectURL(a.url)), 2000)
  }

  /** Esc: a menu open closes first. */
  escape(): boolean {
    if (this.menu) {
      this.closeMenu()
      return true
    }
    return false
  }

  set(text: string): void {
    this.input.value = text
    this.fit()
    this.input.setSelectionRange(text.length, text.length)
  }

  /** Text put into the box from elsewhere (a canvas action, a cancelled queue). */
  append(text: string): void {
    this.set(this.input.value ? `${this.input.value.replace(/\s+$/, '')}\n${text}` : text)
    this.input.focus()
  }

  focus(): void {
    this.input.focus()
  }

  /** The input grows with what is written, up to a point, then scrolls. */
  fit(): void {
    this.input.style.height = 'auto'
    const line = parseFloat(getComputedStyle(this.input).lineHeight) || 21
    this.input.style.height = `${Math.min(Math.max(this.input.scrollHeight, line), line * 8)}px`
    this.ctx.relayout()
  }

  // ------------------------------------------------------------- menus

  /** What is before the caret decides the menu: `/name` at the start, or `@path` anywhere. */
  private updateMenu(): void {
    const caret = this.input.selectionStart ?? 0
    if (caret !== (this.input.selectionEnd ?? 0)) return this.closeMenu()
    const before = this.input.value.slice(0, caret)
    const slash = /^\/([\w:.-]*)$/.exec(before)
    if (slash) {
      this.openSlash(slash[1]!.toLowerCase())
      return
    }
    const at = /(^|\s)@("?)([^\s"@]*)$/.exec(before)
    if (at) {
      const start = caret - at[3]!.length - at[2]!.length - 1
      this.queryFiles(at[3]!, start)
      return
    }
    this.closeMenu()
  }

  private openSlash(q: string): void {
    const seen = new Set<string>()
    const items: Array<MenuItem & { score: number }> = []
    const add = (name: string, detail: string, hint: string, cli: boolean) => {
      if (seen.has(name)) return
      const n = name.toLowerCase()
      const score = !q ? 1 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : detail.toLowerCase().includes(q) ? 2 : -1
      if (score < 0) return
      seen.add(name)
      items.push({ label: `/${name}`, detail, insert: `/${name} `, hint, cli, score })
    }
    for (const c of this.ctx.commands()) {
      if (TUI_ONLY[c.name] && !TUI_ONLY[c.name]!.args) continue
      add(c.name, c.description.replace(/\s*\((user|project|plugin[^)]*|bundled)\)\s*$/i, ''), c.argumentHint, false)
      for (const a of c.aliases ?? []) seen.add(a)
    }
    for (const [name, spec] of Object.entries(TUI_ONLY)) add(name, spec.description, '', true)
    items.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
    if (!items.length) return this.closeMenu()
    this.menu = { kind: 'slash', items: items.slice(0, 60), index: 0, start: 0, query: q }
    this.renderMenu()
  }

  private queryFiles(query: string, start: number): void {
    window.clearTimeout(this.fileTimer)
    const seq = ++this.fileSeq
    this.fileTimer = window.setTimeout(async () => {
      let paths: string[] = []
      try {
        paths = await this.ctx.files(query)
      } catch {
        paths = []
      }
      if (seq !== this.fileSeq) return
      if (!paths.length) return this.closeMenu()
      const items = paths.slice(0, 30).map((p) => {
        const dir = /[\\/]$/.test(p)
        const quoted = /\s/.test(p) ? `"${p}"` : p
        return { label: p, detail: dir ? 'folder' : '', insert: `@${quoted}${dir ? '' : ' '}`, dir }
      })
      this.menu = { kind: 'file', items, index: 0, start, query }
      this.renderMenu()
    }, 120)
  }

  /** Tab completes; Enter completes and, for a command that takes nothing, sends it. */
  private pick(enter: boolean): void {
    const m = this.menu
    const item = m?.items[m.index]
    if (!m || !item) return
    const caret = this.input.selectionStart ?? this.input.value.length
    const value = this.input.value
    if (m.kind === 'slash') {
      const rest = value.slice(caret).replace(/^\S*/, '')
      this.set(`${item.insert}${rest.replace(/^\s+/, '')}`)
      this.closeMenu()
      if (enter && !item.hint && !rest.trim()) this.submit()
      return
    }
    const next = value.slice(0, m.start) + item.insert + value.slice(caret)
    this.input.value = next
    const at = m.start + item.insert.length
    this.input.setSelectionRange(at, at)
    this.fit()
    this.closeMenu()
    // A folder goes on: what is in it, next.
    if (item.dir) this.updateMenu()
  }

  private renderMenu(): void {
    const m = this.menu
    if (!m) return
    this.menuEl.innerHTML =
      `<div class="loom-native-menu-head">${m.kind === 'slash' ? 'Commands' : 'Files'}<span>↑↓ choose · Tab complete · Enter ${m.kind === 'slash' ? 'run' : 'insert'} · Esc close</span></div>` +
      `<div class="loom-native-menu-list">` +
      m.items
        .map(
          (it, i) =>
            `<div class="loom-native-menu-row${i === m.index ? ' is-sel' : ''}${it.dir ? ' is-dir' : ''}" role="option" data-i="${i}"${i === m.index ? ' aria-selected="true"' : ''}>` +
            `<span class="n">${escapeHtml(it.label)}${it.hint ? ` <i>${escapeHtml(it.hint)}</i>` : ''}</span>` +
            `<span class="d">${escapeHtml(it.cli ? `${it.detail} · opens in the CLI view` : it.detail)}</span></div>`
        )
        .join('') +
      `</div>`
    this.menuEl.classList.add('is-on')
    this.menuEl.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' })
    this.ctx.relayout()
  }

  closeMenu(): void {
    window.clearTimeout(this.fileTimer)
    this.fileSeq++
    if (!this.menu) return
    this.menu = null
    this.menuEl.classList.remove('is-on')
    this.menuEl.innerHTML = ''
    this.ctx.relayout()
  }

  get menuOpen(): { kind: string; items: string[]; index: number } | null {
    return this.menu ? { kind: this.menu.kind, items: this.menu.items.map((i) => i.label), index: this.menu.index } : null
  }

  // ------------------------------------------------------------- pictures

  private paste(e: ClipboardEvent): void {
    const dt = e.clipboardData
    if (!dt) return
    // Text wins when the clipboard has both (a cell copied from a sheet): it is what was meant.
    if (dt.types.includes('text/plain') && dt.getData('text/plain')) return
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    void this.addFiles(files)
  }

  /** Image files become attachments; anything else is mentioned by path. */
  async addFiles(files: File[], pathFor?: (f: File) => string): Promise<void> {
    const mentions: string[] = []
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        const image = await toImage(f).catch(() => null)
        if (!image) {
          this.ctx.toast(`Could not read ${f.name || 'the picture'}`)
          continue
        }
        this.attachments.push({ image, url: URL.createObjectURL(f) })
      } else {
        const p = pathFor?.(f) ?? ''
        if (p) mentions.push(/\s/.test(p) ? `@"${p}"` : `@${p}`)
      }
    }
    this.renderAttachments()
    if (mentions.length) {
      const v = this.input.value
      this.set(`${v}${v && !/\s$/.test(v) ? ' ' : ''}${mentions.join(' ')} `)
    }
    this.input.focus()
  }

  private removeAttachment(i: number): void {
    const [a] = this.attachments.splice(i, 1)
    if (a) URL.revokeObjectURL(a.url)
    this.renderAttachments()
  }

  private renderAttachments(): void {
    this.attachEl.innerHTML = this.attachments
      .map(
        (a, i) =>
          `<figure class="loom-attach-item"><img src="${a.url}" alt=""><figcaption>Image #${i + 1}</figcaption>` +
          `<button type="button" class="loom-attach-x" data-x="${i}" title="Remove" aria-label="Remove image ${i + 1}">×</button></figure>`
      )
      .join('')
    this.attachEl.classList.toggle('has-items', this.attachments.length > 0)
    this.ctx.relayout()
  }

  get attachmentCount(): number {
    return this.attachments.length
  }

  // ------------------------------------------------------------- queue

  setQueue(items: QueuedMessage[]): void {
    this.queued = items
    this.queueEl.innerHTML =
      items
        .map(
          (q) =>
            `<div class="loom-queue-item" data-uuid="${escapeHtml(q.uuid)}"><span class="loom-queue-tag">queued</span>` +
            `<span class="loom-queue-text">${escapeHtml(q.text || '(picture)')}${q.images ? ` <i>+${q.images} image${q.images > 1 ? 's' : ''}</i>` : ''}</span>` +
            `<span class="loom-queue-acts"><button type="button" data-q="now" title="Stop the turn and send this now">Send now</button>` +
            `<button type="button" data-q="x" class="is-x" title="Don't send" aria-label="Cancel">×</button></span></div>`
        )
        .join('') + (items.length ? `<div class="loom-queue-foot"><span>Sent when this turn ends · Esc stops the turn and gives them back</span></div>` : '')
    this.queueEl.classList.toggle('has-items', items.length > 0)
    this.ctx.relayout()
  }

  get queue(): QueuedMessage[] {
    return this.queued
  }

  dispose(): void {
    for (const u of this.unsubs) u()
    window.clearTimeout(this.fileTimer)
    for (const a of this.attachments) URL.revokeObjectURL(a.url)
    this.input.remove()
    this.attachEl.remove()
    this.queueEl.remove()
    this.menuEl.remove()
  }
}

/** A picture file as the API takes it: base64, a type it knows, small enough. */
async function toImage(f: File): Promise<ClaudeImage> {
  if (IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES) return { mediaType: f.type, data: await base64(f) }
  const bmp = await createImageBitmap(f)
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * scale))
  c.height = Math.max(1, Math.round(bmp.height * scale))
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.88))
  if (!blob) throw new Error('could not encode')
  return { mediaType: 'image/jpeg', data: await base64(blob) }
}

function base64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}
