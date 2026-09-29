/**
 * Checks the four activity states against the screens that produce them.
 *
 * probe-activity.mjs drives a real `claude`, which makes it good for *discovering*
 * what Claude Code does and useless as a check: it depends on a login, a trust
 * prompt, tokens and a model's mood. The detection rules only ever look at two
 * things — the window title and the text on screen — so this drives a plain shell
 * that paints exactly those screens, and asserts the state each one produces.
 *
 * That is also the regression this exists for: the middle phase leaves a spinner on
 * screen while the shell sleeps in silence. Traffic-based detection called that idle
 * (and called an idle Claude Code redrawing its prompt "working" for hours).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
// Wipe it: restored scrollback from a previous run is still on screen at startup, and
// the detection reads the screen.
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
const PORT = 9342
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME },
})

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(400)
  }
  throw new Error('no devtools target')
}

const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
let sid = null
for (let i = 0; i < 40 && !sid; i++) {
  await sleep(500)
  sid = await evaluate(`window.__ember?.sessions()[0]?.id ?? null`)
}
if (!sid) throw new Error('no session')

const write = (text) => evaluate(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(text)})`)
const run = async (cmd) => {
  await write(`${cmd}\r`)
  await sleep(900)
}
const state = async () => {
  const s = await evaluate(`window.__ember.sessions()[0].activity`)
  const rawTitle = await evaluate(`window.__ember.sessions()[0].rawTitle`)
  const text = await evaluate(`window.__ember.sessions()[0].text`)
  const card = await evaluate(`(() => {
    const c = document.querySelector('.ember-card')
    return c && { state: c.dataset.state, attention: c.dataset.attention, status: c.querySelector('.ember-card-statustext')?.textContent ?? '', tooltip: c.title }
  })()`)
  return { ...s, rawTitle, text, card }
}

const results = []
const expect = async (name, want, wantAttention = null) => {
  const s = await state()
  // `want` may be a predicate when what matters is what the state is *not*: a shell
  // can ring the bell at any moment (PSReadLine dings at a completion with no match),
  // and a bell legitimately claims attention for a while.
  const ok =
    typeof want === 'function'
      ? want(s)
      : s.state === want && (wantAttention === null || s.attention === wantAttention)
  results.push({ name, want: String(want), wantAttention, got: s.state, gotAttention: s.attention, ok })
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} want=${want}${wantAttention ? `/${wantAttention}` : ''} got=${s.state}${s.attention ? `/${s.attention}` : ''} label=${JSON.stringify(s.label)} detail=${JSON.stringify(s.detail)} title=${JSON.stringify(s.rawTitle)}`,
  )
  if (!ok) {
    const tail = s.text
      .split('\n')
      .filter((l) => l.trim())
      .slice(-8)
    for (const l of tail) console.log(`        | ${l.slice(0, 100)}`)
  }
  return s
}

await sleep(2500)

// Everything below is measured on session 0 while a *second* session holds the
// foreground. A session you are looking at is acknowledged on every tick — that is
// the point of the acknowledge path — so the states worth checking are the ones a
// background session reports.
await evaluate(`document.querySelector('.ember-newtab').click()`)
await sleep(2500)

// Each phase runs from a file rather than a typed command line. A command is echoed
// as you type it, so typing the spinner text puts a second copy of the pattern on
// screen that no Clear-Host in the same line can remove — the probe would then be
// measuring its own echo.
const SPINNER = `  ✳ Scurrying… (12s · ↓ 3.1k tokens)`

/**
 * Poll the screen rather than guess at a delay: pwsh takes its time getting a script
 * started, and a phase that queues up behind the previous one gets measured as the
 * previous one. `ready` says when the screen this phase is about is actually up.
 */
const waitFor = async (label, ready, timeoutMs = 25000) => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = await evaluate(
      `({ text: window.__ember.sessions()[0].text, title: window.__ember.sessions()[0].rawTitle })`,
    )
    if (ready(s.text, s.title)) return
    if (Date.now() > until) {
      console.log(`      (timed out waiting for ${label})`)
      return
    }
    await sleep(400)
  }
}

const phase = async (name, body, ready) => {
  const file = join(EMBER_HOME, `${name}.ps1`)
  // Claude Code announces itself by title. Written by every phase because pwsh
  // re-asserts its own title, which would unlatch the detection a second later.
  writeFileSync(file, `Write-Host -NoNewline "\`e]0;✳ Claude Code\`a"\nClear-Host\n${body}\n`, 'utf8')
  await write(`& '${file}'\r`)
  await waitFor(name, ready)
  // Let the sticky window on the previous screen's signal expire.
  await sleep(1600)
}

// --- 1. a working turn: a spinner on screen while the session makes no noise -------
await phase(
  'working',
  `Write-Host ""\nWrite-Host "  Reading src\\main\\window.ts"\nWrite-Host ""\nWrite-Host "${SPINNER}"\nStart-Sleep -Seconds 40`,
  (text, title) => /Scurrying/.test(text) && /claude/i.test(title),
)
await expect('spinner on screen, pty silent -> working', 'working')
await sleep(9000)
const stillBusy = await expect('still working 9s later, no output at all', 'working')
console.log(`      (elapsed shown on the card: ${JSON.stringify(stillBusy.card?.status)})`)

// --- 2. the turn ends: handed back to you, then it settles ------------------------
// Ctrl+C ends the sleep; otherwise the next phase queues behind it and the spinner is
// still on screen when it is asserted to be gone.
await write('\u0003')
await sleep(1200)
await phase('prompt', `Write-Host ""\nWrite-Host "> "\nWrite-Host ""`, (text) => !/Scurrying/.test(text))
await expect('turn finished -> your turn', 'attention', 'handoff')

// --- 3. a question it is blocked on ------------------------------------------------
await phase(
  'question',
  `Write-Host "Do you want to make this edit?"\nWrite-Host "❯ 1. Yes"\nWrite-Host "  2. No, tell Claude what to do differently"\nWrite-Host "Enter to confirm · Esc to cancel"`,
  (text) => /1\. Yes/.test(text),
)
await expect('picker on screen -> needs you', 'attention', 'question')

// --- 4. answered: the question is gone, and so is the demand ----------------------
await phase('answered', `Write-Host ""\nWrite-Host "> "\nWrite-Host ""`, (text) => !/1\. Yes/.test(text))
await expect(
  'question dismissed -> question no longer claimed',
  (s) => s.attention !== 'question',
  null,
)

// --- 5. nothing happening for a while ---------------------------------------------
console.log('\nwaiting out the handoff window...')
await sleep(32000)
await expect('quiet for 20s+ -> idle, no lingering claim', 'idle')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
const file = `${process.env.TEMP}\\ember-states.png`
;(await import('node:fs')).writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', file)

ws.close()
child.kill()
process.exit(failed.length ? 1 : 0)
