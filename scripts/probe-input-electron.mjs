#!/usr/bin/env node
/**
 * End-to-end input latency in Ember itself (dev Electron, isolated EMBER_HOME, window
 * shown inactive behind whatever the person is doing): start `claude` in the first tab,
 * ask it to stream 200 lines, and while it streams type a letter at a time through the
 * real xterm and measure how long until the screen shows it. Compare with
 * scripts/probe-input.cjs (node-pty alone) to see what the app adds.
 *
 *   node scripts/probe-input-electron.mjs [WxH]     (default 1920x1200; try 3840x2160)
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const bounds = args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1200'
const noStatus = args.includes('--no-statusline')
const raw = args.includes('--raw')
const tag = `electron ${bounds}${raw ? ' raw claude' : noStatus ? ' no statusline' : ''}`
const PORT = 9333
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-input')
mkdirSync(EMBER_HOME, { recursive: true })
const userCfg = join(process.env.USERPROFILE ?? '', '.ember', 'config.json')
if (existsSync(userCfg)) copyFileSync(userCfg, join(EMBER_HOME, 'config.json'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const t0 = Date.now()
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: bounds },
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
}
async function findPage(pred) {
  for (let i = 0; i < 300; i++) {
    try { const p = (await targets()).find(pred); if (p) return p } catch {}
    await sleep(100)
  }
  return null
}
function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const ready = new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } } })
  const send = (method, params = {}) => new Promise((res) => { pending.set(++seq, res); ws.send(JSON.stringify({ id: seq, method, params })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result?.result?.value
  }
  return { ws, ready, ev }
}

const appTarget = await findPage((t) => !t.url.includes('desk-overlay') && !t.url.includes('realtime'))
if (!appTarget) { child.kill(); throw new Error('no app window') }
const app = cdp(appTarget)
await app.ready

// The first session, once its shell has spoken.
let sid = null
for (let i = 0; i < 300 && !sid; i++) {
  const s = (await app.ev('window.__ember ? window.__ember.sessions() : []'))[0]
  if (s && s.bytesIn > 0) sid = s.id
  await sleep(100)
}
if (!sid) { child.kill(); throw new Error('no session') }
console.log(`[${tag}] window+shell ${Date.now() - t0} ms`)
const screen = () => app.ev(`(() => { const t = window.__ember.term(${JSON.stringify(sid)}); const b = t.buffer.active; const out = []; for (let i = 0; i < t.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? ''); return out })()`)
const type = (s) => app.ev(`window.__ember.term(${JSON.stringify(sid)}).input(${JSON.stringify(s)}, true); true`)
async function until(pred, maxMs) {
  const s = Date.now()
  while (Date.now() - s < maxMs) {
    if (pred(await screen())) return true
    await sleep(5)
  }
  return false
}
await sleep(2500)
await type('claude\r')
const up = await until((sc) => sc.some((l) => /auto mode|for shortcuts|Try "/.test(l)), 40000)
console.log(`[${tag}] claude up: ${up} (${Date.now() - t0} ms)`)
if (!up) { console.log((await screen()).filter((l) => l.trim()).slice(-8).join('\n')); child.kill(); process.exit(1) }
await sleep(2000)
await type('Print 200 lines, each exactly "row N lorem ipsum dolor sit amet consectetur" with N from 1 to 200. No tool use, no commentary, just the lines.')
await sleep(800)
await type('\r')
const streaming = await until((sc) => sc.some((l) => l.includes('lorem ipsum')), 45000)
console.log(`[${tag}] streaming: ${streaming}`)
// While the letters go in, watch both event loops: a main-process invoke round trip
// (desk.state is a cheap IPC) and the renderer's own timer drift.
await app.ev(`window.__probeLag = { mainMax: 0, mainOver100: 0, rendMax: 0, rendOver100: 0, samples: 0, stop: false };
(async () => { const L = window.__probeLag; while (!L.stop) { const t = performance.now(); try { await window.ember.desk.state() } catch {} const rt = performance.now() - t; L.samples++; if (rt > L.mainMax) L.mainMax = rt; if (rt > 100) L.mainOver100++; await new Promise((r) => setTimeout(r, 50)) } })();
(() => { const L = window.__probeLag; let last = performance.now(); const tick = () => { if (L.stop) return; const now = performance.now(); const drift = now - last - 20; if (drift > L.rendMax) L.rendMax = drift; if (drift > 100) L.rendOver100++; last = now; setTimeout(tick, 20) }; setTimeout(tick, 20) })(); true`)
const lat = []
let typed = ''
for (let k = 0; k < 20; k++) {
  typed += 'z'
  const want = typed
  const s = Date.now()
  await type('z')
  const seen = await until((sc) => sc.some((l) => l.includes(want)), 5000)
  lat.push(seen ? String(Date.now() - s) : 'MISS')
  await sleep(450)
}
const lag = await app.ev('(() => { const L = window.__probeLag; L.stop = true; return { mainMax: Math.round(L.mainMax), mainOver100: L.mainOver100, rendMax: Math.round(L.rendMax), rendOver100: L.rendOver100, samples: L.samples } })()')
console.log(`[${tag}] main-process invoke round trip: max ${lag.mainMax} ms, >100 ms ${lag.mainOver100}× of ${lag.samples}; renderer timer drift: max ${lag.rendMax} ms, >100 ms ${lag.rendOver100}×`)
console.log(`[${tag}] latencies ms: ${lat.join(' ')}`)
const nums = lat.filter((x) => x !== 'MISS').map(Number).sort((a, b) => a - b)
const sc = await screen()
if (nums.length) console.log(`[${tag}] median ${nums[Math.floor(nums.length / 2)]} ms, max ${nums[nums.length - 1]} ms, misses ${lat.length - nums.length}, still streaming: ${sc.some((l) => l.includes('lorem ipsum'))}`)
console.log(`[${tag}] box: ${sc.filter((l) => l.includes('z')).slice(-1)[0]?.trim().slice(0, 80) ?? '(none)'}`)
child.kill()
process.exit(0)
