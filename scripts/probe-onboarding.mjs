/**
 * Walk the onboarding and Settings › Agent in a running Ember and screenshot each step.
 *
 * Run against a throwaway home so the welcome appears and Labs is off:
 *
 *   $env:EMBER_HOME = "$env:TEMP\ember-onboard"; npx electron . --remote-debugging-port=9333
 *   node scripts/probe-onboarding.mjs <out-dir>          (EMBER_CDP_PORT, default 9333)
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env['EMBER_CDP_PORT'] ?? 9333)
const OUT = process.argv[2] ?? '.'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page
for (let i = 0; i < 40 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
  } catch {
    /* not up yet */
  }
  if (!page) await sleep(500)
}
if (!page) {
  console.error('No renderer target on port %d', PORT)
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
  if (r.exceptionDetails) return `ERROR: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
  return r.result.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`  shot ${file}`)
}
const click = (sel) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return 'missing ${sel}'; b.click(); return 'ok' })()`)

// Up to a few seconds for the welcome to appear.
for (let i = 0; i < 20; i++) {
  if (await evaluate("!!document.querySelector('.ember-onboard.is-open')")) break
  await sleep(300)
}
console.log('  welcome open     :', await evaluate("!!document.querySelector('.ember-onboard.is-open')"))
console.log('  labs-off class   :', await evaluate("document.body.classList.contains('labs-off')"))
await sleep(500)
await shot('1-welcome')

await click('.ember-onboard-btn.is-primary')
await sleep(4500)
console.log('  agents listed    :', await evaluate("[...document.querySelectorAll('.ember-agent')].map(a => a.querySelector('.ember-agent-name')?.textContent + (a.classList.contains('is-chosen') ? ' *' : '')).join(' | ')"))
await shot('2-agent')

await click('.ember-onboard-btn.is-primary')
await sleep(800)
await shot('3-look')

await click('.ember-onboard-btn.is-primary')
await sleep(500)
await shot('4-keys')

// Finish without launching anything.
await evaluate("(() => { const t = [...document.querySelectorAll('.ember-onboard-toggle input')].pop(); if (t && t.checked) t.click() })()")
await click('.ember-onboard-btn.is-primary')
await sleep(900)
console.log('  welcome closed   :', await evaluate("!document.querySelector('.ember-onboard')"))

await evaluate("window.__ember?.openSettings?.()")
await sleep(700)
await evaluate("(() => { const t = [...document.querySelectorAll('.ember-settings-tab')].find(b => b.dataset.tab === 'Agent'); t?.click() })()")
await sleep(4000)
await shot('5-settings-agent')
await evaluate("(() => { const t = [...document.querySelectorAll('.ember-settings-tab')].find(b => b.dataset.tab === 'Labs'); t?.click() })()")
await sleep(500)
await shot('6-settings-labs')
ws.close()
