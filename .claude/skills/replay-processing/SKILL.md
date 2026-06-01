---
name: replay-processing
description: Use when processing Factorio replay saves into dashboard data on Windows — one run or many. Covers the install→playback→extract→build pipeline via tools/replay-tool.ps1, batch runs via tools/process-batch.ps1, and the version-match-then-swap flow (a replay only plays back on the Factorio version it was recorded in). Triggers on "process this save", "re-collect the runs", "refresh run data", "extract a replay", "rebuild built-data", "add a run to the dashboard", "run the batch".
---

# Replay processing (singleton & batch)

Turn Factorio replay save zips into the dashboard's per-run data. The mechanics
live in [tools/replay-tool.ps1](../../../tools/replay-tool.ps1) and
[tools/process-batch.ps1](../../../tools/process-batch.ps1); this skill is the
*orchestration* layer — version grouping, swap ordering, mode and scope choice —
that those runners can't decide for themselves.

## What the processing is

A replay save records a run's inputs. Processing replays it with our
data-collection `control.lua` injected, and harvests the JSON it exports. Four
stages:

1. **install** — copy the save from the external folder into Factorio's saves
   folder and inject the current `out/control.lua` (the
   [data-collection layer](../../../factorio-replay-analysis/)) into the copy.
2. **playback** — run Factorio headless (`--run-replay`) on that copy at uncapped
   tick rate. `control.lua` auto-exports JSON to Factorio's `script-output/` on
   rocket launch, then the game exits.
3. **extract** — move those JSONs into `extracted-data/<name>/`, then delete the
   working copy from Factorio's saves folder.
4. **build** (`npm run data`) — reshape `extracted-data/<name>/` into the
   dashboard's per-run files: `built-data/<name>.json` + `<name>.map.json`.

### Two modes — where you stop

| Mode | Stages | Output | Depends on |
|---|---|---|---|
| `extract` | install → playback → extract | `extracted-data/<name>/*.json` | `control.lua` only |
| `full` | + build | `built-data/<name>.json` + `.map.json` | `control.lua` + build scripts |

Use **`extract`** when you only need refreshed extractions (e.g. after a
`control.lua` change) and will build/publish separately. Use **`full`** for
dashboard-ready output in one shot. `extract` output can be built later with
`npm run data` — no replay needed.

## Where saves live: external dir vs Factorio saves

Two folders, both set in `config.json`:

- **`externalSavesFolder`** (currently `~/Downloads`) — the *original* replay
  saves. This pipeline only ever **reads** from here; originals are never
  modified or deleted.
