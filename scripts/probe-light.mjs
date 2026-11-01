/**
 * Ember in its day theme, every surface added lately: a session's canvas, the provider
 * menu, a sticky note, the Todo page with its daily check, the Notes page, the first run.
 *
 *   node scripts/probe-light.mjs [out-prefix]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'light'
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

// A session in the day theme.
{
  const a = await launch('light', { agent: { default: 'claude', onboarded: true }, brain: { sync: false } }, 9394)
  for (let i = 0; i < 40; i++) {
    if ((await a.ev('window.__ember.loom()'))?.mode === 'claude') break
    await wait(1000)
  }
  await wait(2500)
  // The sun/moon in the title bar.
  await a.ev(`(() => { const b = [...document.querySelectorAll('.ember-titlebar button, header button')].find((x) => /night|day|light|dark|theme/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); b?.click(); return b?.getAttribute('aria-label') || b?.title })()`)
  await wait(1500)
  console.log('  light:', await a.ev(`document.body.classList.contains('is-light')`))
  await a.shot('session')
  await a.ev(`document.querySelector('.ember-provider')?.click()`)
  await wait(500)
  await a.shot('provider')
  await a.key('Escape', 'Escape', 27)
  await a.ev(`document.querySelector('.ember-provider-menu')?.remove()`)
  await a.key('N', 'KeyN', 78, 2 | 8)
  await wait(2500)
  await a.shot('sticky')
  console.log('  sticky:', await a.ev(`!!document.querySelector('.loom-piece.is-sticky')`))
  await a.ev(`[...document.querySelectorAll('.ember-sidebar button')].find((x) => /todo/i.test(x.getAttribute('aria-label') || ''))?.click()`)
  await wait(1500)
  await a.shot('todo')
  console.log('  daily check:', await a.ev(`!!document.querySelector('.ember-todo-review:not([hidden])')`))
  await a.ev(`[...document.querySelectorAll('.ember-sidebar button')].find((x) => /notes/i.test(x.getAttribute('aria-label') || ''))?.click()`)
  await wait(1500)
  await a.shot('notes')
  a.close()
}

// The first run in the day theme.
{
  const b = await launch('light-first', { appearance: { mode: 'day' } }, 9395)
  await wait(3000)
  await b.ev(`(() => { const b = [...document.querySelectorAll('.ember-titlebar button, header button')].find((x) => /night|day|light|dark|theme/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); if (!document.body.classList.contains('is-light')) b?.click() })()`)
  await wait(1500)
  await b.shot('firstrun')
  b.close()
}
