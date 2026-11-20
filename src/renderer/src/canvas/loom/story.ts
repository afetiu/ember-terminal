/**
 * The session's story on the canvas: one quiet line at the top — what the work is and where
 * it stands — and, behind it, the story so far: a plain line per request, under its goal.
 * The story is a drawer that drops from the header and goes again on Esc, a click outside,
 * or the next thing you type. It never stays on screen by itself.
 *
 * Written on the side by main/story.ts as each request ends.
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

  constructor(
    host: HTMLElement,
    private readonly jump: (uuid: string) => void
  ) {
    this.header.setAttribute('role', 'button')
    this.header.tabIndex = 0
    this.header.title = 'The story so far'
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
    this.drawer.addEventListener('click', (e) => {
      e.stopPropagation()
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-uuid]')
      if (!li) return
      this.close()
      this.jump(li.dataset['uuid'] ?? '')
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

  /** What the session is doing, as its story says. */
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
    if (!this.story.entries.length && !this.story.header) return
    this.renderDrawer()
    this.drawer.classList.add('is-on')
    this.header.classList.add('is-open')
    // The latest at the foot, in view.
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
    this.header.innerHTML = on
      ? `<span class="loom-story-mark"></span><span class="loom-story-text">${escapeHtml(s.header)}</span>` +
        (s.entries.length ? `<span class="loom-story-more">${s.entries.length > 1 ? 'Story so far' : 'So far'}</span>` : '')
      : ''
    this.header.classList.toggle('is-writing', this.writing)
    if (this.isOpen) this.renderDrawer()
  }

  private renderDrawer(): void {
    const groups: Array<{ goal: string; items: Story['entries'] }> = []
    for (const e of this.story.entries) {
      const last = groups[groups.length - 1]
      if (last && last.goal === e.goal) last.items.push(e)
      else groups.push({ goal: e.goal, items: [e] })
    }
    this.drawer.innerHTML =
      `<div class="loom-story-now">${escapeHtml(this.story.header)}</div>` +
      groups
        .map(
          (g) =>
            `<section><h4>${escapeHtml(g.goal || 'Getting started')}</h4><ul>` +
            g.items.map((e) => `<li data-uuid="${escapeHtml(e.uuid)}">${escapeHtml(e.text)}</li>`).join('') +
            `</ul></section>`
        )
        .join('') +
      (groups.length ? '' : `<p class="loom-story-empty">Nothing yet: a line is added as each request ends.</p>`)
  }
}
