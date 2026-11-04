#!/usr/bin/env node
/**
 * The sidebar's minimised state.
 *
 * A thing that looks fine in a screenshot of one state and is wrong in another, so this
 * measures it rather than looking.
 *
 *   node scripts/probe-chrome.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { seedHome } from './probelib.mjs'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))

const PORT = 9372
const out = process.argv[2] ?? 'chrome.png'

seedHome(EMBER_HOME)
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME },
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', rej, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.#pending.get(msg.id)
      if (!p) return
      c.#pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    })
    return c
  }

  send(method, params = {}) {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.#pending.set(id, { res, rej }))
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.value
  }

  close() {
    this.#ws.close()
  }
}

let failures = 0
const fail = (m) => {
  failures++
  console.error(`  ✗ ${m}`)
}
const pass = (m) => console.log(`  ✓ ${m}`)

/** Settle on a measurement: springs mean the first read is never the resting one. */
async function settle(cdp, expr) {
  let last = null
  let stable = 0
  for (let i = 0; i < 50; i++) {
    await sleep(120)
    const now = await cdp.eval(expr)
    if (last && JSON.stringify(now) === JSON.stringify(last)) stable++
    else stable = 0
    last = now
    if (stable >= 2) return now
  }
  return last
}

try {
  let page
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
    } catch {
      /* not up yet */
    }
  }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3500)

  // ---------------------------------------------------------------- the sidebar
  console.log('\nthe sidebar')
  const full = await settle(cdp, `(() => {
    const s = document.querySelector('.ember-sidebar')
    const b = s.getBoundingClientRect()
    return { w: Math.round(b.width), mini: document.body.classList.contains('sidebar-mini') }
  })()`)
  if (full.w < 150) fail(`the sidebar did not start expanded (${full.w}px)`)
  else pass(`it starts at ${full.w}px, with names`)

  await cdp.eval(`window.__ember.sidebar()`)
  const mini = await settle(cdp, `(() => {
    const s = document.querySelector('.ember-sidebar')
    const b = s.getBoundingClientRect()
    const card = document.querySelector('.ember-card')
    const title = document.querySelector('.ember-card-title')
    const badge = document.querySelector('.ember-card-state')
    return {
      w: Math.round(b.width),
      mini: document.body.classList.contains('sidebar-mini'),
      cardVisible: !!card && card.getBoundingClientRect().width > 8,
      titleShown: !!title && title.getBoundingClientRect().width > 1,
      badgePx: badge ? Math.round(badge.getBoundingClientRect().width) : 0,
    }
  })()`)

  // Minimised, not gone. The distinction is the whole request: a rail you can still see
  // and click, rather than a sidebar that has vanished and left you guessing.
  if (mini.w === 0) fail('collapsing hid the sidebar entirely instead of minimising it')
  else if (mini.w >= full.w) fail(`collapsing did not narrow it (${full.w} -> ${mini.w}px)`)
  else pass(`it minimises to a ${mini.w}px rail rather than disappearing`)

  if (!mini.cardVisible) fail('the session cards are not visible in the minimised rail')
  else pass('the sessions are still there to click')

  if (mini.titleShown) fail('the rail still shows session names, so it is not really minimised')
  else pass('their names are dropped, which is what makes room')

  // Each card keeps its state dot: the rail still says which session is working.
  if (mini.badgePx === 0) fail('the rail has no state dots in it')
  else if (mini.badgePx > 34) {
    fail(`the state marks are ${mini.badgePx}px — the rail is narrower but its marks are not`)
  } else pass(`and each keeps its state dot (${mini.badgePx}px)`)

  await cdp.eval(`window.__ember.sidebar()`)
  const back = await settle(cdp, `Math.round(document.querySelector('.ember-sidebar').getBoundingClientRect().width)`)
  if (Math.abs(back - full.w) > 2) fail(`it did not come back to its width (${full.w} -> ${back}px)`)
  else pass('and comes back')

  await cdp.eval(`window.__ember.sidebar()`)
  await sleep(900)
  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`\nscreenshot -> ${out}`)

  cdp.close()
  child.kill()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join('').slice(-1500))
    process.exit(1)
  }
  console.log('CHROME OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join('').slice(-1500))
  child.kill()
  process.exit(1)
}
