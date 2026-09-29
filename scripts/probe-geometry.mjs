/**
 * Does anything scroll the stage?
 *
 * A tab seen "stuck" 60% up, content cut off, with its springs at rest and the
 * watchdog silent, is a tab whose ancestor scrolled. The stage is overflow: hidden,
 * which a focus() can still scroll. The suspect is a panel document focusing an input
 * while its tab is parked off-stage: the host scrolls the webview into view.
 *
 * Active window (focus must be real), a shell A on stage, a shell B parked, a panel
 * pushed into B that focuses an input, then every scrolled element in the document is
 * listed, before and after switching to B.
 *
 *   node scripts/probe-scroll.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9387
const OUT = join(process.env.TEMP ?? '.', 'ember-shots')
mkdirSync(OUT, { recursive: true })
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
writeFileSync(join(NOTES, 'Todo.md'), '- [ ] An item\n- [ ] Another one\n')
const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES },
})

async function findPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('realtime'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error('no devtools target')
}
const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
const consoleLines = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) {
    consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
  }
  if (m.method === 'Runtime.exceptionThrown') consoleLines.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? '').slice(0, 300))
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
await send('Runtime.enable')
await send('Page.enable')
for (let i = 0; i < 100; i++) {
  if (await ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}
await sleep(1500)
await ev(`window.ember.window.toggleMaximize()`)
await sleep(4000)

const state = (label) =>
  ev(`(() => {
    const scrolled = [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0 || e.scrollLeft > 0).map((e) => e.className + ':' + e.scrollTop + '/' + e.scrollLeft)
    const g = document.querySelector('.ember-group.is-active')
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    return { label: ${JSON.stringify(label)}, scrolled, activeBox: box(g), activeTransform: g ? getComputedStyle(g).transform : null, focused: document.activeElement?.tagName + '.' + document.activeElement?.className }
  })()`)


const geo = (label) =>
  ev(`(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    const g = document.querySelector('.ember-group.is-active')
    const scrolled = [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0 || e.scrollLeft > 0).map((e) => e.className + ':' + e.scrollTop)
    return { label: ${JSON.stringify(label)}, win: [window.innerWidth, window.innerHeight], root: box(document.querySelector('.ember-root')), stack: box(document.querySelector('.ember-stack')), group: box(g), panes: box(g?.querySelector('.ember-group-panes')), surface: box(g?.querySelector('.ember-todo, .ember-notes, .ember-slot')), transform: g ? getComputedStyle(g).transform : null, scrolled }
  })()`)

const log = []
const a = await ev(`window.__ember.activeTab()`)
await ev(`window.__ember.openTodo()`)
await sleep(1200)
const t = await ev(`window.__ember.activeTab()`)
log.push(await geo('todo fresh (maximized)'))
await ev(`window.__ember.activate(${JSON.stringify(a)})`)
await sleep(1200)
// resize while the todo tab is parked: restore, then maximize again, then a viewport override
await ev(`window.ember.window.toggleMaximize()`)
await sleep(1500)
log.push(await geo('shell active, restored'))
await ev(`window.__ember.activate(${JSON.stringify(t)})`)
await sleep(1200)
log.push(await geo('todo active after restore'))
await shot('17-todo-after-restore')
await ev(`window.__ember.activate(${JSON.stringify(a)})`)
await sleep(800)
await ev(`window.ember.window.toggleMaximize()`)
await sleep(1500)
await ev(`window.__ember.activate(${JSON.stringify(t)})`)
await sleep(1200)
log.push(await geo('todo active after re-maximize'))
await shot('18-todo-after-remax')
// a DPI-like change: emulate a different viewport while parked
await ev(`window.__ember.activate(${JSON.stringify(a)})`)
await sleep(600)
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 800, deviceScaleFactor: 1.25, mobile: false })
await sleep(1500)
await ev(`window.__ember.activate(${JSON.stringify(t)})`)
await sleep(1200)
log.push(await geo('todo active under 1400x800 @1.25'))
await shot('19-todo-dpi')
await send('Emulation.clearDeviceMetricsOverride')
await sleep(1500)
log.push(await geo('todo active after clearing override'))
await shot('20-todo-dpi-cleared')

for (const s of log) console.log(JSON.stringify(s))
console.log('console:', JSON.stringify(consoleLines.slice(0, 12)))
ws.close()
child.kill()
