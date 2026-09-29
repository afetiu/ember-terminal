#!/usr/bin/env node
/**
 * Drives the panel in the direction it did not used to go: from the panel back into
 * the terminal.
 *
 * Three claims, each checked where it can actually fail rather than where it is easy to
 * observe:
 *
 *   1. Pressing a button on an `ask` panel runs a command in the shell. Proved by
 *      having the button's value *be* a command that writes a file — the whole chain
 *      (guest click → bridge → renderer → pty → pwsh) has to work for the file to exist.
 *   2. An `ember-type:` link fills the prompt without pressing Enter, which is read back
 *      out of the terminal grid rather than assumed.
 *   3. Picking an element gives Ember the element's text, and sending composes the two
 *      into one line.
 *
 * It used to also cover dictation routing into panel fields. That went out with the
 * Azure speech subsystem the orchestrator replaced.
 *
 * The guest is its own DevTools target, so most of this is done through a second CDP
 * connection into the panel's page — the same isolation that keeps model HTML away from
 * `window.ember` also keeps it out of reach of the host document's `querySelector`.
 *
 *   node scripts/probe-interact.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9353
const out = process.argv[2] ?? 'interact.png'
const MARK = join(EMBER_HOME, 'pressed.txt').replace(/\\/g, '/')
rmSync(MARK, { force: true })

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

async function until(cdp, expression, ok, what, tries = 50) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

const frameSrc = `document.querySelector('.ember-panel-frame')?.getAttribute('src') ?? ''`

try {
  const page = await hostTarget()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3500)

  const wire = await cdp.eval(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabId: document.querySelector('.ember-group')?.dataset.groupId ?? null
  }))()`)
  if (!wire.origin || !wire.tabId) fail(`no bridge or tab: ${JSON.stringify(wire)}`)

  const token = await readToken(cdp)
  if (!token) fail('the shell never reported EMBER_BRIDGE_TOKEN')

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
      { label: 'Write the mark', value: `'pressed' | Set-Content -Encoding utf8 '${MARK}'`, hint: 'proves the chain' },
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

  await g.eval(`document.querySelectorAll('.ember-ask-opt')[0].click()`)

  for (let i = 0; i < 60 && !existsSync(MARK); i++) await sleep(250)
  if (!existsSync(MARK)) fail('pressing a panel button did not reach the shell — no mark file')
  if (!readFileSync(MARK, 'utf8').includes('pressed')) fail('the mark file has the wrong contents')
  pass('pressing an option ran the command in the shell')

  const retired = await g.eval(`({
    answered: document.querySelector('.ember-ask')?.classList.contains('is-answered') ?? false,
    note: document.querySelector('.ember-ask-sent')?.textContent ?? ''
  })`)
  if (!retired.answered) fail('the answered card is still offering its buttons')
  if (!retired.note.includes('Set-Content')) fail(`the card does not show what was sent: "${retired.note}"`)
  pass('the answered card retires itself and shows what it sent')

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

  await g.eval(`document.querySelector('[data-ember-send]').click()`)
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

  // ---------- 3. picking an element ----------

  console.log('\npicking')
  await push({
    title: 'Cars',
    format: 'markdown',
    content: '| Car | Year | Price |\n| --- | --- | --- |\n| Ford Focus | 2014 | 4500 |\n| Golf | 2016 | 7200 |\n',
    replace: true,
  })
  src = await until(cdp, frameSrc, (v) => v.includes('/doc/') && v !== src, 'table panel never loaded')
  g.close()
  g = await guest(src)

  await cdp.eval(`document.querySelector('.ember-panel-btn.is-pick').click()`)
  await until(cdp, `window.__ember.panels()[0].picking`, (v) => v === true, 'pick mode never armed')
  await until(g, `!!window.__emberPick`, (v) => v === true, 'the picker was never injected into the guest')
  pass('pick mode arms and injects into the guest')

  // A click on a cell, which the picker is supposed to read as a click on its row.
  await g.eval(`(() => {
    const cell = document.querySelectorAll('tbody tr')[1].children[0]
    const r = cell.getBoundingClientRect()
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }))
  })()`)

  const popped = await until(
    cdp,
    `(() => { const p = document.querySelector('.ember-panel')
       return { open: p.classList.contains('has-pick'),
                what: p.querySelector('.ember-pick-what')?.textContent ?? '',
                quote: p.querySelector('.ember-pick-quote')?.textContent ?? '',
                picking: window.__ember.panels()[0].picking } })()`,
    (v) => v.open,
    'the popover never opened after a pick'
  )
  if (!popped.quote.includes('Golf') || !popped.quote.includes('7200')) fail(`the quote reads "${popped.quote}"`)
  if (!popped.quote.includes('|')) fail('a row was not read cell by cell')
  if (popped.what !== 'row 2') fail(`the pick is named "${popped.what}", expected "row 2" — headers are not rows`)
  if (popped.picking) fail('pick mode stayed armed after a pick')
  pass(`picking a cell selects its row — "${popped.what}: ${popped.quote}"`)

  // ---------- sending composes the pick with what was typed ----------
  await cdp.eval(`document.querySelector('.ember-pick-box').value = 'is this one worth it'`)

  await cdp.eval(`document.querySelector('.ember-pick-send').click()`)
  const line = await until(
    cdp,
    `window.__ember.sessions()[0].text`,
    (t) => String(t).includes('is this one worth it'),
    'the composed selection never reached the terminal'
  )
  if (!/Golf/.test(line)) fail('the composed line does not quote what was picked')
  pass('sending composes what was picked with what was said')

  await until(
    cdp,
    `document.querySelector('.ember-panel').classList.contains('has-pick')`,
    (v) => v === false,
    'the popover stayed open after sending'
  )
  pass('the popover closes after sending')

  // ---------- the toggle ----------

  console.log('\npanel toggle')
  await cdp.eval(`document.querySelector('.ember-paneltoggle').click()`)
  await until(cdp, `window.__ember.panels()[0].open`, (v) => v === false, 'the title-bar toggle did not hide the panel')
  const marked = await cdp.eval(`document.querySelector('.ember-paneltoggle').classList.contains('has-unseen')`)
  if (!marked) fail('a hidden panel with content on it is not marked as unseen')
  await cdp.eval(`document.querySelector('.ember-paneltoggle').click()`)
  await until(cdp, `window.__ember.panels()[0].open`, (v) => v === true, 'the toggle did not bring the panel back')
  pass('the title-bar button hides and shows the panel, and marks unseen content')

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
