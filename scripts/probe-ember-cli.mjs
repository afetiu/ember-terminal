/**
 * The `ember` command, exercised from inside a real Ember shell.
 *
 * What is checked: that the launcher is on PATH in an Ember shell, that words typed
 * there reach the renderer's command table over the bridge and act on the tab that typed
 * them, that a row's printed result comes back to the shell, that an unknown command
 * fails with the help, and that `ember set` edits the config the app is running on.
 *
 *   node scripts/probe-ember-cli.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9384
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
cfg.window = { ...(cfg.window ?? {}), opacity: 77 }
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES, EMBER_PROBE_INACTIVE: '1' },
})

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

async function findPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('realtime'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error('no devtools target')
}

const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
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
    pending.set(++seq, res)
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result?.result?.value
}
await send('Runtime.enable')
for (let i = 0; i < 100; i++) {
  if (await ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}

async function waitForPrompt(id) {
  let last = -1
  let quietSince = 0
  for (let i = 0; i < 300; i++) {
    const s = (await ev(`window.__ember.sessions()`)).find((x) => (id ? x.id === id : true))
    if (s && s.bytesIn > 0) {
      const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
      const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
      if (s.bytesIn === last) {
        if (!quietSince) quietSince = Date.now()
        if (Date.now() - quietSince > (prompt ? 1200 : 9000)) return s
      } else {
        quietSince = 0
        last = s.bytesIn
      }
    }
    await sleep(150)
  }
  throw new Error('shell never settled')
}

/** Type a line into a shell and wait until the prompt is back under its output. */
async function run(sid, line) {
  const before = (await ev(`window.__ember.sessions()`)).find((s) => s.id === sid).bytesIn
  await ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(line + '\r')})`)
  const t0 = Date.now()
  let last = before
  let quiet = 0
  for (let i = 0; i < 400; i++) {
    await sleep(150)
    const s = (await ev(`window.__ember.sessions()`)).find((x) => x.id === sid)
    const lastLine = String(s.text ?? '').split('\n').filter((l) => l.trim()).at(-1) ?? ''
    const prompt = /[>❯▸$#»]\s*$/.test(lastLine)
    if (s.bytesIn === last) {
      quiet++
      if (quiet >= 4 && s.bytesIn > before && prompt) {
        console.log(`   (${line.split(' ').slice(0, 2).join(' ')} took ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
        return s.text
      }
    } else {
      quiet = 0
      last = s.bytesIn
    }
  }
  return (await ev(`window.__ember.sessions()`)).find((x) => x.id === sid).text
}

const tail = (text, n = 4) => text.split('\n').filter((l) => l.trim()).slice(-n).join(' | ')

try {
  const first = await waitForPrompt()
  const sid = first.id
  const home = await ev(`window.__ember.activeTab()`)
  // A first line typed into a shell that is still loading its profile loses characters;
  // one throwaway command absorbs that so the checks measure the launcher, not PSReadLine.
  await run(sid, 'echo warm')

  // 1. The launcher is on PATH and the help comes from the app's table.
  const help = await run(sid, 'ember')
  check('pwsh: `ember` prints the table', /ember set <path>/.test(help) && /commands of their own/.test(help), tail(help, 3))

  // 2. A row that prints: the tab list, with this tab marked.
  const list = await run(sid, 'ember list')
  check('`ember list` names the tabs', /\*\s+1\./.test(list), tail(list, 2))

  // 3. A row with an argument acts on the tab that typed it.
  await run(sid, 'ember rename probe-tab')
  await sleep(400)
  const title = (await ev(`window.__ember.groups()`)).find((g) => g.id === home)?.title ?? (await ev(`document.querySelector('.ember-card.is-active .ember-card-title')?.textContent`))
  const cards = await ev(`[...document.querySelectorAll('.ember-card')].map((c) => c.textContent)`)
  check('`ember rename` names this tab', cards.some((c) => /probe-tab/.test(c)) || /probe-tab/.test(String(title)), cards.join(' / '))

  // 4. Two words match the longer row: split right adds a pane to this tab.
  await run(sid, 'ember split right')
  await sleep(1200)
  const panes = (await ev(`window.__ember.groups()`)).find((g) => g.id === home)?.panes.length
  check('`ember split right` splits this tab', panes === 2, `${panes} panes`)

  // 5. Unknown words fail, with the help, and a non-zero exit.
  const bad = await run(sid, 'ember frobnicate; echo "exit=$LASTEXITCODE"')
  check('an unknown command fails with the help', /unknown command/.test(bad) && /exit=1/.test(bad), tail(bad, 2))

  // 6. `ember set` writes the config the running app watches.
  await run(sid, 'ember set window.opacity 61')
  await sleep(900)
  const saved = JSON.parse(readFileSync(join(EMBER_HOME, 'config.json'), 'utf8')).window.opacity
  const live = await ev(`window.__ember.config?.() ? window.__ember.config().window.opacity : null`).catch(() => null)
  check('`ember set` edits config.json', saved === 61, `file says ${saved}${live !== null ? `, app says ${live}` : ''}`)

  // 7. Git Bash resolves the extensionless launcher (Claude Code's shell).
  const viaBash = await run(sid, `bash -lc "ember list"`)
  check('git bash: `ember` resolves', /1\./.test(viaBash), tail(viaBash, 2))

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
} finally {
  try {
    for (const s of await ev(`window.__ember.sessions()`)) await ev(`window.ember.write(${JSON.stringify(s.id)}, "\\u0003exit\\r")`)
    await sleep(500)
  } catch {
    /* gone */
  }
  child.kill()
  ws.close()
  process.exitCode = failures ? 1 : 0
}
