/**
 * Keystroke-to-echo latency, measured on a real pty.
 *
 * "It lags for two or three seconds and then everything I typed appears at once" is a
 * complaint about one number: the time between a key going down and its echo landing in
 * the buffer. This types into a live shell through the DevTools protocol and reads the
 * echo back off the terminal's own onWriteParsed, so the number includes every hop —
 * renderer key handling, IPC, ConPTY, the shell, ConPTY again, main's coalescing, IPC,
 * and xterm's parser. Nothing is mocked.
 *
 * Three scenarios, because the lag is not felt at an idle prompt:
 *
 *   idle    a quiet PowerShell prompt — the floor
 *   tui     a full-screen program repainting itself at 30fps in the *same* tab while you
 *           type into its input line, which is what typing into Claude Code while it
 *           streams looks like to the terminal
 *   flood   a firehose in another tab while you type at a prompt in this one
 *
 * Alongside the echo times it reports the things that could be eating them: long tasks
 * on the renderer's main thread, gaps between animation frames, main's event-loop delay,
 * and how long the pty spent paused for backpressure.
 *
 *   node scripts/probe-latency.mjs [--scenario=idle|tui|flood|all] [--material=none|acrylic|mica]
 *                                  [--opacity=N] [--no-webgl] [--tabs=N] [--rainbow] [--profile] [--keep]
 *
 * --tabs=N opens N more tabs first, each running a program that repaints at 4fps, so the
 * tui scenario is measured with the kind of background a day's work has.
 *
 * Config is copied from ~/.ember so the run matches the machine it is on; flags override
 * single fields for A/B runs. Launches its own Ember with an isolated EMBER_HOME.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1], m[2] ?? '1'] : [a, '1']
  }),
)
const SCENARIO = args.get('scenario') ?? 'all'
const PORT = Number(args.get('port') ?? 9361)
const PROFILE = args.has('profile')
const KEEP = args.has('keep')

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })

// ---- config: the user's own, with overrides ------------------------------------------
const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
cfg.window ??= {}
if (args.has('material')) cfg.window.material = args.get('material')
if (args.has('opacity')) cfg.window.opacity = Number(args.get('opacity'))
if (args.has('experience')) cfg.experience = args.get('experience')
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

// ---- the fake TUI ------------------------------------------------------------------------
// A full-screen program that repaints every frame and echoes what you type on its last
// line. This is the shape of an agent CLI mid-answer: the whole grid is rewritten
// continuously, and the keystroke has to make it through the same pty the repaint is
// pouring out of before its echo can appear.
const TUI = join(process.env.TEMP ?? '.', 'ember-probe-tui.ps1')
writeFileSync(
  TUI,
  [
    'param([int]$Seconds = 25, [int]$Fps = 30)',
    '$esc = [char]27',
    '$nl = [char]10',
    '[Console]::TreatControlCAsInput = $true',
    '$size = $Host.UI.RawUI.WindowSize',
    '$rows = [Math]::Max(10, $size.Height)',
    '$cols = [Math]::Max(40, $size.Width)',
    "$typed = ''",
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    '$frame = 0',
    '$out = [Console]::Out',
    '$out.Write("$esc[?1049h")',
    'while ($sw.Elapsed.TotalSeconds -lt $Seconds) {',
    '  while ([Console]::KeyAvailable) {',
    '    $k = [Console]::ReadKey($true)',
    "    if ($k.Key -eq 'Escape') { $typed = '' }",
    "    elseif ($k.Key -eq 'Backspace') { if ($typed.Length) { $typed = $typed.Substring(0, $typed.Length - 1) } }",
    '    elseif ($k.KeyChar -and -not [char]::IsControl($k.KeyChar)) { $typed += $k.KeyChar }',
    '  }',
    '  $sb = [Text.StringBuilder]::new()',
    '  [void]$sb.Append("$esc[?25l$esc[H")',
    '  for ($r = 0; $r -lt $rows - 2; $r++) {',
    '    $ch = [char](97 + (($frame + $r) % 26))',
    '    $line = ("frame {0,6} row {1,3} " -f $frame, $r) + [string]::new($ch, $cols - 26)',
    // A handful of colours, like an agent CLI. --rainbow cycles 200 of them instead, which
    // gives the glyph atlas a new entry for every letter in every colour: the worst case
    // for the WebGL renderer, and a way to see what an atlas under pressure costs.
    args.has('rainbow') ? '    $c = (($frame + $r) % 200) + 16' : '    $c = @(252, 245, 141, 110, 208, 39)[($frame + $r) % 6]',
    '    [void]$sb.Append("$esc[38;5;$($c)m$line$esc[0m$esc[K$nl")',
    '  }',
    '  [void]$sb.Append("$esc[K$nl> $typed$esc[K$esc[?25h")',
    '  $out.Write($sb.ToString())',
    '  $frame++',
    '  Start-Sleep -Milliseconds ([int](1000 / $Fps))',
    '}',
    '$out.Write("$esc[?1049l")',
    'Write-Host "[tui done after $frame frames]"',
  ].join('\r\n'),
)

const FLOOD = join(process.env.TEMP ?? '.', 'ember-probe-flood.ps1')
writeFileSync(
  FLOOD,
  ['param([int]$Lines = 400000)', "$pad = [string]::new('x', 96)", 'for ($i = 0; $i -lt $Lines; $i++) { "line $i $pad" }'].join('\r\n'),
)

// ---- launch ------------------------------------------------------------------------------
const electronArgs = ['.', `--remote-debugging-port=${PORT}`]
if (args.has('no-webgl')) electronArgs.push('--no-webgl')
const child = spawn('./node_modules/electron/dist/electron.exe', electronArgs, {
  stdio: 'ignore',
  // Inactive: the window must not take the keyboard from whoever is at the machine.
  // Keystrokes go in through the protocol, which does not need OS focus.
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: '1700x1000' },
})

async function findPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('realtime'))
      if (p) return p
    } catch {
      /* not up yet */
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
await send('Page.enable')
// The page believes it is focused even though the OS window is not, so xterm's textarea
// takes the dispatched keys and the caret logic behaves as it does for a person.
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

