/**
 * Checks the fixes from the feedback round: cards actually reorder when dragged,
 * Claude detection survives the title changing to a task name, no ripple remains,
 * and no card motion is horizontal.
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
const PORT = 9342
const STATE = join(EMBER_HOME, 'state.json')
if (existsSync(STATE)) rmSync(STATE)

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

// ---- claude detection latches through a task-title change ----
await ev(`window.__ember.type("$Host.UI.RawUI.WindowTitle = [char]0x2733 + ' Claude Code'\\r")`)
await sleep(2000)
const announced = await ev(`window.__ember.sessions()[0].activity.isClaude`)
check('detects Claude from its announced title', announced === true)

await ev(`window.__ember.type("$Host.UI.RawUI.WindowTitle = 'Generate long report'\\r")`)
await sleep(2200)
const latched = await ev(`({
  isClaude: window.__ember.sessions()[0].activity.isClaude,
  raw: window.__ember.sessions()[0].rawTitle,
  mascot: document.querySelector('.ember-card').classList.contains('is-claude'),
})`)
check('stays Claude when the title becomes a task name', latched.isClaude === true && latched.mascot === true, JSON.stringify(latched))

// Restoring a shell-looking title must release the latch.
await ev(`window.__ember.type("$Host.UI.RawUI.WindowTitle = 'C:\\\\Windows\\\\System32\\\\pwsh.exe'\\r")`)
await sleep(2200)
const released = await ev(`window.__ember.sessions()[0].activity.isClaude`)
check('releases the latch when the shell takes the title back', released === false, String(released))

// ---- drag reorder ----
await ev(`document.querySelector('.ember-newtab').click()`)
await sleep(2600)
const before = await ev(`window.__ember.groups().map(g => g.id)`)

const drag = await ev(`(async () => {
  const cards = [...document.querySelectorAll('.ember-card')]
  const first = cards[0]
  const r = first.getBoundingClientRect()
  const step = r.height + 6
  first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: r.top + 10 }))
  await new Promise(res => setTimeout(res, 60))
  first.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: r.top + 10 + step }))
  await new Promise(res => setTimeout(res, 120))
  first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: r.top + 10 + step }))
  await new Promise(res => setTimeout(res, 200))
  return {
    orders: [...document.querySelectorAll('.ember-card')].map(c => ({ id: c.dataset.id, order: c.style.order })),
    flex: getComputedStyle(document.querySelector('.ember-cards')).flexDirection,
  }
})()`)
await sleep(600)
const after = await ev(`window.__ember.groups().map(g => g.id)`)

check('cards container is a flex column (order works at all)', drag.flex === 'column', drag.flex)
check(
  'dragging a card reorders the sessions',
  JSON.stringify(before) !== JSON.stringify(after),
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
)
check(
  'flex order reflects the new arrangement',
  drag.orders.every((o) => o.order !== ''),
  JSON.stringify(drag.orders),
)

// ---- no horizontal card motion, no tilt ----
const styles = await ev(`(() => {
  const c = document.querySelector('.ember-card')
  const cs = getComputedStyle(c)
  return { transform: cs.transform, tiltVar: cs.getPropertyValue('--tilt-x').trim() }
})()`)
check('no tilt transform on cards', !/matrix3d|perspective/.test(styles.transform) && styles.tiltVar === '', JSON.stringify(styles))

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${process.env.TEMP}\\ember-feedback.png`, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', `${process.env.TEMP}\\ember-feedback.png`)

ws.close()
child.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
