/**
 * Reordering sessions in the sidebar by dragging: three tabs, the last card dragged to
 * the top with real mouse events. Prints the card order before and after.
 *
 *   node scripts/probe-sidebar-drag.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-sidebar-drag')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9385
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
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await wait(4000)
await ev('window.__ember.newTab()')
await wait(1500)
await ev('window.__ember.newTab()')
await wait(2000)
const cards = () =>
  ev(`[...document.querySelectorAll('.ember-card')].map((c) => { const r = c.getBoundingClientRect(); return { t: c.querySelector('.ember-card-title')?.textContent?.trim() ?? '', y: Math.round(r.top + r.height / 2), x: Math.round(r.left + r.width / 2), order: getComputedStyle(c).order, hit: (() => { const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el ? el.className.toString().slice(0, 40) : 'none' })() } })`)
const before = await cards()
console.log('  before:', JSON.stringify(before))
const last = before[before.length - 1]
const first = before[0]
await mouse('mousePressed', last.x, last.y)
for (let i = 1; i <= 12; i++) {
  await mouse('mouseMoved', last.x, last.y + ((first.y - 10 - last.y) * i) / 12)
  await wait(30)
}
await mouse('mouseReleased', last.x, first.y - 10)
await wait(800)
const after = await cards()
console.log('  after: ', JSON.stringify(after.map((c) => ({ t: c.t, y: c.y, order: c.order }))))
const sorted = (l) => [...l].sort((a, b) => a.y - b.y).map((c) => c.t)
console.log('  visual order before:', sorted(before).join(' | '))
console.log('  visual order after: ', sorted(after).join(' | '))
// The active card (the last opened), dragged down past the others, slowly, while timers tick.
const now = await cards()
const active = await ev(`(() => { const c = document.querySelector('.ember-card.is-active, .ember-card[aria-selected="true"]'); return c ? c.querySelector('.ember-card-title')?.textContent?.trim() : null })()`)
console.log('  active card:', active)
const top = [...now].sort((a, b) => a.y - b.y)[0]
const bottomY = Math.max(...now.map((c) => c.y)) + 30
await mouse('mousePressed', top.x, top.y)
for (let i = 1; i <= 20; i++) {
  await mouse('mouseMoved', top.x, top.y + ((bottomY - top.y) * i) / 20)
  await wait(120)
}
await mouse('mouseReleased', top.x, bottomY)
await wait(2500)
console.log('  after drag down:', sorted(await cards()).join(' | '))
ws.close()
child.kill()
