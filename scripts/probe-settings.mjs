/**
 * Does the settings panel actually build what it claims to?
 *
 * Opens the panel and reads the DOM back: the filter, the speed presets, the sections,
 * and what filtering actually leaves on screen. Checking
 * a settings panel by eye means opening it, and opening it means remembering to; this
 * asks the page instead.
 *
 *   node scripts/probe-settings.mjs      (its own dev Ember; EMBER_CDP_PORT=n attaches to a running one)
 */
import { emberPage } from './probelib.mjs'
const ember = await emberPage('probe-settings', 9496)
const PORT = ember.port
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  if (r.exceptionDetails) return `ERROR: ${r.exceptionDetails.text}`
  return r.result.value
}

await evaluate('window.__ember.openSettings()')
await sleep(900)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`)
}
const rowCount = () => evaluate("document.querySelectorAll('.ember-settings-row').length")

check('the panel opens', await evaluate("document.querySelector('.ember-settings')?.classList.contains('is-open') === true"))
check('it has a filter box', await evaluate("!!document.querySelector('.ember-settings-filter')"))
// The speed presets are on the Motion tab.
await evaluate(`document.querySelector('.ember-settings-tab[data-tab="Motion"]')?.click()`)
await sleep(300)
const presets = await evaluate("[...document.querySelectorAll('.ember-preset-btn')].map(b => b.textContent + (b.classList.contains('is-current') ? ' (current)' : '')).join(', ')")
check('the speed presets are there', !!presets, presets)
const sections = await evaluate("document.querySelectorAll('.ember-settings-section').length")
check('it shows its sections', sections > 0, `${sections}`)

// Every row, over all the tabs, to compare a filtered panel with.
let all = 0
for (const t of await evaluate(`[...document.querySelectorAll('.ember-settings-tab')].map((b) => b.dataset.tab)`)) {
  await evaluate(`document.querySelector('.ember-settings-tab[data-tab="${t}"]').click()`)
  await sleep(200)
  all += await rowCount()
}

// Filtering is the whole point of the box; assert it narrows rather than just renders.
const filter = async (term) => {
  await evaluate(
    `(() => { const f = document.querySelector('.ember-settings-filter'); f.value = ${JSON.stringify(term)}; f.dispatchEvent(new Event('input')); })()`,
  )
  await sleep(250)
  const rows = await rowCount()
  const shown = await evaluate("[...document.querySelectorAll('.ember-settings-section h3')].map(h => h.textContent).join(', ')")
  const empty = await evaluate("!!document.querySelector('.ember-settings-empty')")
  return { rows, shown, empty }
}
const opacity = await filter('opacity')
check('"opacity" narrows the rows to a few', opacity.rows > 0 && opacity.rows < all, `${all} -> ${opacity.rows} (${opacity.shown || 'no sections'})`)
const none = await filter('zzzz')
check('nothing matching says so', none.rows === 0 && none.empty, `${none.rows} row(s)${none.empty ? ' + empty message' : ''}`)

ws.close()
console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
