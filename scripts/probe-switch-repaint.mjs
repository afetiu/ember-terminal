import { join, basename } from 'node:path'
/**
 * Does a tab you switch back to show what the shell actually printed while you were
 * away? xterm's WebGL renderer draws only when something is damaged, on a context with
 * `preserveDrawingBuffer: false`, so a pane parked off-screen can end up composited from
 * a buffer nothing has drawn into — two screens of output legible at once.
 *
 * Three measurements: whether a backgrounded pane's canvas goes stale at all, whether
 * switching back changes it, and whether the arrived-at canvas is byte-identical to one
 * produced by an unambiguous full repaint. The first answers "no" — a pane at -60% still
 * intersects the viewport, so xterm never pauses its renderer and keeps painting while
 * hidden, which rules the intersection observer out as the mechanism. The third is the
 * property Session.repaint guarantees.
 *
 * What this cannot do is force the compositor to drop a backing buffer on cue, so it
 * passes with or without the repaint calls. It is a regression guard and a record of
 * what was ruled out, not a reproduction.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
// Start from one tab every run; a restored session from the last run changes what the
// indices below mean.
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
const PORT = 9351
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME },
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

/**
 * Wait on state, never on the clock. A cold shell behind a heavy PowerShell profile can
 * take twenty seconds to draw its first prompt, and a fixed sleep that is generous today
 * is a false failure the next time startup gets slower.
 */
async function until(label, expr, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await ev(expr)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(500)
  }
}

await send('Runtime.enable')
await until('the first prompt', `!!window.__ember && (window.__ember.sessions()[0]?.text ?? '').trim().length > 0`)

// A pane's canvas, hashed. toDataURL reads the live drawing buffer, which is the same
// surface the compositor shows — so this is the pixels, not the model that should
// have produced them.
// `.xterm-screen` holds three stacked canvases — xterm's link layer, the WebGL text
// surface, and Ember's cursor layer. Only the middle one carries the glyphs.
const HASH = `(i) => {
  const pane = document.querySelectorAll('.ember-pane')[i]
  const all = pane ? Array.from(pane.querySelectorAll('.xterm-screen canvas')) : []
  const c = all.find((x) => x.getContext('webgl2'))
  if (!c) return null
  const url = c.toDataURL()
  let h = 5381
  for (let k = 0; k < url.length; k++) h = ((h * 33) ^ url.charCodeAt(k)) >>> 0
  return { hash: h.toString(16), bytes: url.length }
}`

await ev(`window.__hash = ${HASH}`)

// Two tabs, so tab 0 goes off-screen.
await ev(`document.querySelector('.ember-newtab').click()`)
await until('the second tab', `window.__ember.groups().length >= 2`)
await until('its prompt', `(window.__ember.sessions()[1]?.text ?? '').trim().length > 0`)
const groups = await ev(`window.__ember.groups().length`)
const active = await ev(`window.__ember.activeId()`)
console.log(`groups=${groups} active=${active}`)
if (groups < 2) throw new Error('needed two groups')

console.log(
  'canvas inventory:',
  JSON.stringify(
    await ev(`Array.from(document.querySelectorAll('.ember-pane')[0].querySelectorAll('canvas')).map(c => ({
      cls: c.className, parent: c.parentElement.className, w: c.width, h: c.height,
      ctx: c.getContext('webgl2') ? 'webgl2' : '2d-or-none' }))`),
  ),
)

const before = await ev(`window.__hash(0)`)

// Print into the backgrounded tab. Enough rows that a partial paint is unmistakable.
await ev(`window.__ember.writeTo(0, "1..40 | ForEach-Object { 'BACKGROUND_ROW_' + $_ }\\r")`)
await until('the backgrounded output', `window.__ember.sessions()[0].text.includes('BACKGROUND_ROW_40')`)
// The canvas is sampled a frame later than the buffer; give the renderer its turn.
await sleep(600)

const hiddenAfterWrite = await ev(`window.__hash(0)`)
console.log(
  'session tails:',
  JSON.stringify(
    await ev(`window.__ember.sessions().map(s => ({ id: s.id, rows: s.rows, tail: s.text.split('\\n').filter(Boolean).slice(-2) }))`),
  ),
)
const bufferHasRows = await ev(
  `window.__ember.sessions()[0].text.includes('BACKGROUND_ROW_40')`,
)
console.log(`\nbackgrounded pane`)
console.log(`  buffer received the output : ${bufferHasRows}`)
console.log(`  canvas before write        : ${before?.hash}`)
console.log(`  canvas after write         : ${hiddenAfterWrite?.hash}`)
console.log(`  canvas went stale          : ${before?.hash === hiddenAfterWrite?.hash}`)

// Switch back the way a user does, and let the slide settle.
const firstId = await ev(`window.__ember.groups()[0].id`)
await ev(`document.querySelector('.ember-card[data-id="${firstId}"]').click()`)
await sleep(2500)

const afterSwitch = await ev(`window.__hash(0)`)

// The reference. Scrolling up and back damages every row twice over — the manual
// workaround that made this look self-healing, used here as ground truth for what the
// buffer should look like.
await ev(`(() => {
  const vp = document.querySelectorAll('.ember-pane')[0].querySelector('.xterm-viewport')
  vp.scrollTop -= 40
  return true
})()`)
await sleep(900)
await ev(`(() => {
  const vp = document.querySelectorAll('.ember-pane')[0].querySelector('.xterm-viewport')
  vp.scrollTop = vp.scrollHeight
  return true
})()`)
await sleep(1200)
const groundTruth = await ev(`window.__hash(0)`)

console.log(`\nafter switching back`)
console.log(`  canvas on arrival          : ${afterSwitch?.hash}`)
console.log(`  canvas after forced repaint: ${groundTruth?.hash}`)
console.log(`  changed on arrival         : ${afterSwitch?.hash !== hiddenAfterWrite?.hash}`)
console.log(`  matches a full repaint     : ${afterSwitch?.hash === groundTruth?.hash}`)

// Reported but not asserted: whether arriving *changed* the canvas depends on what the
// shell happened to leave on screen, and a pane that was already correct should not have
// to change to be right. The invariant is that what you arrive at is what a full repaint
// produces.
const pass = bufferHasRows && !!afterSwitch && afterSwitch.hash === groundTruth?.hash
console.log(`\n${pass ? 'PASS' : 'FAIL'}`)

ws.close()
child.kill()
process.exit(pass ? 0 : 1)
