/**
 * Contact sheet of every mascot pose.
 *
 * The sprite is the only thing on a card that says what the session is doing, so the
 * poses have to be distinguishable at a glance and at 38px. This lays each state out
 * across a few moments of its animation, at card size and blown up, so they can be
 * compared side by side instead of by catching them one at a time in a live session.
 */
import { mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PORT = 9343
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
for (let i = 0; i < 40; i++) {
  await sleep(500)
  if (await evaluate(`!!window.__ember?.mascot`)) break
}

const built = await evaluate(`(() => {
  const rows = [
    ['working', null, 'working'],
    ['idle', null, 'idle / bored'],
    ['idle', null, 'idle / dozing'],
    ['attention', 'question', 'needs you'],
    ['attention', 'handoff', 'your turn'],
    ['exited', null, 'exited'],
  ]
  // Sample times chosen to catch each pose mid-cycle; the dozing row is sampled deep
  // into the doze phase, which is the same 'idle' state a few seconds later.
  const times = [[0, 0.22, 0.45, 0.7], [0, 0.9, 1.8, 2.7], [8.2, 8.6, 9.0, 9.4], [0, 0.2, 0.4, 0.6], [0, 0.25, 0.5, 0.75], [0, 1, 2, 3]]

  const wrap = document.createElement('div')
  wrap.id = 'mascot-sheet'
  wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#150c22;color:#D9D2EA;font:13px system-ui;padding:24px;overflow:auto'
  for (const [i, [state, attention, label]] of rows.entries()) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:22px;margin-bottom:14px'
    const name = document.createElement('div')
    name.style.cssText = 'width:120px;opacity:0.75'
    name.textContent = label
    row.appendChild(name)
    for (const t of times[i]) {
      for (const size of [38, 96]) {
        const img = document.createElement('img')
        img.src = window.__ember.mascot(state, attention, t, size)
        img.style.cssText = 'image-rendering:pixelated;width:' + size + 'px'
        row.appendChild(img)
      }
    }
    wrap.appendChild(row)
  }
  document.body.appendChild(wrap)
  return rows.length
})()`)

console.log(`rendered ${built} states`)
await sleep(600)
await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = `${process.env.TEMP}\\ember-mascot-sheet.png`
;(await import('node:fs')).writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
console.log('contact sheet ->', file)

ws.close()
child.kill()
process.exit(0)
