/**
 * Native canvas, Phase 1 (docs/specs/canvas-native.md): a Claude tab with `canvas.native`
 * on runs Claude Code in structured mode, hosted by main, and the canvas draws it.
 *
 * Two runs of a dev Ember, each with its own EMBER_HOME:
 *   1. a stand-in (scripts/fake-claude.mjs, via EMBER_CLAUDE_BIN): the spawn args, a reply
 *      drawn on the canvas, the shell untouched, interrupt, Allow on a permission card,
 *      Ctrl+` to the CLI view (a stand-in TUI) and back, and the process gone when the tab closes.
 *   2. the real `claude`, `--model haiku`, in a fresh temp folder: "Reply with the word ok."
 *
 * Keys go to Ember's own input box only. Nothing is typed into a terminal running claude.
 *
 *   npm run build; node scripts/probe-native.mjs [out-dir] [--fake-only]
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const args = process.argv.slice(2)
const OUT = args.find((a) => !a.startsWith('--')) ?? join(process.env.TEMP ?? '.', 'ember-native-shots')
const FAKE_ONLY = args.includes('--fake-only')
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

/** A dev Ember with native mode on, driven over CDP. */
async function ember(name, port, env) {
  const home = join(process.env.TEMP ?? '.', `ember-probe-native-${name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false }, canvas: { native: true } }))
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
  /** Type into Ember's own input, then Enter. */
  const say = async (text) => {
    await ev(`document.querySelector('.loom-native-input').focus()`)
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
  const close = () => {
    ws.close()
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await wait(5000)
  return { ev, shot, key, say, until, close, home }
}

/** Open a native Claude tab in `cwd`, close the starting one. */
async function claudeTab(e, cwd) {
  const first = await e.ev('window.__ember.activeTab()')
  const tab = await e.ev(`window.__ember.newClaude(${JSON.stringify(cwd)})`)
  await e.ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await e.ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  return tab
}

const loom = (e, tab) => e.ev(`window.__ember.loom(${JSON.stringify(tab)})`)

// ---------------------------------------------------------------- 1. the stand-in

{
  const log = join(process.env.TEMP ?? '.', 'ember-fake-claude.log')
  rmSync(log, { force: true })
  const folder = join(process.env.TEMP ?? '.', 'ember-native-fake')
  mkdirSync(folder, { recursive: true })
  const e = await ember('fake', Number(process.env.PROBE_PORT) || 9441, { EMBER_CLAUDE_BIN: join(REPO, 'scripts', 'fake-claude.mjs'), FAKE_CLAUDE_LOG: log })
  try {
    const tab = await claudeTab(e, folder)
    const ready = await e.until(async () => (await loom(e, tab))?.native?.phase === 'idle', 15000)
    check('stand-in comes up', !!ready)
    // The log is shared by every stand-in this Ember starts (the tab it opened with too): this tab's is the one with its id.
    const logged = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    const at = logged.findLastIndex((l) => l.argv && l.env?.EMBER_TAB_ID === tab)
    const head = logged[at] ?? { argv: [] }
    const argv = head.argv.join(' ')
    for (const a of ['--output-format stream-json', '--input-format stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool stdio', '--session-id', '--mcp-config', '--settings'])
      check(`spawned with ${a}`, argv.includes(a))
    check('runs in the tab folder, by its long path', head.cwd?.toLowerCase() === realpathSync.native(folder).toLowerCase(), head.cwd)
    check('carries the tab id', head.env?.EMBER_TAB_ID === tab && head.env?.EMBER_SURFACE === 'canvas')
    check('initialize sent first', logged.slice(at + 1).find((l) => l.in)?.subtype === 'initialize')
    const focus = await e.ev(`document.activeElement?.className`)
    check('the keyboard is in Ember\'s input, not the shell', focus === 'loom-native-input', focus)
    await e.shot('native-fake-idle')

    await e.say('hello canvas')
    const replied = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && l.text.includes('Hello from the fake Claude') ? l : null
    }, 10000)
    check('reply drawn on the canvas', !!replied, replied ? JSON.stringify(replied.text.slice(0, 120)) : '')
    check('your words drawn as the turn', !!replied?.text.includes('hello canvas'))
    const shell = await e.ev(`window.__ember.sessions()[0].text`)
    check('nothing typed into the shell', !String(shell).includes('hello canvas'))
    console.log('      shots:', await e.shot('native-fake-reply'))

    await e.say('slow please')
    const working = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'working' && l.native.live.length > 40 ? l : null
    }, 8000)
    check('working, with the reply streaming in', !!working, working ? `live ${working.native.live.length} chars` : '')
    const writing = await e.ev(`(() => { const w = document.querySelector('.loom-writing'); return !!w && w.getBoundingClientRect().height > 0 })()`)
    check('the words so far are on screen', !!writing)
    console.log('      shots:', await e.shot('native-fake-working'))
    await e.key('Escape', 'Escape', 27)
    const stopped = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && /interrupted/i.test(l.text) ? l : null
    }, 8000)
    check('Esc interrupts the turn', !!stopped)

    await e.say('ask me first')
    const asked = await e.until(async () => ((await loom(e, tab))?.native?.asks === 1 ? true : null), 8000)
    check('permission card shown', !!asked)
    console.log('      shots:', await e.shot('native-fake-ask'))
    await e.ev(`document.querySelector('.loom-ask-card button[data-a="yes"]').click()`)
    const allowed = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && l.text.includes('you said allow') ? l : null
    }, 8000)
    check('Allow reaches Claude Code', !!allowed)

    // Ctrl+`: the CLI view, here with a stand-in TUI (scripts/fake-claude-tui.mjs) in place of `claude`.
    const tuiLog = join(process.env.TEMP ?? '.', `ember-fake-tui-native${process.env.PROBE_TAG ?? ''}.log`)
    rmSync(tuiLog, { force: true })
    await e.ev(`window.__ember.cliBin(${JSON.stringify(`node "${join(REPO, 'scripts', 'fake-claude-tui.mjs')}" --log "${tuiLog}"`)})`)
    const before = (await loom(e, tab))?.native?.pid
    await e.key('`', 'Backquote', 192, 2)
    const inCli = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.cli && l.mode === 'raw' ? l : null
    }, 15000)
    check('Ctrl+` opens the session in the CLI view', !!inCli && !alive(before), inCli?.cliLine)
    await e.key('`', 'Backquote', 192, 2)
    const after = await e.until(async () => {
      const l = await loom(e, tab)
      return !l?.native?.cli && l?.native?.phase === 'idle' && l.mode === 'claude' ? l : null
    }, 15000)
    check('Ctrl+` again comes back to the canvas', !!after)

    const pid = after?.native?.pid
    check('process alive while the tab is open', !!pid && alive(pid), String(pid))
    await e.ev(`window.__ember.newTab()`)
    await e.ev(`window.__ember.closeTab(${JSON.stringify(tab)})`)
    const gone = await e.until(async () => (!alive(pid) ? true : null), 6000)
    check('process gone when the tab closes', !!gone)
  } finally {
    e.close()
  }
}

