/**
 * An object inline in a reply: `claude --model haiku` typed into a new terminal, a mermaid
 * block asked for in the CLI's prompt, then Ctrl+↑ onto it, its edges pulled to size it
 * where it sits, Enter for full screen, Ctrl+wheel and the 100% button for zoom, Esc out.
 * Screenshots of each; exits non-zero when a step does not do what it says.
 *
 *   node scripts/probe-inline-objects.mjs [out-prefix]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'kbd'
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-inline')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { default: 'claude', onboarded: true }, brain: { sync: false } }))
const PORT = 9388
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
await say('Reply with only a mermaid code block in your message (do not use any tool): flowchart LR with A --> B --> C.')
for (let i = 0; i < 60; i++) {
  if (await ev(`!!document.querySelector('.loom-shown .loom-liftable, .loom-turn.is-shown .loom-liftable')`)) break
  await wait(1000)
}
await wait(3000)
await key('ArrowUp', 'ArrowUp', 2) // Ctrl
await wait(700)
await shot('selected')
check('the reply carries an inline diagram', await ev(`!!document.querySelector('.loom-turn.is-shown .loom-liftable')`))
check('Ctrl+Up puts the ring on it', await ev(`!!document.querySelector('.loom-turn.is-shown .loom-liftable.is-kbd, .loom-piece.is-kbd')`))
check('and shows the legend', await ev(`!!document.querySelector('.loom-kbd-legend.is-on')`))
const box = () => ev(`(() => { const r = document.querySelector('.loom-turn.is-shown .loom-liftable')?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null })()`)
const handle = (d) => ev(`(() => { const r = document.querySelector('.loom-turn.is-shown .loom-liftable > .loom-rz[data-rz="${d}"]')?.getBoundingClientRect(); return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null })()`)
await key('Escape', 'Escape')
await wait(300)
const m = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
const pull = async (d, dx, dy) => {
  const g = await handle(d)
  if (!g) return console.log('  no handle', d)
  console.log('   under', d, await ev(`(() => { const e = document.elementFromPoint(${g.x}, ${g.y}); return e ? e.className + ' ' + (e.dataset?.rz || '') : null })()`), ' frame h:', await ev(`document.querySelector('.loom-turn.is-shown .loom-liftable iframe')?.style.height`))
  await m('mouseMoved', g.x, g.y)
  await m('mousePressed', g.x, g.y)
  for (let i = 1; i <= 10; i++) { await m('mouseMoved', g.x + (i * dx) / 10, g.y + (i * dy) / 10); await wait(30) }
  await m('mouseReleased', g.x + dx, g.y + dy)
  await wait(500)
  console.log(`  after ${d} ${dx},${dy}:`, JSON.stringify(await box()))
}
console.log('  se rect:', await ev(`(() => { const L = document.querySelector('.loom-turn.is-shown .loom-liftable'); const h = L.querySelector(':scope > .loom-rz[data-rz="se"]'); const r = h.getBoundingClientRect(); const cs = getComputedStyle(h); return JSON.stringify([r.left, r.top, r.width, r.height, cs.pointerEvents, cs.zIndex, cs.display, getComputedStyle(L).overflow, L.className, L.parentElement.className, getComputedStyle(L.parentElement).overflow]) })()`))
console.log('  handles:', await ev(`document.querySelectorAll('.loom-turn.is-shown .loom-liftable > .loom-rz').length`), ' start:', JSON.stringify(await box()))
const start = await box()
await pull('se', 400, 160)
const grown = await box()
check('the corner handle sizes it in place', !!start && !!grown && grown[2] > start[2] && grown[3] > start[3], `${JSON.stringify(start)} -> ${JSON.stringify(grown)}`)
await pull('w', 100, 0)
await pull('n', 0, 60)
await pull('e', -80, 0)
await wait(800)
await shot('resized')
// Full screen, then zoom: Ctrl+wheel over the diagram, the + button, 0 back to fit.
await key('ArrowUp', 'ArrowUp', 2)
await wait(500)
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await wait(2500)
check('Enter opens it full screen, with the zoom bar', await ev(`!!document.querySelector('.loom-piece.is-full') && !!document.querySelector('.loom-zoom .loom-zoom-pct')`))
const fr = await ev(`(() => { const r = document.querySelector('.loom-piece.is-full iframe')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 3 } : null })()`)
if (fr) for (let i = 0; i < 4; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: fr.x, y: fr.y, deltaX: 0, deltaY: -120, modifiers: 2 }); await wait(120) }
await wait(500)
const zoomed = await ev(`document.querySelector('.loom-zoom .loom-zoom-pct')?.textContent`)
check('Ctrl+wheel zooms it', !!zoomed && zoomed !== '100%', zoomed)
await shot('zoomed')
await ev(`document.querySelector('.loom-zoom [data-z="reset"]')?.click()`)
await wait(500)
const reset = await ev(`document.querySelector('.loom-zoom .loom-zoom-pct')?.textContent`)
check('the 100% button goes back to fit', reset === '100%', reset)
// Esc steps back one level at a time: out of full screen first, then off the object.
await key('Escape', 'Escape')
await wait(600)
check('Esc leaves full screen, the ring still on', await ev(`!document.querySelector('.loom-piece.is-full') && !!document.querySelector('.is-kbd')`))
await key('Escape', 'Escape')
await wait(600)
check('a second Esc takes the ring off', await ev(`!document.querySelector('.is-kbd')`))
check('the diagram keeps its size in the reply', await ev(`!!document.querySelector('.loom-liftable.is-sized')`))
ws.close()
child.kill()
if (failures) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
}
