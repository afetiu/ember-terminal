// Smoke test: does the prebuilt N-API ConPTY binding load and actually drive pwsh?
// Run under plain node AND under electron -- if it loads in both, the ABI is stable
// and we can build on it. This is the one thing worth de-risking before writing UI.
const pty = require('@lydell/node-pty')

const shell = process.env.EMBER_TEST_SHELL || 'powershell.exe'
const p = pty.spawn(shell, ['-NoLogo', '-NoProfile', '-Command', 'Write-Output "PTY_OK:$($PSVersionTable.PSVersion)"'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
})

let buf = ''
p.onData((d) => {
  buf += d
})

p.onExit(({ exitCode }) => {
  const hit = /PTY_OK:[^\r\n]*/.exec(buf)
  console.log('runtime      :', process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`)
  console.log('exitCode     :', exitCode)
  console.log('handshake    :', hit ? hit[0] : 'MISSING')
  console.log('bytes        :', buf.length)
  if (typeof process.exit === 'function') process.exit(hit ? 0 : 1)
})

setTimeout(() => {
  console.error('TIMEOUT - no exit after 15s')
  process.exit(2)
}, 15000)
