/**
 * What the one-Claude canvas costs: the numbers in docs/engineering-notes.md › "The canvas,
 * measured". Launches its own Ember (own EMBER_HOME, onboarded) and, for the Claude parts,
 * the real `claude --model haiku` in ~/agent-box, typed into a plain shell as a person would.
 *
 *   node scripts/probe-perf.mjs [--only=start,claude,hooks,mem,frames] [--port=9501] [--profile]
 *
 *   start   launch → first shell prompt, three launches, median
 *   claude  `claude` typed → canvas ready (and what the canvas said meanwhile); CPU idle with
 *           the canvas up; CPU while a long reply streams (3 turns, median); keypress →
 *           character in the composer (idle and while streaming) and in a plain shell; the
 *           real permission round trip (Claude Code's dialog drawn → Ember's card shown)
 *   hooks   the hook itself, without a model: an async event (start → in the renderer) and a
 *           PermissionRequest (start → card shown), 7 each, median — run exactly as the
 *           settings file Claude Code is handed says (a command, or an http hook)
 *   mem     Ember's memory with 1 and with 4 Claude canvas tabs
 *   frames  a made-up conversation with 30 diagrams (window.__ember.loomFeed): memory, frames,
 *           CPU while scrolled to the top and at rest
 *
 * Memory is private bytes (a working set is trimmed under memory pressure and reads lower
 * with more tabs). CPU and memory are Ember's own processes only (the probe's electron.exe tree), so other
 * Embers on the machine do not count; the machine's total load is printed beside each.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { seedHome } from './probelib.mjs'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const flags = new Map(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1'] }))
const PORT = Number(flags.get('port') ?? 9501)
const ONLY = new Set((flags.get('only') ?? 'start,claude,hooks,mem,frames').split(','))
const CWD = join(homedir(), 'agent-box')
const HOME = join(process.env.TEMP ?? '.', `ember-probe-perf-${PORT}`)
/** A shell prompt: PowerShell's own, or a profile's (this machine's draws ▸, through the wrong code page â–¸). */
const PROMPT = /(PS .*>|[>❯▸¸$#»])\s*$/
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN }
const out = {}
const note = (k, v) => { out[k] = v; console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) }

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
/** Every process under `root` (the launched electron.exe), with its kind, CPU seconds and working set. */
function snap(root) {
  const list = [].concat(JSON.parse(ps(`Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | % { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; c=($_.CommandLine -replace '[^ -~]', ' '); k=[double]($_.KernelModeTime + $_.UserModeTime) / 1e7; ws=[math]::Round($_.PrivatePageCount/1MB) } } | ConvertTo-Json -Compress`) || '[]'))
  const kids = new Map()
  for (const p of list) kids.set(p.pp, [...(kids.get(p.pp) ?? []), p])
  const mine = []
  const walk = (pid, depth) => { for (const k of kids.get(pid) ?? []) { if (k.p === pid) continue; mine.push(k); if (depth < 12) walk(k.p, depth + 1) } }
  const self = list.find((p) => p.p === root)
  if (self) mine.push(self)
  walk(root, 0)
  return mine
    .filter((p) => /^electron\.exe$/i.test(p.n))
    .map((p) => ({ pid: p.p, type: /--type=(\w+)/.exec(p.c ?? '')?.[1] ?? 'main', sub: /utility-sub-type=(\S+)/.exec(p.c ?? '')?.[1]?.split('.')[0] ?? '', cpu: p.k, mb: p.ws }))
}
function machineLoad() {
  try { return Number(ps(`(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average`)) } catch { return NaN }
}
/** CPU % of one core per kind of process over a window, from two snaps. */
function cpuBetween(a, b, secs) {
  const by = {}
  for (const p of b) {
    const was = a.find((x) => x.pid === p.pid)
    if (!was) continue
    const kind = p.type === 'renderer' ? 'renderer' : p.type === 'main' ? 'main' : p.type === 'gpu-process' ? 'gpu' : 'other'
    by[kind] = (by[kind] ?? 0) + ((p.cpu - was.cpu) / secs) * 100
  }
  by.total = Object.values(by).reduce((n, x) => n + x, 0)
  for (const k of Object.keys(by)) by[k] = Math.round(by[k] * 10) / 10
  return by
}
const ram = (s) => {
  const by = { total: 0 }
  for (const p of s) {
    const kind = p.type === 'renderer' ? 'renderer' : p.type
    by[kind] = (by[kind] ?? 0) + p.mb
    by.total += p.mb
  }
  return by
}

