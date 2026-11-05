/**
 * The keyboard path: a new terminal, `claude --model haiku` typed into it, a diagram asked for
 * in the CLI's prompt,
 * then Ctrl+↑ onto it, Shift+→ to snap it right, Esc back to typing. Screenshots of each;
 * exits non-zero when a step does not do what it says.
 *
 *   node scripts/probe-kbd-canvas.mjs [out-prefix]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'kbd'
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-kbd')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9386
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let target
for (let i = 0; i < 60 && !target; i++) {
  await wait(500)
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
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
const snap = () => ev('window.__ember.loom()')
const write = (sid, text) => ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(text)})`)
const typeText = (text) => send('Input.insertText', { text })
const enterKey = async () => {
  // A beat first: an Enter right after typed text reads to the TUI as part of a paste.
  await new Promise((r) => setTimeout(r, 350))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}
/** A message, typed into the agent's own prompt in the CLI, as the person would. */
const say = async (text) => {
  await ev(`document.querySelector('[data-session-id="' + window.__ember.loom().sessionId + '"] .xterm-helper-textarea')?.focus()`)
  await typeText(text)
  await enterKey()
}
/** `claude` typed into the tab's shell, as the person would, and only while it is a plain shell. */
const startClaude = async (sid) => {
  for (let i = 0; i < 20 && !(await snap())?.rows?.some((r) => /PS .*>/.test(r)); i++) await wait(500)
  const s = await snap()
  if (s.mode !== 'shell' || s.claude) throw new Error(`the tab is not a plain shell (mode ${s.mode}); not typing into it`)
  await write(sid, 'claude --model haiku')
  await wait(300)
  await write(sid, String.fromCharCode(13))
  for (let i = 0; i < 40; i++) {
    if ((await snap()).mode === 'claude' && (await snap()).cli?.promptSeen) break
    await wait(1000)
  }
}
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}-${name}.png`, Buffer.from(r.data, 'base64'))
}
const key = async (key, code, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: { ArrowUp: 38, ArrowRight: 39, Escape: 27 }[key] ?? 0, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
}

await wait(5000)
await shot('terminal')
const sid = (await snap()).sessionId
await startClaude(sid)
check('typing claude in the shell turns the canvas on', (await snap()).mode === 'claude')
await wait(2000)
await say('Use show_panel to put a tiny mermaid flowchart A --> B on the canvas titled "tiny". No other text.')
for (let i = 0; i < 60; i++) {
  if ((await snap()).pieces > 0) break
  await wait(1000)
}
await wait(3000)
await key('ArrowUp', 'ArrowUp', 2) // Ctrl
await wait(700)
await shot('selected')
check('the panel arrived as a piece', (await snap()).pieces > 0)
check('Ctrl+Up puts the ring on it', await ev(`!!document.querySelector('.loom-piece.is-kbd')`))
check('and shows the legend', await ev(`!!document.querySelector('.loom-kbd-legend.is-on')`))
await key('ArrowRight', 'ArrowRight', 8) // Shift
await wait(900)
await shot('snapped')
check('Shift+Right snaps it right', await ev(`!!document.querySelector('.loom-piece.is-kbd.is-pinned.is-snapped[data-snap="right"]')`))
await key('Escape', 'Escape')
await wait(500)
// Back to typing is the agent's own prompt, in the CLI below.
check('Esc goes back to typing', await ev(`!document.querySelector('.loom-piece.is-kbd') && !!document.activeElement?.classList?.contains('xterm-helper-textarea')`), await ev(`document.activeElement?.className`))
ws.close()
child.kill()
if (failures) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
}
