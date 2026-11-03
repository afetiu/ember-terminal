import { randomBytes } from 'node:crypto'
import type { PanelOption, PanelPush } from '../shared/types.js'
import { customViewDocument, viewDocument, type ViewTheme } from './panelView.js'

/**
 * Turn a pushed panel into the page the panel webview loads.
 *
 * Rendering happens in main rather than the renderer for one reason: the output is
 * model-authored, and main can hand it to a webview on the bridge's origin, where it
 * has no preload, no node, and no `window.ember` to reach. Doing the same work in the
 * renderer would mean injecting untrusted markup into the process that holds the IPC
 * handles, which is the whole thing worth avoiding.
 *
 * The markdown subset is deliberately small — headings, emphasis, code, lists, tables,
 * quotes, rules, links, images. It exists so Claude can explain something without a
 * dependency, not to be a spec-complete parser. Anything richer is what 'html' is for.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The inverse of `escapeHtml`, for text that has been escaped once and now has to be
 * read as itself again — `ember:` link targets, which are decoded and then re-escaped
 * into an attribute. Without this round trip an `&` in a command comes out as `&amp;`.
 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** Only http(s) and data:image survive. Blocks `javascript:` in links and images. */
function safeUrl(raw: string): string {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url)) return escapeHtml(url)
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url)) return escapeHtml(url)
  if (/^\/doc\//.test(url)) return escapeHtml(url)
  return ''
}

/** Inline spans, applied to already-escaped text. */
function inline(text: string): string {
  let out = escapeHtml(text)

  // Code first: whatever is inside a span of backticks must not then be read as
  // emphasis, so it is lifted out and put back after everything else has run.
  const codes: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, href: string) => {
    const url = safeUrl(href)
    return url ? `<img alt="${alt}" src="${url}">` : m
  })
  // `[Do the thing](ember:npm run build)` is a button that types into the terminal
  // rather than a link that goes somewhere. `ember-type:` fills the prompt and leaves
  // Enter to the user, which is what you want for a command worth reading first.
  out = out.replace(/\[([^\]]+)\]\((ember(?:-type)?):([^)]*)\)/g, (_m, label: string, scheme: string, arg: string) => {
    const raw = unescapeHtml(arg.trim())
    let value = raw
    try {
      value = decodeURIComponent(raw)
    } catch {
      /* A literal `%` is far likelier than a broken escape; keep what was written. */
    }
    const send = value ? escapeHtml(value) : label
    const submit = scheme === 'ember' ? '1' : '0'
    return `<button type="button" class="ember-act" data-ember-send="${send}" data-ember-submit="${submit}">${label}</button>`
  })

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    const url = safeUrl(href)
    return url ? `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>` : m
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ''}</code>`)
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  const closeList = (stack: string[]): void => {
    while (stack.length) out.push(`</${stack.pop()}>`)
  }
  const listStack: string[] = []

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // Fenced code. A `mermaid` fence becomes a diagram rather than a listing.
    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      closeList(listStack)
      const lang = (fence[1] ?? '').toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++
      const text = body.join('\n')
      out.push(
        lang === 'mermaid'
          ? `<pre class="mermaid">${escapeHtml(text)}</pre>`
          : `<pre class="code"><code data-lang="${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>`
      )
      continue
    }

    // Table: a header row followed by a delimiter row of dashes.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      closeList(listStack)
      const head = tableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) rows.push(tableRow(lines[i++] ?? ''))
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          `</tbody></table>`
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList(listStack)
      const level = (heading[1] ?? '#').length
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeList(listStack)
      out.push('<hr>')
      i++
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      closeList(listStack)
      const body: string[] = [quote[1] ?? '']
      i++
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      }
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`)
      continue
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      const wanted = /^\d/.test(item[2] ?? '') ? 'ol' : 'ul'
      if (listStack[listStack.length - 1] !== wanted) {
        closeList(listStack)
        listStack.push(wanted)
        out.push(`<${wanted}>`)
      }
      out.push(`<li>${inline(item[3] ?? '')}</li>`)
      i++
      continue
    }

    if (!line.trim()) {
      closeList(listStack)
      i++
      continue
    }

    // Paragraph: keep consuming until a blank line or something that starts a block.
    closeList(listStack)
    const para: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (!l.trim() || /^\s*(?:```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(l)) break
      para.push(l)
      i++
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`)
  }

  closeList(listStack)
  return out.join('\n')
}

/**
 * The panel's stylesheet.
 *
 * It reads as Ember rather than as a document because the panel sits beside the
 * terminal and a white page next to a dark one is a hole in the window. Colours are
 * left as literals: this page is served from the bridge, not the renderer, so it has
 * no access to the app's CSS variables and re-plumbing them per push would cost more
 * than it is worth.
 */
const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
/* One type system with the canvas: prose in the text face, code alone in monospace;
   sizes from the scale (12/13/14/16/20/26), spacing on a 4px grid, no frames of its own. */
body {
  padding: 16px 18px 24px;
  color: #d8d4dd;
  font: 400 14px/1.6 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif;
  overflow-wrap: anywhere;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4, h5, h6 { color: #f3f1f5; font-weight: 600; line-height: 1.25; letter-spacing: -0.012em; margin: 24px 0 8px; }
h1 { font-size: 26px; } h2 { font-size: 20px; } h3 { font-size: 16px; }
h4, h5, h6 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #a7a2ad; }
h1:first-child, h2:first-child, h3:first-child, h4:first-child { margin-top: 0; }
p { margin: 0 0 12px; }
a { color: #E08BFF; text-decoration: underline; text-decoration-color: rgba(224, 139, 255, 0.35); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
strong { color: #f3f1f5; font-weight: 600; }
em { color: inherit; }
code {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 1px 6px;
  font: 13px/1.5 "CaskaydiaCove NF", "Cascadia Code", Consolas, ui-monospace, monospace;
  color: #f3f1f5;
}
pre.code {
  background: rgba(255, 255, 255, 0.035);
  border-radius: 10px;
  padding: 12px 16px;
  overflow-x: auto;
  margin: 12px 0;
}
pre.code code { background: none; padding: 0; color: #d8d4dd; font-size: 13px; line-height: 1.55; }
pre.mermaid { background: none; border: 0; text-align: center; margin: 16px 0; }
.mm-fail { margin: 12px 0; padding: 12px 16px; border-radius: 10px; background: rgba(127, 127, 127, 0.07); }
.mm-fail-t { font-size: 12px; opacity: 0.7; margin-bottom: 8px; }
.mm-fail pre.code { margin: 0; max-height: 260px; overflow: auto; background: none; padding: 0; }
/* Pinned on a Loom screen and resized: the diagram fits the box it is given, both ways. */
.ember-fit body { padding: 8px 12px; }
.ember-fit pre.mermaid { margin: 0; }
.ember-fit pre.mermaid svg { max-height: calc(100vh - 24px); }
blockquote { margin: 12px 0; padding: 0 0 0 16px; border-left: 2px solid rgba(255, 255, 255, 0.14); color: #a7a2ad; }
ul, ol { margin: 0 0 12px; padding-left: 20px; }
li { margin: 4px 0; }
li::marker { color: #8a8590; }
hr { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.08); margin: 24px 0; }
img, svg { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; display: block; overflow-x: auto; font-size: 13px; }
th, td { border: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.07); padding: 8px 12px; text-align: left; vertical-align: top; }
th { background: none; color: #8a8590; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
tr:last-child td { border-bottom: 0; }
.ember-raw { color: #d8d4dd; }
`

/**
 * The same page for a light palette, laid over the one above.
 *
 * The panel's design is a dark one — pale lavender on a transparent webview over the
 * stage — and on a light theme that is pale text on paper, i.e. nothing. This keeps
 * the purple as the accent and inverts the rest. The renderer asks for it (?tone=light)
 * because only the renderer knows which theme is on; this page cannot read the app's CSS.
 */
