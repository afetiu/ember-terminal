import { join, basename } from 'node:path'
/**
 * Verifies the split layout and the command palette end to end: creates a split,
 * checks both panes got sane grids, drags the divider with real mouse events and
 * confirms the pty was resized, then exercises the palette's fuzzy matching.
 */
import { spawn } from 'node:child_process'
import { writeFileSync , mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9339
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
await sleep(3000)
await evaluate(`window.ember.window.toggleMaximize()`)
await sleep(2200)

console.log('--- split ---')
await evaluate(`window.__ember.split('row')`)
await sleep(2600)

const afterSplit = await evaluate(`({
  groups: window.__ember.groups(),
  dividers: document.querySelectorAll('.ember-divider').length,
  slots: document.querySelectorAll('.ember-slot').length,
  sessions: window.__ember.sessions().map(s => ({ id: s.id, cols: s.cols, rows: s.rows, w: s.paneW })),
})`)
console.log(JSON.stringify(afterSplit, null, 2))

// Drag the seam with real input events so pointer capture is exercised.
const box = await evaluate(`(() => {
  const d = document.querySelector('.ember-divider').getBoundingClientRect()
  return { x: d.x + d.width / 2, y: d.y + d.height / 2 }
})()`)
console.log('\n--- dragging divider from', JSON.stringify(box), '---')

const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })

await mouse('mousePressed', box.x, box.y)
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved', box.x + i * 40, box.y)
  await sleep(30)
}
await mouse('mouseReleased', box.x + 320, box.y)
await sleep(1200)

const afterDrag = await evaluate(`window.__ember.sessions().map(s => ({ id: s.id, cols: s.cols, w: s.paneW }))`)
console.log(JSON.stringify(afterDrag, null, 2))

const before = afterSplit.sessions
const grew = afterDrag[0].cols > before[0].cols && afterDrag[1].cols < before[1].cols
console.log(`left pane grew and right shrank: ${grew}`)

console.log('\n--- palette ---')
await evaluate(`window.__ember.openPalette()`)
await sleep(500)
await evaluate(`(() => {
  const i = document.querySelector('.ember-palette-input')
  i.value = 'spd'
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(400)
const palette = await evaluate(`({
  open: document.querySelector('.ember-palette').classList.contains('is-open'),
  rows: Array.from(document.querySelectorAll('.ember-palette-row')).map(r => r.querySelector('.ember-palette-title').textContent),
  cursor: document.querySelector('.ember-palette-row.is-cursor')?.querySelector('.ember-palette-title')?.textContent ?? null,
})`)
console.log(JSON.stringify(palette, null, 2))

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${process.env.TEMP}\\ember-features.png`, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', `${process.env.TEMP}\\ember-features.png`)

ws.close()
child.kill()
process.exit(0)
