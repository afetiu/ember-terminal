# A Claude Code-like status line repainting at ~30 fps, for probe-cpu.mjs and probe-jank.mjs
# (and for running the same load in another terminal, to compare).
#   & scripts/spinner.ps1 -Seconds 40
param([int]$Seconds = 40)
# ASCII only: Windows PowerShell reads a BOM-less script as ANSI.
$frames = @('|', '/', '-', '\')
$end = (Get-Date).AddSeconds($Seconds)
$i = 0
while ((Get-Date) -lt $end) {
  $t = [int]((Get-Date) - $end.AddSeconds(-$Seconds)).TotalSeconds
  [Console]::Write("`r$($frames[$i % $frames.Length]) Thinking... ($($t)s - $($i * 7) tokens - esc to interrupt)   ")
  $i++
  Start-Sleep -Milliseconds 33
}
[Console]::WriteLine('')
