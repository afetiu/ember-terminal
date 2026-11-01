/// <reference lib="dom" />
/**
 * Data views: a visual drawn by Ember from data the session sends.
 *
 * A chart written as an html page costs the session thousands of output tokens, and stays
 * in its context, re-read on every later call. The same chart as data is a hundred. So
 * the common shapes — charts, stat tiles, a sortable table, a timeline, a board, cards to
 * compare, progress, a JSON tree — are drawn here, in the theme, interactive (hover for
 * values; click an item to ask about it), from a small JSON payload.
 *
 * Anything else stays open: a session can save its own view once (define_view) as an html
 * page that reads `window.EMBER_DATA`, and afterwards send only data to it.
 */

export interface ViewTheme {
  accent: string
  ink: string
  strong: string
  dim: string
  line: string
  surface: string
  cats: string[]
}

export const BUILTIN_VIEWS = ['bar', 'line', 'area', 'pie', 'stats', 'table', 'timeline', 'kanban', 'compare', 'progress', 'json', 'todo'] as const

const VIEW_STYLE = `
.v-wrap { padding: 4px 0 8px; font: 400 14px/1.5 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif; color: var(--v-ink); }
.v-title { font-weight: 600; color: var(--v-strong); margin: 0 0 12px; font-size: 16px; letter-spacing: -0.01em; }
.v-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 12px 0 0; color: var(--v-dim); font-size: 12px; }
.v-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 3px; margin-right: 6px; vertical-align: 0; }
svg.v-chart { width: 100%; height: auto; display: block; overflow: visible; }
svg.v-chart text { fill: var(--v-dim); font-size: 12px; font-family: inherit; }
svg.v-chart text.v-val { fill: var(--v-ink); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
svg.v-chart .v-grid { stroke: var(--v-line); stroke-width: 1; stroke-dasharray: 2 4; }
svg.v-chart .v-base { stroke: var(--v-line); stroke-width: 1; }
svg.v-chart .v-hit { cursor: pointer; transition: opacity 150ms; }
svg.v-chart .v-hit:hover { opacity: 0.8; }
.v-tip { position: fixed; pointer-events: none; z-index: 9; padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 500;
  background: var(--v-tipbg); color: var(--v-strong); box-shadow: 0 8px 24px -10px rgba(0,0,0,.5), inset 0 0 0 1px var(--v-line); opacity: 0; transition: opacity 150ms; }
.v-tip.on { opacity: 1; }
.v-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.v-stat { padding: 16px; border-radius: 10px; background: var(--v-surface); cursor: pointer; transition: background 150ms; }
.v-stat:hover { background: var(--v-hover); }
.v-stat .l { color: var(--v-dim); font-size: 12px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; }
.v-stat .n { color: var(--v-strong); font-size: 26px; font-weight: 600; line-height: 1.15; margin-top: 8px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.v-stat .d { font-size: 12px; font-weight: 500; margin-top: 4px; }
.v-stat .d.up { color: #5fbf8f; } .v-stat .d.down { color: #e2676f; }
.v-stat .h { color: var(--v-dim); font-size: 12px; margin-top: 8px; }
table.v-table { width: 100%; border-collapse: collapse; font-size: 13px; display: table; }
.v-table th, .v-table td { border: 0; background: none; }
.v-table th { text-align: left; color: var(--v-dim); font-weight: 500; font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
  padding: 8px 12px; border-bottom: 1px solid var(--v-line); cursor: pointer; user-select: none; white-space: nowrap; }
.v-table th:hover { color: var(--v-strong); }
.v-table th .s { opacity: .6; margin-left: 4px; }
.v-table td { padding: 8px 12px; border-bottom: 1px solid var(--v-line); color: var(--v-ink); }
.v-table tbody tr:last-child td { border-bottom: 0; }
.v-table td.num, .v-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.v-table tbody tr { cursor: pointer; transition: background 150ms; }
.v-table tbody tr:hover { background: var(--v-surface); }
.v-tl { position: relative; padding-left: 24px; }
.v-tl::before { content: ''; position: absolute; left: 4px; top: 8px; bottom: 8px; width: 1px; background: var(--v-line); }
.v-tl .it { position: relative; padding: 0 0 16px; cursor: pointer; }
.v-tl .it:last-child { padding-bottom: 0; }
.v-tl .it::before { content: ''; position: absolute; left: -24px; top: 6px; width: 9px; height: 9px; border-radius: 50%; background: var(--v-accent); box-shadow: 0 0 0 3px var(--v-bg); }
.v-tl .w { color: var(--v-dim); font-size: 12px; font-weight: 500; }
.v-tl .t { color: var(--v-strong); font-weight: 600; margin-top: 2px; }
.v-tl .x { color: var(--v-ink); font-size: 13px; margin-top: 2px; }
.v-kb { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(200px, 1fr); gap: 8px; overflow-x: auto; }
.v-kb .col { background: var(--v-surface); border-radius: 10px; padding: 12px; min-height: 60px; }
.v-kb .h { color: var(--v-dim); font-size: 12px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; margin: 0 4px 8px; display: flex; justify-content: space-between; }
.v-kb .card { background: var(--v-raised); border-radius: 8px; padding: 8px 12px; margin-top: 4px; color: var(--v-ink); cursor: pointer; font-size: 13px; transition: background 150ms; }
.v-kb .card:hover { background: var(--v-hover); }
.v-kb .card b { color: var(--v-strong); font-weight: 600; display: block; }
.v-kb .card span { color: var(--v-dim); font-size: 12px; }
.v-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.v-cmp .c { background: var(--v-surface); border-radius: 10px; padding: 16px; cursor: pointer; transition: background 150ms; }
.v-cmp .c:hover { background: var(--v-hover); }
.v-cmp .c.win { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--v-accent) 60%, transparent); }
.v-cmp .t { color: var(--v-strong); font-weight: 600; font-size: 16px; margin-bottom: 8px; }
.v-cmp ul { margin: 0; padding-left: 16px; color: var(--v-ink); font-size: 13px; }
.v-cmp li { margin: 4px 0; }
.v-cmp .v { margin-top: 12px; color: var(--v-accent); font-size: 12px; font-weight: 500; }
.v-pg .r { margin: 0 0 12px; cursor: pointer; }
.v-pg .r:last-child { margin-bottom: 0; }
.v-pg .top { display: flex; justify-content: space-between; color: var(--v-ink); font-size: 13px; margin-bottom: 6px; }
.v-pg .top span:last-child { color: var(--v-dim); font-variant-numeric: tabular-nums; font-size: 12px; }
.v-pg .bar { height: 6px; border-radius: 6px; background: var(--v-surface); overflow: hidden; }
.v-pg .bar i { display: block; height: 100%; border-radius: 6px; background: var(--v-accent); transform-origin: left; animation: v-grow 400ms cubic-bezier(.22,1,.36,1) backwards; }
.v-json details { margin-left: 12px; } .v-json summary { cursor: pointer; color: var(--v-dim); }
.v-json .k { color: var(--v-strong); } .v-json .s { color: #8fc49a; } .v-json .n { color: #e0b45a; } .v-json .b { color: #6aa8e6; }
.v-json div { margin-left: 12px; font: 13px/1.6 "CaskaydiaCove NF", "Cascadia Code", Consolas, monospace; }
.v-todo { list-style: none; margin: 0; padding: 0; }
.v-todo li { display: grid; grid-template-columns: 20px 1fr auto; gap: 12px; align-items: start; padding: 8px; border-radius: 8px; transition: background 150ms, opacity 250ms; }
.v-todo li:hover { background: var(--v-surface); }
.v-todo .box { width: 16px; height: 16px; margin-top: 2px; border-radius: 5px; box-shadow: inset 0 0 0 1.5px var(--v-dim); cursor: pointer; display: grid; place-items: center; transition: background 150ms, box-shadow 150ms; }
.v-todo .box svg { width: 11px; height: 11px; stroke: var(--v-bg); stroke-width: 3; fill: none; stroke-dasharray: 14; stroke-dashoffset: 14; transition: stroke-dashoffset 250ms cubic-bezier(.22,1,.36,1) 80ms; }
.v-todo li.done .box { background: #5fbf8f; box-shadow: none; }
.v-todo li.done .box svg { stroke-dashoffset: 0; }
.v-todo li.done .t { color: var(--v-dim); text-decoration: line-through; text-decoration-color: var(--v-line); }
.v-todo .t { color: var(--v-ink); font-size: 14px; line-height: 1.45; }
.v-todo .go { opacity: 0; border: 0; border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 12px; font-weight: 500; color: var(--v-strong); background: var(--v-surface); cursor: pointer; transition: opacity 150ms, background 150ms; white-space: nowrap; }
.v-todo .go:hover { background: var(--v-hover); }
.v-todo li:hover .go { opacity: 1; }
.v-todo-add { display: flex; gap: 8px; margin-top: 8px; }
.v-todo-add input { flex: 1; border: 0; border-radius: 10px; padding: 8px 12px; font: inherit; font-size: 13px; color: var(--v-ink); background: var(--v-surface); outline: none; transition: box-shadow 150ms; }
.v-todo-add input:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--v-accent) 60%, transparent); }
@keyframes v-grow { from { transform: scaleX(0); } to { transform: none; } }
@keyframes v-rise { from { transform: scaleY(0); } to { transform: none; } }
svg.v-chart .v-bar { transform-box: fill-box; transform-origin: bottom; animation: v-rise 400ms cubic-bezier(.22,1,.36,1) backwards; }
svg.v-chart .v-val { animation: v-fade 400ms cubic-bezier(.22,1,.36,1) backwards; }
@keyframes v-fade { from { opacity: 0; } to { opacity: 1; } }
`