const LIGHT_STYLE = `
:root { color-scheme: light; }
body { color: #2b2830; }
h1, h2, h3, strong { color: #141217; }
h4, h5, h6, th, blockquote { color: #6b6672; }
a { color: #7A22AE; text-decoration-color: rgba(122, 34, 174, 0.35); }
code { background: rgba(0, 0, 0, 0.05); color: #141217; }
pre.code { background: rgba(0, 0, 0, 0.03); }
pre.code code, .ember-raw { color: #2b2830; }
blockquote { border-left-color: rgba(0, 0, 0, 0.14); }
li::marker { color: #8a8590; }
hr { border-top-color: rgba(0, 0, 0, 0.08); }
th, td { border-bottom-color: rgba(0, 0, 0, 0.07); }
`

/** The controls and scrollbars on paper. Alone, this is what an authored page gets: its own design is left alone. */
const LIGHT_INTERACT = `
:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ember-ink, #555) 24%, transparent); background-clip: padding-box; }
.ember-act { border-color: color-mix(in srgb, var(--ember-accent, #B07A2A) 45%, transparent); background: color-mix(in srgb, var(--ember-accent, #B07A2A) 9%, transparent); color: var(--ember-ink, #2a2520); }
.ember-act:hover { background: color-mix(in srgb, var(--ember-accent, #B07A2A) 17%, transparent); border-color: color-mix(in srgb, var(--ember-accent, #B07A2A) 70%, transparent); }
.ember-act.is-sent { background: rgba(11, 122, 92, 0.12); border-color: rgba(11, 122, 92, 0.45); }
.ember-ask { border-color: color-mix(in srgb, var(--ember-accent, #B07A2A) 24%, transparent); background: color-mix(in srgb, var(--ember-accent, #B07A2A) 4%, transparent); }
.ember-ask-opt { border-color: color-mix(in srgb, var(--ember-accent, #B07A2A) 30%, transparent); background: color-mix(in srgb, var(--ember-accent, #B07A2A) 5%, transparent); color: var(--ember-ink, #2a2520); }
.ember-ask-opt:hover { background: color-mix(in srgb, var(--ember-accent, #B07A2A) 14%, transparent); border-color: color-mix(in srgb, var(--ember-accent, #B07A2A) 58%, transparent); }
.ember-ask-opt .hint { color: #5E5373; }
.ember-ask-free textarea { border-color: color-mix(in srgb, var(--ember-accent, #B07A2A) 30%, transparent); background: rgba(255, 255, 255, 0.7); color: var(--ember-ink, #2a2520); }
.ember-ask-sent { color: #0B7A5C; }
`

/**
 * Scrollbars that read as part of the panel rather than as part of a browser.
 *
 * Three things do the work. The thumb is a pill floated off the edge by a transparent
 * border with `background-clip: padding-box`, so it never touches the panel's border
 * and never looks welded to it. It is nearly invisible until the pointer is inside the
 * thing that scrolls — `:hover::-webkit-scrollbar-thumb`, which for the document means
 * "the pointer is somewhere in the panel at all" and is exactly the right condition.
 * And the arrow buttons are removed outright; nobody has clicked one this decade.
 *
 * Note the standard `scrollbar-width` / `scrollbar-color` properties are deliberately
 * *not* set. Chromium honours them in preference to the `::-webkit-scrollbar`
 * pseudo-elements, and setting either would silently throw all of this away in favour
 * of a thin grey bar.
 */
const SCROLLBARS = `
::-webkit-scrollbar { width: 12px; height: 12px; background: transparent; }
::-webkit-scrollbar-track { background: transparent; border: 0; }
::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
::-webkit-scrollbar-thumb {
  background: transparent;
  border: 3.5px solid transparent;
  border-radius: 99px;
  background-clip: padding-box;
  transition: background 180ms ease;
}
:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ember-ink, #bbb) 22%, transparent); background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--ember-ink, #bbb) 38%, transparent); background-clip: padding-box; }
::-webkit-scrollbar-thumb:active { background: color-mix(in srgb, var(--ember-ink, #bbb) 52%, transparent); background-clip: padding-box; }
`

/**
 * The controls, kept apart from the document styling above.
 *
 * A raw `html` push brings its own design and gets only this — enough that a button
 * the model put on its own page still looks like one of Ember's, without a stylesheet
 * arriving underneath it and moving everything else.
 */
const INTERACT_STYLE = `
/* Anything that answers back. A panel is a place to press as well as read, so the
   controls are sized to be pressed rather than to be unobtrusive. */
.ember-act {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 2px 4px 2px 0;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #f3f1f5;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.ember-act:hover { background: color-mix(in srgb, var(--ember-accent, #F2A43A) 24%, transparent); border-color: color-mix(in srgb, var(--ember-accent, #F2A43A) 60%, transparent); }
.ember-act:active { transform: translateY(1px); }
.ember-act.is-sent { background: rgba(120, 255, 190, 0.16); border-color: rgba(120, 255, 190, 0.4); }

.ember-ask {
  border: 1px solid transparent;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  padding: 16px;
  margin: 0 0 12px;
}
.ember-ask-q > :first-child { margin-top: 0; }
.ember-ask-q > :last-child { margin-bottom: 0; }
.ember-ask-options { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }

/* Options are full-width rows rather than a wrap of chips: they are usually sentences,
   and a two-line chip beside a one-line chip reads as a layout accident. */
.ember-ask-opt {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 13px;
  border: 1px solid color-mix(in srgb, var(--ember-accent, #F2A43A) 26%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ember-accent, #F2A43A) 8%, transparent);
  color: #F0EAFB;
  font: inherit;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.ember-ask-opt:hover { background: color-mix(in srgb, var(--ember-accent, #F2A43A) 20%, transparent); border-color: color-mix(in srgb, var(--ember-accent, #F2A43A) 55%, transparent); }
.ember-ask-opt .hint { display: block; margin-top: 3px; font-size: 0.86em; color: #A99DC4; }

.ember-ask-free { display: flex; gap: 8px; margin-top: 12px; align-items: flex-end; }
.ember-ask-free textarea {
  flex: 1;
  min-height: 38px;
  max-height: 180px;
  resize: vertical;
  padding: 8px 11px;
  border: 1px solid color-mix(in srgb, var(--ember-accent, #F2A43A) 24%, transparent);
  border-radius: 9px;
  background: rgba(12, 6, 22, 0.6);
  color: #E9DDFB;
  font: inherit;
  font-size: 0.95em;
  outline: none;
}
.ember-ask-free textarea:focus { border-color: color-mix(in srgb, var(--ember-accent, #F2A43A) 60%, transparent); }
.ember-ask-sent { margin-top: 12px; color: #8FE9C0; font-size: 0.92em; }
.ember-ask.is-answered .ember-ask-options,
.ember-ask.is-answered .ember-ask-free { display: none; }

/* What the picker paints while the user is choosing something to talk about. Injected
   from the renderer rather than shipped in the page, so it also applies to a website
   the panel happens to be browsing. */
html.ember-picking, html.ember-picking * { cursor: crosshair !important; }
.ember-pick-hover {
  outline: 2px solid var(--ember-accent, #F2A43A) !important;
  outline-offset: 1px !important;
  background: color-mix(in srgb, var(--ember-accent, #F2A43A) 12%, transparent) !important;
}
`

