/**
 * Queued messages sit above the input box, with Send now; the version shows at the foot of
 * the sidebar. A dev Ember (own EMBER_HOME) whose terminal display is given a copy of
 * Claude Code's full-screen layout with two queued messages — written to the screen, not
 * typed: nothing reaches the shell or any agent. Prints where the queue is and what Send
 * now would write, and screenshots it.
 *
 *   npm run build; node scripts/probe-queue.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-queue-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-queue')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9394
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
  // Claude Code's full-screen layout, mid-turn, with two messages queued — on the display only.
  const screen = await ev(`(() => {
    const t = window.__ember.term(${JSON.stringify(sid)}); const cols = t.cols, rows = t.rows
    const rule = '\\u2500'.repeat(cols)
    const body = [
      ' \\u2590\\u259b\\u2588\\u2588\\u2588\\u259c\\u258c   Claude Code v2.1.316',
      '\\u259d\\u259c\\u2588\\u2588\\u2588\\u2588\\u2588\\u259b\\u2598  Opus 5.5 · Claude Max',
      '', '\\u276f do i have access to pg prod for analytics?', '',
      '\\u25cf Searching memories\\u2026', '',
    ]
    const foot = [
      '\\u2722 Churning\\u2026 (10s \\u00b7 \\u2193 299 tokens)', '',
      '\\u276f also check the staging replica',
      '\\u276f and list the read-only roles',
      '  ctrl+x ctrl+s to send now', '',
      rule, '\\u276f ', rule, '  \\u23f5\\u23f5 auto mode on (shift+tab to cycle)',
    ]
    const lines = [...body, ...Array(Math.max(0, rows - body.length - foot.length)).fill(''), ...foot]
    t.write('\\x1b[?1049h\\x1b[H\\x1b[2J' + lines.map((l) => l.slice(0, cols)).join('\\r\\n'))
    t.write('\\x1b]0;\\u2733 Claude Code\\x07')
    return rows + 'x' + cols
  })()`)
  await wait(2500)
  const st = await ev(`(() => {
    const q = [...document.querySelectorAll('.loom-queue')].find((x) => getComputedStyle(x).display !== 'none')
    const box = [...document.querySelectorAll('.loom-frame-box')].find((x) => getComputedStyle(x).display !== 'none')
    const ver = document.querySelector('.ember-version')
    const qr = q?.getBoundingClientRect(), br = box?.getBoundingClientRect()
    return {
      mode: window.__ember.loom()?.mode,
      queueItems: q ? q.querySelectorAll('.loom-queue-item').length : 0,
      sendNow: !!q?.querySelector('[data-q="send"]'),
      queueBottom: qr && Math.round(qr.bottom), inputTop: br && Math.round(br.top),
      queueInTurn: !!document.querySelector('.loom-turn .loom-queue'),
      version: ver?.textContent ?? null,
      button: (() => { const b = q?.querySelector('[data-q="send"]'); if (!b) return null; const c = getComputedStyle(b); return { bg: c.backgroundColor, color: c.color, opacity: c.opacity, w: Math.round(b.getBoundingClientRect().width) } })(),
      tagSize: q ? getComputedStyle(q.querySelector('.loom-queue-tag')).fontSize : null,
      cardBg: q ? getComputedStyle(q).backgroundColor : null,
    } })()`)
  console.log('screen', screen)
  console.log(JSON.stringify(st, null, 1))
  await shot('queue')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