/** Runs inside the document: draws `window.EMBER_VIEW` with `window.EMBER_DATA`. */
const VIEW_RUNTIME = String(function draw() {
  const w = window as unknown as { EMBER_VIEW: string; EMBER_DATA: Record<string, unknown>; EMBER_THEME: ViewTheme; EMBER_TITLE: string }
  const T = w.EMBER_THEME
  const D = (w.EMBER_DATA ?? {}) as Record<string, any>
  const root = document.getElementById('v-root')!
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, '')) || 0)
  const fmt = (v: number) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v * 100) / 100))
  // Clicking an item fills the prompt with a question about it, for the user to finish.
  const ask = (text: string) => `data-ember-send="${esc(`About ${w.EMBER_TITLE ? `"${w.EMBER_TITLE}" — ` : ''}${text}: `)}" data-ember-submit="0"`
  const tip = document.createElement('div')
  tip.className = 'v-tip'
  document.body.appendChild(tip)
  document.addEventListener('mousemove', (e) => {
    const t = (e.target as Element).closest?.('[data-tip]')
    if (!t) return tip.classList.remove('on')
    tip.textContent = t.getAttribute('data-tip')
    tip.style.left = `${e.clientX + 12}px`
    tip.style.top = `${e.clientY + 12}px`
    tip.classList.add('on')
  })
  const color = (i: number) => T.cats[i % T.cats.length]!
  const legend = (names: string[]) =>
    names.length > 1 ? `<div class="v-legend">${names.map((n, i) => `<span><i style="background:${color(i)}"></i>${esc(n)}</span>`).join('')}</div>` : ''
  const series = (): { labels: string[]; series: Array<{ name: string; values: number[] }> } => {
    const labels = (D.labels ?? D.x ?? []).map(String)
    const s = Array.isArray(D.series) ? D.series : [{ name: D.name ?? '', values: D.values ?? D.y ?? [] }]
    return { labels, series: s.map((x: any) => ({ name: String(x.name ?? ''), values: (x.values ?? []).map(num) })) }
  }
  const nice = (max: number) => {
    if (max <= 0) return [0, 1]
    const p = Math.pow(10, Math.floor(Math.log10(max)) - 1)
    const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100].map((m) => m * p).find((s) => max / s <= 6) ?? p * 100
    return [Math.ceil(max / step) * step, step]
  }
  const axes = (W: number, H: number, L: number, top: number, maxV: number, step: number) => {
    let g = ''
    for (let v = 0; v <= maxV + 1e-9; v += step) {
      const y = top + H - (v / maxV) * H
      g += `<line class="${v === 0 ? 'v-base' : 'v-grid'}" x1="${L}" x2="${W}" y1="${y}" y2="${y}"/><text x="${L - 10}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`
    }
    return g
  }

  const views: Record<string, () => string> = {
    bar() {
      const { labels, series: S } = series()
      const W = 640, H = 220, L = 40, top = 22
      const [maxV, step] = nice(Math.max(1, ...S.flatMap((s) => s.values)))
      const band = (W - L) / Math.max(1, labels.length)
      const bw = Math.min(48, (band * 0.62) / S.length)
      // A bar with only its top corners rounded.
      const bar = (x: number, y: number, w: number, h: number) => {
        const r = Math.min(6, w / 2, h)
        return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
      }
      let out = axes(W, H, L, top, maxV!, step!)
      labels.forEach((lab, i) => {
        const x0 = L + i * band + (band - bw * S.length) / 2
        S.forEach((s, j) => {
          const v = s.values[i] ?? 0
          const h = (v / maxV!) * H
          const x = x0 + j * bw
          const w = bw - (S.length > 1 ? 4 : 0)
          out += `<path class="v-hit v-bar" style="animation-delay:${i * 40}ms" d="${bar(x, top + H - h, w, Math.max(h, 0.5))}" fill="${color(j)}" data-tip="${esc(`${lab}${s.name ? ` · ${s.name}` : ''}: ${fmt(v)}`)}" ${ask(`${lab}${s.name ? ` (${s.name})` : ''}, ${fmt(v)}`)}/>`
          out += `<text class="v-val" style="animation-delay:${i * 40 + 200}ms" x="${x + w / 2}" y="${top + H - h - 8}" text-anchor="middle">${fmt(v)}</text>`
        })
        out += `<text x="${L + i * band + band / 2}" y="${top + H + 20}" text-anchor="middle">${esc(lab.length > 16 ? lab.slice(0, 15) + '…' : lab)}</text>`
      })
      return `<svg class="v-chart" viewBox="0 0 ${W} ${top + H + 32}">${out}</svg>${legend(S.map((s) => s.name))}`
    },
    line() {
      return views['area']!.call({ fill: false } as never)
    },
    area(this: { fill?: boolean } | void) {
      const fill = !(this && (this as { fill?: boolean }).fill === false)
      const { labels, series: S } = series()
      const W = 640, H = 240, L = 44, top = 10
      const [maxV, step] = nice(Math.max(1, ...S.flatMap((s) => s.values)))
      const dx = (W - L) / Math.max(1, labels.length - 1)
      let out = axes(W, H, L, top, maxV!, step!)
      S.forEach((s, j) => {
        const pts = s.values.map((v, i) => [L + i * dx, top + H - (v / maxV!) * H] as const)
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('')
        if (fill) out += `<path d="${d}L${pts[pts.length - 1]?.[0] ?? L},${top + H}L${L},${top + H}Z" fill="${color(j)}" opacity=".16"/>`
        out += `<path d="${d}" fill="none" stroke="${color(j)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
        pts.forEach((p, i) => {
          out += `<circle class="v-hit" cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${color(j)}" stroke="var(--v-bg)" stroke-width="1.5" data-tip="${esc(`${labels[i] ?? ''}${s.name ? ` · ${s.name}` : ''}: ${fmt(s.values[i]!)}`)}" ${ask(`${labels[i] ?? ''}${s.name ? ` (${s.name})` : ''}, ${fmt(s.values[i]!)}`)}/>`
        })
      })
      const every = Math.ceil(labels.length / 10)
      labels.forEach((lab, i) => {
        if (i % every === 0) out += `<text x="${L + i * dx}" y="${top + H + 18}" text-anchor="middle">${esc(lab)}</text>`
      })
      return `<svg class="v-chart" viewBox="0 0 ${W} ${H + 30}">${out}</svg>${legend(S.map((s) => s.name))}`
    },
    pie() {
      const { labels, series: S } = series()
      const vals = S[0]?.values ?? []
      const total = vals.reduce((a, b) => a + b, 0) || 1
      let a0 = -Math.PI / 2, out = ''
      const R = 90, r = 56, cx = 110, cy = 110
      vals.forEach((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2
        const large = a1 - a0 > Math.PI ? 1 : 0
        const p = (a: number, rad: number) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`
        out += `<path class="v-hit" d="M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r},${r} 0 ${large} 0 ${p(a0, r)}Z" fill="${color(i)}" data-tip="${esc(`${labels[i]}: ${fmt(v)} (${Math.round((v / total) * 100)}%)`)}" ${ask(`${labels[i]}, ${fmt(v)}`)}/>`
        a0 = a1
      })
      out += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" style="fill:var(--v-strong);font-size:22px;font-weight:650">${fmt(total)}</text><text x="${cx}" y="${cy + 16}" text-anchor="middle">total</text>`
      const leg = labels.map((l, i) => `<span><i style="background:${color(i)}"></i>${esc(l)} · ${Math.round(((vals[i] ?? 0) / total) * 100)}%</span>`).join('')
      return `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap"><svg class="v-chart" viewBox="0 0 220 220" style="max-width:220px">${out}</svg><div class="v-legend" style="flex-direction:column;gap:6px">${leg}</div></div>`
    },
    stats() {
      const items: any[] = D.items ?? D.stats ?? []
      return `<div class="v-stats">${items
        .map((s) => {
          const d = s.delta == null ? '' : String(s.delta)
          const up = /^\+|^[0-9]/.test(d) && !/^-/.test(d)
          return `<div class="v-stat" ${ask(`${s.label}, ${s.value}`)}><div class="l">${esc(s.label)}</div><div class="n">${esc(s.value)}</div>${d ? `<div class="d ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${esc(d.replace(/^[+-]/, ''))}</div>` : ''}${s.hint ? `<div class="h">${esc(s.hint)}</div>` : ''}</div>`
        })
        .join('')}</div>`
    },
    table() {
      const cols: string[] = (D.columns ?? []).map(String)
      const rows: unknown[][] = D.rows ?? []
      const numeric = cols.map((_, c) => rows.length > 0 && rows.every((r) => r[c] === '' || r[c] == null || !isNaN(num(r[c])) && /^[\s$€£%+\-0-9.,kKmM]+$/.test(String(r[c]))))
      const html = `<table class="v-table"><thead><tr>${cols.map((c, i) => `<th data-c="${i}" class="${numeric[i] ? 'num' : ''}">${esc(c)}<span class="s"></span></th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr ${ask(String(r[0] ?? ''))}>${cols.map((_, i) => `<td class="${numeric[i] ? 'num' : ''}">${esc(r[i] ?? '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
      setTimeout(() => {
        let by = -1, dir = 1
        document.querySelectorAll<HTMLElement>('.v-table th').forEach((th) =>
          th.addEventListener('click', () => {
            const c = Number(th.dataset['c'])
            dir = by === c ? -dir : 1
            by = c
            const body = document.querySelector('.v-table tbody')!
            const trs = Array.from(body.querySelectorAll('tr'))
            trs.sort((a, b) => {
              const x = a.children[c]!.textContent ?? '', y = b.children[c]!.textContent ?? ''
              return (numeric[c] ? num(x) - num(y) : x.localeCompare(y)) * dir
            })
            trs.forEach((t) => body.appendChild(t))
            document.querySelectorAll('.v-table th .s').forEach((s, i) => (s.textContent = i === c ? (dir > 0 ? '▲' : '▼') : ''))
          })
        )
      })
      return html
    },
    timeline() {
      const items: any[] = D.items ?? []
      return `<div class="v-tl">${items.map((it) => `<div class="it" ${ask(String(it.title ?? ''))}><div class="w">${esc(it.when ?? it.date ?? '')}</div><div class="t">${esc(it.title ?? '')}</div>${it.text ? `<div class="x">${esc(it.text)}</div>` : ''}</div>`).join('')}</div>`
    },
    kanban() {
      const cols: any[] = D.columns ?? []
      return `<div class="v-kb">${cols
        .map((c) => {
          const cards: any[] = c.cards ?? c.items ?? []
          return `<div class="col"><div class="h"><span>${esc(c.name ?? c.title ?? '')}</span><span>${cards.length}</span></div>${cards
            .map((k) => (typeof k === 'string' ? `<div class="card" ${ask(k)}>${esc(k)}</div>` : `<div class="card" ${ask(String(k.title ?? ''))}><b>${esc(k.title ?? '')}</b>${k.text ? `<span>${esc(k.text)}</span>` : ''}</div>`))
            .join('')}</div>`
        })
        .join('')}</div>`
    },
    compare() {
      const items: any[] = D.items ?? []
      return `<div class="v-cmp">${items
        .map((c) => `<div class="c${c.best || c.winner ? ' win' : ''}" ${ask(String(c.title ?? ''))}><div class="t">${esc(c.title ?? '')}</div><ul>${(c.points ?? []).map((p: unknown) => `<li>${esc(p)}</li>`).join('')}</ul>${c.verdict ? `<div class="v">${esc(c.verdict)}</div>` : ''}</div>`)
        .join('')}</div>`
    },
    progress() {
      const items: any[] = D.items ?? []
      return `<div class="v-pg">${items
        .map((it, i) => {
          const max = num(it.max ?? 100) || 100
          const v = num(it.value)
          const pct = Math.max(0, Math.min(100, (v / max) * 100))
          return `<div class="r" ${ask(String(it.label ?? ''))}><div class="top"><span>${esc(it.label ?? '')}</span><span>${it.max ? `${fmt(v)} / ${fmt(max)}` : `${Math.round(pct)}%`}</span></div><div class="bar"><i style="width:${pct}%;background:${color(i)};animation-delay:${i * 60}ms"></i></div></div>`
        })
        .join('')}</div>`
    },
    json() {
      const node = (v: any, k?: string): string => {
        const key = k != null ? `<span class="k">${esc(k)}</span>: ` : ''
        if (v && typeof v === 'object') {
          const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v)
          return `<details ${k == null ? 'open' : ''}><summary>${key}${Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`}</summary>${entries.map(([kk, vv]) => node(vv, kk)).join('')}</details>`
        }
        const cls = typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : 'b'
        return `<div>${key}<span class="${cls}">${esc(typeof v === 'string' ? JSON.stringify(v) : String(v))}</span></div>`
      }
      return `<div class="v-json">${node(D.value ?? D)}</div>`
    },
  }
  // The todo list: tick, add, or hand an item to this session. Changes go to the real list.
  views['todo'] = () => {
    const items: Array<{ text: string; done: boolean }> = D.items ?? []
    const post = (msg: unknown) => {
      try {
        parent.postMessage({ emberTodo: msg }, '*')
      } catch {}
    }
    setTimeout(() => {
      document.querySelectorAll<HTMLElement>('.v-todo li').forEach((li) => {
        li.querySelector('.box')?.addEventListener('click', () => {
          li.classList.toggle('done')
          post({ op: 'toggle', text: li.dataset['t'] })
        })
      })
      const input = document.querySelector<HTMLInputElement>('.v-todo-add input')
      input?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return
        post({ op: 'add', text: input.value.trim() })
        input.value = ''
      })
    })
    const open = items.filter((i) => !i.done)
    const done = items.filter((i) => i.done).slice(-5)
    return (
      `<ul class="v-todo">${[...open, ...done]
        .map(
          (it) =>
            `<li class="${it.done ? 'done' : ''}" data-t="${esc(it.text)}"><span class="box"><svg viewBox="0 0 12 12"><path d="M2 6.5l2.5 2.5L10 3.5"/></svg></span><span class="t">${esc(it.text)}</span>` +
            (it.done ? '' : `<button type="button" class="go" data-ember-send="${esc(`Do this from my todo list: ${it.text}`)}" data-ember-submit="1">do it here</button>`) +
            `</li>`
        )
        .join('')}</ul>` + `<div class="v-todo-add"><input placeholder="Add a todo… (Enter)"></div>`
    )
  }
  const v = views[w.EMBER_VIEW]
  root.innerHTML = v ? v() : `<p>Unknown view "${esc(w.EMBER_VIEW)}".</p>`
})

