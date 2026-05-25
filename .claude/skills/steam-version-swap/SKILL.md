---
name: steam-version-swap
description: Use when swapping a Steam app's installed branch/version headlessly on Windows (no Steam UI). Covers the appmanifest BetaKey edit + steam://validate bypass for Steam's server-side post-branch-switch cooldown. Triggers on requests like "swap Factorio to 2.0.X", "match Factorio version to save", "headless Steam version swap", or any task that needs to programmatically change a Steam app's branch.
---

# Steam headless version swap (Windows)

## When to use

Headless swap of a Steam app to a named beta branch (e.g. Factorio's per-patch `2.0.76` branches, or generic `experimental` / `stable`). For arbitrary historical patches not published as a named branch, prefer SteamCMD `+download_depot <appid> <depotid> <manifestid>` or the vendor's download site instead — they bypass Steam entirely.

## The trick

After editing `appmanifest_<appid>.acf` and restarting Steam, the client applies a **server-side ~6h cooldown** (`Update delayed for ~20000 secs` in `content_log.txt`). Local file edits don't move it (tested — `LastUpdated` rewrites had no effect). **Fire `steam://validate/<appid>` after restart — it bypasses the cooldown** (`update disabled for 0 seconds`). The Steam GUI's Properties→Betas path bypasses similarly, but only validate is headless.

## Recipe (PowerShell)

```powershell
$appid = 427520           # Factorio; change for other apps
$branch = "2.0.77"        # target branch name as in Steam's beta list
$targetBuildId = "23347942"  # look up via SteamDB beforehand
$manifest = "C:\Program Files (x86)\Steam\steamapps\appmanifest_$appid.acf"

# 1. Shut down Steam (must be down to safely edit manifest)
& "C:\Program Files (x86)\Steam\steam.exe" -shutdown
Get-Process -Name steam -ErrorAction SilentlyContinue | Wait-Process -Timeout 30

# 2. Backup + edit both BetaKey entries (UserConfig + MountedConfig)
Copy-Item $manifest "$manifest.bak" -Force
$content = Get-Content $manifest -Raw
Set-Content $manifest -Value ($content -replace '("BetaKey"\s+)"[^"]*"', "`$1`"$branch`"") -NoNewline

# 3. Restart Steam silently (no library window)
Start-Process "C:\Program Files (x86)\Steam\steam.exe" -ArgumentList "-silent"
Start-Sleep -Seconds 20

# 4. Bypass the cooldown
Start-Process "steam://validate/$appid"

# 5. Poll buildid until it matches target
while (-not (Select-String -Path $manifest -Pattern "`"buildid`"\s+`"$targetBuildId`"" -Quiet)) {
  Start-Sleep -Seconds 5
}
```

## Gotchas

- **Both BetaKey lines** must match — `UserConfig.BetaKey` (the branch the user opted into) and `MountedConfig.BetaKey` (the branch currently materialized). Editing only one creates a state mismatch.
- **`steam://install/<appid>` does NOT work** for already-installed apps; Steam treats it as a no-op. Use `validate`.
- **Validate is a full re-verify**, so it pulls ~2× the bytes of a pure delta update. Acceptable cost for being headless.
- **Cooldown value varies** (~5–6h, server-side, computed per request). Don't try to interpret or pre-compute it locally — just bypass with validate.
