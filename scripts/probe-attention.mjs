/**
 * The sidebar: the tab you are on against tabs that want you, and why each wants you.
 *
 *   npm run build; LOOK=snowfall node scripts/probe-attention.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-attention-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-attention')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false }, look: process.env.LOOK || 'snowfall' }))
const PORT = Number(process.env.PROBE_PORT) || 9671
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

  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  const mk = async () => {
    const before = await ev('window.__ember.sessions().map((s) => s.id)')
    const tab = await ev('window.__ember.newLoom()')
    await wait(1500)
    const sid = await ev(`window.__ember.sessions().map((s) => s.id).find((id) => !${JSON.stringify(before)}.includes(id))`)
    return { tab, sid }
  }
  const tabs = { here: await mk(), perm: await mk(), ask: await mk(), done: await mk() }
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  const write = (sid, d) => ev(`new Promise((r) => window.__ember.term(${JSON.stringify(sid)}).write(${JSON.stringify(d)}, () => r(true)))`)
  const names = { here: 'Fix the login page', perm: 'Deploy the API', ask: 'Plan the release', done: 'Write the docs' }
  for (const [k, t] of Object.entries(tabs)) {
    await write(t.sid, `\x1b]0;✳ Claude Code\x07`)
    await ev(`window.__ember.loomTitle(${JSON.stringify(t.tab)}, ${JSON.stringify(names[k])}, "claude")`)
  }
  await wait(800)
  // Working first (the spinner), so the ends below are real ends.
  for (const k of ['perm', 'ask', 'done']) await write(tabs[k].sid, '\x1b[2J\x1b[H✻ Working… (3s · esc to interrupt)\r\n')
  await wait(1500)
  await write(tabs.perm.sid, '\x1b[2J\x1b[H Bash command\r\n   npm run deploy\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again for npm run deploy\r\n   3. No, and tell Claude what to do differently\r\n')
  await write(tabs.ask.sid, '\x1b[2J\x1b[H Which release channel should I use?\r\n ❯ 1. Stable\r\n   2. Beta\r\n   3. Type something.\r\n Enter to confirm · Esc to cancel\r\n')
  await write(tabs.done.sid, '\x1b[2J\x1b[H● Done: the docs are written.\r\n\r\n❯ \r\n')
  await ev(`window.__ember.activate(${JSON.stringify(tabs.here.tab)})`)
  await wait(2500)
  const cards = await ev(`[...document.querySelectorAll('.ember-card')].map((c) => ({ title: c.querySelector('.ember-card-title')?.textContent, need: c.dataset.need, status: c.querySelector('.ember-card-status')?.innerText.trim(), active: c.classList.contains('is-active') }))`)
  console.log(JSON.stringify(cards, null, 1))
  const order = ['Fix the login page', 'Deploy the API', 'Plan the release', 'Write the docs']
  const by = (t) => cards[order.indexOf(t)] ?? {}
  check('the tab you are on is just selected', by('Fix the login page').active && !by('Fix the login page').need)
  check('permission says so', by('Deploy the API').need === 'blocked' && /Needs your permission/.test(by('Deploy the API').status ?? ''))
  check('a question says so', by('Plan the release').need === 'blocked' && /Has a question for you/.test(by('Plan the release').status ?? ''))
  check('a finished turn says so', by('Write the docs').need === 'done' && /Finished, your turn/.test(by('Write the docs').status ?? ''))
  const pic = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 300, height: 420, scale: 2 } })
  writeFileSync(join(OUT, `sidebar-${process.env.LOOK || 'snowfall'}.png`), Buffer.from(pic.data, "base64"))
  await wait(15000)
  const later = await ev(`[...document.querySelectorAll('.ember-card')][3]?.dataset.need`)
  check('a finished tab you have not looked at stays finished (no 20s fade)', later === 'done', later)
  await ev(`window.__ember.activate(${JSON.stringify(tabs.done.tab)})`)
  await wait(1200)
  const seen = await ev(`[...document.querySelectorAll('.ember-card')][3]?.dataset.need`)
  check('once you look at it, it is just a tab again', !seen, seen)
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exitCode = failed ? 1 : 0
