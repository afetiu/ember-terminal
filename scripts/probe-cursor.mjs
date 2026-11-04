/**
 * Is the caret drawn where the caret actually is?
 *
 * The caret is painted on Ember's own canvas, so nothing in the DOM contradicts it when
 * it drifts — it just looks slightly wrong, which is the hardest kind of wrong to pin
 * down by eye. The buffer gives the ground truth: the cursor's cell, times the cell size.
 * Comparing the painted pixels against that cell turns "looks a bit off" into a number.
 * (xterm's hidden textarea, parked for IME, used to be the reference; it can lag a row
 * behind after a prompt that wraps, so it is only the fallback.)
 *
 * This catches the specific bug it was written for — a sprite whose intrinsic size is in
 * device pixels blitted into a context already scaled by dpr, which is correct at 100%
 * scaling and off by half a caret at 150%. Run it on a HiDPI display or it proves little.
 *
 *   node scripts/probe-cursor.mjs      (its own dev Ember; EMBER_CDP_PORT=n attaches to a running one)
 */
import { emberPage } from './probelib.mjs'
const ember = await emberPage('probe-cursor', 9492)
const PORT = ember.port
/** Pixels of disagreement worth complaining about. Sub-pixel rounding is not a bug. */
const TOLERANCE = 2

const page = ember.page

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result)
    waiting.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq
    waiting.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}

/**
 * Read the caret canvas back and find the solid core of what was painted.
 *
 * Only strongly opaque pixels count. The glow is a wide, faint skirt around the caret and
 * including it would measure the blur radius rather than the caret's position; the recoil
 * and trail are likewise deliberately soft. Alpha 200 is comfortably inside the fill and
 * comfortably outside anything feathered.
 */
const expression = `(() => {
  const screen = document.querySelector('.xterm-screen') || document.querySelector('.xterm')
  const ta = document.querySelector('.xterm-helper-textarea')
  const canvas = [...document.querySelectorAll('canvas')].find(c => c.className.includes('cursor') || c.parentElement?.className.includes('cursor'))
    || [...document.querySelectorAll('canvas')].find(c => !c.className.includes('xterm'))
  if (!screen || !ta || !canvas) return JSON.stringify({ error: 'missing ' + (!screen ? 'screen' : !ta ? 'textarea' : 'canvas') })

  const ctx = canvas.getContext('2d')
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const dpr = window.devicePixelRatio || 1
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hits = 0
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (img[(y * canvas.width + x) * 4 + 3] > 200) {
        hits++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!hits) return JSON.stringify({ error: 'nothing solid painted on the caret canvas' })

  // Canvas pixels are device pixels; the textarea is positioned in CSS pixels. The caret
  // canvas is a window that follows the caret (SmoothCursor.place), translated to where it
  // sits over the screen, so its own pixels are offset by that translation.
  const m = /translate3d\\(\\s*(-?[\\d.]+)px,\\s*(-?[\\d.]+)px/.exec(canvas.style.transform || '')
  const ox = m ? parseFloat(m[1]) : 0
  const oy = m ? parseFloat(m[2]) : 0
  const painted = { x: ox + minX / dpr, y: oy + minY / dpr, w: (maxX - minX + 1) / dpr, h: (maxY - minY + 1) / dpr }
  // Where the cursor is, from the buffer itself: xterm moves its textarea only on some
  // events, so after a prompt that wraps (a right-aligned clock one cell too wide) the
  // textarea can sit a row behind a caret that is exactly right.
  const sess = window.__ember?.sessions?.()[0]
  const term = sess && window.__ember.term(sess.id)
  const sr = screen.getBoundingClientRect()
  const expected = term
    ? { x: term.buffer.active.cursorX * (sr.width / term.cols), y: term.buffer.active.cursorY * (sr.height / term.rows) }
    : { x: parseFloat(ta.style.left) || 0, y: parseFloat(ta.style.top) || 0 }
  return JSON.stringify({ dpr, painted, expected, canvas: { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth } })
})()`

const raw = await evaluate(expression)
const r = JSON.parse(raw)
if (r.error) {
  console.error('could not measure:', r.error)
  ws.close()
  process.exit(1)
}

const dx = r.painted.x - r.expected.x
const dy = r.painted.y - r.expected.y
console.log(`  devicePixelRatio : ${r.dpr}`)
console.log(`  caret painted at : ${r.painted.x.toFixed(1)}, ${r.painted.y.toFixed(1)}  (${r.painted.w.toFixed(1)} x ${r.painted.h.toFixed(1)})`)
console.log(`  the buffer says  : ${r.expected.x.toFixed(1)}, ${r.expected.y.toFixed(1)}`)
console.log(`  offset           : ${dx.toFixed(1)}, ${dy.toFixed(1)}`)

const ok = Math.abs(dx) <= TOLERANCE && Math.abs(dy) <= TOLERANCE
console.log(`\n  ${ok ? 'PASS — caret is where xterm says the cursor is' : 'FAIL — caret is drawn off its cell'}`)
if (!ok && r.dpr !== 1) {
  console.log(`  offset is ${(dx / (r.dpr - 1 || 1)).toFixed(1)}x the dpr excess — suspect a device/CSS pixel mix-up`)
}
ws.close()
process.exit(ok ? 0 : 1)
