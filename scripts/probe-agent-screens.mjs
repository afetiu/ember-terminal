/**
 * An agent's real screen, row by row, in the states its input dock has to handle: idle,
 * with the slash menu open, and mid-answer. What a screen profile is built from.
 *
 *   node scripts/probe-agent-screens.mjs <agent> [out.json]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const agent = process.argv[2] ?? 'codex'
const out = process.argv[3] ?? `screens-${agent}.json`
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-screens-${agent}`)
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: agent, onboarded: true }, brain: { sync: false } }))
const PORT = 9383
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
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
const snap = () => ev(`window.__ember.loom()`)
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out.replace(/\.json$/, `-${name}.png`), Buffer.from(r.data, 'base64'))
}
const states = {}
// Ember opens on the agent; wait for it to be up.
for (let i = 0; i < 40; i++) {
  const d = await snap()
  if (d && d.mode === 'agent' && d.rows.some((r) => r.trim())) break
  await wait(1000)
}
await wait(4000)
states.idle = (await snap()).rows
await shot('idle')
const sid = (await snap()).sessionId
await ev(`window.ember.write(${JSON.stringify(sid)}, '/')`)
await wait(1500)
states.slash = (await snap()).rows
await shot('slash')
await ev(`window.ember.write(${JSON.stringify(sid)}, '\x1b')`)
await wait(800)
await ev(`window.ember.write(${JSON.stringify(sid)}, '\x15')`)
await wait(500)
await ev(`window.ember.write(${JSON.stringify(sid)}, 'Count from 1 to 40, one number per line, slowly.')`)
await wait(300)
await ev(`window.ember.write(${JSON.stringify(sid)}, '\r')`)
await wait(3500)
states.working = (await snap()).rows
await wait(12000)
states.after = (await snap()).rows
await shot('after')
writeFileSync(out, JSON.stringify(states, null, 1))
console.log(`  saved ${out}`)
ws.close()
child.kill()
