/**
 * Verifies the two safety/UX behaviours: a short tap on a card's close button must
 * NOT close the session, a sustained hold must, and F2 rename must stick and persist.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync , mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join , basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Probes must never share ~/.ember with the installed copy: they edit config.json and
// delete state.json, which would rewrite a live session's settings underneath it.
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PROBE_ENV = { ...process.env, EMBER_HOME }
const PORT = 9341
const STATE = join(EMBER_HOME, 'state.json')
if (existsSync(STATE)) rmSync(STATE)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: PROBE_ENV,
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
await sleep(3500)

// Two sessions, so closing one leaves something behind to assert on.
await ev(`document.querySelector('.ember-newtab').click()`)
await sleep(2600)
const start = await ev(`window.__ember.groups().length`)
check('two sessions open', start === 2, String(start))

const press = (idx) =>
  ev(`(() => {
    const b = document.querySelectorAll('.ember-card-close')[${idx}]
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    return true
  })()`)
// The button legitimately disappears when a completed hold closes the card, so
// releasing must tolerate it being gone.
const release = (idx) =>
  ev(`(() => {
    const b = document.querySelectorAll('.ember-card-close')[${idx}]
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    return true
  })()`)

// ---- short tap must not close ----
await press(1)
await sleep(220)
const midHold = await ev(`Number(document.querySelectorAll('.ember-card-close')[1].style.getPropertyValue('--hold') || 0)`)
await release(1)
await sleep(900)
const afterTap = await ev(`window.__ember.groups().length`)
check('short tap does not close', afterTap === 2, `${afterTap} groups, hold reached ${midHold.toFixed?.(2) ?? midHold}`)
check('hold ring animates while pressed', midHold > 0.1 && midHold < 0.9, String(midHold))

const rewound = await ev(`Number(document.querySelectorAll('.ember-card-close')[1].style.getPropertyValue('--hold') || 0)`)
check('hold rewinds after release', rewound === 0, String(rewound))

// ---- sustained hold must close ----
const domState = await ev(`({
  cards: document.querySelectorAll('.ember-card').length,
  closes: document.querySelectorAll('.ember-card-close').length,
  ids: Array.from(document.querySelectorAll('.ember-card')).map(c => c.dataset.id + (c.classList.contains('is-leaving') ? ':leaving' : '')),
})`)
console.log('   dom:', JSON.stringify(domState))
await press(domState.closes - 1)
await sleep(1500)
await release(domState.closes - 1)
await sleep(900)
const afterHold = await ev(`window.__ember.groups().length`)
check('holding closes the session', afterHold === 1, `${afterHold} groups`)

// ---- rename ----
await ev(`window.__ember.beginRename()`)
await sleep(400)
const hasInput = await ev(`!!document.querySelector('.ember-card-rename')`)
check('F2 opens the rename input', hasInput === true)

await ev(`(() => {
  const i = document.querySelector('.ember-card-rename')
  i.value = 'deploy box'
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)
await sleep(700)
const title = await ev(`document.querySelector('.ember-card-title').textContent`)
check('rename applies to the card', title === 'deploy box', String(title))

// Titles from the shell must not overwrite the user's name.
await ev(`window.__ember.type("$Host.UI.RawUI.WindowTitle = 'from-shell'\\r")`)
await sleep(2200)
const stillNamed = await ev(`document.querySelector('.ember-card-title').textContent`)
check('custom name survives a shell title change', stillNamed === 'deploy box', String(stillNamed))

await sleep(4500)
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null
check('rename persisted', saved?.groups?.[0]?.customTitle === 'deploy box', JSON.stringify(saved?.groups?.[0]?.customTitle))

await send('Page.bringToFront')
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(`${process.env.TEMP}\\ember-close-rename.png`, Buffer.from(shot.result.data, 'base64'))
console.log('screenshot ->', `${process.env.TEMP}\\ember-close-rename.png`)

ws.close()
child.kill()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
