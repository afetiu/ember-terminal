/**
 * Native canvas, Phase 4 (docs/specs/canvas-native.md): the bar's switches, the CLI view
 * hand-off, sessions across restarts, the sidebar card and the canvas hint.
 *
 * Runs of a dev Ember, each with its own EMBER_HOME (CDP ports 9445/9446 unless PROBE_PORT):
 *   1. the stand-in (scripts/fake-claude.mjs), with a stand-in TUI (scripts/fake-claude-tui.mjs)
 *      as what the CLI view runs: the mode chip and Shift+Tab, the model picker, effort and
 *      the context meter (control requests read back from the stand-in's log); the hint;
 *      the card; `/clear` moving the session to a new id; Ctrl+` to the CLI view and back
 *      (`--resume <id>` in the shell, the canvas's process stopped, then resumed); the
 *      "stop the turn?" question; `/login` typed into the TUI.
 *   2. the same EMBER_HOME again: the tab comes back on its session (`--resume`).
 *   3. once more, with that session gone: a new one starts, said so.
 *   4. the real `claude` (`--model haiku`, in ~/agent-box, a folder the TUI trusts): one turn, the CLI view
 *      (the real TUI, `claude --resume <id>`), back, and a second turn that remembers the first.
 *
 * Nothing is typed into a terminal running claude by this script: the CLI view's own
 * hand-off (Ctrl+C twice to leave the TUI) is the feature under test.
 *
 *   npm run build; node scripts/probe-native-bar.mjs [out-dir] [--fake-only | --real-only]
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const args = process.argv.slice(2)
const OUT = args.find((a) => !a.startsWith('--')) ?? join(process.env.TEMP ?? '.', 'ember-native-bar-shots')
const FAKE_ONLY = args.includes('--fake-only')
const REAL_ONLY = args.includes('--real-only')
const PORT = Number(process.env.PROBE_PORT) || 9445
const TAG = process.env.PROBE_TAG ?? ''
mkdirSync(OUT, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}
const alive = (pid) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid))
  } catch {
    return false
  }
}

/** A dev Ember with native mode on, driven over CDP. `fresh` wipes its EMBER_HOME first. */
async function ember(name, port, env, fresh = true) {
  const home = join(process.env.TEMP ?? '.', `ember-probe-native-bar-${name}${TAG}`)
  if (fresh) {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false }, canvas: { native: true } }))
  }
  if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) throw new Error(`port ${port} is taken`)
  const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${port}`], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1', ...env },
  })
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
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
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${file}.png`), Buffer.from(r.data, 'base64'))
    return join(OUT, `${file}.png`)
  }
  const key = (k, code, vk, modifiers = 0, text) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    )
  const focusInput = () => ev(`document.querySelector('.loom-native-input').focus()`)
  const say = async (text) => {
    await focusInput()
    await send('Input.insertText', { text })
    await key('Enter', 'Enter', 13, 0, '\r')
  }
  const until = async (fn, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await wait(250)
    }
    return null
  }
  const close = async () => {
    ws.close()
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await until(async () => !(await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)), 10000)
    await wait(800)
  }
  await wait(4000)
  return { ev, shot, key, say, focusInput, until, close, home, send }
}

const loom = (e, tab) => e.ev(`window.__ember.loom(${JSON.stringify(tab)})`)
const ctrlBacktick = (e) => e.key('`', 'Backquote', 192, 2)
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const saved = (home) => {
  try {
    return JSON.parse(readFileSync(join(home, 'native-tabs.json'), 'utf8'))
  } catch {
    return null
  }
}