function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const handlers = new Map()
  const ready = new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id) }
    else handlers.get(m.method)?.(m.params)
  })
  const send = (method, params = {}) => new Promise((r) => { pending.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })) })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result?.result?.value
  }
  return { ws, ready, send, ev, on: (m, cb) => handlers.set(m, cb) }
}

/** Whatever Ember holds this probe's port: its own earlier launch (one that relaunched itself for the GPU is no longer its child). */
function killPort() {
  try { ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ? { $_.CommandLine -match 'remote-debugging-port=${PORT}( |$)' } | % { taskkill /PID $_.ProcessId /T /F | Out-Null }`) } catch {}
}
async function launch() {
  killPort()
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); await sleep(250) } catch { break } }
  rmSync(HOME, { recursive: true, force: true })
  seedHome(HOME)
  const t0 = Date.now()
  const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, EMBER_HOME: HOME, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: '1400x900' },
  })
  let target = null
  for (let i = 0; i < 300 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) } catch {}
    if (!target) await sleep(50)
  }
  if (!target) throw new Error('no renderer')
  const app = cdp(target)
  await app.ready
  for (let i = 0; i < 400; i++) { try { if (await app.ev(`typeof window.__ember !== 'undefined' && window.__ember.sessions().length > 0`)) break } catch {} await sleep(25) }
  let prompt = 0
  for (let i = 0; i < 800 && !prompt; i++) {
    const s = (await app.ev(`window.__ember.sessions()`))[0]
    if (s && PROMPT.test(String(s.text ?? '').trimEnd())) { prompt = Date.now() - t0; if (flags.has('debug')) console.log(JSON.stringify(s.text.slice(-200))) }
    else await sleep(25)
  }
  const kill = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} killPort() }
  process.on('exit', kill)
  return { app, child, prompt, kill }
}

const until = async (fn, ms, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step) } return null }

// ------------------------------------------------------------------ start
if (ONLY.has('start')) {
  const times = []
  for (let i = 0; i < 5; i++) {
    const { prompt, kill } = await launch()
    times.push(prompt)
    kill()
    await sleep(1500)
  }
  note('start: launch → first shell prompt, ms (5 launches)', { runs: times, median: median(times) })
}

if (ONLY.has('claude') || ONLY.has('startup') || ONLY.has('hooks') || ONLY.has('mem') || ONLY.has('frames')) {
  const { app, child, kill } = await launch()
  const ev = app.ev
  const key = (k, code, vk, modifiers = 0, text) =>
    app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() => app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }))
  const enter = () => key('Enter', 'Enter', 13, 0, '\r')
  const first = await ev('window.__ember.activeTab()')

  /** A tab in ~/agent-box running claude, started by typing it at the plain shell's prompt. */
  async function claudeTab(record = false) {
    const tab = await ev(`window.__ember.newLoom(${JSON.stringify(CWD)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    await until(async () => (await ev(`window.__ember.loom(${JSON.stringify(tab)})`))?.rows?.some((r) => PROMPT.test(r)), 30_000)
    const l = await ev(`window.__ember.loom(${JSON.stringify(tab)})`)
    if (l.mode !== 'shell' || l.claude) throw new Error(`tab ${tab} is not a plain shell (${l.mode})`)
    if (record) {
      // What the canvas and the hidden TUI said while Claude Code started, frame by frame.
      await ev(`(() => {
        const tab = ${JSON.stringify(tab)}
        const r = (window.__perfStart = { t0: 0, events: [], lines: [], hints: [], boxAt: 0, modeAt: 0, hookAt: {} })
        window.ember.hooks.onEvent((e) => { if (e.tabId === tab && !r.hookAt[e.event]) r.hookAt[e.event] = Date.now() })
        const seen = new Set(), saw = new Set()
        const tick = () => {
          const l = window.__ember.loom(tab)
          if (l) {
            if (!r.modeAt && l.mode === 'claude') r.modeAt = Date.now()
            if (!r.boxAt && l.wrapper && l.wrapper.boxSeen) r.boxAt = Date.now()
            for (const row of l.rows) { const t = row.trim(); if (t && !seen.has(t) && r.lines.length < 80) { seen.add(t); r.lines.push([Date.now(), t.slice(0, 120)]) } }
            const el = document.querySelector('.is-active .loom-hint-text, .loom-starting, .loom-boot')
            const said = [...document.querySelectorAll('.loom-hint-text, .loom-starting, .loom-boot')].filter((x) => x.offsetParent).map((x) => x.textContent.trim()).join(' | ')
            if (said && !saw.has(said)) { saw.add(said); r.hints.push([Date.now(), said.slice(0, 160)]) }
          }
          if (!r.boxAt || Date.now() - r.boxAt < 1500) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        return true
      })()`)
    }
    await ev(`document.querySelector('.is-active .xterm-helper-textarea, .xterm-helper-textarea')?.focus()`)
    // Focus the tab's own terminal textarea (the active tab's).
    await ev(`(() => { const s = window.__ember.term(window.__ember.groups().find((g) => g.id === ${JSON.stringify(tab)}).panes[0]); s.focus(); return true })()`)
    await app.send('Input.insertText', { text: 'claude --model haiku --permission-mode default' })
    await sleep(150)
    const t0 = Date.now()
    if (record) await ev(`window.__perfStart.t0 = ${t0}`)
    await enter()
    const up = await until(async () => { const x = await ev(`window.__ember.loom(${JSON.stringify(tab)})`); return x?.claude && x.wrapper?.boxSeen && x }, 90_000, 50)
    return { tab, t0, ready: up ? Date.now() - t0 : NaN }
  }

  async function profileFor(ms, title) {
    await app.send('Profiler.enable')
    await app.send('Profiler.start')
    await sleep(ms)
    const prof = (await app.send('Profiler.stop')).result.profile
    const self = new Map()
    const byId = new Map(prof.nodes.map((n) => [n.id, n]))
    for (let k = 0; k < prof.samples.length; k++) {
      const f = byId.get(prof.samples[k]).callFrame
      const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`
      self.set(name, (self.get(name) ?? 0) + (prof.timeDeltas[k] ?? 0) / 1000)
    }
    console.log(`   ${title}`)
    for (const [k, v] of [...self.entries()].sort((x, y) => y[1] - x[1]).slice(0, 16)) console.log(`   ${v.toFixed(1).padStart(8)}  ${k}`)
  }
  // The diagrams alone need no Claude.
  const needClaude = ['claude', 'startup', 'hooks', 'mem'].some((k) => ONLY.has(k))
  const tab = needClaude ? await claudeTab(true) : { tab: first, ready: NaN, t0: 0 }
  if (needClaude) await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab.tab)})`)
  const loom = () => ev(`window.__ember.loom(${JSON.stringify(tab.tab)})`)
  if (needClaude) await until(async () => (await ev('window.__perfStart')).hookAt.SessionStart, 12_000, 100)
  const rec = needClaude ? await ev('window.__perfStart') : null
  if (ONLY.has('claude') || ONLY.has('startup')) {
    note('claude: typed → canvas ready (input box seen), ms', tab.ready)
    note('claude: typed → SessionStart hook in renderer, ms', rec.hookAt.SessionStart ? rec.hookAt.SessionStart - rec.t0 : 'none')
    console.log('   what the canvas said while starting:')
    for (const [t, h] of rec.hints) console.log(`   ${String(t - rec.t0).padStart(6)} ms  ${h}`)
    if (flags.has('lines')) for (const [t, h] of rec.lines) console.log(`   ${String(t - rec.t0).padStart(6)} ms  | ${h}`)
  }

  const say = async (text) => {
    await ev(`document.querySelector('.is-active .loom-native-input, .loom-native-input').focus()`)
    await app.send('Input.insertText', { text })
    await enter()
  }
  const idle = () => until(async () => { const w = (await loom())?.wrapper; return w?.phase === 'idle' && !w.live && w }, 120_000, 100)

  if (ONLY.has('claude')) {
    await sleep(8000)
    const idleRuns = []
    for (let i = 0; i < 3; i++) {
      const load = machineLoad()
      const a = snap(child.pid)
      await sleep(8000)
      const b = snap(child.pid)
      idleRuns.push({ ...cpuBetween(a, b, 8), load })
    }
    if (flags.has('profile')) await profileFor(4000, 'renderer self time over 4 s, idle with the canvas up (ms):')
    note('claude: CPU % idle, canvas up (3 × 8 s)', { runs: idleRuns, median: median(idleRuns.map((r) => r.total)), renderer: median(idleRuns.map((r) => r.renderer)), main: median(idleRuns.map((r) => r.main)) })
    if (flags.has('idle-only')) {
      // What the idle canvas is doing: layouts and writes per second.
      console.log('   idle activity (5 s):', JSON.stringify(await ev(`(async () => { const t = window.__ember.term(window.__ember.groups().find((g) => g.id === ${JSON.stringify(tab.tab)}).panes[0]); let w = 0, bytes = 0; const d = t.onWriteParsed(() => w++); let f = 0; const fr = () => { f++; if (on) requestAnimationFrame(fr) }; let on = true; requestAnimationFrame(fr); await new Promise((r) => setTimeout(r, 5000)); on = false; d.dispose(); return { writesPerS: w / 5, framesPerS: f / 5 } })()`)))
      console.log('   running animations:', await ev(`JSON.stringify(document.getAnimations().filter((a) => a.playState === 'running').map((a) => { const t = a.effect && a.effect.target; return (a.animationName || a.constructor.name) + ' on ' + (t ? (t.tagName + '.' + String(t.className).split(' ').slice(0, 3).join('.')) : '?') + (t && t.offsetParent === null ? ' (hidden)' : '') }))`))
      console.log('   cursor:', JSON.stringify(await ev('window.__ember.cursorState()')), 'xterm paused:', await ev(`window.__ember.term(window.__ember.groups().find((g) => g.id === ${JSON.stringify(tab.tab)}).panes[0])._core._renderService._isPaused`))
      console.log('   rAF callers (3 s):', await ev(`(async () => { const orig = window.requestAnimationFrame; const counts = new Map(); window.requestAnimationFrame = function (cb) { const s = (new Error().stack || '').split('\n').slice(2, 4).map((x) => x.trim()).join(' <- '); counts.set(s, (counts.get(s) || 0) + 1); return orig.call(window, cb) }; await new Promise((r) => setTimeout(r, 3000)); window.requestAnimationFrame = orig; return JSON.stringify([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) })()`))
      kill()
      process.exit(0)
    }

    // Typing into the composer: keydown → the character in the textarea → the frame it shows in.
    const composerLatency = async (n) => {
      await ev(`document.querySelector('.is-active .loom-native-input, .loom-native-input').focus()`)
      const res = []
      for (let i = 0; i < n; i++) {
        await ev(`(() => { const inp = document.querySelector('.loom-native-input'); window.__lat = null; const t = performance.now(); window.__latKey = t
          const onIn = () => { inp.removeEventListener('input', onIn); requestAnimationFrame(() => { window.__lat = performance.now() - window.__latKeyDown }) }
          inp.addEventListener('input', onIn)
          window.addEventListener('keydown', () => { window.__latKeyDown = performance.now() }, { once: true, capture: true })
          return true })()`)
        const ch = 'abcdefghij'[i % 10]
        await key(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), 0, ch)
        const v = await until(() => ev('window.__lat'), 2000, 5)
        res.push(v ?? NaN)
        await sleep(60)
      }
      await ev(`(() => { const inp = document.querySelector('.loom-native-input'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      return res
    }
    const lat0 = await composerLatency(15)
    note('claude: composer keypress → painted, ms (idle, 15 keys)', { p50: Math.round(median(lat0) * 10) / 10, max: Math.round(Math.max(...lat0)) })

    // Streaming: a long reply, CPU over the turn, the composer typed into meanwhile.
    const streamRuns = []
    let latStream = []
    for (let i = 0; i < 3; i++) {
      await idle()
      await say(`Write ${40 + i} numbered lines of plain text, one short sentence each, about rivers. No tools, no headings.`)
      const started = await until(async () => { const w = (await loom())?.wrapper; return (w?.phase === 'working' || w?.live) && w }, 30_000, 50)
      const load = machineLoad()
      const a = snap(child.pid)
      const ta = Date.now()
      if (i === 0) latStream = await composerLatency(12)
      let prof = null
      if (i === 1 && flags.has('profile')) {
        await app.send('Profiler.enable')
        await app.send('Profiler.start')
        await sleep(4000)
        prof = (await app.send('Profiler.stop')).result.profile
      }
      await idle()
      const secs = (Date.now() - ta) / 1000
      const b = snap(child.pid)
      streamRuns.push({ ...cpuBetween(a, b, secs), secs: Math.round(secs * 10) / 10, load, started: !!started })
      if (prof) {
        const self = new Map()
        const dt = prof.timeDeltas
        const byId = new Map(prof.nodes.map((n) => [n.id, n]))
        for (let k = 0; k < prof.samples.length; k++) {
          const n = byId.get(prof.samples[k])
          const f = n.callFrame
          const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`
          self.set(name, (self.get(name) ?? 0) + (dt[k] ?? 0) / 1000)
        }
        console.log('   renderer self time over 4 s of streaming (ms):')
        for (const [k, v] of [...self.entries()].sort((x, y) => y[1] - x[1]).slice(0, 18)) console.log(`   ${v.toFixed(1).padStart(8)}  ${k}`)
      }
    }
    note('claude: CPU % while a long reply streams (3 turns)', { runs: streamRuns, median: median(streamRuns.map((r) => r.total)), renderer: median(streamRuns.map((r) => r.renderer)), main: median(streamRuns.map((r) => r.main)) })
    note('claude: composer keypress → painted, ms (while streaming, 12 keys)', { p50: Math.round(median(latStream) * 10) / 10, max: Math.round(Math.max(...latStream)) })

    // The real permission round trip: Claude Code's own dialog drawn (on its hidden screen) → Ember's card.
    await idle()
    const PF = join(CWD, 'probe-perf.txt')
    rmSync(PF, { force: true })
    await ev(`(() => { const tab = ${JSON.stringify(tab.tab)}; const r = (window.__perm = { dialog: 0, card: 0 })
      const tick = () => { const l = window.__ember.loom(tab)
        if (!r.dialog && l.rows.some((x) => /Do you want to/i.test(x))) r.dialog = Date.now()
        if (!r.card && document.querySelector('.loom-ask-card button[data-a="yes"]')) r.card = Date.now()
        if (!(r.dialog && r.card)) requestAnimationFrame(tick) }
      requestAnimationFrame(tick); return true })()`)
    await say('Use the Bash tool to run exactly this command and nothing else: echo hi > probe-perf.txt')
    const perm = await until(async () => { const r = await ev('window.__perm'); return r.dialog && r.card && r }, 90_000, 100)
    note('claude: permission — TUI dialog drawn → Ember card shown, ms (+ = card later)', perm ? perm.card - perm.dialog : 'no card')
    await ev(`document.querySelector('.loom-ask-card button[data-a="no"]')?.click()`)
    await idle()
    rmSync(PF, { force: true })

    // A plain shell's echo, for comparison: keydown → onWriteParsed with the character.
    const shellTab = await ev('window.__ember.newTab()')
    await ev(`window.__ember.activate(${JSON.stringify(shellTab)})`)
    await until(async () => (await ev(`window.__ember.sessions()`)).find((s) => s.id === shellTab || true) && (await ev(`window.__ember.loom(${JSON.stringify(shellTab)})`))?.rows?.some((r) => PROMPT.test(r)), 20_000)
    const sid = await ev(`window.__ember.groups().find((g) => g.id === ${JSON.stringify(shellTab)}).panes[0]`)
    await ev(`window.__ember.term(${JSON.stringify(sid)}).focus()`)
    await sleep(500)
    const shellLat = []
    for (let i = 0; i < 15; i++) {
      await ev(`(() => { const t = window.__ember.term(${JSON.stringify(sid)}); window.__sl = null
        window.addEventListener('keydown', () => { const k = performance.now(); const d = t.onWriteParsed(() => { d.dispose(); window.__sl = performance.now() - k }) }, { once: true, capture: true }); return true })()`)
      const ch = 'qwertyuiop'[i % 10]
      await key(ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0), 0, ch)
      shellLat.push((await until(() => ev('window.__sl'), 2000, 5)) ?? NaN)
      await sleep(60)
    }
    note('shell: keypress → echo parsed, ms (idle, 15 keys)', { p50: Math.round(median(shellLat) * 10) / 10, max: Math.round(Math.max(...shellLat)) })
    await ev(`window.__ember.closeTab(${JSON.stringify(shellTab)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab.tab)})`)
  }

  // ---------------------------------------------------------------- hooks, without a model
  if (ONLY.has('hooks')) {
    // The bridge's address and token, read the way any shell in a tab has them.
    const sh = await ev('window.__ember.newTab()')
    await until(async () => (await ev(`window.__ember.loom(${JSON.stringify(sh)})`))?.rows?.some((r) => PROMPT.test(r)), 20_000)
    const shSid = await ev(`window.__ember.groups().find((g) => g.id === ${JSON.stringify(sh)}).panes[0]`)
    await ev(`window.ember.write(${JSON.stringify(shSid)}, 'echo "ENV|$env:EMBER_BRIDGE_URL|$env:EMBER_BRIDGE_TOKEN|$env:EMBER_SETTINGS|"' + '\\r')`)
    const envRow = await until(async () => (await ev(`window.__ember.loom(${JSON.stringify(sh)})`))?.rows?.find((r) => /^ENV\|http/.test(r.trim())), 10_000)
    const [, url, token, settings] = envRow.trim().split('|')
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const hookOf = (event) => cfg.hooks[event][0].hooks.find((h) => h.type === 'http' || /ember-hook/.test(h.command ?? ''))
    const envFor = (tabId) => ({ ...process.env, EMBER_BRIDGE_URL: url, EMBER_BRIDGE_TOKEN: token, EMBER_TAB_ID: tabId })
    /** Run a hook as Claude Code would: its command with the input on stdin, or its http POST. */
    function runHook(h, tabId, input) {
      const t0 = Date.now()
      if (h.type === 'http') {
        const env = envFor(tabId)
        const headers = { 'content-type': 'application/json' }
        for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_m, n) => ((h.allowedEnvVars ?? []).includes(n) ? env[n] ?? '' : ''))
        const ac = new AbortController()
        const done = fetch(h.url, { method: 'POST', headers, body: JSON.stringify(input), signal: ac.signal }).then((r) => r.text()).catch(() => '').then(() => Date.now() - t0)
        return { t0, done, stop: () => ac.abort() }
      }
      const p = spawn('cmd.exe', ['/d', '/s', '/c', `"${h.command}"`], { env: envFor(tabId), stdio: ['pipe', 'pipe', 'ignore'], windowsVerbatimArguments: true })
      p.stdin.end(JSON.stringify(input))
      const done = new Promise((r) => p.on('exit', () => r(Date.now() - t0)))
      return { t0, done, stop: () => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} } }
    }
    await ev(`(() => { window.__hk = {}; window.ember.hooks.onEvent((e) => { const m = e.input && e.input.message; if (m) window.__hk[m] = Date.now() }); return true })()`)
    const asyncRuns = [], exitRuns = []
    const nh = hookOf('Notification')
    for (let i = 0; i < 7; i++) {
      const m = `perf-${i}-${Date.now()}`
      const r = runHook(nh, sh, { hook_event_name: 'Notification', session_id: '', message: m })
      exitRuns.push(await r.done)
      const at = await until(async () => (await ev(`window.__hk[${JSON.stringify(m)}]`)) || 0, 5000, 5)
      asyncRuns.push(at ? at - r.t0 : NaN)
      await sleep(200)
    }
    note(`hooks (${nh.type}): async event start → in renderer, ms (7)`, { runs: asyncRuns, median: median(asyncRuns) })
    note(`hooks (${nh.type}): async event start → hook done, ms (7)`, { runs: exitRuns, median: median(exitRuns) })
    const ph = hookOf('PermissionRequest')
    const cardRuns = []
    for (let i = 0; i < 7; i++) {
      const r = runHook(ph, tab.tab, { hook_event_name: 'PermissionRequest', session_id: '', tool_name: 'Bash', tool_input: { command: `echo synthetic-${i}` } })
      const shown = await until(async () => (await ev(`!!document.querySelector('.loom-ask-card button[data-a="yes"]')`)) && Date.now(), 10_000, 2)
      cardRuns.push(shown ? shown - r.t0 : NaN)
      r.stop()
      await until(async () => !(await ev(`!!document.querySelector('.loom-ask-card')`)), 5000, 20)
      await sleep(300)
    }
    note(`hooks (${ph.type}): PermissionRequest start → card shown, ms (7)`, { runs: cardRuns, median: median(cardRuns) })
    await ev(`window.__ember.closeTab(${JSON.stringify(sh)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab.tab)})`)
  }

  // ---------------------------------------------------------------- memory, 1 vs 4 tabs
  const heap = async () => {
    const m = (await app.send('Performance.getMetrics')).result?.metrics ?? []
    return Math.round((m.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0) / 1e6)
  }
  if (ONLY.has('mem')) {
    await app.send('Performance.enable')
    await app.send('HeapProfiler.collectGarbage')
    await sleep(3000)
    const one = { ...ram(snap(child.pid)), heap: await heap() }
    const more = []
    for (let i = 0; i < 3; i++) more.push(await claudeTab(false))
    await sleep(6000)
    await app.send('HeapProfiler.collectGarbage')
    await sleep(2000)
    const four = { ...ram(snap(child.pid)), heap: await heap() }
    note('mem: Ember MB with 1 Claude canvas tab', one)
    note('mem: Ember MB with 4 Claude canvas tabs', four)
    note('mem: per extra tab, MB (renderer / total / JS heap)', { renderer: Math.round((four.renderer - one.renderer) / 3), total: Math.round((four.total - one.total) / 3), heap: Math.round((four.heap - one.heap) / 3) })
    for (const t of more) await ev(`window.__ember.closeTab(${JSON.stringify(t.tab)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab.tab)})`)
  }

  // ---------------------------------------------------------------- 30 diagrams
  if (ONLY.has('frames')) {
    await app.send('Performance.enable')
    const ftab = await ev(`window.__ember.newLoom(${JSON.stringify(CWD)})`)
    await ev(`window.__ember.activate(${JSON.stringify(ftab)})`)
    await sleep(3000)
    await app.send('HeapProfiler.collectGarbage')
    await sleep(1500)
    const before = { ...ram(snap(child.pid)), heap: await heap() }
    // A made-up conversation: 30 turns, each a question and an answer with a mermaid diagram.
    const lines = []
    const sid = 'perf-frames'
    let t = Date.now() - 3600_000
    for (let i = 0; i < 30; i++) {
      const u = `u${i}`, a = `a${i}`
      lines.push({ type: 'user', uuid: u, sessionId: sid, timestamp: new Date((t += 1000)).toISOString(), message: { role: 'user', content: `Question ${i}: how does part ${i} connect?` } })
      const graph = `graph LR\n  A${i}[Client ${i}] --> B${i}[API]\n  B${i} --> C${i}[(DB ${i})]\n  B${i} --> D${i}[Cache]\n  D${i} --> E${i}[Worker ${i}]`
      lines.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId: sid, timestamp: new Date((t += 1000)).toISOString(), message: { role: 'assistant', id: `m${i}`, content: [{ type: 'text', text: `Part ${i} works like this.\n\n\`\`\`mermaid\n${graph}\n\`\`\`\n\nThat is the whole of part ${i}. ${'More words about it. '.repeat(20)}` }] } })
    }
    await ev(`window.__ember.loomFeed(${JSON.stringify(ftab)}, ${JSON.stringify(lines)})`)
    // Shown as Claude mode shows it (no model here): the canvas on, at the height layout() gives it.
    await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom[data-tab-id="${ftab}"] { display: block !important; height: 640px !important; }'; document.head.appendChild(st); return true })()`)
    // Every turn is shown once (the rail walks them), as reading back through it would.
    const turns = (await ev(`window.__ember.loom(${JSON.stringify(ftab)})`)).turns
    await sleep(8000)
    const frames = async () => ev(`document.querySelectorAll('.is-active iframe, iframe').length`)
    const live = async () => ev(`[...document.querySelectorAll('iframe')].filter((f) => f.isConnected && f.src && f.src !== 'about:blank').length`)
    await app.send('HeapProfiler.collectGarbage')
    await sleep(1500)
    const after = { ...ram(snap(child.pid)), heap: await heap(), iframes: await frames(), live: await live(), turns }
    const a = snap(child.pid)
    await sleep(8000)
    const b = snap(child.pid)
    note('frames: Ember MB, empty canvas tab', before)
    note('frames: Ember MB, 30 diagrams fed', after)
    note('frames: CPU % at rest with 30 diagrams (8 s)', cpuBetween(a, b, 8))
    // Read back through the whole conversation, a turn at a time (the rail), and back to now.
    const walk = await ev(`(async () => {
      const dots = () => [...document.querySelectorAll('.loom[data-tab-id="${ftab}"] .loom-rail .loom-dot')]
      const gaps = []; let last = performance.now(); let on = true
      const f = () => { const n = performance.now(); gaps.push(n - last); last = n; if (on) requestAnimationFrame(f) }
      requestAnimationFrame(f)
      const n = dots().length
      for (let i = 0; i < n; i++) { dots()[i]?.click(); await new Promise((r) => setTimeout(r, 120)) }
      on = false
      gaps.sort((x, y) => x - y)
      return { turns: n, frames: gaps.length, p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0), worst: Math.round(gaps.at(-1) ?? 0) }
    })()`)
    note('frames: stepping through every turn (120 ms each)', walk)
    await sleep(3000)
    await app.send('HeapProfiler.collectGarbage')
    await sleep(1500)
    note('frames: Ember MB just after reading back through them all', { ...ram(snap(child.pid)), heap: await heap(), live: await live() })
    await sleep(12_000)
    await app.send('HeapProfiler.collectGarbage')
    await sleep(1500)
    note('frames: Ember MB 15 s after', { ...ram(snap(child.pid)), heap: await heap(), live: await live() })
    await ev(`window.__ember.closeTab(${JSON.stringify(ftab)})`)
  }
  if (ONLY.has('frames') && !ONLY.has('claude')) { kill(); process.exit(0) }

  note('machine load now, %', machineLoad())
  kill()
}
writeFileSync(join(process.env.TEMP ?? '.', `probe-perf-${Date.now()}.json`), JSON.stringify(out, null, 2))
process.exit(0)
