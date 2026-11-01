/**
 * A Codex tab end to end: Ember opens it as the tab's agent, a message is typed and sent,
 * and the reply must reach the canvas (the Codex log adapter), not just Codex's own screen.
 *
 *   node scripts/probe-codex-enter.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-codex-enter')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'codex', onboarded: true }, brain: { sync: false } }))
const PORT = 9384
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
  pending.get(m.id)?.(m.result)
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

for (let i = 0; i < 40; i++) {
  const d = await snap()
  if (d && d.rows.some((r) => r.startsWith('›'))) break
  await wait(1000)
}
await wait(3000)
const sid = (await snap()).sessionId
await write(sid, 'Reply with the single word pong.')
await wait(1500)
await write(sid, String.fromCharCode(13))
await wait(12000)
const d = await snap()
console.log(`  says on canvas: ${d.says}, turns: ${d.turns}`)
console.log(`  canvas text: ${await ev(`[...document.querySelectorAll('.loom-say, .loom-ask-text, .loom-ask')].map((e) => e.textContent.trim()).join(' | ').slice(0, 200)`)}`)
console.log(`  codex screen: ${d.rows.filter((r) => r.trim()).slice(-5).map((r) => r.trim()).join(' / ').slice(0, 200)}`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(process.argv[2] ?? 'codex-enter.png', Buffer.from(shot.data, 'base64'))
ws.close()
child.kill()
