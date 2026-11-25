/**
 * A long session's canvas: a dev Ember (own EMBER_HOME) bound, through the bridge's /status
 * route as the status line binds it, to a COPY of a real, large transcript. Measures how
 * long until the canvas shows turns, whether the window stays responsive, and whether a
 * turn appended afterwards (as the live session writes it) shows up.
 *
 *   npm run build; node scripts/probe-big-transcript.mjs <transcript.jsonl> [out-dir]
 *
 * Nothing is typed into any terminal running claude.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const SRC = process.argv[2]
if (!SRC || !existsSync(SRC)) throw new Error('usage: node scripts/probe-big-transcript.mjs <transcript.jsonl> [out-dir]')
const OUT = process.argv[3] ?? join(process.env.TEMP ?? '.', 'ember-big-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-big')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const DIR = join(EMBER_HOME, 'projects')
mkdirSync(DIR, { recursive: true })
const FILE = join(DIR, 'big.jsonl')
copyFileSync(SRC, FILE)
console.log(`transcript ${(statSync(FILE).size / 1e6).toFixed(0)} MB`)
const PORT = Number(process.env.PROBE_PORT) || 9431
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  const consoleLines = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error'))
      consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400))
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r?.result?.value
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }

  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev('window.__ember.newLoom()')
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(1500)
  const sid = await ev(`window.__ember.sessions()[0].id`)
  await ev(`window.__ember.term(${JSON.stringify(sid)}).write('\\x1b]0;\\u2733 Claude Code\\x07'), true`)
  await wait(2500)
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 640px !important; }'; document.head.appendChild(st); return true })()`)

  const LOOM = `document.querySelector('.loom[data-tab-id="${tab}"]')`
  const state = () =>
    ev(`(() => { const L = ${LOOM}; const flow = L.querySelector('.loom-flow')
      const turns = [...flow.querySelectorAll(':scope > .loom-turn')].filter((t) => t.childElementCount)
      return {
        turns: turns.length,
        last: [...flow.querySelectorAll('.loom-ask-text')].slice(-1).map((x) => x.textContent.slice(0, 40))[0] ?? '',
        hint: !L.querySelector('.loom-hint').classList.contains('is-gone'),
        imgs: flow.querySelectorAll('img').length,
        nodes: flow.querySelectorAll('*').length,
      } })()`)

  const origin = await ev('window.ember.panel.origin()')
  const tokenFile = join(EMBER_HOME, 'tok.txt')
  await ev(`(() => { const s = window.__ember.sessions()[0]; window.ember.write(s.id, ${JSON.stringify(`$env:EMBER_BRIDGE_TOKEN | Set-Content -Encoding utf8 '${tokenFile.replace(/\\/g, '/')}'\r`)}); return true })()`)
  let token = ''
  for (let i = 0; i < 50 && !token; i++) {
    await wait(300)
    if (existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim()
  }
  if (!token) throw new Error('could not read the bridge token from the shell')
  const status = async () => {
    const r = await fetch(`${origin}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({ tabId: tab, status: { session_id: 'big', transcript_path: FILE, cwd: EMBER_HOME, model: { display_name: 'Opus' } } }),
    })
    if (!r.ok) throw new Error(`status refused: ${r.status}`)
  }

  const t0 = Date.now()
  await status()
  let s = null
  let shown = 0
  for (let i = 0; i < 40; i++) {
    await wait(1500)
    const q = Date.now()
    try {
      s = await Promise.race([state(), wait(20_000).then(() => null)])
    } catch (e) {
      s = { error: String(e).slice(0, 200) }
    }
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(1)}s  eval ${Date.now() - q}ms  ${JSON.stringify(s)}`)
    if (s && s.turns > 0 && !shown) shown = Date.now() - t0
    if (s && s.turns > 0 && i > 3) break
  }
  await shot('1-loaded')

  // A new turn, as the live session writes it.
  const now = Date.now()
  appendFileSync(
    FILE,
    JSON.stringify({ type: 'user', uuid: `probe-u-${now}`, timestamp: new Date(now).toISOString(), message: { role: 'user', content: 'PROBE new turn after load' } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', uuid: `probe-a-${now}`, timestamp: new Date(now + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'PROBE reply.' }] } }) +
      '\n'
  )
  let appended = false
  for (let i = 0; i < 20 && !appended; i++) {
    await wait(500)
    s = await state()
    appended = s.last.startsWith('PROBE new turn')
  }
  await shot('2-appended')
  console.log(`first turns on canvas after ${shown ? (shown / 1000).toFixed(1) + 's' : 'NEVER'}; appended turn shown: ${appended}; ${JSON.stringify(s)}`)
  if (consoleLines.length) console.log('renderer warnings/errors:\n  ' + consoleLines.slice(0, 15).join('\n  '))
  ws.close()
} finally {
  child.kill()
}
