#!/usr/bin/env node
/**
 * Two bits of chrome that are only wrong to the eye: the card's ticking timer, and the
 * scrollbars inside the panel.
 *
 * The timer is checked structurally rather than visually. "Only the digit that changed
 * moved" is not a thing a screenshot can settle — both the old whole-line slide and the
 * new per-character roll look like a number changing in a still frame. What can be
 * settled is which elements are mid-animation at the moment of the tick, so that is
 * what this reads: drive the status through a sequence of values and count the cells
 * carrying an animation each time.
 *
 * The scrollbars get a screenshot, because there the eye is the point.
 *
 *   node scripts/probe-odometer.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9355
const out = process.argv[2] ?? 'odometer.png'

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

/**
 * Set the odometer directly and report what moved.
 *
 * It reads `getAnimations()` rather than class names: a cell that carries `is-rolling`
 * but whose animation never started is exactly the bug this is looking for, and only
 * the animation itself distinguishes the two.
 */
const drive = (value) => `(() => {
  if (!window.__ember.setCardStatus(${JSON.stringify(value)})) return null
  const odo = document.querySelector('.ember-card-statustext')
  const cells = [...odo.querySelectorAll('.ember-odo-cell')]
  const busy = (c) => c.getAnimations({ subtree: true }).some((a) => a.playState === 'running')
  // Read the arriving glyph only. Mid-roll a cell holds two: the one leaving is
  // absolutely positioned and on its way out, and counting it reads "3m 26s" ticking
  // to "3m 267s" — the cell's textContent is not what is on screen.
  const shown = (c) => c.querySelector('.ember-odo-glyph:not(.is-out)')?.textContent ?? ''
  return {
    text: cells.map(shown).join(''),
    cells: cells.length,
    moving: cells.filter(busy).length,
    chars: cells.map((c) => (busy(c) ? '^' : '\\u00b7')).join(''),
  }
})()`

try {
  const page = await hostTarget()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3500)

  const seq = ['3m 26s', '3m 27s', '3m 28s', '3m 30s', '4m 00s']
  console.log('\nodometer')
  let last = null
  for (const v of seq) {
    const state = await cdp.eval(drive(v))
    if (!state) {
      fail('the odometer disappeared mid-sequence')
      break
    }
    console.log(`  "${state.text}"  moving: ${state.moving}/${state.cells}   ${state.chars}`)
    if (state.text !== v) fail(`odometer shows "${state.text}", asked for "${v}"`)
    if (last === '3m 26s' && v === '3m 27s' && state.moving !== 1) {
      fail(`a one-second tick moved ${state.moving} cells — the whole line is still animating`)
    }
    last = v
    await sleep(450)
  }
  if (!failures) pass('a one-second tick rolls exactly one cell')

  // Rollover legitimately moves several, but never all of them: the "m" and the two
  // spaces either side of it never change.
  const over = await cdp.eval(drive('5m 00s'))
  if (over.moving === 0) fail('a minute rollover moved nothing')
  if (over.moving >= over.cells) fail('a minute rollover moved every cell, including the unchanged ones')
  pass(`a minute rollover moves ${over.moving} of ${over.cells} cells, not the line`)

  console.log('\nscrollbars')
  const bars = await cdp.eval(`(() => {
    const s = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules] } catch { return [] } })
    const text = s.map((r) => r.cssText).join('\\n')
    return {
      pill: text.includes('::-webkit-scrollbar-thumb'),
      buttons: text.includes('::-webkit-scrollbar-button'),
      // Any survivor here would silently disable every rule above it in Chromium.
      standard: (text.match(/scrollbar-width/g) ?? []).length,
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
    // Put the pointer in the panel, since the thumb is deliberately faint until it is.
    await sleep(2000)
    const box = await cdp.eval(`(() => { const r = document.querySelector('.ember-panel-frame').getBoundingClientRect()
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
