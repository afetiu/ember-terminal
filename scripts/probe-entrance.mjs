/**
 * What a new tab costs, by function.
 *
 * The entrance of a new tab stayed janky after the panel's webview and the WebGL terminal
 * were both taken off its first frame, so this stops guessing: it profiles the renderer's
 * CPU across exactly one `newTab()` and prints where the sampled time went, plus the long
 * tasks the browser itself reported.
 *
 *   node scripts/probe-entrance.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9411
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: '1700x1000' },
})

async function findPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('realtime'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error('no devtools target')
}
const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
  }
})
const send = (method, params = {}) => new Promise((res) => { pending.set(++seq, res); ws.send(JSON.stringify({ id: seq, method, params })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result?.result?.value
}
await send('Runtime.enable')
for (let i = 0; i < 100; i++) {
  if (await ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}
// Let the shell come up and the spare be built. The spare is built only after three quiet
// seconds, and the shell's own startup output counts against that, so wait for it the
// way a person would — by not doing anything for a while.
for (let i = 0; i < 100; i++) {
  if (await ev(`window.__ember.spareReady ? window.__ember.spareReady() : true`)) break
  await sleep(300)
}
if (process.argv.includes('--no-park')) await ev(`window.__ember.setParking(false)`)
if (process.argv.includes('--no-sound')) await ev(`window.__ember.config().sound.enabled = false`)
console.log(`spare ready before newTab: ${await ev(`window.__ember.spareReady ? window.__ember.spareReady() : 'n/a'`)}${process.argv.includes('--no-park') ? ' · parking off' : ''}`)

await ev(`(() => {
  window.__long = []
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ at: e.startTime, dur: e.duration }) }).observe({ entryTypes: ['longtask'] })
  window.__t0 = performance.now()
})()`)
// Chromium's own timeline for the same window: the browser names what it did — layout,
// paint, layer tree updates, resize observers, GC — with durations, which is the only
// way to see a cost that is not in any JS function.
const traceEvents = []
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.method === 'Tracing.dataCollected') traceEvents.push(...msg.params.value)
})
await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute', options: 'sampling-frequency=10000' })
await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 250 })
await send('Profiler.start')
const t0 = Date.now()
await ev(`window.__ember.newTab()`)
const tOpen = Date.now() - t0
await sleep(1500)
const { result } = await send('Profiler.stop')
await send('Tracing.end')
await new Promise((resolve) => {
  const onMsg = (m) => {
    if (JSON.parse(m.data).method === 'Tracing.tracingComplete') {
      ws.removeEventListener('message', onMsg)
      resolve()
    }
  }
  ws.addEventListener('message', onMsg)
})
{
  // The longest task on the renderer's main thread, and what was inside it.
  const xs = traceEvents.filter((e) => e.ph === 'X' && typeof e.dur === 'number')
  const tasks = xs.filter((e) => e.name === 'RunTask').sort((a, b) => b.dur - a.dur)
  const top = tasks[0]
  if (top) {
    console.log(`
-- longest main-thread task: ${(top.dur / 1000).toFixed(1)}ms — its contents (≥1ms) --`)
    const inside = xs
      .filter((e) => e !== top && e.pid === top.pid && e.tid === top.tid && e.ts >= top.ts && e.ts + e.dur <= top.ts + top.dur && e.dur >= 1000 && e.name !== 'RunTask')
      .sort((a, b) => b.dur - a.dur)
    for (const e of inside.slice(0, 24)) {
      const d = e.args?.data ?? e.args?.beginData ?? {}
      const detail = d.functionName
        ? `${d.functionName} ${String(d.url ?? '').split('/').pop()}:${d.lineNumber ?? ''}`
        : d.type ?? (d.dirtyObjects !== undefined ? `dirty ${d.dirtyObjects}/${d.totalObjects}` : (d.styleSheetURL ?? d.frame ?? ''))
      console.log(`  ${(e.dur / 1000).toFixed(1).padStart(6)}ms  +${((e.ts - top.ts) / 1000).toFixed(0).padStart(4)}ms  ${e.name.padEnd(30)} ${String(detail).slice(0, 80)}`)
    }
    // Also the instant/begin events with no duration but a story: what kicked the task off.
    const kick = traceEvents.filter((e) => e.pid === top.pid && e.tid === top.tid && e.ts >= top.ts - 200 && e.ts <= top.ts + 2000 && e.ph !== 'X').slice(0, 8)
    console.log(`  begins with: ${kick.map((e) => e.name).join(', ')}`)
  }
}
const long = await ev(`window.__long`)
console.log(`newTab() resolved after ${tOpen}ms`)
console.log(`steps (ms): ${JSON.stringify(await ev(`window.__ember.lastEntrance ? window.__ember.lastEntrance() : {}`))}`)
console.log(`long tasks during the entrance: ${long.map((l) => `${l.dur.toFixed(0)}ms @${(l.at - 0).toFixed(0)}`).join(', ') || 'none'}`)

const profile = result?.profile
if (profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const hits = new Map()
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1)
  const total = profile.samples.length || 1
  const name = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url ? f.url.split('/').pop() + ':' + (f.lineNumber + 1) : ''}` }
  const rows = [...hits].map(([id, c]) => ({ n: byId.get(id), pct: (c / total) * 100 })).sort((a, b) => b.pct - a.pct)
  console.log(`\n-- renderer self time during newTab (${total} samples at 0.25ms) --`)
  for (const r of rows.slice(0, 14)) console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${name(r.n)}`)
  // Inclusive time by our own functions: walk each sample up to the first frame in index-*.js.
  const incl = new Map()
  for (const id of profile.samples) {
    let cur = id
    const seen = new Set()
    while (cur !== undefined) {
      const n = byId.get(cur)
      if (!n) break
      const f = n.callFrame
      if (f.url && /index-.*\.js$/.test(f.url) && f.functionName) {
        const k = name(n)
        if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + 1) }
      }
      cur = parent.get(cur)
    }
  }
  const inc = [...incl].map(([k, c]) => ({ k, pct: (c / total) * 100 })).sort((a, b) => b.pct - a.pct)
  console.log(`\n-- inclusive, app functions --`)
  for (const r of inc.slice(0, 16)) console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.k}`)
}

try {
  for (const s of await ev(`window.__ember.sessions()`)) await ev(`window.ember.write(${JSON.stringify(s.id)}, "\\u0003exit\\r")`)
  await sleep(400)
} catch {
  /* gone */
}
child.kill()
ws.close()
