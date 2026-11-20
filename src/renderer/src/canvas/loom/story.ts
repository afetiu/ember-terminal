/**
 * The session's story on the canvas: its title at the top, as a proper heading — what this
 * session is about, high level, changing only when the work grows beyond it — and, behind
 * it, the story of what happened: plain sentences, under what they were about. Reading
 * only; nothing in it is a link or a button. The story drops down when the title is clicked
 * and goes again on Esc, a click outside, or the next thing you type.
 *
 * Written on the side by main/story.ts as each request ends (`header` is the title).
 */
import type { Story } from '@shared/types'
import { escapeHtml } from '../markdown'
import { div } from './shared'

export class StoryView {
  readonly header = div('loom-story')
  readonly drawer = div('loom-story-drawer')
  private story: Story = { header: '', goal: '', entries: [] }
  /** A line is being written (a request just ended). */
  private writing = false

  constructor(host: HTMLElement) {
    this.header.setAttribute('role', 'button')
    this.header.tabIndex = 0
    this.header.title = 'What happened in this session'
    this.header.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggle()
    })
    this.header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.toggle()
      }
    })
    // Temporary: Esc, a click anywhere else, or typing sends it away.
    const away = (e: Event) => {
      if (!this.isOpen) return
      if (e instanceof KeyboardEvent && e.key !== 'Escape' && e.key.length !== 1) return
      if (e instanceof MouseEvent && (this.drawer.contains(e.target as Node) || this.header.contains(e.target as Node))) return
      this.close()
    }
    window.addEventListener('keydown', away, true)
    window.addEventListener('pointerdown', away, true)
    this.dispose = () => {
      window.removeEventListener('keydown', away, true)
      window.removeEventListener('pointerdown', away, true)
    }
    host.append(this.header, this.drawer)
    this.render()
  }

  readonly dispose: () => void

  /** What the session is about, as its story says. */
  get current(): { goal: string; header: string } {
    return { goal: this.story.goal, header: this.story.header }
  }

  get isOpen(): boolean {
    return this.drawer.classList.contains('is-on')
  }

  /** The uuids that already have a line, so a request is never written twice. */
  has(uuid: string): boolean {
    return this.story.entries.some((e) => e.uuid === uuid)
  }

  get empty(): boolean {
    return !this.story.header
  }

  set(story: Story): void {
    this.story = story
    this.render()
  }

  setWriting(on: boolean): void {
    this.writing = on
    this.header.classList.toggle('is-writing', on)
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  open(): void {
    if (!this.story.entries.some((e) => e.text) && !this.story.header) return
    this.renderDrawer()
    this.drawer.classList.add('is-on')
    this.header.classList.add('is-open')
    requestAnimationFrame(() => (this.drawer.scrollTop = this.drawer.scrollHeight))
  }

  close(): void {
    this.drawer.classList.remove('is-on')
    this.header.classList.remove('is-open')
  }

  private render(): void {
    const s = this.story
    const on = !!s.header
    this.header.classList.toggle('is-on', on)
    this.header.closest('.loom')?.classList.toggle('has-story', on)
    const told = s.entries.filter((e) => e.text).length
    this.header.innerHTML = on
      ? `<h1 class="loom-story-text">${escapeHtml(s.header)}</h1>` +
        (told ? `<span class="loom-story-more">The story so far<span class="loom-story-caret">▾</span></span>` : '')
      : ''
    this.header.classList.toggle('is-writing', this.writing)
    if (this.isOpen) this.renderDrawer()
  }

  private renderDrawer(): void {
    const groups: Array<{ goal: string; items: string[] }> = []
    for (const e of this.story.entries) {
      if (!e.text) continue
      const last = groups[groups.length - 1]
      if (last && last.goal === e.goal) last.items.push(e.text)
      else groups.push({ goal: e.goal, items: [e.text] })
    }
    this.drawer.innerHTML =
      `<div class="loom-story-now">${escapeHtml(this.story.header)}</div>` +
      groups
        .map(
          (g) =>
            `<section>${g.goal ? `<h4>${escapeHtml(g.goal)}</h4>` : ''}` +
            g.items.map((t) => `<p>${escapeHtml(t)}</p>`).join('') +
            `</section>`
        )
        .join('') +
      (groups.length ? '' : `<p class="loom-story-empty">Nothing yet: the story is written as each request ends.</p>`)
  }
}
