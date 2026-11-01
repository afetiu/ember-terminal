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
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-view')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9389
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
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2 })
await wait(600)
await shot('palette')
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await wait(400)
const sid = (await snap()).sessionId
await write(sid, 'claude')
await wait(300)
await write(sid, String.fromCharCode(13))
for (let i = 0; i < 40; i++) {
  if ((await snap()).mode === 'claude') break
  await wait(1000)
}
await wait(3000)
await shot('canvas')
console.log('  canvas bar:', JSON.stringify(await ev(`(() => { const r = document.querySelector('.loom-sign:not(.loom-rawpill)').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.right), Math.round(r.height)] })()`)))
await ev(`document.querySelector('.loom-sign [data-view="cli"]').click()`)
await wait(1500)
await shot('cli')
console.log('  cli bar:   ', JSON.stringify(await ev(`(() => { const r = document.querySelector('.loom-rawpill').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.right), Math.round(r.height)] })()`)))
console.log('  mode after CLI:', (await snap()).mode)
const { readFileSync } = await import('node:fs')
console.log('  saved view:', JSON.parse(readFileSync(join(EMBER_HOME, 'config.json'), 'utf8')).agentView)
ws.close()
child.kill()
