#!/usr/bin/env node
/**
 * A stand-in for the Codex CLI, for probe-codex.mjs when the real one cannot be used (or
 * to reach what a real session would only do after the person trusted Ember's hooks).
 *
 * It draws Codex's screen the way the real TUI does (0.156, rows as captured from it): the
 * `›` prompt with a dim placeholder, the status line under it ("GPT-Fake high · ~\dir"),
 * "• Working (Ns • esc to interrupt)" mid-turn, the numbered approval prompt, and the
 * "Hooks need review" screen at start. It reads keys as the TUI does — bracketed paste,
 * Enter, Tab (queue), Ctrl+C (clear the prompt), Ctrl+V (attach a picture), Esc — and
 * writes a rollout log in the real format under $CODEX_HOME/sessions/YYYY/MM/DD/.
 *
 * Approvals: a message asking to "run" a command needs one. With FAKE_CODEX_TRUSTED=1 and
 * `-c hooks.PermissionRequest=…` on its command line (what Ember's shim passes), it asks
 * Ember's hook first, exactly as Codex does (hook input on stdin, decision on stdout), and
 * draws its own approval prompt only when the hook gives no decision. "in the CLI" in the
 * message skips the hook, to show the prompt.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const hooked = process.env.FAKE_CODEX_TRUSTED === '1' && args.some((a) => /^hooks\.PermissionRequest=/.test(a))
const hookCmd = process.env.EMBER_CODEX_HOOK || ''
const cwd = process.cwd()
const home = process.env.CODEX_HOME || join(homedir(), '.codex')
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const dir = join(home, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
mkdirSync(dir, { recursive: true })
const sessionId = randomUUID()
const rollout = join(dir, `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${sessionId}.jsonl`)
let ordinal = 0
const rec = (type, payload) => appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal++, type, payload }) + '\n')
rec('session_meta', { session_id: sessionId, id: sessionId, timestamp: now.toISOString(), cwd, originator: 'codex-tui', cli_version: '0.0.0-fake', source: 'cli' })

const out = (s) => process.stdout.write(s)
const W = () => process.stdout.columns || 120
const H = () => process.stdout.rows || 30
const PLACEHOLDER = 'Ask Codex to do anything'
const history = []
let prompt = ''
let images = 0
let screen = process.env.FAKE_CODEX_TRUSTED === '1' ? 'main' : 'review'
let working = null
let approval = null
let queued = []
let quitArmed = 0
let mode = 'default'

function draw() {
  const rows = []
  rows.push('╭──────────────────────────────────╮')
  rows.push('│ >_ OpenAI Codex (v0.0.0-fake)    │')
  rows.push('│                                  │')
  rows.push('│ model:     GPT-Fake   /model     │')
  rows.push(`│ directory: ${cwd.replace(homedir(), '~').slice(0, 21).padEnd(22)}│`)
  rows.push('╰──────────────────────────────────╯')
  rows.push('')
  if (screen === 'review') {
    rows.push('  Hooks need review', '  3 hooks are new or changed.', '  Hooks can run outside the sandbox after you trust them.', '', '', '› 1. Review hooks', '  2. Trust all and continue', "  3. Continue without trusting (hooks won't run)", '', '  enter confirm · esc skip')
    return paint(rows)
  }
  for (const h of history.slice(-14)) rows.push(h, '')
  if (working) rows.push(`• Working (${Math.round((Date.now() - working) / 1000)}s • esc to interrupt)`, '')
  if (queued.length) {
    rows.push('• Queued follow-up inputs')
    for (const q of queued) rows.push(`  ↳ ${q}`)
    rows.push('    alt+↑ edit last queued message', '')
  }
  if (approval) {
    rows.push('  Would you like to run the following command?', '', '  Environment: local', '', `  $ ${approval.command}`, '', '', '› 1. Yes, proceed (y)', '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel')
    return paint(rows)
  }
  const lines = (prompt + (images ? ' ' : '')).split('\n')
  const pics = Array.from({ length: images }, (_, i) => `[Image #${i + 1}]`).join(' ')
  if (!prompt && !images) rows.push(`› \x1b[2m${PLACEHOLDER}\x1b[22m`)
  else {
    const first = `${pics}${pics && prompt ? ' ' : ''}${lines[0]}`
    rows.push(`› ${first}`)
    for (const l of lines.slice(1)) rows.push(`  ${l}`)
  }
  rows.push('')
  rows.push(mode === 'plan' ? '  Plan mode (shift+tab to cycle) · GPT-Fake high' : `  GPT-Fake high · ${cwd.replace(homedir(), '~')}`)
  paint(rows)
}

function paint(rows) {
  const h = H()
  const shown = rows.length > h ? rows.slice(rows.length - h) : rows
  out('\x1b[?25l\x1b[H' + shown.map((r) => `\x1b[2K${r}`).join('\r\n') + '\x1b[J')
}

function runHook(event, input) {
  return new Promise((resolve) => {
    if (!hookCmd) return resolve(null)
    const p = spawn(hookCmd, [], { shell: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    p.stdout.on('data', (d) => (buf += d))
    p.on('close', () => {
      try {
        resolve(buf.trim() ? JSON.parse(buf) : null)
      } catch {
        resolve(null)
      }
    })
    p.on('error', () => resolve(null))
    p.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd, transcript_path: rollout, model: 'gpt-fake', ...input }))
  })
}

let busy = Promise.resolve()
function submit(text) {
  history.push(`› ${text}`)
  busy = busy.then(() => turn(text))
}

async function turn(text) {
  const turnId = randomUUID()
  if (hooked) void runHook('UserPromptSubmit', { turn_id: turnId, prompt: text })
  rec('event_msg', { type: 'task_started', turn_id: turnId })
  rec('response_item', { type: 'message', id: `msg_${randomUUID()}`, role: 'user', content: [{ type: 'input_text', text }] })
  working = Date.now()
  const tick = setInterval(draw, 500)
  draw()
  await sleep(1200)
  let reply = 'ok'
  const run = /run (?:exactly )?(?:this command[^:]*: )?(echo .+)$/i.exec(text)
  const word = /reply with (?:exactly )?(?:the word |this and nothing else: )?(\S+)/i.exec(text)
  if (run) {
    const command = run[1].trim()
    let decision = null
    if (hooked && !/in the CLI/i.test(text)) {
      const r = await runHook('PermissionRequest', { turn_id: turnId, tool_name: 'Bash', tool_input: { command, description: null } })
      decision = r?.hookSpecificOutput?.decision?.behavior ?? null
    }
    if (!decision) {
      approval = { command }
      draw()
      decision = await new Promise((r) => (approval.answer = r))
      approval = null
    }
    if (decision === 'allow') {
      const id = randomUUID()
      rec('event_msg', { type: 'item_completed', turn_id: turnId, item: { type: 'CommandExecution', id, command: ['pwsh', '-Command', command], aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } })
      reply = 'Done: the command ran.'
    } else reply = 'Understood, I did not run it.'
  } else if (word) reply = word[1]
  rec('response_item', { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', content: [{ type: 'output_text', text: reply }] })
  rec('event_msg', { type: 'task_complete', turn_id: turnId })
  history.push(`• ${reply}`)
  clearInterval(tick)
  working = null
  if (hooked) void runHook('Stop', { turn_id: turnId })
  const next = queued.shift()
  if (next) submit(next)
  draw()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function key(s) {
  if (screen === 'review') {
    if (s === '\x1b' || s === '\r') screen = 'main'
    return draw()
  }
  if (approval) {
    if (s === 'y' || s === '\r') approval.answer('allow')
    else if (s === '\x1b') approval.answer('deny')
    return
  }
  if (s === '\x1b') {
    // Esc: interrupt (the fake's turns are short; it just says so).
    return draw()
  }
  if (s === '\x1b[Z') {
    mode = mode === 'plan' ? 'default' : 'plan'
    return draw()
  }
  if (s === '\x03') {
    if (prompt || images) {
      prompt = ''
      images = 0
    } else if (Date.now() - quitArmed < 1500) return quit()
    else quitArmed = Date.now()
    return draw()
  }
  if (s === '\x16') {
    images++
    return draw()
  }
  if (s === '\r' || s === '\t') {
    const text = prompt.trim()
    const pics = images
    prompt = ''
    images = 0
    if (!text && !pics) return draw()
    if (text === '/quit' || text === '/exit') return quit()
    const msg = pics ? `${Array.from({ length: pics }, (_, i) => `[Image #${i + 1}]`).join(' ')} ${text}`.trim() : text
    if (working && s === '\t') queued.push(msg)
    else submit(msg)
    return draw()
  }
  if (s === '\x7f' || s === '\b') {
    prompt = prompt.slice(0, -1)
    return draw()
  }
  prompt += s.replace(/[\x00-\x08\x0b-\x1f]/g, '')
  draw()
}

function quit() {
  out('\x1b[?25h\x1b[2J\x1b[H')
  process.exit(0)
}

let pasting = null
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  let s = chunk
  while (s.length) {
    if (pasting !== null) {
      const end = s.indexOf('\x1b[201~')
      if (end < 0) {
        pasting += s
        return
      }
      prompt += (pasting + s.slice(0, end)).replace(/\r\n?/g, '\n')
      pasting = null
      s = s.slice(end + 6)
      draw()
      continue
    }
    if (s.startsWith('\x1b[200~')) {
      pasting = ''
      s = s.slice(6)
      continue
    }
    if (s.startsWith('\x1b[Z')) {
      key('\x1b[Z')
      s = s.slice(3)
      continue
    }
    if (s.startsWith('\x1b[') || s.startsWith('\x1bO')) {
      // Other escape sequences (focus, arrows): ignored.
      const m = /^\x1b[[O][0-9;?]*[A-Za-z~]/.exec(s)
      s = s.slice(m ? m[0].length : 1)
      continue
    }
    key(s[0])
    s = s.slice(1)
  }
})
process.stdout.on('resize', draw)
draw()
