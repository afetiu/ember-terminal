/**
 * Claude's replies, as markup for the canvas.
 *
 * Escape first, then add structure. Nothing the model wrote reaches the DOM as markup: it
 * is all text until one of the patterns below turns a piece of it into an element we
 * chose. That is the same rule panelDoc.ts follows for the panel, and it matters more
 * here — this runs in the renderer, next to `window.ember`. Anything richer than this
 * subset (a page of the model's own HTML, a diagram) is rendered on the bridge's origin
 * and shown in a frame, never inlined.
 *
 * Two things are left as placeholders for the view to resolve, because both need a
 * round trip to main: mermaid fences (hosted as a document) and images by local path
 * (registered as media). The placeholders carry an index into the arrays returned here,
 * never the content itself.
 */

export interface Rendered {
  html: string
  /** Mermaid sources, by placeholder index. */
  diagrams: string[]
  /** Local image paths, by placeholder index. */
  images: string[]
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/** A Windows or POSIX absolute path to an image file, as Claude writes them. */
const LOCAL_IMAGE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)[^<>"|?*]*\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i

function safeHref(raw: string): string {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url)) return url
  return ''
}

/** An inline picture: carried in the reply itself, so showing it asks nothing of anyone. */
function safeImage(raw: string): string {
  const url = raw.trim()
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url)) return url
  return ''
}

/**
 * A picture on someone else's server is not fetched until it is asked for.
 *
 * Loading it is a request to that server, and the URL is whatever the model wrote — which
 * can be whatever a web page or a file it read told it to write, with your data in the
 * query string. So it arrives as a button naming the host, and the view swaps in the real
 * image on a click (LoomView.click). Until then nothing on the page has the URL as a src.
 */
function remoteImage(alt: string, raw: string): string {
  const url = raw.trim()
  if (!/^https?:\/\//i.test(url)) return ''
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return ''
  }
  return (
    `<button type="button" class="loom-img-remote" data-src="${escapeHtml(url)}" data-alt="${alt}" title="${escapeHtml(url)}">` +
    `Image from ${escapeHtml(host)} — click to load</button>`
  )
}

class Inline {
  constructor(private readonly images: string[]) {}

  render(text: string): string {
    let out = escapeHtml(text)

    // Code spans first: nothing inside backticks is read as anything else.
    const codes: string[] = []
    out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
      codes.push(code)
      return `\u0000${codes.length - 1}\u0000`
    })
    // A code span inside a button's payload goes back to being backticked text: the
    // button has to send exactly what was written.
    const withCode = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `\`${codes[Number(i)] ?? ''}\``)

    // Finished elements whose attributes carry the model's text (a button's payload, an
    // image's address) are set aside the same way, so the link and emphasis passes below
    // cannot reach into them: an `*` in a command must not turn into <em> in data-send.
    const kept: string[] = []
    const stash = (html: string) => {
      kept.push(html)
      return `\u0001${kept.length - 1}\u0001`
    }

    out = out.replace(/!\[([^\]]*)\]\(([^)]+?)\)/g, (m, alt: string, href: string) => {
      const raw = unescapeHtml(href.trim()).replace(/^<|>$/g, '')
      if (LOCAL_IMAGE.test(raw)) {
        this.images.push(raw)
        return `<img class="loom-img" alt="${alt}" data-local="${this.images.length - 1}">`
      }
      const url = safeImage(raw)
      if (url) return `<img class="loom-img" alt="${alt}" src="${escapeHtml(url)}">`
      const remote = remoteImage(withCode(alt), raw)
      return remote ? stash(remote) : m
    })

    // `[Do it](ember:npm test)` is a button that speaks for the user; `ember-type:` only
    // fills the prompt. The same convention the panel has, so one habit works in both.
    out = out.replace(/\[([^\]]+)\]\((ember(?:-type)?):([^)]*)\)/g, (_m, label: string, scheme: string, arg: string) => {
      let value = unescapeHtml(withCode(arg.trim()))
      try {
        value = decodeURIComponent(value)
      } catch {
        /* a literal % */
      }
      const submit = scheme === 'ember' ? '1' : '0'
      const shown = unescapeHtml(withCode(label))
      // No payload sends the label itself, as plain text: code styling is not part of it.
      const send = value || shown.replace(/`/g, '')
      // The button speaks for the user, so its label cannot be all they see: when the
      // text it sends is not the text it shows, that text is on the button as well, and
      // in its tooltip. Backticks aside — `npm test` labelled npm test is the same thing.
      const differs = send.replace(/`/g, '').trim() !== shown.replace(/`/g, '').trim()
      const verb = submit === '1' ? 'Sends' : 'Types'
      return stash(
        `<button type="button" class="loom-act${differs ? ' has-sends' : ''}" data-send="${escapeHtml(send)}" data-submit="${submit}"` +
          (differs ? ` title="${escapeHtml(`${verb}: ${send}`)}">` : '>') +
          `<span class="loom-act-label">${label}</span>` +
          (differs ? `<span class="loom-act-sends">${escapeHtml(send)}</span>` : '') +
          `</button>`,
      )
    })

    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
      const url = safeHref(unescapeHtml(href))
      return url ? `<a class="loom-link" href="${escapeHtml(url)}">${label}</a>` : m
    })

    // Bare URLs become links too — a dev server's address is the thing most worth
    // clicking in a reply. Only outside tags already made.
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+[^\s<)"'.,;:!?])/g, (_m, pre: string, url: string) => {
      return `${pre}<a class="loom-link" href="${url}">${url}</a>`
    })

    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')

    out = out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => kept[Number(i)] ?? '')
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ''}</code>`)
  }
}

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

