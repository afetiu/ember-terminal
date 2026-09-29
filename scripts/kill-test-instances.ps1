# Kills ONLY the Ember/Electron instances launched from this repo.
#
# Never use `Get-Process Ember | Stop-Process` — that matches by name and will kill
# the copy installed at C:\Program Files\Ember, i.e. the terminal the user is
# actually working in. Filtering on ExecutablePath is the whole point of this file.

$repo = (Resolve-Path "$PSScriptRoot\..").Path.TrimEnd('\')

$targets = Get-CimInstance Win32_Process -Filter "Name='Ember.exe' OR Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase) }

if (-not $targets) {
  Write-Output 'no repo-local instances running'
  return
}

foreach ($t in $targets) {
  Write-Output "killing $($t.ProcessId)  $($t.ExecutablePath)"
  try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop } catch { Write-Output "  already gone" }
}
