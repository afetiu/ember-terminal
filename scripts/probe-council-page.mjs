/**
 * The council as a canvas page: empty, setup, a council playing out, the conclusion.
 *
 *   node scripts/probe-council-page.mjs [out-prefix] [--real] [--light]
 *
 * By default no agent runs: the main process is opened with --inspect, the council's
 * `start` IPC is swapped for one that only records the request, and the probe plays the
 * council's events back to the renderer itself (openings, a note, a failure, round 1,
 * the conclusion). `--real` instead runs one tiny real council (rounds 0) to the end.
 * EMBER_HOME is a temp folder, so nothing touches the real ~/.ember.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const real = args.includes('--real')
const light = args.includes('--light')
const out = args.find((a) => !a.startsWith('--')) ?? 'council'
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-council-page')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9392
const INSPECT = 9393
const child = spawn('./node_modules/electron/dist/electron.exe', [`--inspect=${INSPECT}`, '.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** A CDP session over a websocket. */
async function cdp(url) {
  const ws = new WebSocket(url)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id === undefined) return
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) console.log('  eval error:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r?.result?.value
  }
  return { ws, send, ev }
}

let page
for (let i = 0; i < 60 && !page; i++) {
  await wait(500)
  try {
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
  } catch {}
}
const R = await cdp(page.webSocketDebuggerUrl)

let M = null
if (!real) {
  const targets = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json()
  M = await cdp(targets[0].webSocketDebuggerUrl)
  // The main bundle is ESM: reach electron through a CommonJS require made for the purpose.
  const ok = await M.ev(`(() => {
    const req = process.getBuiltinModule('module').createRequire(process.execPath)
    const { ipcMain, webContents } = req('electron')
    globalThis.__probe = { reqs: [], notes: [], stops: [], webContents }
    ipcMain.removeAllListeners('ember:council:start')
    ipcMain.removeAllListeners('ember:council:stop')
    ipcMain.on('ember:council:start', (_e, r) => (r.interject ? globalThis.__probe.notes.push(r.interject) : globalThis.__probe.reqs.push(r)))
    ipcMain.on('ember:council:stop', (_e, id) => globalThis.__probe.stops.push(id))
    return true
  })()`)
  console.log('  main hooked:', ok)
}
/** Play one council event to the renderer, as main would. */
const emit = (e) =>
  M.ev(`(() => { const p = globalThis.__probe; const r = p.reqs.at(-1); for (const w of p.webContents.getAllWebContents()) w.send('ember:council:event', { id: r.id, at: Date.now(), ...${JSON.stringify(e)} }); return r.members })()`)

