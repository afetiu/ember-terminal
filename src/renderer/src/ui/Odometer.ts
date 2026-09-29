/**
 * A run of text that updates in place.
 *
 * This used to be an odometer: one span per character, and only the characters that
 * changed rolled, so `3m 26s` → `3m 27s` turned a single digit. It read beautifully and
 * it was the single most expensive thing on screen. Each roll was a DOM swap plus a
 * 240ms transform animation on an inline element that Chromium cannot composite on its
 * own, so the whole sidebar re-rasterised on a 4K glass window for as long as any card
 * was counting — measured at more than half of Ember's CPU while a session streamed.
 *
 * Now it is text. The class and its `set` stay so nothing that used it has to change.
 */
export class Odometer {
  readonly el: HTMLElement
  private text = ''

  constructor(className: string) {
    this.el = document.createElement('span')
    this.el.className = `ember-odo ${className}`.trim()
  }

  /** What is currently displayed. */
  get value(): string {
    return this.text
  }

  /** Show `next`; a no-op when nothing changed, so a 5Hz refresh never touches the DOM. */
  set(next: string): void {
    if (next === this.text) return
    this.text = next
    this.el.textContent = next
  }
}
