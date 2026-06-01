<#
.SYNOPSIS
    Factorio Replay Analyzer wrapper. Inject control.lua into save zips and extract JSON output.

.DESCRIPTION
    Subcommands:
      install <save>            Inject the built control.lua into a Factorio save zip and
                                copy the modified save into the Factorio saves folder.
                                <save> can be a full path, a filename in the
                                external-saves folder (config: externalSavesFolder),
                                or a glob pattern matched against that folder.
      build                     Run `npm run build` in the repo to regenerate out/control.lua.
      playback <save>           Run an installed save through Factorio --run-replay headlessly
                                (no GUI, no audio, uncapped tick rate). control.lua's auto-export
                                on rocket launch fires the same way it does in the GUI, so
                                JSONs land in script-output/ and Factorio exits cleanly.
                                Requires Factorio >= 2.0.51 (Steam install is auto-detected;
                                override with 'factorioBinary' in config.json).
      extract <name> [save]     Move all *.json files from Factorio's script-output folder
                                into extracted-data/<name>/. If [save] is given, also delete
                                that save from the Factorio saves folder afterwards.
      process <name> [save]     Full post-replay pipeline: extract JSONs, optionally clean
                                the save, then rebuild dashboard data via `npm run data`
                                so the new run shows up in the React app.
      run <external-save> <name>
                                One-shot end-to-end pipeline: install -> headless playback ->
                                extract -> clean save -> rebuild dashboard. Replaces the
                                manual GUI play step entirely. Same Factorio version requirement
                                as `playback`.
      clean <save>              Delete a save from the Factorio saves folder. <save> can be
                                a filename (with or without .zip) or a glob. The original
                                save in externalSavesFolder is never touched.
      version [save]            Print a Factorio version as "major.minor.patch". With no
                                arg, the installed binary's version; with a save (external
                                folder), the version that save was created in. Used to
                                group saves before a branch swap (--run-replay needs a match).
      list-saves [pat]          List zip files in externalSavesFolder, optionally filtered.
      list-installed            List saves currently in the Factorio saves folder.
      config                    Print the resolved configuration.

    Configuration is read from ../config.json (relative to this script).

    Typical workflow (manual GUI play):
      replay-tool install  "DSMP 01_47_59.zip"
      <play in Factorio, save, run /export-replay-data>
      replay-tool process  DSMP-run-1 "DSMP 01_47_59.zip"     # extract + clean + rebuild dashboard

    Typical workflow (headless, one-shot):
      replay-tool run      "Actual DS 2_16_04.zip" DS-2_16_04  # install + headless play + process

.EXAMPLE
    ./replay-tool.ps1 install "DSMP 01_47_59.zip"
    ./replay-tool.ps1 list-saves "DSMP*"
    ./replay-tool.ps1 build
    ./replay-tool.ps1 playback "Actual DS 2_16_04.zip"
    ./replay-tool.ps1 extract DSMP-run-1
    ./replay-tool.ps1 extract DSMP-run-1 "DSMP 01_47_59.zip"
    ./replay-tool.ps1 process DSMP-run-1 "DSMP 01_47_59.zip"
    ./replay-tool.ps1 run "Actual DS 2_16_04.zip" DS-2_16_04
    ./replay-tool.ps1 clean "DSMP 01_47_59.zip"
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'build', 'playback', 'extract', 'process', 'run', 'clean', 'version', 'list-saves', 'list-installed', 'config', 'help')]
    [string]$Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Config {
    $configPath = Join-Path $PSScriptRoot '..\config.json'
    if (-not (Test-Path $configPath)) {
        throw "Config file not found at $configPath"
    }
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    foreach ($p in @('repoPath', 'controlLuaPath', 'externalSavesFolder', 'factorioSavesFolder', 'factorioScriptOutput', 'extractedDataFolder', 'dashboardPath')) {
        if (-not $cfg.PSObject.Properties.Name.Contains($p)) {
            throw "Config is missing required key: $p"
        }
    }
    return $cfg
}

