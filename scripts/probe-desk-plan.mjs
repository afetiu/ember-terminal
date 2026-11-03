/**
 * Computer use, planned once and run on the machine: a whole checked sequence in one `act`.
 *
 * Drives a small test window this probe opens itself (scripts/desk-test-window.ps1, a text
 * box whose Ctrl+S opens the real Windows Save As dialog) and nothing else on the desktop.
 *
 * What is checked: one plan with name-targeted steps, waits and expects types text, opens
 * Save As, waits for it, fills the file name, saves, waits for the dialog to go and expects
 * the title to change, in one call through the bridge's /desk/act (the MCP tool's path);
 * the file exists with the text. While it runs Ember steps aside: its window is minimised,
 * the overlay's card says the current step and the app, and the overlay stays out of the
 * daemon's window list; when the work stops it comes back as it was. A plan whose expect is
 * not met fails fast with the step, the reason and the screen. A plan that worked, saved as
 * a recipe, replays with other arguments.
 *
 *   node scripts/probe-desk-plan.mjs     (screenshots beside the probe home)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9433
const TITLE = `Ember Plan Probe ${process.pid}`
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
rmSync(join(EMBER_HOME, 'desk.halt'), { force: true })
rmSync(join(EMBER_HOME, 'recipes'), { recursive: true, force: true })

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ ...cfg, hands: 'act', deskStepAside: true }, null, 2))

const fileA = join(EMBER_HOME, `plan-a-${Date.now()}.txt`)
const fileB = join(EMBER_HOME, `plan b ${Date.now()}.txt`)

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: '1200x800' },
})
// However the probe ends, its Ember goes with it (an orphan would hold the debugging port).
process.on('exit', () => child.kill())
let mainLog = ''
child.stdout.on('data', (d) => (mainLog += d.toString()))
child.stderr.on('data', (d) => (mainLog += d.toString()))

let testWin = null
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
      pending.get(m.id)?.(m)
      pending.delete(m.id)
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
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
// A plain shell of the probe's own (the default profile is PowerShell): never an agent's terminal.
await sleep(1500)
if (!(await app.ev(`window.__ember.sessions().length`))) await app.ev(`window.__ember.newTab()`)
for (let i = 0; i < 100 && !(await app.ev(`window.__ember.sessions().length`)); i++) await sleep(200)

/** The bridge and daemon addresses, read from the probe's own (plain PowerShell) shell. */
async function shellEnv(sid) {
  const mark = `ENV${Date.now()}`
  for (let i = 0; i < 200; i++) {
    // Asked again every few seconds: a shell still starting up can drop the first line.
    if (i % 30 === 0) await app.ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(`echo "${mark} $env:EMBER_BRIDGE_URL $env:EMBER_BRIDGE_TOKEN $env:EMBER_DESK_PORT $env:EMBER_DESK_TOKEN"\r`)})`)
    await sleep(150)
    const s = (await app.ev(`window.__ember.sessions()`)).find((x) => x.id === sid)
    const m = new RegExp(`${mark} (http\\S+) (\\S+) (\\d+) (\\S+)`).exec(s?.text ?? '')
    if (m) return { bridge: m[1], btoken: m[2], dport: Number(m[3]), dtoken: m[4] }
  }
  throw new Error('no bridge env in the shell')
}

let env
async function post(path, body = {}) {
  const r = await fetch(`${env.bridge}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ember-token': env.btoken }, body: JSON.stringify(body) })
  return r.json()
}
/** Straight to the daemon, as a shell's `desk` does. */
function daemon(argv) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port: env.dport })
    let data = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ argv, token: env.dtoken, tab: '' })}\n`))
    sock.on('data', (c) => {
      data += c
      if (data.endsWith('\n')) sock.end()
    })
    sock.on('close', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error(data || 'closed'))
      }
    })
    sock.on('error', reject)
  })
}
const q = (p) => `"${p.replace(/\\/g, '\\\\')}"`

try {
  const sid = (await app.ev(`window.__ember.sessions()`))[0].id
  await sleep(1500)
  env = await shellEnv(sid)
  check('bridge + daemon addresses from the shell', !!env.bridge && env.dport > 0)

  // The window this probe drives, and only it.
  testWin = spawn('powershell', ['-NoProfile', '-STA', '-File', 'scripts/desk-test-window.ps1', '-Title', TITLE], { stdio: 'ignore' })
  const up = await post('/desk/start')
  check('daemon up', up.ok && up.state?.running, JSON.stringify(up))
  const seen = await daemon(['wait', TITLE, '--timeout', '15'])
  check('test window open', seen.ok, seen.out.trim())

  const before = (await post('/desk/status')).aside
  check('Ember is on screen before', before && !before.minimized && !before.aside, JSON.stringify(before))

  // 1. One plan, start to finish, by names, with waits and expects.
  const plan = [
    `focus "${TITLE}"`,
    `settext [Edit] "Body" "Planned once, run locally."`,
    'key ctrl+s',
    'wait "Save As" 8s',
    `settext [Edit] "File name:" ${q(fileA)} in "Save As"`,
    'press [Button] "Save" in "Save As"',
    'if window "Confirm Save As" 1s then press [Button] "Yes"',
    'wait not window "Save As" 8s',
    `expect title "${basename(fileA)}" 3s`,
  ].join('\n')
  const samples = []
  let polling = true
  const poller = (async () => {
    while (polling) {
      const st = await post('/desk/status').catch(() => null)
      if (st?.aside) samples.push({ t: Date.now(), ...st.aside })
      await sleep(80)
    }
  })()
  const t0 = Date.now()
  const r = await post('/desk/act', { script: plan, save: ['save-text', fileA, 'Planned once, run locally.', basename(fileA)] })
  const planMs = Date.now() - t0
  check('plan ran in one call', r.ok, r.ok ? `${planMs} ms end to end` : r.error)
  console.log(`   ${String(r.output ?? r.error).split('\n').filter((l) => /^(waited|ok:|if |-- \d|saved)/.test(l)).join('\n   ')}`)
  check('file written with the text', existsSync(fileA) && readFileSync(fileA, 'utf8') === 'Planned once, run locally.', fileA)

  // 2. Stepping aside, seen while it ran (and in the seconds after).
  const asideSample = samples.find((s) => s.aside)
  check('Ember stepped aside (window minimised)', samples.some((s) => s.aside && s.minimized), `${samples.length} samples`)
  const withCard = samples.filter((s) => s.card?.now)
  check('card said what it was doing', withCard.length > 0, withCard.map((s) => s.card.now).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8).join(' → '))
  check('card named the app', withCard.some((s) => /Ember Plan Probe/.test(s.card.app)), asideSample?.card?.app ?? '')
  check('trail of earlier steps (≤3)', withCard.some((s) => s.card.trail.length > 0) && withCard.every((s) => s.card.trail.length <= 3))

  const w = await daemon(['windows'])
  check("overlay out of the daemon's window list", !/Ember's pointer/.test(w.out), w.out.split('\n').length + ' windows listed')

  // The card as drawn, and the real desktop with it.
  const ovTarget = await findPage((t) => t.url.includes('desk-overlay'))
  if (ovTarget) {
    const ov = cdp(ovTarget)
    await ov.ready
    const rect = await ov.ev(`(() => { const r = document.getElementById('card').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, on: document.getElementById('card').classList.contains('on'), now: document.querySelector('#card .now').textContent } })()`)
    check('overlay card visible after the plan', rect.on && rect.w > 300, JSON.stringify(rect))
    await ov.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 40, g: 44, b: 52, a: 1 } })
    const shot = await ov.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x - 24, y: rect.y - 24, width: rect.w + 48, height: rect.h + 48, scale: 2 } })
    await ov.send('Emulation.setDefaultBackgroundColorOverride', {})
    if (shot.result?.data) writeFileSync(join(EMBER_HOME, 'card.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`   card: ${join(EMBER_HOME, 'card.png')}`)
    const desk = await daemon(['shot', '--full', '--png', '--scale', '0.5', '--out', join(EMBER_HOME, 'desktop-aside.png')])
    console.log(`   desktop while aside: ${desk.ok ? join(EMBER_HOME, 'desktop-aside.png') : desk.out}`)
    ov.ws.close()
  }

  // 3. Coming back: quiet for ~4 s (no agent turn in this plain shell) and Ember is restored.
  let back = null
  for (let i = 0; i < 80; i++) {
    const st = (await post('/desk/status')).aside
    if (!st.aside) {
      back = { ...st, after: Date.now() - t0 - planMs }
      break
    }
    await sleep(100)
  }
  polling = false
  await poller
  check('Ember came back after the work stopped', back && !back.minimized, back ? `${back.after} ms after the plan returned` : 'still aside')

  // 4. A plan that cannot be met fails fast with the step, why and the screen.
  const f0 = Date.now()
  const bad = await post('/desk/act', { script: `focus "${TITLE}"; expect [Button] "Publish"; key ctrl+a` })
  const failMs = Date.now() - f0
  const err = String(bad.error ?? '')
  check('failing expect stops the plan', !bad.ok && /FAILED at step 2 of 3/.test(err), err.split('\n')[0])
  check('failure says why', /no \[Button\] 'Publish'/.test(err), err.split('\n')[1]?.trim())
  check('failure shows the screen', /-- now: /.test(err) && /#\d+ \[/.test(err))
  check('failure is fast', failMs < 2500, `${failMs} ms`)

  // 5. The recipe saved by step 1, replayed with other values.
  const list = await post('/desk/recipe', { op: 'list' })
  check('recipe saved from the plan', list.ok && /save-text/.test(list.output) && /\$1 \$2/.test(list.output), list.output ?? list.error)
  const r0 = Date.now()
  const rerun = await post('/desk/recipe', { op: 'run', name: 'save-text', args: [fileB, 'Second run, from a recipe.', basename(fileB)] })
  check('recipe replays with new arguments', rerun.ok && existsSync(fileB) && readFileSync(fileB, 'utf8') === 'Second run, from a recipe.', rerun.ok ? `${Date.now() - r0} ms` : rerun.error)

  const mainErrs = mainLog.split('\n').filter((l) => /error|Error/.test(l) && !/Autofill|GPU|cache/i.test(l))
  check('no main-process errors', mainErrs.length === 0, mainErrs.slice(0, 3).join(' | '))
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
} finally {
  // The test window goes with its process: no keys sent on the way out, so nothing else can get them.
  try {
    testWin?.kill()
  } catch {
    /* gone */
  }
  try {
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
