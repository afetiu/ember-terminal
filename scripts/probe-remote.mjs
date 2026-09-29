#!/usr/bin/env node
/**
 * The phone, end to end, against a real desk and the real relay.
 *
 * This stands in for the phone with the same `protocol.js` the phone ships — Node 22 has
 * WebSocket and WebCrypto, so the client here is the client there minus the interface.
 * What it exercises is everything between: a real Ember running headless, a real pairing,
 * the deployed relay on Heroku, and the orchestrator's real tools against real sessions.
 *
 * It is worth the tokens it spends. Every piece of this works in isolation — the relay
 * has its own test, the orchestrator has probe-voice, the turn gating has probe-turns —
 * and the failure this catches is the one none of those can: a message that crosses all
 * four and arrives meaning something slightly different. The `secret` case in particular
 * cannot be faked, because the whole point of it is that the desk mints a credential the
 * phone is never given the means to mint.
 *
 *   node scripts/probe-remote.mjs
 */
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { AccountLink, newDeviceId } from '../resources/relay/protocol.js'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2' }, null, 2))

// Minting a session secret needs the real key. Copied into the sandbox rather than read
// across, so the probe still owns every file it touches.
const realSecrets = join(homedir(), '.ember', 'secrets.json')
if (existsSync(realSecrets)) copyFileSync(realSecrets, join(EMBER_HOME, 'secrets.json'))
else console.warn(`  ! no ${realSecrets} — the secret and reply checks will fail`)

const PORT = 9368

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
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
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
  console.error(`  x ${m}`)
}
const pass = (m) => console.log(`  + ${m}`)

/**
 * Wait for a condition.
 *
 * `await ok()` and not `ok()`. Half the predicates here read state out of the renderer
 * over CDP and are therefore async, and an un-awaited async predicate returns a Promise —
 * which is always truthy, so every check built on one passes instantly and for ever. That
 * is not hypothetical: it is how the first run of this probe reported that the desk could
 * see the phone at a moment when the desk had not managed to open a socket at all.
 */
