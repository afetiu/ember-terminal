#!/usr/bin/env node
/**
 * The phone app itself, driven as a real page against a real desk.
 *
 * `probe-remote.mjs` proves the wire by standing in for the phone with a hand-written
 * client. That leaves the actual thing being shipped — `mobile/www/app.js`, the file
 * inside the APK — never once executed. A syntax error in it, a mis-wired button, an
 * element id that does not match the markup: all of that survives every other test here
 * and shows up as a blank screen on his phone, which is the one place it cannot be
 * debugged.
 *
 * So this loads the bundle in Chrome, which is the same engine as the Android WebView it
 * will run in, points it at a real headless Ember over the deployed relay, and asserts
 * what a person would look at: does it say it is connected, does typing produce an
 * answer, does the answer appear on screen.
 *
 * The call is deliberately out of scope. WebRTC to OpenAI needs a microphone and a real
 * conversation, and faking either would prove nothing about the thing being faked — the
 * path up to it is covered by the `secret` case in probe-remote.
 *
 *   node scripts/probe-phone.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { basename, extname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WWW = join(process.cwd(), 'mobile', 'www')
const WEB_PORT = 8794
const EMBER_PORT = 9369
const CHROME_PORT = 9370

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))
const realSecrets = join(homedir(), '.ember', 'secrets.json')
if (existsSync(realSecrets)) copyFileSync(realSecrets, join(EMBER_HOME, 'secrets.json'))

let failures = 0
const fail = (m) => {
  failures++
  console.error(`  x ${m}`)
}
const pass = (m) => console.log(`  + ${m}`)

// ---- serve the bundle, because ES modules will not load from file:// ----
//
// account.js is substituted rather than served from disk. The real one is generated at
// build time from whatever machine built the APK, so serving it would point this probe at
// the Ember actually running on the user's desk instead of the throwaway one it started — and
// it would pass while testing nothing it claims to.
let baked = null
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const web = createServer((req, res) => {
  const name = (req.url || '/').split('?')[0]
  if (name === '/account.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    return res.end(`export const BAKED = ${JSON.stringify(baked)}`)
  }
  const file = join(WWW, name === '/' ? 'index.html' : name.replace(/^\//, ''))
  if (!file.startsWith(WWW) || !existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
web.listen(WEB_PORT)

const ember = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${EMBER_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME },
})
const logs = []
ember.stdout.on('data', (d) => logs.push(String(d)))
ember.stderr.on('data', (d) => logs.push(String(d)))

const profile = join(tmpdir(), `ember-phone-probe-${Date.now()}`)
let chrome = { kill() {} }

/** Started only once the desk has an account, so the first load sees a real baked one. */
function startChrome() {
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--disable-gpu',
      // A phone-shaped viewport, so anything that only breaks when narrow breaks here too.
      '--window-size=390,844',
      `http://127.0.0.1:${WEB_PORT}/index.html`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  chrome.stderr.on('data', (d) => logs.push(`[chrome] ${d}`))
}

class Cdp {
  #ws
  #id = 0
  #pending = new Map()
  console = []

  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', rej, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      // Page errors are the whole reason this probe exists — a module that fails to parse
      // reports nothing to the DOM, it just never runs.
      if (msg.method === 'Runtime.exceptionThrown') {
        c.console.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception')
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        c.console.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '))
      }
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

async function target(port, match) {
  for (let i = 0; i < 70; i++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const t = list.find(match)
      if (t) return t
    } catch {
      /* not up yet */
    }
  }
  return null
}

/**
 * The bridge token, read out of a shell inside the app.
 *
 * Pushing a panel is an authenticated call and the token is per-run — it exists only in
 * the environment of the shells Ember spawned, so the only way to learn it is to ask one.
 * Same trick probe-layout uses.
 */
async function readBridgeToken(cdp) {
  const file = join(EMBER_HOME, 'tok.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, "/")}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const token = readFileSync(file, 'utf8').trim()
    if (token) return token
  }
  return ''
}

async function until(ok, ms = 20_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await ok()) return true
    await sleep(200)
  }
  return false
}

