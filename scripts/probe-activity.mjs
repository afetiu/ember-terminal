/**
 * Ground truth for the *state* half of the tab-status feature.
 *
 * probe-claude.mjs recorded what a Claude Code session looks like at launch. This one
 * records how it looks over time — output cadence and the last lines on screen while
 * the session is idle at its prompt, while it is answering, and while it is blocked
 * on a question. The current "any output in the last 600ms means working" rule reads
 * Claude Code's animated prompt as work, so the badge says Working forever; this is
 * the data used to replace that rule.
 *
 * Sends one tiny prompt, so it costs a handful of tokens.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const PORT = 9341
// Strip the parent Claude Code session's markers, or the `claude` we launch inside the
// probe comes up as a nested child session (manual mode, no transcript) and never
// actually answers — which is not the state we are trying to measure.
const env = { ...process.env, EMBER_HOME }
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') delete env[k]
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env,
})

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(400)
  }
  throw new Error('no devtools target')
}

const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
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
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
  return r.result?.result?.value
}

await send('Runtime.enable')
let sid = null
for (let i = 0; i < 40 && !sid; i++) {
  await sleep(500)
  sid = await evaluate(`window.__ember?.sessions()[0]?.id ?? null`)
}
if (!sid) throw new Error('no active pane')

const card = () =>
  evaluate(`(() => {
    const c = document.querySelector('.ember-card')
    if (!c) return null
    return {
      state: c.dataset.state,
      attention: c.dataset.attention,
      tooltip: c.title,
      status: c.querySelector('.ember-card-statustext')?.textContent ?? '',
      quiet: !!c.querySelector('.ember-card-status.is-quiet'),
    }
  })()`)

const samples = []
let lastBytes = 0
const sample = async (phase) => {
  const s = await evaluate(`window.__ember.sessions()[0]`)
  const tail = s.text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(-8)
  const row = {
    phase,
    t: Date.now(),
    sinceOutputMs: s.sinceOutputMs,
    bytesDelta: s.bytesIn - lastBytes,
    buffer: s.bufferType,
    bells: s.bells,
    rawTitle: s.rawTitle,
    state: s.activity.state,
    label: s.activity.label,
    tail,
  }
  lastBytes = s.bytesIn
  row.card = await card()
  samples.push(row)
  console.log(
    `[${phase}] since=${String(row.sinceOutputMs).padStart(5)}ms bytes+=${String(row.bytesDelta).padStart(6)} buf=${row.buffer} state=${row.state.padEnd(9)} attention=${String(s.activity.attention).padEnd(8)} card=${JSON.stringify(row.card)}`,
  )
  return row
}

const sampleFor = async (phase, ms, every = 1000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await sample(phase)
    await sleep(every)
  }
}

const write = async (text) => evaluate(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(text)})`)
/** Type like a person: Claude Code's TUI drops input pasted at it while it is booting. */
const type = async (text) => {
  for (const ch of text) {
    await write(ch)
    await sleep(25)
  }
}

await sample('shell')
console.log('\n=== launching claude ===')
await write('claude\r')

// Wait for the TUI to actually take over rather than guessing at a delay, clearing
// the folder-trust prompt on the way — a fresh EMBER_HOME means a fresh trust check,
// and everything typed before it is answered goes to the shell instead.
let trusted = false
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const s = await evaluate(`window.__ember.sessions()[0]`)
  if (!trusted && /trust this folder/i.test(s.text)) {
    trusted = true
    await write('\r')
    continue
  }
  if (s.bufferType === 'alternate' && /claude/i.test(s.rawTitle)) break
}
await sleep(3000)

console.log('\n=== phase: IDLE at prompt (no work in flight) ===')
await sampleFor('idle', 10000, 1500)

console.log('\n=== phase: WORKING (one tiny prompt) ===')
await type('count from 1 to 30, one number per line, nothing else')
await sleep(500)
await write('\r')
await sampleFor('working', 30000, 1500)

console.log('\n=== phase: IDLE again (after the answer) ===')
await sampleFor('idle-after', 30000, 2000)

const dump = await evaluate(`window.__ember.sessions()[0].text`)
console.log('\n--- full viewport at end ---')
console.log(dump.split('\n').filter((l) => l.trim()).join('\n'))

const out = join(process.env.TEMP ?? '.', 'ember-activity-probe.json')
writeFileSync(out, JSON.stringify({ samples, finalViewport: dump }, null, 2))
console.log('\nsamples ->', out)

await evaluate(`window.ember.write(${JSON.stringify(sid)}, '\\u0003')`)
await sleep(600)
await evaluate(`window.ember.write(${JSON.stringify(sid)}, '\\u0003')`)
await sleep(1200)
ws.close()
child.kill()
process.exit(0)