const shot = async (name) => {
  await wait(500)
  const r = await R.send('Page.captureScreenshot', { format: 'png' })
  const file = `${out}-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  shot', file)
}
/** Type into the composer and press a key, the way a person would. */
const type = async (text) => {
  await R.ev(`document.querySelector('.ember-council-input').focus()`)
  await R.send('Input.insertText', { text })
}
const enter = async () => {
  await R.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await R.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r' })
  await R.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

await wait(5000)
if (light) {
  // The titlebar's Night/Day toggle: the light theme of the pair, tokens and all.
  await R.ev(`document.querySelector('.ember-voicetoggle.is-mode')?.click()`)
  await wait(1200)
}
const clicked = await R.ev(
  `(() => { const b = [...document.querySelectorAll('.ember-sidebar button')].find((x) => /^Council/.test(x.getAttribute('aria-label') || x.title || '')); b?.click(); return !!b })()`
)
console.log('  council:', clicked)
await wait(2500)
await shot('1-empty')

const chips = await R.ev(`[...document.querySelectorAll('.ember-council-chip')].map((c) => c.textContent.trim() + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''))`)
console.log('  chips:', JSON.stringify(chips))

if (real) {
  // One tiny real council: openings only.
  await R.ev(`(() => { const s = document.querySelector('.ember-council-chip select'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`)
  await type('In one short sentence: is JSON fine for a small app settings file?')
  await shot('2-typed')
  await enter()
  await wait(4000)
  await shot('3-running')
  for (let i = 0; i < 90; i++) {
    await wait(2000)
    if (await R.ev(`!!document.querySelector('.ember-council-conclusion .ember-council-actions, .ember-council-go')`)) break
  }
  await shot('4-done')
} else {
  // A third member, so a failure and the three-column grid show.
  await R.ev(`[...document.querySelectorAll('.ember-council-chip.is-member')].find((b) => b.getAttribute('aria-pressed') === 'false')?.click()`)
  await type('Should Ember store its settings in a JSON file or in SQLite, given sync to the phone is coming?')
  await shot('2-typed')
  await enter()
  await wait(400)
  const members = await emit({ kind: 'status', round: 0, text: 'Asking everyone…' })
  console.log('  members:', JSON.stringify(members))
  await shot('3-thinking')

  const A = [
    'JSON. The settings are small, human-readable and already diffable; **SQLite** buys transactions you do not need yet.\n\nWhen phone sync arrives, sync a JSON document with a version stamp — that is simpler to merge than a database file.',
    'SQLite, but only if sync is real this quarter. A single `settings` table with a row per key makes per-field merge trivial, and WAL mode keeps writes safe when the app crashes mid-save.\n\nOtherwise JSON with an atomic rename is enough.',
    'JSON for now. The file is under 10 KB, and a schema version field gives you a migration path later.',
  ]
  await emit({ kind: 'speak', member: members[0], round: 0, text: A[0] })
  await shot('4-one-answered')
  if (members[2]) await emit({ kind: 'error', member: members[2], round: 0, text: 'gave up after 3 minutes' })
  await emit({ kind: 'speak', member: members[1] ?? members[0], round: 0, text: A[1] })
  await type('Assume the phone edits settings too, not just reads them.')
  await shot('5-note-typed')
  await enter()
  await wait(200)
  await shot('5b-note-pending')
  await emit({ kind: 'status', text: 'Your note will be read in the next round.' })
  await emit({ kind: 'status', round: 1, text: 'Round 1 of 1, with your note…' })
  await shot('6-round1-thinking')
  await emit({ kind: 'speak', member: members[0], round: 1, text: 'If both sides write, then the merge story decides it: per-key rows in SQLite merge cleanly, a single JSON blob does not. I move to SQLite, with a JSON export for humans.' })
  await emit({ kind: 'speak', member: members[1] ?? members[0], round: 1, text: 'Agreed. Two writers is the case SQLite exists for. Keep a `version` per key and last-writer-wins per key.' })
  await emit({ kind: 'status', round: -1, member: members[0], text: 'Writing the conclusion…' })
  await shot('7-concluding')
  await emit({
    kind: 'conclusion',
    member: members[0],
    round: -1,
    text: '## Recommendation\n\nUse **SQLite** once the phone can edit settings: one row per key, a version per row, last-writer-wins per key. Until then, JSON with an atomic write is fine, and the move is a one-time migration.\n\nKeep a JSON export so a person can still read and diff their settings.',
  })
  await emit({ kind: 'done', text: 'finished' })
  await shot('8-done')
  await R.ev(`document.querySelector('.ember-council-stage').scrollTop = 0`)
  await shot('9-done-top')
  const notes = await M.ev(`globalThis.__probe.notes`)
  console.log('  notes sent:', JSON.stringify(notes))
  // New council: back to the empty page, the composer focused.
  await R.ev(`[...document.querySelectorAll('.ember-council-btn')].find((b) => b.textContent === 'New council')?.click()`)
  await wait(300)
  console.log('  after New council:', await R.ev(`({ empty: !!document.querySelector('.ember-council-empty'), focused: document.activeElement?.className })`))
}

R.ws.close()
M?.ws.close()
child.kill()
process.exit(0)