function Ensure-NodeOnPath {
    <#
        npm is invoked via the .cmd shim or directly from PowerShell, neither of
        which inherits fnm's shell-managed PATH. If npm isn't already discoverable,
        either honour an explicit config override or pick the highest-versioned
        installation under fnm's node-versions directory.
    #>
    param([object]$Config)

    if (Get-Command npm -ErrorAction SilentlyContinue) { return }

    $candidate = $null
    if ($Config -and $Config.PSObject.Properties.Name.Contains('nodePath') -and -not [string]::IsNullOrWhiteSpace($Config.nodePath)) {
        $candidate = $Config.nodePath
    } else {
        $fnmRoot = Join-Path $env:APPDATA 'fnm\node-versions'
        if (Test-Path -LiteralPath $fnmRoot) {
            $latest = Get-ChildItem -Path $fnmRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } |
                Sort-Object @{Expression = { [version]($_.Name.Substring(1)) }} -Descending |
                Select-Object -First 1
            if ($latest) {
                $candidate = Join-Path $latest.FullName 'installation'
            }
        }
    }

    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) {
        throw "npm not found on PATH and no Node installation could be located. Install Node, or set 'nodePath' in config.json."
    }

    $env:Path = "$candidate;" + $env:Path
}

function Resolve-SaveInput {
    param([string]$InputArg, [string]$ExternalSavesFolder)

    if ([string]::IsNullOrWhiteSpace($InputArg)) {
        throw "install requires a save argument (path, filename, or glob)"
    }

    if (Test-Path -LiteralPath $InputArg -PathType Leaf) {
        return (Resolve-Path -LiteralPath $InputArg).Path
    }

    $candidate = Join-Path $ExternalSavesFolder $InputArg
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    $matches = @(Get-ChildItem -Path $ExternalSavesFolder -Filter $InputArg -File -ErrorAction SilentlyContinue)
    if ($matches.Count -eq 1) {
        return $matches[0].FullName
    }
    if ($matches.Count -gt 1) {
        Write-Host "Multiple matches in $ExternalSavesFolder :" -ForegroundColor Yellow
        $matches | ForEach-Object { Write-Host "  $($_.Name)" }
        throw "Be more specific."
    }
    throw "Save not found: '$InputArg' (checked literal path and $ExternalSavesFolder)"
}

function Resolve-FactorioSave {
    <#
        Resolve a save argument against the Factorio saves folder. Accepts a filename
        with or without .zip, or a glob. Returns the full path to a single matching zip.
    #>
    param([string]$InputArg, [string]$SavesFolder)

    if ([string]::IsNullOrWhiteSpace($InputArg)) {
        throw "save name is required"
    }
    if (-not (Test-Path -LiteralPath $SavesFolder)) {
        throw "Factorio saves folder not found: $SavesFolder"
    }

    $candidates = @()
    $candidates += Join-Path $SavesFolder $InputArg
    if ($InputArg -notmatch '\.zip$') { $candidates += Join-Path $SavesFolder ($InputArg + '.zip') }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { return (Resolve-Path -LiteralPath $c).Path }
    }

    $patterns = @($InputArg)
    if ($InputArg -notmatch '\.zip$') { $patterns += ($InputArg + '.zip') }
    foreach ($p in $patterns) {
        $matches = @(Get-ChildItem -Path $SavesFolder -Filter $p -File -ErrorAction SilentlyContinue)
        if ($matches.Count -eq 1) { return $matches[0].FullName }
        if ($matches.Count -gt 1) {
            Write-Host "Multiple matches in saves folder:" -ForegroundColor Yellow
            $matches | ForEach-Object { Write-Host "  $($_.Name)" }
            throw "Be more specific."
        }
    }
    throw "Save not found in $SavesFolder : '$InputArg'"
}

function Update-ZipEntry {
    <#
        Replace (or add) a single entry inside a zip archive in-place.
        $EntryPath is the path WITHIN the zip. $SourceFile is the path on disk.
    #>
    param(
        [string]$ZipPath,
        [string]$EntryPath,
        [string]$SourceFile
    )

    $archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        $existing = $archive.Entries | Where-Object { $_.FullName -ieq $EntryPath }
        foreach ($e in $existing) { $e.Delete() }

        $newEntry = $archive.CreateEntry($EntryPath, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $newEntry.Open()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($SourceFile)
            $entryStream.Write($bytes, 0, $bytes.Length)
        } finally {
            $entryStream.Close()
        }
    } finally {
        $archive.Dispose()
    }
}

