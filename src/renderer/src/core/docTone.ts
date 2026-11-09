/**
 * The query a panel document is loaded with so it is drawn in the theme on screen: which
 * way it faces (light or dark), the paper it sits on, and the theme's accent, ink and
 * ground. Documents are rendered in main, which cannot see the theme; only this side can.
 */
export function docTone(): string {
  const css = getComputedStyle(document.documentElement)
  const q = new URLSearchParams()
  const accent = hex(css.getPropertyValue('--c-accent'))
  const fg = hex(css.getPropertyValue('--c-fg'))
  const bg = hex(css.getPropertyValue('--c-bg'))
  if (document.body.classList.contains('is-light')) {
    q.set('tone', 'light')
    if (bg) q.set('paper', bg)
  }
  if (accent && fg && bg) {
    q.set('accent', accent)
    q.set('fg', fg)
    q.set('bg', bg)
  }
  // A theme that changes material (Basalt) draws documents in its own stone and faces.
  const family = document.body.dataset['themeFamily']
  if (family === 'basalt') q.set('family', family)
  const s = q.toString()
  return s ? `?${s}` : ''
}

let ctx: CanvasRenderingContext2D | null = null

/** Any CSS colour as rrggbb, or '' when it is not one. A 2D context normalises it for us. */
function hex(value: string): string {
  const v = value.trim()
  if (!v) return ''
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#000001'
  ctx.fillStyle = v
  const out = String(ctx.fillStyle)
  if (out === '#000001' && !/^#0{5}1$/i.test(v)) return ''
  const m = /^#([0-9a-f]{6})$/i.exec(out)
  if (m) return m[1]!
  const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(out)
  return r ? [r[1], r[2], r[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : ''
}