try {
  const deskPage = await target(EMBER_PORT, (t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
  const desk = await Cdp.connect(deskPage.webSocketDebuggerUrl)
  await desk.send('Runtime.enable')
  await sleep(3500)

  // The account exists before the app is ever loaded, exactly as it does in a real
  // build, where sync.mjs writes it in before Gradle packages anything.
  const account = await desk.eval(`window.__ember.pairNow()`)
  baked = { relay: account.relay, key: account.key }
  startChrome()

  const phonePage = await target(CHROME_PORT, (t) => t.type === 'page' && t.url.includes('index.html'))
  if (!phonePage) {
    fail('the phone bundle never loaded in Chrome')
    throw new Error('no phone page')
  }
  const phone = await Cdp.connect(phonePage.webSocketDebuggerUrl)
  await phone.send('Runtime.enable')

  // Waited for, not slept on. A target shows up in the list the moment navigation starts,
  // so evaluating too early reads the empty initial document and every element comes back
  // null — which reads as "the markup is wrong" rather than "the page is not there yet".
  const parsed = await until(async () => {
    try {
      return await phone.eval(`document.readyState === 'complete' && !!document.getElementById('pair')`)
    } catch {
      return false
    }
  }, 20_000)

  console.log('\nthe app comes up')
  if (!parsed) {
    fail('the page never finished loading')
    throw new Error('page never loaded')
  }
  if (phone.console.length) fail(`the page reported an error on load: ${phone.console[0]}`)
  else pass('it loads with no script errors')

  // The thing the user actually asked for: install it, and it already knows his machines.
  // A fresh profile, nothing in storage, and it must not ask him for anything.
  const asked = await phone.eval(`document.getElementById('pair').classList.contains('is-on')`)
  if (asked) fail('it asked to be paired even though the build carries the account')
  else pass('a fresh install asks for nothing — the account came with the build')

  await phone.send('Page.enable')

  // The list is the feature. It has to show the machine by name, not by id.
  const listed = await until(
    async () => await phone.eval(`document.querySelectorAll('#devlist .dev').length > 0`),
    30_000
  )
  if (!listed) fail('the machine never appeared in the list on the phone')
  else {
    const name = await phone.eval(`document.querySelector('#devlist .devname')?.textContent ?? ''`)
    if (!String(name).trim()) fail('the machine is listed with no name')
    else pass(`it lists the machine by name: "${name}"`)
  }

  if (!(await until(async () => await phone.eval(`document.getElementById('talk').classList.contains('is-on')`), 12_000))) {
    // Nothing used before, so pick it by hand — which is the first-run path anyway.
    await phone.eval(`document.querySelector('#devlist .dev').click()`)
  }
  if (!(await until(async () => await phone.eval(`document.getElementById('talk').classList.contains('is-on')`), 15_000))) {
    fail('choosing a machine never opened the conversation')
  } else pass('choosing one opens the conversation')

  const headerName = await phone.eval(`document.getElementById('devname').textContent`)
  if (!String(headerName).trim() || headerName === 'Ember') {
    fail('the conversation does not say which machine it is talking to')
  } else pass(`and says which machine it is on: "${headerName}"`)

  const connected = await until(
    async () => (await phone.eval(`document.getElementById('status').textContent`)) === 'connected',
    30_000
  )
  const status = await phone.eval(`document.getElementById('status').textContent`)
  if (!connected) fail(`it never reported a live machine — it says "${status}"`)
  else pass('it finds the machine and says so')

  if (!(await until(async () => await desk.eval(`window.__ember.remote().phoneHere`), 15_000))) {
    fail('the machine did not see the phone app')
  } else pass('and the machine sees it')

  // ---- the thing he will actually do ----
  console.log('\ntyping to it')
  await phone.eval(`(() => {
    const box = document.getElementById('box')
    box.value = 'In one short sentence: how many Claude sessions are open?'
    document.getElementById('send').click()
  })()`)

  if (!(await until(async () => await phone.eval(`document.querySelectorAll('#log .turn.is-you').length > 0`), 10_000))) {
    fail('what was typed never appeared in the log')
  } else pass('what he types appears immediately')

  const answered = await until(
    async () => await phone.eval(`document.querySelectorAll('#log .turn.is-agent:not(.is-thinking)').length > 0`),
    200_000
  )
  if (!answered) fail('no answer ever arrived from the laptop')
  else {
    const text = await phone.eval(
      `document.querySelector('#log .turn.is-agent:not(.is-thinking) .text')?.textContent ?? ''`
    )
    if (!String(text).trim()) fail('the answer bubble rendered empty')
    else pass(`it showed the answer: "${String(text).slice(0, 80)}"`)
  }

  // ---- the failure he will actually hit ----
  // ---- the visualisation panel ----
  //
  // The claim is not "an iframe appeared". It is that the *same document the desk renders*
  // arrives on the phone and runs: a mermaid fence has to become an actual diagram, which
  // means the 3.5MB script bundled into the app was found and executed inside a frame that
  // has no origin of its own. That is the part that can plausibly fail, and it fails
  // invisibly — the panel would simply show the diagram's source text instead.
  console.log('\nthe panel')
  const token = await readBridgeToken(desk)
  const origin = await desk.eval(`window.ember.panel.origin()`)
  const tabId = await desk.eval(`window.__ember.activeTab()`)
  if (!token) fail(`no bridge token, so nothing can be pushed to the panel`)

  await fetch(`${origin}/panel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({
      tabId,
      title: 'Deploy path',
      format: 'mermaid',
      content: 'graph LR\\n  Phone --> Relay\\n  Relay --> Laptop\\n  Laptop --> Claude',
    }),
  })

  const opened = await until(
    async () => await phone.eval(`document.getElementById('panel').classList.contains('is-on')`),
    25_000
  )
  if (!opened) fail('a panel pushed on the laptop never appeared on the phone')
  else pass('a panel pushed on the laptop opens on the phone by itself')

  const shownTitle = await phone.eval(`document.getElementById('paneltitle').textContent`)
  if (shownTitle !== 'Deploy path') fail(`the panel is titled "${shownTitle}"`)
  else pass(`and carries its title: "${shownTitle}"`)

  // Inside the frame. It is sandboxed without same-origin, so this reads it through the
  // frame's own execution context rather than from the host document.
  const drew = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json()
    const guest = targets.find((t) => t.url === 'about:srcdoc')
    if (!guest?.webSocketDebuggerUrl) return false
    try {
      const c = await Cdp.connect(guest.webSocketDebuggerUrl)
      await c.send('Runtime.enable')
      const ok = await c.eval(`document.querySelectorAll('svg').length > 0`)
      c.close()
      return ok
    } catch {
      return false
    }
  }, 45_000)
  if (!drew) fail('the diagram never rendered — mermaid did not run inside the sandboxed frame')
  else pass('the diagram actually renders, from the copy bundled in the app')

  // Dismissing must not lose it, or a glance at the conversation costs him the diagram.
  await phone.eval(`document.getElementById('panelclose').click()`)
  await sleep(400)
  const hidden = await phone.eval(`!document.getElementById('panel').classList.contains('is-on')`)
  const recall = await phone.eval(`!document.getElementById('panelshow').classList.contains('is-hidden')`)
  if (!hidden) fail('closing the panel did not close it')
  else if (!recall) fail('closing the panel lost it — there is no way back to the diagram')
  else pass('closing it leaves a way back to it')
  console.log('\nwhen Ember is not running')
  await desk.eval(`window.__ember.remoteStop()`)
  const toldHim = await until(async () => {
    const s = await phone.eval(`document.getElementById('status').textContent`)
    return String(s).includes('not running')
  }, 20_000)
  if (!toldHim) {
    const s = await phone.eval(`document.getElementById('status').textContent`)
    fail(`with the machine gone it says "${s}" instead of saying so plainly`)
  } else pass('it says the machine is not running rather than appearing to hang')

  const locked = await phone.eval(`document.getElementById('send').disabled && document.getElementById('call').disabled`)
  if (!locked) fail('it still offers to send and call with nothing on the other end')
  else pass('and stops offering to send or call')

  // ---- the way in for a build that carries no account ----
  //
  // Still has to work: it is what a second phone uses, and what any build made on a
  // machine that has not joined yet produces. Easy to break precisely because the happy
  // path no longer goes anywhere near it.
  console.log('\nsigning out')
  await phone.eval(`(() => { localStorage.clear(); localStorage.setItem('ember.left', 'true') })()`)
  await phone.send('Page.reload')
  await sleep(2500)
  const backToJoin = await until(
    async () => await phone.eval(`document.getElementById('pair').classList.contains('is-on')`),
    15_000
  )
  if (!backToJoin) fail('after leaving, it silently signed itself back in with the baked account')
  else pass('leaving takes him to the join screen rather than signing him back in')

  const explains = await phone.eval(`document.querySelector('#pair .lede')?.textContent ?? ''`)
  if (!String(explains).includes('Ctrl+K')) fail('the join screen does not say where to find the code')
  else pass('and that screen says where to get a code')

  if (phone.console.length) console.log(`  page errors: ${JSON.stringify(phone.console).slice(0, 300)}`)

  phone.close()
  desk.close()
  chrome.kill()
  ember.kill()
  web.close()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join('').slice(-1500))
    process.exit(1)
  }
  console.log('\nPHONE OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join('').slice(-1500))
  chrome.kill()
  ember.kill()
  web.close()
  process.exit(1)
}
