/**
 * Does the settings panel actually build what it claims to?
 *
 * Opens the panel in a running Ember and reads the DOM back: the filter, the speed
 * presets, the OpenAI key field, and what filtering actually leaves on screen. Checking
 * a settings panel by eye means opening it, and opening it means remembering to; this
 * asks the page instead.
 *
 *   node scripts/probe-settings.mjs      (needs --remote-debugging-port=9222)
 */
const PORT = Number(process.env['EMBER_CDP_PORT'] ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!page) {
  console.error('No renderer target — launch Ember with --remote-debugging-port=%d', PORT)
  process.exit(1)
}

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

const checks = {
  'panel open': "document.querySelector('.ember-settings')?.classList.contains('is-open')",
  'filter box present': "!!document.querySelector('.ember-settings-filter')",
  'speed presets': "[...document.querySelectorAll('.ember-preset-btn')].map(b => b.textContent + (b.classList.contains('is-current') ? ' (current)' : '')).join(', ')",
  'OpenAI key field': "!!document.querySelector('.ember-secret input')",
  'key field state': "document.querySelector('.ember-secret input')?.placeholder",
  'key is masked': "document.querySelector('.ember-secret input')?.type === 'password'",
  'sections shown': "document.querySelectorAll('.ember-settings-section').length",
}
for (const [label, expr] of Object.entries(checks)) {
  console.log(`  ${label.padEnd(22)}: ${await evaluate(expr)}`)
}

// Filtering is the whole point of the box; assert it narrows rather than just renders.
for (const term of ['opacity', 'key', 'zzzz']) {
  await evaluate(
    `(() => { const f = document.querySelector('.ember-settings-filter'); f.value = ${JSON.stringify(term)}; f.dispatchEvent(new Event('input')); })()`,
  )
  await sleep(250)
  const sections = await evaluate(
    "[...document.querySelectorAll('.ember-settings-section h3')].map(h => h.textContent).join(', ')",
  )
  const rows = await evaluate("document.querySelectorAll('.ember-settings-row').length")
  const empty = await evaluate("!!document.querySelector('.ember-settings-empty')")
  console.log(`\n  filter "${term}" -> ${rows} row(s)${empty ? ' + empty message' : ''}`)
  console.log(`    sections: ${sections || '(none)'}`)
}

ws.close()
