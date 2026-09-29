#!/usr/bin/env node
/**
 * Frame jank in Ember at a given window size: two tabs, switched back and forth while
 * the first streams a spinner, with the renderer's own frame intervals recorded and a
 * DevTools trace of what each frame did. Also the per-process memory of the app.
 *
 *   node scripts/probe-jank.mjs [--bounds=3840x2160] [--material=none|acrylic|mica] [--opacity=N]
 *                               [--inject="<css>"] [--idle] [--paints]
 */
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const flags = new Map(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true] }))
const bounds = flags.get('bounds') ?? '3840x2160'
const PORT = 9334
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-jank')
mkdirSync(EMBER_HOME, { recursive: true })
const userCfg = join(process.env.USERPROFILE ?? '', '.ember', 'config.json')
if (existsSync(userCfg)) {
  const cfg = JSON.parse(readFileSync(userCfg, 'utf8'))
  if (flags.has('material')) cfg.window.material = flags.get('material')
  if (flags.has('opacity')) cfg.window.opacity = Number(flags.get('opacity'))
  writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))
  console.log(`config: material=${cfg.window.material ?? 'none'} opacity=${cfg.window.opacity ?? '?'} bounds=${bounds}`)
}
const spinner = process.env.SPINNER ?? join(process.env.TEMP ?? '.', 'claude', HOME.replace(/[:\/]/g, '-'), '347628de-4674-4589-a7ed-d3d11d55d602', 'scratchpad', 'spinner.ps1')
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
  const handlers = new Map()
  const ready = new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } }
    else if (handlers.has(m.method)) handlers.get(m.method)(m.params)
  })
  const send = (method, params = {}) => new Promise((res) => { pending.set(++seq, res); ws.send(JSON.stringify({ id: seq, method, params })) })
  const on = (method, cb) => handlers.set(method, cb)
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result?.result?.value
  }
  return { ws, ready, send, ev, on }
}
const appTarget = await findPage((t) => !t.url.includes('desk-overlay') && !t.url.includes('realtime'))
if (!appTarget) { child.kill(); throw new Error('no app window') }
const app = cdp(appTarget)
await app.ready
let sid = null
for (let i = 0; i < 300 && !sid; i++) {
  const s = (await app.ev('window.__ember ? window.__ember.sessions() : []'))[0]
  if (s && s.bytesIn > 0) sid = s.id
  await sleep(100)
}
if (!sid) { child.kill(); throw new Error('no session') }
await sleep(2500)
if (flags.has('inject')) {
  await app.ev(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(flags.get('inject'))} })); true`)
  console.log(`injected css: ${flags.get('inject')}`)
}
if (!flags.has('idle')) await app.ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(`& '${spinner}' -Seconds 60\r`)})`)
const tab1 = await app.ev('window.__ember.activeTab()')
const tab2 = await app.ev('window.__ember.newTab()')
await sleep(3000)
await app.ev(`window.__ember.activate(${JSON.stringify(tab1)})`)
await sleep(1500)

// Frame intervals from inside the renderer, for the whole switching run.
await app.ev(`window.__probeFrames = { n: 0, over20: 0, over33: 0, max: 0, sum: 0, stop: false, hist: [] };
(() => { const F = window.__probeFrames; let last = performance.now(); const tick = (now) => { if (F.stop) return; const d = now - last; last = now; F.n++; F.sum += d; if (d > 20) F.over20++; if (d > 33) F.over33++; if (d > F.max) F.max = d; if (d > 20) F.hist.push(Math.round(d)); requestAnimationFrame(tick) }; requestAnimationFrame(tick) })(); true`)

