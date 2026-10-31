/**
 * Drives a Loom tab end to end against a real `claude`, and screenshots each stage.
 *
 *   node scripts/probe-loom.mjs [--stage shell|claude|turn|permission|browser|all]
 *
 * Runs its own dev Electron on the built app (`npm run build` first) with an isolated
 * EMBER_HOME, so the Ember you are using is not touched. Needs a logged-in `claude` on
 * PATH; the turns cost a few cents of tokens. Screenshots land in $LOOM_SHOTS or the
 * temp folder, named after the stage.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const stage = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : 'all'
const TMP = process.env.TEMP ?? '.'
const EMBER_HOME = join(TMP, 'ember-probe-loom')
const SHOTS = process.env.LOOM_SHOTS ?? join(TMP, 'loom-shots')
const PROJECT = join(TMP, 'loom-probe-project')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
rmSync(PROJECT, { recursive: true, force: true })
mkdirSync(PROJECT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, labs: { enabled: false } }))
writeFileSync(
  join(PROJECT, 'app.js'),
  [
    "const greeting = 'hello'",
    '',
    'function greet(name) {',
    '  if (!name) return greeting',
    '  return `${greeting}, ${name}`',
    '}',
    '',
    'function shout(name) {',
    '  return greet(name).toUpperCase()',
    '}',
    '',
    'module.exports = { greet, shout }',
    '',
  ].join('\n'),
)

const PORT = 9351
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME },
})
const cleanup = () => {
  try {
    child.kill()
  } catch {}
}
process.on('exit', cleanup)

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (p) return p
    } catch {}
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  shot ${file}`)
}

await send('Runtime.enable')
await send('Page.enable')
for (let i = 0; i < 60; i++) {
  if (await evaluate(`!!window.__ember?.newLoom`)) break
  await sleep(400)
}
await sleep(1500)

const tab = await evaluate(`window.__ember.newLoom(${JSON.stringify(PROJECT)})`)
console.log('loom tab', tab)
const loom = () => evaluate(`window.__ember.loom(${JSON.stringify(tab)})`)
const type = (text, submit = true) => evaluate(`window.__ember.send(${JSON.stringify(tab)}, ${JSON.stringify(text)}, ${submit})`)
const raw = (data) =>
  evaluate(`(() => { const s = window.__ember.sessions(); return s[s.length - 1].id })()`).then((sid) =>
    evaluate(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(data)})`),
  )
const waitFor = async (label, pred, ms = 60000) => {
  const until = Date.now() + ms
  for (;;) {
    const s = await loom()
    if (pred(s)) return s
    if (Date.now() > until) {
      console.log(`  TIMEOUT waiting for ${label}`, JSON.stringify(s))
      return s
    }
    await sleep(500)
  }
}
/**
 * A turn is over when Claude Code's mode line has stopped saying "esc to interrupt" for a
 * few seconds, or the dock is showing a dialog that wants an answer.
 */
const settle = async (label, ms = 150000) => {
  const until = Date.now() + ms
  let quietSince = 0
  await sleep(2500)
  for (;;) {
    const st = await loom()
    if (st?.dock?.dialog) return { ...st, reason: 'dialog' }
    if (!st?.working) {
      quietSince ||= Date.now()
      if (Date.now() - quietSince > 3500) return { ...st, reason: 'quiet' }
    } else quietSince = 0
    if (Date.now() > until) return { ...st, reason: 'timeout' }
    await sleep(600)
  }
}

console.log('[shell]')
await sleep(2500)
console.log('  ', JSON.stringify(await loom()))
await shot('1-shell')
await type('Get-ChildItem')
await sleep(1800)
await shot('2-shell-ls')

if (stage === 'shell') process.exit(0)

console.log('[claude]')
await type('claude --permission-mode default')
const c = await waitFor('claude mode', (s) => s?.mode === 'claude', 45000)
console.log('  ', JSON.stringify(c))
await sleep(3500)
await shot('3-claude-idle')
if (stage === 'claude') process.exit(0)

if (stage === 'extras') {
  console.log('[extras]')
  const logo = join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'logo.png')
  await type(
    `Use show_steps to pin a 3-step plan titled 'Logo check' where step one is done and step two is active. Then use show_media to show the image at ${logo} with the caption 'the logo'. No explanation.`,
  )
  let e = await settle('extras', 150000)
  for (let i = 0; i < 5 && e.reason === 'dialog'; i++) {
    await raw('\r')
    e = await settle('after allow', 120000)
  }
  await sleep(1500)
  console.log('  ', JSON.stringify(await loom()))
  await shot('9-extras')
  // Ctrl+` flips to the real TUI and back.
  const key = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, modifiers: 2 })
    await sleep(700)
  }
  await key()
  console.log('  after Ctrl+`:', (await loom()).mode)
  await shot('10-raw')
  await key()
  console.log('  after Ctrl+` again:', (await loom()).mode)
  process.exit(0)
}

console.log('[turn]')
await type(
  'Read app.js. In two short sentences say what it does, then a mermaid flowchart of how shout() calls greet(), then a markdown table of the functions with their argument and return. Keep it brief.',
)
console.log('  ', JSON.stringify(await settle('turn')))
await shot('4-turn')
console.log('  ', JSON.stringify(await loom()))
if (stage === 'turn') process.exit(0)

console.log('[permission]')
await type("Change the greeting in app.js from 'hello' to 'hello from Loom'. Just do it, no explanation.")
const p = await settle('permission', 90000)
console.log('  ', JSON.stringify(p), JSON.stringify(await loom()))
await shot('5-permission')
if (p.reason === 'dialog') {
  await raw('\r')
  console.log('  ', JSON.stringify(await settle('after allow')))
}
await shot('6-edited')
if (stage === 'permission') process.exit(0)

console.log('[browser]')
await type(
  "Use open_url to show https://example.com on the canvas, then use annotate to point at the 'More information' link with the note 'this goes to IANA'. Then stop, no explanation.",
)
let b = await settle('browser', 120000)
// Default permission mode asks for each MCP tool the first time: say yes to each.
for (let i = 0; i < 5 && b.reason === 'dialog'; i++) {
  await raw('\r')
  b = await settle('after allow', 120000)
}
await sleep(2500)
await shot('7-browser')
console.log('  ', JSON.stringify(await loom()))
const marks = await evaluate(`(async () => {
  const wv = document.querySelector('.loom[data-tab-id="${tab}"] webview')
  if (!wv) return 'no webview'
  try { return await wv.executeJavaScript("(() => { const l = document.getElementById('__ember_marks__'); return l ? l.children.length + ' mark elements' : 'no marks' })()") } catch (e) { return 'err ' + e.message }
})()`)
console.log('  marks in page:', marks)

console.log('[exit]')
await type('/exit')
await waitFor('shell again', (s) => s?.mode === 'shell', 20000)
await sleep(1200)
await shot('8-after-exit')
console.log('done')
process.exit(0)
