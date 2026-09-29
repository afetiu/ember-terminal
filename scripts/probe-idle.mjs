/**
 * Where the idle frames go.
 *
 * Ember's idle cost was measured, reduced, and then stopped being explainable: with the
 * caret paused and the shell quiet it still held about half a core, and the two obvious
 * suspects — the layered window and PowerShell's redraws — both measured innocent. So
 * this stops sampling processes from outside and asks the renderer directly.
 *
 * It drives the DevTools protocol against a running Ember: CPU profile for the JS, and a
 * frame/paint count for the work that never shows up in a JS profile because it is the
 * compositor's. The second number is the point. A renderer burning a core with an empty
 * JS profile is being driven by style, layout, paint or an animation the compositor is
 * running on its own, and the fix for that is never in a hot function.
 *
 *   node scripts/probe-idle.mjs [seconds]
 *
 * Launch Ember with --remote-debugging-port=9222 first. Nothing here writes to the app,
 * so it is safe to point at a session you are using, though an idle one is the point.
 */
const PORT = Number(process.env['EMBER_CDP_PORT'] ?? 9222)
const SECONDS = Number(process.argv[2] ?? 6)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

/** One request/response pair over the target's WebSocket, by id. */
function rpc(ws) {
  let seq = 0
  const waiting = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      waiting.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

/**
 * Roll a CPU profile up by self time.
 *
 * The profile is a call tree plus a list of sampled node ids; self time is what the
 * sampler actually caught executing, which is the only column worth reading when the
 * question is "what is running when nothing should be".
 */
function selfTime(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const hits = new Map()
  const total = profile.samples.length || 1
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1)

  const rows = []
  for (const [id, count] of hits) {
    const node = byId.get(id)
    if (!node) continue
    const f = node.callFrame
    const where = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : ''
    rows.push({
      name: `${f.functionName || '(anonymous)'} ${where}`.trim(),
      pct: (count / total) * 100,
    })
  }
  return rows.sort((a, b) => b.pct - a.pct)
}

const list = await targets()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('No renderer target. Launch Ember with --remote-debugging-port=%d', PORT)
  console.error('Saw: %s', list.map((t) => `${t.type} ${t.url}`).join(', ') || '(nothing)')
  process.exit(1)
}
console.log(`target: ${page.url}\nsampling ${SECONDS}s...\n`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = rpc(ws)

// Frame timings come from the tracing-free path: a rendering stat the compositor keeps.
await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 200 })
await send('Performance.enable')

const before = await send('Performance.getMetrics')
await send('Profiler.start')
await sleep(SECONDS * 1000)
const { profile } = await send('Profiler.stop')
const after = await send('Performance.getMetrics')

const metric = (set, name) => set.metrics.find((m) => m.name === name)?.value ?? 0
const delta = (name) => metric(after, name) - metric(before, name)

const idle = profile.samples.length
  ? (profile.samples.filter((id) => {
      const n = profile.nodes.find((x) => x.id === id)
      return n && (n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)')
    }).length /
      profile.samples.length) *
    100
  : 0

console.log('--- renderer JS (self time, %% of samples) ---')
const rows = selfTime(profile).filter((r) => !r.name.startsWith('(idle)'))
for (const r of rows.slice(0, 12)) console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.name}`)
if (rows.length === 0) console.log('  (nothing — the JS thread is asleep)')

console.log('\n--- where the wall clock went over %ds ---', SECONDS)
console.log(`  idle/program samples : ${idle.toFixed(1)}%`)
for (const name of ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration']) {
  console.log(`  ${name.padEnd(21)}: ${delta(name).toFixed(3)}s`)
}
console.log(`  Frames               : ${delta('Frames')}  (${(delta('Frames') / SECONDS).toFixed(1)}/s)`)
console.log(`  LayoutCount          : ${delta('LayoutCount')}`)
console.log(`  RecalcStyleCount     : ${delta('RecalcStyleCount')}`)

// A busy renderer with a quiet JS profile means the frames are not ours to fix in JS.
const script = delta('ScriptDuration')
const task = delta('TaskDuration')
console.log('\n--- reading ---')
if (task > 0.05 && script / Math.max(task, 1e-9) < 0.35) {
  console.log('  Most of the renderer task time is NOT script. Look at style, layout, paint')
  console.log('  or a compositor-driven animation, not at a hot function.')
} else if (script > 0.05) {
  console.log('  Script dominates. The table above is the answer.')
} else {
  console.log('  Renderer is close to asleep; the cost is elsewhere (GPU process or main).')
}

ws.close()
