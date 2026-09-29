/**
 * Computer use, exercised from inside a real Ember shell.
 *
 * What is checked: that `desk` is on PATH in an Ember shell and refuses outside one;
 * that the daemon comes up on first use and a batch drives a real app (Calculator:
 * 7 × 6 = 42) through UI Automation; that the sidebar's COMPUTER row appears and says
 * what happened; that the cursor overlay window exists and shows its Stop pill; that
 * the switch halts (daemon dead, `desk` answers HALTED, exit 3) and resumes.
 *
 *   node scripts/probe-desk.mjs            (writes overlay.png beside the probe home)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9386
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
try {
  // A halt left by an earlier run must not decide this one.
  const { rmSync } = await import('node:fs')
  rmSync(join(EMBER_HOME, 'desk.halt'), { force: true })
} catch {
  /* nothing to clear */
}

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: '1400x900' },
})
let mainLog = ''
child.stdout.on('data', (d) => (mainLog += d.toString()))
child.stderr.on('data', (d) => (mainLog += d.toString()))

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
}

async function findPage(pred) {
  for (let i = 0; i < 150; i++) {
    try {
      const p = (await targets()).find(pred)
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  return null
}

function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const errors = []
  const ready = new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id) {
      const p = pending.get(m.id)
      if (p) {
        pending.delete(m.id)
        p(m)
      }
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'exception')
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
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
  return { ws, ready, send, ev, errors }
}

