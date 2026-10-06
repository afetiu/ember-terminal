import type { PanelOption, PanelPush } from '../shared/types.js'

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
body {
  padding: 20px 22px 40px;
  color: #D9D2EA;
  font: 13.5px/1.65 "CaskaydiaCove NF", "Cascadia Code", Consolas, ui-monospace, monospace;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4, h5, h6 { color: #F0EAFB; font-weight: 600; line-height: 1.25; margin: 1.4em 0 0.5em; }
h1 { font-size: 1.5em; } h2 { font-size: 1.28em; } h3 { font-size: 1.12em; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 0.75em 0; }
a { color: #E08BFF; text-underline-offset: 3px; }
strong { color: #F5EFFF; font-weight: 600; }
em { color: #C9BFE0; }
code {
  background: rgba(199, 78, 255, 0.13);
  border: 1px solid rgba(199, 78, 255, 0.18);
  border-radius: 4px;
  padding: 0.08em 0.36em;
  font-size: 0.92em;
  color: #E9DDFB;
}
pre.code {
  background: rgba(12, 6, 22, 0.55);
  border: 1px solid rgba(199, 78, 255, 0.16);
  border-radius: 10px;
  padding: 13px 15px;
  overflow-x: auto;
  margin: 1em 0;
}
pre.code code { background: none; border: 0; padding: 0; color: #D9D2EA; font-size: 12.5px; }
pre.mermaid { background: none; border: 0; text-align: center; margin: 1.2em 0; }
blockquote {
  margin: 1em 0;
  padding: 2px 0 2px 14px;
  border-left: 2px solid rgba(199, 78, 255, 0.45);
  color: #B7ADCE;
}
ul, ol { margin: 0.7em 0; padding-left: 1.4em; }
li { margin: 0.3em 0; }
li::marker { color: #C74EFF; }
hr { border: 0; border-top: 1px solid rgba(199, 78, 255, 0.2); margin: 1.7em 0; }
img, svg { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; display: block; overflow-x: auto; }
th, td { border: 1px solid rgba(199, 78, 255, 0.18); padding: 7px 11px; text-align: left; }
th { background: rgba(199, 78, 255, 0.1); color: #F0EAFB; font-weight: 600; }
.ember-raw { color: #D9D2EA; }
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
body { color: #2E2640; }
h1, h2, h3, h4, h5, h6, strong, th { color: #1B1426; }
a { color: #7A22AE; }
em { color: #4A3F5E; }
code { background: rgba(130, 39, 184, 0.08); border-color: rgba(130, 39, 184, 0.18); color: #3B2156; }
pre.code { background: rgba(46, 38, 64, 0.05); border-color: rgba(130, 39, 184, 0.16); }
pre.code code, .ember-raw { color: #2E2640; }
blockquote { border-left-color: rgba(130, 39, 184, 0.45); color: #564A6B; }
li::marker { color: #8227B8; }
hr { border-top-color: rgba(130, 39, 184, 0.2); }
th, td { border-color: rgba(130, 39, 184, 0.2); }
th { background: rgba(130, 39, 184, 0.07); }
`

/** The controls and scrollbars on paper. Alone, this is what an authored page gets: its own design is left alone. */
const LIGHT_INTERACT = `
::-webkit-scrollbar-thumb { background: rgba(130, 39, 184, 0.16); background-clip: padding-box; }
:hover::-webkit-scrollbar-thumb { background: rgba(130, 39, 184, 0.34); background-clip: padding-box; }
.ember-act { border-color: rgba(130, 39, 184, 0.4); background: rgba(130, 39, 184, 0.08); color: #3B2156; }
.ember-act:hover { background: rgba(130, 39, 184, 0.16); border-color: rgba(130, 39, 184, 0.65); }
.ember-act.is-sent { background: rgba(11, 122, 92, 0.12); border-color: rgba(11, 122, 92, 0.45); }
.ember-ask { border-color: rgba(130, 39, 184, 0.22); background: rgba(130, 39, 184, 0.04); }
.ember-ask-opt { border-color: rgba(130, 39, 184, 0.28); background: rgba(130, 39, 184, 0.05); color: #1B1426; }
.ember-ask-opt:hover { background: rgba(130, 39, 184, 0.13); border-color: rgba(130, 39, 184, 0.55); }
.ember-ask-opt .hint { color: #5E5373; }
.ember-ask-free textarea { border-color: rgba(130, 39, 184, 0.28); background: rgba(255, 255, 255, 0.7); color: #1B1426; }
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
  background: rgba(199, 78, 255, 0.13);
  border: 3.5px solid transparent;
  border-radius: 99px;
  background-clip: padding-box;
  transition: background 180ms ease;
}
:hover::-webkit-scrollbar-thumb { background: rgba(199, 78, 255, 0.34); background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(199, 78, 255, 0.55); background-clip: padding-box; }
::-webkit-scrollbar-thumb:active { background: rgba(199, 78, 255, 0.72); background-clip: padding-box; }
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
  padding: 5px 12px;
  border: 1px solid rgba(199, 78, 255, 0.35);
  border-radius: 999px;
  background: rgba(199, 78, 255, 0.12);
  color: #F0EAFB;
  font: inherit;
  font-size: 0.92em;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.ember-act:hover { background: rgba(199, 78, 255, 0.24); border-color: rgba(199, 78, 255, 0.6); }
.ember-act:active { transform: translateY(1px); }
.ember-act.is-sent { background: rgba(120, 255, 190, 0.16); border-color: rgba(120, 255, 190, 0.4); }

.ember-ask {
  border: 1px solid rgba(199, 78, 255, 0.22);
  border-radius: 12px;
  background: rgba(28, 16, 48, 0.5);
  padding: 16px 18px;
  margin: 0 0 14px;
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
  border: 1px solid rgba(199, 78, 255, 0.26);
  border-radius: 9px;
  background: rgba(199, 78, 255, 0.08);
  color: #F0EAFB;
  font: inherit;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.ember-ask-opt:hover { background: rgba(199, 78, 255, 0.2); border-color: rgba(199, 78, 255, 0.55); }
.ember-ask-opt .hint { display: block; margin-top: 3px; font-size: 0.86em; color: #A99DC4; }

.ember-ask-free { display: flex; gap: 8px; margin-top: 12px; align-items: flex-end; }
.ember-ask-free textarea {
  flex: 1;
  min-height: 38px;
  max-height: 180px;
  resize: vertical;
  padding: 8px 11px;
  border: 1px solid rgba(199, 78, 255, 0.24);
  border-radius: 9px;
  background: rgba(12, 6, 22, 0.6);
  color: #E9DDFB;
  font: inherit;
  font-size: 0.95em;
  outline: none;
}
.ember-ask-free textarea:focus { border-color: rgba(199, 78, 255, 0.6); }
.ember-ask-sent { margin-top: 12px; color: #8FE9C0; font-size: 0.92em; }
.ember-ask.is-answered .ember-ask-options,
.ember-ask.is-answered .ember-ask-free { display: none; }

/* What the picker paints while the user is choosing something to talk about. Injected
   from the renderer rather than shipped in the page, so it also applies to a website
   the panel happens to be browsing. */
html.ember-picking, html.ember-picking * { cursor: crosshair !important; }
.ember-pick-hover {
  outline: 2px solid #C74EFF !important;
  outline-offset: 1px !important;
  background: rgba(199, 78, 255, 0.12) !important;
}
`

/**
 * The page's half of the conversation.
 *
 * Two jobs, both of which need to run inside the document rather than out here: press
 * anything carrying `data-ember-send` and it types into the terminal, and tell Ember
 * when the caret is in one of this page's own fields so a dictated sentence lands
 * there instead of in the prompt.
 *
 * On the desk it reaches the app by POSTing to the bridge it was served from — same
 * origin, so no CORS and no preload — carrying the per-document secret written in below.
 * A page on any other origin has neither, which is what keeps a browsed website from
 * typing into the terminal.
 *
 * On the phone there is no bridge to POST to: the document arrived over the relay and is
 * shown in a sandboxed frame with no origin at all. There it talks to its host by
 * postMessage instead. The frame is sandboxed without `allow-same-origin`, so it cannot
 * read the app's storage or the account key — the isolation the webview provides on the
 * desk, provided differently.
 *
 * The secret still travels either way. It is meaningless to the phone's host, which knows
 * which machine the panel came from, but it is what the *desk* checks when the act comes
 * back round — so a document cannot act on a tab it does not belong to.
 */
function runtime(actSecret: string, viaParent = false): string {
  return `<script>
(function () {
  var ACT = ${JSON.stringify(actSecret)}
  var VIA_PARENT = ${viaParent ? 'true' : 'false'}

  function post(body) {
    body.act = ACT
    if (VIA_PARENT) {
      body.__emberPanel = true
      try { parent.postMessage(body, '*') } catch (_) { /* no host to tell */ }
      return
    }
    return fetch('/panel/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () { /* A dead bridge means Ember is gone; nothing to report to. */ })
  }

  function send(text, submit) {
    text = String(text == null ? '' : text).trim()
    if (!text) return
    post({ kind: 'send', text: text, submit: submit !== false })
  }

  function editable(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.isContentEditable) return true
    var tag = el.tagName
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly
    if (tag !== 'INPUT') return false
    return !el.disabled && !el.readOnly && !/^(button|submit|reset|checkbox|radio|range|file|color|image|hidden)$/i.test(el.type || 'text')
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

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-ember-send], [data-ember-free]') : null
    if (!t) return
    e.preventDefault()

    if (t.hasAttribute('data-ember-free')) {
      var box = document.getElementById(t.getAttribute('data-ember-free'))
      var typed = box ? box.value : ''
      if (!String(typed).trim()) { if (box) box.focus(); return }
      send(typed, true)
      retire(t.closest('.ember-ask'), typed)
      return
    }

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
  // the one a terminal user already has in their fingers.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    var box = e.target
    if (!box || box.tagName !== 'TEXTAREA' || !box.id) return
    var btn = document.querySelector('[data-ember-free="' + box.id + '"]')
    if (!btn) return
    e.preventDefault()
    btn.click()
  })

})()
</script>`
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
  primaryBorderColor: '#C74EFF',
  secondaryColor: '#1F1436',
  tertiaryColor: '#160E28',
  lineColor: '#8A6FB5',
  textColor: '#D9D2EA',
  mainBkg: '#2A1A44',
  nodeBorder: '#C74EFF',
  clusterBkg: 'rgba(199, 78, 255, 0.07)',
  clusterBorder: 'rgba(199, 78, 255, 0.3)',
  edgeLabelBackground: '#1A0E2E',
}

/** The diagram on paper: pale lavender boxes, the purple kept for the borders. */
const MERMAID_LIGHT = {
  background: 'transparent',
  primaryColor: '#F1E8FA',
  primaryTextColor: '#1B1426',
  primaryBorderColor: '#8227B8',
  secondaryColor: '#F6F0FB',
  tertiaryColor: '#FBF8FD',
  lineColor: '#7A6496',
  textColor: '#2E2640',
  mainBkg: '#F1E8FA',
  nodeBorder: '#8227B8',
  clusterBkg: 'rgba(130, 39, 184, 0.05)',
  clusterBorder: 'rgba(130, 39, 184, 0.3)',
  edgeLabelBackground: '#FBF8FD',
}

const mermaidBoot = (light: boolean) => `
<script src="/vendor/mermaid.min.js"></script>
<script>
  (function () {
    var blocks = document.querySelectorAll('pre.mermaid')
    if (!blocks.length) return
    if (!window.mermaid) {
      blocks.forEach(function (b) { b.className = 'code' })
      return
    }
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      fontFamily: 'inherit',
      themeVariables: ${JSON.stringify(light ? MERMAID_LIGHT : MERMAID_DARK)}
    })
    window.mermaid.run({ nodes: blocks }).then(fixContrast).catch(function () {
      blocks.forEach(function (b) { b.className = 'code' })
    })

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

function shell(body: string, act: string, viaParent = false, light = false): string {
  const head = body.includes('class="mermaid"') ? mermaidBoot(light) : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}${SCROLLBARS}${INTERACT_STYLE}${light ? LIGHT_STYLE + LIGHT_INTERACT : ''}</style>
</head><body>${body}${head}${runtime(act, viaParent)}</body></html>`
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
  color: #D9D2EA;
  font: 13.5px/1.6 "CaskaydiaCove NF", "Cascadia Code", Consolas, ui-monospace, monospace;
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
  font: 13.5px/1.6 "CaskaydiaCove NF", "Cascadia Code", Consolas, ui-monospace, monospace;
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
    ? { paper, ink: '#2E2640', strong: '#1B1426', muted: '#5E5373', accent: '#7A22AE', line: 'rgba(46, 38, 64, 0.16)', surface: 'rgba(46, 38, 64, 0.05)' }
    : { paper: '#1D1530', ink: '#D9D2EA', strong: '#F0EAFB', muted: '#A99DC4', accent: '#E08BFF', line: 'rgba(217, 210, 234, 0.16)', surface: 'rgba(255, 255, 255, 0.04)' }
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
function graft(page: string, act: string, viaParent = false, light = false, paper = DEFAULT_PAPER): string {
  const source = unfence(page)
  // The scrollbars go in too. A model-authored page is still a page inside Ember's
  // panel, and a browser-default bar down the side of it is the one part that gives
  // away that it is a webview.
  const addition = `<style>${SCROLLBARS}${INTERACT_STYLE}${light ? LIGHT_INTERACT : ''}</style>${light ? lightGuard(paper) : ''}${runtime(act, viaParent)}`

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

export function renderPanelDocument(push: PanelPush, target: PanelTarget = 'bridge', light = false, paper = DEFAULT_PAPER): string {
  const act = push.act ?? ''
  const viaParent = target === 'phone'
  const html = renderFor(push, act, viaParent, light, paper)
  // The phone bundles mermaid rather than fetching it from a bridge it cannot see.
  return viaParent ? html.replace('/vendor/mermaid.min.js', 'mermaid.min.js') : html
}

function renderFor(push: PanelPush, act: string, viaParent: boolean, light: boolean, paper: string): string {
  switch (push.format) {
    case 'html':
      // Passed through as its own document. It is untrusted, and it is contained by
      // being on this origin in a webview rather than by being filtered here — a
      // sanitiser that has to be right every time is a worse bet than an isolation
      // boundary that does not.
      return graft(push.content, act, viaParent, light, paper)

    case 'code':
      return shell(
        `<pre class="code"><code data-lang="${escapeHtml(push.language ?? '')}">${escapeHtml(push.content)}</code></pre>`,
        act,
        viaParent,
        light
      )

    case 'mermaid':
      return shell(`<pre class="mermaid">${escapeHtml(push.content)}</pre>`, act, viaParent, light)

    case 'ask':
      return shell(askCard(push), act, viaParent, light)

    case 'url':
      // On the desk a url push navigates the webview instead of building a page. The
      // phone has no browser to hand it to, so it gets something it can tap instead.
      return shell(
        `<p>Opening <a href="${escapeHtml(push.content)}" target="_blank" rel="noreferrer">${escapeHtml(push.content)}</a>…</p>`,
        act,
        viaParent,
        light
      )

    case 'markdown':
    default:
      return shell(markdownToHtml(push.content), act, viaParent, light)
  }
}
