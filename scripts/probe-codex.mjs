/**
 * Codex on the canvas: the Codex TUI in a terminal tab, wrapped by CodexTui — one process,
 * the canvas drawn from its rollout log, Ember's composer typing into its prompt.
 *
 *   npm run build; node scripts/probe-codex.mjs [--fake] [out-dir]
 *
 * Real Codex (when `codex login status` says it is signed in, and --fake is not given):
 *   0. a new tab is a plain shell; typing `codex` in it turns the canvas on;
 *   1. Codex's "Hooks need review" screen is a banner with Open CLI, not a crop; in the
 *      CLI, Esc skips it (the probe never trusts hooks on the person's behalf);
 *   2. one cheap turn from the composer ("reply with the word …") reaches the canvas;
 *   3. Ctrl+` shows the same TUI at once (< 300 ms, same codex.exe PID), and back;
 *   4. /quit from the composer gives the tab back to the shell.
 *
 * Fake Codex (scripts/fake-codex.mjs, its own CODEX_HOME, hooks "trusted"), for what a
 * real session only does once the person has trusted Ember's hooks, at no cost:
 *   the same 0, 2, 3, 4, and
 *   5. an approval is Ember's card (through resources/hook.mjs, as Codex calls it); Allow
 *      runs it and the canvas shows the command;
 *   6. an approval only Codex's screen asks: the banner says so, Open CLI shows it;
 *   7. a picture pasted into the composer is attached with Ctrl+V ("[Image #1]").
 *
 * Keys go to Ember's composer and cards, and — for 0 and the CLI-view steps only, the
 * person's own typing — to the terminal.
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { seedHome } from './probelib.mjs'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const argv = process.argv.slice(2)
const wantFake = argv.includes('--fake')
const OUT = argv.find((a) => !a.startsWith('--')) ?? join(process.env.TEMP ?? '.', 'ember-codex-shots')
const PORT = Number(process.env.PROBE_PORT) || 9513
const CWD = join(homedir(), 'agent-box')
mkdirSync(OUT, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// Real Codex only when it is there and signed in; never signs in.
let real = false
if (!wantFake) {
  const r = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', shell: true, timeout: 20_000 })
  real = r.status === 0 && /logged in/i.test(`${r.stdout}${r.stderr}`)
  console.log(real ? `real Codex: ${(r.stdout || r.stderr).trim()}` : 'real Codex not usable (not installed or not signed in): using the fake')
}
const FAKE = !real
console.log(FAKE ? 'MODE  fake Codex (scripts/fake-codex.mjs) — real Codex NOT tested in this run' : 'MODE  real Codex')

const home = join(process.env.TEMP ?? '.', `ember-probe-codex${FAKE ? '-fake' : ''}`)
rmSync(home, { recursive: true, force: true })
seedHome(home)
const env = { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' }
if (FAKE) {
  // `codex` on PATH is the fake; its rollouts go to a home of its own, read from there.
  const bin = join(home, 'fake-bin')
  const codexHome = join(home, 'codex-home')
  mkdirSync(bin, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(bin, 'codex.cmd'), `@echo off\r\nnode "${join(REPO, 'scripts', 'fake-codex.mjs')}" %*\r\n`)
  env.PATH = `${bin};${process.env.PATH}`
  env.CODEX_HOME = codexHome
  env.FAKE_CODEX_TRUSTED = '1'
}
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: REPO, stdio: 'ignore', env })
let ws
try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
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
  }
  const key = (k, code, vk, modifiers = 0, text) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    )
  const enter = () => key('Enter', 'Enter', 13, 0, '\r')
  const esc = () => key('Escape', 'Escape', 27)
  const switchKey = () => key('`', 'Backquote', 192, 2)
  const typeText = (text) => send('Input.insertText', { text })
  const until = async (fn, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await wait(200)
    }
    return null
  }
  await wait(4000)
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev(`window.__ember.newLoom(${JSON.stringify(CWD)})`)
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  const loom = () => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
  const w = async () => (await loom())?.wrapper ?? null
  const say = async (text) => {
    await ev(`document.querySelector('.loom-native-input').focus()`)
    await typeText(text)
    await enter()
  }
  const feedHas = (re, ms = 120_000) => until(async () => re.test((await loom())?.text ?? '') && (await loom()), ms)
  const idle = () => until(async () => (await w())?.phase === 'idle' && !(await w())?.live && (await w()), 90_000)
  /** The Codex process this Ember runs: codex.exe (real) or the fake's node.exe, under the probe's Electron. */
  const codexPid = () => {
    try {
      const ps = (cmd) => [].concat(JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `${cmd} | ConvertTo-Json -Compress`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '[]'))
      const list = ps('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name')
      const parent = new Map(list.map((p) => [p.ProcessId, p.ParentProcessId]))
      const fakes = FAKE ? new Set(ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*fake-codex.mjs*' } | Select-Object ProcessId`).map((p) => p.ProcessId)) : null
      const mine = list.filter((p) => {
        const is = FAKE ? fakes.has(p.ProcessId) : /^codex(\.exe)?$/i.test(p.Name)
        if (!is) return false
        let at = p.ParentProcessId
        for (let i = 0; i < 12 && at; i++) {
          if (at === child.pid) return true
          at = parent.get(at)
        }
        return false
      })
      return mine.map((p) => p.ProcessId).sort((a, b) => a - b)[0] ?? 0
    } catch {
      return 0
    }
  }
  const toCli = async () => {
    await switchKey()
    return until(async () => (await loom())?.mode === 'raw' && (await loom()), 3000)
  }
  const toCanvas = async () => {
    await switchKey()
    return until(async () => (await loom())?.mode === 'claude' && (await loom()), 3000)
  }

  // ---- 0. a terminal first; `codex` typed in it
  await until(async () => (await loom())?.rows?.some((r) => /PS .*>/.test(r)), 20_000)
  let l = await loom()
  check('a new tab is a plain shell (no agent started)', l.mode === 'shell' && !l.agent && l.paneVisible, `mode=${l.mode}`)
  await ev(`document.querySelector('.is-loom .xterm-helper-textarea')?.focus()`)
  await typeText('codex')
  await wait(150)
  await enter()
  const up = await until(async () => {
    const x = await loom()
    return x?.agent === 'codex' && x.mode === 'claude' && x
  }, 30_000)
  check('typing `codex` in the shell turns the canvas on (Codex on its wrapper)', !!up && up.paneVisible === false, up ? `mode=${up.mode} pane hidden=${!up.paneVisible}` : '')

  // ---- 1. what only Codex's screen has, before its prompt: a banner, never a crop
  if (!FAKE) {
    const review = await until(async () => {
      const x = await loom()
      return /review hooks|showing something/i.test(x?.wrapper?.elsewhere ?? '') && x
    }, 30_000)
    if (review) {
      check('Codex\'s startup screen (hook review) is a banner with Open CLI', /review hooks|showing something/i.test(review.wrapper.elsewhere) && review.paneVisible === false, review.wrapper.elsewhere)
      await shot('1-hook-review-banner')
      await ev(`document.querySelector('.loom-elsewhere.is-on button[data-open-cli]').click()`)
      const cli = await until(async () => (await loom())?.mode === 'raw' && (await loom()), 3000)
      check('Open CLI shows Codex\'s own screen', !!cli && cli.paneVisible && cli.rows.some((r) => /Hooks need review|enter confirm/i.test(r)))
      await shot('1b-hook-review-cli')
      // The person's choice here; the probe skips (Esc: "continue without trusting").
      for (let i = 0; i < 3; i++) {
        const x = await loom()
        if (!x.rows.some((r) => /Hooks need review|Update available|enter (?:confirm|continue)/i.test(r))) break
        await esc()
        await wait(1500)
      }
      await toCanvas()
    }
  }
  const ready = await until(async () => {
    const x = await loom()
    return x?.wrapper?.box && x.wrapper.phase === 'idle' && !x.wrapper.elsewhere && x
  }, 60_000)
  check('Codex\'s prompt is up: the wrapper is idle, no banner', !!ready && !ready.wrapper.elsewhere, ready ? `model=${ready.wrapper.model} effort=${ready.wrapper.effort}` : JSON.stringify((await loom()).rows.filter((r) => r.trim()).slice(-6)))
  await wait(1000)
  await shot('2-canvas-empty')

  // ---- 2. one cheap turn from the composer
  const word = `ok${Math.floor(Math.random() * 900 + 100)}`
  await say(`reply with the word ${word}`)
  const one = await feedHas(new RegExp(`reply with the word ${word}[\\s\\S]*\\b${word}\\b`))
  check('a composer message becomes a turn with its reply, on the canvas', !!one && one.turns >= 1, `turns=${one?.turns}`)
  const settled = await idle()
  check('the turn ends: the wrapper is idle again', !!settled, settled ? '' : JSON.stringify((await w())?.live))
  l = await loom()
  check('the composer is empty, nothing left in Codex\'s prompt', l.wrapper.input === '' && (l.wrapper.box?.text ?? '') === '', JSON.stringify([l.wrapper.input, l.wrapper.box?.text]))
  check('the bar names Codex\'s model', /GPT/i.test(l.bar), l.bar.replace(/\s+/g, ' '))
  await shot('3-canvas-turn')

  // ---- 3. Ctrl+`: the same TUI, at once
  const pid0 = codexPid()
  const t = await ev(`(async () => {
    const t0 = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', code: 'Backquote', ctrlKey: true, bubbles: true, cancelable: true }))
    while (performance.now() - t0 < 2000) {
      const l = window.__ember.loom(${JSON.stringify(tab)})
      if (l.paneVisible && l.mode === 'raw') break
      await new Promise((r) => requestAnimationFrame(r))
    }
    await new Promise((r) => requestAnimationFrame(r))
    return Math.round(performance.now() - t0)
  })()`)
  l = await loom()
  const pid1 = codexPid()
  check('Ctrl+` shows the TUI in under 300 ms', t < 300 && l.mode === 'raw' && l.paneVisible, `${t} ms`)
  check('the same Codex process (same PID)', pid0 > 0 && pid0 === pid1, `pid ${pid0} → ${pid1}`)
  check('the CLI shows the same conversation', l.rows.some((r) => r.includes(word)))
  await shot('4-cli')
  const back = await toCanvas()
  const pid2 = codexPid()
  check('Ctrl+` again: back on the canvas, the same process', !!back && back.paneVisible === false && pid2 === pid0, `pid ${pid2}`)
  for (let i = 0; i < 10; i++) {
    await switchKey()
    await wait(40)
  }
  await wait(800)
  l = await loom()
  const focus = await ev(`document.activeElement?.className ?? ''`)
  check('10 rapid switches: on the canvas, keyboard in the composer, no stray input', l.mode === 'claude' && /loom-native-input/.test(focus) && (l.wrapper.box?.text ?? '') === '', `mode=${l.mode} focus=${focus}`)

  if (FAKE) {
    // ---- 5. an approval through Ember's hook is Ember's card
    await say('run exactly this command: echo hi > probe-codex.txt')
    const asked = await until(async () => ((await w())?.askKinds ?? []).includes('tool') && (await loom()), 30_000)
    check('an approval is Ember\'s card (Codex\'s PermissionRequest hook)', !!asked, JSON.stringify(asked?.wrapper?.hooks ?? (await w())?.hooks))
    check('the canvas shows none of the TUI while the card is up', asked?.paneVisible === false)
    await shot('5-approval-card')
    await ev(`document.querySelector('.loom-ask-card button[data-a="yes"]').click()`)
    const ran = await feedHas(/Done: the command ran/, 20_000)
    check('Allow on the card: Codex runs it, the canvas shows the command and the reply', !!ran && /echo hi/.test(ran.text))
    await idle()

    // ---- 6. an approval only Codex's own screen asks
    await say('run exactly this command in the CLI: echo hi > probe-codex.txt')
    const banner = await until(async () => /approval/i.test((await w())?.elsewhere ?? '') && (await loom()), 20_000)
    check('an approval in Codex\'s own screen: a banner says so, phase asking', !!banner && banner.wrapper.phase === 'asking' && banner.paneVisible === false, banner?.wrapper?.elsewhere)
    await shot('6-approval-banner')
    await ev(`document.querySelector('.loom-elsewhere.is-on button[data-open-cli]').click()`)
    const cli = await until(async () => (await loom())?.mode === 'raw' && (await loom()), 3000)
    check('Open CLI shows Codex\'s approval prompt', !!cli && cli.rows.some((r) => /Would you like to run/.test(r)))
    await shot('6b-approval-cli')
    await typeText('y')
    await wait(500)
    await toCanvas()
    const ran2 = await feedHas(/in the CLI: echo hi[\s\S]*Done: the command ran/, 20_000)
    check('answered in the CLI: back on the canvas, the turn goes on, the banner goes', !!ran2 && !ran2.wrapper.elsewhere, ran2 ? '' : JSON.stringify((await loom()).text.slice(-300)))
    await idle()

    // ---- 7. a picture
    await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const g = c.getContext('2d'); g.fillStyle = '#e01010'; g.fillRect(0, 0, 64, 64)
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'square.png', { type: 'image/png' }))
      document.querySelector('.loom-native-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return true
    })()`)
    await until(async () => (await w())?.attachments === 1, 5000)
    await say('reply with the word picture')
    const pic = await feedHas(/\[Image #1\] reply with the word picture/, 20_000)
    check('a pasted picture is attached with Ctrl+V ([Image #1]) and sent with the message', !!pic, JSON.stringify((await w())?.typed?.slice(-4)))
    await idle()
  }

  // ---- 4. /quit
  await say('/quit')
  const shell = await until(async () => {
    const x = await loom()
    return !x.agent && x.mode === 'shell' && x.paneVisible && x
  }, 30_000)
  check('/quit gives the tab back to the shell', !!shell, shell ? `mode=${shell.mode}` : `mode=${(await loom()).mode}`)
  await wait(800)
  await shot('9-shell-again')
} catch (err) {
  failed++
  console.log('FAIL  probe crashed:', err?.stack ?? err)
} finally {
  try {
    ws?.close()
  } catch {}
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  rmSync(join(CWD, 'probe-codex.txt'), { force: true })
  console.log(`\nshots: ${OUT}`)
  console.log(`${FAKE ? 'fake Codex' : 'real Codex'}: ${failed ? `${failed} FAILED` : 'ALL PASSED'}`)
  process.exit(failed ? 1 : 0)
}