const log = join(process.env.TEMP ?? '.', `ember-fake-claude-bar${TAG}.log`)
const tuiLog = join(process.env.TEMP ?? '.', `ember-fake-tui-bar${TAG}.log`)
const folder = join(process.env.TEMP ?? '.', 'ember-native-bar-fake')
mkdirSync(folder, { recursive: true })
const fakeEnv = { EMBER_CLAUDE_BIN: join(REPO, 'scripts', 'fake-claude.mjs'), FAKE_CLAUDE_LOG: log }
const cliBin = `node "${join(REPO, 'scripts', 'fake-claude-tui.mjs')}" --log "${tuiLog}"`
const controls = (sub) => lines(log).filter((l) => l.in === 'control_request' && l.subtype === sub)
const argvs = () => lines(log).filter((l) => l.argv)
let sessionId = ''

// ---------------------------------------------------------------- 1. the stand-in

if (!REAL_ONLY) {
  rmSync(log, { force: true })
  rmSync(tuiLog, { force: true })
  const e = await ember('fake', PORT, fakeEnv)
  try {
    await e.ev(`window.__ember.cliBin(${JSON.stringify(cliBin)})`)
    const first = await e.ev('window.__ember.activeTab()')
    const tab = await e.ev(`window.__ember.newClaude(${JSON.stringify(folder)})`)
    await e.ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
    await e.ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    const ready = await e.until(async () => ((await loom(e, tab))?.native?.phase === 'idle' ? true : null), 15000)
    check('stand-in comes up', !!ready)

    // ---- the hint and the card
    let l = await loom(e, tab)
    check('hint shows on an empty canvas', l?.hint === true)
    await e.focusInput()
    await e.send('Input.insertText', { text: '/' })
    await wait(300)
    l = await loom(e, tab)
    check('hint hides while the / menu is open', !!l?.native?.menu && l.hint === false)
    await e.key('Escape', 'Escape', 27)
    await e.ev(`(() => { const i = document.querySelector('.loom-native-input'); i.value = ''; i.dispatchEvent(new Event('input')); return true })()`)
    const card = await e.ev(`window.__ember.card(${JSON.stringify(tab)})`)
    check('sidebar card says Claude Code and the folder, not the shell', /Claude Code/.test(card) && /ember-native-bar-fake/.test(card) && !/PowerShell/.test(card), JSON.stringify(card))

    // ---- the bar
    const models = l?.native?.models ?? []
    check('models from initialize', models.join(',') === 'default,sonnet,haiku', models.join(','))
    await e.ev(`document.querySelector('.loom-bar-mode').click()`)
    await wait(300)
    await e.focusInput()
    await e.key('Tab', 'Tab', 9, 8)
    await wait(200)
    await e.key('Tab', 'Tab', 9, 8)
    await wait(300)
    const modeReqs = controls('set_permission_mode').map((c) => c.request.mode)
    check('mode chip, then Shift+Tab, cycle the permission mode', modeReqs.join(',') === 'acceptEdits,plan,auto', modeReqs.join(','))
    await e.key('Tab', 'Tab', 9, 8)
    await wait(300)
    l = await loom(e, tab)
    check('…and round to default; never bypass', l?.native?.permissionMode === 'default' && !controls('set_permission_mode').some((c) => /bypass/i.test(c.request.mode)), l?.native?.modes?.join(','))
    await e.ev(`document.querySelector('.loom-bar-pickmodel').click()`)
    await wait(300)
    const pick = await e.ev(`[...document.querySelectorAll('.loom-bar-pick.is-on [data-model]')].map((b) => b.dataset.model).join(',')`)
    check('model picker lists Claude Code\'s models', pick === 'default,sonnet,haiku', pick)
    l = await loom(e, tab)
    check('hint hides while the picker is open', l?.hint === false)
    console.log('      shots:', await e.shot('bar-model-picker'))
    await e.ev(`document.querySelector('.loom-bar-pick [data-model="sonnet"]').click()`)
    await wait(400)
    const setModel = controls('set_model')
    check('picking a model sends set_model', setModel[0]?.request?.model === 'sonnet', JSON.stringify(setModel[0]?.request))
    const barText = await e.ev(`document.querySelector('.loom-bar').innerText`)
    check('the bar shows the picked model', /Sonnet/.test(barText), JSON.stringify(barText))
    await e.ev(`document.querySelector('.loom-bar-effort').click()`)
    await wait(300)
    const eff = controls('apply_flag_settings')
    check('effort chip sends apply_flag_settings', ['low', 'medium', 'high'].includes(eff[0]?.request?.settings?.effortLevel), JSON.stringify(eff[0]?.request))

    // ---- a turn: context meter, hint gone, session remembered
    await e.say('hello bar')
    const replied = await e.until(async () => {
      const x = await loom(e, tab)
      return x?.native?.phase === 'idle' && x.native.context != null && x.text.includes('Hello from the fake Claude') ? x : null
    }, 10000)
    check('after a turn: get_context_usage, and the meter', !!replied && controls('get_context_usage').length > 0 && /\d+%/.test(await e.ev(`document.querySelector('.loom-bar').innerText`)), `${replied?.native?.context}%`)
    check('hint gone after the turn', replied?.hint === false)
    sessionId = replied?.native?.resumable ?? ''
    const s1 = saved(e.home)
    check('the tab\'s session id and folder are saved', !!sessionId && s1?.[0]?.sessionId === sessionId && /ember-native-bar-fake/i.test(s1?.[0]?.cwd ?? ''), JSON.stringify(s1))
    console.log('      shots:', await e.shot('bar-after-turn'))

    // ---- /clear: the canvas starts over, the session moves to a new id
    await e.say('/clear')
    const cleared = await e.until(async () => {
      const x = await loom(e, tab)
      return x?.native?.phase === 'idle' && x.native.resumable && x.native.resumable !== sessionId ? x : null
    }, 10000)
    check('/clear: a new session id, saved', !!cleared && saved(e.home)?.[0]?.sessionId === cleared.native.resumable, `${sessionId.slice(0, 8)} → ${cleared?.native?.resumable?.slice(0, 8)}`)
    check('/clear: the canvas is empty again, hint back', !!cleared && !cleared.text.includes('hello bar') && cleared.hint === true)
    await e.say('after clear')
    const again = await e.until(async () => {
      const x = await loom(e, tab)
      return x?.native?.phase === 'idle' && x.text.includes('after clear') && x.text.includes('Hello from') ? x : null
    }, 10000)
    sessionId = again?.native?.resumable ?? sessionId

    // ---- the CLI view and back
    const pidBefore = again?.native?.pid
    await ctrlBacktick(e)
    const inCli = await e.until(async () => {
      const x = await loom(e, tab)
      return x?.native?.cli && x.tuiRunning && x.rows.some((r) => r.includes('Claude Code v')) ? x : null
    }, 15000)
    const tuiArgv = lines(tuiLog).find((x) => x.argv)?.argv ?? []
    check('Ctrl+`: the canvas\'s process stops', !!pidBefore && !alive(pidBefore))
    check('Ctrl+`: the TUI runs on the session in the tab\'s shell (__emberCli, --resume <id>, Ember\'s settings)', !!inCli && inCli.cliLine.startsWith('__emberCli ') && inCli.cliLine.includes(`-Id ${sessionId}`) && tuiArgv.join(' ').endsWith(`--resume ${sessionId}`) && tuiArgv.includes('--settings'), `${inCli?.cliLine} | ${tuiArgv.join(' ')}`)
    const rowsCli = (await loom(e, tab))?.rows ?? []
    check('…and its line is not left on screen', !rowsCli.some((r) => r.includes('__emberCli')), rowsCli.filter((r) => r.trim()).slice(0, 3).join(' / '))
    check('the sidebar card says CLI', /CLI/.test(await e.ev(`window.__ember.card(${JSON.stringify(tab)})`)))
    console.log('      shots:', await e.shot('cli-view'))
    await ctrlBacktick(e)
    const back = await e.until(async () => {
      const x = await loom(e, tab)
      return !x?.native?.cli && x?.native?.phase === 'idle' && x.mode === 'claude' ? x : null
    }, 15000)
    const resumed = argvs().pop()?.argv.join(' ') ?? ''
    check('Ctrl+` back: the TUI stopped from outside (no keys sent to it)', back?.tuiRunning === false && !lines(tuiLog).some((x) => x.key === '\x03'))
    check('…and the canvas resumes the session (--resume <id>)', !!back && resumed.includes(`--resume ${sessionId}`), resumed.slice(-60))
    check('…with the turns still on the canvas', !!back?.text.includes('after clear'))
    const focus = await e.ev(`document.activeElement?.className`)
    check('…and the keyboard back in Ember\'s input', focus === 'loom-native-input', focus)

    // ---- mid-turn: asked first
    await e.say('slow please')
    await e.until(async () => ((await loom(e, tab))?.native?.phase === 'working' ? true : null), 8000)
    await ctrlBacktick(e)
    const asked = await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.includes('confirm') ? true : null), 5000)
    check('mid-turn, Ctrl+` asks "Stop the current turn and open the CLI?"', !!asked)
    console.log('      shots:', await e.shot('cli-confirm'))
    await e.key('Escape', 'Escape', 27)
    await wait(400)
    l = await loom(e, tab)
    check('Esc = no: still on the canvas, still working', !l?.native?.cli && l?.native?.phase === 'working' && !l?.native?.askKinds?.includes('confirm'))
    const interruptsBefore = controls('interrupt').length
    await ctrlBacktick(e)
    await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.includes('confirm') ? true : null), 5000)
    await e.ev(`document.querySelector('.loom-ask-card.is-confirm button[data-a="yes"]').click()`)
    const inCli2 = await e.until(async () => ((await loom(e, tab))?.native?.cli ? true : null), 15000)
    check('yes: the turn is interrupted, then the CLI view opens', !!inCli2 && controls('interrupt').length > interruptsBefore)
    await wait(1500)
    await ctrlBacktick(e)
    await e.until(async () => {
      const x = await loom(e, tab)
      return !x?.native?.cli && x?.native?.phase === 'idle' ? true : null
    }, 15000)

    // ---- a command only the TUI has
    rmSync(tuiLog, { force: true })
    await e.say('/login')
    const typed = await e.until(async () => (lines(tuiLog).some((x) => x.submitted === '/login') ? true : null), 20000)
    check('/login opens the CLI view and is typed into the TUI once its prompt is up', !!typed)
    await ctrlBacktick(e)
    const back3 = await e.until(async () => {
      const x = await loom(e, tab)
      return !x?.native?.cli && x?.native?.phase === 'idle' ? x : null
    }, 15000)
    check('and back again', !!back3)
    sessionId = back3?.native?.resumable ?? sessionId
    console.log('      shots:', await e.shot('back-on-canvas'))
  } finally {
    await e.close()
  }
}

