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

const PORT = 9386
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

const log = []
const a = await ev(`window.__ember.activeTab()`)
await ev(`window.__ember.newTab()`)
await sleep(2500)
const b = await ev(`window.__ember.activeTab()`)
await ev(`window.__ember.activate(${JSON.stringify(a)})`)
await sleep(1500)
log.push(await state('A active, B parked'))

// A panel into the parked tab whose page focuses an input, as an ask card would.
const html = '<div style="padding:20px;color:#eee"><h3>From a background session</h3><input id="q" placeholder="type here" autofocus><script>setTimeout(function(){document.getElementById("q").focus()},400)</script></div>'
await ev(`window.ember.diag.pushPanel({ tabId: ${JSON.stringify(b)}, title: 'probe', content: ${JSON.stringify(html)}, format: 'html', replace: true })`)
await sleep(3000)
log.push(await state('after push into parked B'))
await shot('14-after-push-parked')

await ev(`window.__ember.activate(${JSON.stringify(b)})`)
await sleep(1500)
log.push(await state('B active after push'))
await shot('15-b-active')

// The same into the active tab, and into a bare todo tab that is parked.
await ev(`window.__ember.openTodo()`)
await sleep(1200)
const t = await ev(`window.__ember.activeTab()`)
await ev(`window.__ember.activate(${JSON.stringify(a)})`)
await sleep(1500)
await ev(`window.ember.diag.pushPanel({ tabId: ${JSON.stringify(t)}, title: 'probe2', content: ${JSON.stringify(html)}, format: 'html', replace: true })`)
await sleep(3000)
log.push(await state('after push into parked todo tab'))
await ev(`window.__ember.activate(${JSON.stringify(t)})`)
await sleep(1500)
log.push(await state('todo active after push'))
await shot('16-todo-active')

for (const s of log) console.log(JSON.stringify(s))
console.log('console:', JSON.stringify(consoleLines.slice(0, 12)))
ws.close()
child.kill()
