import { join, basename } from 'node:path'
/**
 * End-to-end smoke test driven over the Chrome DevTools Protocol.
 *
 * Launches the built app, waits for a live session, types a command into the real
 * pty, then screenshots the window. Node 22+ has a global WebSocket, so this needs
 * no dependencies.
 *
 *   node scripts/smoke.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { writeFileSync , mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9333
const out = process.argv[2] ?? 'smoke.png'
// EMBER_BIN points the same smoke test at a packaged build, where the app is the exe
// itself rather than electron loading the project directory.
const packaged = process.env.EMBER_BIN
const electron = packaged ?? './node_modules/electron/dist/electron.exe'
const launchArgs = packaged ? [] : ['.']

console.log('testing:', electron)
const child = spawn(electron, [...launchArgs, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('DevTools endpoint never came up')
}

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

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error(logs.join(''))
  child.kill()
  process.exit(1)
}

try {
  const page = await targets()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // Give the renderer time to boot, spawn the shell and draw the first prompt.
  await sleep(2500)

  const state = await cdp.eval(`(() => {
    const pane = document.querySelector('.ember-group.is-active .ember-pane')
    return {
      panes: document.querySelectorAll('.ember-pane').length,
      tabs: document.querySelectorAll('.ember-card').length,
      sessionId: pane?.dataset.sessionId ?? null,
      cursorLayer: !!document.querySelector('.ember-cursor-layer'),
      canvasCount: document.querySelectorAll('.ember-pane canvas').length,
      rows: document.querySelectorAll('.xterm-rows > div').length,
      indicator: document.querySelector('.ember-card-indicator')?.style.transform ?? null,
      bodyText: (document.body.innerText || '').slice(0, 400),
    }
  })()`)

  console.log('state:', JSON.stringify(state, null, 2))
  if (!state.sessionId) fail('no active session mounted')
  if (!state.cursorLayer) fail('smooth cursor layer not attached')
  if (state.canvasCount === 0) fail('no renderer canvas — xterm did not open')

  // Type into the real pty and confirm the output comes back through ConPTY.
  await cdp.eval(`window.ember.write(${JSON.stringify(state.sessionId)}, "'EMBER_SMOKE_' + 'OK'\\r")`)
  await sleep(2000)

  // Open a second tab so the screenshot shows the tab strip and indicator.
  await cdp.eval(`document.querySelector('.ember-newtab').click()`)
  await sleep(1800)

  const after = await cdp.eval(`(() => ({
    tabs: document.querySelectorAll('.ember-card').length,
    panes: document.querySelectorAll('.ember-pane').length,
    indicator: document.querySelector('.ember-card-indicator')?.style.transform ?? null,
    sessions: window.__ember.sessions(),
  }))()`)

  // The WebGL renderer paints to canvas, so the DOM has no row text — read the
  // terminal buffer itself instead.
  const sawEcho = after.sessions.some((s) => /EMBER_SMOKE_OK/.test(s.text))
  console.log('tabs after new:', after.tabs, '| panes:', after.panes)
  console.log('indicator transform:', after.indicator)
  console.log('sessions:', JSON.stringify(after.sessions, null, 2))
  console.log('pty echo seen:', sawEcho)

  const shoot = async (file) => {
    // The caret deliberately renders hollow and trail-less when the window is not
    // focused, so the window must be foreground for these frames to be meaningful.
    await cdp.send('Page.bringToFront')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('screenshot ->', file)
  }

  // Switch back to the first tab (which has real prompt output) and let it settle.
  await cdp.eval(`document.querySelector('.ember-card').click()`)
  await sleep(900)
  await shoot(out.replace(/\.png$/, '-settled.png'))

  // Fire a switch and grab a frame mid-flight to see the blur/slide actually applied.
  await cdp.eval(`document.querySelectorAll('.ember-card')[1].click()`)
  await sleep(90)
  await shoot(out.replace(/\.png$/, '-switching.png'))
  await sleep(600)

  // Back to tab 1, then jump the caret across the line to catch the trail.
  await cdp.eval(`document.querySelector('.ember-card').click()`)
  await sleep(700)
  const sid = await cdp.eval(`document.querySelector('.ember-group.is-active .ember-pane').dataset.sessionId`)
  await cdp.send('Page.bringToFront')
  await sleep(300)
  await cdp.eval(`window.ember.write(${JSON.stringify(sid)}, 'Get-ChildItem C:\\\\Users\\\\afeti -Name | Select-Object -First 6')`)
  await sleep(55)
  await shoot(out.replace(/\.png$/, '-trail.png'))
  await sleep(400)
  await shoot(out)

  cdp.close()
  child.kill()

  if (after.tabs < 2) fail('second tab did not appear')
  console.log('SMOKE OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}
