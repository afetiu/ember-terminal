/**
 * What Ember costs while it just sits there: CPU and RAM of every Ember process while a
 * tab shows a Claude Code-like spinner (a status line repainting at ~30 fps), and the
 * time from launch to a usable prompt. The same spinner is run in other terminals by
 * scratch/Measure-Term.ps1 so the numbers are comparable.
 *
 *   node scripts/probe-cpu.mjs [--material=none|acrylic|mica] [--opacity=N] [--no-webgl] [--idle]
 *
 * Launches its own Ember with an isolated EMBER_HOME (never the installed one's ~/.ember).
 * --idle measures a quiet prompt instead of the spinner.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9388
const flags = new Map(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1'] }))
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
{
  const userCfg = join(homedir(), '.ember', 'config.json')
  const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
  cfg.window ??= {}
  if (flags.has('material')) cfg.window.material = flags.get('material')
  if (flags.has('opacity')) cfg.window.opacity = Number(flags.get('opacity'))
  writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))
  console.log(`config: material=${cfg.window.material ?? 'none'} opacity=${cfg.window.opacity ?? '?'}${flags.has('no-webgl') ? ' (DOM renderer)' : ''}`)
}
const spinner = process.env.SPINNER ?? join(process.env.TEMP ?? '.', 'claude', HOME.replace(/[:\/]/g, '-'), '347628de-4674-4589-a7ed-d3d11d55d602', 'scratchpad', 'spinner.ps1')

const t0 = Date.now()
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`, ...(flags.has('no-webgl') ? ['--ember-no-webgl'] : [])], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, ...(flags.has('active') ? {} : { EMBER_PROBE_INACTIVE: '1' }), EMBER_PROBE_BOUNDS: '1400x900' },
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
}
async function findPage(pred) {
  for (let i = 0; i < 150; i++) {
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
if (!appTarget) throw new Error('no app window')
const tWindow = Date.now() - t0
const app = cdp(appTarget)
await app.ready
{
  // Is the window actually GPU-composited? A software-rasterised 4K transparent window
  // would look exactly like a GPU process burning a core.
  try {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    const b = cdp({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl })
    await b.ready
    const info = (await b.send('SystemInfo.getInfo')).result
    const fs = info.gpu.featureStatus ?? {}
    const dev = info.gpu.devices?.map((d) => d.deviceString || d.driverVendor).filter(Boolean).join(' | ')
    console.log(`gpu: ${dev}; compositing=${fs.gpu_compositing} rasterization=${fs.rasterization} webgl=${fs.webgl} canvas=${fs['2d_canvas']} video=${fs.video_decode}`)
    if (info.gpu.auxAttributes) console.log(`gpu aux: software_rendering=${info.gpu.auxAttributes.software_rendering} gl_renderer=${info.gpu.auxAttributes.gl_renderer ?? ''}`)
    b.ws.close()
  } catch (e) {
    console.log(`gpu info unavailable: ${e.message}`)
  }
}
await app.send('Runtime.enable')
// The renderer's own startup timings (`lap(...)` in newGroup) and anything else it logs
// before the prompt, so a slow spawn can be placed inside the app rather than guessed at.
const consoleLines = []
app.on('Runtime.consoleAPICalled', ({ args, type }) => {
  const text = args.map((a) => a.value ?? a.description ?? '').join(' ')
  consoleLines.push(`${(Date.now() - t0).toString().padStart(6)} ms  [${type}] ${text.slice(0, 160)}`)
})
for (let i = 0; i < 100; i++) { if (await app.ev(`typeof window.__ember !== 'undefined'`)) break; await sleep(50) }
const tEmberReady = Date.now() - t0
let tSessionListed = 0
for (let i = 0; i < 200 && !tSessionListed; i++) {
  if ((await app.ev(`window.__ember.sessions().length`)) > 0) tSessionListed = Date.now() - t0
  else await sleep(50)
}
console.log(`renderer ready ${tEmberReady} ms, session requested ${tSessionListed} ms`)

let tFirstByte = 0, tPromptSeen = 0
async function waitForPrompt() {
  let last = -1, quietSince = 0
  for (let i = 0; i < 600; i++) {
    const s = (await app.ev(`window.__ember.sessions()`))[0]
    if (s && s.bytesIn > 0) {
      if (!tFirstByte) tFirstByte = Date.now() - t0
      const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
      const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
      if (prompt && !tPromptSeen) tPromptSeen = Date.now() - t0
      if (s.bytesIn === last) { if (!quietSince) quietSince = Date.now(); if (Date.now() - quietSince > (prompt ? 600 : 9000)) return s }
      else { quietSince = 0; last = s.bytesIn }
    }
    await sleep(50)
  }
  throw new Error('shell never settled')
}
const sess = await waitForPrompt()
const tPrompt = Date.now() - t0
console.log(`window ${tWindow} ms, first shell byte ${tFirstByte} ms, prompt visible ${tPromptSeen || 'not matched'} ms, settled (probe heuristic) ${tPrompt} ms`)
if (flags.has('console')) for (const l of consoleLines.slice(0, 40)) console.log(`   ${l}`)

if (flags.has('inject')) {
  // A/B without a rebuild: --inject="<css>" is appended to the page as a <style> before
  // the workload starts, so a suspected layer or effect can be switched off in place.
  await app.ev(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(flags.get('inject'))} })); true`)
  console.log(`injected css: ${flags.get('inject')}`)
}
if (flags.has('silent')) {
  // A command that runs but prints nothing: separates "output frames" from "something
  // animates because a command is running".
  await app.ev(`window.ember.write(${JSON.stringify(sess.id)}, ${JSON.stringify(`Start-Sleep 40\r`)})`)
} else if (!flags.has('idle')) {
  await app.ev(`window.ember.write(${JSON.stringify(sess.id)}, ${JSON.stringify(`& '${spinner}' -Seconds 40\r`)})`)
}
await sleep(4000)

if (flags.has('shot')) {
  // What the window looks like mid-workload, for a human to check nothing regressed.
  const shot = (await app.send('Page.captureScreenshot', { format: 'png' })).result?.data
  if (shot) {
    const file = join(EMBER_HOME, 'probe-cpu.png')
    writeFileSync(file, Buffer.from(shot, 'base64'))
    console.log(`screenshot: ${file}`)
  }
}

// Sample every electron.exe (the installed app is Ember.exe, so this is only the probe's).
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
const snap = () => JSON.parse(ps(`Get-CimInstance Win32_Process | ? { $_.Name -eq 'electron.exe' } | % { $g = Get-Process -Id $_.ProcessId -EA SilentlyContinue; if ($g) { $t = if ($_.CommandLine -match '--type=(\\w+)') { $Matches[1] } else { 'main' }; $u = if ($_.CommandLine -match 'utility-sub-type=(\\S+)') { $Matches[1].Split('.')[0] } else { '' }; [pscustomobject]@{ pid=$_.ProcessId; type="$t $u".Trim(); cpu=$g.CPU; mb=[math]::Round($g.WorkingSet64/1MB) } } } | ConvertTo-Json -Compress`))
const bytes0 = (await app.ev(`window.__ember.sessions()`)).find((s) => s.id === sess.id)?.bytesIn ?? 0
const a = snap(); const s0 = Date.now()
await sleep(10000)
const b = snap(); const dt = (Date.now() - s0) / 1000
const bytes1 = (await app.ev(`window.__ember.sessions()`)).find((s) => s.id === sess.id)?.bytesIn ?? 0
const bps = (bytes1 - bytes0) / dt
if (!flags.has('idle') && !flags.has('silent') && bps < 500) console.log(`WORKLOAD MISSING: only ${bps.toFixed(0)} B/s of output during the sample — this run is invalid`)
else console.log(`workload: ${bps.toFixed(0)} B/s of output during the sample`)
const rows = (Array.isArray(b) ? b : [b]).map((p) => { const prev = (Array.isArray(a) ? a : [a]).find((x) => x.pid === p.pid); return { ...p, pct: prev ? ((p.cpu - prev.cpu) / dt) * 100 : 0 } }).sort((x, y) => y.pct - x.pct)
const total = rows.reduce((n, r) => n + r.pct, 0)
const ram = rows.reduce((n, r) => n + r.mb, 0)
console.log(`${flags.has('idle') ? 'idle prompt' : 'spinner'}: CPU ${total.toFixed(1)}% of one core, RAM ${ram} MB, ${rows.length} processes`)
for (const r of rows) console.log(`   ${r.pct.toFixed(1).padStart(6)}%  ${String(r.mb).padStart(4)} MB  ${r.type}`)
if (flags.has('paints')) {
  // Which compositor layers get repainted while the workload runs, and how big the
  // repainted areas are. This is the question the CPU numbers cannot answer: a 38px
  // canvas that invalidates a 2000px layer costs the 2000px.
  let layers = new Map()
  const paints = new Map()
  app.on('LayerTree.layerTreeDidChange', ({ layers: ls }) => { if (ls) layers = new Map(ls.map((l) => [l.layerId, l])) })
  app.on('LayerTree.layerPainted', ({ layerId, clip }) => {
    const p = paints.get(layerId) ?? { n: 0, area: 0, w: 0, h: 0 }
    p.n++; p.area += clip.width * clip.height; p.w = Math.max(p.w, clip.width); p.h = Math.max(p.h, clip.height)
    paints.set(layerId, p)
  })
  await app.send('DOM.enable')
  await app.send('LayerTree.enable')
  const p0 = Date.now()
  await sleep(4000)
  await app.send('LayerTree.disable')
  const secs = (Date.now() - p0) / 1000
  const rows = []
  for (const [id, p] of paints) {
    const l = layers.get(id)
    let what = l ? `${l.width}x${l.height}` : '?'
    if (l?.backendNodeId) {
      try {
        const n = (await app.send('DOM.describeNode', { backendNodeId: l.backendNodeId })).result.node
        const cls = n.attributes ? n.attributes[n.attributes.indexOf('class') + 1] : ''
        what += ` <${n.nodeName.toLowerCase()}${cls ? ` .${String(cls).split(' ').slice(0, 2).join('.')}` : ''}>`
      } catch { /* node gone */ }
    }
    rows.push({ id, n: p.n, rate: p.n / secs, area: p.area / secs, w: p.w, h: p.h, what })
  }
  rows.sort((a, b) => b.area - a.area)
  console.log(`paints over ${secs.toFixed(1)} s (layer: paints/s, repainted Mpx/s, largest clip):`)
  for (const r of rows.slice(0, 14)) console.log(`   ${r.rate.toFixed(1).padStart(6)}/s  ${(r.area / 1e6).toFixed(1).padStart(7)} Mpx/s  ${`${r.w}x${r.h}`.padStart(10)}  layer ${r.what}`)
}
if (flags.has('styles')) {
  // Who writes styles per frame: every CSS property set through element.style, the
  // class list, or attributes, counted by the calling function for 3 s.
  await app.ev(`(() => {
    const counts = new Map()
    const bump = (what) => {
      const st = (new Error().stack || '').split('\\n').slice(2, 4).map((l) => l.trim().replace(/^at /, '').replace(/\\(.*\\/(index[^/]*\\.js)/, '($1')).join(' <- ')
      const key = what + '  ' + st
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const sp = CSSStyleDeclaration.prototype.setProperty
    CSSStyleDeclaration.prototype.setProperty = function (p, v, pr) { bump('setProperty ' + p); return sp.call(this, p, v, pr) }
    for (const prop of ['transform', 'width', 'height', 'opacity', 'left', 'top', 'order', 'background', 'filter', 'cssText']) {
      const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop)
      if (d && d.set) Object.defineProperty(CSSStyleDeclaration.prototype, prop, { ...d, set(v) { bump('style.' + prop); return d.set.call(this, v) } })
    }
    const ca = DOMTokenList.prototype.add, cr = DOMTokenList.prototype.remove, ct = DOMTokenList.prototype.toggle
    DOMTokenList.prototype.add = function (...a) { bump('classList.add ' + a.join(' ')); return ca.apply(this, a) }
    DOMTokenList.prototype.remove = function (...a) { bump('classList.remove ' + a.join(' ')); return cr.apply(this, a) }
    DOMTokenList.prototype.toggle = function (...a) { bump('classList.toggle ' + a[0]); return ct.apply(this, a) }
    const sa = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (n, v) { bump('setAttribute ' + n); return sa.call(this, n, v) }
    const tc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')
    Object.defineProperty(Node.prototype, 'textContent', { ...tc, set(v) { bump('textContent'); return tc.set.call(this, v) } })
    window.__styleCounts = counts
    return true
  })()`)
  await sleep(3000)
  const rows = await app.ev(`[...window.__styleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)`)
  console.log('style/DOM writes per second, by caller:')
  for (const [k, v] of rows) console.log(`   ${(v / 3).toFixed(1).padStart(6)}/s  ${k}`)
}
if (flags.has('trace')) {
  // The DevTools Performance panel's view: every Paint / raster / composite event for 3 s,
  // grouped by the DOM node that was painted, with the painted area.
  const events = []
  app.on('Tracing.dataCollected', ({ value }) => events.push(...value))
  let done
  const complete = new Promise((r) => (done = r))
  app.on('Tracing.tracingComplete', () => done())
  const cats = 'disabled-by-default-devtools.timeline,devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline.stack'
  const st = await app.send('Tracing.start', { categories: cats, transferMode: 'ReportEvents', options: 'sampling-frequency=1000' })
  if (st.error) console.log('tracing start failed:', st.error.message)
  const p0 = Date.now()
  await sleep(3000)
  await app.send('Tracing.end')
  await Promise.race([complete, sleep(10000)])
  const secs = (Date.now() - p0) / 1000
  const byName = new Map()
  const paintsByNode = new Map()
  for (const e of events) {
    if (!e.name) continue
    const c = byName.get(e.name) ?? { n: 0, dur: 0 }
    c.n++; c.dur += e.dur ?? 0
    byName.set(e.name, c)
    if (e.name === 'Paint' && e.args?.data?.clip) {
      const clip = e.args.data.clip
      const xs = [clip[0], clip[2], clip[4], clip[6]], ys = [clip[1], clip[3], clip[5], clip[7]]
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      const key = e.args.data.nodeId ?? 0
      const p = paintsByNode.get(key) ?? { n: 0, area: 0, maxArea: 0, layer: e.args.data.layerId }
      p.n++; p.area += area; p.maxArea = Math.max(p.maxArea, area)
      paintsByNode.set(key, p)
    }
  }
  console.log(`trace ${secs.toFixed(1)} s, ${events.length} events. Per second:`)
  for (const name of ['Paint', 'RasterTask', 'UpdateLayer', 'UpdateLayerTree', 'CompositeLayers', 'DrawFrame', 'BeginFrame', 'Commit', 'Layout', 'UpdateLayoutTree', 'FunctionCall', 'Animation', 'HitTest']) {
    const c = byName.get(name)
    if (c) console.log(`   ${name.padEnd(16)} ${(c.n / secs).toFixed(0).padStart(6)}/s   ${(c.dur / 1000 / secs).toFixed(1).padStart(6)} ms/s`)
  }
  // Who asks for the style recalcs and layouts: the top JS frame of each scheduling event.
  for (const name of ['ScheduleStyleRecalculation', 'UpdateLayoutTree', 'InvalidateLayout', 'FunctionCall', 'TimerFire', 'FireAnimationFrame']) {
    const agg = new Map()
    for (const e of events) {
      if (e.name !== name) continue
      const d = e.args?.data ?? e.args?.beginData ?? {}
      const top = d.stackTrace?.[0]
      const key = top ? `${top.functionName || '(anon)'} ${(top.url || '').split('/').pop()}:${top.lineNumber}` : d.functionName ? `${d.functionName} ${(d.url || '').split('/').pop()}:${d.lineNumber}` : '(no stack)'
      agg.set(key, (agg.get(key) ?? 0) + 1)
    }
    if (agg.size === 0) continue
    console.log(`${name} by caller (/s):`)
    for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${(v / secs).toFixed(1).padStart(6)}/s  ${k}`)
  }
  // Invalidation tracking: which node, for what reason, made Chromium repaint or
  // recalculate — the answer to "why is the whole document layer repainted".
  for (const name of ['PaintInvalidationTracking', 'StyleRecalcInvalidationTracking', 'StyleInvalidatorInvalidationTracking', 'LayoutInvalidationTracking']) {
    const agg = new Map()
    for (const e of events) {
      if (e.name !== name) continue
      const d = e.args?.data ?? {}
      const top = d.stackTrace?.[0]
      const key = `${d.nodeName ?? '?'}  ${d.reason ?? ''}${d.selectorPart ? ` [${d.selectorPart}]` : ''}${d.extraData ? ` ${d.extraData}` : ''}${top ? `  <- ${top.functionName || '(anon)'}:${top.lineNumber}` : ''}`
      agg.set(key, (agg.get(key) ?? 0) + 1)
    }
    if (agg.size === 0) continue
    console.log(`${name} (/s):`)
    for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${(v / secs).toFixed(1).padStart(6)}/s  ${k.slice(0, 150)}`)
  }
  const rows = [...paintsByNode.entries()].sort((a, b) => b[1].area - a[1].area).slice(0, 12)
  console.log('paints by node (paints/s, Mpx/s, largest clip px):')
  for (const [nodeId, p] of rows) {
    let what = `node ${nodeId}`
    if (nodeId) {
      try {
        const n = (await app.send('DOM.describeNode', { backendNodeId: nodeId })).result.node
        const cls = n.attributes ? n.attributes[n.attributes.indexOf('class') + 1] : ''
        what = `<${n.nodeName.toLowerCase()}${cls ? ` .${String(cls).split(' ').slice(0, 2).join('.')}` : ''}>`
      } catch { /* gone */ }
    }
    console.log(`   ${(p.n / secs).toFixed(1).padStart(6)}/s  ${(p.area / 1e6 / secs).toFixed(2).padStart(7)} Mpx/s  ${String(Math.round(p.maxArea)).padStart(9)}  ${what}`)
  }
}
if (flags.has('profile')) {
  // Where the renderer's main thread goes for 5 s: a CPU profile aggregated by function,
  // xterm renders per second, and Chromium's layout/style counters.
  const m0 = (await app.send('Performance.getMetrics')).result.metrics
  await app.ev(`window.__probeRenders = 0; window.__probeRenderDisp = window.__ember.term(${JSON.stringify(sess.id)}).onRender(() => window.__probeRenders++); true`)
  await app.send('Profiler.enable')
  await app.send('Profiler.setSamplingInterval', { interval: 500 })
  await app.send('Profiler.start')
  const p0 = Date.now()
  await sleep(5000)
  const prof = (await app.send('Profiler.stop')).result.profile
  const secs = (Date.now() - p0) / 1000
  const renders = await app.ev(`window.__probeRenderDisp.dispose(); window.__probeRenders`)
  const m1 = (await app.send('Performance.getMetrics')).result.metrics
  const delta = (name) => (m1.find((x) => x.name === name)?.value ?? 0) - (m0.find((x) => x.name === name)?.value ?? 0)
  console.log(`profile over ${secs.toFixed(1)} s: xterm renders ${(renders / secs).toFixed(1)}/s, layouts ${(delta('LayoutCount') / secs).toFixed(1)}/s, style recalcs ${(delta('RecalcStyleCount') / secs).toFixed(1)}/s, script ${(delta('ScriptDuration') / secs * 100).toFixed(1)}% , layout ${(delta('LayoutDuration') / secs * 100).toFixed(1)}%, tasks ${(delta('TaskDuration') / secs * 100).toFixed(1)}%`)
  const total = prof.nodes.reduce((n, x) => n + (x.hitCount ?? 0), 0)
  const byFn = new Map()
  for (const n of prof.nodes) {
    const cf = n.callFrame
    const key = `${cf.functionName || '(anonymous)'}  ${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`
    byFn.set(key, (byFn.get(key) ?? 0) + (n.hitCount ?? 0))
  }
  // Inclusive time for the heavy parents too: walk children.
  const byId = new Map(prof.nodes.map((n) => [n.id, n]))
  const incl = new Map()
  const totalOf = (n) => {
    if (incl.has(n.id)) return incl.get(n.id)
    let t = n.hitCount ?? 0
    for (const c of n.children ?? []) t += totalOf(byId.get(c))
    incl.set(n.id, t)
    return t
  }
  for (const n of prof.nodes) totalOf(n)
  console.log(`top self time (${total} samples):`)
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`   ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
  const inclFns = new Map()
  for (const n of prof.nodes) {
    const cf = n.callFrame
    const key = `${cf.functionName || '(anonymous)'}  ${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`
    inclFns.set(key, Math.max(inclFns.get(key) ?? 0, incl.get(n.id)))
  }
  console.log('top inclusive:')
  for (const [k, v] of [...inclFns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`   ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
}
child.kill()
process.exit(0)
