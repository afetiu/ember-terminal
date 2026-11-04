/**
 * The gaps of the one-Claude canvas, with the real Claude Code TUI (`claude --model haiku`):
 *
 *   1. Trust: Claude started in a folder it has not trusted shows Ember's card ("Trust
 *      <folder>?"), not the TUI. No exits Claude (the tab is a shell again); Yes lets it
 *      on to its prompt and the folder is trusted in ~/.claude.json.
 *   2. The queue is Ember's: messages written mid-turn are held with a × each; × drops one,
 *      Send now sends one at once (Claude Code's send-now), the rest go when the turn ends,
 *      and Esc gives what is queued back to the composer.
 *   3. The ask box's question check (scripts/test-question.mjs, run here too).
 *
 * The folders are new ones under C:\Users\Public (the home folder is trusted, and trust is
 * inherited); they and their ~/.claude.json entries are removed at the end.
 *
 *   npm run build; PROBE_PORT=9521 node scripts/probe-gaps.mjs [out-dir]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-gaps-shots')
const PORT = Number(process.env.PROBE_PORT) || 9521
const STAMP = Date.now().toString(36)
const YES_DIR = `C:\\Users\\Public\\ember-gaps-yes-${STAMP}`
const NO_DIR = `C:\\Users\\Public\\ember-gaps-no-${STAMP}`
mkdirSync(OUT, { recursive: true })
mkdirSync(YES_DIR, { recursive: true })
mkdirSync(NO_DIR, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}
const claudeJson = join(homedir(), '.claude.json')
/** A folder's newest Claude session, from its transcript under ~/.claude/projects: who said what, in order. */
function transcript(folder) {
  const dir = join(homedir(), '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'))
  if (!existsSync(dir)) return []
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!file) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const m = JSON.parse(line)
      if (m.type !== 'assistant' && m.type !== 'user') continue
      const c = m.message?.content
      const text = typeof c === 'string' ? c : (c ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('')
      if (text) out.push({ who: m.type, text })
    } catch {}
  }
  return out
}
const key = (dir) => dir.replace(/\\/g, '/')
const trusted = (dir) => {
  try {
    return JSON.parse(readFileSync(claudeJson, 'utf8')).projects?.[key(dir)]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

// ---- 3. the question check, first (no app needed)
const unit = spawnSync(process.execPath, ['--test', join(REPO, 'scripts/test-question.mjs')], { encoding: 'utf8' })
check('the ask box: a question word needs a word boundary (test-question.mjs)', unit.status === 0, (unit.stdout.match(/ℹ (pass|fail) \d+/g) ?? []).join(' '))

if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) {
  console.error(`port ${PORT} is taken; close what holds it first`)
  process.exit(1)
}
const home = join(process.env.TEMP ?? '.', 'ember-probe-gaps')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
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
  }
  const press = (k, code, vk, text) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
    )
  const enter = () => press('Enter', 'Enter', 13, '\r')
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
  const boot = await ev('window.__ember.activeTab()')

  /** A tab in `dir` with `claude` typed into its shell (the person's own action in a shell). */
  const claudeIn = async (dir, args) => {
    const tab = await ev(`window.__ember.newLoom(${JSON.stringify(dir)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    const loom = () => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
    const shell = await until(async () => {
      const x = await loom()
      return x?.mode === 'shell' && !x.claude && x.rows.some((r) => r.trim()) && x
    }, 20_000)
    if (!shell) throw new Error('the new tab is not a plain shell')
    await wait(1500)
    await ev(`document.querySelector('.is-loom .xterm-helper-textarea')?.focus()`)
    await typeText(`claude --model haiku ${args}`)
    await wait(150)
    await enter()
    return { tab, loom, w: async () => (await loom())?.wrapper ?? null }
  }
  const cardText = () => ev(`document.querySelector('.loom-ask-card.is-confirm')?.innerText ?? ''`)

  // ---- 1a. trust: No
  {
    const t = await claudeIn(NO_DIR, '')
    await ev(`window.__ember.closeTab(${JSON.stringify(boot)})`)
    const asked = await until(async () => (await t.w())?.trust === 'asking' && (await t.loom()), 60_000)
    const text = await cardText()
    check('untrusted folder: Ember\'s trust card, not the TUI', !!asked && asked.paneVisible === false && text.includes(`Trust ${NO_DIR}?`) && /read and run files here/.test(text), JSON.stringify(text.slice(0, 120)))
    check('the TUI\'s own dialog is what it answers (on its hidden screen)', !!asked && asked.rows.some((r) => /Yes, I trust this folder/.test(r)))
    await ev(`document.querySelector('.loom-ask-card.is-confirm button[data-a="no"]').click()`)
    const back = await until(async () => {
      const x = await t.loom()
      return !x.claude && x.mode === 'shell' && x
    }, 20_000)
    check('No: Claude Code exits, the tab is a shell again', !!back, back ? `mode=${back.mode}` : '')
    check('No: the folder is not trusted', !trusted(NO_DIR))
    await ev(`window.__ember.closeTab(${JSON.stringify(t.tab)})`)
  }

  // ---- 1b. trust: Yes
  const t = await claudeIn(YES_DIR, '--permission-mode default --allowedTools "Bash(sleep *)"')
  {
    const asked = await until(async () => (await t.w())?.trust === 'asking' && (await t.loom()), 60_000)
    check('a second untrusted folder: the card again', !!asked)
    await wait(300)
    await shot('1-trust-card')
    const focus = await ev(`document.activeElement?.closest('.loom-ask-card') ? 'card' : document.activeElement?.className`)
    check('the keyboard is on the card', focus === 'card', String(focus))
    await press('Enter', 'Enter', 13, '\r')
    const on = await until(async () => {
      const x = await t.loom()
      return x.wrapper?.boxSeen && x.wrapper.trust === 'none' && x.wrapper.phase === 'idle' && x
    }, 30_000)
    check('Yes (Enter): Claude Code moves on to its prompt', !!on, on ? `phase=${on.wrapper.phase}` : JSON.stringify((await t.loom()).rows.filter((r) => r.trim()).slice(-6)))
    check('Yes: the folder is trusted in ~/.claude.json', await until(async () => trusted(YES_DIR), 5000))
    check('the card is gone and the composer has the keyboard', !(await cardText()) && /loom-native-input/.test(await ev(`document.activeElement?.className ?? ''`)))
    check('no banner over the canvas', !(await t.w()).elsewhere)
    await shot('2-trusted-prompt')
  }

  // ---- 2. the queue is Ember's
  const say = async (text) => {
    await ev(`document.querySelector('.loom-native-input').focus()`)
    await typeText(text)
    await enter()
  }
  const items = () => ev(`[...document.querySelectorAll('.loom-queue-item')].map((e) => ({ text: e.querySelector('.loom-queue-text').innerText, x: !!e.querySelector('button[data-q="x"]') }))`)
  const prompts = () => ev(`window.__ember.loom(${JSON.stringify(t.tab)}).text`)
  // A long reply, not a long tool call: Claude Code's shell tool refuses `sleep` (alone or
  // chained), and anything else that waits would ask for permission.
  await say('Without using any tool, write the numbers from 1 to 600 in English words, one per line, then a last line with exactly: SLEPT')
  const working = await until(async () => (await t.w())?.turnOn && (await t.w())?.live && (await t.w()), 45_000)
  check('a long turn runs', !!working, working ? working.live.verb : '')
  await say('Reply with exactly: QONE')
  await say('Reply with exactly: QTWO')
  await say('Reply with exactly: QTHREE')
  await wait(300)
  let q = await items()
  check('three messages are queued in Ember, each with ×', q.length === 3 && q.every((i) => i.x), JSON.stringify(q.map((i) => i.text)))
  const tuiPrompt = (await t.w()).box?.text ?? ''
  check('nothing was typed into the TUI for them', !/Q(ONE|TWO|THREE)/.test(tuiPrompt) && !(await t.loom()).rows.some((r) => /QTWO/.test(r)))
  await shot('3-queue')
  await ev(`[...document.querySelectorAll('.loom-queue-item')].find((e) => /QTWO/.test(e.innerText)).querySelector('button[data-q="x"]').click()`)
  await wait(200)
  q = await items()
  check('× removes that one only', q.length === 2 && /QONE/.test(q[0].text) && /QTHREE/.test(q[1].text), JSON.stringify(q.map((i) => i.text)))
  const sentNowAt = Date.now()
  await ev(`[...document.querySelectorAll('.loom-queue-item')].find((e) => /QTHREE/.test(e.innerText)).querySelector('button[data-q="now"]').click()`)
  // Claude Code's send-now cuts the running turn and runs it again with the message joined
  // to it (what the model then replies is the model's): the message is in the session
  // before the turn's reply is, and answered soon after. Read from the session's transcript:
  // the feed shows one turn at a time, and QONE's can follow QTHREE's before a look sees it.
  const joined = async () => {
    const tr = transcript(YES_DIR)
    const u3 = tr.findIndex((m) => m.who === 'user' && /QTHREE/.test(m.text))
    const reply = tr.findIndex((m) => m.who === 'assistant')
    return u3 >= 0 && (reply < 0 || u3 < reply) && tr.slice(u3 + 1).some((m) => m.who === 'assistant') ? tr : null
  }
  const now3 = await until(joined, 60_000)
  check('Send now: that message joins the running turn and is answered without waiting for it', !!now3, `${Math.round((Date.now() - sentNowAt) / 1000)} s ${JSON.stringify(transcript(YES_DIR).map((m) => `${m.who}:${m.text.slice(0, 18)}`))}`)
  // Claude Code's send-now may end the running turn to make way; what stays queued in
  // Ember then goes when that turn ends, after the one sent now. (The feed shows one turn
  // at a time, so the order is read from what was typed into the TUI.)
  const typed = async () => ((await t.w())?.typed ?? []).join(' ')
  const one = await until(async () => /QONE/.test(await typed()), 90_000)
  check('the rest is sent when the turn ends', !!one)
  const ty = await typed()
  check('Send now went ahead of what was queued before it', ty.indexOf('QTHREE') >= 0 && ty.indexOf('QTHREE') < ty.indexOf('QONE'))
  const settled = async () => {
    const x = await t.w()
    return x?.phase === 'idle' && !x.live && !x.turnOn && !x.queue.length
  }
  await until(async () => (await settled()) && (await wait(1500), await settled()), 90_000)
  check('a removed message is never sent', !/QTWO/.test(await typed()))
  check('the queue is empty after', (await items()).length === 0)

  // Esc: what is queued comes back to the composer.
  await say('Without using any tool, write the numbers from 1 to 600 in English words, one per line, then a last line with exactly: SLEPT2')
  await until(async () => (await t.w())?.turnOn && (await t.w())?.live, 45_000)
  await say('Reply with exactly: QFOUR')
  await wait(300)
  await press('Escape', 'Escape', 27)
  const gave = await until(async () => {
    const x = await t.w()
    return x.queue.length === 0 && /QFOUR/.test(x.input) && x
  }, 5000)
  check('Esc stops the turn and gives the queued message back to the composer', !!gave, JSON.stringify((await t.w()).input))
  const stopped = await until(async () => (await t.w())?.phase === 'idle' && !(await t.w())?.live && !(await t.w())?.turnOn, 20_000)
  check('Esc: the canvas sees the turn end', !!stopped)
  if (!stopped || process.env.PROBE_DEBUG) {
    const d = await t.loom()
    console.log('DEBUG', JSON.stringify({ phase: d.wrapper.phase, live: d.wrapper.live, turnOn: d.wrapper.turnOn, box: d.wrapper.box }), '\nHOOKS', JSON.stringify(d.wrapper.hooks.slice(-10)), '\nTYPED', JSON.stringify(d.wrapper.typed.slice(-8)), '\nROWS', JSON.stringify(d.rows.filter((r) => r.trim()).slice(-14)))
  }
  await wait(1500)
  check('nothing was sent behind Esc', !/QFOUR[\s\S]*QFOUR/.test(await prompts()))
  await shot('4-after-esc')
  await ev(`(() => { const i = document.querySelector('.loom-native-input'); i.value = ''; i.dispatchEvent(new Event('input')) })()`)
  await say('/exit')
  await until(async () => !(await t.loom()).claude, 20_000)
} catch (err) {
  failed++
  console.log('FAIL  probe crashed:', err?.stack ?? err)
} finally {
  try {
    ws?.close()
  } catch {}
  // Electron relaunches itself (--gpu-relaunched), out of the launched pid's tree: it is
  // found by its port, and the shells and Claude Code it ran by its pid in their paths.
  const ps = [
    `$e = @(Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${PORT}' -and $_.CommandLine -notmatch '--type=' })`,
    `foreach ($x in $e) { $tag = "ember-$($x.ProcessId)"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tag) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
    `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ].join('; ')
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await wait(1500)
  // The probe's folders, and the trust Claude Code wrote for them.
  for (const d of [YES_DIR, NO_DIR]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
    } catch (e) {
      console.log(`      (could not remove ${d}: ${e?.code})`)
    }
  }
  try {
    const j = JSON.parse(readFileSync(claudeJson, 'utf8'))
    let n = 0
    for (const k of Object.keys(j.projects ?? {})) if (/^C:\/Users\/Public\/ember-(gaps|trust)-/.test(k)) delete j.projects[k], n++
    if (n) {
      // In place: other Claude Code processes hold the file open, so it cannot be replaced.
      writeFileSync(claudeJson, JSON.stringify(j, null, 2))
    }
    console.log(`      (removed ${n} probe folder entr${n === 1 ? 'y' : 'ies'} from ~/.claude.json)`)
  } catch (e) {
    console.log('      (could not tidy ~/.claude.json:', e?.message, ')')
  }
  console.log(`\nshots: ${OUT}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
}
