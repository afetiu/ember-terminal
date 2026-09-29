/**
 * Head-to-head throughput: Ember vs Windows Terminal, same command, same shell.
 *
 * Console writes block on the host consuming them, so Measure-Command around a
 * large Out-Host really does include the terminal's render cost. Each side writes
 * its elapsed time and grid size to a file, so nothing depends on reading a screen.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync , mkdirSync } from 'node:fs'
import { join , basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME, EMBER_PROBE_INACTIVE: '1' }
const TMP = process.env.TEMP

// The user's own config, with per-run overrides, so an A/B of the window material or the
// renderer is one flag rather than an edit to ~/.ember.
//   node scripts/bench.mjs [--material=none|acrylic|mica] [--opacity=N] [--no-webgl]
import { homedir } from 'node:os'
const flags = new Map(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1'] }))
{
  const userCfg = join(homedir(), '.ember', 'config.json')
  const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
  cfg.window ??= {}
  if (flags.has('material')) cfg.window.material = flags.get('material')
  if (flags.has('opacity')) cfg.window.opacity = Number(flags.get('opacity'))
  writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))
  console.log(`config: material=${cfg.window.material ?? 'none'} opacity=${cfg.window.opacity ?? '?'}${flags.has('no-webgl') ? ' (DOM renderer)' : ''}`)
}
const LINES = 20000
const emberOut = join(TMP, 'bench-ember.txt')
const wtOut = join(TMP, 'bench-wt.txt')
for (const f of [emberOut, wtOut]) if (existsSync(f)) rmSync(f)

// The payload lives in a .ps1 rather than a -Command string: Windows Terminal
// treats `;` in its own argv as a subcommand separator, which mangles any inline
// PowerShell. A file path has no metacharacters either side can misread.
const script = join(TMP, 'ember-bench.ps1')
writeFileSync(
  script,
  `param([string]$Out)
$s = $Host.UI.RawUI.WindowSize
$t = Measure-Command { 1..${LINES} | ForEach-Object { "line $_ " + ('x' * 90) } | Out-Host }
"$([int]$t.TotalMilliseconds) $($s.Width)x$($s.Height)" | Set-Content -Path $Out
`,
  'utf8',
)

async function waitFor(file, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const txt = readFileSync(file, 'utf8').trim()
      if (txt) return txt
    }
    await sleep(300)
  }
  return null
}

// ---------- Windows Terminal ----------
// BENCH_SKIP_WT=1 for Ember-vs-Ember A/B runs, where WT's own run-to-run variance
// (2966ms vs 1499ms on this machine) would swamp the effect being measured.
let wt = null
if (!process.env.BENCH_SKIP_WT) {
  console.log('running Windows Terminal pass...')
  spawn('wt.exe', ['-w', 'new', 'pwsh.exe', '-NoLogo', '-NoProfile', '-File', script, '-Out', wtOut], {
    stdio: 'ignore',
    detached: true,
  }).unref()
  wt = await waitFor(wtOut, 180000)
}

// ---------- Ember ----------
console.log('running Ember pass...')
const PORT = 9336
// --profile-main: a CPU profile of the *main* process during the pass. Main is where
// every pty byte and every keystroke crosses, so a stall there is felt in every tab.
const MAIN_INSPECT = 9329
const child = spawn(
  './node_modules/electron/dist/electron.exe',
  ['.', `--remote-debugging-port=${PORT}`, ...(flags.has('no-webgl') ? ['--no-webgl'] : []), ...(flags.has('profile-main') ? [`--inspect=${MAIN_INSPECT}`] : [])],
  { stdio: 'ignore', env: PROBE_ENV },
)

async function mainSession() {
  if (!flags.has('profile-main')) return null
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${MAIN_INSPECT}/json`)).json()
      const t = list.find((x) => x.webSocketDebuggerUrl)
      if (t) {
        const sock = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((r) => sock.addEventListener('open', r, { once: true }))
        let n = 0
        const waiting = new Map()
        sock.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data)
          const p = waiting.get(m.id)
          if (p) {
            waiting.delete(m.id)
            p(m)
          }
        })
        const call = (method, params = {}) =>
          new Promise((res) => {
            waiting.set(++n, res)
            sock.send(JSON.stringify({ id: n, method, params }))
          })
        await call('Profiler.enable')
        await call('Profiler.setSamplingInterval', { interval: 1000 })
        return { call, sock }
      }
    } catch (err) {
      if (i === 49) console.error(`main inspector: ${err.message}`)
    }
    await sleep(300)
  }
  console.error('main inspector never answered; no main profile')
  return null
}

function topSelf(profile, label) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const hits = new Map()
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1)
  const total = profile.samples.length || 1
  const rows = [...hits]
    .map(([id, c]) => {
      const f = byId.get(id)?.callFrame ?? {}
      const where = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : ''
      return { name: `${f.functionName || '(anon)'} ${where}`, pct: (c / total) * 100 }
    })
    .sort((a, b) => b.pct - a.pct)
  console.log(`\n-- ${label} CPU (self time, top 16 of ${total} samples) --`)
  for (const r of rows.slice(0, 16)) console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.name}`)
}

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(400)
  }
  throw new Error('no devtools target')
}

const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
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
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await send('Runtime.enable')
await sleep(1500)
// WT launches maximized (launchMode in the user's settings), so match it — a
// smaller grid is less work per frame and would flatter Ember.
await evaluate(`window.ember.window.toggleMaximize()`)
// Wait for the prompt, not a fixed delay: a profile with oh-my-posh in it takes several
// seconds to reach its first prompt, and a command typed before that is eaten.
{
  let last = -1
  let quietSince = 0
  for (let i = 0; i < 300; i++) {
    const s = (await evaluate(`window.__ember.sessions()[0]`)) ?? null
    if (s && s.bytesIn > 0) {
      const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
      const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
      if (s.bytesIn === last) {
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince > (prompt ? 1200 : 9000)) break
      } else {
        quietSince = 0
        last = s.bytesIn
      }
    }
    await sleep(150)
  }
}
const sid = await evaluate(`document.querySelector('.ember-group.is-active .ember-pane').dataset.sessionId`)
const main = await mainSession()
if (main) await main.call('Profiler.start')
const cmd = `& '${script}' -Out '${emberOut}'`
await evaluate(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(cmd + '\r')})`)

// Watch it drain. A pass that times out used to say nothing about *how* it failed;
// bytes received and the pty's pause bookkeeping every few seconds show whether the
// shell was blocked (paused for backpressure) or the renderer was slow.
let ember = null
const t0 = Date.now()
while (Date.now() - t0 < 180000) {
  ember = await waitFor(emberOut, 5000)
  if (ember) break
  const s = await evaluate(`window.__ember.sessions()[0]`)
  const diag = await evaluate(`window.__ember.loopLag ? window.__ember.loopLag() : null`)
  const p = diag?.pty?.[s?.id] ?? {}
  console.log(
    `  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  received ${String(s?.bytesIn ?? 0).padStart(8)}  ` +
      `unacked ${String(p.unacked ?? '?').padStart(7)}  pauses ${p.pauses ?? '?'}  paused ${p.pausedMs ?? '?'}ms  main loop max ${diag?.max ?? '?'}ms`,
  )
}
const stats = await evaluate(`window.__ember.sessions()[0] && { bytes: window.__ember.sessions()[0].bytesIn }`)
if (main) {
  const r = await main.call('Profiler.stop')
  if (r.result?.profile) topSelf(r.result.profile, 'main process')
  main.sock.close()
}

ws.close()
child.kill()

const parse = (s) => (s ? { ms: Number(s.split(' ')[0]), grid: s.split(' ')[1] } : null)
const w = parse(wt)
const v = parse(ember)

console.log('')
console.log(`lines rendered      : ${LINES}`)
console.log(`Windows Terminal    : ${w ? `${w.ms} ms  (grid ${w.grid})` : 'FAILED/timeout'}`)
console.log(`Ember                : ${v ? `${v.ms} ms  (grid ${v.grid})` : 'FAILED/timeout'}`)
if (stats) console.log(`Ember chars received : ${stats.bytes}`)
if (w && v) {
  const ratio = v.ms / w.ms
  console.log(`ratio               : Ember is ${ratio.toFixed(2)}x ${ratio > 1 ? 'slower' : 'faster'} than WT`)
  console.log(`throughput (Ember)   : ${Math.round((stats?.bytes ?? 0) / (v.ms / 1000) / 1024)} KB/s sustained`)
}
process.exit(0)
