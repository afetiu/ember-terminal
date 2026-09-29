/**
 * Verifies wave 4: the settings panel edits the real config file, theme switching
 * applies live, the cheatsheet opens, and zen mode hides the chrome.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const CONFIG = join(EMBER_HOME, 'config.json')
for (const f of [join(EMBER_HOME, 'state.json'), CONFIG]) if (existsSync(f)) rmSync(f, { force: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const PORT = 9348
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
  const cb = pending.get(m.id)
  if (cb) {
    pending.delete(m.id)
    cb(m)
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
await send('Page.bringToFront')

// ---- settings panel opens and is populated ----
await ev(`window.__ember.openSettings()`)
await sleep(900)
const panel = await ev(`({
  open: document.querySelector('.ember-settings').classList.contains('is-open'),
  sections: [...document.querySelectorAll('.ember-settings-section h3')].map(e => e.textContent),
  rows: document.querySelectorAll('.ember-settings-row').length,
  themes: document.querySelectorAll('.ember-theme').length,
})`)
check('settings panel opens', panel.open === true)
check('sections render', panel.sections.length >= 7, JSON.stringify(panel.sections))
check('controls render', panel.rows > 25, `${panel.rows} rows`)
check('themes listed', panel.themes >= 5, `${panel.themes} themes`)

// ---- a control writes the real config file ----
const before = JSON.parse(readFileSync(CONFIG, 'utf8')).sound.volume
await ev(`(() => {
  const rows = [...document.querySelectorAll('.ember-settings-row')]
  const row = rows.find(r => r.querySelector('.ember-settings-label').textContent.startsWith('Volume'))
  const input = row.querySelector('input[type=range]')
  input.value = '0.9'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(1400)
const after = JSON.parse(readFileSync(CONFIG, 'utf8')).sound.volume
check('a slider writes config.json', Math.abs(after - 0.9) < 0.01 && after !== before, `${before} -> ${after}`)

// ---- theme switch applies live ----
await ev(`(() => {
  const t = [...document.querySelectorAll('.ember-theme')].find(b => b.textContent.includes('Deep Sea'))
  t.click()
  return true
})()`)
await sleep(1600)
const themed = await ev(`({
  name: window.__ember.config().theme.name,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim(),
})`)
const onDisk = JSON.parse(readFileSync(CONFIG, 'utf8')).theme.name
check('theme applies live', themed.name === 'Deep Sea' && themed.accent.toLowerCase() === '#39d3e8', JSON.stringify(themed))
check('theme persists to disk', onDisk === 'Deep Sea', String(onDisk))

// ---- reset to defaults is two-step ----
await ev(`document.querySelector('.ember-settings-reset').click()`)
await sleep(300)
const armed = await ev(`({
  armed: document.querySelector('.ember-settings-reset').classList.contains('is-armed'),
  volume: JSON.parse('0') + window.__ember.config().sound.volume,
})`)
check('first click only arms the reset', armed.armed === true && Math.abs(armed.volume - 0.9) < 0.01, JSON.stringify(armed))

await ev(`document.querySelector('.ember-settings-reset').click()`)
await sleep(1600)
const reset = JSON.parse(readFileSync(CONFIG, 'utf8'))
check(
  'second click restores shipped defaults',
  Math.abs(reset.sound.volume - 1) < 0.01 && reset.theme.name === 'Nightfall Neon',
  `volume ${reset.sound.volume}, theme ${reset.theme.name}`,
)

await ev(`document.querySelector('.ember-settings-close').click()`)
await sleep(500)

// ---- cheatsheet ----
await ev(`window.__ember.toggleCheatsheet()`)
await sleep(600)
const sheet = await ev(`({
  open: document.querySelector('.ember-cheatsheet').classList.contains('is-open'),
  rows: document.querySelectorAll('.ember-cheatsheet-row').length,
})`)
check('cheatsheet opens with bindings', sheet.open === true && sheet.rows >= 20, JSON.stringify(sheet))
await ev(`window.__ember.toggleCheatsheet()`)

// ---- zen mode ----
await sleep(400)
await ev(`window.__ember.toggleZen()`)
await sleep(1200)
const zen = await ev(`(() => {
  const tb = document.querySelector('.ember-titlebar').getBoundingClientRect()
  return { zen: document.body.classList.contains('is-zen'), titlebarH: Math.round(tb.height), sidebarW: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim() }
})()`)
check('zen hides the chrome', zen.zen && zen.titlebarH === 0 && parseFloat(zen.sidebarW) < 2, JSON.stringify(zen))

await ev(`window.__ember.toggleZen()`)
await sleep(1200)
const unzen = await ev(`Math.round(document.querySelector('.ember-titlebar').getBoundingClientRect().height)`)
check('zen restores the chrome', unzen > 20, `${unzen}px`)

writeFileSync(
  `${process.env.TEMP}\\ember-wave4.png`,
  Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'),
)

ws.close()
child.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