/** Column alignment from a delimiter row: `:--`, `:-:`, `--:`. */
function aligns(line: string): Array<'left' | 'center' | 'right' | ''> {
  return tableRow(line).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''))
}

/** Does this cell read as a number? Numeric columns are set right-aligned and tabular. */
function numeric(cell: string): boolean {
  return /^[-+−]?[$€£]?\s?[\d.,]+\s?(%|ms|s|x|×|k|m|kb|mb|gb)?$/i.test(cell.trim())
}

export function renderMarkdown(src: string): Rendered {
  const diagrams: string[] = []
  const images: string[] = []
  const inline = new Inline(images)
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  const listStack: Array<{ tag: 'ul' | 'ol'; indent: number }> = []
  const closeLists = (toIndent = -1): void => {
    while (listStack.length && listStack[listStack.length - 1]!.indent > toIndent) {
      out.push(`</${listStack.pop()!.tag}>`)
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      closeLists()
      const marker = fence[1]![0]!
      const lang = (fence[2] ?? '').toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*\\${marker}{3,}\\s*$`).test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++
      const text = body.join('\n')
      if (lang === 'mermaid') {
        diagrams.push(text)
        out.push(`<div class="loom-diagram" data-diagram="${diagrams.length - 1}"></div>`)
      } else {
        // Plain text wraps instead of scrolling sideways; code, and text drawn with box
        // characters (a tree, a table), keep their lines.
        const wrap = ['', 'text', 'txt', 'plain', 'plaintext', 'markdown', 'md'].includes(lang) && !/[─━│┃┌┐└┘├┤┬┴┼╭╮╰╯]/.test(text)
        out.push(
          `<div class="loom-code${wrap ? ' is-wrap' : ''}"><div class="loom-code-bar"><span>${escapeHtml(lang || 'text')}</span><button type="button" class="loom-copy" title="Copy">copy</button></div>` +
            `<pre><code>${escapeHtml(text)}</code></pre></div>`
        )
      }
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      closeLists()
      const head = tableRow(line)
      const align = aligns(lines[i + 1] ?? '')
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) rows.push(tableRow(lines[i++] ?? ''))
      const numCol = head.map((_h, c) => rows.length > 0 && rows.every((r) => !r[c] || numeric(r[c]!)))
      const cellAttr = (c: number): string => {
        const a = align[c] || (numCol[c] ? 'right' : '')
        return a ? ` style="text-align:${a}"` : ''
      }
      out.push(
        `<div class="loom-table"><table><thead><tr>${head.map((h, c) => `<th${cellAttr(c)}>${inline.render(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_h, c) => `<td${cellAttr(c)}>${inline.render(r[c] ?? '')}</td>`).join('')}</tr>`).join('') +
          `</tbody></table></div>`
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      closeLists()
      const level = Math.min(4, (heading[1] ?? '#').length)
      out.push(`<h${level}>${inline.render(heading[2] ?? '')}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeLists()
      out.push('<hr>')
      i++
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      closeLists()
      const body: string[] = [quote[1] ?? '']
      i++
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) body.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      const inner = renderMarkdown(body.join('\n'))
      // Quotes rarely carry diagrams; their placeholders would point into another array.
      out.push(`<blockquote>${inner.diagrams.length || inner.images.length ? escapeHtml(body.join('\n')) : inner.html}</blockquote>`)
      continue
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      const indent = (item[1] ?? '').replace(/\t/g, '    ').length
      const tag: 'ul' | 'ol' = /^\d/.test(item[2] ?? '') ? 'ol' : 'ul'
      const top = listStack[listStack.length - 1]
      if (!top || indent > top.indent) {
        listStack.push({ tag, indent })
        out.push(`<${tag}>`)
      } else {
        closeLists(indent)
        const now = listStack[listStack.length - 1]
        if (!now || now.indent < indent || now.tag !== tag) {
          if (now && now.indent === indent) out.push(`</${listStack.pop()!.tag}>`)
          listStack.push({ tag, indent })
          out.push(`<${tag}>`)
        }
      }
      let text = item[3] ?? ''
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
      if (task) text = `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}`
      out.push(`<li>${inline.render(text)}</li>`)
      i++
      continue
    }

    if (!line.trim()) {
      closeLists()
      i++
      continue
    }

    closeLists()
    const para: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (!l.trim() || /^\s*(?:```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(l)) break
      para.push(l)
      i++
    }
    out.push(`<p>${inline.render(para.join('\n')).replace(/\n/g, '<br>')}</p>`)
  }

  closeLists()
  return { html: out.join('\n'), diagrams, images }
}
