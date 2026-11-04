/**
 * The CLI view and back, against the real `claude` (haiku): a Claude tab hands its session
 * to Claude Code's own screen (Ctrl+`) and takes it back, again and again.
 *
 * A dev Ember (own EMBER_HOME, ANTHROPIC_MODEL=haiku so the TUI is cheap too) in a folder
 * under ~/agent-box (trusted there, its own transcripts). Rounds, each screenshotted:
 *   1. plain there and back
 *   2. Ctrl+` twice quickly (ends in one view, never half of each)
 *   3. a message typed in the CLI view, then back: the canvas shows that turn
 *   4. /clear in the CLI view, then back: the canvas is on the new session
 *   5. mid-turn on the canvas: the confirm card, yes, then back
 *   6. the TUI showing a dialog (/model), then back: stopped, nothing answered
 *   7. a folder the TUI never trusted: its trust question, answered, then back
 *   8. /exit typed in the CLI view: back on the canvas by itself
 * Every round checks: no `__emberCli` line or ^C left on screen, no turn shown twice or
 * lost, the keyboard in the right place.
 *
 * Keys are typed into this probe's own test TUI (rounds 3, 4, 6, 7, 8) — never into a
 * terminal of yours.
 *
 *   npm run build; node scripts/probe-cli-handoff.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-handoff-shots')
mkdirSync(OUT, { recursive: true })
const PORT = Number(process.env.PROBE_PORT) || 9462
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const home = join(process.env.TEMP ?? '.', 'ember-probe-handoff')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const folder = join(homedir(), 'agent-box', '.ember-cli-probe')
mkdirSync(folder, { recursive: true })

const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1', EMBER_CLAUDE_ARGS: '--model haiku', ANTHROPIC_MODEL: 'haiku' },
})
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
let shotN = 0
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  return file
}
const key = (k, code, vk, modifiers = 0, text) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() =>
    send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  )
const ctrlBacktick = () => key('`', 'Backquote', 192, 2)
const enter = () => key('Enter', 'Enter', 13, 0, '\r')
const until = async (fn, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await wait(300)
  }
  return null
}
let tab = ''
const loom = () => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
const focus = () => ev(`document.activeElement?.className ?? ''`)
/** Type into Ember's own input, then Enter. */
const say = async (text) => {
  await ev(`document.querySelector('.loom-native-input').focus()`)
  await send('Input.insertText', { text })
  await enter()
}
/** Type into the CLI view's TUI (the probe's own), as keys. */
const tuiType = async (text) => {
  await send('Input.insertText', { text })
  await wait(300)
}
const turns = async () => (await loom())?.turns ?? -1
const idle = () => until(async () => ((await loom())?.native?.phase === 'idle' ? true : null), 90_000)
/** The TUI is up with its input box. */
const tuiReady = () =>
  until(async () => {
    const l = await loom()
    if (!l?.native?.cli || !l.tuiRunning) return null
    return l.rows.some((r, y) => y > 0 && /^\s?[❯>](\s|$)/.test(r) && /^[─━]{20,}\s*$/.test(l.rows[y - 1].trim())) ? l : null
  }, 60_000)
const onCanvas = () =>
  until(async () => {
    const l = await loom()
    return l && !l.native?.cli && !l.tuiRunning && l.native?.phase === 'idle' && l.mode === 'claude' ? l : null
  }, 90_000)
const noNoise = (l) => !(l?.rows ?? []).some((r) => /__emberCli|\^C/.test(r))

async function toCli(name) {
  await ctrlBacktick()
  const l = await tuiReady()
  check(`${name}: the CLI view is up`, !!l)
  check(`${name}: no hand-off line or ^C on screen`, noNoise(l), (l?.rows ?? []).filter((r) => /__emberCli|\^C/.test(r)).join(' | '))
  const f = await focus()
  check(`${name}: keyboard in the terminal`, /xterm-helper-textarea/.test(f), f)
  console.log('      shot:', await shot(`${name}-cli`))
  return l
}
async function toCanvas(name, expectTurns) {
  await ctrlBacktick()
  const l = await onCanvas()
  check(`${name}: back on the canvas`, !!l, l ? '' : JSON.stringify((await loom())?.native?.phase))
  const f = await focus()
  check(`${name}: keyboard in Ember's input`, f === 'loom-native-input', f)
  if (expectTurns !== undefined) check(`${name}: turns on the canvas`, l?.turns === expectTurns, `${l?.turns} (want ${expectTurns})`)
  console.log('      shot:', await shot(`${name}-canvas`))
  return l
}

