/**
 * Verifies waves 1-3: command blocks and the rail, git/URL chips and the task runner,
 * cross-session search, unread badges and scrollback restore.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const STATE = join(EMBER_HOME, 'state.json')
if (existsSync(STATE)) rmSync(STATE, { force: true })
// Scrollback files persist across probe runs, so stale ones from an older build
// would be asserted against and fail for the wrong reason.
const SCROLLBACK = join(EMBER_HOME, 'scrollback')
if (existsSync(SCROLLBACK)) rmSync(SCROLLBACK, { recursive: true, force: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function connect(port, child) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl)
        await new Promise((r) => ws.addEventListener('open', r, { once: true }))
        let id = 0
        const pending = new Map()
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data)
          const cb = pending.get(m.id)
          if (cb) {
            pending.delete(m.id)
            cb(m)
          }
        })
        const send = (method, params = {}) =>
          new Promise((res) => {
            pending.set(++id, res)
            ws.send(JSON.stringify({ id, method, params }))
          })
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
          if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
          return r.result?.result?.value
        }
        await send('Runtime.enable')
        return { ws, send, ev }
      }
    } catch {
      /* not up */
    }
    await sleep(400)
  }
  child.kill()
  throw new Error('no devtools target')
}

// ---------- first run ----------
let child = spawn('./node_modules/electron/dist/electron.exe', ['.', '--remote-debugging-port=9346'], {
  stdio: 'ignore',
  env: PROBE_ENV,
})
let { ws, send, ev } = await connect(9346, child)
await sleep(3500)
await send('Page.bringToFront')

// ---- wave 1: blocks ----
await ev(`window.__ember.type("cd C:\\\\Users\\\\afeti\\\\ember\\r")`)
await sleep(1500)
await ev(`window.__ember.type("Write-Output 'BLOCK_ONE'\\r")`)
await sleep(1600)
await ev(`window.__ember.type("this-command-does-not-exist-xyz\\r")`)
await sleep(2200)
// Enough output that the viewport actually has somewhere to scroll to — otherwise
// "jump to previous command" is a no-op because everything already fits on screen.
await ev(`window.__ember.type("1..200 | ForEach-Object { 'filler ' + $_ }\\r")`)
await sleep(2600)
await ev(`window.__ember.type("Write-Output 'BLOCK_THREE'\\r")`)
await sleep(1800)

const blocks = await ev(`(() => {
  const s = window.__ember.blocks()
  return { count: s.length, commands: s.map(b => b.command), outcomes: s.map(b => b.outcome) }
})()`)
console.log('blocks:', JSON.stringify(blocks))
check('commands become blocks', blocks.count >= 3, `${blocks.count} blocks`)
check('block captures the command text', blocks.commands.some((c) => /BLOCK_ONE/.test(c)), JSON.stringify(blocks.commands))
check('a failing command is marked failed', blocks.outcomes.includes('fail'), JSON.stringify(blocks.outcomes))

const rail = await ev(`({
  ticks: document.querySelectorAll('.ember-rail-tick').length,
  failTicks: document.querySelectorAll('.ember-rail-tick[data-outcome="fail"]').length,
})`)
check('rail renders a tick per command', rail.ticks >= 3, JSON.stringify(rail))
check('failed commands get a red tick', rail.failTicks >= 1, String(rail.failTicks))

// jump by command
const jumped = await ev(`(() => {
  const before = window.__ember.sessions()[0].viewportY
  window.__ember.jumpCommand(-1)
  return { before, after: window.__ember.sessions()[0].viewportY }
})()`)
check('Ctrl+Up jumps to a previous command', jumped.after !== jumped.before, JSON.stringify(jumped))

// ---- wave 2: git + tasks ----
await sleep(1200)
const git = await ev(`(() => {
  const chip = document.querySelector('.ember-chip.is-git')
  return chip ? chip.textContent : null
})()`)
check('git branch chip appears for a repo cwd', typeof git === 'string' && git.length > 0, String(git))

const tasks = await ev(`(async () => {
  window.__ember.openPalette('!')
  await new Promise(r => setTimeout(r, 900))
  const rows = [...document.querySelectorAll('.ember-palette-row .ember-palette-title')].map(e => e.textContent)
  document.querySelector('.ember-palette').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return rows
})()`)
check('task runner lists package.json scripts', tasks.includes('dev') && tasks.includes('dist'), JSON.stringify(tasks.slice(0, 6)))

// ---- wave 3: cross-session search ----
await sleep(400)
const found = await ev(`(async () => {
  window.__ember.openPalette('?BLOCK_THREE')
  await new Promise(r => setTimeout(r, 900))
  const rows = [...document.querySelectorAll('.ember-palette-row .ember-palette-title')].map(e => e.textContent)
  document.querySelector('.ember-palette').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return rows
})()`)
check('cross-session search finds a line', found.some((r) => /BLOCK_THREE/.test(r)), JSON.stringify(found.slice(0, 3)))

// ---- unread badge ----
await ev(`document.querySelector('.ember-newtab').click()`)
await sleep(2600)
await ev(`window.__ember.writeTo(0, "Write-Output 'BACKGROUND_NOISE'\\r")`)
await sleep(1800)
const unread = await ev(`document.querySelectorAll('.ember-card.has-unread').length`)
check('background output raises an unread badge', unread >= 1, `${unread} card(s)`)

// force a save, then relaunch and check the scrollback came back
await sleep(4800)
ws.close()
child.kill()
await sleep(1500)

// ---------- second run ----------
child = spawn('./node_modules/electron/dist/electron.exe', ['.', '--remote-debugging-port=9347'], {
  stdio: 'ignore',
  env: PROBE_ENV,
})
;({ ws, send, ev } = await connect(9347, child))
await sleep(5000)

const restored = await ev(`window.__ember.sessions().map(s => s.text).join('\\n')`)
const anyText = await ev(`(() => {
  const out = []
  for (const s of window.__ember.sessions()) {
    const t = s.id
    out.push(t)
  }
  return window.__ember.scrollbackText()
})()`)
check(
  'scrollback survives a relaunch',
  /BLOCK_ONE|BLOCK_THREE|restored/.test(anyText ?? restored ?? ''),
  ((anyText ?? '').match(/BLOCK_\w+|restored/g) ?? []).slice(0, 4).join(','),
)

// Restored scrollback must never re-enable terminal modes: SerializeAddon captures
// them, and replaying ?1003h into a fresh shell turns every mouse click into typed
// escape codes at the prompt.
const sbDir = join(EMBER_HOME, 'scrollback')
const saved = existsSync(sbDir)
  ? readdirSync(sbDir).map((f) => readFileSync(join(sbDir, f), 'utf8'))
  : []
const modeSets = saved.join('').match(/\x1b\[\?[0-9;]*h/g) ?? []
check('saved scrollback contains no mode-set sequences', modeSets.length === 0, modeSets.slice(0, 5).join(' '))

const liveModes = await ev(`(() => {
  const s = window.__ember.sessions()[0]
  return { buffer: s.bufferType }
})()`)
check('restored session is on the normal buffer', liveModes.buffer === 'normal', JSON.stringify(liveModes))

writeFileSync(
  `${process.env.TEMP}\\ember-waves.png`,
  Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'),
)
ws.close()
child.kill()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
