/**
 * Ember turns: a request and its follow-ups are one turn (src/shared/turnGroups.ts). A dev
 * Ember (own EMBER_HOME) whose canvas is fed a made-up transcript through
 * window.__ember.loomFeed: a request, its reply, `/model`, "yes do it", a reply, then a long
 * new request and its reply. Two points on the rail; the follow-ups inside turn 1; "Split into
 * its own turn" and "Join previous" move them; a named session's card is just the name.
 *
 *   npm run build; node scripts/probe-turn-groups.mjs [out-dir]
 *
 * Nothing is typed into any terminal.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-turn-groups-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-turn-groups')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = Number(process.env.PROBE_PORT) || 9652
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ---- the made-up session: seconds apart, as a real one would be ----
let n = 0
let t = Date.parse('2026-11-09T09:00:00Z')
const at = (s) => new Date((t += s * 1000)).toISOString()
const u = (content, s = 10) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(s), message: { role: 'user', content } })
const a = (text, s = 20) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: at(s), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const LONG =
  'Now something else entirely: build a settings page for the notifications service with a toggle per channel, a quiet hours range picker, and a preview of how each notification will look on the phone and on the desktop.'
const lines = [
  u('Refactor the auth middleware so it reads sessions from the new store'),
  a('## Plan\n\nI will move the session lookup into `SessionStore.get()` and keep the old cookie path as a fallback.\n\n| Step | File |\n|---|---|\n| 1 | auth/middleware.ts |\n| 2 | auth/store.ts |\n\nShall I go ahead?'),
  u('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', 30),
  u('<local-command-stdout>Set model to opus</local-command-stdout>', 1),
  u('yes do it', 15),
  a('Done. The middleware now reads from the new store; the cookie path stays as a fallback for a week.'),
  u(LONG, 120),
  a('## Notifications settings\n\nA page with one row per channel, a quiet-hours picker and a live preview. I put it under **Settings › Notifications**.'),
]

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')
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
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log(`shot ${file}`)
  }
  const VIS = `[...document.querySelectorAll('.loom')].find((x) => x.offsetParent)`
  const state = () =>
    ev(`(() => { const v = ${VIS}; if (!v) return null
      const turns = [...v.querySelectorAll('.loom-flow > .loom-turn')].filter((x) => x.querySelector(':scope > .loom-ask'))
      const sh = v.querySelector('.loom-turn.is-shown')
      const vis = (e) => e && getComputedStyle(e).display !== 'none'
      return {
        dots: v.querySelectorAll('.loom-rail .loom-dot').length,
        titles: [...v.querySelectorAll('.loom-rail .loom-dot')].map((d) => d.title),
        turns: turns.map((t) => ({
          ask: t.querySelector(':scope > .loom-ask .loom-ask-text')?.textContent ?? '',
          follows: [...t.querySelectorAll(':scope > .loom-follow .loom-follow-text')].map((f) => f.textContent),
          notes: [...t.querySelectorAll(':scope > [data-cmd]')].map((f) => f.textContent),
          says: [...t.querySelectorAll(':scope > .loom-say')].filter((s) => t !== sh || vis(s)).map((s) => s.textContent.slice(0, 30)),
        })),
        shownAsk: sh?.querySelector('.loom-ask-text')?.textContent ?? '',
      } })()`)

  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev('window.__ember.newLoom()')
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(1500)
  const sid = await ev(`window.__ember.sessions()[0].id`)
  await ev(`window.__ember.term(${JSON.stringify(sid)}).write('\\x1b]0;\\u2733 Claude Code\\x07'), true`)
  await wait(2500)
  await ev(`localStorage.removeItem('ember.turnOverrides'), true`)
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
  await wait(800)
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 640px !important; }'; document.head.appendChild(st); return true })()`)
  await wait(800)

  let s = await state()
  check('two points on the rail', s?.dots === 2, JSON.stringify(s?.titles))
  check('the rail titles hold no button labels', !s?.titles.some((x) => /Join previous|Split into/.test(x)))
  check('the rail says the main requests', /Refactor the auth middleware/.test(s?.titles[0] ?? '') && /Now something else/.test(s?.titles[1] ?? ''), JSON.stringify(s?.titles))
  const t1 = s?.turns[0]
  check('turn 1: /model and "yes do it" are inside it', !!t1 && t1.notes.some((x) => /\/model/.test(x)) && t1.follows.includes('yes do it'), JSON.stringify(t1))
  check('turn 1: both replies are in it', !!t1 && t1.says.length === 2, JSON.stringify(t1?.says))
  check('turn 2: the long new request, no follow-ups', s?.turns[1]?.follows.length === 0 && /Now something else/.test(s?.turns[1]?.ask ?? ''))
  await shot('1-turn2-newest')

  // Back to turn 1: both parts and their answers on screen.
  await ev(`(() => { const d = ${VIS}.querySelector('.loom-rail .loom-dot'); d.click(); return true })()`)
  await wait(700)
  s = await state()
  check('turn 1 on screen: its request, the follow-up and both answers visible', /Refactor/.test(s?.shownAsk ?? '') && s?.turns[0]?.says.length === 2, JSON.stringify(s?.turns[0]))
  await ev(`(() => { const f = ${VIS}.querySelector('.loom-turn.is-shown .loom-follow'); const r = f.getBoundingClientRect(); return true })()`)
  // Hover the follow-up so its "Split" shows in the picture.
  const fr = await ev(`(() => { const r = ${VIS}.querySelector('.loom-turn.is-shown > .loom-follow').getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fr.x, y: fr.y })
  await wait(300)
  await shot('2-turn1-with-follow-up')

  // Split it off, then join it back.
  await ev(`(() => { ${VIS}.querySelector('.loom-turn.is-shown > .loom-follow .loom-regroup').click(); return true })()`)
  await wait(500)
  s = await state()
  check('"Split into its own turn": three turns, "yes do it" heads the second', s?.dots === 3 && s?.turns[1]?.ask === 'yes do it' && /Done\./.test(s?.turns[1]?.says[0] ?? ''), JSON.stringify(s?.turns.map((x) => x.ask)))
  const stored = await ev(`localStorage.getItem('ember.turnOverrides')`)
  check('the split is remembered for a reload', /"u5":"split"/.test(stored ?? ''), stored)
  await ev(`(() => { const t = [...${VIS}.querySelectorAll('.loom-flow > .loom-turn')].find((x) => x.querySelector(':scope > .loom-ask .loom-ask-text')?.textContent === 'yes do it'); t.querySelector(':scope > .loom-ask .loom-regroup').click(); return true })()`)
  await wait(500)
  s = await state()
  check('"Join previous": two turns again, "yes do it" back inside turn 1', s?.dots === 2 && s?.turns[0]?.follows.includes('yes do it') && s?.turns[0]?.says.length === 2, JSON.stringify(s?.turns))
  check('the first turn offers no "Join previous"', await ev(`(() => { const b = ${VIS}.querySelector('.loom-turn.is-first > .loom-ask .loom-regroup'); return !b || getComputedStyle(b).display === 'none' })()`))

  // The step the large live line names is not shown twice while it is the one in progress.
  const tool = { type: 'assistant', uuid: `a${++n}`, timestamp: at(5), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ts1', name: 'ToolSearch', input: { query: 'select:Read' } }] } }
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify([tool])})`)
  await ev(`(() => { const d = [...${VIS}.querySelectorAll('.loom-rail .loom-dot')].pop(); d.click(); return true })()`)
  await ev(`window.__ember.loomWorking(${JSON.stringify(tab)}, true)`)
  await wait(500)
  const dup = () => ev(`(() => { const v = ${VIS}; const row = [...v.querySelectorAll('.loom-flow .loom-tool')].find((x) => /loaded tools/i.test(x.textContent)); const now = v.querySelector('.loom-now.is-on .loom-now-line')?.innerText ?? ''; return { now, row: !!row, rowShown: !!row && row.getClientRects().length > 0 } })()`)
  let d = await dup()
  check('mid-step: "Loaded tools" is said once, on the live line, not also as a row', /Loaded tools/.test(d.now) && d.row && !d.rowShown, JSON.stringify(d))
  await shot('3-step-said-once')
  await ev(`window.__ember.loomWorking(${JSON.stringify(tab)}, false)`)
  await wait(300)
  d = await dup()
  check('once the work stops the step stays folded away', d.row && !d.rowShown && !d.now, JSON.stringify(d))

  // A request's steps are one line that counts them; the rows are behind it.
  const use = (id, name, input) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: at(3), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  const res = (id, content, is_error = false) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })
  const work = [
    use('b1', 'Bash', { command: 'cd /c/repo; git grep -nE "tree changes" origin/master -- policy', description: 'Grep limits in policy' }),
    res('b1', 'policy/work-types.yaml:181: max_per_day: 40'),
    use('r1', 'Read', { file_path: 'C:/repo/policy/work-types.yaml' }),
    res('r1', 'max_per_day: 40'),
    use('b2', 'Bash', { command: 'ls .github/workflows', description: 'List workflows' }),
    res('b2', "ls: cannot access '.github/workflows': No such file or directory", true),
    use('e1', 'Edit', { file_path: 'C:/repo/policy/work-types.yaml', old_string: 'max_per_day: 40', new_string: 'max_per_day: 50' }),
    res('e1', 'done'),
    a('The daily limit is now 50.', 4),
  ]
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(work)})`)
  await wait(600)
  const fold = () => ev(`(() => { const v = ${VIS}; const t = v.querySelector('.loom-turn.is-shown'); const shown = (x) => x.getClientRects().length > 0; return { folds: [...t.querySelectorAll('.loom-fold')].filter(shown).map((f) => f.querySelector('.loom-tool-head').innerText.replace(/\\s+/g, ' ').trim()), rows: [...t.querySelectorAll('.loom-tool')].filter(shown).length, peeks: [...t.querySelectorAll('.loom-peek-line, .loom-diff')].filter(shown).length } })()`)
  let f = await fold()
  check('the steps of a request are one line that counts them', f.folds.length === 1 && /5 steps/.test(f.folds[0]) && /ran 2 commands/.test(f.folds[0]) && /read 1 file/.test(f.folds[0]) && /1 failed/.test(f.folds[0]), JSON.stringify(f))
  check('no command, output or diff on the canvas until it is opened', f.rows === 0 && f.peeks === 0, JSON.stringify(f))
  await shot('3b-steps-folded')
  await ev(`${VIS}.querySelector('.loom-turn.is-shown .loom-fold > .loom-tool-head').click()`)
  await wait(300)
  f = await fold()
  check('the line opens to the steps', f.rows >= 4, JSON.stringify(f))
  await shot('3c-steps-open')
  await ev(`${VIS}.querySelector('.loom-turn.is-shown .loom-fold > .loom-tool-head').click()`)

  // A named session's card: just the name; the folder only when there is no name.
  await ev(`window.__ember.loomTitle(${JSON.stringify(tab)}, '', 'claude')`)
  await wait(1200)
  const before = await ev(`window.__ember.card(${JSON.stringify(tab)})`)
  await ev(`window.__ember.loomTitle(${JSON.stringify(tab)}, 'test')`)
  await wait(1200)
  const after = await ev(`window.__ember.card(${JSON.stringify(tab)})`)
  const title = await ev(`document.querySelector('.ember-card.is-active .ember-card-title, .ember-card .ember-card-title')?.textContent ?? ''`)
  check('unnamed: the card is "agent · folder"', /·/.test(before.split('\n')[0] ?? ''), JSON.stringify(before))
  check('named "test": the card title is just "test"', (title || after.split('\n')[0]).trim() === 'test', JSON.stringify({ title, after }))
  await shot('4-card-named')

  console.log(failed ? `\n${failed} failed` : '\nall passed')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
process.exitCode = failed ? 1 : 0