- **`factorioSavesFolder`** (Factorio's own saves dir) — the *working copy*.
  `install` writes a `control.lua`-injected copy here; `playback`/`extract`/
  `clean` act on it; `clean` deletes it after extraction.

Which folder a command resolves its save against:

| Command | Save resolved in |
|---|---|
| `version`, `install`, `run` | `externalSavesFolder` (the original) |
| `playback`, `extract`, `clean`, `process` | `factorioSavesFolder` (the working copy) |

`install` preserves the filename, so the same save string works across all of
them. `run` is the one-shot that spans both: it takes the *external* save,
installs it, then plays + extracts the *working copy*.

## First-time setup

Before the first run: copy `config.example.json` to `config.json` and set the
folder paths; install Factorio ≥ 2.0.51 (Steam is auto-detected, or set
`factorioBinary` in config); make sure Node is available (fnm is auto-detected,
or set `nodePath`); then build the collector once with
`./tools/replay-tool.ps1 build`. `extract` mode needs only that. `full` mode also
renders the map sidecar via the FBSR toolchain — a portable JDK 21 + Maven plus a
one-time `vanilla` profile build, all described in
[tools/README.md](../../../tools/README.md). Version swaps additionally require
Steam (see the **steam-version-swap** skill).

## Flow

The same procedure whether a person or an agent is driving it.

### 1. Verify state

- **Which saves** to process (names resolve in `externalSavesFolder`).
- **Each save's version:** `./tools/replay-tool.ps1 version "<save>"`
- **Installed Factorio version:** `./tools/replay-tool.ps1 version` (no arg)
- **Factorio not running** — the single-instance lock blocks `--run-replay`. The
  runner asserts this too, but confirm up front.
- If `control.lua` changed, **rebuild it first:** `./tools/replay-tool.ps1 build`
  (playback bakes in whatever `control.lua` is current).

`version` prints a bare `major.minor.patch` you can capture into a variable.

### 2. Decide how to run

- **Scope:** one save (singleton) or several (batch).
- **Mode:** `extract` or `full` (table above).
- **Path:** headless one-shot (default) vs manual GUI play — for the GUI path use
  the granular subcommands: `install`, play the save in Factorio yourself, then
  `process <name> <save>`.

### 3. Prepare execution

- **Bucket the saves by version.**
- **Order** so the bucket matching the *installed* Factorio runs first (no swap).
- For each other bucket, **swap Factorio to that version right before running it:**
  `./tools/steam-swap-to.ps1 -Branch <version>` (see the **steam-version-swap**
  skill — the `steam://validate` trick dodges Steam's ~6h post-switch cooldown).
- **Minimize swaps:** one per version, never per-save.

### 4. Execute

```powershell
# Singleton, full build:
./tools/replay-tool.ps1 run "DS 2_09_42.zip" DS-2_09_42

# Singleton, extract only:
./tools/process-batch.ps1 -Mode extract -Runs "DS 2_09_42.zip=DS-2_09_42"

# Batch (either mode) — one already-version-matched bucket per call:
./tools/process-batch.ps1 -Mode extract -Runs `
  "Actual DS 2_08_21.zip=DS-2_08_21", `
  "Actual DS 2_11_10.zip=DS-2_11_10", `
  "Actual DS 2_16_34.zip=DS-2_16_34"
```

`process-batch.ps1` runs the list sequentially (Factorio's lock forbids
parallel), each save in its own child process so one failure doesn't abort the
rest, logging to `$env:TEMP\replay-batch\`. Each run is ~5–6 min of playback;
a 6-run bucket ≈ 35 min — launch it in the background and watch
`$env:TEMP\replay-batch\summary-<mode>.txt`.

A full two-bucket batch is just: run bucket A → `steam-swap-to.ps1` → run bucket B.

### 5. Verify

The summary marks each run `OK`/`FAIL` and the runner exits non-zero if any
failed. Spot-check that the artifact is newer than the run start:

```powershell
# extract mode → a fresh entityLayout.json per run
Get-ChildItem extracted-data\<name>\entityLayout.json | Select-Object LastWriteTime, Length
# full mode → a fresh built-data json per run
Get-ChildItem built-data\<name>.json | Select-Object LastWriteTime, Length
```

A `FAIL` with the artifact present but **stale** means a later step threw (e.g.
`npm run data` crashed) while playback + extract actually succeeded — read the
run's log in `$env:TEMP\replay-batch\<name>.log`.

After `extract`-mode runs, the publish steps remain (separate, maintainer-only,
outward-facing — confirm first): `npm run data` per run, then upload
`built-data/*` to R2 + `npm run install:url`.

## Gotchas

- **A replay must run on the Factorio version it was recorded in.** Verified
  behaviour: a save *newer* than the installed Factorio is rejected at load
  within a few seconds — Factorio logs `Error loading replay: Map version
  2.0.77-0 cannot be loaded because it is higher than the game version
  (2.0.76-0)`, exports no JSON, and the runner exits non-zero. (Only the
  newer-save-on-older-Factorio direction was tested; treat any version
  difference as a blocker and match before running.) This is why step 3 buckets
  by version.
- **Run names are yours to choose.** Pass the identifier explicitly as
  `"<save>=<name>"`; there is no automatic save-filename → run-name rule. (The
  current DS saves happen to map e.g. `... 2_16_34.zip` → `DS-2_16_34`, but
  that's just a naming convention, not logic.)
- **Minimize swaps:** process all saves of one version, then swap once.
