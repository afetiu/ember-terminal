import { mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
/**
 * Ground truth for the tab-status feature: launch `claude` inside a real Ember
 * session and record what it actually does to the terminal — window title, screen
 * buffer, BEL, output cadence — instead of guessing at its signatures.
 *
 * Starting Claude Code does not call the API until you send a prompt, so this is
 * free to run. It exits the session at the end.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9337
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: PROBE_ENV,
})

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(400)
  }
  throw new Error('no devtools target')
}

const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
await sleep(3000)
const sid = await evaluate(`document.querySelector('.ember-pane.is-active').dataset.sessionId`)

const snap = async (label) => {
  const s = await evaluate(`window.__ember.sessions()[0]`)
  console.log(
    `[${label}] title=${JSON.stringify(s.title ?? null)} raw=${JSON.stringify(s.rawTitle)} buffer=${s.bufferType} bells=${s.bells} sinceOutput=${s.sinceOutputMs}ms bytes=${s.bytesIn}`,
  )
  return s
}

await snap('before')

console.log('\nlaunching claude...')
await evaluate(`window.ember.write(${JSON.stringify(sid)}, 'claude\\r')`)

for (const t of [1500, 3000, 5000, 8000, 12000]) {
  await sleep(t === 1500 ? 1500 : t - (t === 3000 ? 1500 : t === 5000 ? 3000 : t === 8000 ? 5000 : 8000))
  await snap(`t+${t}ms`)
}

const dump = await evaluate(`window.__ember.sessions()[0].text`)
console.log('\n--- visible buffer ---')
console.log(dump.split('\n').filter((l) => l.trim()).slice(0, 24).join('\n'))

// Open a second, plain shell session so the sidebar shows both badge kinds.
await evaluate(`document.querySelector('.ember-newtab').click()`)
await sleep(2000)
await evaluate(`document.querySelectorAll('.ember-card')[0].click()`)
await sleep(1200)

const cards = await evaluate(`Array.from(document.querySelectorAll('.ember-card')).map(c => ({
  title: c.querySelector('.ember-card-title').textContent,
  status: c.querySelector('.ember-card-statustext').textContent,
  state: c.dataset.state,
  claude: c.classList.contains('is-claude'),
  active: c.classList.contains('is-active'),
}))`)
console.log('\n--- sidebar cards ---')
console.log(JSON.stringify(cards, null, 2))

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = `${process.env.TEMP}\\ember-claude.png`
;(await import('node:fs')).writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', file)

console.log('\nexiting claude...')
await evaluate(`window.ember.write(${JSON.stringify(sid)}, '\\u0003')`)
await sleep(600)
await evaluate(`window.ember.write(${JSON.stringify(sid)}, '\\u0003')`)
await sleep(1500)
await snap('after exit')

ws.close()
child.kill()
process.exit(0)
