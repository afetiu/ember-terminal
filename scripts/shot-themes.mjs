/**
 * The same surfaces under one theme, for checking that light palettes look as deliberate
 * as dark ones.
 *
 *   node scripts/shot-themes.mjs "One Light" [outdir]
 *
 * Like shot.mjs, but with its own port and EMBER_HOME so it can run beside the user's
 * Ember and beside the other probes, and with the theme forced from src/main/themes.ts.
 * The map needs a surveyed project; a small made-up one is written into the probe's home,
 * so the map's every state — status, notes, flows, a change — has something to draw.
 *
 *   ONBOARD=1  start with the welcome sheet and shoot its first three steps
 *   NOEMU=1    keep the window's own size and pixel ratio. The fixed 1600x960 viewport
 *              is easier to compare, but it shrinks the terminal's WebGL grid, and thin
 *              dark text on a light theme then looks far fainter than it is on screen.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const THEME = process.argv[2] ?? 'One Light'
const slug = THEME.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const OUT = process.argv[3] ?? join(process.env.TEMP ?? '.', 'ember-theme-shots', slug)
mkdirSync(OUT, { recursive: true })
const PORT = 9471
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-shot-themes`)
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })

// The palette, read out of the source rather than copied, so the probe follows edits.
// The house pair is named through constants (`name: HOUSE_NIGHT`); inline them first.
let src = readFileSync(new URL('../src/main/themes.ts', import.meta.url), 'utf8')
for (const [, k, v] of src.matchAll(/export const (\w+) = ('[^']+')/g)) src = src.replaceAll(`name: ${k},`, `name: ${v},`)
const at = src.indexOf(`name: '${THEME}'`)
if (at < 0) throw new Error(`no theme named ${THEME}`)
const open = src.lastIndexOf('{', at)
const close = src.indexOf('}', at)
const theme = new Function(`return ${src.slice(open, close + 1)}`)()

const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
writeFileSync(join(NOTES, 'Release checklist.md'), '# Release checklist\n\n- bump version\n- pnpm dist\n- gh release upload\n\n> Sign **before** uploading. See `docs/release.md` and [the runbook](https://example.com).\n\n```\npnpm dist\n```\n')
writeFileSync(join(NOTES, 'Ideas.md'), 'Ideas\n\nA notes command instead of an MCP tool. Park background tabs.\n')
writeFileSync(
  join(NOTES, 'Todo.md'),
  '# Todo\n\n- [ ] Reply to Alex about the mockups [Mail](https://mail.google.com/mail/#all/18f2c3a9b1)\n- [ ] Resolve the merge conflicts in radix-platform#551, rebase onto #550 and push so CI runs again before the v0.31.0 release\n- [x] Sign the installer\n- [ ] Move the orchestrator under the list [GitHub](https://github.com/afetiu/ember/issues/12)\n- [ ] Answer Noah on DE-862 [Jira](https://org.atlassian.net/browse/DE-862)\n- [ ] Send Kabashi the sizes [Slack](https://kabashi.slack.com/archives/C0123/p1693820000)\n\nLater\n- [ ] Slack and mail triage routine\n',
)

// A small surveyed project for the map.
const MAP = join(EMBER_HOME, 'maps', 'shop')
mkdirSync(MAP, { recursive: true })
const now = new Date().toISOString()
const node = (id, name, kind, parent, summary, extra = {}) => ({ id, name, kind, ...(parent ? { parent } : {}), summary, ...extra })
writeFileSync(join(MAP, 'project.json'), JSON.stringify({ id: 'shop', name: 'Shop', brief: 'The shop and its hosting', pollMinutes: 0, createdAt: now }))
writeFileSync(
  join(MAP, 'model.json'),
  JSON.stringify({
    version: 3,
    updatedAt: now,
    overview: 'A storefront, its API and the jobs around them.',
    watches: [],
    nodes: [
      node('web', 'Web', 'group', null, 'What the buyer sees'),
      node('site', 'Storefront', 'app', 'web', 'Next.js storefront', { tech: ['Next.js', 'React'], status: 'ok', deploy: 'Cloudflare Pages', notes: [{ type: 'pr', text: 'Checkout redesign #41' }] }),
      node('admin', 'Admin', 'app', 'web', 'Back office for orders', { status: 'warn', statusNote: 'Build is slow', tech: ['Vite'] }),
      node('cloud', 'Heroku', 'group', null, 'Where the API runs'),
      node('api', 'API server', 'service', 'cloud', 'Express API for carts and orders', { tech: ['Node', 'Express'], status: 'ok', deploy: 'Heroku shop-api', notes: [{ type: 'risk', text: 'No rate limiting on /login' }, { type: 'todo', text: 'Move sessions to Redis' }] }),
      node('worker', 'Mail worker', 'job', 'cloud', 'Sends receipts', { status: 'down', statusNote: 'Crashed at 09:12' }),
      node('db', 'Postgres', 'datastore', 'cloud', 'Orders, users', { status: 'ok' }),
      node('queue', 'Jobs queue', 'queue', 'cloud', 'Bull on Redis', { status: 'unknown' }),
      node('stripe', 'Stripe', 'external', null, 'Payments', { status: 'ok' }),
      node('docs', 'Runbook', 'doc', null, 'How to deploy'),
    ],
    edges: [
      { id: 'e1', from: 'site', to: 'api', label: 'REST', protocol: 'HTTPS' },
      { id: 'e2', from: 'admin', to: 'api', label: 'REST', protocol: 'HTTPS' },
      { id: 'e3', from: 'api', to: 'db', label: 'SQL' },
      { id: 'e4', from: 'api', to: 'queue', label: 'enqueue' },
      { id: 'e5', from: 'queue', to: 'worker', label: 'jobs' },
      { id: 'e6', from: 'api', to: 'stripe', label: 'charges', protocol: 'HTTPS' },
    ],
    flows: [{ id: 'f1', name: 'Buyer checks out', summary: 'Cart to receipt', steps: [{ node: 'site', text: 'Cart' }, { node: 'api', text: 'Order' }, { node: 'stripe', text: 'Charge' }, { node: 'queue' }, { node: 'worker', text: 'Receipt' }] }],
  }),
)
writeFileSync(
  join(MAP, 'changes.json'),
  JSON.stringify([
    { id: 'c1', at: new Date(Date.now() - 86400e3).toISOString(), kind: 'build', trigger: ['by hand'], summary: 'First survey.', items: [], touched: [], version: 1 },
    { id: 'c2', at: now, kind: 'update', trigger: ['git'], summary: 'The mail worker was added.', items: [{ node: 'worker', text: 'New mail worker', impact: 'notable' }], touched: ['worker', 'queue'], version: 3, added: ['worker'] },
  ]),
)
writeFileSync(join(MAP, 'state.json'), JSON.stringify({ fingerprints: {}, watchErrors: {} }))

const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
cfg.theme = theme
cfg.agent = { ...(cfg.agent ?? {}), onboarded: process.env.ONBOARD ? false : true }
cfg.labs = { enabled: true }
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
const logs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
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
const key = async (k, code, mods = 0, vk = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk })
}
const esc = () => key('Escape', 'Escape', 0, 27)
const step = async (name, fn) => {
  try {
    await fn()
  } catch (err) {
    console.log(`${name} failed: ${err.message}`)
  }
}

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1500)
  if (!process.env.NOEMU) await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false })
  await sleep(2500)
  console.log('is-light', await ev(`document.body.classList.contains('is-light')`))

  if (process.env.ONBOARD) {
    await step('onboarding', async () => {
      await shot('00-onboarding')
      await ev(`document.querySelector('.ember-onboard-btn.is-primary').click()`)
      await sleep(500)
      await shot('00b-onboarding-agent')
      await ev(`document.querySelector('.ember-onboard-btn.is-primary').click()`)
      await sleep(500)
      await shot('00c-onboarding-look')
      await ev(`document.querySelector('.ember-onboard-btn.is-quiet').click()`)
      await sleep(500)
    })
  }

  await sleep(2500)
  // Something with colour in it, so the terminal's palette shows beside the chrome.
  await ev(`window.__ember.type('Write-Host ok -ForegroundColor Green; Write-Host warn -ForegroundColor Yellow; Write-Host err -ForegroundColor Red; Get-ChildItem\\r')`)
  await sleep(2500)
  await shot('01-shell')
  await step('notes', async () => {
    await ev(`window.__ember.newTab()`)
    await sleep(2000)
    await ev(`window.__ember.openNotes()`)
    await sleep(1500)
    await shot('02-notes-list')
    await ev(`window.__ember.openNotes('Release checklist.md')`)
    await sleep(1200)
    await shot('03-note')
    await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'List' && b.offsetParent)?.click()`)
    await sleep(700)
    await shot('03b-note-as-list')
  })
  await step('todo', async () => {
    await ev(`window.__ember.newTab()`)
    await sleep(2000)
    await ev(`window.__ember.openTodo()`)
    await sleep(1200)
    await shot('04-todo')
  })
  await step('panel', async () => {
    await ev(`window.__ember.pushPanel('Plan', '# Plan\\n\\n- [x] audit\\n- [ ] fix\\n\\n> a quote\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n\`\`\`ts\\nconst x = 1\\n\`\`\`')`)
    await sleep(1500)
    await shot('05-panel')
  })
  await step('orchestrator', async () => {
    await ev(`window.__ember.orchestrator()`)
    await sleep(1200)
    await shot('06-orchestrator')
    await ev(`window.__ember.orchestrator()`)
    await sleep(600)
  })
  await step('palette', async () => {
    await ev(`window.__ember.openPalette('')`)
    await sleep(600)
    await shot('07-palette')
    await ev(`window.__ember.openPalette('!')`)
    await sleep(800)
    await shot('07b-palette-tasks')
    await esc()
    await sleep(300)
  })
  await step('settings', async () => {
    await ev(`window.__ember.openSettings()`)
    await sleep(800)
    await shot('08-settings')
    await ev(`document.querySelector('.ember-settings-tab[data-tab="Todo"]')?.click()`)
    await sleep(400)
    await shot('08b-settings-todo')
    await ev(`document.querySelector('.ember-settings-tab[data-tab="Agent"]')?.click()`)
    await sleep(400)
    await shot('08c-settings-agent')
    await esc()
    await sleep(300)
  })
  await step('cheatsheet', async () => {
    await ev(`window.__ember.toggleCheatsheet()`)
    await sleep(600)
    await shot('09-cheatsheet')
    await ev(`window.__ember.toggleCheatsheet()`)
    await sleep(300)
  })
  await step('search', async () => {
    await ev(`window.__ember.activate(window.__ember.groups()[0].id)`)
    await sleep(600)
    await ev(`window.__ember.openSearch()`)
    await sleep(500)
    await shot('11-search')
    await esc()
    await sleep(300)
  })
  await step('map', async () => {
    await key('G', 'KeyG', 2 | 8, 71)
    await sleep(1200)
    await shot('10-map-list')
    await ev(`document.querySelector('.ember-map-row').click()`)
    await sleep(2800)
    await shot('10b-map')
    await ev(`(() => { const all = [...document.querySelectorAll('.mnode:not(.is-hidden)')].filter(x => x.querySelector('.mnode-body')); const n = all.find(x => /API server/.test(x.innerText)) ?? all.find(x => x.classList.contains('is-leaf')) ?? all[0]; const b = n.querySelector('.mnode-body'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 })) })()`)
    await sleep(800)
    await shot('10c-map-card')
    await esc()
    await sleep(300)
    await key('l', 'KeyL', 0, 76)
    await ev(`document.querySelectorAll('.mhud-tr .mbtn')[1]?.click()`)
    await sleep(700)
    await shot('10d-map-legend-timeline')
    await key('l', 'KeyL', 0, 76)
    await ev(`document.querySelectorAll('.mhud-tr .mbtn')[1]?.click()`)
    await sleep(300)
    await ev(`document.querySelectorAll('.mhud-tr .mbtn')[0].click()`)
    await sleep(400)
    await ev(`[...document.querySelectorAll('.mmenu-item')][0].click()`)
    await sleep(3000)
    await shot('10e-map-flow')
    await esc()
    await sleep(300)
  })
  console.log('errors', logs.length ? logs.join('\n') : 'none')
} finally {
  ws.close()
  // By the PID this script spawned, tree and all: Electron's helpers outlive a plain kill,
  // and the next run would then attach to this window instead of its own.
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
process.exit(0)
