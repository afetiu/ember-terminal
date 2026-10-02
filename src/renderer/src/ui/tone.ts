/**
 * Light or dark, decided from the theme's own background.
 *
 * The chrome was drawn for dark palettes: surfaces sink toward black, shadows are black,
 * the state colours are pale enough to glow on near-black. A light theme needs the
 * opposite of each, and the only reliable thing to ask is the background itself — names
 * lie ("Solarized" is both), and a theme pasted into config.json has no category at all.
 */

type Rgb = [number, number, number]

function parse(css: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(css.trim())
  if (!m) return null
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance, 0 for black to 1 for white. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const hex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/**
 * Every palette that ships sits far from the middle (dark ones under 0.04, light ones
 * over 0.85), so the cut can be anywhere between; 0.4 leaves room for a custom theme.
 * Anything unparseable counts as dark, which is what the chrome was designed for.
 */
export function isLightBackground(background: string): boolean {
  const bg = parse(background)
  return bg !== null && luminance(bg) > 0.4
}

/**
 * The colour as text on `background`: itself when it already reads, otherwise moved
 * toward `ink` (the theme's foreground) until it does. Keeps the hue recognisable —
 * a link is still the accent, just a deeper one — rather than swapping it for grey.
 */
export function legible(colour: string, ink: string, background: string, ratio = 4.5): string {
  const c = parse(colour)
  const k = parse(ink)
  const bg = parse(background)
  if (!c || !k || !bg) return colour
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const mixed: Rgb = [c[0] + (k[0] - c[0]) * t, c[1] + (k[1] - c[1]) * t, c[2] + (k[2] - c[2]) * t]
    if (contrast(mixed, bg) >= ratio) return t === 0 ? colour : hex(mixed)
  }
  return ink
}