async function until(ok, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await ok()) return true
    await sleep(80)
  }
  return false
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
  await sleep(3500)

  // ---------- the account ----------
  console.log('\nthe account')
  const account = await cdp.eval(`window.__ember.pairNow()`)
  if (!account?.key || !account?.deviceId) {
    fail('the machine did not produce an account')
    throw new Error('no account')
  }
  pass(`the machine started an account on ${new URL(account.relay).host}`)

  const inbox = []
  let desks = []
  const phone = new AccountLink({
    relay: account.relay,
    key: account.key,
    deviceId: newDeviceId(),
    kind: 'phone',
    name: 'Probe phone',
    onMessage: (m) => inbox.push(m),
    onRoster: (d) => {
      desks = d.filter((x) => x.kind === 'desk' && x.online && !x.self)
    },
    onStatus: () => {},
  })
  await phone.start()

  if (!(await until(() => desks.length === 1, 25_000))) fail('the phone never saw the machine on the roster')
  else pass('the phone sees the machine listed, without pairing to it')

  // The name is the one thing the relay cannot read, so the phone reading it is proof it
  // round-tripped through the seal rather than being handed over in the clear.
  const deskName = desks[0]?.name ?? ''
  if (!deskName || deskName === 'Unknown device') fail(`the phone could not read the name (${deskName})`)
  else pass(`and reads its name: "${deskName}"`)

  const deskId = desks[0].id

  if (!(await until(async () => (await cdp.eval(`window.__ember.remote().phoneHere`)) === true, 15_000))) {
    fail('the machine never saw the phone')
  } else pass('and the machine sees the phone')

  /** Send and wait for the matching reply, by id. */
  const ask = async (msg, ms = 200_000) => {
    const id = `t${inbox.length}-${Math.round(performance.now())}`
    await phone.send(deskId, { ...msg, id })
    const got = await until(() => inbox.some((m) => m.id === id), ms)
    return got ? inbox.find((m) => m.id === id) : null
  }

  // ---------- what the phone asks on arrival ----------
  console.log('\nwaking up')
  await phone.send(deskId, { t: 'hello' })
  if (!(await until(() => inbox.some((m) => m.t === 'ready'), 15_000))) {
    fail('the desk never answered hello — a phone would open to a blank screen')
  } else pass('the desk answers with the conversation so far')

  // ---------- a tool, against the real crew ----------
  console.log('\nrunning a tool on the laptop')
  const listed = await ask({ t: 'tool', name: 'list_sessions', args: {} }, 60_000)
  if (!listed) fail('list_sessions never came back')
  else if (!/id g\d/.test(String(listed.text))) {
    fail(`list_sessions did not describe the crew: ${String(listed.text).slice(0, 160)}`)
  } else pass(`the phone can see the real crew — "${String(listed.text).slice(0, 80)}…"`)

  // A tool that does not exist must still answer, because the model on the phone is
  // holding the floor waiting for a string either way.
  const nonsense = await ask({ t: 'tool', name: 'not_a_tool', args: {} }, 30_000)
  if (!nonsense || !nonsense.text) fail('an unknown tool produced no reply at all — a call would go silent')
  else pass('an unknown tool still comes back with something sayable')

  // ---------- closing a session ----------
  //
  // The only tool that destroys anything, so both refusals are worth pinning down. The
  // last-session guard especially: closing the final tab quits Ember, which would take
  // the relay link and any live call with it — the agent would end the conversation it
  // was being asked a question in, and the user would hear silence with no idea why.
  console.log('\nclosing sessions')
  const tabsBefore = await cdp.eval(`window.__ember.groups().length`)
  const refused = await ask({ t: 'tool', name: 'close_session', args: { session: 'g1' } }, 30_000)
  const stillThere = await cdp.eval(`window.__ember.groups().length`)
  if (stillThere !== tabsBefore) fail('it closed the only session and shut Ember down')
  else if (!/only session|shut Ember down/i.test(String(refused?.text))) {
    fail(`it refused for no stated reason: "${String(refused?.text).slice(0, 120)}"`)
  } else pass('it refuses to close the last session, and says why')

  const opened = await ask({ t: 'tool', name: 'start_session', args: { name: 'Scratch' } }, 60_000)
  if (!opened) fail('start_session never came back')
  const grew = await until(async () => (await cdp.eval(`window.__ember.groups().length`)) > tabsBefore, 30_000)
  if (!grew) fail('start_session did not open a tab')
  else pass('it can open a session')

  const ids = await cdp.eval(`JSON.stringify(window.__ember.groups().map((g) => g.id))`)
  const fresh = JSON.parse(ids).at(-1)

  // A session that has just started is booting a shell, so it reads as working — which
  // makes this the natural moment to check the second refusal. Closing something mid-task
  // on a spoken instruction from a car is the case the guard exists for, and the agent
  // cannot see what it is about to throw away.
  const held = await ask({ t: 'tool', name: 'close_session', args: { session: fresh } }, 30_000)
  const survived = await cdp.eval(`window.__ember.groups().length`)
  if (survived === tabsBefore) fail('it closed a session that was still working, without being told to')
  else if (!/still working/i.test(String(held?.text))) {
    fail(`it did not explain why it held off: "${String(held?.text).slice(0, 120)}"`)
  } else pass('it will not close a working session on its own say-so')

  // And the way past it, which has to exist or the tool is unusable on a busy machine.
  const closed = await ask(
    { t: 'tool', name: 'close_session', args: { session: fresh, force: true } },
    30_000
  )
  const shrank = await until(
    async () => (await cdp.eval(`window.__ember.groups().length`)) === tabsBefore,
    20_000
  )
  if (!shrank) fail(`force did not close it: "${String(closed?.text).slice(0, 120)}"`)
  else pass(`and closes it when told to — "${String(closed?.text).slice(0, 70)}"`)

  // ---------- the credential ----------
  console.log('\nminting a session for the phone')
  const secret = await ask({ t: 'secret', voice: 'cedar', model: 'gpt-realtime-2.1' }, 45_000)
  if (!secret?.auth?.ok) {
    fail(`the desk would not mint a session: ${secret?.auth?.error ?? 'no answer'}`)
  } else if (!String(secret.auth.secret).startsWith('ek_')) {
    fail(`what came back is not an ephemeral secret: ${String(secret.auth.secret).slice(0, 6)}…`)
  } else if (String(secret.auth.secret).startsWith('sk-')) {
    fail('THE ACCOUNT KEY WAS SENT TO THE PHONE')
  } else pass(`the phone gets an ephemeral secret (ek_…, ${secret.auth.model}) and never the key`)

  // ---------- typing to it ----------
  console.log('\ntyping to it from the phone')
  const typed = await ask({ t: 'say', text: 'In one short sentence, how many Claude sessions are open?' })
  if (!typed) fail('a typed message never got an answer')
  else if (!String(typed.text).trim()) fail('the answer came back empty')
  else pass(`it answered: "${String(typed.text).slice(0, 90)}"`)
  if (!typed?.did?.length) {
    // Not fatal — it may answer from what it already knows — but worth seeing.
    console.log('    (answered without calling a tool)')
  } else pass(`and used the crew: ${typed.did.join(', ')}`)

  // ---------- one conversation, two devices ----------
  console.log('\nthe same conversation on both')
  // Matched on the text, not on the count. A turn count going up proves only that
  // *something* was appended — and something else always is — which is how this reported
  // success while the desk's own counter said it had received no spoken lines at all.
  const spoken = `said out loud in the car ${Math.round(performance.now())}`
  await phone.send(deskId, { t: 'line', who: 'user', text: spoken })
  const landed = await until(async () => {
    const t = await cdp.eval(`JSON.stringify(window.__ember.thread().turns)`)
    return String(t).includes(spoken)
  }, 15_000)
  if (!landed) fail('something said on the phone never reached the desk thread')
  else pass('what is said on the phone lands in the desk conversation, word for word')

  const stats = await cdp.eval(`window.__ember.remote()`)
  console.log(
    `\n  desk saw: ${stats.texts} typed, ${stats.tools} tools, ${stats.lines} spoken lines, ${stats.secrets} secrets`
  )
  if (stats.errors?.length) console.log(`  errors: ${JSON.stringify(stats.errors).slice(0, 300)}`)

  // ---------- a machine going away ----------
  console.log('\nwhen the machine closes')
  await cdp.eval(`window.__ember.remoteStop()`)
  if (!(await until(() => desks.length === 0, 15_000))) {
    fail('the phone still lists a machine that has closed')
  } else pass('it leaves the list at once, so the phone can say it is not running')

  phone.stop()
  cdp.close()
  child.kill()
  if (failures) {
    console.error(`\n${failures} failure(s)`)
    console.error(logs.join('').slice(-2000))
    process.exit(1)
  }
  console.log('\nREMOTE OK')
  process.exit(0)
} catch (err) {
  console.error(err.stack ?? String(err))
  console.error(logs.join('').slice(-2000))
  child.kill()
  process.exit(1)
}
