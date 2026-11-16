/**
 * The CLI box against two things Claude Code draws that are not its live area (reported
 * 2026-11-16 with screenshots): the prompt's top rule once the session has a name
 * ("──── urgent-issues ─"), and a running tool call ("● Bash(…)") whose bullet blinks
 * right above the prompt. Neither may show in the box.
 *
 *   node --test scripts/test-live-labelled.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { StreamEngine } from '../src/shared/streamEngine.ts'
import { keptRows } from '../src/shared/liveRules.ts'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')

const COLS = 120
const ROWS = 30
const rule = (label) => (label ? '─'.repeat(COLS - label.length - 4) + ` ${label} ─` : '─'.repeat(COLS))
const at = (y) => `\x1b[${y + 1};1H\x1b[2K`

/** Draws the bottom area from row `y0`: [rows above the rule...], rule, prompt, status. */
function frame(y0, above, label) {
  const lines = [...above, rule(label), '❯ ', '  .claude · Opus 5.5 (1M context) · $0.63', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
  return lines.map((l, i) => at(y0 + i) + l).join('') + `\x1b[${y0 + above.length + 2};3H`
}

async function setup() {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  let clock = 0
  const engine = new StreamEngine(term, { agent: 'claude', now: () => clock })
  const write = (d) => new Promise((r) => term.write(d, r))
  const shown = (r) => {
    const b = term.buffer.active
    const k = keptRows((y) => b.getLine(b.baseY + y), r.top, r.bottom, COLS, Infinity)
    return k.ys.map((y) => b.getLine(b.baseY + y)?.translateToString(true) ?? '')
  }
  const step = async (data, ms = 120) => {
    clock += ms
    await write(data)
    return engine.frame()
  }
  // Some conversation first.
  await step(['Hi! What are we working on?', '', 'Sure, let me look.'].map((l, i) => at(i) + l).join(''))
  return { step, shown }
}

test('a named prompt rule is a rule: left out of the box, and the top', async () => {
  const { step, shown } = await setup()
  const r = await step(frame(20, [], 'urgent-issues'))
  const s = shown(r)
  assert.ok(!s.some((l) => /urgent-issues/.test(l)), `box shows the named rule: ${JSON.stringify(s)}`)
  assert.match(s[0], /^❯/)
  assert.equal(s.length, 3)
})

test('a running tool call above the prompt stays out of the box while it blinks', async () => {
  const { step, shown } = await setup()
  const tool = (on) => `${on ? '●' : ' '} Bash(cd ~/radix-assistant && git log --oneline -3)`
  let r = await step(frame(18, [tool(true), '  ⎿  Running…'], 'urgent-issues'))
  // The bullet blinks: small frames that change only the tool's row.
  for (let i = 0; i < 6; i++) {
    r = await step(at(18) + tool(i % 2 === 1) + `\x1b[22;3H`, 300)
    const s = shown(r)
    assert.ok(!s.some((l) => /Bash\(|Running…/.test(l)), `frame ${i}: box shows the tool call: ${JSON.stringify(s)}`)
    assert.match(s[0], /^❯/)
  }
})

test('the working line still lifts the top (and the box still leaves it out)', async () => {
  const { step, shown } = await setup()
  const work = (n) => `✻ Cogitating… (${n}s · esc to interrupt)`
  let r = await step(frame(18, [work(1), ''], 'urgent-issues'))
  for (let i = 2; i < 6; i++) r = await step(at(18) + work(i) + `\x1b[22;3H`, 300)
  assert.ok(r.top <= 18, `top ${r.top} should include the working line (${r.why})`)
  const s = shown(r)
  assert.match(s[0], /^❯/)
})