/**
 * The page's half of the conversation.
 *
 * One job, and it has to run inside the document rather than out here: press anything
 * carrying `data-ember-send` and it types into the terminal.
 *
 * Only a press the user made counts. A model-authored page has scripts of its own, and a
 * script can call `.click()` on a button or dispatch a click at it; neither is the user, so
 * a click has to be trusted and the page has to be holding a fresh user activation. That is
 * the page's half of the check and a script in the page could forge the fetch around it, so
 * it is not the whole check: main and the renderer each test for a real gesture on the
 * frame the document is in before anything is typed (see /panel/act and App's onAct).
 *
 * On the desk it reaches the app by POSTing to the bridge it was served from — same
 * origin, so no CORS and no preload — carrying the per-document secret. The secret is not
 * written into the page: the runtime is a separate script, fetched once by a one-time
 * address placed ahead of everything else in the document, so it runs before any of the
 * page's own scripts and keeps the secret in its closure. Asking for that address a second
 * time gets nothing. A page on any other origin has neither, which is what keeps a browsed
 * website from typing into the terminal.
 *
 * On the phone there is no bridge to POST to: the document arrived over the relay and is
 * shown in a sandboxed frame with no origin at all. There it talks to its host by
 * postMessage instead. The frame is sandboxed without `allow-same-origin`, so it cannot
 * read the app's storage or the account key — the isolation the webview provides on the
 * desk, provided differently.
 *
 * The phone's copy carries no desk secret at all, only `PHONE_ACT_SLOT`. The desk fills
 * that in with a secret of its own as it sends the document (PhoneHost, Remote), and checks
 * it when the act comes back round — so a document cannot act on a tab it does not belong
 * to, and a page on the desk that fetches its own phone version learns nothing.
 *
 * A document with no secret at all — a file shown with show_file — gets no runtime: its
 * buttons are pictures of buttons.
 */
export const PHONE_ACT_SLOT = '__EMBER_PHONE_ACT__'

function runtimeJs(actSecret: string, viaParent: boolean): string {
  return `(function () {
  var ACT = ${JSON.stringify(actSecret)}
  var VIA_PARENT = ${viaParent ? 'true' : 'false'}
  // Taken now, before any of the page's scripts can replace them.
  var FETCH = window.fetch ? window.fetch.bind(window) : null
  var STRINGIFY = JSON.stringify
  var UA = navigator.userActivation || null
  var UA_ACTIVE = (function () {
    try { return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(UA), 'isActive').get } catch (_) { return null }
  })()

  // A real press: trusted, and the page holding a user activation that has not run out.
  function live(e) {
    if (!e || e.isTrusted !== true) return false
    if (!UA || !UA_ACTIVE) return true
    try { return UA_ACTIVE.call(UA) === true } catch (_) { return false }
  }

  function post(kind, text, submit) {
    if (VIA_PARENT) {
      try { parent.postMessage({ __emberPanel: true, act: ACT, kind: kind, text: text, submit: submit }, '*') } catch (_) { /* no host to tell */ }
      return
    }
    if (!FETCH) return
    return FETCH('/panel/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: STRINGIFY({ act: ACT, kind: kind, text: text, submit: submit })
    }).catch(function () { /* A dead bridge means Ember is gone; nothing to report to. */ })
  }

  function send(text, submit) {
    text = String(text == null ? '' : text).trim()
    if (!text) return
    post('send', text, submit !== false)
  }

  // Answering a card retires it. The alternative is a panel of buttons that all still
  // look pressable after the conversation has moved past them.
  function retire(card, text) {
    if (!card) return
    card.classList.add('is-answered')
    var note = document.createElement('div')
    note.className = 'ember-ask-sent'
    note.textContent = '\\u2192 ' + text
    card.appendChild(note)
  }

  function sendFree(t) {
    var box = document.getElementById(t.getAttribute('data-ember-free'))
    var typed = box ? box.value : ''
    if (!String(typed).trim()) { if (box) box.focus(); return }
    send(typed, true)
    retire(t.closest('.ember-ask'), typed)
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-ember-send], [data-ember-free]') : null
    if (!t) return
    e.preventDefault()
    if (!live(e)) return

    if (t.hasAttribute('data-ember-free')) return sendFree(t)

    var text = t.getAttribute('data-ember-send')
    var submit = t.getAttribute('data-ember-submit') !== '0'
    send(text, submit)
    var card = t.closest('.ember-ask')
    if (card) retire(card, text)
    else {
      t.classList.add('is-sent')
      setTimeout(function () { t.classList.remove('is-sent') }, 900)
    }
  })

  // Enter sends, Shift+Enter is a newline — the same bargain every chat box makes, and
  // the one a terminal user already has in their fingers. Sent from here rather than by
  // clicking the button, because a click made by script is exactly what the check refuses.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    var box = e.target
    if (!box || box.tagName !== 'TEXTAREA' || !box.id) return
    var btn = document.querySelector('[data-ember-free="' + box.id + '"]')
    if (!btn) return
    e.preventDefault()
    if (live(e)) sendFree(btn)
  })
})()`
}

/**
 * Runtimes waiting to be fetched, by one-time address. A document asks for its own within
 * milliseconds of being served, so an entry that has waited a minute was never wanted.
 */
const runtimes = new Map<string, { js: string; until: number }>()
const RUNTIME_TTL_MS = 60_000

/** The runtime behind a one-time address, once; null for an address used or never issued. */
export function takeRuntime(nonce: string): string | null {
  const r = runtimes.get(nonce)
  runtimes.delete(nonce)
  return r && r.until > Date.now() ? r.js : null
}

function runtime(actSecret: string, viaParent = false): string {
  if (!actSecret) return ''
  // The phone's host fills the slot in; the desk secret never leaves this machine in a page.
  if (viaParent) return `<script>${runtimeJs(PHONE_ACT_SLOT, true)}</script>`
  const now = Date.now()
  for (const [n, r] of runtimes) if (r.until <= now || runtimes.size > 500) runtimes.delete(n)
  const nonce = randomBytes(16).toString('hex')
  runtimes.set(nonce, { js: runtimeJs(actSecret, false), until: now + RUNTIME_TTL_MS })
  return `<script src="/panel/runtime.js?n=${nonce}"></script>`
}

/**
 * Put the runtime first in the document, right after the doctype, so ahead of any
 * script the page brought. A script ahead of `<html>` is legal: the parser opens the head
 * for it, and it blocks everything after it until it has run.
 */
function withRuntime(html: string, tag: string): string {
  if (!tag) return html
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const cut = doctype ? doctype[0].length : 0
  return html.slice(0, cut) + tag + html.slice(cut)
}

/**
 * Boot mermaid, but only on pages that contain a diagram.
 *
 * It is loaded from the bridge rather than inlined so the 3MB parses once and is then
 * cached, and it is started manually because `startOnLoad` races a document that is
 * already parsed by the time the script arrives. Failures degrade to the diagram
 * source: a panel showing the text you wrote beats a panel showing nothing.
 */
const MERMAID_DARK = {
  background: 'transparent',
  primaryColor: '#2A1A44',
  primaryTextColor: '#E9DDFB',
  primaryBorderColor: '#F2A43A',
  secondaryColor: '#1F1436',
  tertiaryColor: '#160E28',
  lineColor: '#8A6FB5',
  textColor: '#E8E0D5',
  mainBkg: '#2A1A44',
  nodeBorder: '#F2A43A',
  clusterBkg: 'color-mix(in srgb, var(--ember-accent, #F2A43A) 7%, transparent)',
  clusterBorder: 'color-mix(in srgb, var(--ember-accent, #F2A43A) 30%, transparent)',
  edgeLabelBackground: '#1A0E2E',
}

/** The diagram on paper: pale lavender boxes, the purple kept for the borders. */
const MERMAID_LIGHT = {
  background: 'transparent',
  primaryColor: '#FBF1E1',
  primaryTextColor: '#2A2118',
  primaryBorderColor: '#B07A2A',
  secondaryColor: '#FAF5EC',
  tertiaryColor: '#FDFAF4',
  lineColor: '#8C7356',
  textColor: '#33291F',
  mainBkg: '#FBF1E1',
  nodeBorder: '#B07A2A',
  clusterBkg: 'rgba(176, 122, 42, 0.05)',
  clusterBorder: 'rgba(176, 122, 42, 0.3)',
  edgeLabelBackground: '#FDFAF4',
}

