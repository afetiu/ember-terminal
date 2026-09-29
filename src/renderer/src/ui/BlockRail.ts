import type { Terminal } from '@xterm/xterm'
import type { BlockTracker, CommandBlock } from '../core/Blocks'

/**
 * Two readouts over the scrollback, both derived from the block tracker:
 *
 *   - a **rail** down the right edge with a tick per command, red where one failed,
 *     so a whole session's history is legible at a glance and clickable;
 *   - a **sticky header** naming the command that produced whatever output you are
 *     currently looking at, which is the thing you always lose when scrolling back
 *     through a long build.
 *
 * Both are plain DOM over the WebGL grid. Ticks are only rebuilt when the block count
 * or buffer length actually changes, so scrolling costs one transform.
 */
export class BlockRail {
  readonly rail: HTMLElement
  readonly header: HTMLElement
  private lastSignature = ''
  private lastHeaderId = -1

  constructor(
    host: HTMLElement,
    private readonly term: Terminal,
    private readonly blocks: BlockTracker,
    private readonly onJump: (block: CommandBlock) => void,
  ) {
    this.rail = document.createElement('div')
    this.rail.className = 'ember-rail'

    this.header = document.createElement('div')
    this.header.className = 'ember-block-header'

    host.append(this.rail, this.header)
  }

  /** Cheap enough to call on every render. */
  update(): void {
    const buf = this.term.buffer.active
    const total = buf.baseY + this.term.rows
    const all = this.blocks.all

    // Rebuild only when something structural changed.
    const signature = `${all.length}:${total}:${all[all.length - 1]?.outcome ?? ''}`
    if (signature !== this.lastSignature) {
      this.lastSignature = signature
      this.rebuild(all, total)
    }

    // Sticky header: name the command owning the top visible row. Only show it once
    // you are actually inside the output, not sitting on the command line itself.
    const topRow = buf.viewportY
    const owner = this.blocks.at(topRow)
    const show = owner && topRow > owner.markRow
    if (!show) {
      if (this.lastHeaderId !== -1) {
        this.lastHeaderId = -1
        this.header.classList.remove('is-on')
      }
      return
    }
    if (owner.id !== this.lastHeaderId) {
      this.lastHeaderId = owner.id
      this.header.textContent = owner.command
      this.header.dataset['outcome'] = owner.outcome
      this.header.classList.add('is-on')
    }
  }

  private rebuild(all: readonly CommandBlock[], total: number): void {
    this.rail.replaceChildren()
    if (all.length < 2 || total <= 0) return

    for (const b of all) {
      const tick = document.createElement('button')
      tick.className = 'ember-rail-tick'
      tick.dataset['outcome'] = b.outcome
      tick.style.top = `${((b.markRow / total) * 100).toFixed(3)}%`
      tick.title = b.command
      tick.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onJump(b)
      })
      this.rail.appendChild(tick)
    }
  }

  dispose(): void {
    this.rail.remove()
    this.header.remove()
  }
}
