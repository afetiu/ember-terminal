# Install or update Ember from a terminal.
#
#   PowerShell:  irm https://ember.deepanswerlabs.com/install.ps1 | iex
#   cmd:         powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://ember.deepanswerlabs.com/install.ps1 | iex"
#
# Downloads the latest installer from the GitHub release, checks it against the release's
# SHA256SUMS.txt, installs it for you alone (no admin prompt) without any windows, and
# starts Ember. Running it again updates Ember to the latest release.
#
# Set EMBER_INSTALL_DRYRUN=1 to download and check the installer without running it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'afetiu/ember-terminal'
$base = "https://github.com/$repo/releases/latest/download"
$file = 'Ember-Setup-win-x64.exe'

function Say([string]$text) { Write-Host "  $text" }

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  Write-Host 'Ember runs on 64-bit Windows 10 and 11.' -ForegroundColor Red
  return
}

$version = ''
try { $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'ember-install' }).tag_name } catch {}
Write-Host ''
Write-Host "Ember $version" -ForegroundColor Yellow

# The installer cannot replace files Ember is running from.
if (-not $env:EMBER_INSTALL_DRYRUN -and (Get-Process -Name 'Ember' -ErrorAction SilentlyContinue)) {
  Write-Host 'Ember is running. Close it, then run this again.' -ForegroundColor Red
  return
}

$dir = Join-Path ([IO.Path]::GetTempPath()) "ember-install-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $dir | Out-Null
$exe = Join-Path $dir $file

try {
  Say 'Downloading...'
  Invoke-WebRequest "$base/$file" -OutFile $exe -UseBasicParsing

  Say 'Checking it...'
  $sums = (Invoke-WebRequest "$base/SHA256SUMS.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($file) } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS.txt has no line for $file" }
  $want = ($line.Trim() -split '\s+')[0].ToLower()
  # .NET rather than Get-FileHash: Windows PowerShell started from PowerShell 7 inherits a
  # module path where Get-FileHash does not load.
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::OpenRead($exe)
  try { $got = ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() } finally { $fs.Dispose(); $sha.Dispose() }
  if ($got -ne $want) { throw "The download does not match the release checksum ($got, expected $want)." }

  if ($env:EMBER_INSTALL_DRYRUN) {
    Say "Checked: $got"
    Say "Dry run: not installed. The installer is at $exe"
    return
  }

  Say 'Installing...'
  $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "The installer stopped with code $($p.ExitCode)." }

  # Where it went: the installer's own Apps & Features entry, else the per-user default.
  $app = Join-Path $env:LOCALAPPDATA 'Programs\Ember\Ember.exe'
  $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Ember *' -and $_.InstallLocation } | Select-Object -First 1
  if ($entry -and (Test-Path (Join-Path $entry.InstallLocation 'Ember.exe'))) { $app = Join-Path $entry.InstallLocation 'Ember.exe' }
  Write-Host ''
  Write-Host "Ember $version is installed." -ForegroundColor Green
  if (Test-Path $app) {
    Say 'Starting it.'
    Start-Process -FilePath $app
  } else {
    Say 'Start it from the Start menu.'
  }
} catch {
  Write-Host ''
  Write-Host "Could not install Ember: $($_.Exception.Message)" -ForegroundColor Red
  Say "Download it from https://ember.deepanswerlabs.com instead."
} finally {
  if (-not $env:EMBER_INSTALL_DRYRUN) { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
}
