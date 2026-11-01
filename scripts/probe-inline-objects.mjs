/**
 * The keyboard path: a new terminal (with its hint), `claude` typed, a diagram asked for,
 * then Ctrl+↑ onto it, Shift+→ to snap it right, Esc back to typing. Screenshots of each.
 *
 *   node scripts/probe-kbd-canvas.mjs [out-prefix]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'kbd'
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-inline')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9388
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
await shot('terminal')
const sid = (await snap()).sessionId
await write(sid, 'claude')
await wait(300)
await write(sid, String.fromCharCode(13))
for (let i = 0; i < 40; i++) {
  if ((await snap()).mode === 'claude') break
  await wait(1000)
}
await wait(3000)
await write(sid, 'Reply with only a mermaid code block in your message (do not use any tool): flowchart LR with A --> B --> C.')
await wait(500)
await write(sid, String.fromCharCode(13))
for (let i = 0; i < 60; i++) {
  if (await ev(`!!document.querySelector('.loom-shown .loom-liftable, .loom-turn.is-shown .loom-liftable')`)) break
  await wait(1000)
}
await wait(3000)
await key('ArrowUp', 'ArrowUp', 2) // Ctrl
await wait(700)
await shot('selected')
console.log('  ring on:', await ev(`!!document.querySelector('.loom-piece.is-kbd')`), ' legend on:', await ev(`!!document.querySelector('.loom-kbd-legend.is-on')`))
const g = await ev(`(() => { const r = document.querySelector('.loom-turn.is-shown .loom-inline-rz')?.getBoundingClientRect(); return r ? { x: r.left + 8, y: r.top + 8 } : null })()`)
console.log('  grip:', JSON.stringify(g))
await key('Escape', 'Escape')
await wait(300)
if (g) {
  const m = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await m('mouseMoved', g.x - 40, g.y - 40)
  await m('mouseMoved', g.x, g.y)
  await m('mousePressed', g.x, g.y)
  for (let i = 1; i <= 10; i++) { await m('mouseMoved', g.x - i * 30, g.y + i * 25); await wait(30) }
  await m('mouseReleased', g.x - 300, g.y + 250)
}
await wait(800)
await shot('resized')
console.log('  ring gone after Esc:', await ev(`!document.querySelector('.is-kbd')`))
console.log('  sized:', await ev(`!!document.querySelector('.loom-liftable.is-sized')`))
ws.close()
child.kill()
