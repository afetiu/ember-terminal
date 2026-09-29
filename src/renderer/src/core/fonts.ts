/**
 * Font questions the picker needs answered that the platform will not answer.
 *
 * The list of families comes from main; everything about *a* family — is it really
 * installed, is it monospaced — is measured here with a canvas, because that is the
 * only thing in the renderer that can see how a name actually resolves.
 */

const probe = document.createElement('canvas').getContext('2d')

/** The first family in a CSS stack, unquoted — what `document.fonts` wants. */
export function primaryFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '')
}

/** CSS-safe form of a family name for a `font-family` value. */
export function quoteFamily(family: string): string {
  return /^[\w -]+$/.test(family) ? family : `"${family.replace(/"/g, '\\"')}"`
}

/** `stack` is a ready-made CSS font-family value — quote before you get here. */
function width(text: string, stack: string): number {
  if (!probe) return 0
  probe.font = `16px ${stack}`
  return probe.measureText(text).width
}

const mono = new Map<string, boolean>()

/** Whether every glyph in a family is the same width — what the terminal grid needs. */
export function isMonospace(family: string): boolean {
  const name = primaryFamily(family)
  if (!name) return false
  const hit = mono.get(name)
  if (hit !== undefined) return hit
  const i = width('iiiiiiiiii', quoteFamily(name))
  const w = width('WWWWWWWWWW', quoteFamily(name))
  const ok = i > 0 && Math.abs(i - w) < 0.5
  mono.set(name, ok)
  return ok
}

/**
 * Wait for a font stack to be usable before anything measures against it.
 *
 * xterm derives cols/rows from the cell it measures, so applying a font the browser
 * has not resolved yet produces a fit against the fallback that only corrects on the
 * next resize. Best effort: a family the machine does not have never resolves, and
 * waiting forever for it would be worse than fitting to the fallback it will use.
 */
export async function loadFont(stack: string, weight: number, size: number): Promise<void> {
  const name = primaryFamily(stack)
  if (!name) return
  try {
    await document.fonts.load(`${weight} ${size}px ${quoteFamily(name)}`)
    await document.fonts.ready
  } catch {
    /* font loading is best-effort */
  }
}
