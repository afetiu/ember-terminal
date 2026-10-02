/**
 * The map's small vocabulary: one glyph per kind of part and per kind of note, and the
 * few words that go with them. Stroke-only, currentColor, 16px grid — so they take the
 * colour of whatever they sit in.
 */

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const KIND_GLYPH: Record<string, string> = {
  system: svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/>'),
  group: svg('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 6h12"/>'),
  repo: svg('<path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10H4.5A1.5 1.5 0 0 0 3 13.5z"/><path d="M3 13.5A1.5 1.5 0 0 0 4.5 15H13v-3"/>'),
  app: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12M4 4.5h.01M5.6 4.5h.01"/>'),
  service: svg('<rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M4.5 4.75h.01M4.5 11.25h.01"/>'),
  component: svg('<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/>'),
  module: svg('<path d="M5 3 2 8l3 5M11 3l3 5-3 5"/>'),
  datastore: svg('<ellipse cx="8" cy="3.8" rx="5.5" ry="2"/><path d="M2.5 3.8v8.4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.8M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>'),
  queue: svg('<rect x="1.5" y="5" width="13" height="6" rx="3"/><path d="M5 5v6M8 5v6M11 5v6"/>'),
  infra: svg('<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><circle cx="8" cy="8" r="2"/>'),
  external: svg('<path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7-.7 2.8 2.8 0 0 1 .3 5.6z"/>'),
  job: svg('<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6 1.5h4"/>'),
  doc: svg('<path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6 8h4.5M6 10.5h4.5"/>'),
}

export const KIND_WORD: Record<string, string> = {
  system: 'system',
  group: 'area',
  repo: 'repo',
  app: 'app',
  service: 'service',
  component: 'component',
  module: 'module',
  datastore: 'data',
  queue: 'queue',
  infra: 'infra',
  external: 'external',
  job: 'job',
  doc: 'doc',
}

export const NOTE_GLYPH: Record<string, string> = {
  risk: svg('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.5h.01"/>'),
  question: svg('<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.2h.01"/>'),
  decision: svg('<path d="M8 14V8M8 8 3.5 3.5M8 8l4.5-4.5M2.5 6V3h3M13.5 6V3h-3"/>'),
  pr: svg('<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6.5A2.5 2.5 0 0 0 9.5 4H7M8.5 2.5 7 4l1.5 1.5"/>'),
  issue: svg('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1"/>'),
  todo: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.5 8 1.8 1.8 3.2-3.6"/>'),
  cost: svg('<path d="M11.5 4.2A4.5 4.5 0 1 0 11.5 11.8M2.5 7h6.5M2.5 9h6.5"/>'),
  date: svg('<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/>'),
  person: svg('<circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14a5.5 5.5 0 0 1 11 0"/>'),
  note: svg('<path d="M3 2.5h10v8l-3 3H3z"/><path d="M10 13.5v-3h3"/>'),
}

export const NOTE_WORD: Record<string, string> = {
  risk: 'Risks',
  question: 'Open questions',
  decision: 'Decisions waiting',
  pr: 'Pull requests',
  issue: 'Issues',
  todo: 'To do',
  cost: 'Costs',
  date: 'Dates',
  person: 'People',
  note: 'Notes',
}

export const ICON = {
  ask: svg('<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/><path d="M6.5 6.2a1.5 1.5 0 1 1 1.9 1.4c-.3.1-.4.4-.4.7"/>'),
  change: svg('<path d="m10.5 2.5 3 3L6 13H3v-3z"/>'),
  blast: svg('<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4.5" stroke-dasharray="2 1.6"/><circle cx="8" cy="8" r="7" stroke-dasharray="1.5 2"/>'),
  shell: svg('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3.5"/>'),
  link: svg('<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/>'),
  play: svg('<path d="M5 3.5v9l7-4.5z"/>'),
  pause: svg('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
  prev: svg('<path d="M10.5 3.5 5.5 8l5 4.5"/>'),
  next: svg('<path d="m5.5 3.5 5 4.5-5 4.5"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  flow: svg('<circle cx="3" cy="8" r="1.5"/><circle cx="13" cy="4" r="1.5"/><circle cx="13" cy="12" r="1.5"/><path d="M4.5 8h3.5M8 8c1.5 0 2-4 3.5-4M8 8c1.5 0 2 4 3.5 4"/>'),
  clock: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  fit: svg('<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>'),
  more: svg('<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/>'),
  legend: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.5V11M8 5h.01"/>'),
  replay: svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.5v3h3"/>'),
  back: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>'),
  eye: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  pen: svg('<path d="m10.5 2.5 3 3L6 13H3v-3z"/>'),
}

/** Enough markdown for an answer or a part's details: headings, lists, code, emphasis, links. */
export function md(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" data-href="$2">$1</a>')
  const out: string[] = []
  const lines = src.replace(/\r/g, '').split('\n')
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const endPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const endList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      endPara()
      endList()
      const code: string[] = []
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!)
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      endPara()
      endList()
      out.push(`<h4>${inline(h[2]!)}</h4>`)
      continue
    }
    const li = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      endPara()
      const want = /\d/.test(li[1]!) ? 'ol' : 'ul'
      if (list !== want) {
        endList()
        out.push(`<${want}>`)
        list = want
      }
      out.push(`<li>${inline(li[2]!)}</li>`)
      continue
    }
    if (!line.trim()) {
      endPara()
      endList()
      continue
    }
    endList()
    para.push(line.trim())
  }
  endPara()
  endList()
  return out.join('')
}

/** "just now", "14m ago", "yesterday", "12 Sep". */
export function ago(at?: string | number): string {
  if (at === undefined || at === '') return 'never'
  const t = typeof at === 'number' ? at : Date.parse(at)
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Hues for top-level areas: each area is a soft zone of its own colour. */
export const AREA_HUES = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#73daca', '#ff9e64', '#c0caf5']

/** Colours for live sessions, distinct from the area hues' job. */
export const SESSION_HUES = ['#ff7eb6', '#4ce0b3', '#ffc857', '#6ea8ff', '#c49bff', '#ff9966', '#5ee7ff']

/**
 * The same two palettes for a light theme, index for index, so an area keeps its colour
 * when the theme flips. The dark ones are pastels picked to glow on near-black; on paper
 * they wash out, and the parts' names and glyphs are drawn in them.
 */
const AREA_HUES_LIGHT = ['#3562c9', '#4f8a1f', '#a8701a', '#7a4fd0', '#1f80b8', '#c93a58', '#1d8f7f', '#c25a1c', '#5a6491']
const SESSION_HUES_LIGHT = ['#c8327a', '#0b8a62', '#a86a00', '#2f63c4', '#7a4fd0', '#c2541c', '#0a7f99']

const onLight = () => document.body.classList.contains('is-light')

/** The area palette for the theme that is on now. */
export function areaHues(): string[] {
  return onLight() ? AREA_HUES_LIGHT : AREA_HUES
}

/** The live-session palette for the theme that is on now. */
export function sessionHues(): string[] {
  return onLight() ? SESSION_HUES_LIGHT : SESSION_HUES
}

export function hueFor(key: string, palette: string[]): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return palette[h % palette.length]!
}
