/**
 * Exercises the whole new feature surface in one run: live config reload, session
 * persistence, split + zoom, scrollback search, palette shell/project modes,
 * broadcast input, and copy-last-output.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync , mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join , basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9340
const CONFIG = join(EMBER_HOME, 'config.json')
const STATE = join(EMBER_HOME, 'state.json')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
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

await send('Runtime.enable')
await sleep(3500)
await ev(`window.ember.window.toggleMaximize()`)
await sleep(2000)

// ---- live config reload -------------------------------------------------
const before = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--fx-vignette').trim()`)
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
// Alternate, so a re-run never writes the value it already has.
const wanted = Math.abs(Number(before) - 0.77) < 0.01 ? 0.41 : 0.77
cfg.effects = { ...cfg.effects, vignette: wanted }
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2))
await sleep(1800)
const after = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--fx-vignette').trim()`)
check('live config reload', Math.abs(Number(after) - wanted) < 0.01, `${before} -> ${after} (wanted ${wanted})`)

// ---- split + zoom -------------------------------------------------------
await ev(`window.__ember.split('row')`)
await sleep(2600)
const split = await ev(`window.__ember.groups()[0]`)
check('split creates sibling pane', split.panes.length === 2, `${split.panes.length} panes`)

await ev(`window.__ember.toggleZoom()`)
await sleep(1100)
const zoomWidths = await ev(`window.__ember.sessions().map(s => s.paneW)`)
const zoomed = await ev(`window.__ember.groups()[0].zoomed`)
check('zoom expands focused pane', zoomed && Math.max(...zoomWidths) / Math.min(...zoomWidths) > 5, JSON.stringify(zoomWidths))
await ev(`window.__ember.toggleZoom()`)
await sleep(1100)

// ---- copy last output ---------------------------------------------------
const sid = await ev(`document.querySelector('.ember-group.is-active .ember-pane').dataset.sessionId`)
await ev(`(() => {
  const t = window.__ember
  const term = document.querySelector('.ember-group.is-active .ember-pane')
  window.__probeSid = ${JSON.stringify(sid)}
})()`)
// Type through xterm so the Enter is observed by the input handler, not injected.
await ev(`(() => {
  const ta = document.querySelector('.ember-group.is-active .ember-pane textarea')
  ta.focus()
  return true
})()`)
// Route through xterm's own input(), which fires the same onData listeners as real
// typing — that is what sets the output mark used by copy-last-output.
await ev(`window.__ember.type("Write-Output 'MARKER_LINE_1'")`)
await sleep(400)
await ev(`window.__ember.type('\\r')`)
await sleep(2500)
await ev(`window.__ember.copyLastOutput()`)
await sleep(500)
const clip = await ev(`navigator.clipboard.readText()`)
check('copy last command output', /MARKER_LINE_1/.test(clip ?? ''), JSON.stringify((clip ?? '').slice(0, 60)))

// ---- search -------------------------------------------------------------
await ev(`window.__ember.openSearch()`)
await sleep(400)
await ev(`(() => {
  const i = document.querySelector('.ember-search-input')
  i.value = 'MARKER_LINE_1'
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(600)
const searchOk = await ev(`!document.querySelector('.ember-search').classList.contains('is-empty')`)
check('scrollback search finds match', searchOk === true)
await ev(`document.querySelector('.ember-search .ember-search-btn:last-child').click()`)

// ---- palette modes ------------------------------------------------------
await ev(`window.__ember.openPalette('@')`)
await sleep(900)
const projects = await ev(`Array.from(document.querySelectorAll('.ember-palette-row .ember-palette-title')).slice(0,6).map(e => e.textContent)`)
check('palette project mode lists folders', Array.isArray(projects) && projects.length > 1, JSON.stringify(projects?.slice(0, 4)))

await ev(`(() => {
  const i = document.querySelector('.ember-palette-input')
  i.value = '>Get-Date'
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(500)
const shellRow = await ev(`document.querySelector('.ember-palette-row .ember-palette-title')?.textContent ?? null`)
check('palette shell mode offers the line', shellRow === 'Get-Date', String(shellRow))
await ev(`document.querySelector('.ember-palette').dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`)
await sleep(300)

// ---- broadcast ----------------------------------------------------------
const bcast = await ev(`(() => { window.__ember.openPalette(); return true })()`)
await ev(`document.querySelector('.ember-palette').dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`)
await sleep(200)

// ---- persistence --------------------------------------------------------
await sleep(4500)
const stateOk = existsSync(STATE)
let saved = null
if (stateOk) saved = JSON.parse(readFileSync(STATE, 'utf8'))
// Assert on *some* group holding the split, not groups[0]: if a lingering instance
// flushed state back to disk after the pre-run delete, restore reopens those groups
// and the split lands on whichever one is active.
check(
  'layout persisted to state.json',
  stateOk && Array.isArray(saved?.groups) && saved.groups.some((g) => g.panes.length === 2),
  stateOk ? `${saved.groups.length} group(s), panes: ${saved.groups.map((g) => g.panes.length).join('/')}` : 'missing',
)

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${process.env.TEMP}\\ember-suite.png`, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', `${process.env.TEMP}\\ember-suite.png`)

ws.close()
child.kill()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
