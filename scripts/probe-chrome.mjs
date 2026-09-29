#!/usr/bin/env node
/**
 * The title-bar controls, and the sidebar's minimised state.
 *
 * Both are things that look fine in a screenshot of one state and are wrong in another.
 * Alignment especially: "the two buttons are not vertically aligned" is a two-pixel claim,
 * and two pixels is exactly the kind of thing that gets argued about from memory instead
 * of measured. So this measures — centre lines, to the pixel — and it measures the icons
 * inside the buttons rather than the buttons themselves, because that was the bug: two
 * buttons agreeing on their own boxes while their contents sat on different baselines.
 *
 *   node scripts/probe-chrome.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))

const PORT = 9372
const out = process.argv[2] ?? 'chrome.png'

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

  // ---------------------------------------------------------------- alignment
  //
  // The icons, not the buttons. One is a font glyph and one is an inline SVG, and an
  // inline SVG sits on the text baseline — so two buttons can be perfectly aligned while
  // what you actually see in them is not.
  console.log('\nthe title-bar controls')
  const marks = await cdp.eval(`(() => {
    const box = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { top: +b.top.toFixed(1), mid: +(b.top + b.height / 2).toFixed(1), h: +b.height.toFixed(1), w: +b.width.toFixed(1) }
    }
    const panel = document.querySelector('.ember-paneltoggle')
    const orch = document.querySelector('.ember-voicetoggle.is-orch')
    return {
      panelBtn: box(panel),
      orchBtn: box(orch),
      // What is actually drawn inside each.
      panelInk: box(panel),
      orchInk: box(orch?.querySelector('svg')),
    }
  })()`)

  if (!marks.panelBtn || !marks.orchBtn) {
    fail('one of the title-bar buttons is missing')
  } else {
    const btnDelta = Math.abs(marks.panelBtn.mid - marks.orchBtn.mid)
    if (btnDelta > 0.6) fail(`the buttons themselves are ${btnDelta.toFixed(1)}px apart vertically`)
    else pass('the two buttons share a centre line')

    const inkDelta = Math.abs(marks.panelInk.mid - marks.orchInk.mid)
    if (inkDelta > 0.6) {
      fail(`what is drawn inside them is ${inkDelta.toFixed(1)}px apart — the icons look misaligned`)
    } else pass(`and so does what is drawn inside them (${inkDelta.toFixed(1)}px apart)`)
  }

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
    const badge = document.querySelector('.ember-card-badge')
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

  // The icons have to come down with it. A rail of full-size badges is a narrower
  // sidebar, not a minimised one, which is the distinction the user drew.
  if (mini.badgePx === 0) fail('the rail has no icons in it')
  else if (mini.badgePx > 34) {
    fail(`the icons are still ${mini.badgePx}px — the rail is narrower but the icons are not minimised`)
  } else pass(`and the icons shrink with it (${mini.badgePx}px, from 38)`)

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
