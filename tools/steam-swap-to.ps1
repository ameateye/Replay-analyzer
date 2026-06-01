<#
  Headless Steam branch swap for Factorio (app 427520), per the steam-version-swap skill.
  Edits both BetaKey lines in the appmanifest, restarts Steam -silent, fires steam://validate
  to bypass the server-side post-switch cooldown, then polls factorio --version until it
  reports the target branch (authoritative "is it actually installed" signal -- more robust
  than a hardcoded buildid, which SteamDB Cloudflare-blocks us from looking up).
  Writes progress to $env:TEMP\rerun-collection\swap-status.txt.
#>
param(
  [Parameter(Mandatory)][string]$Branch,           # e.g. "2.0.77"
  [int]$TimeoutSec = 5400                           # 90 min cap on the validate download
)

$ErrorActionPreference = 'Continue'
$appid    = 427520
$steam    = "C:\Program Files (x86)\Steam\steam.exe"
$manifest = "C:\Program Files (x86)\Steam\steamapps\appmanifest_$appid.acf"
$binary   = "C:\Program Files (x86)\Steam\steamapps\common\Factorio\bin\x64\factorio.exe"
$logDir   = Join-Path $env:TEMP 'rerun-collection'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$status   = Join-Path $logDir 'swap-status.txt'

function Log($m) { "$(Get-Date -Format 'HH:mm:ss')  $m" | Out-File $status -Append -Encoding utf8 }
function FactorioVer {
  try { $line = & $binary --version 2>$null | Select-Object -First 1; return "$line" } catch { return "" }
}

"=== STEAM SWAP -> $Branch  START $(Get-Date -Format o) ===" | Out-File $status -Encoding utf8
Log "before: $(FactorioVer)"

# 0. Factorio must not be running.
if (@(Get-Process -Name factorio -ErrorAction SilentlyContinue).Count -gt 0) {
  Log "ABORT: factorio is running"; return
}

# 1. Shut down Steam.
Log "shutting down Steam..."
if (Test-Path $steam) { & $steam -shutdown | Out-Null }
$deadline = (Get-Date).AddSeconds(40)
while ((@(Get-Process -Name steam -ErrorAction SilentlyContinue).Count -gt 0) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Seconds 2
}
Log "steam procs after shutdown: $(@(Get-Process -Name steam -ErrorAction SilentlyContinue).Count)"

# 2. Backup + edit both BetaKey entries.
if (-not (Test-Path $manifest)) { Log "ABORT: manifest not found at $manifest"; return }
Copy-Item $manifest "$manifest.bak" -Force
$content = Get-Content $manifest -Raw
$new = $content -replace '("BetaKey"\s+)"[^"]*"', ("`${1}`"$Branch`"")
# NB: no -Encoding (PS 5.1 default = ANSI). -Encoding utf8 would add a BOM and corrupt the VDF parse.
Set-Content $manifest -Value $new -NoNewline
$check = (Select-String -Path $manifest -Pattern '"BetaKey"\s+"([^"]*)"' -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value }
Log "BetaKey now: $($check -join ', ')"
if ($check -notcontains $Branch) { Log "ABORT: BetaKey edit did not take"; return }

# 3. Restart Steam silently.
Log "restarting Steam -silent..."
Start-Process $steam -ArgumentList "-silent"
Start-Sleep -Seconds 20

# 4. Bypass cooldown with validate.
Log "firing steam://validate/$appid ..."
Start-Process "steam://validate/$appid"

# 5. Poll factorio --version until it reports the target branch.
$swStart = Get-Date
$lastLog = Get-Date
$done = $false
while (((Get-Date) - $swStart).TotalSeconds -lt $TimeoutSec) {
  Start-Sleep -Seconds 20
  $v = FactorioVer
  $bid = ""
  if (Test-Path $manifest) {
    $m = Select-String -Path $manifest -Pattern '"buildid"\s+"(\d+)"' | Select-Object -First 1
    if ($m) { $bid = $m.Matches[0].Groups[1].Value }
  }
  if (((Get-Date) - $lastLog).TotalSeconds -ge 60) {
    Log "polling... ver='$v' buildid=$bid elapsed=$([int]((Get-Date)-$swStart).TotalSeconds)s"
    $lastLog = Get-Date
  }
  if ($v -match [regex]::Escape($Branch)) { $done = $true; break }
}

if ($done) {
  Log "SUCCESS: factorio now $(FactorioVer)"
  "=== STEAM SWAP -> $Branch  DONE OK $(Get-Date -Format o) ===" | Out-File $status -Append -Encoding utf8
} else {
  Log "TIMEOUT after ${TimeoutSec}s. last ver: $(FactorioVer)"
  "=== STEAM SWAP -> $Branch  TIMEOUT $(Get-Date -Format o) ===" | Out-File $status -Append -Encoding utf8
}
