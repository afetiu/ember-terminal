/**
 * The element picker, as source to be injected into the panel's guest page.
 *
 * It is a string rather than a module because it does not run here. The panel's
 * webview is a separate process on a separate origin — that separation is the whole
 * containment story for model-authored HTML — so anything that needs to see the
 * document has to be handed across as text and evaluated there.
 *
 * It is injected rather than baked into the rendered page for one reason: a `url`
 * panel is a real website Ember did not write, and picking a row out of a docs page or
 * a dashboard is worth as much as picking one out of a table Claude drew. The same
 * code has to work in both.
 *
 * Communication back is deliberately one-way and pull-based. The guest stashes the
 * pick; Ember reads it on the next poll. A page cannot push anything at the app, which
 * matters when the page is `https://whatever-the-user-opened`.
 */
export const PICK_RUNTIME = `(function () {
  if (window.__emberPick) { window.__emberPick.on(); return 'again' }

  var HOVER = 'ember-pick-hover'
  var BLOCKS = ['TR','LI','PRE','BLOCKQUOTE','P','H1','H2','H3','H4','H5','H6','FIGURE','TABLE','BUTTON','A','IMG','SVG','CANVAS','SECTION','ARTICLE','ASIDE','FORM','DETAILS']
  var active = false
  var hovered = null
  var picked = null

  /**
   * What the user meant by clicking there.
   *
   * A cell is almost never the interesting thing — the row it is in is — so cells are
   * promoted to their row. Past that it is the nearest ancestor that is a block of
   * meaning rather than a span of styling, which is what stops a click on a bold word
   * selecting the bold word.
   */
  function candidate(el) {
    if (!el || el.nodeType !== 1) return null
    if (el.tagName === 'TD' || el.tagName === 'TH') return el.closest('tr') || el
    var n = el
    while (n && n !== document.body && n !== document.documentElement) {
      if (n.tagName === 'TD' || n.tagName === 'TH') return n.closest('tr') || n
      if (BLOCKS.indexOf(n.tagName) !== -1) return n
      n = n.parentElement
    }
    return el
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim()
  }

  /** A short human name for the thing, for the popover header and for the prompt. */
  function name(el) {
    var tag = el.tagName
    if (tag === 'TR') {
      var table = el.closest('table')
      if (el.closest('thead')) return 'the header row'
      // Counted among the body rows only. The user reading the table calls the first
      // row under the headings "row 1", and an off-by-one here is a sentence about the
      // wrong car.
      var rows = table
        ? Array.prototype.slice.call(table.querySelectorAll('tr')).filter(function (r) { return !r.closest('thead') })
        : []
      var head = 'row ' + (rows.indexOf(el) + 1)
      return table && table.caption ? head + ' of "' + clean(table.caption.textContent) + '"' : head
    }
    if (tag === 'LI') {
      var list = el.parentElement
      var items = list ? Array.prototype.slice.call(list.children).filter(function (c) { return c.tagName === 'LI' }) : []
      return 'item ' + (items.indexOf(el) + 1)
    }
    if (/^H[1-6]$/.test(tag)) return 'heading'
    if (tag === 'PRE' || tag === 'CODE') return 'code block'
    if (tag === 'TABLE') return 'table'
    if (tag === 'IMG') return 'image'
    if (tag === 'SVG' || tag === 'svg') return 'diagram'
    if (tag === 'A') return 'link'
    if (tag === 'BUTTON') return 'button'
    if (tag === 'BLOCKQUOTE') return 'quote'
    return tag.toLowerCase()
  }

  /**
   * The text of a row is read cell by cell.
   *
   * \`innerText\` on a table row runs the cells together with tabs or nothing at all
   * depending on layout, and "Ford Focus2014" is not a thing anyone can be asked
   * about. Joining on a pipe keeps the columns legible in a single-line prompt.
   */
  function text(el) {
    var out = ''
    if (el.tagName === 'TR') {
      out = Array.prototype.map.call(el.children, function (c) { return clean(c.innerText || c.textContent) }).join(' | ')
    } else if (el.tagName === 'IMG') {
      out = clean(el.alt) || clean(el.getAttribute('src')).slice(0, 120)
    } else {
      out = clean(el.innerText || el.textContent)
    }
    return out.length > 700 ? out.slice(0, 700) + '…' : out
  }

  function paint(el) {
    if (hovered === el) return
    if (hovered) hovered.classList.remove(HOVER)
    hovered = el
    if (hovered) hovered.classList.add(HOVER)
  }

  function onMove(e) {
    if (!active) return
    paint(candidate(e.target))
  }

  function onClick(e) {
    if (!active) return
    e.preventDefault()
    e.stopPropagation()
    var el = candidate(e.target)
    if (!el) return
    var r = el.getBoundingClientRect()
    picked = {
      name: name(el),
      text: text(el),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    off()
  }

  function onKey(e) {
    if (active && e.key === 'Escape') { picked = { cancelled: true }; off() }
  }

  function on() {
    active = true
    document.documentElement.classList.add('ember-picking')
  }

  function off() {
    active = false
    document.documentElement.classList.remove('ember-picking')
    paint(null)
  }

  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)

  window.__emberPick = {
    on: on,
    off: off,
    /** Hand over whatever was picked, once. Ember polls this while picking is armed. */
    take: function () { var p = picked; picked = null; return p }
  }

  on()
  return 'ready'
})()`

/**
 * The picker's own styling, for pages that were not served by Ember.
 *
 * Documents Ember renders already carry these rules; a website does not, and injecting
 * a stylesheet is cheaper and less invasive than setting inline styles on whatever the
 * cursor happens to be over and then trying to put them back.
 */
export const PICK_STYLE = `(function () {
  if (document.getElementById('ember-pick-style')) return
  var s = document.createElement('style')
  s.id = 'ember-pick-style'
  s.textContent = 'html.ember-picking, html.ember-picking * { cursor: crosshair !important; }' +
    '.ember-pick-hover { outline: 2px solid #C74EFF !important; outline-offset: 1px !important; background: rgba(199,78,255,0.12) !important; }'
  ;(document.head || document.documentElement).appendChild(s)
})()`
