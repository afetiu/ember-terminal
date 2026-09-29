import { join, basename } from 'node:path'
/**
 * Clear done → archive, and back.
 *
 * Starts a test Ember on a temp notes folder whose todo list has one open and two ticked
 * items, opens the Todo surface, and checks: the Clear done button is there only while
 * something is ticked; pressing it moves the ticked items into `Todo.archive.md` under
 * today's date and leaves the open one; the footer says `archive · 2` and opens to show
 * them; ↩ on one puts it back on the list, open. Also that the panel bar no longer has
 * the ↑/↓ buttons.
 *
 *   node scripts/probe-todo-archive.mjs [outfile.png]
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
const NOTES = join(EMBER_HOME, 'notes')
rmSync(NOTES, { recursive: true, force: true })
mkdirSync(NOTES, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))
writeFileSync(join(NOTES, 'Todo.md'), '- [ ] open one\n- [x] done one\n- [x] done two\n', 'utf8')

const PORT = 9355
const out = process.argv[2] ?? 'todo-archive.png'

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES },
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

const TODO = `(() => {
  const t = document.querySelector('.ember-todo')
  if (!t) return null
  const q = (s) => t.querySelector(s)
  const foot = q('.ember-todo-foot')
  return {
    count: q('.ember-todo-count')?.textContent ?? '',
    clearVisible: !!q('.ember-todo-clear') && !q('.ember-todo-clear').hidden,
    footVisible: !!foot && !foot.hidden,
    toggle: q('.ember-todo-archive-toggle')?.textContent ?? '',
    archiveOpen: !!q('.ember-todo-archive') && !q('.ember-todo-archive').hidden,
    archived: Array.from(t.querySelectorAll('.ember-todo-archive-item > span')).map((s) => s.textContent),
    days: Array.from(t.querySelectorAll('.ember-todo-archive-day')).map((s) => s.textContent),
  }
})()`

try {
  const page = await target()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3000)

  // The panel bar: no ↑/↓ any more.
  const bar = await cdp.eval(`Array.from(document.querySelectorAll('.ember-panel-bar .ember-panel-btn')).map((b) => b.className.replace('ember-panel-btn ', ''))`)
  console.log('panel bar buttons:', JSON.stringify(bar))
  if (bar.some((c) => /is-prev|is-next/.test(c))) fail('the panel bar still has previous/next buttons')

  // Open the todo surface the way the shortcut does.
  const token = await readToken(cdp)
  if (!token) fail('the shell never reported EMBER_BRIDGE_TOKEN')
  const origin = await cdp.eval(`window.ember.panel.origin()`)
  const opened = await fetch(`${origin}/notes/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({ mode: 'todo' }),
  })
  if (!opened.ok) fail(`could not open the todo list: ${opened.status}`)

  const before = await until(cdp, TODO, (v) => v && v.count.includes('open'), 'the todo surface never opened')
  console.log('before:', JSON.stringify(before))
  if (!before.clearVisible) fail('Clear done is hidden while two items are ticked')
  if (before.footVisible) fail('the archive footer is showing with nothing archived')

  await cdp.eval(`document.querySelector('.ember-todo-clear').click()`)
  const cleared = await until(cdp, TODO, (v) => v.footVisible && v.toggle.includes('2'), 'clearing did not archive two items')
  console.log('cleared:', JSON.stringify(cleared))
  if (cleared.clearVisible) fail('Clear done still showing with nothing ticked')
  if (!/^1 open$/.test(cleared.count)) fail(`count reads "${cleared.count}", expected "1 open"`)
  await sleep(600)
  const list = readFileSync(join(NOTES, 'Todo.md'), 'utf8')
  const archive = readFileSync(join(NOTES, 'Todo.archive.md'), 'utf8')
  console.log('Todo.md:', JSON.stringify(list), 'archive:', JSON.stringify(archive))
  if (list.trim() !== '- [ ] open one') fail('Todo.md is not just the open item')
  const today = new Date().toISOString().slice(0, 10)
  if (!archive.startsWith(`## ${today}\n- [x] done one\n- [x] done two`)) fail('the archive is not dated today with both items')

  // Open the archive, bring one back.
  await cdp.eval(`document.querySelector('.ember-todo-archive-toggle').click()`)
  const open = await until(cdp, TODO, (v) => v.archiveOpen && v.archived.length === 2, 'the archive did not open with two items')
  console.log('archive open:', JSON.stringify(open))
  if (open.days[0] !== 'today') fail(`day label is "${open.days[0]}", expected "today"`)

  await cdp.eval(`document.querySelectorAll('.ember-todo-archive-back')[1].click()`)
  const restored = await until(cdp, TODO, (v) => v.archived.length === 1 && /^2 open$/.test(v.count), 'restoring did not put the item back')
  console.log('restored:', JSON.stringify(restored))
  await sleep(600)
  const list2 = readFileSync(join(NOTES, 'Todo.md'), 'utf8')
  const archive2 = readFileSync(join(NOTES, 'Todo.archive.md'), 'utf8')
  if (!list2.includes('- [ ] done two')) fail(`Todo.md after restore: ${JSON.stringify(list2)}`)
  if (archive2.includes('done two') || !archive2.includes('done one')) fail(`archive after restore: ${JSON.stringify(archive2)}`)

  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot ->', out)

  cdp.close()
  child.kill()
  console.log('TODO ARCHIVE OK')
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