const appTarget = await findPage((t) => !t.url.includes('desk-overlay') && !t.url.includes('realtime'))
if (!appTarget) throw new Error('no app window')
const app = cdp(appTarget)
await app.ready
await app.send('Runtime.enable')
for (let i = 0; i < 100; i++) {
  if (await app.ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}

async function waitForPrompt() {
  let last = -1
  let quietSince = 0
  for (let i = 0; i < 300; i++) {
    const s = (await app.ev(`window.__ember.sessions()`))[0]
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

/** Type a line into the shell and wait until the prompt is back under its output. */
async function run(sid, line, quietFor = 4) {
  const before = (await app.ev(`window.__ember.sessions()`)).find((s) => s.id === sid).bytesIn
  await app.ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(line + '\r')})`)
  const t0 = Date.now()
  let last = before
  let quiet = 0
  for (let i = 0; i < 600; i++) {
    await sleep(150)
    const s = (await app.ev(`window.__ember.sessions()`)).find((x) => x.id === sid)
    const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
    const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
    if (s.bytesIn === last) {
      quiet++
      if (quiet >= quietFor && s.bytesIn > before && prompt) return { text: s.text, ms: Date.now() - t0 }
    } else {
      quiet = 0
      last = s.bytesIn
    }
  }
  return { text: (await app.ev(`window.__ember.sessions()`)).find((x) => x.id === sid).text, ms: Date.now() - t0 }
}

const tail = (text, n = 3) => text.split('\n').filter((l) => l.trim()).slice(-n).join(' | ')
const strip = () =>
  app.ev(`(() => { const r = document.querySelector('.ember-vitals-desk'); if (!r) return null; return { shown: !r.classList.contains('is-empty'), state: r.querySelector('.is-desk-state')?.textContent, what: r.querySelector('.is-desk-what')?.textContent, sw: r.querySelector('.is-desk-switch')?.textContent } })()`)

try {
  const first = await waitForPrompt()
  const sid = first.id
  await run(sid, 'echo warm')

  // 1. On PATH, and off until used: the strip shows nothing yet.
  const status = await run(sid, 'desk status')
  check('`desk status` answers from Ember', /\boff\b|running/.test(status.text) && !/only works inside/.test(status.text), tail(status.text, 2))
  check('COMPUTER row hidden before first use', (await strip())?.shown === false, JSON.stringify(await strip()))

  // 2. First use brings the daemon up and a batch drives Calculator through UI Automation.
  const batch = await run(
    sid,
    `desk do "run calc.exe; wait Calculator; press Calculator ^Clear$; press Calculator ^Seven$; press Calculator '^Multiply by$'; press Calculator ^Six$; press Calculator ^Equals$; read Calculator 'Display is'"`,
    6
  )
  check('batch: 7 × 6 = 42 in Calculator', /Display is 42/.test(batch.text), tail(batch.text, 3))
  const st = await app.ev(`window.ember.desk.state()`)
  check('daemon reports running', st.running === true && st.ready === 'ok', `ready=${st.ready} ${st.message}`)
  const row = await strip()
  // The batch ends with a read, so that is the last thing the row names.
  check('COMPUTER row shows what happened', row?.shown && /read Calculator/.test(row.what ?? ''), JSON.stringify(row))

  // 3. The per-call floor, with the daemon warm.
  const w = await run(sid, 'desk windows')
  check('`desk windows` lists windows', /Calculator/.test(w.text), `${w.ms} ms round trip through the shell`)

  // 4. The overlay: a second window drawing the cursor, with its Stop pill showing.
  const ovTarget = await findPage((t) => t.url.includes('desk-overlay'))
  check('overlay window exists', !!ovTarget, ovTarget?.url ?? 'none')
  if (ovTarget) {
    const ov = cdp(ovTarget)
    await ov.ready
    await ov.send('Runtime.enable')
    const pill = await ov.ev(`document.getElementById('stop').className`)
    check('overlay shows the Stop pill', /show/.test(pill) && !/halted/.test(pill), pill)
    const cur = await ov.ev(`({ x: window.__desk.x, y: window.__desk.y, visible: window.__desk.visible, label: window.__desk.label })`)
    check('overlay cursor sits on the last action', cur.visible && cur.x > 0 && cur.y > 0, JSON.stringify(cur))
    // The page is transparent; without the override the capture is a white sheet.
    await ov.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 30, g: 30, b: 34, a: 1 } })
    const shot = await ov.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, cur.x - 40), y: Math.max(0, cur.y - 30), width: 360, height: 110, scale: 2 },
    })
    await ov.send('Emulation.setDefaultBackgroundColorOverride', {})
    if (shot.result?.data) writeFileSync(join(EMBER_HOME, 'overlay.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`   overlay screenshot: ${join(EMBER_HOME, 'overlay.png')}`)
    ov.ws.close()
  }

  // 5. The switch in the strip halts: daemon dead, `desk` refuses with exit 3.
  await app.ev(`document.querySelector('.ember-vitals-desk .is-desk-switch').click()`)
  await sleep(600)
  const halted = await app.ev(`window.ember.desk.state()`)
  check('STOP halts', halted.halted === true && halted.running === false, JSON.stringify(await strip()))
  const refused = await run(sid, 'desk windows; echo "exit=$LASTEXITCODE"')
  check('`desk` answers HALTED with exit 3', /HALTED/.test(refused.text) && /exit=3/.test(refused.text), tail(refused.text, 2))
  check('Calculator still open (nothing else was touched)', /Calculator/.test(w.text))

  // 6. Resume: the next command brings the daemon back.
  await app.ev(`document.querySelector('.ember-vitals-desk .is-desk-switch').click()`)
  await sleep(400)
  const back = await run(sid, 'desk do "focus Calculator; key alt+f4"', 6)
  check('RESUME: daemon returns and closes Calculator', /pressed: alt\+f4/.test(back.text), tail(back.text, 2))

  // 7. Outside an Ember shell there is no tool.
  const outside = await run(sid, `$env:EMBER_DESK_PORT=''; $env:EMBER_DESK_TOKEN=''; desk status; echo "exit=$LASTEXITCODE"`)
  check('outside Ember: `desk` refuses', /only inside an Ember shell/.test(outside.text) && /exit=2/.test(outside.text), tail(outside.text, 2))

  const errs = app.errors.filter((e) => !/Autofill|ResizeObserver/.test(e))
  check('no renderer errors', errs.length === 0, errs.slice(0, 3).join(' | '))
  const mainErrs = mainLog.split('\n').filter((l) => /error|Error/.test(l) && !/Autofill|GPU|cache/i.test(l))
  check('no main-process errors', mainErrs.length === 0, mainErrs.slice(0, 3).join(' | '))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
} finally {
  try {
    // Let the app stop its daemon on the way out rather than orphaning it.
    await app.ev(`window.ember.desk.halt()`)
    for (const s of await app.ev(`window.__ember.sessions()`)) await app.ev(`window.ember.write(${JSON.stringify(s.id)}, "\\u0003exit\\r")`)
    await sleep(500)
  } catch {
    /* gone */
  }
  child.kill()
  app.ws.close()
  process.exitCode = failures ? 1 : 0
}
