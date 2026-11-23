/**
 * Slack: four simulated messages routed by the real small model; chat never shows, the rest share one card; the setup sheet.
 *
 *   npm run build; LOOK=snowfall node scripts/probe-slack.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-slack-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-slack')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false }, look: process.env.LOOK || 'snowfall' }))
const PORT = Number(process.env.PROBE_PORT) || 9673
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: join(EMBER_HOME, 'notes'), EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
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
  const tabs = { uat: await mk(), docs: await mk() }
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.loomTitle(${JSON.stringify(tabs.uat.tab)}, 'Radix UAT deploy', 'claude')`)
  await ev(`window.__ember.loomTitle(${JSON.stringify(tabs.docs.tab)}, 'Write the docs', 'claude')`)
  await ev(`window.__ember.loomStory(${JSON.stringify(tabs.uat.tab)}, { goal: 'UAT cluster upgrade', header: 'Upgrading the UAT cluster to the new ingress; rollout half done.', entries: [] })`)
  await wait(500)
  const now = Date.now()
  const m1 = { id: 'C1:1', channel: 'C1', channelName: 'radix-uat', dm: false, user: 'U1', userName: 'Noah', text: '@you the ingress on uat is returning 502s since the rollout started, can you take a look?', ts: '1', threadTs: '1', permalink: 'https://example.slack.com/archives/C1/p1', at: now - 60_000 }
  const m2 = { id: 'D1:2', channel: 'D1', channelName: '', dm: true, user: 'U2', userName: 'Mira', text: 'thanks for yesterday!', ts: '2', threadTs: '2', permalink: '', at: now }
  await ev(`window.__ember.slackMessage(${JSON.stringify(m1)})`)
  await ev(`window.__ember.slackMessage(${JSON.stringify(m2)})`)
  const cards = () => ev(`[...document.querySelectorAll('.ember-slack-card')].map((c) => ({ who: c.querySelector('.ember-slack-who')?.textContent, why: c.querySelector('.ember-slack-why')?.textContent, acts: [...c.querySelectorAll('.ember-slack-act')].map((b) => (b.classList.contains('is-primary') ? '*' : '') + b.textContent) }))`)
  const m3 = { id: 'C2:3', channel: 'C2', channelName: 'design', dm: false, user: 'U3', userName: 'Nora', text: '@you we decided: the onboarding goes with the dark theme, final. Specs in the Figma file.', ts: '3', threadTs: '3', permalink: '', at: now + 1000 }
  const m4 = { id: 'D2:4', channel: 'D2', channelName: '', dm: true, user: 'U4', userName: 'Kai', text: 'haha did you see the game last night', ts: '4', threadTs: '4', permalink: '', at: now + 2000 }
  await ev(`window.__ember.slackMessage(${JSON.stringify(m3)})`)
  await ev(`window.__ember.slackMessage(${JSON.stringify(m4)})`)
  // Routing is on the side: wait until nothing is still being read.
  for (let i = 0; i < 90; i++) {
    await wait(1000)
    const count = await ev(`document.querySelector('.ember-slack-count')?.textContent ?? (document.querySelector('.ember-slack-card') ? '1/1' : '0')`)
    if (count === '2/2' && i > 20) break
  }
  await wait(8000)
  let c = await cards()
  const count = await ev(`document.querySelector('.ember-slack-count')?.textContent ?? ''`)
  console.log(JSON.stringify({ c, count }, null, 1))
  check('one card on screen, never a stack', c.length === 1, JSON.stringify(c))
  check('chat (thanks, the game) never shows: two of four are waiting', count === '2/2', count)
  check('the newest worth showing has the card: the decision, as a note', c[0]?.who?.startsWith('Nora') && c[0].acts[0] === '*Note', JSON.stringify(c))
  await shot('slack-card')
  await ev(`document.querySelector('.ember-slack-nav').click()`)
  await wait(300)
  c = await cards()
  check('‹ steps back to the UAT message, suggested for the UAT session', c.length === 1 && c[0].who.startsWith('Noah') && /^\*Send to "Radix UAT deploy"/.test(c[0].acts[0] ?? ''), JSON.stringify(c))
  await shot('slack-card-earlier')
  const notesBefore = (await ev(`window.ember.notes.list()`)).length
  await ev(`document.querySelector('.ember-slack-nav:not(:disabled)').click()`)
  await wait(300)
  await ev(`document.querySelector('.ember-slack-act.is-primary').click()`)
  await wait(1200)
  const notesAfter = await ev(`window.ember.notes.list()`)
  check('Note keeps it as a note', notesAfter.length === notesBefore + 1, JSON.stringify(notesAfter.slice(0, 1)))
  c = await cards()
  check('the next one takes the slot', c.length === 1 && c[0].who.startsWith('Noah'), JSON.stringify(c))
  await ev(`document.querySelector('.ember-slack-x').click()`)
  await wait(500)
  check('dismissing the last leaves nothing', (await cards()).length === 0)
  await ev(`window.__ember.slackSheet()`)
  await wait(500)
  await shot('slack-sheet')
  check('the sheet offers the manifest and the two tokens', await ev(`document.querySelectorAll('.ember-slack-sheet.is-open .ember-slack-input').length === 2`))
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exitCode = failed ? 1 : 0
