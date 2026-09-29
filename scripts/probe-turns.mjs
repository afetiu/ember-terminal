#!/usr/bin/env node
/**
 * One request gets one answer.
 *
 * the user's report was that the orchestrator "responds two or three times for the same
 * thing", and the screenshot showed four spoken turns restating one dispatch. That was
 * ours, not the model's: every tool result sent its own `response.create`, so a turn that
 * used three tools asked OpenAI for three replies — and each one, having only the
 * conversation to go on, said roughly what the last one said.
 *
 * This drives the event path in `resources/realtime/rtc.js` directly and counts the
 * `response.create` events we emit. It cannot be tested against a live call: that needs a
 * microphone, a paid session, and a model whose choices are not repeatable. What is being
 * asserted here is not what the model says — it is how many times we ask it to speak,
 * which is the half that was broken.
 *
 * The failure direction that matters is silence. Over-suppressing gates every reply and
 * looks identical to a slow model from the outside, so every case that asserts "no reply
 * yet" is followed by one asserting the reply does arrive.
 *
 *   node scripts/probe-turns.mjs
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))

const PORT = 9366

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  // The diagnostic hook in the realtime page exists only under this flag.
  env: { ...process.env, EMBER_HOME, EMBER_PROBE: '1' },
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

/** A completed function_call output item, the shape a tool actually arrives in. */
const toolItem = (n) =>
  JSON.stringify({
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'list_sessions', call_id: `call_${n}`, arguments: '{}' },
  })

try {
  // ---- the renderer, so the app is up and has opened the realtime frame ----
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
  const app = await Cdp.connect(page.webSocketDebuggerUrl)
  await app.send('Runtime.enable')
  await sleep(3500)

  // ---- the realtime page itself ----
  //
  // A separate CDP target rather than an eval in the renderer: the frame is on the
  // bridge's origin, which is the whole point of it, so the renderer cannot reach into it.
  let frame
  for (let i = 0; i < 40 && !frame; i++) {
    await sleep(400)
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    frame = list.find((t) => t.url.endsWith('/realtime'))
  }
  if (!frame) {
    fail('the realtime frame never loaded, so there is nothing to test')
    throw new Error('no realtime frame')
  }
  const rtc = await Cdp.connect(frame.webSocketDebuggerUrl)
  await rtc.send('Runtime.enable')

  const hooked = await rtc.eval('!!window.__rtc')
  if (!hooked) {
    fail('no diagnostic hook — EMBER_PROBE did not reach the bridge')
    throw new Error('no hook')
  }
  pass('driving the realtime page directly')

  const reset = () => rtc.eval('window.__rtc.reset()')
  const feed = (json) => rtc.eval(`window.__rtc.feed(${json})`)
  const creates = () => rtc.eval('window.__rtc.creates()')
  const state = () => rtc.eval('JSON.stringify(window.__rtc.state())')

  /**
   * Answer a tool call, and insist it was a real one.
   *
   * Without the check this probe lies in the direction it is meant to catch: an answer
   * addressed to an id that does not exist is a no-op, the reply count stays at zero, and
   * every "it has not spoken yet" assertion passes for the wrong reason. That is exactly
   * what happened on the first run here, when the call ids carried over between blocks.
   */
  const answer = async (id, text) => {
    const landed = await rtc.eval(`window.__rtc.answer('${id}', ${JSON.stringify(text)})`)
    if (!landed) fail(`answered ${id}, which was not an outstanding call — the test is wrong`)
  }

  // ---------------------------------------------------------------- one tool
  console.log('\na turn that uses one tool')
  await reset()
  await feed(`{ type: 'response.created' }`)
  await feed(toolItem(1))
  await feed(`{ type: 'response.done' }`)
  if ((await creates()) !== 0) fail('it asked for a reply before the tool had answered')
  else pass('nothing is said while the tool is still running')

  await answer('a1', 'two sessions, both idle')
  const one = await creates()
  if (one !== 1) fail(`answering one tool asked for ${one} replies, expected exactly 1`)
  else pass('answering it asks for exactly one reply')

  // ---------------------------------------------------------------- fan-out
  //
  // The reported bug. Three tools in one turn used to mean three spoken replies, each
  // restating the last — which is precisely the screenshot the user sent.
  console.log('\na turn that uses three tools')
  await reset()
  await feed(`{ type: 'response.created' }`)
  await feed(toolItem(1))
  await feed(toolItem(2))
  await feed(toolItem(3))
  await feed(`{ type: 'response.done' }`)

  await answer('a1', 'g1 idle, g2 working')
  await answer('a2', 'ventures is at C:/Users/afeti/ventures')
  const partial = await creates()
  if (partial !== 0) fail(`it replied ${partial} time(s) with a tool still outstanding`)
  else pass('two of three answered, and it has not spoken yet')

  await answer('a3', 'started g4')
  const all = await creates()
  if (all !== 1) fail(`three tools produced ${all} replies — this is the repetition bug`)
  else pass('all three answered, and it asks for one reply')

  // ---------------------------------------------------------------- stacking
  // A notice takes the same path the renderer uses — the page's own message listener —
  // rather than going through `Realtime.notice`, which refuses when no call is up.
  const notice = async (text) => {
    await rtc.eval(
      `window.postMessage({ __ember: 'ember-realtime', action: 'notice', text: ${JSON.stringify(text)}, speak: true }, '*')`
    )
    await sleep(250)
  }

  console.log('\na session finishes mid-sentence')
  await reset()
  await feed(`{ type: 'response.created' }`)
  await notice('Session "g2" has finished. It said: done')
  const during = await creates()
  if (during !== 0) fail(`a background note interrupted a live sentence (${during} replies)`)
  else pass('it does not interrupt itself to report a finished session')

  await feed(`{ type: 'response.done' }`)
  const after = await creates()
  if (after !== 1) fail(`the finished session was never reported (${after} replies after the gap)`)
  else pass('it reports it in the gap afterwards — queued, not dropped')

  // ---------------------------------------------------------------- not lost
  //
  // The other direction, and the one that matters more: suppression must not become
  // silence. With nobody talking there is nothing to wait for, so it speaks at once.
  console.log('\na session finishes while nobody is talking')
  await reset()
  await notice('Session "g3" has finished. It said: done')
  const idle = await creates()
  if (idle !== 1) fail(`a note arriving on a free line produced ${idle} replies, expected 1`)
  else pass('it reports it straight away')

  // Two finishing inside one sentence is still one thing to say afterwards.
  console.log('\ntwo sessions finish inside one sentence')
  await reset()
  await feed(`{ type: 'response.created' }`)
  await notice('Session "g4" has finished. It said: done')
  await notice('Session "g5" has finished. It said: done')
  await feed(`{ type: 'response.done' }`)
  const both = await creates()
  if (both !== 1) fail(`two notes produced ${both} replies, expected them collapsed into 1`)
  else pass('both are covered by one reply')

  console.log(`\n  final state ${await state()}`)

  rtc.close()
  app.close()
  child.kill()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join('').slice(-2000))
    process.exit(1)
  }
  console.log('TURNS OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join('').slice(-2000))
  child.kill()
  process.exit(1)
}
