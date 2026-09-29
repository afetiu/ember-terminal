/**
 * How long a shell takes to say its first word through node-pty, exactly as Ember
 * spawns it — for each way of naming pwsh, with the bundled conpty.dll and the in-box one.
 *
 *   node scripts/bench-spawn.cjs
 */
const pty = require('@lydell/node-pty')
const { performance } = require('node:perf_hooks')

const candidates = [
  ['alias  pwsh.exe (WindowsApps)', 'C:\\Users\\afeti\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'],
  ['package pwsh.exe', 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe'],
  ['powershell.exe 5.1', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
]

function run(label, exe, useConptyDll, args) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let first = 0
    let prompt = 0
    let text = ''
    const p = pty.spawn(exe, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.env.USERPROFILE, env: process.env, useConptyDll })
    p.onData((d) => {
      if (!first) first = performance.now() - t0
      text += d
      if (!prompt && /[>❯▸$#»]\s*$/.test(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd())) prompt = performance.now() - t0
    })
    const done = () => resolve({ label, useConptyDll, first: Math.round(first), prompt: Math.round(prompt) })
    p.onExit(done)
    setTimeout(() => { try { p.kill() } catch {} ; done() }, 12000)
    // Ask it to leave once it has a prompt, without depending on the prompt regex.
    setTimeout(() => { try { p.write('exit\r') } catch {} }, 6000)
  })
}

;(async () => {
  const integ = 'if(-not $global:__emberOldPrompt){$global:__emberOldPrompt=$function:prompt;function global:prompt{$c=if($?){0}else{1};([char]27+"]133;D;"+$c+[char]7)+([char]27+"]9;9;"+$PWD.ProviderPath+[char]7)+(& $global:__emberOldPrompt)}}'
  const shim = "function global:claude { $real = @(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue)[0]; if (-not $real) { Write-Error 'claude was not found on PATH'; return }; & $real.Source @args }"
  const only = process.argv.includes('--ember-args')
  for (const useConptyDll of only ? [false] : [true, false]) {
    for (const [label, exe] of only ? candidates.slice(0, 1) : candidates) {
      for (const args of only ? [['-NoLogo'], ['-NoLogo', '-NoExit', '-Command', integ], ['-NoLogo', '-NoExit', '-Command', shim + '; ' + integ]] : [['-NoLogo', '-NoProfile'], ['-NoLogo']]) {
        const r = await run(label, exe, useConptyDll, args)
        console.log(`${useConptyDll ? 'bundled conpty' : 'in-box conpty '}  ${label.padEnd(30)} ${args.slice(0, 3).join(' ').slice(0, 28).padEnd(28)} first byte ${String(r.first).padStart(5)} ms   prompt ${String(r.prompt).padStart(5)} ms`)
      }
    }
  }
  process.exit(0)
})()
