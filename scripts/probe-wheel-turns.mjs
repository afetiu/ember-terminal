/**
 * The wheel walks the turns: a dev Ember (own EMBER_HOME), a canvas fed a made-up session
 * through window.__ember.loomFeed (no model, no real transcript), and wheel events past
 * the top and bottom of each turn. Also checks that a slash command is a note rather than
 * a turn, and that a message holding a result (a table) stays above the turn's last line.
 *
 *   npm run build; node scripts/probe-wheel-turns.mjs [out-dir]
 *
 * Nothing is typed into any terminal. The canvas is shown by a stylesheet, as Claude mode
 * would show it, because no agent runs.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-wheel-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-wheel')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = Number(process.env.PROBE_PORT) || 9391
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- the made-up session ----
let n = 0
const t0 = Date.parse('2026-11-02T09:00:00Z')
// Minutes apart: each prompt a request of its own (a short one sent soon after a reply is a follow-up).
const at = () => new Date(t0 + n * 240_000).toISOString()
const u = (content, extra = {}) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(), message: { role: 'user', content }, ...extra })
const a = (text) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const long = (topic) =>
  Array.from({ length: 9 }, (_, i) => `${topic}, part ${i + 1}. ` + 'The gateway checks the token, the service reads the store, and the session renews itself quietly before it expires. '.repeat(2)).join('\n\n')
const lines = [
  u('turn 1: how does auth flow through the API?'), a(long('Auth')),
  u('turn 2: and the refresh tokens?'), a(long('Refresh')),
  u('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
  u('<local-command-stdout>Set model to opus</local-command-stdout>'),
  u('turn 3: list the gaps for cutover day'),
  a('## Gaps\n\n| # | Gap | Owner |\n|---|---|---|\n| 1 | Saved-report migration not in the steps | Data |\n| 2 | No rollback for the cron switch | Ops |\n| 3 | Go/no-go rows 4, 5, 9 undecided | You |'),
  a('Checking older sessions for a decision…'),
  a('Gap 1 stays as I reported it. I need your decisions on rows 4, 5 and 9.'),
  u('turn 4: short one'), a('Done.'),
  u('turn 5: write the release notes'), a(long('Release notes')),
  u('turn 6: newest'), a(long('Newest')),
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
  const VIS = `[...document.querySelectorAll('.loom-scroll')].find((x) => x.offsetParent)`
  const state = () =>
    ev(`(() => { const s = ${VIS}; if (!s) return null
      const flow = s.querySelector('.loom-flow')
      const t = [...flow.querySelectorAll(':scope > .loom-turn')].filter((x) => x.childElementCount && [...x.children].some((c) => !c.dataset.cmd))
      const sh = flow.querySelector('.loom-turn.is-shown')
      const ask = (sh?.querySelector('.loom-ask-text, .loom-ask')?.textContent || '').replace('❯', '').slice(0, 30)
      const shown = sh ? [...sh.querySelectorAll(':scope > .loom-say')].filter((x) => getComputedStyle(x).display !== 'none').length : 0
      const notes = sh ? sh.querySelectorAll(':scope > [data-cmd]').length : 0
      return { at: t.indexOf(sh), of: t.length, top: Math.round(s.scrollTop), max: Math.round(s.scrollHeight - s.clientHeight), ask, shown, notes } })()`)
  const wheel = async (dy, count) => {
    const r = await ev(`(() => { const b = ${VIS}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
    for (let i = 0; i < count; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: dy })
      await wait(30)
    }
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
    await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
  await wait(1500)
  // Shown as the app shows it in Claude mode: the container on, with the height layout() gives it.
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 640px !important; }'; document.head.appendChild(st); return true })()`)
  await wait(800)
  await shot('0-fed')

  const log = []
  const note = async (label) => {
    const s = await state()
    log.push(
      s
        ? `${label.padEnd(34)} turn ${s.at + 1}/${s.of}  scroll ${String(s.top).padStart(4)}/${s.max}  messages shown ${s.shown}  cmd notes ${s.notes}  "${s.ask}"`
        : `${label}: no canvas`
    )
  }
  await note('start')
  await shot('0-start')
  await wheel(-100, 3); await wait(400); await note('small scroll up (inside the turn)')
  await wheel(-100, 30); await wait(800); await note('scroll up to the top and past it')
  await shot('1-prev')
  await wheel(-100, 30); await wait(800); await note('again')
  await wheel(-100, 30); await wait(800); await note('again')
  await shot('2-turn3')
  await wheel(-100, 80); await wait(900); await note('one long fling up (momentum)')
  await wheel(100, 60); await wait(900); await note('scroll down to the end and past it')
  await wheel(100, 60); await wait(900); await note('again')
  await shot('3-down')
  console.log(log.join('\n'))
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
