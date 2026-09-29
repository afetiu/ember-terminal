import { join, basename } from 'node:path'
/**
 * An OSC 8 hyperlink — the kind Claude Code prints for a PR or a file — opens.
 *
 * Starts a test Ember, writes a hyperlink straight into the first tab's xterm, finds its
 * cell, and clicks it with a synthetic mouse, with `window.open` stubbed to record what
 * it was asked to open. Before the linkHandler fix, xterm's default handler put up a
 * confirm and called window.open() with no URL, so the record stayed empty (and, in the
 * real app, main refused "about:blank" and nothing opened). The plain-URL path is
 * checked the same way, so the two cannot drift apart again.
 *
 *   node scripts/probe-osc8.mjs
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9356

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME },
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

async function target() {
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

/** Write `text` into the terminal at a fresh line and return where its `needle` landed on screen. */
async function place(cdp, text, needle) {
  return cdp.eval(`(async () => {
    const s = window.__ember.sessions()[0]
    const term = window.__ember.term(s.id)
    await new Promise((r) => term.write(${JSON.stringify(text)}, r))
    const buf = term.buffer.active
    for (let y = buf.length - 1; y >= 0; y--) {
      const line = buf.getLine(y)?.translateToString(true) ?? ''
      const col = line.indexOf(${JSON.stringify(needle)})
      if (col === -1) continue
      const screen = document.querySelector('.ember-pane.is-focused .xterm-screen, .xterm-screen')
      const r = screen.getBoundingClientRect()
      const cw = r.width / term.cols
      const ch = r.height / term.rows
      const row = y - buf.viewportY
      return { row, col, x: r.left + (col + ${needle.length} / 2) * cw, y: r.top + (row + 0.5) * ch, line }
    }
    return null
  })()`)
}

async function click(cdp, at) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(300)
  return cdp.eval(`window.__opened`)
}

try {
  const page = await target()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await sleep(3500)

  // Record instead of opening: the real path from here is main's window-open hook and
  // shell.openExternal, which is what plain URLs have used all along.
  await cdp.eval(`(() => { window.__opened = null; window.open = (u) => { window.__opened = String(u ?? ''); return null } })()`)

  const osc = await place(cdp, '\r\n\x1b]8;;https://example.com/pr/42\x1b\\OPENTHIS\x1b]8;;\x1b\\\r\n', 'OPENTHIS')
  console.log('osc8 link at:', JSON.stringify(osc))
  if (!osc) fail('the hyperlink text never appeared in the buffer')
  const opened = await click(cdp, osc)
  console.log('clicked, window.open got:', JSON.stringify(opened))
  if (opened !== 'https://example.com/pr/42') fail(`OSC 8 click opened ${JSON.stringify(opened)}, expected the link`)

  await cdp.eval(`window.__opened = null`)
  const plain = await place(cdp, '\r\nsee https://example.com/plain/7 now\r\n', 'https://example.com/plain/7')
  console.log('plain url at:', JSON.stringify(plain))
  if (!plain) fail('the plain URL never appeared in the buffer')
  const opened2 = await click(cdp, plain)
  console.log('clicked, window.open got:', JSON.stringify(opened2))
  if (opened2 !== 'https://example.com/plain/7') fail(`plain URL click opened ${JSON.stringify(opened2)}`)

  cdp.close()
  child.kill()
  console.log('OSC8 OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}
