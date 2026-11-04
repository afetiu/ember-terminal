#!/usr/bin/env node
/**
 * Drives a shown document in the direction it did not used to go: from the document back
 * into the terminal. Documents land on the tab's canvas, each in a frame of its own.
 *
 * Two claims, each checked where it can actually fail rather than where it is easy to
 * observe:
 *
 *   1. Pressing a button on an `ask` document puts its words on the shell's line — the
 *      whole chain (guest press → bridge → renderer → pty) has to work for them to be
 *      there — and, in a plain shell, does not run them: a document's buttons submit only
 *      into an agent.
 *   2. An `ember-type:` link fills the prompt without pressing Enter, which is read back
 *      out of the terminal grid rather than assumed.
 *
 * And the side panel's toggle (Ctrl+Shift+J) still opens and closes it. It used to also
 * cover dictation routing into panel fields, which went out with the Azure speech
 * subsystem, and picking an element in the side panel, which went once nothing a session
 * shows reaches that panel.
 *
 * The guest is its own DevTools target, so most of this is done through a second CDP
 * connection into the document's page — the same isolation that keeps model HTML away from
 * `window.ember` also keeps it out of reach of the host document's `querySelector`.
 *
 *   node scripts/probe-interact.mjs [outfile.png]
 */
import { execFileSync, spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { seedHome } from './probelib.mjs'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9353
const out = process.argv[2] ?? 'interact.png'
const MARK = join(EMBER_HOME, 'pressed.txt').replace(/\\/g, '/')
rmSync(MARK, { force: true })

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

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error(logs.join(''))
  child.kill()
  process.exit(1)
}
const pass = (msg) => console.log(`  ✓ ${msg}`)

async function targets() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list
}

async function hostTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await targets()).find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('DevTools endpoint never came up')
}

/** The panel's own page, found by the document URL the host says it is showing. */
async function guest(src) {
  for (let i = 0; i < 40; i++) {
    const t = (await targets()).find((t) => t.url === src)
    if (t) {
      const cdp = await Cdp.connect(t.webSocketDebuggerUrl)
      await cdp.send('Runtime.enable')
      // The runtime is at the end of the body, so a target that exists is not yet a
      // target that can answer.
      for (let j = 0; j < 40; j++) {
        if (await cdp.eval(`document.readyState === 'complete'`)) return cdp
        await sleep(150)
      }
      return cdp
    }
    await sleep(200)
  }
  fail(`the panel document ${src} never appeared as a debuggable target`)
}

/**
 * A real press on something inside a document: the runtime acts only on a trusted event
 * with a user activation (panelDoc's `live`), which a script's .click() is not. So the
 * element is found in the guest, its frame on the host, and the mouse goes down there.
 */
async function press(cdp, g, selector) {
  const inner = await g.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.scrollIntoView({ block: 'center' }); const r = e?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null })()`)
  const frame = await cdp.eval(`(() => { const f = [...document.querySelectorAll('.loom-piece iframe.loom-frame')].at(-1); const r = f?.getBoundingClientRect(); return r ? { x: r.left, y: r.top } : null })()`)
  if (!inner || !frame) return false
  const x = frame.x + inner.x
  const y = frame.y + inner.y
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return true
}

/** Does the window in the foreground belong to the Ember this probe launched? */
function foregroundIsOurs() {
  try {
    const ps = `Add-Type -Name Fg -Namespace Probe -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'; $p = 0; [void][Probe.Fg]::GetWindowThreadProcessId([Probe.Fg]::GetForegroundWindow(), [ref]$p); $p`
    const pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim())
    // The window is the browser process's; it is the probe's child, or the child's child.
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8' }).trim()
    return pid === child.pid || Number(out) === child.pid
  } catch {
    return false
  }
}

async function until(cdp, expression, ok, what, tries = 50) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

const ASK_MARK = 'ember-ask-probe-marker'
/** The newest document frame on the tab's canvas: every push lands there, as a piece. */
const frameSrc = `(() => { const f = [...document.querySelectorAll('.loom-piece iframe.loom-frame')].at(-1); return f?.getAttribute('src') ?? '' })()`

