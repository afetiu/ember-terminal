#!/usr/bin/env node
/**
 * Two surfaces open at once, and neither on top of the other.
 *
 * The orchestrator began life as a drawer floating over the window. That looked right
 * until a tab had its visualisation panel open too — then both occupied the same strip
 * of screen and the panel was simply buried underneath, with nothing in the app aware
 * anything was wrong.
 *
 * It is measured rather than looked at, because a screenshot of one state cannot show
 * it: open both, read the rectangles, and assert they do not intersect *and* that the
 * terminal actually gave up the room. Either half alone would pass while the bug was
 * still there — no overlap is satisfiable by a panel squeezed to nothing, and a narrower
 * terminal is satisfiable by two things stacked on the same pixels.
 *
 *   node scripts/probe-layout.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))

const PORT = 9363
const out = process.argv[2] ?? 'layout.png'

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

/** Every surface's rectangle, in one round trip so they are all from the same frame. */
const RECTS = `(() => {
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }
  }
  return {
    orch: r('.ember-orch'),
    panel: r('.ember-panel'),
    panes: r('.ember-group-panes'),
    sidebar: r('.ember-sidebar'),
    win: window.innerWidth,
  }
})()`

/** Horizontal intersection in px. Negative means a gap. Zero-width boxes never count. */
function overlap(a, b) {
  if (!a || !b || a.w <= 2 || b.w <= 2) return -1
  return Math.min(a.r, b.r) - Math.max(a.l, b.l)
}

/**
 * Wait until the layout both satisfies `ok` and has stopped moving.
 *
 * The stillness half is not belt-and-braces. Every width here is spring-driven, so a
 * predicate like "the panel is wider than 100px" is true long before the panel has
 * arrived — and a baseline captured mid-animation makes the *later* comparison fail
 * against a number that was never the resting one. That is exactly how this probe first
 * reported a layout bug that did not exist.
 */
async function settle(cdp, ok) {
  let last = null
  let stable = 0
  for (let i = 0; i < 60; i++) {
    await sleep(120)
    const now = await cdp.eval(RECTS)
    const same =
      last && ['orch', 'panel', 'panes'].every((k) => Math.abs((now[k]?.w ?? 0) - (last[k]?.w ?? 0)) <= 1)
    stable = same ? stable + 1 : 0
    last = now
    if (ok(now) && stable >= 2) return now
  }
  return last
}

async function readToken(cdp) {
  const file = join(EMBER_HOME, 'tok.txt')
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
  return ''
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

  const wire = await cdp.eval(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabId: document.querySelector('.ember-group')?.dataset.groupId ?? ''
  }))()`)
  const token = await readToken(cdp)
  if (!token) fail('no bridge token, so the panel cannot be filled')

  // A panel with something on it, so it has real width to be buried under.
  await fetch(`${wire.origin}/panel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({
      tabId: wire.tabId,
      title: 'Both open',
      format: 'markdown',
      content: '# Panel\n\nThis has to stay visible with the orchestrator open.',
    }),
  })

  console.log('\npanel alone')
  const alone = await settle(cdp, (r) => r.panel && r.panel.w > 100)
  if (!alone.panel || alone.panel.w < 100) fail(`the panel never opened (w=${alone.panel?.w})`)
  else pass(`panel is ${alone.panel.w}px beside ${alone.panes.w}px of terminal`)

  console.log('\nboth open')
  await cdp.eval(`window.__ember.orchestrator()`)
  const both = await settle(cdp, (r) => r.orch && r.orch.w > 200)

  if (!both.orch || both.orch.w < 200) fail(`the orchestrator did not take a column (w=${both.orch?.w})`)
  else pass(`orchestrator is ${both.orch.w}px wide`)

  const vsPanel = overlap(both.orch, both.panel)
  const vsPanes = overlap(both.orch, both.panes)
  if (vsPanel > 1) fail(`it overlaps the visualisation panel by ${vsPanel}px`)
  else pass('it does not overlap the visualisation panel')
  if (vsPanes > 1) fail(`it overlaps the terminal by ${vsPanes}px`)
  else pass('it does not overlap the terminal')

  // Not overlapping is satisfiable by a panel squeezed to nothing, so check the room
  // actually came from the stage and the panel survived it.
  if (both.panes.w >= alone.panes.w) fail(`the terminal did not shrink (${alone.panes.w} -> ${both.panes.w})`)
  else pass(`the terminal gave up the room: ${alone.panes.w} -> ${both.panes.w}px`)

  // Not-overlapping is satisfiable by a panel squeezed to a sliver, which is what the
  // first version of this layout did: technically correct, and 200px of a diagram.
  if (both.panel.w < 280) fail(`the visualisation panel was squeezed to ${both.panel.w}px — too narrow to read`)
  else pass(`the panel is still readable at ${both.panel.w}px`)
  if (both.panes.w < 240) fail(`the terminal was squeezed to ${both.panes.w}px`)
  else pass(`the terminal still has ${both.panes.w}px`)

  const total = both.sidebar.w + both.panes.w + both.panel.w + both.orch.w
  console.log(
    `  sidebar ${both.sidebar.w} | terminal ${both.panes.w} | panel ${both.panel.w} | orchestrator ${both.orch.w}  =  ${total} of ${both.win}`
  )

  console.log('\nclosing again')
  await cdp.eval(`window.__ember.orchestrator()`)
  const shut = await settle(cdp, (r) => r.orch && r.orch.w < 2)
  if (shut.orch.w > 2) fail(`closing left ${shut.orch.w}px behind`)
  else if (Math.abs(shut.panes.w - alone.panes.w) > 2) {
    fail(`the terminal did not get its width back (${alone.panes.w} -> ${shut.panes.w})`)
  } else pass('closing gives the width back')

  await cdp.eval(`window.__ember.orchestrator()`)
  await sleep(900)
  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`\nscreenshot -> ${out}`)

  cdp.close()
  child.kill()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join('').slice(-2000))
    process.exit(1)
  }
  console.log('LAYOUT OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join('').slice(-2000))
  child.kill()
  process.exit(1)
}
