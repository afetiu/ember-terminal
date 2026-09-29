/**
 * The `notes` command, exercised from inside a real Ember shell.
 *
 * The claim being checked is not that notes-cli.mjs works when node runs it — that is a
 * unit test — but that a shell Ember opens can *find* it: that ~/.ember/bin is on PATH in
 * PowerShell, that `note …` opens a tab with the words on it, and that Git Bash (the shell
 * Claude Code runs commands in) resolves the extensionless launcher too.
 *
 *   node scripts/probe-notes-cli.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9383
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
for (const f of readdirSync(NOTES)) if (f.endsWith('.md')) writeFileSync(join(NOTES, f), '')
writeFileSync(join(NOTES, 'Probe seed.md'), 'Probe seed\n\nplanted by probe-notes-cli\n')

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
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
// The page exists before the app has booted; wait for the diagnostics hook to appear.
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

/** Type a line into the shell and wait until the prompt is back under its output. */
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
      // Quiet with the prompt showing means the command is done. The echo of the command
      // itself also goes quiet, so the prompt glyph is what tells the two apart.
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

try {
  const first = await waitForPrompt()
  const sid = first.id
  const home = await ev(`window.__ember.activeTab()`)

  // 1. PowerShell resolves the launcher from PATH and lists the seeded note.
  const listed = await run(sid, 'notes list')
  check('pwsh: `notes list` reaches the command', /Probe seed/.test(listed), listed.split('\n').filter(Boolean).slice(-3).join(' | '))

  // 2. `note <words>` opens a tab holding a new note with those words.
  await run(sid, 'note the probe was here')
  await sleep(800)
  const groups = await ev(`window.__ember.groups()`)
  const active = await ev(`window.__ember.activeTab()`)
  // The note opens over the shell in the same tab now, not in a tab of its own.
  const noteTab = (await ev(`!!document.querySelector('.ember-group.is-active .ember-group-panes.has-note .ember-notes')`)) ? groups.find((g) => g.id === active) : null
  // The newest match: earlier runs leave emptied files of the same name behind.
  const file = readdirSync(NOTES)
    .filter((f) => /the probe was here/i.test(f))
    .sort((a, b) => statSync(join(NOTES, b)).mtimeMs - statSync(join(NOTES, a)).mtimeMs)[0]
  check('pwsh: `note …` creates the note file', !!file, file ?? readdirSync(NOTES).join(', '))
  check('pwsh: `note …` opens it over the same tab', !!noteTab && active === home, `active ${active}, shell ${home}, ${groups.length} tabs`)
  const body = file ? readFileSync(join(NOTES, file), 'utf8') : ''
  check('the note holds the words', /the probe was here/.test(body), JSON.stringify(body))

  // 3. Git Bash resolves the extensionless launcher (what Claude Code's Bash tool sees).
  await ev(`window.__ember.activate(${JSON.stringify(groups.find((g) => g.panes.includes(sid))?.id ?? active)})`)
  await sleep(600)
  const viaBash = await run(sid, `bash -lc "notes list && notes read 'Probe seed' | head -1"`)
  check('git bash: `notes` resolves and reads', /planted|Probe seed/.test(viaBash), viaBash.split('\n').filter(Boolean).slice(-3).join(' | '))

  // 4. A write from the shell reaches an open list without a refresh (the folder watch).
  await ev(`window.__ember.openNotes()`)
  await sleep(800)
  await ev(`window.__ember.activate(${JSON.stringify(groups.find((g) => g.panes.includes(sid))?.id ?? active)})`)
  await sleep(400)
  await run(sid, 'notes new "Written from the shell"')
  await sleep(900)
  const rows = await ev(`[...document.querySelectorAll('.ember-notes-title')].map((e) => e.textContent)`)
  check('folder watch: the list shows a note the shell just wrote', rows.includes('Written from the shell'), rows.join(', '))

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
  // Not process.exit: with stdout redirected to a file it is a pipe, writes to it are
  // asynchronous, and exiting here threw away every line this script had printed.
  process.exitCode = failures ? 1 : 0
}