const events = []
app.on('Tracing.dataCollected', ({ value }) => events.push(...value))
let done
const complete = new Promise((r) => (done = r))
app.on('Tracing.tracingComplete', () => done())
const cats = 'disabled-by-default-devtools.timeline,devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline.stack'
const st = await app.send('Tracing.start', { categories: cats, transferMode: 'ReportEvents', options: 'sampling-frequency=1000' })
if (st.error) console.log('tracing start failed:', st.error.message)
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
const snap = () => JSON.parse(ps(`Get-CimInstance Win32_Process | ? { $_.Name -eq 'electron.exe' } | % { $g = Get-Process -Id $_.ProcessId -EA SilentlyContinue; if ($g) { $t = if ($_.CommandLine -match '--type=(\\w+)') { $Matches[1] } else { 'main' }; $u = if ($_.CommandLine -match 'utility-sub-type=(\\S+)') { $Matches[1].Split('.')[0] } else { '' }; [pscustomobject]@{ pid=$_.ProcessId; type="$t $u".Trim(); cpu=$g.CPU; mb=[math]::Round($g.WorkingSet64/1MB) } } } | ConvertTo-Json -Compress`))
const a = snap(); const s0 = Date.now()
const p0 = Date.now()
for (let i = 0; i < 8; i++) {
  await app.ev(`window.__ember.activate(${JSON.stringify(tab2)})`)
  await sleep(450)
  await app.ev(`window.__ember.activate(${JSON.stringify(tab1)})`)
  await sleep(450)
}
await app.send('Tracing.end')
await Promise.race([complete, sleep(10000)])
const secs = (Date.now() - p0) / 1000
const b = snap(); const dt = (Date.now() - s0) / 1000
const F = await app.ev('(() => { const F = window.__probeFrames; F.stop = true; return { n: F.n, over20: F.over20, over33: F.over33, max: Math.round(F.max), avg: F.sum / Math.max(1, F.n), hist: F.hist.slice(0, 40) } })()')
console.log(`switching ${secs.toFixed(1)} s: ${F.n} frames, avg ${F.avg.toFixed(1)} ms, >20 ms ${F.over20}, >33 ms ${F.over33}, worst ${F.max} ms   slow frames: ${F.hist.join(' ')}`)

const rows = (Array.isArray(b) ? b : [b]).map((p) => { const prev = (Array.isArray(a) ? a : [a]).find((x) => x.pid === p.pid); return { ...p, pct: prev ? ((p.cpu - prev.cpu) / dt) * 100 : 0 } }).sort((x, y) => y.pct - x.pct)
console.log(`CPU ${rows.reduce((n, r) => n + r.pct, 0).toFixed(1)}% of one core, RAM ${rows.reduce((n, r) => n + r.mb, 0)} MB:`)
for (const r of rows) console.log(`   ${r.pct.toFixed(1).padStart(6)}%  ${String(r.mb).padStart(4)} MB  ${r.type}`)

const byName = new Map()
for (const e of events) {
  if (!e.name || !e.dur) continue
  const c = byName.get(e.name) ?? { n: 0, dur: 0, max: 0 }
  c.n++; c.dur += e.dur; c.max = Math.max(c.max, e.dur)
  byName.set(e.name, c)
}
console.log(`trace: ${events.length} events over ${secs.toFixed(1)} s (renderer main thread, ms/s and worst single):`)
for (const name of ['Paint', 'RasterTask', 'UpdateLayerTree', 'CompositeLayers', 'Layout', 'UpdateLayoutTree', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'Animation', 'GPUTask', 'DrawFrame']) {
  const c = byName.get(name)
  if (c) console.log(`   ${name.padEnd(18)} ${(c.n / secs).toFixed(0).padStart(5)}/s   ${(c.dur / 1000 / secs).toFixed(1).padStart(6)} ms/s   worst ${(c.max / 1000).toFixed(1)} ms`)
}
// The JS callers behind the long tasks.
const agg = new Map()
for (const e of events) {
  if (!e.dur || e.dur < 4000) continue
  if (!['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch'].includes(e.name)) continue
  const d = e.args?.data ?? {}
  const key = `${e.name} ${d.functionName ?? d.type ?? ''} ${d.url ? String(d.url).split('/').pop() + ':' + d.lineNumber : ''}`.trim()
  const c = agg.get(key) ?? { n: 0, dur: 0 }
  c.n++; c.dur += e.dur
  agg.set(key, c)
}
const top = [...agg].sort((x, y) => y[1].dur - x[1].dur).slice(0, 8)
if (top.length) { console.log('long JS tasks (>4 ms):'); for (const [k, c] of top) console.log(`   ${(c.dur / 1000).toFixed(1).padStart(7)} ms total  ${String(c.n).padStart(3)}×  ${k}`) }
child.kill()
process.exit(0)