// ---------------------------------------------------------------- 2. a restart

if (!REAL_ONLY) {
  const before = argvs().length
  const e = await ember('fake', PORT, fakeEnv, false)
  try {
    const tab = await e.ev('window.__ember.activeTab()')
    const up = await e.until(async () => ((await loom(e, tab))?.native?.phase === 'idle' ? true : null), 15000)
    const started = argvs().slice(before)
    check('after a restart the tab comes back', !!up && started.length === 1, `${started.length} started`)
    check('…on its session: --resume <id>, in its folder', started[0]?.argv.join(' ').includes(`--resume ${sessionId}`) && /ember-native-bar-fake/i.test(started[0]?.cwd ?? ''), started[0]?.argv.slice(-8).join(' '))
    console.log('      shots:', await e.shot('restored'))
  } finally {
    await e.close()
  }
}

// ---------------------------------------------------------------- 3. the session is gone

if (!REAL_ONLY) {
  const before = argvs().length
  const e = await ember('fake', PORT, { ...fakeEnv, FAKE_CLAUDE_MISSING: sessionId }, false)
  try {
    const tab = await e.ev('window.__ember.activeTab()')
    const up = await e.until(async () => {
      const x = await loom(e, tab)
      return x?.native?.phase === 'idle' && /Could not pick up the last session/.test(x.text) ? x : null
    }, 15000)
    const started = argvs().slice(before)
    check('a session that is gone: said so, and a new one starts', !!up && started.length === 2 && started[1].argv.includes('--session-id'), JSON.stringify(up?.text?.slice(0, 120)))
  } finally {
    await e.close()
  }
}