try {
  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  tab = await ev(`window.__ember.newClaude(${JSON.stringify(folder)})`)
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  check('Claude Code comes up', !!(await idle()))
  await say('Reply with just the word one.')
  await wait(1500)
  await idle()
  const t0 = await turns()
  check('a first turn on the canvas', t0 === 1 && /\bone\b/i.test((await loom())?.text ?? ''), String(t0))
  const sid0 = (await loom())?.native?.resumable
  console.log('      shot:', await shot('start'))

  // 1. plain
  await toCli('r1')
  let l = await toCanvas('r1', t0)
  check('r1: same session', l?.native?.resumable === sid0)

  // 2. twice quickly
  await ctrlBacktick()
  await wait(80)
  await ctrlBacktick()
  await wait(8000)
  l = await loom()
  const settled = l?.native?.cli ? !!(await tuiReady()) : !!(await onCanvas())
  check('r2: Ctrl+` twice quickly ends in one whole view', settled, `cli=${l?.native?.cli} tui=${l?.tuiRunning} phase=${l?.native?.phase}`)
  console.log('      shot:', await shot('r2-settled'))
  if ((await loom())?.native?.cli) await toCanvas('r2', t0)

  // 3. a message in the CLI view
  await toCli('r3')
  await tuiType('Reply with just the word two.')
  await key('Enter', 'Enter', 13, 0, '\r')
  const answered = await until(async () => {
    const x = await loom()
    return x?.tuiRunning && !x.rows.some((r) => /esc to interrupt/i.test(r)) && x.rows.some((r) => /\btwo\b/i.test(r) && !/Reply with/.test(r)) ? true : null
  }, 90_000)
  check('r3: the TUI answered', !!answered)
  await wait(2000)
  console.log('      shot:', await shot('r3-cli-answered'))
  l = await toCanvas('r3', t0 + 1)
  check('r3: the canvas shows the CLI turn', /\btwo\b/i.test(l?.text ?? ''))
  await say('Reply with just the word three.')
  await wait(1500)
  await idle()
  l = await loom()
  check('r3: a canvas turn after it, nothing twice', l?.turns === t0 + 2 && /\bthree\b/i.test(l?.text ?? ''), String(l?.turns))

  // 4. /clear in the CLI view
  const before4 = (await loom())?.native?.resumable
  await toCli('r4')
  await tuiType('/clear')
  await wait(500)
  await key('Enter', 'Enter', 13, 0, '\r')
  await wait(4000)
  console.log('      shot:', await shot('r4-cli-cleared'))
  l = await toCanvas('r4')
  check('r4: the canvas is on the new session', !!l?.native?.resumable && l.native.resumable !== before4, `${before4?.slice(0, 8)} → ${l?.native?.resumable?.slice(0, 8)}`)
  check('r4: the canvas started over', (l?.turns ?? 9) === 0, String(l?.turns))
  await say('Reply with just the word four.')
  await wait(1500)
  await idle()
  l = await loom()
  check('r4: and goes on there', l?.turns === 1 && /\bfour\b/i.test(l?.text ?? ''), String(l?.turns))

  // 5. mid-turn
  await say('Count from 1 to 60, one number per line, nothing else.')
  await until(async () => ((await loom())?.native?.phase === 'working' ? true : null), 20_000)
  await wait(1200)
  await ctrlBacktick()
  const asked = await until(async () => ((await loom())?.native?.askKinds?.includes('confirm') ? true : null), 8000)
  check('r5: mid-turn, Ctrl+` asks first', !!asked)
  console.log('      shot:', await shot('r5-confirm'))
  await ev(`document.querySelector('.loom-ask-card.is-confirm button[data-a="yes"]').click()`)
  l = await tuiReady()
  check('r5: yes → the CLI view', !!l && noNoise(l))
  console.log('      shot:', await shot('r5-cli'))
  const t5 = (await loom())?.turns
  l = await toCanvas('r5')
  check('r5: no turn lost or doubled', l?.turns === t5, `${t5} → ${l?.turns}`)

  // 6. a dialog in the TUI
  await toCli('r6')
  await tuiType('/model')
  await wait(400)
  await key('Enter', 'Enter', 13, 0, '\r')
  await wait(2500)
  console.log('      shot:', await shot('r6-cli-dialog'))
  const t6 = (await loom())?.turns
  l = await toCanvas('r6')
  check('r6: back from a dialog, nothing changed', l?.turns === t6 && noNoise(l), String(l?.turns))

  // 8. /exit in the CLI view
  await toCli('r8')
  await tuiType('/exit')
  await wait(400)
  await key('Enter', 'Enter', 13, 0, '\r')
  l = await onCanvas()
  check('r8: /exit in the CLI view → back on the canvas by itself', !!l)
  check('r8: keyboard in Ember\'s input', (await focus()) === 'loom-native-input', await focus())
  console.log('      shot:', await shot('r8-canvas'))

  // 7. an untrusted folder
  const fresh = join(process.env.TEMP ?? '.', `ember-handoff-untrusted-${Date.now()}`)
  mkdirSync(fresh, { recursive: true })
  const old = tab
  tab = await ev(`window.__ember.newClaude(${JSON.stringify(fresh)})`)
  await ev(`window.__ember.closeTab(${JSON.stringify(old)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await idle()
  await say('Reply with just the word five.')
  await wait(1500)
  await idle()
  await ctrlBacktick()
  const trust = await until(async () => {
    const x = await loom()
    return x?.native?.cli && x.rows.some((r) => /trust/i.test(r)) ? x : null
  }, 40_000)
  console.log('      shot:', await shot('r7-trust'))
  if (trust) {
    await key('Enter', 'Enter', 13, 0, '\r')
    l = await tuiReady()
    check('r7: trust answered, the TUI comes up', !!l)
    console.log('      shot:', await shot('r7-cli'))
  } else check('r7: (folder was already trusted: no question)', !!(await tuiReady()))
  l = await toCanvas('r7', 1)
  check('r7: the canvas holds its turn', /\bfive\b/i.test(l?.text ?? ''))

  console.log(failed ? `\n${failed} failed` : '\nall passed')
} catch (err) {
  console.log('FAIL  threw', err?.stack ?? err)
  failed++
} finally {
  ws.close()
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
process.exit(failed ? 1 : 0)
