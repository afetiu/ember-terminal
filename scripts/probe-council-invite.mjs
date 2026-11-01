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
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-invite')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9391
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
await write(sid, 'In one sentence: should a small desktop app store its settings in JSON or SQLite?')
await wait(500)
await write(sid, String.fromCharCode(13))
for (let i = 0; i < 60; i++) {
  if ((await snap()).says > 0 && !(await snap()).working) break
  await wait(1000)
}
await wait(3000)
await wait(2000)
console.log('  council button:', await ev(`(() => { const b = document.querySelector('.loom-sign [data-s="council"]'); b?.click(); return !!b })()`))
await wait(2000)
console.log('  council tab active:', await ev(`[...document.querySelectorAll('.ember-card.is-active .ember-card-title')].map((t) => t.textContent.trim()).join()`))
await shot('council-running')
for (let i = 0; i < 150; i++) {
  if (await ev(`[...document.querySelectorAll('.ember-council button')].some((b) => /^Send to/.test(b.textContent.trim()))`)) break
  await wait(1000)
}
await shot('council-done')
console.log('  send button:', await ev(`(() => { const b = [...document.querySelectorAll('.ember-council button')].find((x) => /^Send to/.test(x.textContent.trim())); if (!b) return null; const t = b.textContent.trim(); b.click(); return t })()`))
await wait(6000)
console.log('  back in session, last ask:', await ev(`[...document.querySelectorAll('.loom-ask-text, .loom-ask')].map((e) => e.textContent.trim()).pop()?.slice(0, 120)`))
await shot('handed-back')
ws.close()
child.kill()