// ---------------------------------------------------------------- 2. the real one

if (!FAKE_ONLY) {
  const folder = join(process.env.TEMP ?? '.', `ember-native-real-${Date.now()}`)
  mkdirSync(folder, { recursive: true })
  const e = await ember('real', (Number(process.env.PROBE_PORT) || 9441) + 1, { EMBER_CLAUDE_ARGS: '--model haiku' })
  try {
    const tab = await claudeTab(e, folder)
    const t0 = Date.now()
    const ready = await e.until(async () => (await loom(e, tab))?.native?.phase === 'idle', 90000)
    check('real claude comes up', !!ready, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
    await e.say('Reply with the word ok.')
    const done = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && Object.keys(l.native.counts).some((k) => k.startsWith('result')) ? l : null
    }, 120000)
    const text = done?.text ?? ''
    console.log('      canvas text:', JSON.stringify(text.slice(0, 200)))
    console.log('      model:', done?.native?.model, ' counts:', JSON.stringify(done?.native?.counts ?? {}))
    check('real reply "ok" drawn on the canvas', /\bok\b/i.test(text.replace('Reply with the word ok.', '')))
    console.log('      shots:', await e.shot('native-real-reply'))
    const pid = done?.native?.pid
    await e.ev(`window.__ember.newTab()`)
    await e.ev(`window.__ember.closeTab(${JSON.stringify(tab)})`)
    const gone = pid ? await e.until(async () => (!alive(pid) ? true : null), 8000) : null
    check('real process gone when the tab closes', !!gone)
  } finally {
    e.close()
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
