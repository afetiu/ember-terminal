/**
 * Frame pacing of every animation the app has.
 *
 * Smoothness is not a feeling; it is the distribution of gaps between presented frames.
 * This records requestAnimationFrame timestamps in the page while each motion runs —
 * a tab opening, a switch, the panel sliding in over a real document, the panel closing,
 * the sidebar collapsing, the orchestrator column, the palette — and reports, per motion,
 * how many frames were late (gap over 20ms, i.e. a dropped frame at 60Hz), the worst gap,
 * and the 95th percentile. A motion is smooth when the late count is zero and the worst
 * gap is one frame.
 *
 * rAF cadence follows the compositor: when the GPU cannot present, rAF is held back too,
 * so this catches jank the main thread never sees as well as jank it causes.
 *
 *   node scripts/probe-frames.mjs [--material=none|acrylic] [--opacity=N] [--no-webgl] [--rounds=N]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const args = new Map(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1'] }))
const PORT = Number(args.get('port') ?? 9401)
const ROUNDS = Number(args.get('rounds') ?? 2)
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
cfg.window ??= {}
if (args.has('material')) cfg.window.material = args.get('material')
if (args.has('opacity')) cfg.window.opacity = Number(args.get('opacity'))
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const electronArgs = ['.', `--remote-debugging-port=${PORT}`]
if (args.has('no-webgl')) electronArgs.push('--no-webgl')
const child = spawn('./node_modules/electron/dist/electron.exe', electronArgs, {
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
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++seq, res)
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result?.result?.value
}
await send('Runtime.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
for (let i = 0; i < 100; i++) {
  if (await ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}

async function waitForPrompt(id) {
  let last = -1
  let quietSince = 0
  for (let i = 0; i < 300; i++) {
    const s = (await ev(`window.__ember.sessions()`)).find((x) => (id ? x.id === id : true))
    if (s && s.bytesIn > 0) {
      const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
      const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
      if (s.bytesIn === last) {
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince > (prompt ? 1200 : 9000)) return s
      } else {
        quietSince = 0
        last = s.bytesIn
      }
    }
    await sleep(150)
  }
  throw new Error('shell never settled')
}

// The recorder: rAF timestamps while armed.
await ev(`(() => {
  const R = window.__frames = { on: false, ts: [] }
  const loop = (t) => { if (R.on) R.ts.push(t); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  R.start = () => { R.ts = []; R.on = true }
  R.stop = () => { R.on = false; return R.ts }
})()`)

const first = await waitForPrompt()
console.log(`ember up · pane ${first.cols}x${first.rows} · material=${cfg.window.material ?? 'none'} opacity=${cfg.window.opacity ?? '?'}${args.has('no-webgl') ? ' · DOM renderer' : ''}`)

const results = []
async function measure(name, trigger, ms = 900) {
  await ev(`window.__frames.start()`)
  await trigger()
  await sleep(ms)
  const ts = await ev(`window.__frames.stop()`)
  const gaps = []
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1])
  const sorted = [...gaps].sort((a, b) => a - b)
  const late = gaps.filter((g) => g > 20).length
  const bad = gaps.filter((g) => g > 50).length
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const max = sorted.at(-1) ?? 0
  results.push({ name, frames: ts.length, late, bad, p95, max })
  return { late, max }
}

const home = await ev(`window.__ember.activeTab()`)
const MARKDOWN = [
  '# Probe panel',
  '',
  'A table, a list and a diagram, so the document costs what a real one costs.',
  '',
  '| step | state | ms |',
  '|---|---|---|',
  ...Array.from({ length: 14 }, (_, i) => `| step ${i + 1} | done | ${(i * 37) % 200} |`),
  '',
  '```mermaid',
  'flowchart LR',
  '  A[keys] --> B[pty] --> C[shell] --> D[ConPTY] --> E[main] --> F[renderer]',
  '```',
  '',
  ...Array.from({ length: 20 }, (_, i) => `- item ${i + 1} with a line of text long enough to wrap in a narrow panel`),
].join('\n')

/** The spare terminal is built only in quiet; a tab opened before it exists is built inline. */
async function waitForSpare() {
  for (let i = 0; i < 80; i++) {
    if (await ev(`window.__ember.spareReady ? window.__ember.spareReady() : true`)) return
    await sleep(300)
  }
}

for (let round = 1; round <= ROUNDS; round++) {
  await waitForSpare()
  await measure('new tab (entrance)', () => ev(`window.__ember.newTab()`), 1200)
  const tabs = await ev(`window.__ember.groups().map((g) => g.id)`)
  await sleep(2500)
  await measure('switch tab', () => ev(`window.__ember.activate(${JSON.stringify(home)})`))
  await measure('switch tab back', () => ev(`window.__ember.activate(${JSON.stringify(tabs.at(-1))})`))
  await measure('panel: push + open (doc loading)', () => ev(`window.__ember.pushPanel('Probe', ${JSON.stringify(MARKDOWN)})`), 1600)
  await sleep(1500)
  await measure('panel: close', () => ev(`window.__ember.togglePanel()`))
  await sleep(400)
  await measure('panel: open (doc loaded)', () => ev(`window.__ember.togglePanel()`))
  await sleep(400)
  await measure('switch tab (panel open)', () => ev(`window.__ember.activate(${JSON.stringify(home)})`))
  await measure('switch back (to panel)', () => ev(`window.__ember.activate(${JSON.stringify(tabs.at(-1))})`))
  await measure('sidebar: collapse', () => ev(`window.__ember.sidebar()`))
  await sleep(300)
  await measure('sidebar: expand', () => ev(`window.__ember.sidebar()`))
  await sleep(300)
  await measure('orchestrator: open', () => ev(`window.__ember.orchestrator()`))
  await sleep(300)
  await measure('orchestrator: close', () => ev(`window.__ember.orchestrator()`))
  await sleep(300)
  await measure('palette: open', () => ev(`window.__ember.openPalette('')`), 600)
  await measure('palette: close', () => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })), 600)
  await ev(`window.__ember.togglePanel()`)
  await sleep(600)
  await measure('idle (nothing moving)', async () => {}, 1000)
  if (round < ROUNDS) console.log(`round ${round} done`)
}

console.log('\nmotion                                 frames  late(>20ms)  bad(>50ms)    p95     max')
for (const r of results) {
  console.log(`${r.name.padEnd(38)} ${String(r.frames).padStart(6)}  ${String(r.late).padStart(11)}  ${String(r.bad).padStart(10)}  ${r.p95.toFixed(1).padStart(5)}ms ${r.max.toFixed(0).padStart(5)}ms`)
}
const worst = results.filter((r) => r.name !== 'idle (nothing moving)').sort((a, b) => b.late - a.late).slice(0, 3)
console.log(`\nworst: ${worst.map((r) => `${r.name} (${r.late} late, max ${r.max.toFixed(0)}ms)`).join(' · ')}`)

try {
  for (const s of await ev(`window.__ember.sessions()`)) await ev(`window.ember.write(${JSON.stringify(s.id)}, "\\u0003exit\\r")`)
  await sleep(500)
} catch {
  /* gone */
}
child.kill()
ws.close()