function Get-SaveInternalFolder {
    <#
        Factorio save zips contain a single top-level folder. Detect its name by looking
        for an existing control.lua entry (or any entry).
    #>
    param([string]$ZipPath)

    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $controlEntry = $archive.Entries | Where-Object { $_.FullName -match '^[^/]+/control\.lua$' } | Select-Object -First 1
        if ($controlEntry) {
            return ($controlEntry.FullName -split '/')[0]
        }
        $any = $archive.Entries | Where-Object { $_.FullName -match '^[^/]+/' } | Select-Object -First 1
        if ($any) {
            return ($any.FullName -split '/')[0]
        }
        throw "Could not detect internal save folder in $ZipPath"
    } finally {
        $archive.Dispose()
    }
}

function Get-SaveFactorioVersion {
    <#
        Read the Factorio version a save was created in. The save's level-init.dat
        opens with the map version header: three little-endian uint16s
        (major, minor, patch). This is the version --run-replay must match, so the
        replay-processing skill reads it to group saves before swapping branches.
    #>
    param([string]$ZipPath)

    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entry = $archive.Entries | Where-Object { $_.FullName -match '/level-init\.dat$' } | Select-Object -First 1
        if (-not $entry) { throw "No level-init.dat in $ZipPath (not a Factorio save?)" }
        $stream = $entry.Open()
        try {
            $buf = New-Object byte[] 6
            if ($stream.Read($buf, 0, 6) -lt 6) { throw "level-init.dat too short in $ZipPath" }
            $major = [BitConverter]::ToUInt16($buf, 0)
            $minor = [BitConverter]::ToUInt16($buf, 2)
            $patch = [BitConverter]::ToUInt16($buf, 4)
            return "$major.$minor.$patch"
        } finally {
            $stream.Close()
        }
    } finally {
        $archive.Dispose()
    }
}

function Get-InstalledFactorioVersion {
    param([object]$Config)
    $binary = Resolve-FactorioBinary -Config $Config
    $first  = & $binary --version 2>&1 | Select-Object -First 1
    if ($first -match 'Version:\s*(\d+\.\d+\.\d+)') { return $Matches[1] }
    return "$first"
}

function Invoke-Version {
    <#
        No save arg  -> the installed Factorio binary's version.
        With a save  -> the Factorio version that save was created in.
        Prints a bare "major.minor.patch" so callers can capture it directly.
    #>
    param([string]$SaveArg, [object]$Config)

    if ([string]::IsNullOrWhiteSpace($SaveArg)) {
        Write-Output (Get-InstalledFactorioVersion -Config $Config)
        return
    }
    $sourceZip = Resolve-SaveInput -InputArg $SaveArg -ExternalSavesFolder $Config.externalSavesFolder
    Write-Output (Get-SaveFactorioVersion -ZipPath $sourceZip)
}

function Invoke-Install {
    param([string]$SaveArg, [object]$Config)

    if (-not (Test-Path -LiteralPath $Config.controlLuaPath)) {
        throw "control.lua not found at $($Config.controlLuaPath). Run: replay-tool.ps1 build"
    }

    $sourceZip = Resolve-SaveInput -InputArg $SaveArg -ExternalSavesFolder $Config.externalSavesFolder
    $destZip   = Join-Path $Config.factorioSavesFolder ([System.IO.Path]::GetFileName($sourceZip))

    if (-not (Test-Path -LiteralPath $Config.factorioSavesFolder)) {
        New-Item -ItemType Directory -Path $Config.factorioSavesFolder -Force | Out-Null
    }

    Write-Host "Source:  $sourceZip"
    Write-Host "Dest:    $destZip"

    Copy-Item -LiteralPath $sourceZip -Destination $destZip -Force

    $internalFolder = Get-SaveInternalFolder -ZipPath $destZip
    $entryPath = "$internalFolder/control.lua"
    Write-Host "Injecting -> $entryPath"

    Update-ZipEntry -ZipPath $destZip -EntryPath $entryPath -SourceFile $Config.controlLuaPath

    Write-Host ""
    Write-Host "Done. Open Factorio and load the save '$internalFolder'." -ForegroundColor Green
    Write-Host "After running the replay and saving, run /export-replay-data in-game,"
    Write-Host "then: replay-tool.ps1 extract <run-name>"
}

