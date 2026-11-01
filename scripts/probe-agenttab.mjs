/**
 * An agent tab from +: the starting cover, then the agent's own screen. Screenshots of both.
 *
 *   node scripts/probe-firstrun.mjs [out-prefix]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-agenttab')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true } }))
const PORT = 9382
const out = process.argv[2] ?? 'firstrun'
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let target
for (let i = 0; i < 60 && !target; i++) {
  await wait(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  } catch {}
}
if (!target) throw new Error('no page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  pending.get(m.id)?.(m.result)
  pending.delete(m.id)
})
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
const evalv = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}-${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  saved ${out}-${name}.png`)
}
await wait(3000)
await evalv(`document.querySelector('.ember-newtab').click()`)
await wait(900)
await shot('starting')
for (let i = 0; i < 25; i++) {
  if (await evalv(`!document.querySelector('.loom-starting')`)) break
  await wait(1000)
}
await wait(2500)
await shot('agent')
console.log('  cover gone:', await evalv(`!document.querySelector('.loom-starting')`))
ws.close()
child.kill()
