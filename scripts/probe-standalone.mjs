import { join, basename } from 'node:path'
/**
 * Ember must be able to talk with nothing but itself.
 *
 * Speech used to read its code out of `~/voice`, which meant a second project had to be
 * checked out beside the app for dictation and narration to work at all — and a static
 * import of those files meant that if the folder was missing, the speech page failed to
 * parse and even the Azure path died with it.
 *
 * This runs the app against a home directory where `~/voice` is invisible, and asserts
 * the shipped path still works end to end.
 *
 *   node scripts/probe-standalone.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
const FAKE_HOME = join(EMBER_HOME, 'home')
mkdirSync(FAKE_HOME, { recursive: true })
writeFileSync(
  join(EMBER_HOME, 'config.json'),
  JSON.stringify(
    { experience: 'v2', restoreSession: false, voice: { engine: 'azure', voiceId: 'en-US-AvaMultilingualNeural', recognizer: 'azure' } },
    null,
    2
  )
)

// The key still has to be found, so bring it across; the point of the run is the
// absence of ~/voice, not the absence of credentials.
const realSecrets = join(homedir(), '.ember', 'secrets.json')
const haveKey = existsSync(realSecrets)
if (haveKey) copyFileSync(realSecrets, join(EMBER_HOME, 'secrets.json'))

const PORT = 9363
// USERPROFILE/HOME point at an empty directory, so `~/voice` genuinely does not exist
// for this process — os.homedir() follows them on Windows.
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME },
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

class Cdp {
  #ws; #id = 0; #pending = new Map()
  static async connect(url) {
    const c = new Cdp(); c.#ws = new WebSocket(url)
    await new Promise((r, j) => { c.#ws.addEventListener('open', r, { once: true }); c.#ws.addEventListener('error', j, { once: true }) })
    c.#ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); const p = c.#pending.get(m.id); if (!p) return; c.#pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) })
    return c
  }
  send(method, params = {}) { const id = ++this.#id; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#pending.set(id, { res, rej })) }
  async eval(e, t = 120000) {
    const r = await Promise.race([this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }), sleep(t).then(() => ({ timedOut: true }))])
    if (r.timedOut) throw new Error('evaluate timed out')
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 300) ?? 'eval failed')
    return r.result.value
  }
  close() { this.#ws.close() }
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error(logs.slice(-25).join(''))
  child.kill()
  process.exit(1)
}

async function find(match, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = l.find(match); if (t?.webSocketDebuggerUrl) return t } catch {}
    await sleep(400)
  }
  return null
}

try {
  const host = await find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
  if (!host) fail('the app never came up without ~/voice')
  const app = await Cdp.connect(host.webSocketDebuggerUrl)
  await app.send('Runtime.enable')
  await sleep(3500)

  const status = JSON.parse(await app.eval(`(async () => JSON.stringify(await window.ember.azure.configured()))()`))
  console.log('status:', JSON.stringify(status))
  if (status.local) fail('~/voice was still visible — the probe did not isolate the app')

  const origin = await app.eval(`window.ember.panel.origin()`)
  for (const p of ['/azure.js', '/player.js', '/vendor/azure/azure-speech-sdk.js', '/speech']) {
    const res = await fetch(`${origin}${p}`)
    console.log(`  ${res.status}  ${p}`)
    if (!res.ok) fail(`Ember does not ship ${p}`)
    await res.arrayBuffer()
  }
  // And the optional ones really are absent, so the test means something.
  const gone = await fetch(`${origin}/speak.js`)
  console.log(`  ${gone.status}  /speak.js  (expected 404 — it lives in ~/voice)`)
  if (gone.ok) fail('/speak.js resolved even though ~/voice is hidden')

  // The frame must still come up. Under a static import of the missing files it would
  // not, and Azure would have died with them.
  const frame = await find((t) => t.url.endsWith('/speech'))
  if (!frame) fail('the speech frame is not even a target without ~/voice')
  const sp = await Cdp.connect(frame.webSocketDebuggerUrl)
  await sp.send('Runtime.enable')

  const up = await app.eval(`JSON.stringify(window.__ember.speech())`)
  console.log('host:', up)
  if (!JSON.parse(up).up) fail('the speech frame never came up without ~/voice')

  const inside = JSON.parse(await sp.eval(`JSON.stringify(window.__emberSpeech())`))
  console.log('frame:', JSON.stringify(inside))
  // Built its speaker from Ember's own Azure client, with ~/voice nowhere in reach.
  if (!inside.hasSpeaker) fail('the frame never built a speaker without ~/voice')
  if (!inside.voiceId.startsWith('en-')) fail(`no Azure voice selected (${inside.voiceId})`)

  if (!haveKey) {
    console.log('\n(no Azure key on this machine — stopped after proving the app loads standalone)')
  } else {
    // Synthesise for real, with nothing but what Ember ships.
    const auth = await app.eval(`(async () => JSON.stringify(await window.ember.azure.token()))()`)
    if (!JSON.parse(auth).ok) fail(`no Azure token: ${auth}`)
    const spoke = await sp.eval(`(async () => {
      const { createAzureSpeaker } = await import('/azure.js')
      const { Player } = await import('/player.js')
      const s = await createAzureSpeaker(async () => (${auth}), 'en-US-AvaMultilingualNeural')
      const p = new Player(s)
      let started = false, ended = false
      p.onstart = () => { started = true }
      p.onend = () => { ended = true }
      p.speak('Ember is talking without anything else installed.')
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); if (ended) break }
      return JSON.stringify({ started, ended, ctx: p.ctx?.state ?? 'none', ctxTime: +(p.ctx?.currentTime ?? 0).toFixed(2) })
    })()`, 90000)
    console.log('azure synthesis + playback:', spoke)
    const r = JSON.parse(spoke)
    if (!r.started || !r.ended) fail('the player never ran a full utterance')
    // The context clock only advances while audio is being played through it.
    if (r.ctxTime < 0.5) fail(`no audio actually played (context clock at ${r.ctxTime}s)`)
  }

  sp.close()
  app.close()
  child.kill()
  console.log('\nSTANDALONE OK — Ember speaks with nothing but itself')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}
