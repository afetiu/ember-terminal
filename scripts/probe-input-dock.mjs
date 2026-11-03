/**
 * Claude Code's input box stays framed, and its dialogs whole, in the screens that broke
 * it: `!` shell mode (prompt `!`, mode line "! for shell mode"), a status line of many
 * lines, and a question from Claude, whose question must stay in view. A dev Ember (own
 * EMBER_HOME) whose terminal display is given a copy of Claude Code's full-screen layout.
 * Nothing is typed into the shell or any agent.
 *
 *   npm run build; node scripts/probe-input-dock.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-shell-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-shell')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9397
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
  // Claude Code's full-screen layout, idle: the prompt line and the mode line under the box.
  const draw = (promptLine, modeLine) => drawFoot(['RULE', promptLine, 'RULE', ...[modeLine].flat()])
  // The bottom of the screen, line by line; 'RULE' is one of Claude Code's rules.
  const drawFoot = (footLines) =>
    ev(`(() => {
      const t = window.__ember.term(${JSON.stringify(sid)}); const cols = t.cols, rows = t.rows
      const rule = '\\u2500'.repeat(cols)
      const body = [' \\u2590\\u259b\\u2588\\u2588\\u2588\\u259c\\u258c   Claude Code v2.1.316', '\\u259d\\u259c\\u2588\\u2588\\u2588\\u2588\\u2588\\u259b\\u2598  Opus 5.5 · Claude Max', '']
      const foot = ${JSON.stringify(footLines)}.map((l) => (l === 'RULE' ? rule : l))
      const lines = [...body, ...Array(Math.max(0, rows - body.length - foot.length)).fill(''), ...foot]
      t.write('\\x1b[?1049h\\x1b[H\\x1b[2J' + lines.map((l) => l.slice(0, cols)).join('\\r\\n'))
      t.write('\\x1b]0;\\u2733 Claude Code\\x07')
      return true
    })()`)
  const state = () =>
    ev(`(() => {
      const box = [...document.querySelectorAll('.loom-frame-box')].find((x) => getComputedStyle(x).display !== 'none')
      const r = box?.getBoundingClientRect()
      return { mode: window.__ember.loom()?.mode, framed: !!r, frameH: r && Math.round(r.height) }
    })()`)

  await draw('❯ git status', '  ⏵⏵ auto mode on (shift+tab to cycle)')
  await wait(1500)
  console.log('normal prompt', JSON.stringify(await state()))
  await shot('normal')
  await draw('! git status', '  ! for shell mode')
  await wait(1500)
  console.log('shell mode   ', JSON.stringify(await state()))
  await shot('shell')
  // A custom status line of several lines between the box and the mode line.
  await draw('❯ git status', [
    'Opus 5.5 | platform | $0.18 | ▉ 6% 55k/1000k',
    'acme-web              ⎇ WEB-128-single-property-guard ~6 ?3',
    'renterPortal          ⎇ main ↓73 ~1',
    'renters-portal-api    ⎇ main ~1',
    'ui                    ⎇ main ~1',
    'survey-app-frontend   ⎇ master ✓',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · + 1 agent',
  ])
  await wait(1500)
  console.log('tall status  ', JSON.stringify(await state()))
  await shot('tall-status')
  // A question from Claude (AskUserQuestion): the question must stay in view.
  await drawFoot([
    'RULE',
    ' ←  ☐ Artifacts  ✔ Submit  →',
    '',
    'When a channel message mentions an artifact, what should the bot do?',
    '',
    '❯ 1. Link silently (Recommended)',
    '     If the target is clear, it links the artifact and posts nothing.',
    '  2. Ignore them',
    '     Artifacts are linked only when a person asks in a mention or a DM.',
    '  3. Type something.',
    'RULE',
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ])
  await wait(1500)
  console.log('question     ', JSON.stringify(await ev(`(() => {
    const scr = [...document.querySelectorAll('.xterm-screen')].find((x) => x.offsetParent)
    let pane = scr.parentElement
    while (pane && !pane.style.clipPath) pane = pane.parentElement
    const clip = parseFloat(/inset\\(([\\d.]+)px/.exec(pane?.style.clipPath ?? '')?.[1] ?? '0')
    const t = window.__ember.term(${JSON.stringify(sid)}), buf = t.buffer.active
    let q = -1
    for (let y = 0; y < t.rows; y++) if (buf.getLine(buf.viewportY + y)?.translateToString(true).startsWith('When a channel')) q = y
    const sr = scr.getBoundingClientRect(), pr = pane.getBoundingClientRect()
    return { questionRow: q, questionVisible: q >= 0 && sr.top - pr.top + (q * sr.height) / t.rows >= clip }
  })()`)))
  await shot('question')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
