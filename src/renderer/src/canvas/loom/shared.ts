import { escapeHtml } from '../markdown'

/**
 * What the canvas's parts share: the shapes they pass round (a piece, a dock, an edge),
 * the icons, the one curve everything moves on, and a few small helpers. Nothing here
 * holds state.
 */

export type Mode = 'shell' | 'claude' | 'agent' | 'app' | 'raw'

export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface Dock {
  /** First and last viewport rows that stay visible. */
  top: number
  bottom: number
  /** A dialog or a menu rather than the input box: worth drawing the eye to. */
  dialog: boolean
  /** The input box's own rows (the prompt and its continuation lines), when it was found. */
  box: [number, number] | null
  /** The rules that open and close the box, -1 when not on screen. */
  open: number
  close: number
  /** First row of the status lines under the box, when there is no closing rule (Codex). */
  foot?: number
}

export interface Piece {
  el: HTMLElement
  body: HTMLElement
  title: string
  format: string
  frame?: HTMLIFrameElement
  /** Where a pinned piece is docked; the text keeps clear of that edge. None: it floats. */
  dock?: Side | null
  /** Snapped to an edge: part of the layout there, not floating over it. */
  snap?: Side | null
  /** The file it shows, when it came from show_file (a note can then be edited in place). */
  file?: string
  /** The plan step it was shown during, so the step can carry it. */
  step?: string
  /** Extra menu entries this kind of object has (a page: reload, open outside). */
  extra?: Array<[string, string, () => void]>
  /** Its size while floating, to go back to when it leaves a snap. */
  free?: { w: number; h: number }
  /** A diagram lifted out of a reply: its mermaid source, so the session can edit it. */
  source?: string
}

export interface Browser {
  piece: Piece
  view: WebviewTag
  legend: HTMLElement
  ready: Promise<void>
}

/** The parts of Electron's <webview> used here; see Panel.ts for why it is declared locally. */
export interface WebviewTag extends HTMLElement {
  getURL(): string
  isLoading(): boolean
  reload(): void
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
}

/** Canvas | CLI: the two ways to see an agent tab, as one switch. */
export function viewSwitch(cli: boolean): string {
  return (
    `<span class="loom-view-switch" role="group" aria-label="View">` +
    `<button type="button" data-view="canvas" class="${cli ? '' : 'is-on'}" aria-pressed="${!cli}" title="Ember's canvas (Ctrl+\`)">Canvas</button>` +
    `<button type="button" data-view="cli" class="${cli ? 'is-on' : ''}" aria-pressed="${cli}" title="The agent's own screen (Ctrl+\`)">CLI</button>` +
    `</span>`
  )
}

/** Line icons, drawn in the text colour, so the controls read as part of the terminal. */
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
export const ICON = {
  pin: svg('<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
  grip: svg('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  expand: svg('<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>'),
  fold: svg('<path d="M5 12h14"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  check: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>'),
  note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>'),
  diagram: svg('<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M7 16v-4"/><path d="M12 16V8"/><path d="M17 16v-7"/>'),
  page: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18"/><path d="M9 21V9"/>'),
  doc: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h6"/>'),
  code: svg('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/>'),
  table: svg('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M3 15h18M12 3v18"/>'),
  terminal: svg('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
  notes: svg('<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5Z"/><path d="M15 3v6h6"/>'),
  sparkle: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
  hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  eye: svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
  restore: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  ask: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  reload: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  out: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
}

/** The icon a kind of object carries in its title bar and its chip. */
export function iconFor(format: string): string {
  return format === 'mermaid' ? ICON.diagram : format === 'view' ? ICON.chart : format === 'html' ? ICON.page : format === 'code' ? ICON.code
    : format === 'url' ? ICON.globe : format === 'media' || format === 'image' ? ICON.image : format === 'table' ? ICON.table : ICON.doc
}

/** One curve and one pace for everything that moves, so it all feels like one thing. */
export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
export const ms = (n: number) => (reduced() ? 0 : n)

/** The bar under the input box, and the breathing room inside its frame, in px. */
export const BAR_H = 26
export const FRAME_PAD = 10
/** The input is at least this many rows tall, prompt at the top, like a text area. */
export const INPUT_ROWS = 2
/** How much of another agent's own screen stays visible under the canvas: its input and status. */
export const AGENT_ROWS = 10

/** Up to four objects per edge; a fifth does not snap. */
export const SNAPS_PER_EDGE = 4

/** What in a reply can be picked up and placed: diagrams, tables, code, pictures. */
export const LIFTABLE = '.loom-diagram, .loom-table, .loom-code, .loom-say img.loom-img, .loom-shelf .loom-figure, .loom-tool-peek .loom-figure'

export function div(cls: string, html?: string): HTMLElement {
  const e = document.createElement('div')
  e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tok` : n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`
}

/** A todo's text: markdown links become short clickable words; everything else stays text. */
export function linkify(text: string): string {
  return escapeHtml(text).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label: string, url: string) => `<a class="loom-link" href="${url}">${label}</a>`)
}

/**
 * Whether an agent message is a result rather than narration: it has structure (a table,
 * a list, a heading, code, an object) or it is long. "Let me check the config" is not;
 * a gap list or a go/no-go table is, and must not vanish when the turn ends on a one-liner.
 */
export function holdsResult(say: HTMLElement): boolean {
  if (say.querySelector('table, ul, ol, pre, h1, h2, h3, h4, blockquote, img, iframe, .loom-diagram, .loom-liftable')) return true
  return (say.textContent ?? '').trim().length > 320
}

export function sameTitle(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  return n(a) === n(b)
}

export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '')
  return norm(a) === norm(b)
}
