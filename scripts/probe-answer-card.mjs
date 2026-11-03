/**
 * Questions a reply ends with get an answer card: options as chips, a field each, Send.
 * A dev Ember (own EMBER_HOME), canvases fed made-up transcripts through
 * window.__ember.loomFeed (no model). What Send would type is recorded through
 * window.__ember.recordSends() instead of reaching a terminal.
 *
 *   npm run build; node scripts/probe-answer-card.mjs [out-dir]
 *
 * Nothing is typed into any terminal.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-answer-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-answers')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9413
// A live answer on the port is another Ember (an earlier run's): it would be probed instead of this build.
if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) {
  console.error(`port ${PORT} is taken; close what holds it first`)
  process.exit(1)
}
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x900', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const questions = [
  'I drafted the four ideas and the message to Kyle.',
  '',
  '**Questions**',
  '1. Is Product Line `Platform` correct? The other options are Analytics, Underwriting, RealRents, Data Platform and Intelligence.',
  '2. Is the 50% target for the 3 pilot repos, or for all repos?',
  '3. Your account cannot set the assignee in UP. Should the Kyle message ask him to assign the 4 ideas to you?',
].join('\n')
let n = 0
const user = (text) => ({ type: 'user', uuid: `u${++n}`, timestamp: '2026-11-03T09:00:00Z', message: { role: 'user', content: text } })
const said = (text) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: '2026-11-03T09:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const tool = () => ({ type: 'assistant', uuid: `t${++n}`, timestamp: '2026-11-03T09:00:02Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu${n}`, name: 'Read', input: { file_path: 'C:\\x\\a.ts' } }] } })

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  /** A real click at the middle of the first element matching `sel` in the live card. */
  const click = async (sel) => {
    const at = await ev(`(() => { const e = document.querySelector('.loom-answers:not(.is-stale) ' + ${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (!at) throw new Error(`nothing to click: ${sel}`)
    await wait(80)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await wait(80)
  }
  // One tab at a time, so every query below is about the canvas on screen.
  let current = null
  const tabWith = async (lines) => {
    const tab = await ev('window.__ember.newLoom()')
    await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    if (current) await ev(`window.__ember.closeTab(${JSON.stringify(current)})`)
    current = tab
    await wait(1200)
    await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
    await wait(800)
    return tab
  }
  await wait(5000)
  current = await ev('window.__ember.activeTab()')
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 820px !important; }'; document.head.appendChild(st); return true })()`)
  await ev('window.__ember.recordSends()')

  // An older turn asked too; only the latest reply's card is live.
  const tab = await tabWith([
    user('set up the ideas'),
    said('Before I start:\n\n1. Should I use the old template, or the new one?'),
    user('the new one'),
    said(questions),
  ])
  const all = await ev(`[...document.querySelectorAll('.loom-answers')].map((c) => ({ stale: c.classList.contains('is-stale'), rows: [...c.querySelectorAll('.loom-ans-row')].map((r) => [...r.querySelectorAll('.loom-ans-chip')].map((b) => b.dataset.value)) }))`)
  const live = all.filter((c) => !c.stale)
  check('older turn card is not live', all.length === 2 && all[0].stale, JSON.stringify(all.map((c) => c.stale)))
  check('one live card, 3 rows', live.length === 1 && live[0].rows.length === 3)
  const rows = live[0]?.rows ?? []
  console.log('rows', JSON.stringify(rows))
  check('row 1 chips', JSON.stringify(rows[0]) === JSON.stringify(['Platform', 'Analytics', 'Underwriting', 'RealRents', 'Data Platform', 'Intelligence']))
  check('row 2 chips', JSON.stringify(rows[1]) === JSON.stringify(['The 3 pilot repos', 'All repos']))
  check('row 3 chips', JSON.stringify(rows[2]) === JSON.stringify(['Yes', 'No']))
  check('Platform marked current', (await ev(`document.querySelector('.loom-answers:not(.is-stale) .loom-ans-chip.is-current')?.dataset.value`)) === 'Platform')
  check('Send disabled before any answer', await ev(`document.querySelector('.loom-answers:not(.is-stale) .loom-ans-send').disabled`))
  await shot('card')

  await click('.loom-ans-row[data-n="1"] .loom-ans-chip[data-value="Analytics"]')
  await click('.loom-ans-row[data-n="1"] .loom-ans-chip[data-value="Platform"]') // changing your mind: single select
  await click('.loom-ans-row[data-n="2"] .loom-ans-chip[data-value="All repos"]')
  await click('.loom-ans-row[data-n="3"] .loom-ans-chip[data-value="Yes"]')
  await click('.loom-ans-row[data-n="3"] .loom-ans-other')
  await send('Input.insertText', { text: 'ask him to assign them to me' })
  await wait(150)
  check('row 1 single select', (await ev(`[...document.querySelectorAll('.loom-answers:not(.is-stale) .loom-ans-row[data-n="1"] [aria-pressed="true"]')].map((b) => b.dataset.value).join()`)) === 'Platform')
  check('focus stays in the field', (await ev(`document.activeElement?.className`)) === 'loom-ans-other')
  await shot('card-filled')
  // Enter in a field sends, as Send would.
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
  await wait(300)
  const sends = await ev('window.__ember.sends()')
  console.log('sent', JSON.stringify(sends.map((s) => s.text)))
  check('sends the composed answer once, with Enter', sends.length === 1 && sends[0].text === '1. Platform; 2. All repos; 3. Yes — ask him to assign them to me' && sends[0].submit === true && sends[0].tab === tab)
  check('card locked as sent', await ev(`(() => { const c = document.querySelector('.loom-answers:not(.is-stale)'); return c.classList.contains('is-sent') && [...c.querySelectorAll('button, input')].every((b) => b.disabled) })()`))
  await shot('card-sent')
  // Your answer arrives as a new turn: the answered card stays as a record, inert.
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify([user('1. Platform; 2. All repos; 3. Yes — ask him to assign them to me'), said('Done.')])})`)
  await wait(300)
  check('answered card kept, inert', await ev(`(() => { const c = document.querySelector('.loom-answers.is-sent'); return !!c && !c.classList.contains('is-stale') && c.inert })()`))

  // A reply that asks nothing: no card.
  await tabWith([user('what happened?'), said('The deploy finished.\n\n- three files changed\n- tests pass')])
  check('no questions, no card', (await ev(`document.querySelectorAll('.loom-answers').length`)) === 0)
  // A reply asking, then a step after it: the turn went on, so no live card.
  await tabWith([user('go'), said('Should I also update the docs?'), tool()])
  check('step after the question: card not live', (await ev(`document.querySelectorAll('.loom-answers:not(.is-stale):not(.is-sent)').length`)) === 0)
  // One trailing question: Yes / No, and the answer goes without a number.
  await tabWith([user('fix it'), said('Fixed the off-by-one in the pager. Want me to push it to main?')])
  const one = await ev(`[...document.querySelectorAll('.loom-answers:not(.is-stale):not(.is-sent) .loom-ans-row')].map((r) => [...r.querySelectorAll('.loom-ans-chip')].map((b) => b.dataset.value))`)
  check('trailing question → Yes / No', JSON.stringify(one) === JSON.stringify([['Yes', 'No']]), JSON.stringify(one))
  await click('.loom-ans-chip[data-value="Yes"]')
  await click('.loom-ans-send')
  const after = await ev('window.__ember.sends()')
  check('single answer has no number', after[after.length - 1]?.text === 'Yes', after[after.length - 1]?.text)
  // A question with no options it can read: a field only.
  await tabWith([user('names?'), said('**Open questions**\n\n- What should the new service be called?')])
  const field = await ev(`(() => { const c = document.querySelector('.loom-answers:not(.is-stale):not(.is-sent)'); return c ? { chips: c.querySelectorAll('.loom-ans-chip').length, only: !!c.querySelector('.loom-ans-other.is-only') } : null })()`)
  check('open question → field only', field && field.chips === 0 && field.only, JSON.stringify(field))
  await shot('field-only')

  console.log(failed ? `${failed} FAILED` : 'all ok')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  // Electron relaunches itself after a GPU reset, out from under that tree: take any
  // process of this build on this port with it.
  spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${PORT}*' -and $_.CommandLine -like '*ember-asks*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`.replace('ember-asks', REPO.split('/').pop())], { stdio: 'ignore' })
}
