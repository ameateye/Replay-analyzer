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
      extract <name> [save]     Move all *.json files from Factorio's script-output folder
                                into extracted-data/<name>/. If [save] is given, also delete
                                that save from the Factorio saves folder afterwards.
      clean <save>              Delete a save from the Factorio saves folder. <save> can be
                                a filename (with or without .zip) or a glob. The original
                                save in externalSavesFolder is never touched.
      list-saves [pat]          List zip files in externalSavesFolder, optionally filtered.
      list-installed            List saves currently in the Factorio saves folder.
      config                    Print the resolved configuration.

    Configuration is read from ../config.json (relative to this script).

    Typical workflow:
      replay-tool install  "DSMP 01_47_59.zip"
      <play in Factorio, save, run /export-replay-data>
      replay-tool extract  DSMP-run-1 "DSMP 01_47_59.zip"     # extract + clean in one step

.EXAMPLE
    ./replay-tool.ps1 install "DSMP 01_47_59.zip"
    ./replay-tool.ps1 list-saves "DSMP*"
    ./replay-tool.ps1 build
    ./replay-tool.ps1 extract DSMP-run-1
    ./replay-tool.ps1 extract DSMP-run-1 "DSMP 01_47_59.zip"
    ./replay-tool.ps1 clean "DSMP 01_47_59.zip"
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'build', 'extract', 'clean', 'list-saves', 'list-installed', 'config', 'help')]
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
    foreach ($p in @('repoPath', 'controlLuaPath', 'externalSavesFolder', 'factorioSavesFolder', 'factorioScriptOutput', 'extractedDataFolder')) {
        if (-not $cfg.PSObject.Properties.Name.Contains($p)) {
            throw "Config is missing required key: $p"
        }
    }
    return $cfg
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
        'extract'        { Invoke-Extract -Name $Args[0] -SaveToClean $Args[1] -Config $cfg }
        'clean'          { Invoke-Clean -SaveArg $Args[0] -Config $cfg }
        'list-saves'     { Invoke-ListSaves -Pattern $Args[0] -Config $cfg }
        'list-installed' { Invoke-ListInstalled -Config $cfg }
        'config'         { $cfg | Format-List }
        default          { Show-Help }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
