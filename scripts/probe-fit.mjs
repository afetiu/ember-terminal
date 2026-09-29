import { join, basename } from 'node:path'
/**
 * Why is the bottom row clipped? Measures the real geometry rather than nudging
 * padding: pane box, xterm element box, screen box, cell size, and what the pty was
 * actually told — then fills the screen with a numbered ruler so the last row is
 * identifiable in a screenshot.
 */
import { spawn } from 'node:child_process'
import { writeFileSync , mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9338
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
await sleep(2500)

const sid = await evaluate(`document.querySelector('.ember-pane.is-active').dataset.sessionId`)

const geom = await evaluate(`(() => {
  const pane = document.querySelector('.ember-pane.is-active')
  const xterm = pane.querySelector('.xterm')
  const viewport = pane.querySelector('.xterm-viewport')
  const screen = pane.querySelector('.xterm-screen')
  const canvas = pane.querySelector('.xterm-screen canvas')
  const s = window.__ember.sessions().find(x => x.id === pane.dataset.sessionId)
  const cs = getComputedStyle(pane)
  const box = (el) => el ? { w: +el.getBoundingClientRect().width.toFixed(2), h: +el.getBoundingClientRect().height.toFixed(2), top: +el.getBoundingClientRect().top.toFixed(2), bottom: +el.getBoundingClientRect().bottom.toFixed(2) } : null
  return {
    rows: s.rows, cols: s.cols,
    stackBox: box(document.querySelector('.ember-stack')),
    paneBox: box(pane),
    panePadding: { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft },
    paneComputedHeight: cs.height,
    xtermBox: box(xterm),
    viewportBox: box(viewport),
    screenBox: box(screen),
    canvasBox: box(canvas),
    cell: window.__ember.cursorState()?.cell ?? null,
  }
})()`)

console.log(JSON.stringify(geom, null, 2))
const gridH = geom.rows * (geom.cell?.h ?? 0)
console.log(`\nrows x cellH = ${geom.rows} x ${geom.cell?.h?.toFixed(3)} = ${gridH.toFixed(2)}px`)
console.log(`screen element height       = ${geom.screenBox?.h}px`)
console.log(`xterm element height        = ${geom.xtermBox?.h}px`)
console.log(`grid bottom vs pane bottom  = ${(geom.screenBox.top + gridH).toFixed(2)} vs ${geom.paneBox.bottom}`)
console.log(`slack below last row        = ${(geom.paneBox.bottom - (geom.screenBox.top + gridH)).toFixed(2)}px`)

// Fill the viewport so the final row is unambiguous.
const ruler =
  `$h=$Host.UI.RawUI.WindowSize.Height; $w=$Host.UI.RawUI.WindowSize.Width; ` +
  `1..($h-1) | ForEach-Object { if($_ -eq ($h-1)){ ('LAST_ROW_' + $_ + '_').PadRight($w-1,'=') + 'R' } else { "row $_" } }`
await evaluate(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(ruler + '\r')})`)
await sleep(2500)

const tail = await evaluate(`(() => {
  const s = window.__ember.sessions().find(x => x.id === '${sid}')
  const lines = s.text.split('\\n')
  return { rows: s.rows, lastThree: lines.slice(-3), lineCount: lines.length }
})()`)
console.log('\nvisible buffer tail:', JSON.stringify(tail, null, 2))

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = `${process.env.TEMP}\\ember-fit.png`
writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', file)

ws.close()
child.kill()
process.exit(0)