// ---------------------------------------------------------------- 4. the real one

if (!FAKE_ONLY) {
  const e = await ember('real', PORT + 1, { EMBER_CLAUDE_ARGS: '--model haiku' })
  try {
    const first = await e.ev('window.__ember.activeTab()')
    // A folder Claude Code's own screen already trusts: a new one would open on its "trust this folder?" dialog.
    const trusted = process.env.PROBE_TRUSTED_DIR || join(process.env.USERPROFILE ?? '', 'agent-box')
    const tab = await e.ev(`window.__ember.newClaude(${JSON.stringify(trusted)})`)
    await e.ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
    await e.ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    const ready = await e.until(async () => ((await loom(e, tab))?.native?.phase === 'idle' ? true : null), 90000)
    check('real claude comes up', !!ready)
    await e.say('Reply with only the word: amber.')
    const done = await e.until(async () => {
      const x = await loom(e, tab)
      return x?.native?.phase === 'idle' && x.native.resumable && x.native.context != null ? x : null
    }, 120000)
    const id = done?.native?.resumable ?? ''
    check('real turn, session id known, context meter', !!done && /amber/i.test(done.text.replace('Reply with only the word: amber.', '')), `${id.slice(0, 8)} ${done?.native?.context}% ${JSON.stringify(done?.bar)}`)
    console.log('      shots:', await e.shot('real-canvas'))
    const pid = done?.native?.pid
    await ctrlBacktick(e)
    const tui = await e.until(async () => {
      const x = await loom(e, tab)
      // Claude Code may draw full-screen (mode raw) or inline (the shell's own screen): either way, its prompt under the line that started it.
      const at = x?.rows?.findIndex((r) => r.includes(`--resume ${id}`)) ?? -1
      return x?.native?.cli && x.rows.slice(Math.max(0, at)).some((r) => /^\s*❯/.test(r)) ? x : null
    }, 90000)
    check('real: Ctrl+` opens the real TUI on the session', !!tui && tui.cliLine.includes(`--resume ${id}`) && !alive(pid), tui?.cliLine)
    console.log('      shots:', await e.shot('real-cli'))
    await wait(1500)
    await ctrlBacktick(e)
    const back = await e.until(async () => {
      const x = await loom(e, tab)
      return !x?.native?.cli && x?.native?.phase === 'idle' ? x : null
    }, 90000)
    check('real: Ctrl+` back, the TUI exits and the canvas resumes', !!back && !back.tuiRunning, back ? `${back.native.resumable.slice(0, 8)}` : JSON.stringify((await loom(e, tab))?.rows?.slice(-6)))
    await e.say('Which word did you reply with a moment ago? Answer with that word only.')
    const second = await e.until(async () => {
      const x = await loom(e, tab)
      // The canvas shows the latest turn: the question, and the word from the turn before the CLI view.
      return x?.native?.phase === 'idle' && /a moment ago/.test(x.text) && /amber/i.test(x.text.split('Answer with that word only.').pop()) ? x : null
    }, 120000)
    check('real: the resumed session remembers the first turn', !!second, JSON.stringify((await loom(e, tab))?.text?.slice(-120)))
    console.log('      shots:', await e.shot('real-back'))
  } finally {
    await e.close()
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
