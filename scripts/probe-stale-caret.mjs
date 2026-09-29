/**
 * A caret left behind.
 *
 * Reported: after `note …` opened a notes tab and the shell tab was returned to, a solid
 * caret stayed painted where the command had been typed, next to the live one, and
 * survived tab switches. This reproduces the sequence and reports every caret layer in
 * the document — which session it belongs to, where it is, whether it holds painted
 * pixels — plus a screenshot of the shell tab afterwards.
 *
 *   node scripts/probe-stale-caret.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9421
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES, EMBER_PROBE_INACTIVE: '1', EMBER_PROBE_BOUNDS: '1500x900' },
})
async function findPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('realtime'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error('no devtools target')
}
const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
  }
})
const send = (method, params = {}) => new Promise((res) => { pending.set(++seq, res); ws.send(JSON.stringify({ id: seq, method, params })) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result?.result?.value
}
await send('Runtime.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
for (let i = 0; i < 100; i++) {
  if (await ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}
async function waitForPrompt(id) {
  let last = -1
  let quietSince = 0
  for (let i = 0; i < 300; i++) {
    const s = (await ev(`window.__ember.sessions()`)).find((x) => (id ? x.id === id : true))
    if (s && s.bytesIn > 0) {
      const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
      const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
      if (s.bytesIn === last) {
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince > (prompt ? 1200 : 9000)) return s
      } else {
        quietSince = 0
        last = s.bytesIn
      }
    }
    await sleep(150)
  }
  throw new Error('shell never settled')
}

const LAYERS = `[...document.querySelectorAll('.ember-cursor-layer')].map((c) => {
  const pane = c.closest('.ember-pane')
  const group = c.closest('.ember-group')
  const ctx = c.getContext('2d')
  let painted = 0
  try { const d = ctx.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) painted++ } catch {}
  const r = c.getBoundingClientRect()
  return { session: pane?.dataset.sessionId, group: group?.className.includes('is-active') ? 'active' : 'other', groupOpacity: group?.style.opacity, groupVisibility: getComputedStyle(group).visibility, panesDisplay: getComputedStyle(group.querySelector('.ember-group-panes')).display, size: c.width + 'x' + c.height, at: Math.round(r.left) + ',' + Math.round(r.top), transform: c.style.transform, painted }
})`

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(process.env.TEMP ?? '.', `stale-${name}.png`)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  screenshot ${file}`)
}

const first = await waitForPrompt()
const sid = first.id
const home = await ev(`window.__ember.activeTab()`)
await ev(`window.__ember.session().focus()`)
// Type it as keys, so the caret travels the way it does under a hand.
for (const ch of 'note hello there') {
  const code = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code })
  await sleep(60)
}
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(4000)
console.log('after `note hello there` (notes tab should be active):')
console.log(`  active tab ${await ev(`window.__ember.activeTab()`)} (shell was ${home})`)
for (const l of await ev(LAYERS)) console.log('  ', JSON.stringify(l))
// Every tab's visibility while the note tab is up: only one may be showing.
for (const g of await ev(`[...document.querySelectorAll('.ember-group')].map((el) => ({ active: el.classList.contains('is-active'), opacity: el.style.opacity, visibility: getComputedStyle(el).visibility, panes: getComputedStyle(el.querySelector('.ember-group-panes')).display, hasNote: !!el.querySelector('.ember-notes'), hasPane: !!el.querySelector('.ember-pane') }))`)) console.log('   group', JSON.stringify(g))
await shot('note-tab')
await ev(`window.__ember.activate(${JSON.stringify(home)})`)
await sleep(1500)
console.log('back on the shell tab:')
for (const l of await ev(LAYERS)) console.log('  ', JSON.stringify(l))
console.log(`  cursor state: ${JSON.stringify(await ev(`window.__ember.session(${JSON.stringify(sid)}).cursorState()`))}`)
await shot('shell')
// And once more across a switch, since the report says it survives switching.
const notesTab = (await ev(`window.__ember.groups()`)).find((g) => g.id !== home)?.id
if (notesTab) {
  await ev(`window.__ember.activate(${JSON.stringify(notesTab)})`)
  await sleep(800)
  await ev(`window.__ember.activate(${JSON.stringify(home)})`)
  await sleep(1200)
  console.log('after switching away and back:')
  for (const l of await ev(LAYERS)) console.log('  ', JSON.stringify(l))
  await shot('shell-2')
}

try {
  for (const s of await ev(`window.__ember.sessions()`)) await ev(`window.ember.write(${JSON.stringify(s.id)}, "\\u0003exit\\r")`)
  await sleep(400)
} catch {
  /* gone */
}
child.kill()
ws.close()
