import { join, basename } from 'node:path'
import { homedir } from 'node:os'
/**
 * The overview: every session on one screen, with what its Claude last said.
 *
 * Starts a test Ember, opens the overview with Ctrl+Shift+S over the first tab, and
 * checks a row appears for the shell. Then plays a Claude session: it binds a fake
 * session id to the tab over the bridge (what the panel MCP server does at startup),
 * writes a transcript file where Claude Code would, appends an assistant line to it,
 * and checks the row picks the sentence up. Finally types into the row's box and checks
 * the text reached the shell.
 *
 *   node scripts/probe-overview.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9357
const out = process.argv[2] ?? 'overview.png'

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME },
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('DevTools endpoint never came up')
}

class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', rej, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.#pending.get(msg.id)
      if (!p) return
      c.#pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    })
    return c
  }

  send(method, params = {}) {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.#pending.set(id, { res, rej }))
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.value
  }

  close() {
    this.#ws.close()
  }
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error(logs.join(''))
  child.kill()
  process.exit(1)
}

async function until(cdp, expression, ok, what, tries = 40) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

const ROWS = `(() => {
  const v = document.querySelector('.ember-overview')
  if (!v) return null
  return {
    count: v.querySelector('.ember-todo-count')?.textContent ?? '',
    orch: {
      dock: !!v.querySelector('.ember-overview-dock'),
      said: v.querySelector('.ember-overview-dock-text')?.textContent ?? '',
      quiet: v.querySelector('.ember-overview-dock-text')?.classList.contains('is-quiet') ?? true,
      inputs: v.querySelectorAll('.ember-overview-dock .ember-overview-input').length,
      history: !!v.querySelector('.ember-orch'),
      inSidebar: !!document.querySelector('.ember-sidebar .ember-orch'),
    },
    rows: Array.from(v.querySelectorAll('.ember-overview-card')).map((r) => ({
      tabId: r.dataset.tabId,
      state: r.dataset.state,
      kind: r.dataset.kind,
      mark: r.querySelector('.ember-overview-mark')?.hidden ? '' : (r.querySelector('.ember-overview-mark')?.textContent ?? ''),
      title: r.querySelector('.ember-overview-title')?.textContent ?? '',
      where: r.querySelector('.ember-overview-where')?.textContent ?? '',
      counts: r.querySelector('.ember-overview-state')?.textContent ?? '',
      under: r.querySelector('.ember-chip.is-under')?.hidden ? '' : (r.querySelector('.ember-chip.is-under')?.textContent ?? ''),
      said: r.querySelector('.ember-overview-text')?.textContent ?? '',
      quiet: r.querySelector('.ember-overview-text')?.classList.contains('is-quiet') ?? true,
      doing: r.querySelector('.ember-overview-doing')?.textContent ?? '',
      askHidden: r.querySelector('.ember-overview-ask')?.hidden ?? true,
    })),
  }
})()`

async function chord(cdp, code, key) {
  const mods = 2 | 8 // Ctrl | Shift
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mods, code, key, windowsVirtualKeyCode: key.charCodeAt(0) })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, code, key, windowsVirtualKeyCode: key.charCodeAt(0) })
}

try {
  const page = await target()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3000)

  const wire = await cdp.eval(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabId: document.querySelector('.ember-group')?.dataset.groupId ?? null,
    cwd: window.__ember.sessions()[0]?.cwd ?? '',
  }))()`)
  if (!wire.origin || !wire.tabId) fail(`no bridge or tab: ${JSON.stringify(wire)}`)
  const token = await readToken(cdp)
  if (!token) fail('the shell never reported EMBER_BRIDGE_TOKEN')

  // 1. Open the overview over a second tab: the tab it is looked from is not a row.
  await cdp.eval(`window.__ember.newTab()`)
  await sleep(1500)
  await chord(cdp, 'KeyS', 'S')
  await sleep(1200)
  if (process.env.PROBE_DEBUG) {
    console.log('markup:', await cdp.eval(`document.querySelector('.ember-overview')?.outerHTML.slice(0, 1600) ?? 'no .ember-overview'`))
  }
  const opened = await until(cdp, ROWS, (v) => v && v.rows.length === 1, 'the overview did not open with one row')
  console.log('opened:', JSON.stringify(opened))
  if (opened.rows[0].tabId !== wire.tabId) fail('the row is not the shell tab')
  console.log('orchestrator:', JSON.stringify(opened.orch))
  if (!opened.orch.dock || opened.orch.inputs !== 1) fail('the orchestrator dock with its line is missing')
  if (!opened.orch.quiet) fail('the dock claims the orchestrator said something before anything was asked')
  if (opened.orch.history) fail('the orchestrator conversation log is on the page; only its last reply belongs there')
  if (!opened.orch.inSidebar) fail('the sidebar lost its orchestrator card')
  if (!opened.rows[0].askHidden) fail('a plain shell row should have no input box')
  const kind = await cdp.eval(`window.__ember.sessions().length`)
  if (kind !== 2) fail(`expected the overview over the second shell, not a new session (${kind})`)
  if (opened.rows.some((r) => r.tabId !== wire.tabId)) fail('the tab showing the overview is listed as a card')

  // 2. Play a Claude session announcing itself, and a transcript growing.
  const cwd = wire.cwd || process.cwd()
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const sessionId = `probe-${Date.now()}`
  const dir = join(homedir(), '.claude', 'projects', slug)
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${sessionId}.jsonl`)
  writeFileSync(transcript, '', 'utf8')
  const bound = await fetch(`${wire.origin}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({ tabId: wire.tabId, sessionId, cwd }),
  })
  if (!bound.ok) fail(`bind failed: ${bound.status}`)
  await sleep(1500)

  const line = (content, stop) => `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content, stop_reason: stop } })}\n`
  appendFileSync(
    transcript,
    line(
      [
        { type: 'text', text: 'Looking at the panel code now. The grip needs a hook on release, so I am **adding one** to `Panel.ts` and wiring it through App.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/x/src/renderer/src/ui/Panel.ts' } },
      ],
      'tool_use'
    )
  )
  const spoke = await until(cdp, ROWS, (v) => v && !v.rows[0].quiet, 'the row never picked up the assistant sentence', 60)
  console.log('after transcript:', JSON.stringify(spoke.rows[0]))
  const said = spoke.rows[0].said
  if (!said.includes('adding one to Panel.ts')) fail(`sentence is "${said}"`)
  if (said.includes('**') || said.includes('`')) fail('markdown leaked into the sentence')

  // A finished turn drops the "doing" line.
  appendFileSync(transcript, line([{ type: 'text', text: 'Done: the grip saves the width on release.' }], 'end_turn'))
  const ended = await until(cdp, ROWS, (v) => v && v.rows[0].said.startsWith('Done:'), 'the end of the turn never showed', 60)
  console.log('after end_turn:', JSON.stringify(ended.rows[0]))
  if (ended.rows[0].doing) fail('the doing line is still showing after end_turn')

  // 3. Type into the session from the row. The shell is PowerShell; it writes a file.
  const marker = join(EMBER_HOME, 'from-overview.txt').replace(/\\/g, '/')
  rmSync(marker, { force: true })
  const askVisible = await cdp.eval(`!document.querySelector('.ember-overview-ask').hidden`)
  console.log('ask visible:', askVisible)
  await cdp.eval(`(() => {
    const i = document.querySelector('.ember-overview-input')
    i.focus()
    i.value = ${JSON.stringify(`"hello" | Set-Content -Encoding utf8 '${marker}'`)}
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)
  let landed = false
  for (let i = 0; i < 40 && !landed; i++) {
    await sleep(250)
    landed = existsSync(marker) && readFileSync(marker, 'utf8').includes('hello')
  }
  console.log('typed from the row reached the shell:', landed)
  if (!askVisible) fail('the input box is hidden on a Claude row')
  if (!landed) fail('typing into the row did not reach the shell')

  // 3b. The todo list and the notes are tabs too, and neither is a shell: their cards
  // must say what they hold rather than naming the PowerShell they were opened over.
  await cdp.eval(`(async () => {
    const id = await window.__ember.newTab()
    await window.__ember.activate(id)
    await window.__ember.openTodo()
  })()`)
  await sleep(1500)
  await cdp.eval(`window.__ember.openNotes()`)
  await sleep(1500)
  await cdp.eval(`window.__ember.activate(${JSON.stringify(await cdp.eval(`document.querySelector('.ember-overview')?.closest('.ember-group')?.dataset.groupId ?? null`))})`)
  await sleep(1200)

  const surfaces = await until(cdp, ROWS, (v) => v && v.rows.some((r) => r.kind === 'todo') && v.rows.some((r) => r.kind === 'notes'), 'the todo and notes tabs never got their own cards')
  const todoRow = surfaces.rows.find((r) => r.kind === 'todo')
  const noteRow = surfaces.rows.find((r) => r.kind === 'notes')
  console.log('todo card:', JSON.stringify(todoRow))
  console.log('notes card:', JSON.stringify(noteRow))
  if (todoRow.title !== 'Todo') fail(`the todo card is titled "${todoRow.title}"`)
  if (noteRow.title !== 'Notes') fail(`the notes card is titled "${noteRow.title}"`)
  if (todoRow.mark !== '✓' || noteRow.mark !== '✎') fail('a surface card is missing its mark')
  for (const r of [todoRow, noteRow]) {
    if (/powershell/i.test(r.title)) fail(`a surface card is named after its shell: "${r.title}"`)
    if (r.said.includes('Not a Claude session')) fail(`a surface card is describing itself as a session: "${r.said}"`)
    if (!r.said) fail('a surface card has nothing to say')
    if (!r.askHidden) fail('a surface with no Claude under it should have no input box')
  }
  if (!/open|done|empty/.test(todoRow.counts)) fail(`the todo card is not counting items: "${todoRow.counts}"`)
  if (!/note/.test(noteRow.counts)) fail(`the notes card is not counting notes: "${noteRow.counts}"`)
  if (!/over /.test(todoRow.under)) fail(`the todo card does not say what it is over: "${todoRow.under}"`)

  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot ->', out)

  // 4. Esc closes the page; the orchestrator goes back under the cards, closed as it was.
  await cdp.eval(`document.querySelector('.ember-overview').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 })
  const closed = await until(
    cdp,
    `({ overview: !!document.querySelector('.ember-overview'),
        inSidebar: !!document.querySelector('.ember-sidebar .ember-orch'),
        open: !!document.querySelector('.ember-sidebar .ember-orch.is-open') })`,
    (v) => !v.overview,
    'Esc did not close the overview'
  )
  console.log('after Esc:', JSON.stringify(closed))
  if (!closed.inSidebar) fail('the orchestrator did not return to the sidebar')
  if (closed.open) fail('the orchestrator stayed open in the sidebar though it was closed before')

  rmSync(transcript, { force: true })
  cdp.close()
  child.kill()
  console.log('OVERVIEW OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}

async function readToken(cdp) {
  const file = join(EMBER_HOME, 'token.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const token = readFileSync(file, 'utf8').trim()
    if (token) return token
  }
  return null
}