/** The theme the renderer is showing, so a document is drawn in Ember's colours rather than the default purple. */
export interface DocPalette {
  accent: string
  fg: string
  bg: string
}

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `a` laid over `b` at `t` (0..1), as hex: mermaid computes shades from it, so no rgba(). */
function mix(a: string, b: string, t: number): string {
  const x = hexRgb(a)
  const y = hexRgb(b)
  return `#${x.map((v, i) => Math.round(v * t + y[i]! * (1 - t)).toString(16).padStart(2, '0')).join('')}`
}

function rgba(h: string, alpha: number): string {
  return `rgba(${hexRgb(h).join(', ')}, ${alpha})`
}

/**
 * The ink a document is set in: neutral, only faintly the theme's. A theme whose text is
 * its accent colour would otherwise make every word, box and border the same hue.
 */
function inkOf(p: DocPalette, light: boolean): { ink: string; strong: string; dim: string } {
  return light
    ? { ink: mix(p.fg, '#23211f', 0.14), strong: mix(p.fg, '#121110', 0.08), dim: mix(p.fg, '#6a6560', 0.14) }
    : { ink: mix(p.fg, '#e7e4df', 0.14), strong: mix(p.fg, '#f7f5f2', 0.08), dim: mix(p.fg, '#9a958e', 0.14) }
}

/** Where a session's own views live; set by the bridge, which knows the config folder. */
let loadView: (name: string) => string | null = () => null
export function setViewLoader(fn: (name: string) => string | null): void {
  loadView = fn
}

/** The theme a data view is drawn in: neutral ink, the accent, the category hues. */
function viewTheme(palette: DocPalette | undefined, light: boolean): { theme: ViewTheme; bg: string } {
  const p = palette ?? { accent: light ? '#B07A2A' : '#F2A43A', fg: light ? '#2A2118' : '#E8E0D5', bg: light ? '#FBF7F2' : '#16120F' }
  const { ink, strong, dim } = inkOf(p, light)
  return {
    bg: p.bg,
    theme: {
      accent: p.accent,
      ink,
      strong,
      dim,
      line: light ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.08)',
      surface: light ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.04)',
      cats: CATEGORY.map((c) => (light ? c : mix(c, p.bg, 0.9))),
    },
  }
}

/** Muted, distinguishable hues for diagrams that colour by category (pie slices, timelines, mind maps). */
const CATEGORY = ['#6aa8e6', '#5fbf8f', '#e0b45a', '#c98bd9', '#e2876f', '#5cc3c0', '#9aa36a', '#d27a9b']

function mermaidPalette(p: DocPalette, light = false): Record<string, unknown> {
  const { ink, strong } = inkOf(p, light)
  const node = light ? mix(p.bg, '#ffffff', 0.4) : mix('#ffffff', p.bg, 0.06)
  const border = light ? mix(ink, p.bg, 0.25) : mix(ink, p.bg, 0.28)
  const vars: Record<string, unknown> = {
    background: 'transparent',
    primaryColor: node,
    primaryTextColor: strong,
    primaryBorderColor: border,
    secondaryColor: light ? mix(p.bg, '#ffffff', 0.6) : mix('#ffffff', p.bg, 0.04),
    tertiaryColor: light ? mix(p.bg, '#ffffff', 0.8) : mix('#ffffff', p.bg, 0.025),
    // The accent is the connection: lines and arrows, nothing else.
    lineColor: mix(p.accent, p.bg, 0.75),
    textColor: ink,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: light ? 'rgba(0, 0, 0, 0.025)' : 'rgba(255, 255, 255, 0.025)',
    clusterBorder: light ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.06)',
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif",
    fontSize: '13px',
    edgeLabelBackground: p.bg,
    actorBkg: node,
    actorBorder: border,
    actorTextColor: strong,
    signalColor: ink,
    signalTextColor: ink,
    noteBkgColor: light ? mix(p.accent, '#ffffff', 0.08) : mix(p.accent, p.bg, 0.1),
    noteTextColor: strong,
    noteBorderColor: rgba(p.accent, 0.4),
    titleColor: strong,
    pieTitleTextColor: strong,
    pieSectionTextColor: light ? '#ffffff' : '#14110e',
    pieStrokeColor: p.bg,
    pieOuterStrokeColor: border,
  }
  // Charts: bars and lines in the muted palette, axes in the ink, no plate behind them.
  vars['xyChart'] = {
    backgroundColor: 'transparent',
    titleColor: strong,
    xAxisLabelColor: ink,
    xAxisTitleColor: ink,
    xAxisTickColor: border,
    xAxisLineColor: border,
    yAxisLabelColor: ink,
    yAxisTitleColor: ink,
    yAxisTickColor: border,
    yAxisLineColor: border,
    plotColorPalette: CATEGORY.map((c) => (light ? c : mix(c, p.bg, 0.85))).join(', '),
  }
  CATEGORY.forEach((c, i) => {
    vars[`pie${i + 1}`] = c
    vars[`cScale${i}`] = light ? mix(c, '#ffffff', 0.35) : mix(c, p.bg, 0.45)
    vars[`cScaleLabel${i}`] = strong
  })
  return vars
}

/** Neutral ink, depth for surfaces, the accent for links and focus only. */
function paletteStyle(p: DocPalette, light = false): string {
  const { ink, strong, dim } = inkOf(p, light)
  const line = light ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.07)'
  const surface = light ? 'rgba(0, 0, 0, 0.03)' : 'rgba(255, 255, 255, 0.035)'
  const chip = light ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.06)'
  return `
body { color: ${ink}; }
h1, h2, h3, strong { color: ${strong}; }
h4, h5, h6, th, blockquote { color: ${dim}; }
a { color: ${p.accent}; text-decoration-color: ${rgba(p.accent, 0.35)}; }
code { background: ${chip}; color: ${strong}; }
pre.code { background: ${surface}; }
pre.code code, .ember-raw { color: ${ink}; }
blockquote { border-left-color: ${line}; }
li::marker { color: ${dim}; }
hr { border-top-color: ${line}; }
th, td { border-bottom-color: ${line}; }
.ember-act { border-color: transparent; background: ${chip}; color: ${strong}; }
.ember-act:hover { background: ${rgba(p.accent, 0.14)}; border-color: transparent; }
.ember-ask { border-color: transparent; background: ${surface}; }
.ember-ask-opt { border-color: transparent; background: ${surface}; color: ${strong}; }
.ember-ask-opt:hover { background: ${rgba(p.accent, 0.12)}; border-color: transparent; }
::-webkit-scrollbar-thumb { background: ${line}; background-clip: padding-box; }
`
}

const PROSE_FONT = "'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif"

/** Diagram details the theme variables cannot reach: rounded nodes, even strokes, edge labels as pills. */
const MERMAID_CSS = [
  '.node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1px; }',
  '.node rect { rx: 8px; ry: 8px; }',
  '.flowchart-link, .edgePath .path { stroke-width: 1.5px; }',
  '.edgeLabel, .edgeLabel p, .edgeLabel span { font-size: 12px; }',
  '.edgeLabel rect, .labelBkg { rx: 6px; ry: 6px; }',
  '.edgeLabel .label, .labelBkg { padding: 2px 6px; border-radius: 6px; }',
  '.cluster rect { rx: 10px; ry: 10px; stroke-width: 1px; stroke-dasharray: 0; }',
  '.cluster-label, .cluster .label { font-size: 12px; font-weight: 500; }',
  '.nodeLabel, .label { font-size: 13px; }',
  'text { font-family: inherit; }',
].join(' ')