/** The page for a data view: the theme as CSS variables, the data, and the drawing code. */
export function viewDocument(view: string, data: unknown, title: string, theme: ViewTheme, bg: string): string {
  const vars = `:root{--v-accent:${theme.accent};--v-ink:${theme.ink};--v-strong:${theme.strong};--v-dim:${theme.dim};--v-line:${theme.line};--v-surface:${theme.surface};--v-hover:color-mix(in srgb, ${theme.surface} 100%, ${theme.ink} 6%);--v-raised:color-mix(in srgb, ${theme.surface} 100%, ${theme.ink} 4%);--v-bg:${bg};--v-tipbg:${bg}}`
  const json = (x: unknown) => JSON.stringify(x).replace(/</g, '\\u003c')
  return (
    `<style>${vars}${VIEW_STYLE}</style><div class="v-wrap"><div id="v-root"></div></div>` +
    `<script>window.EMBER_VIEW=${json(view)};window.EMBER_DATA=${json(data)};window.EMBER_TITLE=${json(title)};window.EMBER_THEME=${json(theme)};(${VIEW_RUNTIME})()</script>`
  )
}

/** A view the session defined: its own page, given the data and the theme before it runs. */
export function customViewDocument(template: string, data: unknown, title: string, theme: ViewTheme): string {
  const json = (x: unknown) => JSON.stringify(x).replace(/</g, '\\u003c')
  const inject = `<script>window.EMBER_DATA=${json(data)};window.EMBER_TITLE=${json(title)};window.EMBER_THEME=${json(theme)};</script>`
  const at = template.search(/<head[^>]*>/i)
  if (at === -1) return inject + template
  const end = template.indexOf('>', at) + 1
  return template.slice(0, end) + inject + template.slice(end)
}
