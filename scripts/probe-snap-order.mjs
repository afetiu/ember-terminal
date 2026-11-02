/**
 * Snapping goes where you let go, up to four per edge: a dev Ember (own EMBER_HOME), a canvas
 * fed a made-up reply with five tables through window.__ember.loomFeed (no model), and real
 * mouse drags of each table's "Drag out" to the right edge at different heights. Prints the
 * order down the edge after each drop; the fifth must not snap.
 *
 *   npm run build; node scripts/probe-snap-order.mjs [out-dir]
 *
 * Nothing is typed into any terminal. The canvas is shown by a stylesheet, as Claude mode
 * would show it, because no agent runs.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-snap-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-snap')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9393
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x900', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const table = (name) => `### ${name}\n\n| Item | State |\n|---|---|\n| ${name} one | ok |\n| ${name} two | ok |\n`
const lines = [
  { type: 'user', uuid: 'u1', timestamp: '2026-11-02T09:00:00Z', message: { role: 'user', content: 'show five tables' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-11-02T09:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(table).join('\n') }] } },
]

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })

  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev('window.__ember.newLoom()')
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(1500)
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 820px !important; } .loom-lift { opacity: 1 !important; pointer-events: auto !important; }'; document.head.appendChild(st); return true })()`)
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
  await wait(1500)

  /** The order down the right edge, by title, and the canvas box. */
  const order = () =>
    ev(`[...document.querySelectorAll('.loom-piece.is-snapped[data-snap="right"]')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((p) => (p.querySelector('.loom-piece-title')?.textContent || '?').replace(/^table\\s*/i, ''))`)
  const canvas = await ev(`(() => { const r = document.querySelector('.loom').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })()`)

  /** Drag the next inline table's "Drag out" to the right edge at a fraction of the height. */
  const dragNext = async (frac) => {
    const h = await ev(`(() => {
      const d = [...document.querySelectorAll('.loom-liftable')].find((x) => !x.closest('.loom-piece'))
      if (!d) return null
      d.scrollIntoView({ block: 'center' })
      const r = d.querySelector('.loom-lift-hint, .loom-lift').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!h) return 'none left'
    await wait(250)
    await mouse('mouseMoved', h.x, h.y, { button: 'none' })
    await mouse('mousePressed', h.x, h.y)
    const tx = canvas.right - 20
    const ty = canvas.top + (canvas.bottom - canvas.top) * frac
    for (let i = 1; i <= 24; i++) {
      await mouse('mouseMoved', h.x + ((tx - h.x) * i) / 24, h.y + ((ty - h.y) * i) / 24, { buttons: 1 })
      await wait(16)
    }
    await wait(250)
    await mouse('mouseReleased', tx, ty)
    await wait(700)
    return 'dropped'
  }

  const log = []
  for (const [i, frac] of [[1, 0.5], [2, 0.12], [3, 0.92], [4, 0.36], [5, 0.6]]) {
    await dragNext(frac)
    log.push(`drop ${i} at ${Math.round(frac * 100)}% of the height -> right edge, top to bottom: ${JSON.stringify(await order())}`)
    await shot(`drop-${i}`)
  }
  log.push(`floating (not snapped): ${await ev(`document.querySelectorAll('.loom-piece.is-pinned:not(.is-snapped), .loom-piece:not(.is-snapped)[style*="left"]').length`)}`)
  console.log(log.join('\n'))
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
