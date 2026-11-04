/**
 * One Claude, instant switch: the real Claude Code TUI in a terminal tab, wrapped by the
 * canvas (ClaudeTui), with the real `claude --model haiku` in ~/agent-box (a trusted folder).
 *
 * What it checks, in order:
 *   0. a new tab is a plain shell (no Claude started), and typing `claude` in it — the
 *      person's own action in a shell — turns the canvas on;
 *   1. a message typed in Ember's composer becomes a turn with its reply;
 *   2. Ctrl+` shows the same TUI at once (< 300 ms, same claude.exe PID), with the same
 *      conversation on its screen;
 *   3. a message typed in the CLI view shows on the canvas after switching back;
 *   4. 10 rapid switches break nothing (focus, no stray input, no duplicated turns);
 *   5. a Bash permission request is Ember's card; Allow runs it;
 *   6. AskUserQuestion is Ember's card; the answer reaches Claude;
 *   7. an image pasted into the composer round-trips (a red square → "red");
 *   7b. a picker only the TUI has (/model) shows a banner with Open CLI, not a crop;
 *   8. /clear in the composer starts the canvas over;
 *   9. /exit gives the tab back to the shell.
 *
 * Keys go to Ember's composer and cards, and — for 0 and 3 only, the person's own typing in
 * the shell and in the CLI view — to the terminal. Screenshots land in the out dir.
 *
 *   npm run build; node scripts/probe-one-claude.mjs [out-dir]
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-one-claude-shots')
const PORT = Number(process.env.PROBE_PORT) || 9471
const CWD = join(homedir(), 'agent-box')
const PROBE_FILE = join(CWD, 'probe-one-claude.txt')
mkdirSync(OUT, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const home = join(process.env.TEMP ?? '.', 'ember-probe-one-claude')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
rmSync(PROBE_FILE, { force: true })
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
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
    return join(OUT, `${file}.png`)
  }
  const key = (k, code, vk, modifiers = 0, text) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    )
  const enter = () => key('Enter', 'Enter', 13, 0, '\r')
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
  // A tab in the trusted folder; the first (boot) tab is closed.
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
  const feedHas = (re) => until(async () => re.test((await loom())?.text ?? '') && (await loom()), 90_000)
  const idle = () => until(async () => (await w())?.phase === 'idle' && !(await w())?.live && (await w()), 60_000)
  /** The claude.exe this Ember runs: the one whose parents lead back to the probe's Electron. */
  const claudePid = () => {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      const list = [].concat(JSON.parse(out || '[]'))
      const parent = new Map(list.map((p) => [p.ProcessId, p.ParentProcessId]))
      const mine = list.filter((p) => {
        if (!/^claude(\.exe)?$/i.test(p.Name)) return false
        let at = p.ParentProcessId
        for (let i = 0; i < 10 && at; i++) {
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

  // ---- 0. a terminal first
  await until(async () => (await loom())?.rows?.some((r) => /PS .*>/.test(r)), 20_000)
  let l = await loom()
  check('a new tab is a plain shell (no Claude started)', l.mode === 'shell' && !l.claude && l.paneVisible, `mode=${l.mode}`)
  await shot('0-shell')
  await ev(`document.querySelector('.is-loom .xterm-helper-textarea')?.focus()`)
  await typeText('claude --model haiku --permission-mode default')
  await wait(150)
  await enter()
  const up = await until(async () => {
    const x = await loom()
    return x?.claude && x.wrapper?.boxSeen && x.mode === 'claude' && x
  }, 60_000)
  check('typing `claude` in the shell turns the canvas on', !!up && up.paneVisible === false, up ? `mode=${up.mode} pane hidden=${!up.paneVisible}` : '')
  await shot('1-canvas-empty')

  // ---- 1. a message from the composer
  await say('Reply with exactly this and nothing else: PONG-ONE')
  const one = await feedHas(/PONG-ONE[\s\S]*PONG-ONE/)
  check('a composer message becomes a turn with its reply', !!one && one.turns >= 1, `turns=${one?.turns}`)
  await idle()
  await shot('2-canvas-turn')

  // ---- 2. Ctrl+`: the same TUI, at once
  const pid0 = claudePid()
  const t = await ev(`(async () => {
    const t0 = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', code: 'Backquote', ctrlKey: true, bubbles: true, cancelable: true }))
    const pane = () => document.querySelector('.ember-pane.is-loom, .is-loom')
    while (performance.now() - t0 < 2000) {
      const l = window.__ember.loom(${JSON.stringify(tab)})
      if (l.paneVisible && l.mode === 'raw') break
      await new Promise((r) => requestAnimationFrame(r))
    }
    await new Promise((r) => requestAnimationFrame(r))
    return Math.round(performance.now() - t0)
  })()`)
  l = await loom()
  const pid1 = claudePid()
  check('Ctrl+` shows the TUI in under 300 ms', t < 300 && l.mode === 'raw' && l.paneVisible, `${t} ms`)
  check('the same Claude Code process (same PID)', pid0 > 0 && pid0 === pid1, `pid ${pid0} → ${pid1}`)
  check('the CLI shows the same conversation', l.rows.some((r) => /PONG-ONE/.test(r)))
  await shot('3-cli')

  // ---- 3. a message typed in the CLI view
  await typeText('Reply with exactly this and nothing else: PONG-TWO')
  await wait(200)
  await enter()
  await until(async () => (await loom())?.rows?.some((r) => /^\s*●?\s*PONG-TWO\s*$/.test(r)), 60_000)
  await wait(1500)
  await switchKey()
  const two = await feedHas(/PONG-TWO[\s\S]*PONG-TWO/)
  l = await loom()
  check('a message typed in the CLI shows on the canvas', !!two && l.mode === 'claude', `turns=${two?.turns}`)
  await idle()
  const turnsBefore = (await loom()).turns

  // ---- 4. ten rapid switches
  for (let i = 0; i < 10; i++) {
    await switchKey()
    await wait(40)
  }
  await wait(800)
  l = await loom()
  const focus = await ev(`document.activeElement?.className ?? ''`)
  check('10 rapid switches: back on the canvas, keyboard in the composer', l.mode === 'claude' && /loom-native-input/.test(focus), `mode=${l.mode} focus=${focus}`)
  check('no stray input in the TUI or the composer', (l.wrapper.box?.text ?? '') === '' && l.wrapper.input === '', JSON.stringify([l.wrapper.box?.text, l.wrapper.input]))
  check('no duplicated turns', l.turns === turnsBefore, `${turnsBefore} → ${l.turns}`)

  // ---- 5. a permission request is Ember's card
  await say(`Use the Bash tool to run exactly this command and nothing else: echo hi > probe-one-claude.txt`)
  const asked = await until(async () => ((await w())?.askKinds ?? []).includes('tool') && (await loom()), 90_000)
  check('a Bash permission request shows as Ember\'s card', !!asked, JSON.stringify(asked?.wrapper?.hooks?.slice(-4)))
  const cardShot = await shot('4-permission-card')
  const tuiDialog = (asked?.rows ?? []).some((r) => /Do you want to/i.test(r))
  console.log(`      (Claude Code's own dialog is ${tuiDialog ? 'drawn on its hidden screen meanwhile — never shown on the canvas' : 'not on its screen'})`)
  const canvasShowsTui = await ev(`getComputedStyle(document.querySelector('.is-loom')).visibility`)
  check('the canvas shows none of the TUI while the card is up', canvasShowsTui === 'hidden', canvasShowsTui)
  await ev(`document.querySelector('.loom-ask-card button[data-a="yes"]').click()`)
  const ran = await until(async () => existsSync(PROBE_FILE), 60_000)
  check('Allow on the card runs the command', !!ran)
  await idle()
  rmSync(PROBE_FILE, { force: true })

  // ---- 6. AskUserQuestion
  await say('Use the AskUserQuestion tool once to ask me "Which color?" with exactly two options, Red and Blue. After I answer, reply with only the color I chose.')
  const q = await until(async () => ((await w())?.askKinds ?? []).includes('question') && (await loom()), 90_000)
  check('AskUserQuestion shows as Ember\'s question card', !!q)
  await shot('5-question-card')
  await ev(`document.querySelector('.loom-ask-card .loom-ask-chip[data-o="1"]').click()`)
  const blue = await until(async () => {
    const x = await loom()
    return /User answered|Blue/.test(x?.text ?? '') && x.wrapper.phase === 'idle' && /\bBlue\b/.test((x.text ?? '').split(/Which color/).pop() ?? '') && x
  }, 90_000)
  check('the answer reaches Claude (it replies Blue)', !!blue)
  await idle()

  // ---- 7. an image pasted into the composer
  await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const g = c.getContext('2d'); g.fillStyle = '#e01010'; g.fillRect(0, 0, 64, 64)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'square.png', { type: 'image/png' }))
    document.querySelector('.loom-native-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  })()`)
  await until(async () => (await w())?.attachments === 1, 5000)
  await shot('6-image-attached')
  await say('What color is this square? Answer with one word.')
  const red = await until(async () => {
    const x = await loom()
    const parts = (x?.text ?? '').split('What color is this square')
    return parts.length > 1 && /\bred\b/i.test(parts.pop() ?? '') && x.wrapper.phase === 'idle' && x
  }, 90_000)
  check('an image paste round-trips (red square → "red")', !!red)
  await shot('7-image-reply')
  if (process.env.PROBE_DEBUG) {
    const d = await loom()
    console.log('DEBUG', JSON.stringify(d.wrapper.hooks), '\nTYPED', JSON.stringify(d.wrapper.typed), '\nROWS', JSON.stringify(d.rows.filter((r) => r.trim()).slice(-12)))
  }

  // ---- 7b. something only Claude Code's screen has (the /model picker): a banner, not a crop
  await say('/model')
  const away = await until(async () => (await w())?.elsewhere && (await loom()), 15_000)
  check('a TUI-only picker: the canvas offers the CLI view (banner)', !!away && away.paneVisible === false)
  await shot('7b-elsewhere-banner')
  await ev(`document.querySelector('.loom-elsewhere button[data-open-cli]').click()`)
  const cliOpen = await until(async () => (await loom())?.mode === 'raw' && (await loom()), 3000)
  check('Open CLI shows the picker in the TUI', !!cliOpen && cliOpen.paneVisible)
  await shot('7c-picker-in-cli')
  await key('Escape', 'Escape', 27)
  await wait(800)
  await switchKey()
  const home2 = await until(async () => {
    const x = await loom()
    return x.mode === 'claude' && !x.wrapper.elsewhere && x.wrapper.box && x
  }, 10_000)
  check('Esc in the CLI, then back: the banner goes', !!home2)

  // ---- 8. /clear
  const turnsNow = (await loom()).turns
  await say('/clear')
  const cleared = await until(async () => {
    const x = await loom()
    return x.says === 0 && !/PONG|Red/.test(x.text) && (x.wrapper.counts.SessionStart ?? 0) >= 2 && x
  }, 30_000)
  check('/clear in the composer starts the canvas over', !!cleared, `turns ${turnsNow} → ${cleared ? 'none' : '?'}`)
  await shot('8-cleared')

  // ---- 9. /exit
  await say('/exit')
  const back = await until(async () => {
    const x = await loom()
    return !x.claude && x.mode === 'shell' && x.paneVisible && x
  }, 30_000)
  check('/exit gives the tab back to the shell', !!back, back ? `mode=${back.mode}` : '')
  await wait(800)
  await shot('9-shell-again')
} catch (err) {
  failed++
  console.log('FAIL  probe crashed:', err?.stack ?? err)
} finally {
  rmSync(PROBE_FILE, { force: true })
  try {
    ws?.close()
  } catch {}
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  console.log(`\nshots: ${OUT}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
}
