#!/usr/bin/env node
/**
 * The voice call, checked where it can actually fail.
 *
 * Four claims, and only the first is cheap:
 *
 *   1. The bridge serves the call page and its script on the origin the microphone is
 *      granted to. A 404 here is a call that never starts.
 *   2. Ember can mint a real ephemeral secret from OpenAI. This is a live API call — it
 *      is the only way to know the key works, the model name is one this account can use,
 *      and the endpoint has not moved again. `/v1/realtime/sessions` 404s and
 *      `/v1/realtime?model=` is retired; both were live-checked when this was written,
 *      and both are what a from-memory implementation would have used.
 *   3. `ask_claude` completes a real round trip: a question typed into a real `claude`
 *      session in a real tab, and the answer read back off Claude Code's transcript. This
 *      is the join between the two loops and the one thing a person wearing a headset
 *      cannot verify — a plausible answer proves nothing about where it came from, so the
 *      probe asks something only the actual session could answer.
 *   4. Hanging up releases the tab, so the next call is not blocked by the last one.
 *
 * The microphone and the audio are deliberately NOT exercised: WebRTC to OpenAI needs a
 * real capture device and a real conversation, and a probe that fakes both would prove
 * nothing about either. What this covers is everything up to the point where sound starts.
 *
 *   node scripts/probe-voice.mjs
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
// v2, because the bridge (and therefore the call page) only exists there.
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))

// The probe runs against a throwaway EMBER_HOME so it cannot rewrite the real config —
// but secrets.json lives in that same directory, and minting a session needs the actual
// key. Copied in rather than read across, so the probe still owns everything it touches.
const realSecrets = join(homedir(), '.ember', 'secrets.json')
if (existsSync(realSecrets)) copyFileSync(realSecrets, join(EMBER_HOME, 'secrets.json'))
else console.warn(`  ! no ${realSecrets} — the OpenAI section will fail`)

const PORT = 9357

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  // EMBER_HOME moves config.json, but secrets.json is read from the same directory — so
  // the real key is copied in rather than the probe reaching outside its sandbox.
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

  async eval(expression, timeoutMs = 200_000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ __timeout: true })),
    ])
    if (r.__timeout) throw new Error('evaluate timed out')
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

async function until(cdp, expression, ok, what, tries = 60, gap = 500) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(gap)
  }
  fail(`${what} — last saw ${JSON.stringify(last)?.slice(0, 200)}`)
  return last
}

try {
  const page = await hostTarget()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3500)

  const origin = await cdp.eval(`window.ember.panel.origin()`)
  if (!origin) fail('the bridge never came up')

  // ---------- 1. the page is served where the microphone lives ----------

  console.log('\ncall page')
  for (const [path, needle] of [
    ['/realtime', '<audio'],
    ['/realtime/rtc.js', 'function_call'],
  ]) {
    const res = await fetch(`${origin}${path}`)
    const body = await res.text()
    if (!res.ok) fail(`${path} -> ${res.status}`)
    else if (!body.includes(needle)) fail(`${path} served but does not contain ${needle}`)
    else pass(`${path} is served from the bridge origin`)
  }

  const framed = await cdp.eval(`document.querySelector('.ember-realtime')?.getAttribute('src') ?? ''`)
  if (!framed.endsWith('/realtime')) fail(`the call frame points at "${framed}"`)
  else pass('the call frame is attached to it')

  await until(cdp, `window.__ember.call().ready`, (v) => v === true, 'the call page never reported ready')
  if (!failures) pass('the page came up and handshook with the app')

  // ---------- the microphone permission ----------
  //
  // This exists because it shipped broken. `voice.ts` allowlists mic access by *path*,
  // it listed only `/speech`, and every call died on NotAllowedError — page served,
  // session minted, data channel open, and then silence. Nothing else in this probe
  // touches it, because getUserMedia is the very last thing a call does.
  //
  // The distinction that makes this checkable without a microphone: `NotAllowedError`
  // means Ember refused, and `NotFoundError` means Ember allowed it and the machine has
  // no capture device. Only the first is a bug in this repo.
  // The page runs the check itself and posts the answer back — reaching into it from
  // here is a SecurityError, since it is deliberately cross-origin.
  await cdp.eval(`window.__ember.micCheck()`)
  const permission = await until(
    cdp,
    `window.__ember.call().mic`,
    (v) => !!v,
    'the call page never answered the microphone check',
    30,
    500
  )

  if (permission === 'granted') pass('the call page is allowed the microphone (and one was found)')
  else if (permission === 'NotFoundError') pass('the call page is allowed the microphone (no capture device on this machine)')
  else if (permission === 'NotAllowedError') fail('Ember DENIED the microphone to its own call page — check MIC_PAGES in voice.ts')
  else fail(`microphone check was inconclusive: ${permission}`)

  // ---------- 1b. a call you can always get out of ----------
  //
  // The call belongs to the window, but it is *bound* to a tab, and the chrome used to
  // read its state as "the state, if you are looking at the tab it started in, otherwise
  // idle". So a call placed in one tab showed a "Call" button everywhere else — with the
  // orchestrator opening tabs of its own and show_session switching to them, that is the
  // ordinary case, not a corner. The user had a live microphone and no visible way to hang up.
  console.log('\nthe call, seen from another tab')
  const home = await cdp.eval(`window.__ember.activeTab()`)
  await cdp.eval(`window.__ember.pretendCall('live', ${JSON.stringify(home)})`)
  // `void`: newTab hands back the Group, and CDP cannot serialise a live DOM-bearing
  // object by value — it fails with "reference chain is too long" rather than anything
  // that names the real problem.
  await cdp.eval(`void window.__ember.newTab()`)
  await sleep(700)

  const elsewhere = await cdp.eval(`window.__ember.callChrome()`)
  const moved = (await cdp.eval(`window.__ember.activeTab()`)) !== home
  if (!moved) fail('could not switch tabs, so this proves nothing')
  else if (elsewhere.button !== 'Hang up') {
    fail(`from another tab the button says "${elsewhere.button}" during a live call`)
  } else pass('a live call still says "Hang up" from a different tab')

  if (!elsewhere.markOnCall) fail('the title-bar mark does not show a call from another tab')
  else pass('the title-bar mark shows the call wherever you are')

  await cdp.eval(`window.__ember.pretendCall('idle', null)`)
  await sleep(300)
  const quiet = await cdp.eval(`window.__ember.callChrome()`)
  if (quiet.button !== 'Call') fail(`with no call the button says "${quiet.button}"`)
  else pass('with no call it offers one')
  await cdp.eval(`void window.__ember.activate(${JSON.stringify(home)})`)
  await sleep(400)

  // ---------- 2. a real ephemeral secret ----------

  console.log('\nOpenAI')
  const configured = await cdp.eval(`window.ember.voice.configured()`)
  if (!configured.configured) {
    fail(`no OpenAI key in ${configured.path} — everything below needs one`)
  } else {
    pass('an OpenAI key is present')

    const auth = await cdp.eval(`window.ember.voice.secret('cedar', 'gpt-realtime-2.1')`, 40_000)
    if (!auth.ok) {
      fail(`OpenAI refused to mint a session: ${auth.error}`)
    } else {
      if (!String(auth.secret).startsWith('ek_')) fail(`minted secret does not look ephemeral: ${String(auth.secret).slice(0, 6)}…`)
      else pass(`minted an ephemeral session secret (ek_…, model ${auth.model})`)
      // The account key must never be what reaches the page.
      if (String(auth.secret).startsWith('sk-')) fail('the ACCOUNT KEY was handed to the page')
      if (auth.callsUrl !== 'https://api.openai.com/v1/realtime/calls') {
        fail(`calls URL is "${auth.callsUrl}" — the GA route is /v1/realtime/calls`)
      } else pass('the page is pointed at the GA calls route, not the retired beta one')
    }
  }

  // ---------- 3. the round trip that matters ----------

  console.log('\nask_claude round trip')

  // Refuse before a session exists, in a sentence the voice can say out loud.
  const early = await cdp.eval(`window.__ember.ask('what is two plus two')`, 20_000)
  if (!/no Claude session/i.test(String(early))) {
    fail(`with no session running, ask returned "${String(early).slice(0, 120)}"`)
  } else pass('with no session in the tab it refuses in a speakable sentence')

  // Now start one for real and wait for it to announce itself over the panel MCP server.
  const MARK = 'ember-voice-probe-marker-9317'
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, 'claude\\r')
  })()`)
  console.log('  … waiting for a Claude session to come up (this is the slow part)')

  // Wait for the session to announce itself before asking anything, rather than firing
  // questions at a shell that is still starting. `ask` refuses instantly without a
  // binding, so this poll is cheap — and it means the ask itself gets one clean attempt
  // instead of forty overlapping ones, each holding the tab's single in-flight slot.
  const tabId = await cdp.eval(`document.querySelector('.ember-group')?.dataset.groupId ?? ''`)
  let bound = false
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    if (await cdp.eval(`window.ember.voice.ready(${JSON.stringify(tabId)})`, 15_000).catch(() => false)) {
      bound = true
      break
    }
    if (i % 5 === 4) console.log(`  … still waiting (${(i + 1) * 2}s)`)
  }
  if (!bound) fail('no Claude session announced itself in the tab within 90s')

  const asked = bound
    ? await cdp
        // A question only the real session can answer: it names a string that exists
        // nowhere except in this instruction, so a plausible answer from anywhere else
        // still fails.
        .eval(
          `window.__ember.ask(${JSON.stringify(`Reply with exactly this word and nothing else: ${MARK}`)})`,
          170_000
        )
        .catch((err) => `ERROR: ${err.message}`)
    : null

  // Strict on purpose. An earlier version accepted "any string that is not an exception"
  // and passed on the sentence `converse.ts` returns when nothing ever came back — a
  // green probe for a broken bridge, which is worse than no probe. The marker is the
  // whole point: only the real session, having actually read the question, can echo it.
  if (asked && asked.includes(MARK)) {
    pass(`the answer came back from the real session — it echoed ${MARK}`)
  } else {
    fail(`the round trip did not reach Claude. Answer was: ${JSON.stringify(String(asked).slice(0, 200))}`)
    // Every failure mode in this pipeline is silence, so the watcher's own view of what
    // it is tailing is the only thing that separates "the question never submitted" from
    // "it submitted and we were reading the wrong file".
    const watch = await cdp.eval(`window.ember.voice.watch(${JSON.stringify(tabId)})`).catch(() => null)
    console.error(`\n  watcher: ${JSON.stringify(watch)}`)
    // What is actually on the grid is the only thing that explains this — usually a
    // prompt the question got typed into instead (folder trust, a permission dialog).
    const grid = await cdp.eval(`window.__ember.sessions()[0].text`).catch(() => '')
    console.error('\n  --- terminal at the moment of failure ---')
    for (const l of String(grid).split('\n').filter((l) => l.trim()).slice(-25)) {
      console.error(`  | ${l}`)
    }
  }

  // ---------- 4. orchestration ----------
  //
  // The claim that matters here is *not waiting*. `ask_claude` holds the call until the
  // turn completes, which is right when the user is listening for the answer and wrong for
  // work. `send_work` has to come back in milliseconds and then report on its own later —
  // if it blocks, the whole orchestrator idea collapses back into a remote control.

  console.log('\norchestration')

  const listed = await cdp.eval(`window.__ember.tool('list_sessions', {})`, 20_000)
  if (!/id g\d/.test(String(listed))) fail(`list_sessions returned no sessions: ${String(listed).slice(0, 160)}`)
  else pass(`list_sessions reports the crew — "${String(listed).slice(0, 90)}…"`)

  // The reply marker must not appear in the brief itself. An earlier version asked the
  // session to "say DISPATCHDONE" and then matched DISPATCHDONE against check_work's
  // output — which echoes the task back, so the assertion passed on the question rather
  // than the answer and hid a completely dead journal.
  const SLOW = 'Count slowly from one to twenty, one number per line, then say the word FINISHEDNOW.'
  const t0 = Date.now()
  const dispatched = await cdp.eval(
    `window.__ember.tool('send_work', { session: ${JSON.stringify(tabId)}, task: ${JSON.stringify(SLOW)} })`,
    30_000
  )
  const took = Date.now() - t0
  if (!/on it|sent/i.test(String(dispatched))) {
    fail(`send_work refused: ${String(dispatched).slice(0, 160)}`)
  } else if (took > 4000) {
    fail(`send_work blocked the call for ${took}ms — the whole point is that it does not`)
  } else {
    pass(`send_work returned in ${took}ms without waiting for the work`)
  }

  // While that runs, the voice must still be able to do things. This is the behaviour
  // being bought: ask a question about something else while work is in flight.
  const whileBusy = await cdp.eval(`window.__ember.tool('list_sessions', {})`, 20_000)
  if (!/working|idle|waiting/i.test(String(whileBusy))) fail('the crew could not be listed while work was in flight')
  else pass('the voice is still usable while a session works')

  // And the hand-off has to report back on its own.
  const reported = await (async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(2000)
      const r = await cdp.eval(`window.__ember.tool('check_work', { session: ${JSON.stringify(tabId)} })`, 20_000)
      if (/It said:[\s\S]*FINISHEDNOW/.test(String(r))) return String(r)
    }
    return null
  })()
  if (!reported) fail('dispatched work never reported back through check_work')
  else pass('the dispatched work reported back on its own')

  // `finished` is set by the same branch that raises the note, so it separates "the
  // turn-end never arrived" from "it arrived and the note went nowhere".
  const raw = await cdp.eval(`window.ember.crew.report(${JSON.stringify(tabId)})`)
  const watching = await cdp.eval(`window.ember.voice.watch(${JSON.stringify(tabId)})`).catch(() => null)
  console.log(`  crew report: finished=${raw?.finished} seen=${JSON.stringify(raw?.seen)}`)
  console.log(`  watcher:     ${JSON.stringify(watching)}`)

  // The notice path itself: a finished hand-off has to arrive at the app even when no
  // call is up (it is only *spoken* during a call). Counting arrivals separately from
  // spoken notices is what distinguishes "nothing fired" from "nothing to speak to".
  const notes = await cdp.eval(`window.__ember.call().notes`)
  if (!notes) {
    fail('the finished hand-off never raised a note — the voice would never learn it was done')
    const crewLog = logs.join('').split(/\r?\n/).filter((l) => l.includes('[crew]'))
    console.error(`  main log: ${crewLog.join(' | ') || '(no [crew] lines at all)'}`)
  }
  else pass(`the finish was announced to the app (${notes} note${notes === 1 ? '' : 's'})`)

  // ---------- 5. the written half ----------
  //
  // The claim is not "there is also a chat box" — it is that typing reaches the *same*
  // agent, with the same tools and the same conversation. So this drives a real turn
  // through the text model and then checks that what was said out loud and what was
  // typed are sitting in one thread.

  console.log('\nwritten channel')

  const before = await cdp.eval(`window.__ember.thread()`)
  const written = await cdp.eval(
    `window.__ember.write('Which sessions are running right now? Answer in one short sentence.')`,
    120_000
  )
  const after = await cdp.eval(`window.__ember.thread()`)

  const grew = after.turns.length - before.turns.length
  if (grew < 2) fail(`a typed turn added ${grew} entries to the thread; expected the question and an answer`)
  else pass('a typed turn runs end to end and lands in the thread')

  const answered = String(written?.join(' ') ?? '')
  if (!/g\d|session/i.test(answered)) fail(`the written answer does not look like it used the crew: ${answered.slice(0, 160)}`)
  else pass('the written half reached the same tools')

  // Both channels in one conversation is the entire point of this shape.
  const spoken = after.turns.filter((t) => t.spoken).length
  console.log(`  thread: ${after.turns.length} turns (${spoken} spoken), ${after.history} model messages`)

  // ---------- 6. hanging up frees the tab ----------

  console.log('\nlifecycle')
  await cdp.eval(`window.ember.voice.cancel(${JSON.stringify(tabId)})`)
  const again = await cdp.eval(`window.__ember.ask('say OK')`, 60_000)
  if (/still working on the previous/i.test(String(again))) {
    fail('after hanging up the tab is still holding the previous question')
  } else pass('cancelling releases the tab for the next question')

  const state = await cdp.eval(`window.__ember.call()`)
  console.log(`\ncall state: ${JSON.stringify({ state: state.state, usable: state.usable, asks: state.asks, errors: state.errors })}`)

  // Leave a picture of the orchestrator open, since the panel is the half of this that
  // can only be judged by looking.
  await cdp.eval(`window.__ember.orchestrator()`)
  await sleep(700)

  // The title-bar mark is drawn rather than set in a font, so "does it render" is a real
  // question — a broken SVG is an empty button, not a missing-glyph box.
  const mark = await cdp.eval(`(() => {
    const b = document.querySelector('.ember-voicetoggle.is-orch')
    if (!b) return { found: false }
    const svg = b.querySelector('svg')
    const r = svg?.getBoundingClientRect()
    return {
      found: true,
      hidden: b.classList.contains('is-hidden'),
      svg: !!svg,
      hub: !!b.querySelector('.ember-orch-hub'),
      w: Math.round(r?.width ?? 0),
      h: Math.round(r?.height ?? 0),
      phoneGone: !document.querySelector('.ember-voicetoggle.is-call'),
    }
  })()`)
  if (!mark.found || !mark.svg) fail('the orchestrator button has no drawn mark')
  else if (mark.w < 10 || mark.h < 10) fail(`the mark rendered ${mark.w}x${mark.h} — it is not being laid out`)
  else if (!mark.hub) fail('the mark has no hub element, so a call cannot pulse it')
  else if (!mark.phoneGone) fail('the phone button is still in the title bar')
  else pass(`the orchestrator mark renders ${mark.w}x${mark.h} and the phone is gone`)
  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('orchestrator.png', Buffer.from(shot.data, 'base64'))
  console.log('\nscreenshot -> orchestrator.png')

  cdp.close()
  child.kill()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join('').slice(-3000))
    process.exit(1)
  }
  console.log('\nVOICE OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join('').slice(-3000))
  child.kill()
  process.exit(1)
}
