/**
 * A pasted picture shows as a thumbnail above the input until it is sent. A dev Ember (own
 * EMBER_HOME) whose terminal display is given a copy of Claude Code's full-screen layout;
 * the canvas is handed a picture through window.__ember.loomPasted (as Ctrl+V would, but
 * without the real clipboard), then the prompt is redrawn with Claude's "[Image #1]" mark,
 * then empty, as after sending. Nothing is typed into the shell or any agent.
 *
 *   npm run build; node scripts/probe-paste-image.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-paste-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-paste')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9396
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
  await wait(2500)
  const sid = await ev('window.__ember.sessions()[0].id')
  // Claude Code's full-screen layout, idle, with the given prompt — on the display only.
  const draw = (prompt) =>
    ev(`(() => {
      const t = window.__ember.term(${JSON.stringify(sid)}); const cols = t.cols, rows = t.rows
      const rule = '\\u2500'.repeat(cols)
      const body = [' \\u2590\\u259b\\u2588\\u2588\\u2588\\u259c\\u258c   Claude Code v2.1.316', '\\u259d\\u259c\\u2588\\u2588\\u2588\\u2588\\u2588\\u259b\\u2598  Opus 5.5 · Claude Max', '']
      const foot = [rule, '\\u276f ' + ${JSON.stringify(prompt)}, rule, '  \\u23f5\\u23f5 auto mode on (shift+tab to cycle)']
      const lines = [...body, ...Array(Math.max(0, rows - body.length - foot.length)).fill(''), ...foot]
      t.write('\\x1b[?1049h\\x1b[H\\x1b[2J' + lines.map((l) => l.slice(0, cols)).join('\\r\\n'))
      t.write('\\x1b]0;\\u2733 Claude Code\\x07')
      return true
    })()`)
  const state = () =>
    ev(`(() => {
      const a = [...document.querySelectorAll('.loom-attach')].find((x) => x.offsetParent)
      const box = [...document.querySelectorAll('.loom-frame-box')].find((x) => getComputedStyle(x).display !== 'none')
      const ar = a?.getBoundingClientRect(), br = box?.getBoundingClientRect()
      return { mode: window.__ember.loom()?.mode, thumbs: a ? [...a.querySelectorAll('figcaption')].map((f) => f.textContent) : [], attachBottom: ar && Math.round(ar.bottom), inputTop: br && Math.round(br.top) }
    })()`)

  await draw('')
  await wait(2000)
  // A small picture, drawn in the page: an amber square with a dark bar.
  const url = await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 120
    const g = c.getContext('2d'); g.fillStyle = '#f2a43a'; g.fillRect(0, 0, 160, 120); g.fillStyle = '#16120f'; g.fillRect(20, 50, 120, 20)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    return URL.createObjectURL(blob)
  })()`)
  await ev(`window.__ember.loomPasted(${JSON.stringify(tab)}, ${JSON.stringify(url)})`)
  await wait(600)
  console.log('just pasted       ', JSON.stringify(await state()))
  await draw('[Image #1] what is wrong with this chart?')
  await wait(1200)
  console.log('Claude marked it  ', JSON.stringify(await state()))
  await shot('pasted')
  await draw('')
  await wait(1200)
  console.log('sent (prompt empty)', JSON.stringify(await state()))
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
