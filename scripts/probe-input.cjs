#!/usr/bin/env node
// Input latency of a Claude Code session under node-pty (the stack Ember runs), with no
// terminal UI at all: type a letter while Claude streams and measure how long until the
// screen shows it. The screen is xterm's headless parser (the same parser Ember's grid
// uses), so what is measured is what a person would see.
//
//   node scripts/probe-input.cjs [cols] [rows]
//   EMBER_BUNDLED_CONPTY=1 node scripts/probe-input.cjs     # conpty.dll v1.25 from the package
//   EMBER_XTERM_HEADLESS=<dir with node_modules/@xterm/headless>  (default: the session scratchpad)
'use strict'
const path = require('node:path')
const pty = require('@lydell/node-pty')
const headlessDir = process.env.EMBER_XTERM_HEADLESS || path.join(process.env.LOCALAPPDATA, 'Temp', 'claude', HOME.replace(/[:\/]/g, '-'), '347628de-4674-4589-a7ed-d3d11d55d602', 'scratchpad', 'xterm-headless')
const { Terminal } = require(path.join(headlessDir, 'node_modules', '@xterm', 'headless'))

const cols = Number(process.argv[2] || 160)
const rows = Number(process.argv[3] || 45)
const bundled = !!process.env.EMBER_BUNDLED_CONPTY
const shell = process.env.EMBER_PROBE_SHELL || 'pwsh.exe'
const label = bundled ? 'bundled conpty v1.25' : 'in-box conpty'

const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 })
const t0 = Date.now()
const p = pty.spawn(shell, ['-NoLogo'], { name: 'xterm-256color', cols, rows, cwd: process.env.USERPROFILE, env: { ...process.env, TERM_PROGRAM: 'Ember', COLORTERM: 'truecolor' }, useConptyDll: bundled })
p.onData((d) => term.write(d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function screen() {
  const b = term.buffer.active
  const lines = []
  for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  return lines
}
async function until(pred, maxMs) {
  const s = Date.now()
  while (Date.now() - s < maxMs) {
    if (pred(screen())) return true
    await sleep(5)
  }
  return false
}

;(async () => {
  await sleep(3000)
  p.write('claude\r')
  const up = await until((sc) => sc.some((l) => /auto mode|for shortcuts|Try "/.test(l)), 40000)
  console.log(`[${label}] claude up: ${up} (${Date.now() - t0} ms)`)
  if (!up) { console.log(screen().filter((l) => l.trim()).slice(-8).join('\n')); p.kill(); return }
  await sleep(2000)
  p.write('Print 200 lines, each exactly "row N lorem ipsum dolor sit amet consectetur" with N from 1 to 200. No tool use, no commentary, just the lines.')
  await sleep(800)
  p.write('\r')
  const streaming = await until((sc) => sc.some((l) => l.includes('lorem ipsum')), 45000)
  console.log(`[${label}] streaming: ${streaming}`)
  const lat = []
  let typed = ''
  for (let k = 0; k < 20; k++) {
    typed += 'z'
    const s = Date.now()
    const want = typed
    p.write('z')
    const seen = await until((sc) => sc.some((l) => l.includes(want)), 5000)
    lat.push(seen ? String(Date.now() - s) : 'MISS')
    await sleep(450)
  }
  console.log(`[${label}] latencies ms: ${lat.join(' ')}`)
  const nums = lat.filter((x) => x !== 'MISS').map(Number).sort((a, b) => a - b)
  const sc = screen()
  if (nums.length) console.log(`[${label}] median ${nums[Math.floor(nums.length / 2)]} ms, max ${nums[nums.length - 1]} ms, misses ${lat.length - nums.length}, still streaming: ${sc.some((l) => l.includes('lorem ipsum'))}`)
  console.log(`[${label}] box: ${sc.filter((l) => l.includes('z')).slice(-1)[0]?.trim().slice(0, 80) ?? '(none)'}`)
  p.kill()
})().catch((e) => { console.error(e); p.kill(); process.exit(1) })
