import { join, basename } from 'node:path'
/**
 * The two things narration got wrong, asserted directly.
 *
 * 1. It read the wrong transcript. Picking the newest `.jsonl` in a project folder
 *    means that with two sessions open in one directory, the tab on screen is silent
 *    while another session's work is read out. So: two transcripts in one folder, the
 *    decoy written *last*, and the bound session still the one that gets spoken.
 * 2. It spoke for tabs you were not looking at. So: narrate a background tab and assert
 *    nothing is voiced, then bring it to the front and assert it is.
 *
 *   node scripts/probe-narration.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(
  join(EMBER_HOME, 'config.json'),
  JSON.stringify({ experience: 'v2', restoreSession: false, voice: { voiceId: 'en-US-AvaMultilingualNeural' } }, null, 2)
)
// Speech is Azure, so the probe needs the key the app needs. Without it nothing is
// voiced and every assertion below passes for the wrong reason.
const realSecrets = join(homedir(), '.ember', 'secrets.json')
if (!existsSync(realSecrets)) {
  console.error('SKIP: no Azure key at ~/.ember/secrets.json — narration cannot be exercised')
  process.exit(0)
}
copyFileSync(realSecrets, join(EMBER_HOME, 'secrets.json'))

const PORT = 9359
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME },
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
  cleanup()
  child.kill()
  process.exit(1)
}

const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const CWD = join(homedir(), '__ember_narration_probe')
const PROJECT = join(homedir(), '.claude', 'projects', slug(CWD))
const cleanup = () => rmSync(PROJECT, { recursive: true, force: true })

const line = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

async function find(match, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = l.find(match); if (t?.webSocketDebuggerUrl) return t } catch {}
    await sleep(400)
  }
  return null
}

/** Wait for a condition over the host's speech stats. */
async function until(app, ok, what, tries = 30) {
  let last
  for (let i = 0; i < tries; i++) {
    last = JSON.parse(await app.eval(`JSON.stringify(window.__ember.speech())`))
    if (ok(last)) return last
    await sleep(400)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

try {
  cleanup()
  mkdirSync(PROJECT, { recursive: true })

  const host = await find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
  if (!host) fail('the app never came up')
  const app = await Cdp.connect(host.webSocketDebuggerUrl)
  await app.send('Runtime.enable')
  await sleep(3500)

  const origin = await app.eval(`window.ember.panel.origin()`)
  const tabA = await app.eval(`document.querySelector('.ember-group')?.dataset.groupId ?? ''`)
  if (!tabA) fail('no first tab')

  // Read the bridge token out of the shell, the way the MCP server gets it.
  const tokenFile = join(EMBER_HOME, 'tok.txt')
  rmSync(tokenFile, { force: true })
  await app.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`$env:EMBER_BRIDGE_TOKEN | Set-Content -Encoding utf8 '${tokenFile.replace(/\\/g, '/')}'\r`)})
  })()`)
  let token = ''
  for (let i = 0; i < 50 && !token; i++) {
    await sleep(300)
    if (existsSync(tokenFile)) token = (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim()
  }
  if (!token) fail('could not read the bridge token from the shell')

  // The decoy is another session in the same folder — the thing that used to win.
  const mine = join(PROJECT, 'aaaa-1111-mine.jsonl')
  const decoy = join(PROJECT, 'zzzz-9999-decoy.jsonl')
  writeFileSync(mine, '')
  writeFileSync(decoy, '')

  // Bind tab A to *its* session, exactly as the panel MCP server does on startup.
  const bind = await fetch(`${origin}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({ tabId: tabA, sessionId: 'aaaa-1111-mine', cwd: CWD }),
  })
  if (!bind.ok) fail(`the bridge refused the session binding: ${bind.status}`)
  console.log('bound tab', tabA, '-> aaaa-1111-mine')

  await app.eval(`document.querySelector('.ember-voicetoggle.is-ear').click()`)
  await app.eval(`window.ember.narrate.start(${JSON.stringify(tabA)})`)
  await sleep(1500)

  // The decoy writes LAST. Under the old rule it would win outright.
  appendFileSync(mine, line('This line belongs to the tab you are looking at.'))
  await sleep(300)
  appendFileSync(decoy, line('This line belongs to a different session entirely.'))

  const spoke = await until(app, (s) => s.said >= 1, 'the bound session was never spoken')
  console.log('after both files were written:', JSON.stringify(spoke))
  await sleep(2500)
  const after = JSON.parse(await app.eval(`JSON.stringify(window.__ember.speech())`))
  if (after.said !== 1) fail(`expected exactly one spoken line, got ${after.said} — the decoy leaked in`)
  console.log('only the bound session was spoken')

  // Now the second rule: a tab you are not looking at must be silent.
  await app.eval(`(async () => { await window.__ember.newTab() })()`).catch(() => {})
  const tabs = await app.eval(`Array.from(document.querySelectorAll('.ember-group')).map((g) => g.dataset.groupId)`)
  if (tabs.length < 2) {
    console.log('could not open a second tab from the probe; skipping the background-tab check')
  } else {
    const activeNow = await app.eval(`window.__ember.activeTab() ?? ''`)
    console.log('tabs:', JSON.stringify(tabs), 'active:', activeNow)
    if (activeNow === tabA) fail('the new tab did not become active')

    const before = JSON.parse(await app.eval(`JSON.stringify(window.__ember.speech())`))
    appendFileSync(mine, line('Tab A is in the background and must not be heard.'))
    await sleep(3000)
    const bg = JSON.parse(await app.eval(`JSON.stringify(window.__ember.speech())`))
    console.log('while tab A was in the background:', JSON.stringify(bg))
    if (bg.said !== before.said) fail('a background tab was spoken aloud')
    if (bg.skipped <= before.skipped) fail('the background line was not recorded as skipped')

    // Bring it back and it should be heard again.
    await app.eval(`(async () => { await window.__ember.activate(${JSON.stringify(tabA)}) })()`).catch(() => {})
    await sleep(1200)
    appendFileSync(mine, line('Tab A is in front again and should be heard.'))
    const back = await until(app, (s) => s.said > bg.said, 'the tab was not spoken again once it was back in front')
    console.log('after switching back:', JSON.stringify(back))
  }

  cleanup()
  app.close()
  child.kill()
  console.log('\nNARRATION OK — right transcript, and only the tab on screen')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}
