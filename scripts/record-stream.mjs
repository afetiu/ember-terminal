/**
 * Records an agent CLI's raw PTY output stream, chunk by chunk with timestamps, for the
 * stream engine (docs/specs/stream-engine.md, src/shared/streamEngine.ts).
 *
 * The agent runs under node-pty — the OS ConPTY, as in Ember — at a fixed size, and a script
 * of steps types into it as a person would. Every output chunk, every input written, every
 * resize and every named mark (with the screen's text at that moment, for ground truth) goes
 * to scripts/fixtures/streams/<name>.jsonl, one JSON object per line:
 *
 *   {"t":12,"o":"…"}                    output chunk (t = ms since spawn)
 *   {"t":40,"i":"…"}                    input written to the PTY
 *   {"t":90,"resize":[cols,rows]}
 *   {"t":95,"mark":"slash","screen":[…rows…],"cursor":[x,y]}
 *   {"meta":{agent,cols,rows,cmd,args,…}}   first line
 *
 *   node scripts/record-stream.mjs claude|codex [--only=<scenario>]
 *
 * Real agents, real turns: claude --model haiku in ~/agent-box, codex as logged in.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const pty = require('@lydell/node-pty')
const { Terminal } = require('@xterm/xterm')

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = join(REPO, 'scripts', 'fixtures', 'streams')
const CWD = join(homedir(), 'agent-box')
const args = process.argv.slice(2)
const AGENT = args.find((a) => !a.startsWith('--')) ?? 'claude'
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7)
// Ember runs agents under the bundled OpenConsole (passthrough: the agent's own cursor moves,
// scroll regions and 2026 frames reach us); --inbox records the OS ConPTY for comparison.
const BUNDLED = !args.includes('--inbox')
const SUFFIX = BUNDLED ? '' : '-inbox'
const COLS = 120
const ROWS = 45
mkdirSync(OUT, { recursive: true })
// A PTY torn down mid-write throws EAGAIN on its socket; the recording is already saved.
process.on('uncaughtException', (e) => console.log(`  (ignored: ${e.code ?? e.message})`))

const ESC = '\x1b'
const ENTER = '\r'
const paste = (s) => `${ESC}[200~${s}${ESC}[201~`

function settingsFile(tui = 'default') {
  const dir = join(process.env.TEMP ?? '.', 'ember-record')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, `settings-${tui}.json`)
  writeFileSync(f, JSON.stringify({ tui }))
  return f
}

function command(agent, name) {
  if (agent === 'claude') {
    return {
      file: join(homedir(), '.local', 'bin', 'claude.exe'),
      args: ['--model', 'haiku', '--permission-mode', 'default', '--settings', settingsFile(name.includes('fullscreen') ? 'fullscreen' : 'default')],
    }
  }
  // Codex started from a shell with lines on screen above it, as in an Ember tab.
  if (agent === 'codex' && name.includes('shell')) {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-Command', "1..6 | ForEach-Object { \"shell line $_\" }; codex -a on-request -s read-only"],
    }
  }
  if (agent === 'codex') {
    return {
      file: join(process.env.APPDATA ?? '', 'npm', 'codex.cmd'),
      args: ['-a', 'on-request', '-s', 'read-only'],
    }
  }
  if (agent === 'gemini' || agent === 'copilot') return { file: join(process.env.APPDATA ?? '', 'npm', `${agent}.cmd`), args: [] }
  throw new Error(`unknown agent ${agent}`)
}

/** Ember's own environment rule (ConPtyHost.cleanEnv): no launcher markers. */
function cleanEnv() {
  const drop = ['NO_COLOR', 'FORCE_COLOR', 'CLAUDECODE', 'CLAUDE_CODE_', 'ELECTRON_RUN_AS_NODE', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_', 'PWD']
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.some((p) => (p.endsWith('_') ? k.startsWith(p) : k === p))))
}

