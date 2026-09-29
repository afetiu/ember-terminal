import { join, basename } from 'node:path'
/**
 * Drives the v2 visualisation panel the way a Claude session would: start Ember with
 * the panel on, read the tab id and the bridge token out of the running app, POST a
 * markdown panel, a diagram and a URL, and check each one actually arrives on screen.
 *
 * The POSTs go over real HTTP with the real token, so this exercises the same path the
 * MCP server takes — the only thing stubbed out is Claude deciding to call it.
 *
 *   node scripts/probe-panel.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync as write } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
// The panel only exists in v2, and the probe must not depend on the user's own config.
write(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9351
const out = process.argv[2] ?? 'panel.png'

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

/** Wait until a predicate over an evaluated value holds, rather than guessing a delay. */
async function until(cdp, expression, ok, what, tries = 40) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

try {
  const page = await target()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3000)

  // The panel exists but takes no space until something is put on it.
  const initial = await until(
    cdp,
    `(() => { const p = document.querySelector('.ember-panel')
       if (!p) return null
       const b = p.getBoundingClientRect()
       return { w: Math.round(b.width), open: p.classList.contains('is-open') } })()`,
    (v) => v !== null,
    'no .ember-panel in a v2 tab'
  )
  console.log('panel at rest:', JSON.stringify(initial))
  if (initial.w > 2) fail(`panel starts ${initial.w}px wide, expected collapsed`)
  if (initial.open) fail('panel starts open')

  // The shell in the tab must have been handed bridge coordinates.
  const env = await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    return { id: s?.id ?? null }
  })()`)
  if (!env.id) fail('no session in the first tab')

  // Read the tab id and the token the way nothing but a probe can: out of main.
  const wire = await cdp.eval(`(async () => {
    const origin = await window.ember.panel.origin()
    const tabId = document.querySelector('.ember-group')?.dataset.groupId ?? null
    return { origin, tabId }
  })()`)
  console.log('wire:', JSON.stringify(wire))
  if (!wire.origin) fail('bridge never came up — panel.origin() was empty')
  if (!wire.tabId) fail('no group id to address')

  const token = await readToken(cdp)
  if (!token) fail('the shell never reported EMBER_BRIDGE_TOKEN')
  await checkShim(cdp)
  await checkShimArgv(cdp)

  const push = async (body) => {
    const res = await fetch(`${wire.origin}/panel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({ tabId: wire.tabId, ...body }),
    })
    if (!res.ok) fail(`bridge rejected a push: ${res.status} ${await res.text()}`)
    return res.json()
  }

  // An unauthenticated push must be refused.
  const noToken = await fetch(`${wire.origin}/panel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: wire.tabId, title: 'x', format: 'markdown', content: 'x' }),
  })
  if (noToken.status !== 401) fail(`bridge accepted a push with no token (${noToken.status})`)

  await push({ title: 'Estate', format: 'markdown', content: '# Estate\n\n- pika\n- neutron\n' })

  const opened = await until(
    cdp,
    `(() => { const p = document.querySelector('.ember-panel')
       const b = p.getBoundingClientRect()
       return { w: Math.round(b.width), open: p.classList.contains('is-open'),
                title: p.querySelector('.ember-panel-title')?.textContent ?? '' } })()`,
    (v) => v.open && v.w > 200,
    'panel did not spring open on the first push'
  )
  console.log('after push:', JSON.stringify(opened))
  if (opened.title !== 'Estate') fail(`panel title is "${opened.title}", expected "Estate"`)

  // The terminal must have given up exactly the width the panel took, not been covered.
  // Once it has landed: the panel travels as an overlay and only takes its place in the
  // flow when the spring settles, so this is waited for rather than sampled mid-flight.
  const layout = await until(
    cdp,
    `(() => {
      const panes = document.querySelector('.ember-group-panes').getBoundingClientRect()
      const panel = document.querySelector('.ember-panel').getBoundingClientRect()
      return { panesRight: Math.round(panes.right), panelLeft: Math.round(panel.left) }
    })()`,
    (v) => Math.abs(v.panesRight - v.panelLeft) <= 2,
    'panel overlaps the terminal instead of sitting beside it'
  )
  console.log('layout:', JSON.stringify(layout))

  // The document really rendered inside the webview, mermaid and all.
  await push({ title: 'Flow', format: 'mermaid', content: 'graph TD; A[Ember] --> B[Panel]; B --> C[Claude]' })
  await sleep(2500)
  const diagram = await cdp.eval(`(() => {
    const wv = document.querySelector('.ember-panel-frame')
    return { title: document.querySelector('.ember-panel-title')?.textContent ?? '', src: wv?.getAttribute('src') ?? '' }
  })()`)
  console.log('diagram:', JSON.stringify(diagram))
  if (diagram.title !== 'Flow') fail('panel did not switch to the diagram')
  if (!diagram.src.includes('/doc/')) fail(`panel is not loading a bridge document (${diagram.src})`)

  // Look inside the panel's own page: a diagram that renders as its own source text is
  // the failure this check exists for, and it is invisible from the host document.
  const inside = await inspectDoc(diagram.src)
  console.log('inside the panel:', JSON.stringify(inside))
  if (inside.mermaidGlobal !== 'object') fail(`mermaid did not load in the panel (typeof window.mermaid = ${inside.mermaidGlobal})`)
  if (!inside.svgs) fail('the diagram never rendered — no <svg> in the panel document')
  if (inside.fellBack) fail('the diagram fell back to showing its own source')

  // A url push turns the panel into a browser, address bar and all.
  await push({ title: 'Docs', format: 'url', content: 'https://example.com', replace: true })
  const browsing = await until(
    cdp,
    `(() => { const p = document.querySelector('.ember-panel')
       return { browsing: p.classList.contains('is-browsing'),
                address: p.querySelector('.ember-panel-address')?.value ?? '' } })()`,
    (v) => v.browsing,
    'url push did not switch the panel into browser mode'
  )
  console.log('browsing:', JSON.stringify(browsing))
  if (!browsing.address.includes('example.com')) fail(`address bar shows "${browsing.address}"`)

  // Clearing empties and collapses it again.
  await fetch(`${wire.origin}/panel/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({ tabId: wire.tabId }),
  })
  const cleared = await until(
    cdp,
    `(() => { const p = document.querySelector('.ember-panel')
       return { w: Math.round(p.getBoundingClientRect().width), open: p.classList.contains('is-open') } })()`,
    (v) => !v.open && v.w < 3,
    'panel did not collapse after clear'
  )
  console.log('cleared:', JSON.stringify(cleared))

  // The first push into a brand new tab, before anything has built that tab's panel.
  //
  // This is the "blank the first time" case: the panel is constructed by the push
  // itself, so it is asking main where the bridge is at the moment it is asked to show
  // a document. It used to navigate to `/doc/<id>` with no origin in front of it, drop
  // the navigation for not being an http url, and sit there empty until a second push.
  const freshTab = await cdp.eval(`window.__ember.newTab()`)
  const fresh = await fetch(`${wire.origin}/panel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({ tabId: freshTab, title: 'First', format: 'markdown', content: '# First\n\nStraight into a new tab.' }),
  })
  if (!fresh.ok) fail(`bridge rejected the push into a fresh tab: ${fresh.status}`)
  const first = await until(
    cdp,
    `(() => { const p = document.querySelector('.ember-panel[data-tab-id="${freshTab}"]')
       if (!p) return { panel: false }
       const f = p.querySelector('.ember-panel-frame')
       const e = p.querySelector('.ember-panel-empty')
       return { panel: true, open: p.classList.contains('is-open'),
                src: f?.getAttribute('src') ?? '',
                empty: e ? getComputedStyle(e).display !== 'none' : false,
                title: p.querySelector('.ember-panel-title')?.textContent ?? '' } })()`,
    (v) => v.panel && v.src.includes('/doc/'),
    'the first push into a fresh tab left the panel blank'
  )
  console.log('first push into a fresh tab:', JSON.stringify(first))
  if (first.empty) fail('the panel is showing its empty placeholder after a push')
  if (first.title !== 'First') fail(`the fresh panel is titled "${first.title}"`)
  await cdp.eval(`window.__ember.closeTab(${JSON.stringify(freshTab)})`)
  await sleep(400)
  await cdp.eval(`window.__ember.activate(${JSON.stringify(wire.tabId)})`)
  await sleep(400)

  // Leave the screenshot on something worth looking at, and wait for the diagram to
  // exist rather than for a number of milliseconds — the first mermaid load is a 3MB
  // parse and any fixed delay is either a flake or a waste.
  await push({
    title: 'Estate',
    format: 'markdown',
    content:
      '# Estate\n\nWhat a session can put here.\n\n' +
      '```mermaid\ngraph LR\n  A[Claude in a tab] -->|show_panel| B[Bridge]\n  B --> C[Panel]\n```\n\n' +
      '| Repo | State |\n| --- | --- |\n| pika | scaled to 0 |\n| neutron | scaled to 0 |\n',
  })
  const finalSrc = await until(
    cdp,
    `document.querySelector('.ember-panel-frame')?.getAttribute('src') ?? ''`,
    (v) => v.includes('/doc/'),
    'final panel never loaded'
  )
  await inspectDoc(finalSrc)

  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot ->', out)

  cdp.close()
  child.kill()
  console.log('PANEL OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}

/**
 * Read the token out of the shell's own environment — exactly where a real MCP server
 * finds it, so this doubles as the check that the variable is inherited at all.
 *
 * Via a file rather than the screen: the grid is drawn by WebGL, so there is no DOM
 * text to scrape and `innerText` on the terminal is always empty.
 */
async function readToken(cdp) {
  const file = join(EMBER_HOME, 'token.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_TAB_ID|$env:EMBER_BRIDGE_TOKEN|$($env:EMBER_MCP_CONFIG)" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const [tab, token, mcp] = readFileSync(file, 'utf8').trim().split('|')
    if (!token) continue
    console.log(`shell env: tab=${tab} mcpConfig=${mcp ? 'set' : 'MISSING'}`)
    if (!tab) fail('the shell did not inherit EMBER_TAB_ID')
    if (!mcp) fail('the shell did not inherit EMBER_MCP_CONFIG, so the claude shim would be a no-op')
    return token
  }
  return null
}

/**
 * Attach to the panel's guest page and report what it made of the document.
 *
 * The webview is its own DevTools target — deliberately, since that isolation is what
 * keeps model-authored HTML away from the app — so nothing about it can be read from
 * the host page and it has to be inspected as a separate connection.
 */
/**
 * Look inside the panel's own page and wait for it to have actually finished.
 *
 * The patience here is the point. Mermaid is a 3.5MB script that then lays out a diagram,
 * and the first version of this gave up after about five seconds and reported whatever it
 * happened to see — which, once the app grew more to do at startup, became "mermaid did
 * not load" on a build where mermaid loads perfectly well. A probe that reports a
 * regression that is really its own stopwatch costs more than no probe.
 */
async function inspectDoc(url) {
  for (let i = 0; i < 75; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const guest = list.find((t) => t.url === url)
    if (guest?.webSocketDebuggerUrl) {
      const c = await Cdp.connect(guest.webSocketDebuggerUrl)
      await c.send('Runtime.enable')
      const state = await c.eval(`(() => ({
        mermaidGlobal: typeof window.mermaid,
        blocks: document.querySelectorAll('pre.mermaid').length,
        fellBack: document.querySelectorAll('pre.code').length,
        svgs: document.querySelectorAll('svg').length,
      }))()`)
      c.close()
      if (state.svgs && state.mermaidGlobal === 'object') return state
      if (i === 74) return state
    }
    await sleep(400)
  }
  fail(`never found the panel document at ${url} in the target list`)
}

/** The shim must shadow `claude` in an Ember shell, and only there. */
async function checkShim(cdp) {
  const file = join(EMBER_HOME, 'shim.txt')
  rmSync(file, { force: true })
  const line = `(Get-Command claude -ErrorAction SilentlyContinue).CommandType | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const kind = readFileSync(file, 'utf8').trim()
    if (!kind) continue
    console.log(`claude resolves to: ${kind}`)
    if (kind !== 'Function') fail(`claude is a ${kind} in an Ember shell, so the panel MCP server is never added`)
    return
  }
  fail('never learned what `claude` resolves to')
}

