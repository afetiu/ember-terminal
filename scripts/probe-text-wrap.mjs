/**
 * Plain-text blocks wrap instead of scrolling sideways; code and box-drawn text keep their
 * lines. A dev Ember (own EMBER_HOME), a canvas fed a made-up reply through
 * window.__ember.loomFeed (no model). Prints, per block, whether it wraps and whether it
 * still scrolls sideways.
 *
 *   npm run build; node scripts/probe-text-wrap.mjs [out-dir]
 *
 * Nothing is typed into any terminal.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-wrap-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-wrap')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9398
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x900', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const long = 'The deploy finished, but the health check on the second region kept failing because the load balancer still pointed at the old target group, so traffic was split between two versions for about four minutes.'
const reply = [
  'Three blocks:',
  '```\n' + long + '\n```',
  '```js\nconst message = "' + long + '"\n```',
  '```text\nsrc/\n├── main/ ' + long + '\n└── renderer/\n```',
].join('\n\n')
const lines = [
  { type: 'user', uuid: 'u1', timestamp: '2026-11-02T09:00:00Z', message: { role: 'user', content: 'what happened?' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-11-02T09:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
]

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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
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
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 820px !important; }'; document.head.appendChild(st); return true })()`)
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
  await wait(1500)
  const blocks = await ev(`[...document.querySelectorAll('.loom-say .loom-code')].map((c) => {
    const pre = c.querySelector('pre')
    return { lang: c.querySelector('.loom-code-bar span')?.textContent, wraps: c.classList.contains('is-wrap'), scrollsSideways: pre.scrollWidth > pre.clientWidth + 1 }
  })`)
  for (const b of blocks) console.log(JSON.stringify(b))
  await shot('wrap')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
