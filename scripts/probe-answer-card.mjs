/**
 * Questions a reply ends with get an answer card — the same deck as AskUserQuestion: one
 * question at a time, its options as rows, "Other…" last, a review, Submit. A dev Ember (own
 * EMBER_HOME), canvases fed made-up transcripts through window.__ember.loomFeed (no model).
 * What Submit would type is recorded through window.__ember.recordSends() instead of
 * reaching a terminal.
 *
 *   npm run build; node scripts/probe-answer-card.mjs [out-dir]
 *
 * Nothing is typed into any terminal.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedHome } from './probelib.mjs'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-answer-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-answers${process.env.PROBE_TAG ?? ''}`)
rmSync(EMBER_HOME, { recursive: true, force: true })
seedHome(EMBER_HOME)
mkdirSync(OUT, { recursive: true })
const PORT = Number(process.env.PROBE_PORT) || 9541
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

const four = [
  'Wave 1 is planned for both repos.',
  '',
  'Questions:',
  '1. May I start Wave 1 now in both repos? A, yes, both; B, radix-assistant only; or C, wait.',
  '2. For the status updates, which do you want? A, one post per thread that the bot edits in place; B, emoji reactions only, with a post only at done; or C, batched posts.',
  '3. Do you want quiet hours for channel posts? A, 20:00 to 08:00 Europe/Belgrade; B, no quiet hours.',
  '4. For the GitHub App `contents: write` permission, which do you want? A, read-only; B, write only on the 3 repos the bot works in; or C, no change.',
].join('\n')
const earlier = [
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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
  const LIVE = `document.querySelector('.loom-answers:not(.is-stale)')`
  /** A picture of the live card and the reply round it. */
  const shot = async (name) => {
    const box = await ev(`(() => { const c = ${LIVE}; if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.x - 40, y: r.y - 60, w: r.width + 80, h: r.height + 100 } })()`)
    await wait(260)
    const clip = box ? { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.w, height: box.h, scale: 1 } : undefined
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  /** A real click at the middle of the first visible element matching `sel` in the live card. */
  const click = async (sel) => {
    const at = await ev(`(() => { const e = [...${LIVE}.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.offsetParent); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (!at) throw new Error(`nothing to click: ${sel}`)
    await wait(80)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await wait(300)
  }
  const VK = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Tab: 9 }
  /** A real key press, to whatever has focus. */
  const press = async (key, shift = false) => {
    const char = key.length === 1
    const text = key === 'Enter' ? '\r' : char ? key : undefined
    const base = { key, code: char ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: VK[key] ?? key.toUpperCase().charCodeAt(0), modifiers: shift ? 8 : 0 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await wait(320)
  }
  /** The live card's state: the page on show, the options of every page, what is picked. */
  const state = () =>
    ev(`(() => { const c = ${LIVE}; if (!c) return null; return {
      at: [...c.querySelectorAll('.loom-qd-page')].findIndex((p) => !p.hidden),
      pages: [...c.querySelectorAll('.loom-qd-page[data-q]')].map((p) => ({
        text: p.querySelector('.loom-qd-text').textContent,
        keys: [...p.querySelectorAll('.loom-qd-opt[data-o] .loom-qd-key')].map((k) => k.textContent),
        options: [...p.querySelectorAll('.loom-qd-opt[data-o] .loom-qd-label')].map((l) => l.firstChild.textContent),
        on: [...p.querySelectorAll('.loom-qd-opt.is-on[data-o]')].map((o) => Number(o.dataset.o)),
        other: p.querySelector('.loom-qd-other').value,
        only: !!p.querySelector('.loom-qd-opt.is-other.is-only'),
      })),
      sums: [...c.querySelectorAll('.loom-qd-sum-a')].map((a) => a.textContent),
      go: (() => { const b = c.querySelector('.loom-qd-btn.is-primary'); return { text: b.textContent, disabled: b.disabled, hidden: b.hidden } })(),
      focus: document.activeElement?.className ?? '',
      sent: c.classList.contains('is-sent'),
    } })()`)
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
  // The window is shown inactive; keys still need a focused page to land where focus is.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  current = await ev('window.__ember.activeTab()')
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 820px !important; }'; document.head.appendChild(st); return true })()`)
  await ev('window.__ember.recordSends()')

  // ---- the real four-question reply; an older turn asked too, only the latest card is live.
  const tab = await tabWith([user('plan wave 1'), said('Before I start:\n\n1. Should I use the old template, or the new one?'), user('the new one'), said(four)])
  const cards = await ev(`[...document.querySelectorAll('.loom-answers')].map((c) => c.classList.contains('is-stale'))`)
  check('older turn card is not live, one live card', eq(cards, [true, false]), JSON.stringify(cards))
  let s = await state()
  const lower = (a) => a.map((x) => x.toLowerCase())
  check('4 questions, the first on show', s.pages.length === 4 && s.at === 0)
  check('Q1 options', eq(lower(s.pages[0].options), ['yes, both', 'radix-assistant only', 'wait']), JSON.stringify(s.pages[0].options))
  check('Q2 options', eq(lower(s.pages[1].options), ['one post per thread that the bot edits in place', 'emoji reactions only, with a post only at done', 'batched posts']), JSON.stringify(s.pages[1].options))
  check('Q3 options', eq(lower(s.pages[2].options), ['20:00 to 08:00 europe/belgrade', 'no quiet hours']), JSON.stringify(s.pages[2].options))
  check('Q4 options', eq(lower(s.pages[3].options), ['read-only', 'write only on the 3 repos the bot works in', 'no change']), JSON.stringify(s.pages[3].options))
  check("keys are the reply's letters", eq(s.pages.map((p) => p.keys.join('')), ['ABC', 'ABC', 'AB', 'ABC']))
  check('question text without its options', s.pages[3].text === 'For the GitHub App contents: write permission, which do you want?', s.pages[3].text)
  check('Next before an answer (skippable)', s.go.text === 'Next' && !s.go.disabled)
  await shot('1-q1-unanswered')

  // Keyboard: into the card, ↓ to B, Enter picks it and moves on.
  // The new tab hands the keyboard to its prompt a frame late: take it back after that.
  await wait(400)
  await ev(`${LIVE}.querySelector('.loom-qd-opt[data-o="0"]').focus()`)
  await wait(200)
  await press('ArrowDown')
  check('↓ moves to B', (await ev(`document.activeElement?.dataset?.o`)) === '1')
  await press('Enter')
  s = await state()
  check('Enter picks B and moves to Q2', eq(s.pages[0].on, [1]) && s.at === 1, JSON.stringify({ on: s.pages[0].on, at: s.at }))
  await press('ArrowLeft')
  s = await state()
  check('← goes back to Q1, B still picked', s.at === 0 && eq(s.pages[0].on, [1]))
  await shot('2-q1-picked')
  await press('Tab')
  check('Tab goes to Q2', (await state()).at === 1)
  await press('c')
  s = await state()
  check('letter key c picks C and moves on', eq(s.pages[1].on, [2]) && s.at === 2, JSON.stringify({ on: s.pages[1].on, at: s.at }))
  // Q3: the Other row's key is C; it opens the field.
  await press('c')
  check('Other key focuses the field', (await ev(`document.activeElement?.className`)) === 'loom-qd-other')
  await send('Input.insertText', { text: 'only on weekends' })
  await wait(200)
  s = await state()
  check('typing in Other marks it, clears the picks', s.pages[2].other === 'only on weekends' && s.pages[2].on.length === 0)
  await shot('3-q3-other-typing')
  await press('Enter')
  s = await state()
  check('Enter in Other moves to Q4', s.at === 3)
  await press('a')
  s = await state()
  check('Q4 picked, the review is on show', eq(s.pages[3].on, [0]) && s.at === 4)
  check('review lists the answers', eq(s.sums, ['B — Radix-assistant only', 'C — Batched posts', 'only on weekends', 'A — Read-only']), JSON.stringify(s.sums))
  check('Submit ready, focused', s.go.text === 'Submit' && !s.go.disabled && /is-primary/.test(s.focus), JSON.stringify(s.go))
  await shot('4-review')
  await click('.loom-qd-btn.is-primary')
  const sends = await ev('window.__ember.sends()')
  console.log('sent', JSON.stringify(sends.map((x) => x.text)))
  check(
    'Submit sends the composed answer once',
    sends.length === 1 && sends[0].text === '1. B — radix-assistant only; 2. C — batched posts; 3. only on weekends; 4. A — read-only' && sends[0].submit === true && sends[0].tab === tab,
  )
  s = await state()
  check('card locked as sent', s.sent && s.go.hidden && (await ev(`[...${LIVE}.querySelectorAll('button, input')].every((b) => b.disabled)`)))
  await shot('5-sent')
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify([user(sends[0].text), said('Starting Wave 1 in radix-assistant.')])})`)
  await wait(300)
  check('answered card kept, inert', await ev(`(() => { const c = document.querySelector('.loom-answers.is-sent'); return !!c && !c.classList.contains('is-stale') && c.inert })()`))

  // ---- the earlier reply: named options, two sides, yes / no; picked with clicks.
  await tabWith([user('set up the ideas'), said(earlier)])
  s = await state()
  check(
    'earlier: Platform (current) + the 5',
    eq(s.pages[0].options, ['Platform', 'Analytics', 'Underwriting', 'RealRents', 'Data Platform', 'Intelligence']) && (await ev(`${LIVE}.querySelector('.loom-qd-opt[data-o="0"] .loom-qd-tag')?.textContent`)) === 'current',
    JSON.stringify(s.pages[0].options),
  )
  check('earlier: two sides', eq(s.pages[1].options, ['The 3 pilot repos', 'All repos']), JSON.stringify(s.pages[1].options))
  check('earlier: yes / no', eq(s.pages[2].options, ['Yes', 'No']) && eq(s.pages[2].keys, ['1', '2']))
  await shot('6-earlier-q1')
  await click('.loom-qd-opt[data-o="0"]')
  await click('.loom-qd-opt[data-o="1"]')
  await click('.loom-qd-opt[data-o="0"]')
  await click('.loom-qd-btn.is-primary')
  let all = await ev('window.__ember.sends()')
  check('earlier: sends by label', all[all.length - 1]?.text === '1. Platform; 2. All repos; 3. Yes', all[all.length - 1]?.text)

  // ---- skipping: Next past a question, Submit with what was answered.
  await tabWith([user('x'), said(four)])
  await click('.loom-qd-btn.is-primary') // Next: Q1 skipped
  await click('.loom-qd-opt[data-o="0"]') // Q2 A
  await click('.loom-qd-tab.is-submit')
  s = await state()
  check('skipped shows as Skipped in the review', s.at === 4 && s.sums[0] === 'Skipped' && s.sums[2] === 'Skipped', JSON.stringify(s.sums))
  await click('.loom-qd-btn.is-primary')
  all = await ev('window.__ember.sends()')
  check('only the answered go out', all[all.length - 1]?.text === '2. A — one post per thread that the bot edits in place', all[all.length - 1]?.text)

  // ---- a reply that asks nothing: no card.
  await tabWith([user('what happened?'), said('The deploy finished.\n\n- three files changed\n- tests pass')])
  check('no questions, no card', (await ev(`document.querySelectorAll('.loom-answers').length`)) === 0)
  // A reply asking, then a step after it: the turn went on, so no live card.
  await tabWith([user('go'), said('Should I also update the docs?'), tool()])
  check('step after the question: card not live', (await ev(`document.querySelectorAll('.loom-answers:not(.is-stale):not(.is-sent)').length`)) === 0)
  // One trailing question: Yes / No, no tabs, the answer goes without a number.
  await tabWith([user('fix it'), said('Fixed the off-by-one in the pager. Want me to push it to main?')])
  s = await state()
  check('trailing question → Yes / No, no tabs', !!s && eq(s.pages.map((p) => p.options), [['Yes', 'No']]) && (await ev(`!${LIVE}.querySelector('.loom-qd-tabs')`)), JSON.stringify(s?.pages))
  await shot('7-single')
  await click('.loom-qd-opt[data-o="0"]')
  check('one question: Submit takes the focus', /is-primary/.test((await state()).focus))
  await press('Enter')
  all = await ev('window.__ember.sends()')
  check('single answer has no number', all[all.length - 1]?.text === 'Yes', all[all.length - 1]?.text)
  // A question with no options it can read: a field only.
  await tabWith([user('names?'), said('**Open questions**\n\n- What should the new service be called?')])
  s = await state()
  check('open question → field only', !!s && s.pages[0].options.length === 0 && s.pages[0].only, JSON.stringify(s?.pages))
  await click('.loom-qd-other')
  await send('Input.insertText', { text: 'ledger' })
  await wait(150)
  await shot('8-field-only')
  await press('Enter')
  all = await ev('window.__ember.sends()')
  check('a typed answer goes with Enter', all[all.length - 1]?.text === 'ledger', all[all.length - 1]?.text)
  // A paragraph asking, with lettered options after its question.
  await tabWith([user('db?'), said('Both work. Which database should we use? A) Postgres B) SQLite.')])
  s = await state()
  check('paragraph with lettered options', !!s && eq(s.pages[0].options, ['Postgres', 'SQLite']) && eq(s.pages[0].keys, ['A', 'B']), JSON.stringify(s?.pages))

  console.log(failed ? `${failed} FAILED` : 'all ok')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  // Electron relaunches itself after a GPU reset, out from under that tree: take any
  // process of this build on this port with it.
  spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
}