/**
 * What the shim actually hands the real `claude`, read as argv rather than as intent.
 *
 * This exists because of a specific bug. The shim once added `--append-system-prompt`
 * with a paragraph of English behind it; `claude` on this machine is `claude.cmd`, so
 * cmd.exe re-parsed every argument, the `"show me"` inside that paragraph closed the
 * quoted region, and the tail arrived as a *positional* argument — which Claude Code
 * treats as the initial prompt. Every session opened by answering half a sentence
 * nobody typed.
 *
 * Reading the flags back is the only check that catches that class of thing: the shim
 * still parses, the shell still works, and nothing looks wrong until a session starts
 * talking to itself. A stub earlier on PATH than the real CLI is what makes argv
 * observable without running Claude.
 */
async function checkShimArgv(cdp) {
  const dir = join(EMBER_HOME, 'argv')
  mkdirSync(dir, { recursive: true })
  const dump = join(dir, 'argv.txt')
  rmSync(dump, { force: true })

  write(
    join(dir, 'dump.mjs'),
    `import { writeFileSync } from 'node:fs'\n` +
      `writeFileSync(${JSON.stringify(dump.replace(/\\/g, '/'))}, JSON.stringify(process.argv.slice(2)), 'utf8')\n`
  )
  // A .cmd, deliberately: it is what `claude` really is here, and the double parse is
  // the whole hazard being tested for.
  write(join(dir, 'claude.cmd'), `@echo off\r\nnode "${join(dir, 'dump.mjs')}" %*\r\n`)

  const line = `$env:PATH = '${dir.replace(/\\/g, '/')};' + $env:PATH; claude --resume --verbose`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)

  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (!existsSync(dump)) continue
    let argv
    try {
      argv = JSON.parse(readFileSync(dump, 'utf8'))
    } catch {
      continue
    }
    console.log('shim argv:', JSON.stringify(argv))

    // What Ember is allowed to put in front of the user's own flags: the panel's MCP
    // server, and — when the status line is on — the settings file that reports back.
    // Both are `--flag <file>` pairs; anything else in front is the bug this guards.
    const mine = { '--mcp-config': 'mcp-panel.json', '--settings': 'ember-settings.json' }
    let i = 0
    while (argv[i] in mine) {
      const file = String(argv[i + 1] ?? '')
      if (!file.endsWith(mine[argv[i]])) fail(`${argv[i]} points at ${file}`)
      i += 2
    }
    if (!argv.slice(0, i).includes('--mcp-config')) fail(`the shim did not pass --mcp-config: ${JSON.stringify(argv)}`)
    const rest = argv.slice(i)
    const expected = ['--resume', '--verbose']
    if (rest.length !== expected.length || rest.some((a, n) => a !== expected[n])) {
      fail(`the shim passed ${JSON.stringify(argv)} — anything beyond its own flag pairs and the user's own flags is a bug`)
    }
    // The failure that started this: a stray positional would sit after the flags and
    // be read as a prompt.
    const stray = rest.filter((a) => !a.startsWith('-'))
    if (stray.length) fail(`the shim added a positional argument, which Claude Code reads as a prompt: ${JSON.stringify(stray)}`)
    return
  }
  fail('the stub claude was never called, so the shim could not be read')
}
