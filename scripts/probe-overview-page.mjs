/**
 * The overview as a place to work from: stages a realistic scene and photographs it.
 *
 *   node scripts/probe-overview-page.mjs [outdir] [--theme "<theme name>"]
 *
 * Starts a test Ember with the user's config (or the named theme), three tabs: two that
 * pass as Claude sessions — titles set over OSC, transcripts written where Claude Code
 * writes them, bound over the bridge, a status line posted for each — and a plain shell.
 * One session shows a permission picker on its screen. Then it opens the overview from
 * the sidebar's Overview button and checks the page: the numbers, a card per session,
 * the picker's keys, the todo and notes in the rail, the log. Screenshots: the page, a
 * card opened up, and the sidebar.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const themeAt = args.indexOf('--theme')
const themeName = themeAt >= 0 ? args[themeAt + 1] : null
const OUT = args.find((a, i) => !a.startsWith('--') && !(themeAt >= 0 && i === themeAt + 1)) ?? join(process.env.TEMP ?? '.', 'ember-overview-shots')
mkdirSync(OUT, { recursive: true })
const PORT = 9363
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
writeFileSync(
  join(NOTES, 'Todo.md'),
  '# Todo\n\n- [ ] Replace the ADR format and fix the Slack message\n- [ ] Review the agentic harness pricing notes [Mail](https://mail.google.com/mail/#all/1)\n- [ ] Ship Ember 1.1 to the site\n- [x] Sign the installer\n- [ ] Answer Noah on DE-862\n',
)
writeFileSync(join(NOTES, 'Harness ideas.md'), '# Harness ideas\n\nTool budget per agent, a judge that reads diffs, retries with a smaller model.\n')
writeFileSync(join(NOTES, 'ADR template.md'), '# ADR template\n\nContext, decision, consequences. Keep it to one page.\n')

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
cfg.restoreSession = false
cfg.claude = { ...(cfg.claude ?? {}), statusLine: true }
cfg.agent = { ...(cfg.agent ?? {}), onboarded: true }
if (themeName) {
  // Forced from the source palette, before launch — the way shot-themes.mjs does it.
  const src = readFileSync(new URL('../src/main/themes.ts', import.meta.url), 'utf8')
  const at = src.indexOf(`name: '${themeName}'`)
  if (at < 0) throw new Error(`no theme named ${themeName}`)
  cfg.theme = new Function(`return ${src.slice(src.lastIndexOf('{', at), src.indexOf('}', at) + 1)}`)()
}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(EMBER_HOME, 'ud')}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES, EMBER_PROBE_INACTIVE: '1' },
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1') && !t.url.startsWith('devtools://'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('DevTools endpoint never came up')
}

let ws
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('shot', file)
}
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error(logs.join('').slice(-4000))
  child.kill()
  process.exit(1)
}
const checks = []
const check = (ok, what) => {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) process.exitCode = 1
}

async function readToken(sessionIndex) {
  const file = join(EMBER_HOME, 'token.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await ev(`window.ember.write(window.__ember.sessions()[${sessionIndex}].id, ${JSON.stringify(`${line}\r`)})`)
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const token = readFileSync(file, 'utf8').trim()
    if (token) return token
  }
  return null
}

/** Write to a tab's shell as if it were output: `Write-Host` with escapes. */
async function say(sessionIndex, lines) {
  const cmd = ['cls', ...[].concat(lines).map((l) => `Write-Host '${l.replace(/'/g, "''")}'`)].join('; ')
  await ev(`window.ember.write(window.__ember.sessions()[${sessionIndex}].id, ${JSON.stringify(`${cmd}\r`)})`)
}
async function title(sessionIndex, t) {
  await ev(`window.ember.write(window.__ember.sessions()[${sessionIndex}].id, ${JSON.stringify(`$host.UI.RawUI.WindowTitle = '${t}'\r`)})`)
}

