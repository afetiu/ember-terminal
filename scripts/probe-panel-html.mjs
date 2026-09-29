import { join, basename } from 'node:path'
/**
 * The two ways an html panel used to come out blank, and the panel's grip.
 *
 * Starts a test Ember the way probe-panel does, then pushes the three shapes of html a
 * model actually sends — a bare fragment, a full document that never names a text
 * colour, and a page wrapped in a ```html fence — and looks inside the guest to check
 * each one is readable: wrapped, given colours, unfenced. Then takes hold of the panel's
 * left edge with synthetic mouse events, drags it, and checks that the panel followed
 * and that `panel.width` was written to config.
 *
 *   node scripts/probe-panel-html.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9353
const out = process.argv[2] ?? 'panel-html.png'

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

async function until(cdp, expression, ok, what, tries = 40) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

const PANEL_RECT = `(() => { const p = document.querySelector('.ember-panel')
  if (!p) return null
  const b = p.getBoundingClientRect()
  return { w: Math.round(b.width), left: Math.round(b.left), top: Math.round(b.top), h: Math.round(b.height),
           open: p.classList.contains('is-open') } })()`

try {
  const page = await target()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3000)

  await until(cdp, PANEL_RECT, (v) => v !== null, 'no .ember-panel in a v2 tab')

  const wire = await cdp.eval(`(async () => {
    const origin = await window.ember.panel.origin()
    const tabId = document.querySelector('.ember-group')?.dataset.groupId ?? null
    return { origin, tabId }
  })()`)
  if (!wire.origin || !wire.tabId) fail(`no bridge or tab: ${JSON.stringify(wire)}`)

  const token = await readToken(cdp)
  if (!token) fail('the shell never reported EMBER_BRIDGE_TOKEN')

  const push = async (body) => {
    const res = await fetch(`${wire.origin}/panel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({ tabId: wire.tabId, replace: true, ...body }),
    })
    if (!res.ok) fail(`bridge rejected a push: ${res.status} ${await res.text()}`)
    return res.json()
  }

  const loaded = async (title) =>
    until(
      cdp,
      `(() => ({ title: document.querySelector('.ember-panel-title')?.textContent ?? '',
                 src: document.querySelector('.ember-panel-frame')?.getAttribute('src') ?? '' }))()`,
      (v) => v.title === title && v.src.includes('/doc/'),
      `panel never showed "${title}"`
    )

  // 1. A bare fragment: wrapped, and its text is the panel's light colour.
  await push({ title: 'Fragment', format: 'html', content: '<div class="card"><h2>Fragment</h2><p id="t">a fragment</p></div>' })
  const frag = await inspectDoc((await loaded('Fragment')).src, `(() => ({
    wrapped: document.body.classList.contains('ember-fragment'),
    text: document.getElementById('t')?.textContent ?? '',
    color: getComputedStyle(document.getElementById('t')).color,
    bg: getComputedStyle(document.body).backgroundColor,
  }))()`)
  console.log('fragment:', JSON.stringify(frag))
  if (!frag.wrapped) fail('the fragment was not wrapped in a document of its own')
  if (frag.text !== 'a fragment') fail('the fragment lost its markup')
  if (!isLight(frag.color)) fail(`fragment text is ${frag.color}, which will not read on a dark panel`)

  // 2. A full document that never names a colour: readable anyway, and not re-wrapped.
  await push({
    title: 'Document',
    format: 'html',
    content:
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><style>.k { padding: 4px; }</style></head>' +
      '<body><p class="k" id="t">a document</p></body></html>',
  })
  const doc = await inspectDoc((await loaded('Document')).src, `(() => ({
    wrapped: document.body.classList.contains('ember-fragment'),
    color: getComputedStyle(document.getElementById('t')).color,
    doctypes: document.doctype ? 1 : 0,
    heads: document.querySelectorAll('head').length,
  }))()`)
  console.log('document:', JSON.stringify(doc))
  if (doc.wrapped) fail('a full document was treated as a fragment')
  if (!isLight(doc.color)) fail(`unstyled document text is ${doc.color}, black on black`)

  // 3. A document the model fenced in ```html: the backticks must not be on screen, and
  //    the author's own style must still win over the defaults.
  await push({
    title: 'Fenced',
    format: 'html',
    content:
      '```html\n<!doctype html><html><head><style>#t { color: rgb(255, 0, 0); }</style></head>' +
      '<body><p id="t">fenced</p></body></html>\n```',
  })
  const fenced = await inspectDoc((await loaded('Fenced')).src, `(() => ({
    text: document.body.innerText,
    color: getComputedStyle(document.getElementById('t')).color,
  }))()`)
  console.log('fenced:', JSON.stringify(fenced))
  if (fenced.text.includes('```')) fail('the fence is showing as text')
  if (fenced.color !== 'rgb(255, 0, 0)') fail(`author style lost to the defaults: ${fenced.color}`)

  // 4. The grip: invisible at rest, lit on hover, and drags the panel wider.
  const before = await cdp.eval(PANEL_RECT)
  const grip = await cdp.eval(`(() => {
    const g = document.querySelector('.ember-panel-grip')
    if (!g) return null
    const b = g.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width,
             restOpacity: getComputedStyle(g, '::after').opacity }
  })()`)
  console.log('grip:', JSON.stringify(grip), 'panel before:', JSON.stringify(before))
  if (!grip) fail('no .ember-panel-grip on an open panel')
  if (grip.restOpacity !== '0') fail(`the grip is visible at rest (opacity ${grip.restOpacity})`)

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y })
  await sleep(300)
  const hovered = await cdp.eval(`getComputedStyle(document.querySelector('.ember-panel-grip'), '::after').opacity`)
  console.log('grip on hover: opacity', hovered)
  if (hovered !== '1') fail(`the grip does not light on hover (opacity ${hovered})`)

  const drag = 180
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x - (drag * i) / 12, y: grip.y, button: 'left' })
    await sleep(30)
  }
  const midDrag = await cdp.eval(PANEL_RECT)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x - drag, y: grip.y, button: 'left', clickCount: 1 })
  await sleep(600)
  const after = await cdp.eval(PANEL_RECT)
  console.log('mid-drag:', JSON.stringify(midDrag), 'after:', JSON.stringify(after))
  const grew = after.w - before.w
  if (Math.abs(grew - drag) > 12) fail(`dragged ${drag}px but the panel grew ${grew}px`)

  // The terminal gave the width up rather than being covered.
  const layout = await cdp.eval(`(() => {
    const panes = document.querySelector('.ember-group-panes').getBoundingClientRect()
    const panel = document.querySelector('.ember-panel').getBoundingClientRect()
    return { panesRight: Math.round(panes.right), panelLeft: Math.round(panel.left) }
  })()`)
  if (Math.abs(layout.panesRight - layout.panelLeft) > 2) fail(`panel overlaps the terminal after the drag: ${JSON.stringify(layout)}`)

  // And the share was written to config, through the same door the slider uses.
  const saved = await until(
    cdp,
    `window.ember.getConfig().then((c) => c.panel.width)`,
    (v) => typeof v === 'number' && Math.abs(v - 0.42) > 0.01,
    'panel.width was not saved after the drag'
  )
  const stage = await cdp.eval(`document.querySelector('.ember-group').getBoundingClientRect().width`)
  console.log(`saved panel.width=${saved} (panel ${after.w}px of ${Math.round(stage)}px stage = ${(after.w / stage).toFixed(3)})`)
  if (Math.abs(saved - after.w / stage) > 0.02) fail('the saved share does not match the panel on screen')
  const onDisk = JSON.parse(readFileSync(join(EMBER_HOME, 'config.json'), 'utf8'))
  if (Math.abs((onDisk.panel?.width ?? 0) - saved) > 0.001) fail(`config.json has panel.width=${onDisk.panel?.width}`)

  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot ->', out)

  cdp.close()
  child.kill()
  console.log('PANEL HTML OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}

/** rgb() text light enough to read on Ember's dark panel. */
function isLight(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (!m) return false
  return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 > 150
}

async function readToken(cdp) {
  const file = join(EMBER_HOME, 'token.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_TAB_ID|$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const [, token] = readFileSync(file, 'utf8').trim().split('|')
    if (token) return token
  }
  return null
}

/** Attach to the panel's guest page — its own DevTools target — and evaluate there. */
async function inspectDoc(url, expression) {
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const guest = list.find((t) => t.url === url)
    if (guest?.webSocketDebuggerUrl) {
      const c = await Cdp.connect(guest.webSocketDebuggerUrl)
      await c.send('Runtime.enable')
      const ready = await c.eval(`document.readyState`)
      if (ready === 'complete') {
        const state = await c.eval(expression)
        c.close()
        return state
      }
      c.close()
    }
    await sleep(300)
  }
  fail(`never found the panel document at ${url} in the target list`)
}
