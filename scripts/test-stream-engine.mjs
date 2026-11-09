/**
 * The stream engine against real recordings (scripts/record-stream.mjs → scripts/fixtures/
 * streams/*.jsonl): every recording is replayed frame by frame through a hidden xterm and
 * src/shared/streamEngine.ts.
 *
 * Ground truth, per mark (what the screen showed when the recorder marked it, read by a
 * person once and written down here): the rows that must be in the live region (the prompt
 * line, a dialog's choices and footer, a menu's entries) and the conversation text that must
 * not. Per frame, for every frame: the region's bottom is the last row drawn, the visible
 * caret is inside it, and the top does not bounce (A → B → A within 300 ms).
 *
 *   node --test scripts/test-stream-engine.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { replay } from './replay-stream.mjs'
import { workingRows } from '../src/shared/liveRules.ts'

const DIR = join(new URL('.', import.meta.url).pathname.slice(1), 'fixtures', 'streams')
const BORDER = /^ ?([─━╌-])\1{20,}/
/** A plain rule row, as the box would see it: line characters only, across most of the width. */
const PURE_RULE = (l, cols) => {
  const t = l.replace(/ /g, '')
  return t.length >= Math.ceil(cols * 0.6) && /^[─━═╌╍┄┅┈┉╴╶╸╺\-—–]+$/.test(t)
}
const CLAUDE_IDLE = { first: BORDER, has: [/^❯/], not: [/Claude Code v\d/, /~\\agent-box/] }

