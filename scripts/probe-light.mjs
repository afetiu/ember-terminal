/**
 * Ember in its day theme, on the surfaces that have one: a session's canvas with a reply on
 * it, the Todo page, the Notes page, and the first run. Each is screenshotted (to look at)
 * and checked (the day theme is on, the surface is there); exits non-zero on a miss.
 *
 *   node scripts/probe-light.mjs [out-prefix]     (default %TEMP%\ember-light)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-light')
const failures = []
const check = (label, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch(name, config, port) {
  const home = join(process.env.TEMP ?? '.', `ember-probe-${name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify(config))
  const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
  })
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
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
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${out}-${n}.png`, Buffer.from(r.data, 'base64'))
  }
  const key = async (key, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
  }
  return { ev, shot, key, close: () => (ws.close(), child.kill()) }
}

const toggleTheme = `(() => { const b = [...document.querySelectorAll('.ember-titlebar button, header button')].find((x) => /night|day|light|dark|theme/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); if (!document.body.classList.contains('is-light')) b?.click(); return !!b })()`
const reply = [
  { type: 'user', uuid: 'u1', timestamp: '2026-11-02T09:00:00Z', message: { role: 'user', content: 'what is left?' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-11-02T09:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Two things are left.\n\n| Item | State |\n|---|---|\n| Docs | open |\n| Tests | done |\n\n```js\nconst left = 2\n```' }] } },
]

/** The switch saves the config and the app redraws when main sees the file change: wait for it. */
const light = async (app) => {
  for (let i = 0; i < 40; i++) {
    if (await app.ev(`document.body.classList.contains('is-light')`)) return true
    await wait(250)
  }
  return false
}

// A session in the day theme: its canvas, fed a reply (no model), then the places.
{
  const a = await launch('light', { agent: { onboarded: true }, brain: { sync: false } }, 9394)
  await wait(5000)
  check('there is a theme switch in the title bar', await a.ev(toggleTheme))
  check('the day theme is on', await light(a))
  const first = await a.ev('window.__ember.activeTab()')
  const tab = await a.ev('window.__ember.newLoom()')
  await a.ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await a.ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(1500)
  // The canvas is shown by a stylesheet, as Claude mode would show it: no agent runs here.
  await a.ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 700px !important; }'; document.head.appendChild(st); return true })()`)
  await a.ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(reply)})`)
  await wait(1500)
  await a.shot('session')
  check('the reply is on the canvas, its table too', await a.ev(`!!document.querySelector('.loom-say') && !!document.querySelector('.loom-table')`))
  const place = (re) => a.ev(`(() => { const b = [...document.querySelectorAll('.ember-sidebar button')].find((x) => ${re}.test(x.getAttribute('aria-label') || '')); b?.click(); return !!b })()`)
  const tabs = () => a.ev(`[...document.querySelectorAll('.ember-card .ember-card-title')].map((t) => t.textContent.trim())`)
  check('the sidebar has a Todo button', await place('/^todo$/i'))
  await wait(1500)
  await a.shot('todo')
  check('the Todo page opens', (await tabs())?.some((t) => /^todo/i.test(t)))
  check('the Notes button is there', await place('/^notes$/i'))
  await wait(1500)
  await a.shot('notes')
  check('the Notes page opens', (await tabs())?.some((t) => /notes/i.test(t)))
  check('still in the day theme', await a.ev(`document.body.classList.contains('is-light')`))
  a.close()
}

// The first run in the day theme.
{
  const b = await launch('light-first', { appearance: { mode: 'day' } }, 9395)
  await wait(3000)
  await b.ev(toggleTheme)
  await light(b)
  await b.shot('firstrun')
  check('the first run shows, in the day theme', await b.ev(`!!document.querySelector('.ember-firstrun:not([hidden])') && document.body.classList.contains('is-light')`))
  b.close()
}

console.log(`\nscreenshots: ${out}-*.png`)
if (failures.length) {
  console.log(`${failures.length} failure(s)`)
  process.exit(1)
}
