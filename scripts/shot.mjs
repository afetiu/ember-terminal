/**
 * Screenshots of the chrome, for looking at the design without launching by hand.
 *
 *   node scripts/shot.mjs [outdir]
 *
 * Launches an isolated Ember (its own EMBER_HOME, the user's config copied in), opens
 * the surfaces worth seeing — a shell, a notes tab with the list and a note, the
 * orchestrator column — and captures each through the DevTools protocol. Captures are of
 * the page only: the acrylic behind a transparent window is not composited by Chromium,
 * so the backdrop reads as black here even though it is glass on the desk.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-shots')
mkdirSync(OUT, { recursive: true })
const PORT = 9371
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
writeFileSync(join(NOTES, 'Release checklist.md'), '# Release checklist\n\n- bump version\n- pnpm dist\n- gh release upload\n')
writeFileSync(join(NOTES, 'Ideas.md'), 'Ideas\n\nA notes command instead of an MCP tool. Park background tabs.\n')
writeFileSync(
  join(NOTES, 'Todo.md'),
  '# Todo\n\n- [ ] Reply to Alex about the mockups [Mail](https://mail.google.com/mail/#all/18f2c3a9b1)\n- [ ] Resolve the merge conflicts in radix-platform#551 (EN-19669 Intelligence scatter plot and map), rebase onto #550, make the four conflicting files agree on the module union, and push so CI runs again before the v0.31.0 release\n- [x] Sign the installer\n- [ ] Move the orchestrator under the list [GitHub](https://github.com/afetiu/ember/issues/12)\n- [ ] Answer Noah on DE-862 [Jira](https://org.atlassian.net/browse/DE-862)\n- [ ] Send Kabashi the sizes [Slack](https://kabashi.slack.com/archives/C0123/p1693820000)\n\nLater\n- [ ] Slack and mail triage routine\n',
)

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES, EMBER_PROBE_INACTIVE: '1' },
})

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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`wrote ${file}`)
}

await send('Runtime.enable')
await send('Page.enable')
await sleep(1500)
await ev(`window.ember.window.toggleMaximize()`)
await sleep(6000)

await shot('01-shell')
await ev(`window.__ember.newTab()`)
await sleep(2500)
await ev(`window.__ember.openNotes()`)
await sleep(1500)
await shot('02-notes-list')
await ev(`window.__ember.openNotes('Release checklist.md')`)
await sleep(1200)
await shot('03-note')
await ev(`window.__ember.newTab()`)
await sleep(2500)
await ev(`window.__ember.openTodo()`)
await sleep(1200)
await shot('07-todo')
try {
  await ev(`window.__ember.orchestrator()`)
} catch (err) {
  console.log(`orchestrator toggle threw: ${err.message}`)
}
await sleep(1200)
console.log(
  'orchestrator state:',
  JSON.stringify(
    await ev(`(() => { const o = document.querySelector('.ember-orch'); const sb = document.querySelector('.ember-sidebar'); const cs = getComputedStyle(o); return { open: o.classList.contains('is-open'), display: cs.display, opacity: cs.opacity, h: o.offsetHeight, w: o.offsetWidth, parent: o.parentElement.className, sidebar: sb.className, col: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), cards: document.querySelector('.ember-cards').offsetHeight } })()`),
  ),
)
await shot('04-orchestrator')
await ev(`window.__ember.openPalette('')`)
await sleep(600)
await shot('05-palette')
await ev(`window.__ember.openPalette('s')`)
await sleep(500)
await shot('05b-palette-s')
await ev(`window.__ember.openPalette('o run the tests in tab 2')`)
await sleep(500)
await shot('05c-palette-orch')
await ev(`window.__ember.openSettings()`)
await sleep(800)
await shot('06-settings')
await ev(`document.querySelector('.ember-settings-tab[data-tab="Todo"]').click()`)
await sleep(400)
await shot('08-settings-todo')
await ev(`window.__ember.openSettings()`)
await sleep(400)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(300)
await ev(`(() => { for (const g of window.__ember.groups()) window.__ember.closeTab(g.id) })()`)
await sleep(1200)
await shot('09-empty')

ws.close()
child.kill()
