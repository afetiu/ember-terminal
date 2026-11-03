/**
 * A stand-in for Claude Code's own screen (the TUI), for scripts/probe-native-bar.mjs: what
 * the CLI view runs in the tab's shell instead of `claude`.
 *
 * Draws the parts of Claude Code's full-screen layout the canvas reads (the logo line, the
 * input box between two rules, the mode line), echoes what is typed into the box, and exits
 * the way Claude Code does: Ctrl+C clears a half-typed prompt, Ctrl+C on an empty one asks
 * for another, and the second within two seconds exits. Enter on `/exit` exits too.
 *
 *   node scripts/fake-claude-tui.mjs --log <file> [--resume <id>]
 *
 * The log gets its argv, then one line per key it read and how it exited.
 */
import { appendFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const at = argv.indexOf('--log')
const LOG = at >= 0 ? argv[at + 1] : ''
const log = (o) => LOG && appendFileSync(LOG, JSON.stringify(o) + '\n')
if (LOG) writeFileSync(LOG, JSON.stringify({ argv: argv.filter((_, i) => i !== at && i !== at + 1), cwd: process.cwd() }) + '\n')

const out = process.stdout
let typed = ''
let armed = 0
let mode = '  ? for shortcuts'

function draw() {
  const cols = out.columns || 100
  const rows = out.rows || 30
  const rule = '─'.repeat(cols)
  const body = [' ▐▛███▜▌   Claude Code v2.1.316', '▝▜█████▛▘  Opus 5.5 · Claude Max', '  (stand-in TUI for probes)']
  const foot = [rule, `❯ ${typed}`, rule, mode]
  const lines = [...body, ...Array(Math.max(0, rows - body.length - foot.length)).fill(''), ...foot]
  out.write('\x1b[H\x1b[2J' + lines.map((l) => l.slice(0, cols)).join('\r\n'))
  out.write(`\x1b[${rows - 2};${3 + typed.length}H`)
}

function quit(how) {
  log({ exit: how })
  out.write('\x1b[?1049l')
  process.exit(0)
}

out.write('\x1b[?1049h\x1b]0;✳ Claude Code\x07')
draw()
out.on('resize', draw)
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  for (const ch of d) {
    log({ key: ch })
    if (ch === '\x03') {
      if (typed) {
        typed = ''
        armed = 0
      } else if (armed && Date.now() - armed < 2000) {
        quit('ctrl-c')
      } else {
        armed = Date.now()
        mode = '  Press Ctrl-C again to exit'
      }
    } else if (ch === '\r') {
      log({ submitted: typed })
      if (typed.trim() === '/exit') quit('/exit')
      typed = ''
    } else if (ch === '\x7f' || ch === '\b') {
      typed = typed.slice(0, -1)
    } else if (ch >= ' ') {
      typed += ch
      armed = 0
      mode = '  ? for shortcuts'
    }
  }
  draw()
})