const mermaidBoot = (light: boolean, palette?: DocPalette) => `
<script src="/vendor/mermaid.min.js"></script>
<script>
  (function () {
    var blocks = document.querySelectorAll('pre.mermaid')
    if (!blocks.length) return
    var PROSE_FONT_JS = ${JSON.stringify(PROSE_FONT)}
    if (!window.mermaid) {
      blocks.forEach(function (b) { b.className = 'code' })
      return
    }
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: ${JSON.stringify(PROSE_FONT)},
      themeVariables: ${JSON.stringify({ ...(palette ? mermaidPalette(palette, light) : light ? MERMAID_LIGHT : MERMAID_DARK), fontFamily: PROSE_FONT, fontSize: '13px' })},
      themeCSS: ${JSON.stringify(MERMAID_CSS)},
      flowchart: { curve: 'basis', padding: 14, nodeSpacing: 44, rankSpacing: 52, htmlLabels: true },
      sequence: { actorFontFamily: PROSE_FONT_JS, messageFontFamily: PROSE_FONT_JS, noteFontFamily: PROSE_FONT_JS },
      xyChart: { titleFontSize: 14, xAxis: { labelFontSize: 12, titleFontSize: 12 }, yAxis: { labelFontSize: 12, titleFontSize: 12 } },
      suppressErrorRendering: true
    })
    // A frame that loads while hidden (a background tab, a canvas not yet shown) has no
    // layout, and mermaid measuring text there draws an empty diagram for good. Wait
    // until the frame has a size.
    var started = false
    // Nothing Claude writes ever shows mermaid's error bomb. Each diagram is parsed first;
    // a failure is repaired (labels with brackets, colons, slashes or & quoted — the usual
    // cause); what still fails becomes a quiet card with the source. Then the canvas is
    // told how it went, so the session that drew it can hear about it and fix it.
    function repair(src) {
      var t = src.replace(/^\\s*\x60\x60\x60(?:mermaid)?\\s*/, '').replace(/\\s*\x60\x60\x60\\s*$/, '')
      var edge = '(?=\\\\s*(?:[-=.ox<]{2,}|&|;|:::|$))'
      var q = function (s) { return '"' + s.replace(/"/g, "'") + '"' }
      if (/^\\s*(flowchart|graph)\\b/m.test(t)) {
        t = t.replace(new RegExp('(\\\\b[\\\\w-]+)\\\\[(?!["\\\\[(/\\\\\\\\])(.+?)\\\\]' + edge, 'gm'), function (_, id, s) { return id + '[' + q(s) + ']' })
        t = t.replace(new RegExp('(\\\\b[\\\\w-]+)\\\\((?!["(\\\\[])(.+?)\\\\)' + edge, 'gm'), function (_, id, s) { return id + '(' + q(s) + ')' })
        t = t.replace(new RegExp('(\\\\b[\\\\w-]+)\\\\{(?!["{])(.+?)\\\\}' + edge, 'gm'), function (_, id, s) { return id + '{' + q(s) + '}' })
        t = t.replace(/\\|(?!")([^|\\n]+)\\|/g, function (_, s) { return '|' + q(s.trim()) + '|' })
        // A node called "end" closes a subgraph instead.
        t = t.replace(/\\bend\\b(?=\\s*[\\[({])/g, 'endNode')
      }
      return t
    }
    function fallback(b, src, err) {
      var card = document.createElement('div')
      card.className = 'mm-fail'
      var head = document.createElement('div')
      head.className = 'mm-fail-t'
      head.textContent = 'This diagram could not be drawn' + (err ? ' — ' + err : '')
      var pre = document.createElement('pre')
      pre.className = 'code'
      var code = document.createElement('code')
      code.textContent = src
      pre.appendChild(code)
      card.append(head, pre)
      b.replaceWith(card)
    }
    function report(status) {
      var id = (document.querySelector('meta[name="ember-doc"]') || {}).content
      if (!id || window.parent === window) return
      try { window.parent.postMessage({ emberDocStatus: { id: id, ok: status.ok, error: status.error || '', repaired: !!status.repaired } }, '*') } catch (e) {}
    }
    async function check(b) {
      var src = b.textContent || ''
      try {
        if (await window.mermaid.parse(src, { suppressErrors: true })) return { ok: true }
        var fixed = repair(src)
        if (fixed !== src && (await window.mermaid.parse(fixed, { suppressErrors: true }))) {
          b.textContent = fixed
          return { ok: true, repaired: true }
        }
        var err = ''
        try { await window.mermaid.parse(src) } catch (e) { err = String((e && e.message) || e).split('\\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 300) }
        fallback(b, src, err)
        return { ok: false, error: err || 'syntax error' }
      } catch (e) {
        fallback(b, src, '')
        return { ok: false, error: String(e && e.message || e).slice(0, 300) }
      }
    }
    async function start() {
      if (started || !window.innerWidth) return
      started = true
      removeEventListener('resize', start)
      var results = []
      for (var i = 0; i < blocks.length; i++) results.push(await check(blocks[i]))
      var good = Array.prototype.filter.call(document.querySelectorAll('pre.mermaid'), function (b) { return b.isConnected })
      try {
        if (good.length) await window.mermaid.run({ nodes: good, suppressErrors: true })
        fixContrast()
      } catch (e) {
        good.forEach(function (b) { if (!b.querySelector('svg')) fallback(b, b.textContent || '', '') })
      }
      // Anything mermaid still drew as an error is swapped for the quiet card too.
      document.querySelectorAll('svg[aria-roledescription="error"]').forEach(function (s) {
        var host = s.closest('pre') || s.parentElement
        if (host) fallback(host, '', 'syntax error')
      })
      var bad = results.filter(function (r) { return !r.ok })
      report({ ok: !bad.length, error: bad.map(function (r) { return r.error }).join('; '), repaired: results.some(function (r) { return r.repaired }) })
    }
    addEventListener('resize', start)
    start()

    // Authored fills ("style A fill:#e0f0ff", classDefs) keep the theme's light text
    // on a light box, which is unreadable. After render, every label is inked black or
    // white by the luminance of the shape it sits on, whatever the diagram asked for.
    function luma(fill) {
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(fill || '')
      if (!m) return null
      if (m[4] != null && parseFloat(m[4]) < 0.25) return null
      var lin = function (v) {
        v = parseInt(v, 10) / 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3])
    }
    function fixContrast() {
      var shapes = document.querySelectorAll(
        'svg .node rect, svg .node polygon, svg .node circle, svg .node ellipse, svg .node path, ' +
        'svg .cluster rect, svg rect.actor, svg .actor rect, svg .labelBox, svg .note, svg .state rect, ' +
        'svg .er.entityBox, svg .task, svg .section'
      )
      shapes.forEach(function (shape) {
        var l = luma(getComputedStyle(shape).fill)
        if (l == null) return
        var ink = l > 0.42 ? '#14111c' : '#f1ecfa'
        var g = shape.closest('g')
        if (!g) return
        g.querySelectorAll('text, tspan').forEach(function (t) { t.style.fill = ink })
        g.querySelectorAll('foreignObject *').forEach(function (t) { t.style.color = ink })
      })
    }
  })()
</script>`

function shell(body: string, light = false, palette?: DocPalette): string {
  const head = body.includes('class="mermaid"') ? mermaidBoot(light, palette) : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}${SCROLLBARS}${INTERACT_STYLE}${light ? LIGHT_STYLE + LIGHT_INTERACT : ''}${palette ? paletteStyle(palette, light) : ''}</style>