try {
  ws = new WebSocket((await target()).webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(3500)
  await ev(`window.__ember.newTab()`)
  await sleep(1500)
  await ev(`window.__ember.newTab()`)
  await sleep(2000)
  const wire = await ev(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabs: [...document.querySelectorAll('.ember-group')].map((g) => g.dataset.groupId),
    cwd: window.__ember.sessions()[0]?.cwd ?? '',
  }))()`)
  const token = await readToken(0)
  if (!token) fail('no bridge token')

  // Tabs 0 and 1 pass as Claude; tab 2 is a plain shell.
  await title(0, '✳ Claude Code')
  await title(1, '✳ Claude Code')
  await sleep(600)
  await title(0, 'agentic harness')
  await title(1, 'adr')
  await title(2, 'pwsh')
  await sleep(600)

  const cwd = wire.cwd || process.cwd()
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const t0 = Date.now() - 40 * 60_000
  let n = 0
  const at = (min) => new Date(t0 + min * 60_000).toISOString()
  const asst = (min, content, stop, usage) =>
    `${JSON.stringify({ type: 'assistant', timestamp: at(min), message: { id: `m${++n}`, role: 'assistant', content, stop_reason: stop, usage } })}\n`
  const u = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw })

  const sessions = []
  for (const [i, script] of [
    [
      0,
      [
        asst(1, [{ type: 'text', text: 'Reading the harness config first.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'C:/work/harness/src/config.ts' } }], 'tool_use', u(1200, 340, 42000, 3100)),
        asst(4, [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:/work/harness/src/runner.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd\ne' } }], 'tool_use', u(900, 610, 51000, 1200)),
        asst(6, [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'Run the test suite' } }], 'tool_use', u(400, 120, 52000, 300)),
        asst(9, [{ type: 'tool_use', name: 'WebSearch', input: { query: 'TypeSafe Jev pricing 2026' } }], 'tool_use', u(300, 90, 53000, 200)),
        asst(12, [{ type: 'text', text: 'Pricing is public: TypeSafe Jev is in General Availability with no waitlist (explainx.ai). I am collecting the tiers into a table next.' }], 'tool_use', u(500, 820, 54000, 900)),
      ],
    ],
    [
      1,
      [
        asst(2, [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:/work/adr/docs/adr/0007-message-bus.md', content: '# 7\n\nContext\n\nDecision\n\nConsequences\n' } }], 'tool_use', u(2100, 1400, 30000, 5200)),
        asst(5, [{ type: 'tool_use', name: 'MultiEdit', input: { file_path: 'C:/work/adr/docs/adr/README.md', edits: [{ old_string: 'x', new_string: 'x\ny\nz' }] } }], 'tool_use', u(600, 300, 36000, 400)),
        asst(
          8,
          [
            {
              type: 'text',
              text: "My Slack tools have no **delete** action, so you or a workspace admin must remove them with \"Delete message\".\n\nWhat I can do instead:\n\n- Post a correction in the thread\n- Edit the message to `[removed]`\n\n```\n/slack edit last [removed]\n```",
            },
          ],
          'end_turn',
          u(800, 520, 37000, 600),
        ),
      ],
    ],
  ]) {
    const sessionId = `probe-${Date.now()}-${i}`
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, script.join(''), 'utf8')
    sessions.push({ i, sessionId, file })
    const r = await fetch(`${wire.origin}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({ tabId: wire.tabs[i], sessionId, cwd }),
    })
    if (!r.ok) fail(`bind ${i}: ${r.status}`)
    await fetch(`${wire.origin}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': token },
      body: JSON.stringify({
        tabId: wire.tabs[i],
        status: { session_id: sessionId, model: { display_name: 'Fable' }, context_window: { used_percentage: i === 0 ? 46 : 83, context_window_size: 200000 }, cost: { total_cost_usd: i === 0 ? 1.84 : 0.62 } },
      }),
    })
  }
  await sleep(1500)
  // Live: tab 0 keeps working, tab 1 shows a permission picker.
  appendFileSync(sessions[0].file, asst(39, [{ type: 'tool_use', name: 'Bash', input: { command: 'node scripts/collect.mjs', description: 'Collect the pricing tiers' } }], 'tool_use', u(200, 80, 55000, 100)))
  await say(0, '✻ Collecting… (8m 54s · esc to interrupt)')
  await say(
    1,
    [
      ' Bash command',
      '',
      '   gh pr create --title "ADR 7: message bus"',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for gh pr commands",
      '   3. No, and tell Claude what to do differently (esc)',
    ],
  )
  await sleep(2500)

  // Open it the way a person would: the Overview button at the top of the sidebar.
  const nav = await ev(`[...document.querySelectorAll('.ember-place')].map((b) => b.dataset.place)`)
  check(JSON.stringify(nav) === JSON.stringify(['overview', 'todo', 'notes', 'map']), `sidebar places: ${JSON.stringify(nav)}`)
  await ev(`document.querySelector('.ember-place[data-place="overview"]').click()`)
  await sleep(2500)

  const page = await ev(`(() => {
    const v = document.querySelector('.ember-overview')
    if (!v) return null
    const q = (s) => v.querySelector(s)
    return {
      kpis: [...v.querySelectorAll('.ember-ov-kpi')].filter((k) => !k.hidden).map((k) => k.dataset.k + '=' + (k.querySelector('.ember-ov-kpi-value')?.textContent ?? 'svg') + ' / ' + k.querySelector('.ember-ov-kpi-sub').textContent),
      cards: [...v.querySelectorAll('.ember-ov-card')].map((c) => ({ title: c.querySelector('.ember-ov-title').textContent, state: c.dataset.state, att: c.dataset.attention, pill: c.querySelector('.ember-ov-pill').textContent, keys: [...c.querySelectorAll('.ember-ov-key')].map((k) => k.textContent) })),
      todo: [...v.querySelectorAll('.ember-ov-todo-text')].map((t) => t.textContent),
      notes: [...v.querySelectorAll('.ember-ov-note-title')].map((t) => t.textContent),
      log: [...v.querySelectorAll('.ember-ov-log .ember-ov-log-line')].length,
      placeActive: document.querySelector('.ember-place.is-active')?.dataset.place ?? null,
      cardsInSidebar: [...document.querySelectorAll('.ember-card')].length,
    }
  })()`)
  console.log(JSON.stringify(page, null, 2))
  if (!page) fail('no overview on stage')
  check(page.placeActive === 'overview', 'the Overview button is lit')
  check(page.cardsInSidebar === 3, `the overview is not a card in the sidebar (cards: ${page.cardsInSidebar})`)
  check(page.cards.length === 3, 'a card per session')
  check(page.kpis.some((k) => k.startsWith('tokens=') && !k.includes('—')), 'tokens counted from the transcripts')
  check(page.kpis.some((k) => k.startsWith('changes=+')), 'changes counted from the edits')
  check(page.kpis.some((k) => k.startsWith('spend=$')), 'spend summed from the status lines')
  const picker = page.cards.find((c) => c.title === 'adr')
  check(picker?.att === 'question' && picker.keys.length >= 3, `the picker card has its keys: ${JSON.stringify(picker?.keys)}`)
  check(page.todo.length === 4, 'four open todo items in the rail')
  check(page.notes.length === 2, 'two notes in the rail')
  check(page.log > 0, 'the log has lines')
  await shot('overview')

  // Press "2" from the card: it must reach the session as a keystroke.
  await ev(`window.__ember.sessions()[1] && (window.__probeWrites = [])`)
  await ev(`(() => { const w = window.ember.write; window.ember.write = (id, d) => { window.__probeWrites.push(d); return w(id, d) } })()`).catch(() => {})
  const pressed = await ev(`(() => {
    const k = [...document.querySelectorAll('.ember-ov-card[data-attention="question"] .ember-ov-key')].find((b) => b.textContent.startsWith('2'))
    if (!k) return 'no key'
    k.click()
    return 'clicked'
  })()`)
  check(pressed === 'clicked', 'picker key clickable')

  // Open the working card up in place.
  await ev(`(() => { const c = [...document.querySelectorAll('.ember-ov-card')].find((c) => c.querySelector('.ember-ov-title').textContent === 'agentic harness'); c.querySelector('.ember-ov-expand').click() })()`)
  await sleep(700)
  const opened = await ev(`(() => { const c = document.querySelector('.ember-ov-card.is-open'); return c ? { full: !c.querySelector('.ember-ov-full').hidden, recent: c.querySelectorAll('.ember-ov-recent .ember-ov-log-line').length } : null })()`)
  check(!!opened && opened.full && opened.recent > 0, `an opened card shows the reply and its recent actions: ${JSON.stringify(opened)}`)
  await shot('overview-open')

  // Tick a todo from the rail.
  await ev(`document.querySelector('.ember-ov-todo-box').click()`)
  await sleep(900)
  const todoText = readFileSync(join(NOTES, 'Todo.md'), 'utf8')
  check(/- \[x\] Replace the ADR format/.test(todoText), 'ticking in the rail writes the file')

  // Todo from the sidebar, and back.
  await ev(`document.querySelector('.ember-place[data-place="todo"]').click()`)
  await sleep(1500)
  check((await ev(`document.querySelector('.ember-place.is-active')?.dataset.place ?? null`)) === 'todo', 'Todo button lit on the list')
  await shot('todo')
  await ev(`document.querySelector('.ember-place[data-place="notes"]').click()`)
  await sleep(1500)
  await shot('notes')
  check((await ev(`[...document.querySelectorAll('.ember-card')].length`)) === 3, 'places never become sidebar cards')
} catch (err) {
  fail(String(err?.stack ?? err))
} finally {
  console.log(checks.join('\n'))
  // The whole tree: killing electron's main process alone leaves its helpers holding the
  // debugging port, and the next run talks to the old instance.
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
