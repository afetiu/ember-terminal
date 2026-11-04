#!/usr/bin/env node
/**
 * Two bits of chrome that are only wrong to the eye: the card's ticking timer, and the
 * scrollbars inside the panel.
 *
 * The timer used to be an odometer whose changed digits rolled; it was the most expensive
 * thing on screen and is plain text now (src/renderer/src/ui/Odometer.ts). What can go
 * wrong with it is that it stops showing what it was given, or that something starts
 * animating on every tick again — neither visible in a still frame, so this drives the
 * status through a sequence of values and reads the text and the running animations.
 *
 * The scrollbars get a screenshot of a long document on the canvas, because there the
 * eye is the point.
 *
 *   node scripts/probe-odometer.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { seedHome } from './probelib.mjs'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9355
const out = process.argv[2] ?? 'odometer.png'

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
const fail = (msg) => {
  failures++
  console.error(`  ✗ ${msg}`)
}
const pass = (msg) => console.log(`  ✓ ${msg}`)

async function hostTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('DevTools endpoint never came up')
}

/** Set the card's status directly and report what it shows and what is animating. */
const drive = (value) => `(() => {
  if (!window.__ember.setCardStatus(${JSON.stringify(value)})) return null
  const odo = document.querySelector('.ember-card-statustext')
  if (!odo) return null
  return {
    text: odo.textContent,
    moving: odo.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
  }
})()`

try {
  const page = await hostTarget()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3500)

  const seq = ['3m 26s', '3m 27s', '3m 28s', '3m 30s', '4m 00s', '5m 00s']
  console.log('\nthe card timer')
  for (const v of seq) {
    const state = await cdp.eval(drive(v))
    if (!state) {
      fail('the card status disappeared mid-sequence')
      break
    }
    console.log(`  "${state.text}"  animating: ${state.moving}`)
    if (state.text !== v) fail(`the timer shows "${state.text}", asked for "${v}"`)
    if (state.moving) fail(`a tick started ${state.moving} animation(s) — the timer is meant to be still text`)
    await sleep(450)
  }
  if (!failures) pass('every tick shows its value, and nothing animates')

  console.log('\nscrollbars')
  const bars = await cdp.eval(`(() => {
    const s = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules] } catch { return [] } })
    const text = s.map((r) => r.cssText).join('\\n')
    return {
      pill: text.includes('::-webkit-scrollbar-thumb'),
      buttons: text.includes('::-webkit-scrollbar-button'),
      // Any survivor here would silently disable every rule above it in Chromium.
      // scrollbar-width: none is a scroller meant to have no bar at all, which is fine.
      standard: (text.match(/scrollbar-width: (?!none)|scrollbar-color/g) ?? []).length,
    }
  })()`)
  if (!bars.pill) fail('no ::-webkit-scrollbar-thumb rule reached the document')
  if (!bars.buttons) fail('scrollbar arrow buttons are not suppressed')
  if (bars.standard) fail(`${bars.standard} scrollbar-width declaration(s) survive — Chromium ignores the pill where they apply`)
  if (!failures) pass('the pill is the only scrollbar styling in the document')

  // Something long enough to scroll both ways, so the bars are on screen to be judged.
  const wire = await cdp.eval(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabId: document.querySelector('.ember-group')?.dataset.groupId ?? ''
  }))()`)
  const token = await readToken(cdp)
  if (wire.origin && token) {
    // The document lands on the tab's canvas; shown here by a stylesheet, as Claude mode would show it.
    await cdp.eval(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 760px !important; }'; document.head.appendChild(st); return true })()`)
    const rows = Array.from(
      { length: 45 },
      (_, i) => `| row ${i + 1} | ${i * 7} | a wide cell that pushes this table sideways, ${i} |`
    ).join('\n')
    await fetch(`${wire.origin}/panel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({
        tabId: wire.tabId,
        title: 'Scrollbars',
        format: 'markdown',
        replace: true,
        content: `# Scrollbars\n\nBoth axes, so the pill can be judged.\n\n| What | N | Note |\n| --- | --- | --- |\n${rows}\n`,
      }),
    })
    // Put the pointer in the document, since the thumb is deliberately faint until it is.
    await sleep(2000)
    const box = await cdp.eval(`(() => { const r = [...document.querySelectorAll('.loom-piece iframe.loom-frame')].at(-1).getBoundingClientRect()
      return { x: Math.round(r.right - 30), y: Math.round(r.top + r.height / 2) } })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await sleep(500)
  }

  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`\nscreenshot -> ${out}`)

  cdp.close()
  child.kill()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join(''))
    process.exit(1)
  }
  console.log('ODOMETER OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join(''))
  child.kill()
  process.exit(1)
}

/** The bridge token, out of the shell's own environment. */
async function readToken(cdp) {
  const { existsSync, readFileSync, rmSync } = await import('node:fs')
  const file = join(EMBER_HOME, 'token.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const token = readFileSync(file, 'utf8').trim()
    if (token) return token
  }
  return null
}