/** Wait for a session to exist and its shell to go quiet after the prompt lands. */
async function waitForPrompt(id) {
  let last = -1
  let quietSince = 0
  for (let i = 0; i < 300; i++) {
    const s = (await ev(`window.__ember.sessions()`)).find((x) => (id ? x.id === id : true))
    if (s && s.bytesIn > 0) {
      const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
      // A prompt glyph is the strong signal; a long quiet spell is the fallback for
      // prompts this regex has not met.
      const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
      if (s.bytesIn === last) {
        if (!quietSince) quietSince = Date.now()
        // A profile with oh-my-posh in it can sit silent for several seconds before
        // the first prompt, so the no-glyph fallback has to be patient.
        if (Date.now() - quietSince > (prompt ? 1200 : 9000)) {
          if (!prompt) console.log(`(no prompt glyph seen; last line: ${JSON.stringify(lastLine.slice(-60))})`)
          return s
        }
      } else {
        quietSince = 0
        last = s.bytesIn
      }
    }
    await sleep(150)
  }
  throw new Error('shell never settled')
}

await sleep(1500)
// Not maximised: a maximised inactive window still covers the screen. The fixed size
// (EMBER_PROBE_BOUNDS) keeps the grid comparable between runs and leaves the desktop.
const first = await waitForPrompt()
// --no-park: keep off-screen tabs in layout (the pre-parking behaviour), for A/B.
if (args.has('no-park')) await ev(`window.__ember.setParking && window.__ember.setParking(false)`)
console.log(`ember up · pane ${first.cols}x${first.rows} · material=${cfg.window.material ?? 'none'} opacity=${cfg.window.opacity ?? '?'}${args.has('no-webgl') ? ' · DOM renderer' : ''}${args.has('no-park') ? ' · parking off' : ''}`)

// ---- in-page recorder ------------------------------------------------------------------
// Installed once per session. Records what was sent, what the tail of the screen said
// after each parsed write, long tasks, and frame gaps. Everything is timestamped with
// performance.now() on the page, so the arithmetic is done in one clock.
await ev(`(() => {
  if (window.__lat) return
  const L = window.__lat = { sent: [], seen: [], long: [], gaps: [], installed: new Set() }
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) L.long.push({ at: e.startTime, dur: e.duration })
  })
  po.observe({ entryTypes: ['longtask'] })
  let last = performance.now()
  const raf = () => {
    const n = performance.now()
    if (n - last > 40) L.gaps.push({ at: n, gap: n - last })
    last = n
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)
  L.attach = (id) => {
    const s = window.__ember.session(id)
    if (!s || L.installed.has(s.id)) return s?.id ?? null
    L.installed.add(s.id)
    s.term.onData((d) => { for (const ch of d) L.sent.push({ ch, at: performance.now(), s: s.id }) })
    s.term.onWriteParsed(() => {
      const buf = s.term.buffer.active
      const rows = []
      for (let r = s.term.rows - 1; r >= 0 && rows.length < 3; r--) {
        const t = buf.getLine(buf.viewportY + r)?.translateToString(true) ?? ''
        if (t.trim()) rows.push(t)
      }
      const cur = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? ''
      L.seen.push({ at: performance.now(), s: s.id, text: cur + '\\n' + rows.join('\\n') })
    })
    return s.id
  }
  L.reset = () => { L.sent.length = 0; L.seen.length = 0; L.long.length = 0; L.gaps.length = 0 }
  L.take = () => ({ sent: L.sent, seen: L.seen, long: L.long, gaps: L.gaps })
})()`)

