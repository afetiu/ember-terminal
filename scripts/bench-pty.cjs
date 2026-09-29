/**
 * Raw pty throughput, with no renderer in the way.
 *
 * Spawns PowerShell through node-pty exactly as Ember does and runs the same firehose
 * the bench runs, counting bytes as they arrive. What this measures is ConPTY plus the
 * shell; anything slower in Ember itself is Ember's. Run it with the bundled conpty.dll
 * and with the in-box one, because they are different builds and the difference is not
 * always in the bundled one's favour.
 *
 *   node scripts/bench-pty.cjs [--inbox] [--cols=207] [--rows=57] [--lines=20000]
 */
const { spawn } = require('@lydell/node-pty')
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const args = new Map(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? '1'] : [a, '1'] }))
const LINES = Number(args.get('lines') ?? 20000)
const COLS = Number(args.get('cols') ?? 207)
const ROWS = Number(args.get('rows') ?? 57)
const INBOX = args.has('inbox')

const TMP = process.env.TEMP
const out = join(TMP, 'bench-pty.txt')
const script = join(TMP, 'bench-pty.ps1')
if (existsSync(out)) rmSync(out)
writeFileSync(
  script,
  `param([string]$Out)
$t = Measure-Command { 1..${LINES} | ForEach-Object { "line $_ " + ('x' * 90) } | Out-Host }
"$([int]$t.TotalMilliseconds)" | Set-Content -Path $Out
`,
  'utf8',
)

const pty = spawn('pwsh.exe', ['-NoLogo', '-NoProfile'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.env.USERPROFILE,
  env: { ...process.env, TERM_PROGRAM: 'Ember', COLORTERM: 'truecolor' },
  useConptyDll: !INBOX,
})

let bytes = 0
let chunks = 0
let started = 0
let lastReport = 0
pty.onData((d) => {
  bytes += d.length
  chunks++
  if (started && Date.now() - lastReport > 2000) {
    lastReport = Date.now()
    console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s  ${bytes} chars in ${chunks} chunks`)
  }
})

setTimeout(() => {
  started = Date.now()
  lastReport = started
  pty.write(`& '${script}' -Out '${out}'\r`)
  const poll = setInterval(() => {
    if (!existsSync(out)) return
    const inner = readFileSync(out, 'utf8').trim()
    if (!inner) return
    clearInterval(poll)
    const wall = Date.now() - started
    console.log(`\nconpty: ${INBOX ? 'in-box (OS)' : 'bundled dll'}   grid ${COLS}x${ROWS}   lines ${LINES}`)
    console.log(`shell-side Measure-Command : ${inner} ms`)
    console.log(`wall until file appeared   : ${wall} ms`)
    console.log(`received                   : ${bytes} chars in ${chunks} chunks  (${Math.round(bytes / (wall / 1000) / 1024)} KB/s, avg chunk ${Math.round(bytes / Math.max(1, chunks))})`)
    pty.write('exit\r')
    setTimeout(() => process.exit(0), 300)
  }, 200)
}, 2500)