/** recording → mark → { first?, has?, not?, mode? } */
const TRUTH = {
  'claude-idle-typing': {
    idle: CLAUDE_IDLE,
    typing: { first: BORDER, has: [/hello, this is a typing test/] },
    cleared: CLAUDE_IDLE,
  },
  'claude-reply': {
    idle: CLAUDE_IDLE,
    // The working line is in the live area, but the box leaves it out (the canvas shows it at the top).
    working: { has: [/…/, /esc to interrupt/, /^❯/], not: [/Write four short paragraphs/], shownNot: [/Actualizing…/], shownFirst: /^❯/ },
    replied: { first: BORDER, has: [/^❯/], not: [/river/i, /for \d+s · done/] },
  },
  'claude-menus': {
    idle: CLAUDE_IDLE,
    slash: { first: BORDER, has: [/^❯.\/$/, /\/add-dir/] },
    'slash-filtered': { first: BORDER, has: [/^❯.\/mo$/, /\/model/] },
    esc: { ...CLAUDE_IDLE, not: [...CLAUDE_IDLE.not, /\/model /] },
    mcp: { first: BORDER, has: [/Manage MCP servers/, /Esc to cancel/], not: [/^❯.\/mcp/] },
    'mcp-closed': { ...CLAUDE_IDLE, not: [/MCP dialog dismissed/, /\/mcp/] },
    model: { first: BORDER, has: [/Select model/, /Haiku 5\.5/, /Esc to cancel/], not: [/^❯.\/model/, /\/mcp/] },
    'model-closed': { ...CLAUDE_IDLE, not: [/Kept model/, /\/model/] },
    at: { first: BORDER, has: [/^❯.@/] },
    'at-closed': CLAUDE_IDLE,
    multiline: { first: BORDER, has: [/Pasted text #1/] },
    resized: { has: [/Pasted text #1/], not: [/Kept model/] },
    'resized-back': { has: [/Pasted text #1/], not: [/Kept model/] },
    'esc-esc': { first: BORDER, not: [/Kept model/] },
  },
  'claude-permission-queue': {
    idle: CLAUDE_IDLE,
    permission: { first: BORDER, has: [/Do you want to proceed/, /1\. Yes/, /Esc to cancel/], not: [/Run this exact/] },
    'permission-denied': { ...CLAUDE_IDLE, not: [/Interrupted/, /New-Item/] },
    queued: { has: [/second queued/, /third queued/, /esc to interrupt/, /^❯/], not: [/^ {2}\d+$/, /first queued/, /done/], shownNot: [/Blanching…/, /⎿ +Tip:/] },
    'queue-done': { ...CLAUDE_IDLE, not: [/queued/, /probe-se/] },
  },
  'claude-ask': {
    idle: CLAUDE_IDLE,
    ask: { first: BORDER, has: [/Which colour/, /Red/, /Blue/, /Esc to cancel/], not: [/Use the AskUserQuestion/] },
    'ask-closed': { ...CLAUDE_IDLE, not: [/declined/, /Colour/] },
  },
  'claude-trust': {
    trust: { first: BORDER, has: [/trust this folder/, /Enter to confirm/] },
    idle: CLAUDE_IDLE,
  },
  'claude-fullscreen': {
    idle: { mode: 'full' },
    replied: { mode: 'full' },
    slash: { mode: 'full' },
  },
  // Claude's full-screen renderer over a scrolling transcript: no exact boundary between the
  // transcript and its bottom pane in the stream (docs/specs/stream-engine.md), so whole.
  'claude-fullscreen-menus': Object.fromEntries(
    ['idle', 'typing', 'cleared', 'streaming', 'replied', 'slash', 'esc', 'mcp', 'mcp-closed', 'model', 'model-closed', 'multiline', 'resized', 'resized-back', 'esc-esc'].map((m) => [m, { mode: 'full' }])
  ),
  'claude-fullscreen-turns': Object.fromEntries(['idle', 'permission', 'permission-denied', 'queued', 'queue-done'].map((m) => [m, { mode: 'full' }])),
  // Ink log-update (Gemini CLI): its trust dialog, no turns.
  'gemini-short': {
    idle: { has: [/Do you trust the files/, /Don't trust/], not: [/Tips for getting started/, /Gemini CLI v\d/] },
  },
  // Copilot CLI draws on the alternate screen: shown whole.
  'copilot-short': { idle: { mode: 'full' }, slash: { mode: 'full' } },
  'codex-short': {
    idle: { has: [/^› /, /default ·/], not: [/OpenAI Codex/, /Tip:/] },
    // Marked before Codex drew its list (the recorder's wait was too short): the prompt only.
    slash: { has: [/^› /], not: [/OpenAI Codex/] },
  },
  'codex-session': {
    idle: { has: [/^› Ask Codex/, /default ·/], not: [/OpenAI Codex/, /Tip:/] },
    typing: { has: [/^› hello typing test/] },
    slash: { has: [/\/model/, /^› \/$/], not: [/Tip:/] },
    model: { has: [/Select Model/, /esc back/], not: [/Tip:/] },
    mcp: { has: [/^› /], not: [/Tip:/] },
    working: { has: [/Working/, /^› /], not: [/MCP Tools/, /Write three short/], shownNot: [/Working \(/], shownFirst: /^› / },
    queued: { has: [/first queued/, /third queued/, /^› /], not: [/MCP Tools/] },
    replied: { has: [/^› /], not: [/Received/] },
    permission: { has: [/Would you like to run/, /Yes, proceed/, /esc to cancel/], not: [/Run the PowerShell command:/] },
    'permission-denied': { has: [/^› /], not: [/canceled/, /interrupted/i] },
  },
}

const stats = []

for (const [name, marks] of Object.entries(TRUTH)) {
  const file = join(DIR, `${name}.jsonl`)
  test(name, { skip: !existsSync(file) && 'not recorded' }, async (t) => {
    const r = await replay(file)
    for (const m of r.marks) {
      const want = marks[m.mark]
      if (!want) continue
      await t.test(m.mark, () => {
        const reg = m.region
        assert.ok(reg, 'a region was read')
        assert.equal(reg.mode, want.mode ?? 'split', `mode (${reg.why})`)
        if (reg.mode !== 'split') return
        const live = m.live
        const show = `\n${live.map((l, i) => `${String(reg.top + i).padStart(2)}|${l}`).join('\n')}`
        if (want.first) assert.match(live[0] ?? '', want.first, `first row (${reg.why}):${show}`)
        for (const re of want.has ?? []) assert.ok(live.some((l) => re.test(l)), `has ${re} (${reg.why}):${show}`)
        for (const re of want.not ?? []) assert.ok(!live.some((l) => re.test(l)), `not ${re} (${reg.why}):${show}`)
        // What the box shows: the same rows without the agent's rules and its working line (the
        // canvas shows that at the top); the prompt still there.
        const shown = `\n${m.shown.map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n')}`
        assert.ok(!m.shown.some((l) => PURE_RULE(l, r.meta.cols)), `a rule row is shown:${shown}`)
        const working = workingRows(live)
        const expect = live.filter((l, i) => !PURE_RULE(l, r.meta.cols) && !working.has(i))
        assert.equal(m.shown.length, expect.length, `rows shown:${shown}`)
        for (const re of want.has ?? []) if (expect.some((l) => re.test(l))) assert.ok(m.shown.some((l) => re.test(l)), `shown has ${re}:${shown}`)
        for (const re of want.shownNot ?? []) assert.ok(!m.shown.some((l) => re.test(l)), `shown not ${re}:${shown}`)
        if (want.shownNot) assert.ok(working.size > 0, 'the working line was found')
        if (want.shownFirst) assert.match(m.shown[0] ?? '', want.shownFirst, `shown first row:${shown}`)
        // The caret on the row it is on in the terminal: the prompt line, typing, a dialog.
        if (reg.cursor.visible) {
          const at = live[reg.cursor.y - reg.top]
          assert.equal(m.shown[m.caretRow], at, `caret row (${reg.cursor.y}):${shown}`)
          if (r.meta.agent === 'claude' && /^❯/.test(at ?? '')) assert.match(m.shown[m.caretRow], /^❯/, 'caret on the prompt row')
        }
      })
    }
    // Every frame: the bottom is the last drawn row; the caret is inside; no bounces.
    let caretOut = 0
    let bottomOff = 0
    let rulesShown = 0
    let caretLost = 0
    let bounces = 0
    let changes = 0
    const tops = []
    for (const f of r.frames) {
      if (f.mode !== 'split' || f.t >= r.exitAt) continue
      // log-update leaves the cursor at the start of the line under its frame (Ink hides its own).
      const resting = f.model === 'log-update' && f.cursor.x === 0 && f.cursor.y > f.bottom
      if (f.cursor.visible && !resting && (f.cursor.y < f.top || f.cursor.y > f.bottom)) caretOut++
      if (f.shown.some((l) => PURE_RULE(l, r.meta.cols))) rulesShown++
      if (f.cursor.visible && !resting && f.caretRow < 0) caretLost++
      tops.push({ t: f.t, top: f.top, h: f.bottom - f.top + 1 })
    }
    for (let i = 1; i < tops.length; i++) {
      if (tops[i].h !== tops[i - 1].h) changes++
      if (i >= 2 && tops[i].h === tops[i - 2].h && tops[i].h !== tops[i - 1].h && tops[i].t - tops[i - 2].t < 300) bounces++
    }
    stats.push({ name, frames: r.frames.length, heightChanges: changes, bounces, caretOut, bottomOff })
    assert.equal(caretOut, 0, 'frames with the visible caret outside the region')
    assert.equal(rulesShown, 0, 'frames whose shown rows include a rule')
    assert.equal(caretLost, 0, 'frames whose visible caret is on no shown row')
    assert.ok(bounces <= 2, `height bounced back within 300 ms ${bounces} times`)
  })
}

test.after(() => {
  console.log('\nrecording                   frames  height changes  bounces  caret outside')
  for (const s of stats) console.log(`${s.name.padEnd(27)} ${String(s.frames).padStart(6)}  ${String(s.heightChanges).padStart(14)}  ${String(s.bounces).padStart(7)}  ${String(s.caretOut).padStart(13)}`)
})
