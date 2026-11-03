/**
 * The plan is an object like any other: a dev Ember (own EMBER_HOME), a canvas fed a made-up
 * session with Claude's TodoWrite steps through window.__ember.loomFeed (no model), then:
 * the plan shows as an object in the reply, follows the work into the next turn, can be
 * removed with its ×, stays away while the same plan updates, and comes back for a new plan.
 *
 *   npm run build; node scripts/probe-plan-piece.mjs [out-dir]
 *
 * Nothing is typed into any terminal. The canvas is shown by a stylesheet, as Claude mode
 * would show it, because no agent runs.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-plan-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', 'ember-probe-plan')
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = 9392
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let n = 0
const at = () => new Date(Date.parse('2026-11-02T09:00:00Z') + n * 1000).toISOString()
const u = (content) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(), message: { role: 'user', content } })
const a = (text) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const todo = (states, steps = ['Merge #42', 'Switch the billing app to Postgres', 'Turn off the sync functions', 'Point DNS to AWS']) => ({
  type: 'assistant',
  uuid: `t${++n}`,
  timestamp: at(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu${n}`, name: 'TodoWrite', input: { todos: steps.map((s, i) => ({ content: s, activeForm: s, status: states[i] })) } }] },
})

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
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
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }

  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev('window.__ember.newLoom()')
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(1500)
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 640px !important; }'; document.head.appendChild(st); return true })()`)
  const feed = (lines) => ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
  const state = () =>
    ev(`(() => {
      const p = document.querySelector('.loom-piece.is-steps')
      const shown = document.querySelector('.loom-turn.is-shown')
      return {
        plan: !!p,
        inShownTurn: !!(p && shown && shown.contains(p)),
        hasBar: !!p?.querySelector('.loom-piece-head [data-p="close"]'),
        done: p?.querySelector('.loom-plan-count')?.textContent ?? '',
        title: p?.querySelector('.loom-piece-title')?.textContent ?? '',
        topStrip: !!document.querySelector('.loom-scroll > .loom-plan'),
      } })()`)
  const log = []
  const note = async (label) => log.push(`${label.padEnd(40)} ${JSON.stringify(await state())}`)

  await feed([u('do we have everything in place for cutover day?'), a('Here is the order.'), todo(['in_progress', 'pending', 'pending', 'pending'])])
  await wait(1200)
  await note('plan starts')
  await shot('1-plan')
  await feed([u('go on'), a('Merged.'), todo(['completed', 'in_progress', 'pending', 'pending'])])
  await wait(1200)
  await note('next turn, plan updated')
  await shot('2-next-turn')
  // remove it with its ×
  await ev(`(() => { const b = document.querySelector('.loom-piece.is-steps [data-p="close"]'); b.click(); return true })()`)
  await wait(800)
  await note('after × on the plan')
  await feed([a('Switched.'), todo(['completed', 'completed', 'in_progress', 'pending'])])
  await wait(1200)
  await note('same plan updates again')
  await feed([u('new task: the analytics rollout'), todo(['in_progress', 'pending'], ['Backfill the events', 'Turn on the dashboards'])])
  await wait(1200)
  await note('a new plan')
  await shot('3-new-plan')
  console.log(log.join('\n'))
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}