const ALPHA = 'thequickbrownfoxjumpsoverthelazydogandkeepsrunningfar'

async function typeText(text, gapMs) {
  for (const ch of text) {
    const code = ch.toUpperCase().charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code })
    await sleep(gapMs)
  }
}

async function pressEscape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}

function pct(sorted, p) {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/** Time each typed char to the first parsed write whose tail shows everything typed so far. */
function echoLatencies(rec, sid) {
  const sent = rec.sent.filter((x) => x.s === sid && /[a-z]/.test(x.ch))
  const seen = rec.seen.filter((x) => x.s === sid)
  const out = []
  let prefix = ''
  let j = 0
  for (const k of sent) {
    prefix += k.ch
    while (j < seen.length && (seen[j].at < k.at || !seen[j].text.includes(prefix))) j++
    if (j < seen.length) out.push(seen[j].at - k.at)
    else out.push(Infinity)
  }
  return out
}

function report(name, lat, rec, loop, ptyBefore, ptyAfter, sid) {
  const finite = lat.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  const lost = lat.length - finite.length
  const slow = finite.filter((x) => x > 250).length
  const long = rec.long
  const gaps = rec.gaps
  const p = ptyAfter[sid] ?? {}
  const pb = ptyBefore[sid] ?? {}
  console.log(`\n== ${name} ==`)
  console.log(
    `echo   p50 ${pct(finite, 50).toFixed(0)}ms  p90 ${pct(finite, 90).toFixed(0)}ms  p99 ${pct(finite, 99).toFixed(0)}ms  max ${(finite.at(-1) ?? NaN).toFixed(0)}ms` +
      `   >250ms: ${slow}/${lat.length}${lost ? `   never echoed: ${lost}` : ''}`,
  )
  console.log(
    `render long tasks ${long.length} (max ${Math.max(0, ...long.map((l) => l.dur)).toFixed(0)}ms, total ${long.reduce((a, l) => a + l.dur, 0).toFixed(0)}ms)` +
      `   frame gaps>40ms ${gaps.length} (max ${Math.max(0, ...gaps.map((g) => g.gap)).toFixed(0)}ms)`,
  )
  console.log(`main   loop delay max ${loop.max}ms  p99 ${loop.p99}ms  mean ${loop.mean}ms`)
  console.log(`pty    pauses ${(p.pauses ?? 0) - (pb.pauses ?? 0)}  paused ${(p.pausedMs ?? 0) - (pb.pausedMs ?? 0)}ms  unacked now ${p.unacked ?? 0}`)
  return { p50: pct(finite, 50), p90: pct(finite, 90), p99: pct(finite, 99), max: finite.at(-1) ?? NaN, slow, lost }
}

async function profileStart() {
  if (!PROFILE) return
  await send('Profiler.enable')
  await send('Profiler.setSamplingInterval', { interval: 500 })
  await send('Profiler.start')
}

async function profileStop(label) {
  if (!PROFILE) return
  const { result } = await send('Profiler.stop')
  const profile = result?.profile
  if (!profile) return
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const hits = new Map()
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1)
  const total = profile.samples.length || 1
  const rows = [...hits]
    .map(([id, n]) => {
      const f = byId.get(id)?.callFrame ?? {}
      return { name: `${f.functionName || '(anon)'} ${f.url ? f.url.split('/').pop() + ':' + (f.lineNumber + 1) : ''}`, pct: (n / total) * 100 }
    })
    .sort((a, b) => b.pct - a.pct)
  console.log(`\n-- renderer CPU, ${label} (self time, top 14) --`)
  for (const r of rows.slice(0, 14)) console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.name}`)
  const idle = rows.find((r) => r.name.startsWith('(idle)'))
  console.log(`  (idle ${idle ? idle.pct.toFixed(1) : '0.0'}% of samples)`)
}

const results = {}

async function scenarioIdle() {
  const sid = await ev(`window.__lat.attach()`)
  await ev(`window.__ember.session().focus()`)
  await sleep(300)
  await ev(`window.__lat.reset()`)
  const before = (await ev(`window.__ember.loopLag()`)).pty
  await profileStart()
  await typeText(ALPHA, 70)
  await sleep(600)
  const rec = await ev(`window.__lat.take()`)
  const loop = await ev(`window.__ember.loopLag()`)
  await profileStop('idle')
  await pressEscape()
  results.idle = report('idle prompt', echoLatencies(rec, sid), rec, loop, before, loop.pty, sid)
}

/**
 * Background load, the way a working day has it: N other tabs, each with a program
 * redrawing itself a few times a second, like an idle agent CLI ticking its spinner.
 * They are opened, started and left; the scenario then returns to the first tab.
 */
async function openBusyTabs(home) {
  const n = Number(args.get('tabs') ?? 0)
  if (!n) return
  for (let i = 0; i < n; i++) {
    await ev(`window.__ember.newTab()`)
    await sleep(1500)
    const s = await waitForPrompt()
    const ids = (await ev(`window.__ember.sessions()`)).map((x) => x.id)
    const id = ids.at(-1) ?? s.id
    await ev(`window.ember.write(${JSON.stringify(id)}, ${JSON.stringify(`& '${TUI}' -Seconds 120 -Fps 4
`)})`)
    await sleep(400)
  }
  await ev(`window.__ember.activate(${JSON.stringify(home)})`)
  await sleep(1200)
  console.log(`(${n} background tabs each repainting at 4fps)`)
}

async function scenarioTui() {
  const sid = await ev(`window.__lat.attach()`)
  await openBusyTabs(await ev(`window.__ember.activeTab()`))
  await ev(`window.__ember.session(${JSON.stringify(sid)}).focus()`)
  await ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(`& '${TUI}' -Seconds 28 -Fps 30\r`)})`)
  // Let the program take the screen and settle into its repaint rhythm.
  await sleep(3000)
  await ev(`window.__lat.reset()`)
  const before = (await ev(`window.__ember.loopLag()`)).pty
  await profileStart()
  await typeText(ALPHA, 70)
  await sleep(1200)
  const rec = await ev(`window.__lat.take()`)
  const loop = await ev(`window.__ember.loopLag()`)
  await profileStop('tui')
  results.tui = report('typing into a repainting TUI (same tab)', echoLatencies(rec, sid), rec, loop, before, loop.pty, sid)
  // Wait it out rather than interrupting: Ctrl+C is swallowed by TreatControlCAsInput.
  await sleep(26_000)
  await waitForPrompt(sid)
}

