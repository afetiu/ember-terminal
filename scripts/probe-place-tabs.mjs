/**
 * The places as tabs: the sidebar's Todo and Notes buttons each open a tab of their own,
 * and those are the only places there are. Prints the sidebar's buttons and the tabs,
 * screenshots the result, and exits non-zero when a place is missing or an extra one shows.
 *
 *   node scripts/probe-place-tabs.mjs [out-prefix]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'kbd'
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-tabs')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9390
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let target
for (let i = 0; i < 60 && !target; i++) {
  await wait(500)
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  pending.get(m.id)?.(m.result ?? m.error)
  pending.delete(m.id)
})
const send = (method, params = {}) =>
  new Promise((r) => {
    pending.set(++id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
const snap = () => ev('window.__ember.loom()')
const write = (sid, text) => ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(text)})`)
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}-${name}.png`, Buffer.from(r.data, 'base64'))
}
const key = async (key, code, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: { ArrowUp: 38, ArrowRight: 39, Escape: 27 }[key] ?? 0, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
}

await wait(5000)
const navs = await ev(`[...document.querySelectorAll('.ember-sidebar button')].map((b) => (b.getAttribute('aria-label') || b.title || '').slice(0, 30))`)
console.log('  sidebar buttons:', JSON.stringify(navs))
const clickLabel = (re) => ev(`(() => { const b = [...document.querySelectorAll('.ember-sidebar button')].find((x) => ${re}.test(x.getAttribute('aria-label') || x.title || '')); b?.click(); return !!b })()`)
const failures = []
const todo = await clickLabel('/^todo$/i')
console.log('  todo:', todo)
if (!todo) failures.push('no Todo button in the sidebar')
await wait(1200)
const notes = await clickLabel('/^notes$/i')
console.log('  notes:', notes)
if (!notes) failures.push('no Notes button in the sidebar')
await wait(1200)
const gone = (navs ?? []).filter((l) => /council|orchestrat|^map$/i.test(l))
if (gone.length) failures.push(`removed places still in the sidebar: ${gone.join(', ')}`)
const tabs = await ev(`[...document.querySelectorAll('.ember-card .ember-card-title')].map((t) => t.textContent.trim())`)
console.log('  tabs:', JSON.stringify(tabs))
if (!tabs?.some((t) => /^todo/i.test(t))) failures.push('no Todo tab opened')
if (!tabs?.some((t) => /notes/i.test(t))) failures.push('no Notes tab opened')
if (tabs?.some((t) => /^(council|map)$/i.test(t))) failures.push('a Council or Map tab is open')
await shot('tabs')
ws.close()
child.kill()
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`)
  process.exit(1)
}
console.log('  PLACE TABS OK')
process.exit(0)