try {
  const page = await hostTarget()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3500)
  // A press in a document counts only while Ember's window has the focus (App.actHasGesture:
  // the frame must hold it and the window hold a user activation). Windows gives the
  // foreground only to the app the person is using, so a probe launched from a background
  // agent never has it: then the presses are skipped, and said so, rather than faked.
  await cdp.send('Page.bringToFront')
  await sleep(300)
  const canPress = foregroundIsOurs()
  const skip = (what) => console.log(`  - skip  ${what}  (the window does not have the foreground; run it from the desktop)`)

  const wire = await cdp.eval(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabId: document.querySelector('.ember-group')?.dataset.groupId ?? null
  }))()`)
  if (!wire.origin || !wire.tabId) fail(`no bridge or tab: ${JSON.stringify(wire)}`)

  const token = await readToken(cdp)
  if (!token) fail('the shell never reported EMBER_BRIDGE_TOKEN')
  // The canvas is drawn only while an agent runs; here it is shown by a stylesheet, as
  // Claude mode would show it, so its frames lay out and load like they do in use.
  await cdp.eval(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 760px !important; }'; document.head.appendChild(st); return true })()`)

  const push = async (body) => {
    const res = await fetch(`${wire.origin}/panel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({ tabId: wire.tabId, ...body }),
    })
    if (!res.ok) fail(`bridge rejected a push: ${res.status} ${await res.text()}`)
    return res.json()
  }

  // ---------- 1. a button on an ask panel runs a command ----------

  console.log('\nask panel')
  await push({
    title: 'Which one?',
    format: 'ask',
    content: 'Pick a side.',
    options: [
      { label: 'Write the mark', value: `echo ${ASK_MARK}`, hint: 'proves the chain' },
      { label: 'Do nothing', value: 'echo nothing' },
    ],
  })

  let src = await until(cdp, frameSrc, (v) => v.includes('/doc/'), 'ask panel never loaded')
  let g = await guest(src)

  const rendered = await g.eval(`({
    options: document.querySelectorAll('.ember-ask-opt').length,
    free: !!document.querySelector('[data-ember-free]'),
    hint: document.querySelector('.ember-ask-opt .hint')?.textContent ?? ''
  })`)
  if (rendered.options !== 2) fail(`ask card drew ${rendered.options} options, expected 2`)
  if (!rendered.free) fail('ask card has no free-text box')
  if (rendered.hint !== 'proves the chain') fail(`hint reads "${rendered.hint}"`)
  pass('ask card renders its options, hints and free-text box')

  if (!canPress) skip('pressing an option puts its words on the line; the card retires')
  else {
    if (!(await press(cdp, g, '.ember-ask-opt'))) fail('could not find the first option to press')

    // The whole chain (guest press → bridge → renderer → pty) has to work for the words to be
    // on the shell's line. They are not run: a document's buttons submit only into an agent
    // (App.actToSession), and this tab is a plain shell.
    const asked = await until(cdp, `window.__ember.sessions()[0].text`, (t) => String(t).includes(ASK_MARK), 'pressing a button in the document did not reach the shell')
    pass('pressing an option put its words on the shell\'s line')
    if (String(asked).split(ASK_MARK).length > 2) fail('the option was run, not just put on the line')
    else pass('and did not run them in a plain shell')
    // Clear the line again before the next check; the tab is still a plain shell.
    if ((await cdp.eval(`window.__ember.loom()?.mode`)) === 'shell') await cdp.eval(`window.ember.write(window.__ember.sessions()[0].id, '\\u0003')`)
    await sleep(600)

    const retired = await g.eval(`({
      answered: document.querySelector('.ember-ask')?.classList.contains('is-answered') ?? false,
      note: document.querySelector('.ember-ask-sent')?.textContent ?? ''
    })`)
    if (!retired.answered) fail('the answered card is still offering its buttons')
    if (!retired.note.includes(ASK_MARK)) fail(`the card does not show what was sent: "${retired.note}"`)
    pass('the answered card retires itself and shows what it sent')
  }

  // ---------- 2. ember-type: fills the prompt without submitting ----------

  console.log('\nfill-only link')
  const PHRASE = 'ember-fill-probe-marker'
  await push({
    title: 'Fill',
    format: 'markdown',
    content: `Try [this](ember-type:${PHRASE}) here.`,
    replace: true,
  })
  src = await until(cdp, frameSrc, (v) => v.includes('/doc/') && v !== src, 'fill panel never loaded')
  g.close()
  g = await guest(src)

  const btn = await g.eval(`(() => {
    const b = document.querySelector('[data-ember-send]')
    return b ? { send: b.getAttribute('data-ember-send'), submit: b.getAttribute('data-ember-submit') } : null
  })()`)
  if (btn?.send !== PHRASE) fail(`the link did not become a button: ${JSON.stringify(btn)}`)
  if (btn.submit !== '0') fail('ember-type produced a submitting button')
  pass('an ember-type link renders as a fill-only button')

  if (!canPress) skip('pressing it fills the prompt without Enter')
  else {
    if (!(await press(cdp, g, '[data-ember-send]'))) fail('could not find the fill button to press')
    await until(
      cdp,
      `window.__ember.sessions()[0].text`,
      (t) => String(t).includes(PHRASE),
      'the phrase never reached the prompt'
    )
    pass('the phrase is sitting in the prompt')
    // Nothing ran it: the shell is still at a prompt with the text on the line, so no
    // "command not found" ever appeared.
    const ran = await cdp.eval(`window.__ember.sessions()[0].text`)
    if (/not recognized|CommandNotFound/i.test(ran)) fail('the fill-only button pressed Enter')
    pass('and Enter was not pressed for it')
  }

  // ---------- the toggle ----------

  console.log('\npanel toggle')
  // The title bar has no panel button any more; Ctrl+Shift+J and Ctrl+K's "panel" row run this toggle.
  const wasOpen = (await cdp.eval(`window.__ember.panels()[0]?.open ?? false`)) === true
  await cdp.eval(`window.__ember.togglePanel()`)
  await until(cdp, `window.__ember.panels()[0]?.open ?? false`, (v) => v === !wasOpen, 'the toggle did not change the panel')
  await cdp.eval(`window.__ember.togglePanel()`)
  await until(cdp, `window.__ember.panels()[0]?.open ?? false`, (v) => v === wasOpen, 'a second toggle did not put it back')
  pass('the toggle opens and closes the panel')

  await sleep(600)
  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`\nscreenshot -> ${out}`)

  g.close()
  cdp.close()
  child.kill()
  console.log('INTERACT OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}

/** Read the bridge token out of the shell's own environment, where an MCP server finds it. */
async function readToken(cdp) {
  const file = join(EMBER_HOME, 'token.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
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
  return null
}