async function scenarioFlood() {
  const sid = await ev(`window.__lat.attach()`)
  const home = await ev(`window.__ember.activeTab()`)
  await ev(`window.__ember.newTab()`)
  await sleep(1500)
  const otherIds = (await ev(`window.__ember.sessions()`)).map((s) => s.id).filter((id) => id !== sid)
  const floodId = otherIds.at(-1)
  await waitForPrompt(floodId)
  await ev(`window.ember.write(${JSON.stringify(floodId)}, ${JSON.stringify(`& '${FLOOD}'\r`)})`)
  await sleep(800)
  await ev(`window.__ember.activate(${JSON.stringify(home)})`)
  await sleep(900)
  await ev(`window.__ember.session(${JSON.stringify(sid)}).focus()`)
  await sleep(200)
  await ev(`window.__lat.reset()`)
  const before = (await ev(`window.__ember.loopLag()`)).pty
  await profileStart()
  await typeText(ALPHA, 70)
  await sleep(800)
  const rec = await ev(`window.__lat.take()`)
  const loop = await ev(`window.__ember.loopLag()`)
  await profileStop('flood')
  await pressEscape()
  results.flood = report('typing at a prompt while another tab floods', echoLatencies(rec, sid), rec, loop, before, loop.pty, sid)
  const fp = loop.pty[floodId]
  if (fp) console.log(`       (flooding tab: pauses ${fp.pauses}, paused ${fp.pausedMs}ms)`)
  await ev(`window.ember.write(${JSON.stringify(floodId)}, "\\u0003")`)
  await sleep(1500)
}

try {
  if (SCENARIO === 'all' || SCENARIO === 'idle') await scenarioIdle()
  if (SCENARIO === 'all' || SCENARIO === 'tui') await scenarioTui()
  if (SCENARIO === 'all' || SCENARIO === 'flood') await scenarioFlood()
  console.log('\nsummary (ms):', JSON.stringify(results))
} finally {
  if (!KEEP) {
    try {
      for (const s of await ev(`window.__ember.sessions()`)) await ev(`window.ember.write(${JSON.stringify(s.id)}, "\\u0003exit\\r")`)
      await sleep(600)
    } catch {
      /* already gone */
    }
    child.kill()
  }
  ws.close()
}