</head><body${light ? ' class="light"' : ''}>${body}${head}</body></html>`
}

/**
 * A question, as a card you answer by pressing rather than by typing an answer that
 * has to match what was asked.
 *
 * The free-text box is there by default because the interesting answer is very often
 * none of the offered ones, and having to switch back to the terminal to say so is
 * exactly the friction the panel exists to remove.
 */
function askCard(push: PanelPush): string {
  const options = push.options ?? []
  const boxId = `ember-free-${push.id}`

  const buttons = options
    .map((o: PanelOption) => {
      const value = escapeHtml(o.value ?? o.label)
      const submit = o.submit === false ? '0' : '1'
      const hint = o.hint ? `<span class="hint">${escapeHtml(o.hint)}</span>` : ''
      return `<button type="button" class="ember-ask-opt" data-ember-send="${value}" data-ember-submit="${submit}">${escapeHtml(o.label)}${hint}</button>`
    })
    .join('')

  const free =
    push.freeText === false
      ? ''
      : `<div class="ember-ask-free">
  <textarea id="${boxId}" rows="1" placeholder="Or say it in your own words…" spellcheck="false"></textarea>
  <button type="button" class="ember-act" data-ember-free="${boxId}">Send</button>
</div>`

  return `<section class="ember-ask">
  <div class="ember-ask-q">${markdownToHtml(push.content)}</div>
  ${buttons ? `<div class="ember-ask-options">${buttons}</div>` : ''}
  ${free}