/** A fresh folder Claude has never been trusted in (the trust dialog). */
function untrusted() {
  const dir = join(process.env.TEMP ?? '.', `ember-record-untrusted-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** One recording: spawn, run the steps, write the file. */
async function record(name, agent, steps) {
  const { file, args: cargs } = command(agent, name)
  const lines = [{ meta: { agent, name, bundledConpty: BUNDLED, cols: COLS, rows: ROWS, cmd: file, args: cargs, at: new Date().toISOString() } }]
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true })
  const t0 = Date.now()
  const now = () => Date.now() - t0
  let lastOut = now()
  let screenText = ''
  const p = pty.spawn(file, cargs, {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: name.includes('trust') ? untrusted() : CWD,
    env: { ...cleanEnv(), TERM_PROGRAM: 'Ember', COLORTERM: 'truecolor' },
    useConptyDll: BUNDLED,
  })
  let exited = false
  p.onExit(() => (exited = true))
  p.onData((d) => {
    // OpenConsole asks for the terminal's attributes (DA1) at start and waits 3 s for an
    // answer; Ember's engine answers at once, so does the recorder.
    if (d.includes('\x1b[c')) p.write('\x1b[?61;4c')
    lines.push({ t: now(), o: d })
    lastOut = now()
    term.write(d)
  })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const flush = () => new Promise((r) => term.write('', r))
  const screen = async () => {
    await flush()
    const b = term.buffer.active
    const rows = []
    for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '')
    screenText = rows.join('\n')
    return { rows, cursor: [b.cursorX, b.cursorY], baseY: b.baseY }
  }
  const write = (s) => {
    lines.push({ t: now(), i: s })
    p.write(s)
  }
  for (const step of steps) {
    if (exited) break
    const [op, a, b] = step
    if (op === 'wait') await wait(a)
    else if (op === 'idle') {
      // no output for `a` ms (at most `b` ms)
      const end = now() + (b ?? 30000)
      while (now() < end && now() - lastOut < a) await wait(50)
    } else if (op === 'until') {
      const end = now() + (b ?? 60000)
      for (;;) {
        await screen()
        if (a.test(screenText) || now() > end) break
        await wait(100)
      }
      if (!a.test(screenText)) console.log(`  [${name}] timeout waiting for ${a}`)
    } else if (op === 'type') {
      for (const ch of a) {
        write(ch)
        await wait(35)
      }
    } else if (op === 'send') write(a)
    else if (op === 'resize') {
      lines.push({ t: now(), resize: [a, b] })
      p.resize(a, b)
      term.resize(a, b)
    } else if (op === 'mark') {
      const s = await screen()
      lines.push({ t: now(), mark: a, screen: s.rows, cursor: s.cursor })
      console.log(`  [${name}] mark ${a}`)
    }
  }
  await wait(300)
  const out = join(OUT, `${name}${SUFFIX}.jsonl`)
  writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(`${name}: ${lines.length} lines -> ${out}`)
  try {
    p.kill()
  } catch {
    /* gone */
  }
  await wait(500)
}

const claudeReady = /for shortcuts|\? for|bypass|accept edits|plan mode|shift\+tab/i
const claude = {
  'claude-trust': [
    ['until', /trust|Yes, proceed|safety/i, 40000],
    ['idle', 1500, 8000],
    ['mark', 'trust'],
    ['send', '\x1b[B'],
    ['wait', 300],
    ['send', ENTER],
    ['until', claudeReady, 20000],
    ['idle', 2000, 8000],
    ['mark', 'idle'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-ask': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'Use the AskUserQuestion tool once to ask me which colour I prefer, with options Red and Blue. Nothing else.'],
    ['send', ENTER],
    ['until', /Red[\s\S]*Blue/, 60000],
    ['idle', 1000, 6000],
    ['mark', 'ask'],
    ['send', ESC],
    ['idle', 1500, 10000],
    ['mark', 'ask-closed'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-fullscreen': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'Write three short paragraphs about lakes. No tools.'],
    ['send', ENTER],
    ['idle', 2500, 60000],
    ['mark', 'replied'],
    ['type', '/'],
    ['idle', 800, 4000],
    ['mark', 'slash'],
    ['send', ESC],
    ['wait', 300],
    ['send', '\x15'],
    ['idle', 600, 4000],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  // Claude's full-screen renderer (tui: fullscreen; the name says so): the states the box
  // must show, over a transcript long enough to scroll.
  'claude-fullscreen-menus': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'hello, this is a typing test'],
    ['idle', 400, 3000],
    ['mark', 'typing'],
    ['send', '\x15'],
    ['idle', 400, 3000],
    ['mark', 'cleared'],
    ['type', 'Count from 1 to 70, one number per line. No tools.'],
    ['send', ENTER],
    ['wait', 2500],
    ['mark', 'streaming'],
    ['idle', 2500, 60000],
    ['mark', 'replied'],
    ['type', '/'],
    ['until', /\/(help|clear|model)\b/, 8000],
    ['idle', 500, 4000],
    ['mark', 'slash'],
    ['send', ESC],
    ['wait', 300],
    ['send', '\x15'],
    ['idle', 600, 4000],
    ['mark', 'esc'],
    ['type', '/mcp'],
    ['idle', 500, 3000],
    ['send', ENTER],
    ['until', /MCP|mcp/, 8000],
    ['idle', 1200, 8000],
    ['mark', 'mcp'],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'mcp-closed'],
    ['type', '/model'],
    ['idle', 500, 3000],
    ['send', ENTER],
    ['until', /Select model/, 8000],
    ['idle', 1000, 8000],
    ['mark', 'model'],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'model-closed'],
    ['send', paste('line one\rline two\rline three\rline four\rline five\rline six')],
    ['idle', 800, 4000],
    ['mark', 'multiline'],
    ['resize', 100, 34],
    ['idle', 1000, 5000],
    ['mark', 'resized'],
    ['resize', COLS, ROWS],
    ['idle', 1000, 5000],
    ['mark', 'resized-back'],
    ['send', '\x15'],
    ['send', ESC],
    ['wait', 300],
    ['send', ESC],
    ['idle', 800, 4000],
    ['mark', 'esc-esc'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-fullscreen-turns': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'Run this exact PowerShell command with your Bash or PowerShell tool: New-Item probe-se.txt'],
    ['send', ENTER],
    ['until', /Do you want|proceed\?|Yes, and/i, 60000],
    ['idle', 600, 4000],
    ['mark', 'permission'],
    ['send', ESC],
    ['idle', 1500, 10000],
    ['mark', 'permission-denied'],
    ['type', 'Count from 1 to 60, one number per line, then say done.'],
    ['send', ENTER],
    ['wait', 1200],
    ['type', 'first queued'],
    ['send', ENTER],
    ['wait', 300],
    ['type', 'second queued'],
    ['send', ENTER],
    ['wait', 300],
    ['type', 'third queued'],
    ['send', ENTER],
    ['wait', 500],
    ['mark', 'queued'],
    ['idle', 3000, 90000],
    ['mark', 'queue-done'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-idle-typing': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'hello, this is a typing test'],
    ['idle', 400, 3000],
    ['mark', 'typing'],
    ['send', '\x15'], // Ctrl+U clears the line
    ['idle', 400, 3000],
    ['mark', 'cleared'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-reply': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'Write four short paragraphs about rivers. No tools.'],
    ['send', ENTER],
    ['wait', 2500],
    ['mark', 'working'],
    ['idle', 2500, 60000],
    ['mark', 'replied'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-menus': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', '/'],
    ['until', /\/(help|clear|model)\b/, 8000],
    ['idle', 500, 4000],
    ['mark', 'slash'],
    ['type', 'mo'],
    ['idle', 600, 4000],
    ['mark', 'slash-filtered'],
    ['send', ESC],
    ['wait', 300],
    ['send', '\x15'],
    ['idle', 600, 4000],
    ['mark', 'esc'],
    ['type', '/mcp'],
    ['idle', 500, 3000],
    ['send', ENTER],
    ['until', /MCP|mcp/, 8000],
    ['idle', 1200, 8000],
    ['mark', 'mcp'],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'mcp-closed'],
    ['type', '/model'],
    ['idle', 500, 3000],
    ['send', ENTER],
    ['until', /Select model/, 8000],
    ['idle', 1000, 8000],
    ['mark', 'model'],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'model-closed'],
    ['type', '@'],
    ['idle', 1000, 4000],
    ['mark', 'at'],
    ['send', ESC],
    ['wait', 300],
    ['send', '\x15'],
    ['idle', 600, 4000],
    ['mark', 'at-closed'],
    ['send', paste('line one\rline two\rline three\rline four\rline five\rline six')],
    ['idle', 800, 4000],
    ['mark', 'multiline'],
    ['resize', 100, 34],
    ['idle', 1000, 5000],
    ['mark', 'resized'],
    ['resize', COLS, ROWS],
    ['idle', 1000, 5000],
    ['mark', 'resized-back'],
    ['send', ESC],
    ['wait', 300],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'esc-esc'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
  'claude-permission-queue': [
    ['until', claudeReady, 40000],
    ['idle', 2500, 12000],
    ['mark', 'idle'],
    ['type', 'Run this exact PowerShell command with your Bash or PowerShell tool: New-Item probe-se.txt'],
    ['send', ENTER],
    ['until', /Do you want|proceed\?|Yes, and/i, 60000],
    ['idle', 600, 4000],
    ['mark', 'permission'],
    ['send', ESC],
    ['idle', 1500, 10000],
    ['mark', 'permission-denied'],
    ['type', 'Count from 1 to 60, one number per line, then say done.'],
    ['send', ENTER],
    ['wait', 1200],
    ['type', 'first queued'],
    ['send', ENTER],
    ['wait', 300],
    ['type', 'second queued'],
    ['send', ENTER],
    ['wait', 300],
    ['type', 'third queued'],
    ['send', ENTER],
    ['wait', 500],
    ['mark', 'queued'],
    ['idle', 3000, 90000],
    ['mark', 'queue-done'],
    ['send', '\x03'],
    ['wait', 300],
    ['send', '\x03'],
    ['wait', 800],
  ],
}

const codexReady = /context left|% left|\? for shortcuts|send|Ctrl\+J|esc to/i
const codex = {
  'codex-shell': [
    ['until', codexReady, 40000],
    ['idle', 2000, 10000],
    ['mark', 'idle'],
    ['type', '/'],
    ['until', /\/model\s{2,}/, 6000],
    ['idle', 600, 4000],
    ['mark', 'slash'],
    ['send', '\x7f'],
    ['idle', 600, 4000],
    ['type', '/model'],
    ['idle', 400, 3000],
    ['send', ENTER],
    ['until', /Select Model/, 8000],
    ['idle', 800, 4000],
    ['mark', 'model'],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'model-closed'],
    ['send', '\x03'],
    ['wait', 400],
    ['send', '\x03'],
    ['wait', 1000],
  ],
  'codex-short': [
    ['until', codexReady, 40000],
    ['idle', 1500, 10000],
    ['mark', 'idle'],
    ['type', '/'],
    ['idle', 600, 4000],
    ['mark', 'slash'],
    ['send', ESC],
    ['wait', 300],
    ['send', '\x15'],
    ['idle', 600, 4000],
    ['mark', 'esc'],
    ['send', '\x03'],
    ['wait', 400],
    ['send', '\x03'],
    ['wait', 1000],
  ],
  'codex-session': [
    ['until', codexReady, 40000],
    ['idle', 1500, 10000],
    ['mark', 'idle'],
    ['type', 'hello typing test'],
    ['idle', 400, 3000],
    ['mark', 'typing'],
    ['send', '\x15'],
    ['idle', 400, 3000],
    ['type', '/'],
    ['idle', 600, 4000],
    ['mark', 'slash'],
    ['send', ESC],
    ['send', '\x15'],
    ['idle', 600, 4000],
    ['mark', 'esc'],
    ['type', '/model'],
    ['idle', 400, 3000],
    ['send', ENTER],
    ['idle', 1200, 8000],
    ['mark', 'model'],
    ['send', ESC],
    ['wait', 300],
    ['idle', 800, 4000],
    ['mark', 'model-closed'],
    ['type', '/mcp'],
    ['idle', 400, 3000],
    ['send', ENTER],
    ['idle', 1200, 8000],
    ['mark', 'mcp'],
    ['send', paste('line one\nline two\nline three\nline four\nline five\nline six')],
    ['idle', 800, 4000],
    ['mark', 'multiline'],
    ['resize', 100, 34],
    ['idle', 1000, 5000],
    ['mark', 'resized'],
    ['resize', COLS, ROWS],
    ['idle', 1000, 5000],
    ['mark', 'resized-back'],
    ['send', '\x15'],
    ['send', ESC],
    ['idle', 600, 3000],
    ['type', 'Write three short paragraphs about rivers. Do not run any commands.'],
    ['send', ENTER],
    ['wait', 2500],
    ['mark', 'working'],
    ['type', 'first queued'],
    ['send', '\t'],
    ['wait', 300],
    ['type', 'second queued'],
    ['send', '\t'],
    ['wait', 300],
    ['type', 'third queued'],
    ['send', '\t'],
    ['wait', 400],
    ['mark', 'queued'],
    ['idle', 4000, 120000],
    ['mark', 'replied'],
    ['type', 'Run the PowerShell command: New-Item probe-se.txt'],
    ['send', ENTER],
    ['until', /Would you like|Allow|approve|Yes, proceed|\(y\)/i, 90000],
    ['idle', 800, 5000],
    ['mark', 'permission'],
    ['send', ESC],
    ['idle', 2000, 15000],
    ['mark', 'permission-denied'],
    ['send', '\x03'],
    ['wait', 400],
    ['send', '\x03'],
    ['wait', 1000],
  ],
}

// Other Ink CLIs, no turns: their idle prompt and `/` list (is the live area log-update's?).
const inkShort = (agent) => ({
  [`${agent}-short`]: [
    ['wait', 12000],
    ['idle', 1500, 15000],
    ['mark', 'idle'],
    ['type', '/'],
    ['idle', 1200, 5000],
    ['mark', 'slash'],
    ['send', ESC],
    ['wait', 400],
    ['idle', 800, 4000],
    ['mark', 'esc'],
    ['send', '\x03'],
    ['wait', 400],
    ['send', '\x03'],
    ['wait', 1000],
  ],
})

const all = AGENT === 'codex' ? codex : AGENT === 'claude' ? claude : inkShort(AGENT)
for (const [name, steps] of Object.entries(all)) {
  if (ONLY && !name.includes(ONLY)) continue
  await record(name, AGENT, steps)
}
rmSync(join(CWD, 'probe-se.txt'), { force: true })
process.exit(0)
