import { join, basename } from 'node:path'
/**
 * Prove the caret actually springs rather than teleports: sample head/tail spring
 * positions at ~60Hz across a long cursor jump and print the separation over time.
 * Screenshots the frame of maximum separation, which is peak trail.
 */
import { spawn } from 'node:child_process'
import { writeFileSync , mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9335
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: PROBE_ENV,
})

async function findPage() {
  for (let i = 0; i < 60; i++) {
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

// Pin focus so the caret uses its full (filled + trail) rendering path even though
// the automated window is not the OS foreground window.
await evaluate(`window.__ember.forceCursorFocus(true)`)
const sid = await evaluate(`document.querySelector('.ember-pane.is-active').dataset.sessionId`)

// Sample inside the page across the jump — one round-trip per sample would be far
// too coarse to see a 150ms spring.
const samples = await evaluate(`(async () => {
  const out = []
  const canvas = document.querySelector('.ember-cursor-layer')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  // Ground truth for "is anything actually painted": count non-transparent pixels
  // on the caret layer and measure their bounding box.
  const painted = () => {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
    for (let i = 3, p = 0; i < d.length; i += 4, p++) {
      if (d[i] === 0) continue
      n++
      const x = p % canvas.width, y = (p / canvas.width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    return { n, w: maxX - minX, h: maxY - minY }
  }

  window.ember.write(${JSON.stringify(sid)}, 'Write-Output "the quick brown fox jumps over the lazy dog and keeps on running"')
  const t0 = performance.now()
  while (performance.now() - t0 < 500) {
    await new Promise(r => requestAnimationFrame(r))
    const s = window.__ember.cursorState()
    const p = painted()
    out.push({ t: Math.round(performance.now() - t0), hx: +s.head.x.toFixed(1), tx: +s.tail.x.toFixed(1), gap: +s.gap.toFixed(1), target: +s.target.x.toFixed(1), px: p.n, boxW: p.w, boxH: p.h })
  }
  return out
})()`)

const moving = samples.filter((s) => s.gap > 0.5)
console.log('samples:', samples.length, '| frames with head/tail separation:', moving.length)
console.log('peak gap (px):', Math.max(...samples.map((s) => s.gap)).toFixed(1))
console.log('t      head     tail      gap   litPx   boxW   boxH')
for (const s of samples.filter((_, i) => i % 3 === 0).slice(0, 16)) {
  console.log(
    String(s.t).padStart(4),
    String(s.hx).padStart(9),
    String(s.tx).padStart(9),
    String(s.gap).padStart(7),
    String(s.px).padStart(7),
    String(s.boxW).padStart(6),
    String(s.boxH).padStart(6),
  )
}

// Re-run the jump and grab a frame at peak separation.
await sleep(800)
await evaluate(`window.ember.write(${JSON.stringify(sid)}, 'Write-Output "second pass for the screenshot of the trail at full stretch"')`)
await sleep(70)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = `${process.env.TEMP}\\trail-peak.png`
writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
console.log('peak-trail screenshot ->', file)
console.log('final state:', JSON.stringify(await evaluate(`window.__ember.cursorState()`)))

ws.close()
child.kill()
process.exit(0)
