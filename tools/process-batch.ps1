<#
.SYNOPSIS
    Process a list of Factorio replay saves through replay-tool, sequentially.

.DESCRIPTION
    A dumb, version-agnostic batch runner. It does NOT detect versions or swap
    Factorio branches -- the caller (a human, or the replay-processing skill)
    groups saves by version, swaps Factorio to match each group, and invokes
    this once per group. See .claude/skills/replay-processing/SKILL.md.

    Each save runs as a child PowerShell process so replay-tool's `exit 1` on
    one save doesn't abort the batch. Per-save logs + a summary land in
    $env:TEMP\replay-batch\. Sequential because Factorio holds a single-instance
    lock during --run-replay.

    -Mode full     install -> playback -> extract -> clean -> `npm run data`
                   (rebuilds built-data/<name>.json). Use when the build
                   pipeline is stable and you want dashboard-ready output.
    -Mode extract  install -> playback -> extract -> clean. STOPS before the
                   build. Use to refresh extracted-data/ only (e.g. after a
                   control.lua change) while build-run-data.mjs is still in flux.

.PARAMETER Runs
    One entry per save, formatted "save.zip=run-name". The save is resolved
    against externalSavesFolder (config.json); run-name is the extracted-data/
    and built-data/ identifier (Actual- prefix stripped by convention).

.PARAMETER Mode
    'full' (default) or 'extract'. See description.

.EXAMPLE
    # Extract-only refresh of three 2.0.77 saves (Factorio already on 2.0.77):
    ./process-batch.ps1 -Mode extract -Runs `
      "Actual DS 2_08_21.zip=DS-2_08_21", `
      "Actual DS 2_11_10.zip=DS-2_11_10", `
      "Actual DS 2_16_34.zip=DS-2_16_34"

.EXAMPLE
    # Full build of a single run:
    ./process-batch.ps1 -Mode full -Runs "DS 2_09_42.zip=DS-2_09_42"
#>
param(
  [Parameter(Mandatory)][string[]]$Runs,
  [ValidateSet('full', 'extract')][string]$Mode = 'full'
)

$ErrorActionPreference = 'Continue'
$repo      = Split-Path $PSScriptRoot -Parent
$tool      = Join-Path $PSScriptRoot 'replay-tool.ps1'
$cfg       = Get-Content (Join-Path $repo 'config.json') -Raw | ConvertFrom-Json
$extracted = $cfg.extractedDataFolder
$built     = Join-Path $repo 'built-data'

$logDir = Join-Path $env:TEMP 'replay-batch'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$summary = Join-Path $logDir "summary-$Mode.txt"

function Log($msg) {
  "$(Get-Date -Format 'HH:mm:ss')  $msg" | Tee-Object -FilePath $summary -Append | Out-Null
}

# Parse "save.zip=run-name" (filenames never contain '='; split on the first).
$parsed = foreach ($r in $Runs) {
  $i = $r.IndexOf('=')
  if ($i -lt 1) { throw "Bad -Runs entry '$r' - expected 'save.zip=run-name'" }
  [pscustomobject]@{ Save = $r.Substring(0, $i).Trim(); Name = $r.Substring($i + 1).Trim() }
}

"=== BATCH ($Mode) START $(Get-Date -Format o) ($($parsed.Count) runs) ===" | Out-File $summary -Encoding utf8
$results = @()
foreach ($r in $parsed) {
  $log   = Join-Path $logDir "$($r.Name).log"
  $start = Get-Date
  Log "[START] $($r.Name)  <-  $($r.Save)  ($Mode)"

  # Each step is a child process so replay-tool's `exit 1` doesn't abort the batch.
  if ($Mode -eq 'full') {
    # `run` chains install + playback + process (extract + clean + build).
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool run $r.Save $r.Name *> $log
  } else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool install  $r.Save          *>  $log
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool playback $r.Save          *>> $log
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool extract  $r.Name $r.Save  *>> $log
  }
  $code = $LASTEXITCODE

  # Success signal = the goal artifact exists AND was written by THIS run.
  # extract mode: a fresh entityLayout.json. full mode: a fresh built-data json.
  $probe = if ($Mode -eq 'full') { Join-Path $built "$($r.Name).json" }
           else { Join-Path $extracted "$($r.Name)\entityLayout.json" }
  $ok    = Test-Path $probe
  $fresh = $ok -and ((Get-Item $probe).LastWriteTime -ge $start)
  $dur   = [int]((Get-Date) - $start).TotalSeconds
  $status = if ($code -eq 0 -and $fresh) { 'OK' } else { 'FAIL' }
  Log "[$status] $($r.Name)  exit=$code  ${dur}s  artifact=$ok fresh=$fresh  (log: $($r.Name).log)"
  $results += [pscustomobject]@{ Run = $r.Name; Status = $status; Seconds = $dur }
}
"=== BATCH ($Mode) COMPLETE $(Get-Date -Format o) ===" | Out-File $summary -Append -Encoding utf8

Write-Host ""
Write-Host "Batch ($Mode) results - logs in $logDir" -ForegroundColor Cyan
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.Status -ne 'OK' })
if ($failed.Count -gt 0) {
  Write-Host "$($failed.Count) run(s) FAILED: $(($failed.Run) -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "All $($results.Count) run(s) OK." -ForegroundColor Green