</section>`
}

/**
 * The defaults a model-authored page starts from.
 *
 * The panel is dark and the webview is transparent, so a page that never names a text
 * colour is black on Ember's background — which reads as an empty panel, and is by far
 * the most common way an html push has "shown nothing". These go in ahead of the page's
 * own `<style>`, so anything the author did say wins by ordinary cascade order.
 */
const HTML_BASE = `
:root { color-scheme: dark; }
html, body { margin: 0; background: transparent; }
body {
  color: var(--ember-ink, #E8E0D5);
  font: 400 14px/1.6 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif;
}
h1, h2, h3, h4, h5, h6 { color: #F0EAFB; }
a { color: #E08BFF; }
img, svg, canvas, video { max-width: 100%; }`

/** HTML_BASE for a light palette: dark ink, so an unstyled page still reads on paper. */
const HTML_BASE_LIGHT = `
:root { color-scheme: light; }
html, body { margin: 0; background: transparent; }
body {
  color: #2E2640;
  font: 400 14px/1.6 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif;
}
h1, h2, h3, h4, h5, h6 { color: #1B1426; }
a { color: #7A22AE; }
img, svg, canvas, video { max-width: 100%; }`

/**
 * What a model-authored page gets on a light theme, after its own styles.
 *
 * Pages are written for the dark panel more often than not — the old house colour was pale
 * lavender on nothing — and on paper that is nothing at all: legends, headings, the copy
 * in a bordered box, the label on a button. The page is not rewritten; once it has drawn
 * (and again whenever it changes), every element that holds text is measured against the
 * ground it actually sits on — its own background, its parents', and the panel's paper
 * under all of them — and text under 4.5:1 (3:1 when large) is deepened toward the ink
 * until it reads, keeping its hue, the way the chrome's accent ink is made. A border
 * paler than the paper it sits on, which can only have been meant for a dark ground,
 * becomes a faint ink line. Text on a dark card the page painted itself is left alone,
 * because against that card it already reads.
 *
 * A page that wants to do it properly uses the tokens below instead and needs no rescue.
 */
function lightGuard(paper: string): string {
  return `<script>
(function () {
  var PAPER = ${JSON.stringify(paper)}
  var INK = [27, 20, 38]
  function parse(c) {
    var m = /rgba?\\(([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+%?))?\\)/.exec(c || '')
    if (!m) return null
    var a = m[4] == null ? 1 : m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return [+m[1], +m[2], +m[3], a]
  }
  var paperRgb = (function () {
    var h = PAPER.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  })()
  function over(top, under) {
    var a = top[3]
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a)]
  }
  function lum(c) {
    function l(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2])
  }
  function ratio(a, b) {
    var x = lum(a), y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  // The colour the element's box is painted on: its own background and each parent's,
  // composited over the panel's paper. Images and gradients count as the paper, which
  // is what most of them are drawn for.
  function ground(el) {
    var layers = []
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var bg = parse(getComputedStyle(n).backgroundColor)
      if (bg && bg[3] > 0) { layers.push(bg); if (bg[3] >= 0.99) break }
    }
    var c = paperRgb
    for (var i = layers.length - 1; i >= 0; i--) c = over(layers[i], c)
    return c
  }
  function readable(fg, bg, need) {
    if (ratio(fg, bg) >= need) return null
    // Toward the ink on a light ground, toward white on a dark one.
    var to = lum(bg) > 0.4 ? INK : [255, 255, 255]
    for (var t = 0.1; t <= 1.0001; t += 0.1) {
      var m = [fg[0] + (to[0] - fg[0]) * t, fg[1] + (to[1] - fg[1]) * t, fg[2] + (to[2] - fg[2]) * t]
      if (ratio(m, bg) >= need) return m
    }
    return to
  }
  function css(c) { return 'rgb(' + Math.round(c[0]) + ', ' + Math.round(c[1]) + ', ' + Math.round(c[2]) + ')' }
  function holdsText(el) {
    for (var k = el.firstChild; k; k = k.nextSibling) if (k.nodeType === 3 && /\\S/.test(k.nodeValue)) return true
    return false
  }
  function fix() {
    var all = document.body ? document.body.getElementsByTagName('*') : []
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      var tag = el.tagName.toLowerCase()
      var isSvgText = tag === 'text' || tag === 'tspan'
      if (!isSvgText && el.closest('svg')) continue
      var st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') continue
      var bg = null
      if (holdsText(el) || tag === 'input' || tag === 'textarea') {
        var fg = parse(isSvgText ? st.fill : st.color)
        if (fg) {
          bg = ground(el)
          var size = parseFloat(st.fontSize) || 14
          var large = size >= 24 || (size >= 18.5 && parseInt(st.fontWeight, 10) >= 700)
          var better = readable(over(fg, bg), bg, large ? 3 : 4.5)
          if (better) el.style.setProperty(isSvgText ? 'fill' : 'color', css(better), 'important')
        }
      }
      // A border paler than what it sits on was drawn for a dark ground.
      if (!isSvgText && (parseFloat(st.borderTopWidth) > 0 || parseFloat(st.borderLeftWidth) > 0)) {
        var bc = parse(st.borderTopWidth !== '0px' ? st.borderTopColor : st.borderLeftColor)
        if (bc && bc[3] > 0) {
          var under = ground(el.parentElement || el)
          var line = over(bc, under)
          if (lum(line) > lum(under) + 0.005) el.style.setProperty('border-color', 'rgba(46, 38, 64, 0.2)', 'important')
        }
      }
    }
  }
  var queued = false
  var observer = new MutationObserver(soon)
  function watch() {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  }
  function soon() {
    if (queued) return
    queued = true
    requestAnimationFrame(function () {
      queued = false
      observer.disconnect()
      try { fix() } finally { watch() }
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', soon)
  else soon()
  window.addEventListener('load', soon)
  watch()
})()
</script>`
}

/**
 * Which way the panel faces, told to every authored page: `html[data-ember-tone]` and a
 * small set of `--ember-*` colours that flip with the theme. The skills and the tool
 * description point models at these, so one page reads on Night and on Day. Declared
 * before the page's own styles, so a page that defines the same names wins.
 */
function toneTokens(light: boolean, paper: string): string {
  const t = light
    ? { paper, ink: '#2A2118', strong: '#17110B', muted: '#6B5E4F', accent: '#B07A2A', line: 'rgba(42, 33, 24, 0.16)', surface: 'rgba(42, 33, 24, 0.05)' }
    : { paper: '#16120F', ink: '#E8E0D5', strong: '#FBF6EF', muted: '#A99F92', accent: '#F2A43A', line: 'rgba(232, 224, 213, 0.14)', surface: 'rgba(255, 255, 255, 0.04)' }
  return `<style>:root { --ember-paper: ${t.paper}; --ember-ink: ${t.ink}; --ember-strong: ${t.strong}; --ember-muted: ${t.muted}; --ember-accent: ${t.accent}; --ember-line: ${t.line}; --ember-surface: ${t.surface}; }</style><script>document.documentElement.setAttribute('data-ember-tone', '${light ? 'light' : 'dark'}')</script>`
}

/** True when the page is a document of its own rather than a fragment to be given one. */
function isDocument(page: string): boolean {
  return /^\s*(<!doctype\b|<html\b)/i.test(page)
}

/**
 * The page as it was meant, without the wrapping a model sometimes adds on the way
 * out: a ```html fence around the whole thing is the second most common way an html
 * push has looked broken, since the panel then shows the backticks as text.
 */
function unfence(page: string): string {
  const m = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(page)
  return m?.[1] ?? page
}

/**
 * Give a model-authored page the interaction runtime without touching anything else
 * in it. Appended at the end of `<body>` where a browser would put a trailing script
 * anyway, and simply concatenated when the page has no body tag to find.
 *
 * A fragment — a bare `<div>…</div>` with no document around it — is a perfectly valid
 * thing to be handed and Chromium would wrap it, but it would wrap it in a page with no
 * colours, which on a transparent webview over a dark panel is invisible. So a fragment
 * gets Ember's own document around it instead, styled like a markdown panel, and a full
 * document gets `HTML_BASE` ahead of its own head so an unstyled body still reads.
 */
function graft(page: string, light = false, paper = DEFAULT_PAPER): string {
  const source = unfence(page)
  // The scrollbars go in too. A model-authored page is still a page inside Ember's
  // panel, and a browser-default bar down the side of it is the one part that gives
  // away that it is a webview.
  const addition = `<style>${SCROLLBARS}${INTERACT_STYLE}${light ? LIGHT_INTERACT : ''}</style>${light ? lightGuard(paper) : ''}`

  if (!isDocument(source)) {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}${light ? LIGHT_STYLE : ''}</style>${toneTokens(light, paper)}
</head><body class="ember-fragment">${source}${addition}</body></html>`
  }

  const withBase = withDefaults(source, `<style>${light ? HTML_BASE_LIGHT : HTML_BASE}</style>${toneTokens(light, paper)}`)
  const close = withBase.toLowerCase().lastIndexOf('</body>')
  return close === -1 ? withBase + addition : withBase.slice(0, close) + addition + withBase.slice(close)
}

/** Put `head` in first: at the top of `<head>`, else after `<html>`, else after the doctype. */
function withDefaults(page: string, head: string): string {
  const lower = page.toLowerCase()
  for (const tag of ['<head', '<html']) {
    const at = lower.indexOf(tag)
    if (at === -1) continue
    const end = lower.indexOf('>', at)
    if (end === -1) continue
    const cut = end + 1
    return page.slice(0, cut) + head + page.slice(cut)
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page)
  const cut = doctype ? doctype[0].length : 0
  return page.slice(0, cut) + head + page.slice(cut)
}

/**
 * The images a session has seen, as one page: the newest large, the rest as a strip of
 * thumbnails under it. A thumbnail swaps into the large frame; the large frame toggles
 * between fitting the panel and its real size, for reading a screenshot's small print.
 *
 * Every image comes from /img/<id> on the bridge. The phone cannot reach the bridge, so
 * there the page lists what was seen and says where to look.
 */
interface GalleryItem {
  id: string
  source: string
  caption: string
  at: number
}

function gallery(content: string, viaParent: boolean): string {
  let items: GalleryItem[] = []
  try {
    items = JSON.parse(content) as GalleryItem[]
  } catch {
    /* an empty gallery */
  }
  const when = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const meta = (it: GalleryItem) =>
    `<span class="g-cap">${escapeHtml(it.caption)}</span><span class="g-src">${escapeHtml(it.source)} · ${when(it.at)}</span>`
  if (viaParent) {
    return `<p>Images from this session are on the desk's panel:</p><ul>${items.map((it) => `<li>${meta(it)}</li>`).join('')}</ul>`
  }
  const first = items[0]
  if (!first) return '<p>No images yet.</p>'
  const thumbs = items
    .map(
      (it, i) =>
        `<button type="button" class="g-thumb${i === 0 ? ' is-on' : ''}" data-id="${escapeHtml(it.id)}" data-meta="${escapeHtml(meta(it))}" title="${escapeHtml(it.caption)}"><img src="/img/${escapeHtml(it.id)}" alt="" loading="lazy"></button>`
    )
    .join('')
  return `<style>
body { padding: 12px 14px 16px; }
.g-main { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.g-frame { display: block; border-radius: 10px; overflow: auto; max-height: calc(100vh - ${items.length > 1 ? 150 : 70}px);
  border: 1px solid var(--g-line); background: var(--g-well); cursor: zoom-in; }
.g-frame img { display: block; width: 100%; height: auto; max-width: none; }
.g-frame.is-real { cursor: zoom-out; }
.g-frame.is-real img { width: auto; }
.g-meta { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.g-cap { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-src { opacity: 0.7; white-space: nowrap; }
.g-strip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 0 2px; }
.g-thumb { flex: none; width: 86px; height: 58px; padding: 0; border-radius: 7px; overflow: hidden; cursor: pointer;
  border: 1px solid var(--g-line); background: var(--g-well); opacity: 0.72; transition: opacity 120ms ease, border-color 120ms ease; }
.g-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.g-thumb:hover { opacity: 1; }
.g-thumb.is-on { opacity: 1; border-color: var(--g-accent); box-shadow: 0 0 0 1px var(--g-accent); }
:root { --g-line: rgba(217, 210, 234, 0.16); --g-well: rgba(255, 255, 255, 0.03); --g-accent: var(--ember-accent, #F2A43A); }
:root[data-ember-tone="light"], .light { --g-line: rgba(42, 33, 24, 0.16); --g-well: rgba(42, 33, 24, 0.04); --g-accent: var(--ember-accent, #B07A2A); }
</style>
<figure class="g-main">
  <a class="g-frame" title="Click for real size"><img id="g-big" src="/img/${escapeHtml(first.id)}" alt=""></a>
  <figcaption class="g-meta" id="g-meta">${meta(first)}</figcaption>
</figure>
${items.length > 1 ? `<div class="g-strip">${thumbs}</div>` : ''}
<script>
(function () {
  var big = document.getElementById('g-big'), metaEl = document.getElementById('g-meta'), frame = big.parentNode
  frame.addEventListener('click', function () { frame.classList.toggle('is-real') })
  document.querySelectorAll('.g-thumb').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.g-thumb.is-on').forEach(function (o) { o.classList.remove('is-on') })
      t.classList.add('is-on')
      big.src = '/img/' + t.getAttribute('data-id')
      metaEl.innerHTML = t.getAttribute('data-meta')
      frame.classList.remove('is-real')
      frame.scrollTop = 0
    })
  })
})()
</script>`
}

/**
 * Where the document will be shown.
 *
 * 'bridge' is the desk: served over HTTP from the bridge origin into a webview, able to
 * fetch its own subresources and POST its acts back.
 *
 * 'phone' is the same document carried over the relay and dropped into a sandboxed frame.
 * Two things change and only two: acts go out by postMessage because there is no bridge to
 * POST to, and mermaid is loaded from the app bundle because /vendor is a route on a host
 * the phone cannot reach. Everything else — the markup, the styles, the ask cards — is
 * byte for byte what the desk shows, which is the point of rendering it here rather than
 * building a second renderer over there to drift.
 */
export type PanelTarget = 'bridge' | 'phone'

/** The light ground the guard measures against when the renderer does not say which. */
const DEFAULT_PAPER = '#FBF7F2'

export function renderPanelDocument(push: PanelPush, target: PanelTarget = 'bridge', light = false, paper = DEFAULT_PAPER, palette?: DocPalette): string {
  const act = push.act ?? ''
  const viaParent = target === 'phone'
  const drawn = renderFor(push, viaParent, light, paper, palette).replace(/<head>|<head\s[^>]*>/i, (h) => `${h}<meta name="ember-doc" content="${push.id}">`)
  const html = withRuntime(drawn, runtime(act, viaParent))
  // The phone bundles mermaid rather than fetching it from a bridge it cannot see.
  return viaParent ? html.replace('/vendor/mermaid.min.js', 'mermaid.min.js') : withHeightReport(html)
}

/**
 * Tell a framing page how tall the document is.
 *
 * A Loom canvas shows documents inline, in frames that should be exactly as tall as what
 * is in them. The frame is on another origin, so the document has to say. In the panel's
 * webview the document is the top window and this does nothing.
 */
const HEIGHT_REPORT = `<script>(function(){if(window.parent===window)return;addEventListener('keydown',function(e){if(e.key==='Escape'){try{parent.postMessage({emberKey:'Escape'},'*')}catch(_){}}});addEventListener('message',function(e){if(e.data&&e.data.emberFit)document.documentElement.classList.add('ember-fit');var f=e.data&&e.data.emberFind;if(f){var want=String(f.text||'').trim().toLowerCase(),best=null,bl=1e9;document.querySelectorAll('g.node,.nodeLabel,text,tspan,th,td,li,button,a,h1,h2,h3,h4,p,span,div,rect,path').forEach(function(el){var t=(el.textContent||'').trim().toLowerCase();if(!t||t.indexOf(want)<0)return;var r=el.getBoundingClientRect();if(!r.width||!r.height)return;var g=el.closest&&el.closest('g.node');if(g){r=g.getBoundingClientRect();t=(g.textContent||'').trim().toLowerCase()}if(t.length<bl){bl=t.length;best=r}});try{parent.postMessage({emberFound:{id:f.id,rect:best?{x:best.left,y:best.top,w:best.width,h:best.height}:null}},'*')}catch(_){}}});addEventListener('contextmenu',function(e){var t=e.target;if(t&&t.closest&&t.closest('a,input,textarea,select,button'))return;e.preventDefault();var label='';var n=t&&t.closest&&t.closest('.node,.cluster,.actor,.edgeLabel,text');if(n)label=(n.textContent||'').trim().slice(0,80);try{parent.postMessage({emberContext:{x:e.clientX,y:e.clientY,text:String(getSelection()||'').slice(0,500),part:label}},'*')}catch(_){}});var last=-1;function post(){var d=document.documentElement,b=document.body;d.style.overflowY=(d.scrollHeight-window.innerHeight>3)?'auto':'hidden';var h=Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0));if(Math.abs(h-last)<2)return;last=h;try{parent.postMessage({emberDocHeight:h},'*')}catch(e){}}addEventListener('load',post);try{var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}catch(e){}setTimeout(post,30);setTimeout(post,400);setTimeout(post,1500)})()</script><script>(function(){if(window.parent===window)return;var z=1,on=false,d=document.documentElement;function apply(nz,cx,cy){nz=Math.max(0.5,Math.min(8,nz));if(Math.abs(nz-z)<0.001)return;var b=document.body;if(!b)return;if(cx==null){cx=innerWidth/2;cy=innerHeight/2}var px=(d.scrollLeft+cx)/z,py=(d.scrollTop+cy)/z;z=nz;b.style.transformOrigin='0 0';b.style.transform=z===1?'':'scale('+z+')';d.style.overflow=z===1?'':'auto';d.style.cursor=z>1?'grab':'';d.scrollLeft=px*z-cx;d.scrollTop=py*z-cy;try{parent.postMessage({emberZoomed:z},'*')}catch(_){}}addEventListener('message',function(e){var m=e.data&&e.data.emberZoom;if(!m)return;if(m==='on')on=true;else if(m==='off'){on=false;apply(1)}else if(m==='in')apply(z*1.25);else if(m==='out')apply(z/1.25);else if(m==='reset')apply(1)});addEventListener('wheel',function(e){if(!on||!(e.ctrlKey||e.metaKey))return;e.preventDefault();apply(z*Math.exp(-e.deltaY*0.0025),e.clientX,e.clientY)},{passive:false});addEventListener('keydown',function(e){if(!on||e.ctrlKey||e.altKey)return;var t=e.target;if(t&&t.closest&&t.closest('input,textarea,[contenteditable]'))return;if(e.key==='+'||e.key==='='){e.preventDefault();apply(z*1.25)}else if(e.key==='-'||e.key==='_'){e.preventDefault();apply(z/1.25)}else if(e.key==='0'){e.preventDefault();apply(1)}});addEventListener('dblclick',function(e){if(!on)return;var t=e.target;if(t&&t.closest&&t.closest('a,button,input,textarea,select'))return;apply(z>1.01?1:2,e.clientX,e.clientY)});var pan=null;addEventListener('pointerdown',function(e){if(!on||z<=1||e.button!==0)return;var t=e.target;if(t&&t.closest&&t.closest('a,button,input,textarea,select,[contenteditable]'))return;pan={x:e.clientX,y:e.clientY,l:d.scrollLeft,t:d.scrollTop};d.style.cursor='grabbing';e.preventDefault()});addEventListener('pointermove',function(e){if(!pan)return;d.scrollLeft=pan.l-(e.clientX-pan.x);d.scrollTop=pan.t-(e.clientY-pan.y)});addEventListener('pointerup',function(){if(pan){pan=null;d.style.cursor=z>1?'grab':''}})})()</script>`

function withHeightReport(html: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at === -1 ? html + HEIGHT_REPORT : html.slice(0, at) + HEIGHT_REPORT + html.slice(at)
}

function renderFor(push: PanelPush, viaParent: boolean, light: boolean, paper: string, palette?: DocPalette): string {
  switch (push.format) {
    case 'html':
      // Passed through as its own document. It is untrusted, and it is contained by
      // being on this origin in a webview rather than by being filtered here — a
      // sanitiser that has to be right every time is a worse bet than an isolation
      // boundary that does not.
      return graft(push.content, light, paper)

    case 'code':
      return shell(
        `<pre class="code"><code data-lang="${escapeHtml(push.language ?? '')}">${escapeHtml(push.content)}</code></pre>`,
        light,
        palette
      )

    case 'mermaid':
      return shell(`<pre class="mermaid">${escapeHtml(push.content)}</pre>`, light, palette)

    case 'ask':
      return shell(askCard(push), light, palette)

    case 'url':
      // On the desk a url push navigates the webview instead of building a page. The
      // phone has no browser to hand it to, so it gets something it can tap instead.
      return shell(
        `<p>Opening <a href="${escapeHtml(push.content)}" target="_blank" rel="noreferrer">${escapeHtml(push.content)}</a>…</p>`,
        light,
        palette
      )

    case 'view': {
      let spec: { view?: string; data?: unknown; title?: string } = {}
      try {
        spec = JSON.parse(push.content)
      } catch {
        return shell(`<p>This view's data is not valid JSON.</p>`, light, palette)
      }
      const name = String(spec.view ?? '')
      const { theme, bg } = viewTheme(palette, light)
      const own = loadView(name)
      if (own) return graft(customViewDocument(own, spec.data ?? {}, push.title, theme), light, paper)
      return shell(viewDocument(name, spec.data ?? {}, push.title, theme, bg), light, palette)
    }

    case 'images':
      return shell(gallery(push.content, viaParent), light, palette)

    case 'markdown':
    default:
      return shell(markdownToHtml(push.content), light, palette)
  }
}