function Invoke-Build {
    param([object]$Config)
    Ensure-NodeOnPath -Config $Config
    Push-Location $Config.repoPath
    try {
        Write-Host "Running: npm run build"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
        Write-Host "Built: $($Config.controlLuaPath)" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

function Invoke-Extract {
    param([string]$Name, [string]$SaveToClean, [object]$Config)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "extract requires a name (used as the destination subfolder)"
    }

    $src = $Config.factorioScriptOutput
    if (-not (Test-Path -LiteralPath $src)) {
        throw "Factorio script-output not found at $src. Has the replay been exported yet?"
    }

    $jsonFiles = @(Get-ChildItem -Path $src -Filter '*.json' -File)
    if ($jsonFiles.Count -eq 0) {
        Write-Host "No *.json files found in $src" -ForegroundColor Yellow
        return
    }

    $destDir = Join-Path $Config.extractedDataFolder $Name
    if (Test-Path -LiteralPath $destDir) {
        $existingCount = @(Get-ChildItem -Path $destDir -File).Count
        if ($existingCount -gt 0) {
            Write-Host "Destination $destDir already has $existingCount file(s). Overwriting." -ForegroundColor Yellow
        }
    } else {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    foreach ($f in $jsonFiles) {
        $dest = Join-Path $destDir $f.Name
        Move-Item -LiteralPath $f.FullName -Destination $dest -Force
        Write-Host "  $($f.Name) -> $destDir"
    }
    Write-Host "Moved $($jsonFiles.Count) file(s) to $destDir" -ForegroundColor Green

    if (-not [string]::IsNullOrWhiteSpace($SaveToClean)) {
        Write-Host ""
        Invoke-Clean -SaveArg $SaveToClean -Config $Config
    }
}

function Invoke-BuildDashboardData {
    <#
        Run `npm run data -- <run-folder>` in dashboardPath. build-run-data.mjs
        accepts absolute paths, so we pass the resolved extracted-data subfolder
        directly — no relative-path computation needed (and avoids depending on
        [System.IO.Path]::GetRelativePath which Windows PowerShell 5.1 lacks).
    #>
    param([string]$Name, [object]$Config)

    $runFolder = Join-Path $Config.extractedDataFolder $Name
    if (-not (Test-Path -LiteralPath $runFolder)) {
        throw "Extracted-data folder not found: $runFolder"
    }
    if (-not (Test-Path -LiteralPath $Config.dashboardPath)) {
        throw "Dashboard path not found: $($Config.dashboardPath)"
    }

    Ensure-NodeOnPath -Config $Config
    Push-Location $Config.dashboardPath
    try {
        Write-Host "Running: npm run data -- `"$runFolder`""
        npm run data -- $runFolder
        if ($LASTEXITCODE -ne 0) { throw "npm run data failed (exit $LASTEXITCODE)" }
        Write-Host "Dashboard data rebuilt for $Name." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

function Invoke-Process {
    param([string]$Name, [string]$SaveToClean, [object]$Config)

    Invoke-Extract -Name $Name -SaveToClean $SaveToClean -Config $Config
    Write-Host ""
    Invoke-BuildDashboardData -Name $Name -Config $Config
}

function Resolve-FactorioBinary {
    <#
        Locate factorio.exe. Priority: explicit config override -> Steam install ->
        standalone install. The standalone install is often pinned to an older
        version (e.g. 1.1.x), so version is verified by Assert-FactorioVersionSupportsRunReplay
        before --run-replay is used.
    #>
    param([object]$Config)

    if ($Config.PSObject.Properties.Name.Contains('factorioBinary') -and -not [string]::IsNullOrWhiteSpace($Config.factorioBinary)) {
        if (Test-Path -LiteralPath $Config.factorioBinary -PathType Leaf) {
            return $Config.factorioBinary
        }
        throw "factorioBinary in config.json is set but the path doesn't exist: $($Config.factorioBinary)"
    }

    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Steam\steamapps\common\Factorio\bin\x64\factorio.exe'),
        (Join-Path $env:ProgramFiles            'Factorio\bin\x64\factorio.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c }
    }
    throw "Factorio binary not found. Set 'factorioBinary' in config.json (must be Factorio >= 2.0.51 for --run-replay)."
}

function Assert-FactorioVersionSupportsRunReplay {
    param([string]$Binary)

    $first = & $Binary --version 2>&1 | Select-Object -First 1
    if ($first -match 'Version:\s*(\d+)\.(\d+)\.(\d+)') {
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]
        $isSupported = ($major -gt 2) -or ($major -eq 2 -and $minor -gt 0) -or ($major -eq 2 -and $minor -eq 0 -and $patch -ge 51)
        if (-not $isSupported) {
            throw "Factorio at $Binary is $major.$minor.$patch; --run-replay requires >= 2.0.51. Set 'factorioBinary' in config.json to point at a newer install."
        }
        return "$major.$minor.$patch"
    }
    Write-Host "Warning: could not parse Factorio version from '$first'; proceeding anyway." -ForegroundColor Yellow
    return $null
}

function Assert-FactorioNotRunning {
    $procs = @(Get-Process -Name 'factorio' -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
        $pids = ($procs | ForEach-Object { $_.Id }) -join ', '
        throw "Factorio is already running (PID $pids). The single-instance lock prevents --run-replay from launching alongside it. Close Factorio and retry."
    }
}

function Invoke-Playback {
    <#
        Run an installed save headlessly via factorio.exe --run-replay. Streams stdout/stderr
        to a timestamped log file in $env:TEMP (the script-init enum dump alone is ~18k lines,
        too noisy to print to the console) and reports elapsed wall-clock every 30s.
        control.lua exits the game cleanly after auto-export on rocket launch.
    #>
    param(
        [string]$SaveArg,
        [object]$Config,
        [string]$Binary
    )

    Assert-FactorioNotRunning
    if (-not $Binary) { $Binary = Resolve-FactorioBinary -Config $Config }
    $version = Assert-FactorioVersionSupportsRunReplay -Binary $Binary

    $savePath = Resolve-FactorioSave -InputArg $SaveArg -SavesFolder $Config.factorioSavesFolder

    # Clear stale flat JSONs so the auto-export of THIS run is what we extract later.
    $stale = @(Get-ChildItem -Path $Config.factorioScriptOutput -Filter '*.json' -File -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) {
        Write-Host "Removing $($stale.Count) stale *.json file(s) from script-output/" -ForegroundColor Yellow
        $stale | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    }

    $logDir = Join-Path $env:TEMP 'factorio-replay-headless'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $logDir "$stamp.stdout.log"
    $stderr = Join-Path $logDir "$stamp.stderr.log"

    Write-Host "Binary:  $Binary$(if ($version) { " ($version)" })"
    Write-Host "Save:    $savePath"
    Write-Host "Log:     $stdout"
    Write-Host "Running headless replay (no GUI, audio disabled, uncapped tick rate)..." -ForegroundColor Cyan

    # Start-Process joins -ArgumentList array entries with spaces but does NOT quote
    # entries that contain spaces (verified failure on Windows PowerShell 5.1 — Factorio
    # received the save path truncated at the first space). Build a single quoted
    # CommandLine string instead so the child gets the path intact.
    $argString = '--run-replay "{0}" --disable-audio' -f $savePath

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $Binary `
                          -ArgumentList $argString `
                          -NoNewWindow -PassThru `
                          -RedirectStandardOutput $stdout `
                          -RedirectStandardError  $stderr

    $lastReport = 0
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 5
        $elapsed = [int]$sw.Elapsed.TotalSeconds
        if (($elapsed - $lastReport) -ge 30) {
            Write-Host "  $elapsed s elapsed (PID $($proc.Id))..."
            $lastReport = $elapsed
        }
    }
    $proc.WaitForExit()
    $sw.Stop()
    # On Windows PowerShell 5.1, Start-Process -RedirectStandardOutput leaves .ExitCode as
    # $null even after WaitForExit (verified). Treat the actual goal — JSONs in
    # script-output/ — as the success signal. Exit code is informational.
    $code      = $proc.ExitCode
    $jsonCount = @(Get-ChildItem -Path $Config.factorioScriptOutput -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
    $elapsedS  = [math]::Round($sw.Elapsed.TotalSeconds, 1)

    if ($jsonCount -gt 0) {
        Write-Host "Headless playback complete in ${elapsedS}s. Exported $jsonCount JSON file(s) to script-output/." -ForegroundColor Green
        if ($null -ne $code -and $code -ne 0) {
            Write-Host "Note: Factorio reported exit code $code, but the export landed. See log: $stdout" -ForegroundColor Yellow
        }
        return
    }

    # No JSONs — real failure. Surface diagnostics.
    Write-Host "--- last 15 stdout lines ---" -ForegroundColor Yellow
    Get-Content -LiteralPath $stdout -Tail 15 | ForEach-Object { Write-Host "  $_" }
    if ((Test-Path -LiteralPath $stderr) -and (Get-Item -LiteralPath $stderr).Length -gt 0) {
        Write-Host "--- stderr ---" -ForegroundColor Yellow
        Get-Content -LiteralPath $stderr | ForEach-Object { Write-Host "  $_" }
    }
    $codeLabel = if ($null -eq $code) { '(unknown)' } else { $code }
    throw "Factorio --run-replay produced no *.json in $($Config.factorioScriptOutput) after ${elapsedS}s. Exit code: $codeLabel. See log: $stdout"
}

function Invoke-Run {
    <#
        One-shot end-to-end pipeline: install -> headless playback -> extract + clean + rebuild
        dashboard. Replaces the manual GUI play step. Validates Factorio binary up front so
        the install step's mutations don't run if the playback step would fail anyway.
    #>
    param([string]$ExternalSaveArg, [string]$Name, [object]$Config)

    if ([string]::IsNullOrWhiteSpace($ExternalSaveArg)) {
        throw "run requires an external save (path, filename, or glob in externalSavesFolder)"
    }
    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "run requires a name (used as the dashboard run identifier, e.g. DS-2_16_04)"
    }

    Assert-FactorioNotRunning
    $binary = Resolve-FactorioBinary -Config $Config
    [void](Assert-FactorioVersionSupportsRunReplay -Binary $binary)

    $sourceZip         = Resolve-SaveInput -InputArg $ExternalSaveArg -ExternalSavesFolder $Config.externalSavesFolder
    $installedSaveName = [System.IO.Path]::GetFileName($sourceZip)

    Write-Host "=== install ===" -ForegroundColor Cyan
    Invoke-Install -SaveArg $ExternalSaveArg -Config $Config

    Write-Host ""
    Write-Host "=== headless playback ===" -ForegroundColor Cyan
    Invoke-Playback -SaveArg $installedSaveName -Config $Config -Binary $binary

    Write-Host ""
    Write-Host "=== process (extract + clean + rebuild dashboard) ===" -ForegroundColor Cyan
    Invoke-Process -Name $Name -SaveToClean $installedSaveName -Config $Config

    Write-Host ""
    Write-Host "Pipeline complete: $Name" -ForegroundColor Green
}

function Invoke-Clean {
    param([string]$SaveArg, [object]$Config)

    $savePath = Resolve-FactorioSave -InputArg $SaveArg -SavesFolder $Config.factorioSavesFolder
    Remove-Item -LiteralPath $savePath -Force
    Write-Host "Removed: $savePath" -ForegroundColor Green
}

function Invoke-ListInstalled {
    param([object]$Config)
    if (-not (Test-Path -LiteralPath $Config.factorioSavesFolder)) {
        Write-Host "Factorio saves folder not found: $($Config.factorioSavesFolder)" -ForegroundColor Yellow
        return
    }
    Get-ChildItem -Path $Config.factorioSavesFolder -Filter '*.zip' -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object Name, @{n='SizeMB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime |
        Format-Table -AutoSize
}

function Invoke-ListSaves {
    param([string]$Pattern, [object]$Config)
    if ([string]::IsNullOrWhiteSpace($Pattern)) { $Pattern = '*.zip' }
    Get-ChildItem -Path $Config.externalSavesFolder -Filter $Pattern -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object Name, @{n='SizeMB';e={[math]::Round($_.Length/1MB,1)}}, LastWriteTime |
        Format-Table -AutoSize
}

function Show-Help {
    Get-Help $PSCommandPath -Detailed
}

# --- dispatch -----------------------------------------------------------------

try {
    $cfg = if ($Command -ne 'help') { Get-Config } else { $null }

    switch ($Command) {
        'install'        { Invoke-Install -SaveArg $Args[0] -Config $cfg }
        'build'          { Invoke-Build -Config $cfg }
        'playback'       { Invoke-Playback -SaveArg $Args[0] -Config $cfg }
        'extract'        { Invoke-Extract -Name $Args[0] -SaveToClean $Args[1] -Config $cfg }
        'process'        { Invoke-Process -Name $Args[0] -SaveToClean $Args[1] -Config $cfg }
        'run'            { Invoke-Run -ExternalSaveArg $Args[0] -Name $Args[1] -Config $cfg }
        'clean'          { Invoke-Clean -SaveArg $Args[0] -Config $cfg }
        'version'        { Invoke-Version -SaveArg ($Args | Select-Object -First 1) -Config $cfg }
        'list-saves'     { Invoke-ListSaves -Pattern $Args[0] -Config $cfg }
        'list-installed' { Invoke-ListInstalled -Config $cfg }
        'config'         { $cfg | Format-List }
        default          { Show-Help }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
