/**
 * Checks the feedback round: focus lands in the terminal after a switch, a good card
 * title survives ConPTY resetting the console title to the exe path, and measures how
 * long the slide actually takes.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync , mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join , basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9345
const STATE = join(EMBER_HOME, 'state.json')
if (existsSync(STATE)) rmSync(STATE, { force: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: PROBE_ENV,
})

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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
await sleep(3500)
await send('Page.bringToFront')

// ---- title survives ConPTY resetting the console title ----
await ev(`window.__ember.type("$Host.UI.RawUI.WindowTitle = 'my-session'\\r")`)
await sleep(1800)
const named = await ev(`document.querySelector('.ember-card-title').textContent`)
check('card follows the shell title', named === 'my-session', String(named))

await ev(`window.__ember.type("$Host.UI.RawUI.WindowTitle = 'C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe'\\r")`)
await sleep(2000)
const kept = await ev(`({ card: document.querySelector('.ember-card-title').textContent, raw: window.__ember.sessions()[0].rawTitle })`)
check('exe-path title does not clobber the card', kept.card === 'my-session', JSON.stringify(kept))

// ---- focus lands in the terminal after a switch ----
await ev(`document.querySelector('.ember-newtab').click()`)
await sleep(2600)
await ev(`document.querySelectorAll('.ember-card')[0].click()`)
await sleep(900)

const focusState = await ev(`(() => {
  const ae = document.activeElement
  const pane = ae && ae.closest ? ae.closest('.ember-pane') : null
  const activeGroup = document.querySelector('.ember-group.is-active')
  return {
    tag: ae ? ae.tagName : null,
    insidePane: !!pane,
    insideActiveGroup: !!(pane && activeGroup && activeGroup.contains(pane)),
  }
})()`)
check(
  'focus is in the active pane after switching',
  focusState.tag === 'TEXTAREA' && focusState.insideActiveGroup,
  JSON.stringify(focusState),
)

// Typing straight after a switch must reach the shell with no extra click.
await ev(`window.__ember.type("'TYPED_AFTER_SWITCH'\\r")`)
await sleep(1800)
const typed = await ev(`window.__ember.sessions().some(s => /TYPED_AFTER_SWITCH/.test(s.text))`)
check('typing immediately after a switch reaches the shell', typed === true)

// ---- how long is the slide, really ----
const timing = await ev(`(async () => {
  const cards = document.querySelectorAll('.ember-card')
  const read = () => {
    const el = document.querySelector('.ember-group.is-active')
    const m = /matrix3d\\(([^)]+)\\)|matrix\\(([^)]+)\\)/.exec(getComputedStyle(el).transform)
    if (!m) return 0
    const parts = (m[1] || m[2]).split(',').map(Number)
    return Math.abs(m[1] ? parts[13] : parts[5])
  }
  cards[1].click()
  const t0 = performance.now()
  let first = 0
  const samples = []
  while (performance.now() - t0 < 900) {
    await new Promise(r => requestAnimationFrame(r))
    const px = read()
    if (!first) first = px
    samples.push({ t: Math.round(performance.now() - t0), px: +px.toFixed(1) })
  }
  const peak = Math.max(...samples.map(s => s.px))
  const at = (frac) => (samples.find(s => s.px <= peak * frac) || {}).t ?? null
  return { peak: +peak.toFixed(1), t90: at(0.10), t99: at(0.01), settled: (samples.find(s => s.px === 0) || {}).t ?? null }
})()`)
console.log('\nslide timing:', JSON.stringify(timing))
check('slide settles under 600ms', timing.settled !== null && timing.settled < 600, `settled at ${timing.settled}ms`)

// The switch must be strictly vertical: no x translation, and no scale (a scale moves
// the pane's edges sideways, which reads as horizontal motion even with tx = 0).
const axis = await ev(`(async () => {
  const cards = document.querySelectorAll('.ember-card')
  let maxTx = 0, minScaleX = 1, maxOvershoot = 0, startSign = 0
  cards[0].click()
  const t0 = performance.now()
  while (performance.now() - t0 < 700) {
    await new Promise(r => requestAnimationFrame(r))
    for (const el of document.querySelectorAll('.ember-group')) {
      const m = /matrix3d\\(([^)]+)\\)|matrix\\(([^)]+)\\)/.exec(getComputedStyle(el).transform)
      if (!m) continue
      const p = (m[1] || m[2]).split(',').map(Number)
      const tx = m[1] ? p[12] : p[4]
      const sx = m[1] ? p[0] : p[0]
      const ty = m[1] ? p[13] : p[5]
      maxTx = Math.max(maxTx, Math.abs(tx))
      minScaleX = Math.min(minScaleX, sx)
      // Overshoot means crossing rest to the *opposite* side of where it started, so
      // compare against the incoming pane's initial sign rather than raw magnitude.
      if (el.classList.contains('is-active')) {
        if (startSign === 0 && Math.abs(ty) > 1) startSign = Math.sign(ty)
        if (startSign !== 0 && Math.sign(ty) === -startSign) maxOvershoot = Math.max(maxOvershoot, Math.abs(ty))
      }
    }
  }
  return { maxTx: +maxTx.toFixed(2), minScaleX: +minScaleX.toFixed(4), maxOvershoot: +maxOvershoot.toFixed(2) }
})()`)
console.log('axis check:', JSON.stringify(axis))
check('no horizontal translation during a switch', axis.maxTx === 0, `max |tx| = ${axis.maxTx}px`)
check('no scaling during a switch', axis.minScaleX === 1, `min scaleX = ${axis.minScaleX}`)
check('no overshoot past the resting position', axis.maxOvershoot <= 1, `max overshoot = ${axis.maxOvershoot}px`)

writeFileSync(
  `${process.env.TEMP}\\ember-focus-title.png`,
  Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'),
)

ws.close()
child.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
