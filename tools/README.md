# tools/

The build pipeline that turns a Factorio replay extraction into the per-entity SVG manifest the dashboard's map player consumes.

The actual rendering engine lives in two submodules at the repo root:

- [Factorio-FBSR/](../Factorio-FBSR/) — fork of [demodude4u/Factorio-FBSR](https://github.com/demodude4u/Factorio-FBSR) on branch `replay-analyzer`. Trimmed to the headless rendering core plus `cli/Replay{Render,SvgRender}.java`.
- [Java-Factorio-Data-Wrapper/](../Java-Factorio-Data-Wrapper/) — fork of [demodude4u/Java-Factorio-Data-Wrapper](https://github.com/demodude4u/Java-Factorio-Data-Wrapper) on branch `replay-analyzer`. FBSR's Factorio-data dependency.

Both are tracked as git submodules — `git clone --recurse-submodules` reproduces the exact build.

## Pipeline

```
extracted-data/<run>/*.json
    │  node tools/fbsr-prep.mjs <run>
    ▼
tools/output/<run>.json + <run>.timing.json     (synthetic blueprint + timing sidecar)
    │  java -cp ... ReplaySvgRender <run>.json <run>.svg
    ▼
tools/output/<run>.manifest.json                 (sprite atlas + entity placements)
    │  node dashboard/scripts/map-prep.mjs <run>
    ▼
dashboard/public/map-data/<run>.map.json         (committed; small)
game-data/map-sprites/<run>.json                 (committed; sprite atlas)
```

The Java step is the heavy one; the two Node steps just reshape JSON.

## One-time setup

### Submodules

```powershell
git submodule update --init --recursive
```

If you cloned without `--recurse-submodules`, this fills them in. To pull a newer SHA from a fork's `replay-analyzer` branch later:

```powershell
git -C Factorio-FBSR fetch origin
git -C Factorio-FBSR checkout origin/replay-analyzer
git add Factorio-FBSR
git commit -m "Bump FBSR submodule"
```

### Portable JDK 21 + Maven

Both are gitignored — drop pre-built distributions in:

- `tools/jdk21/jdk-21.0.11+10/` — Adoptium Temurin 21 LTS works. Any JDK 21+ should.
- `tools/maven/apache-maven-3.9.9/` — Apache Maven 3.9+.

Per-shell setup (PowerShell):

```powershell
$env:JAVA_HOME = "$PWD/tools/jdk21/jdk-21.0.11+10"
$env:Path = "$env:JAVA_HOME/bin;$PWD/tools/maven/apache-maven-3.9.9/bin;" + $env:Path
java -version  # → 21.0.11
mvn -version
```

### Vanilla profile bootstrap

> **TODO:** document how the FBSR `profiles/vanilla/` directory is initialised on a new machine.
>
> The trimmed fork ships only `profile.json` (4 KB). FBSR also needs the Factorio data dump and sprite atlases at this path before `ReplaySvgRender` can run — `Profile.vanilla().isReady()` is the gate.
>
> Upstream FBSR's CLI commands that build these (`profile-default-vanilla`, `build`, `build-download`, `build-dump`, `build-assets`, `build-manifest`) were dropped from the fork along with the rest of the blueprint-rendering shell. So on a fresh machine, the bootstrap currently requires a separate clone of upstream `demodude4u/Factorio-FBSR` (or a copy of the populated `profiles/vanilla/` from an existing setup).

## Build

The wrapper installs into the local Maven repo (`~/.m2/`); FBSR depends on it:

```powershell
cd Java-Factorio-Data-Wrapper/FactorioDataWrapper
mvn -DskipTests install

cd ../../Factorio-FBSR/FactorioBlueprintStringRenderer
mvn -DskipTests package
```

Output: `Factorio-FBSR/FactorioBlueprintStringRenderer/target/FactorioBlueprintStringRenderer-0.0.1-SNAPSHOT.jar`.

## Render a run

Three steps, one Node prep + one Java render + one Node post:

```powershell
# 1) Reshape extracted-data/<run>/*.json into FBSR's blueprint shape
node tools/fbsr-prep.mjs <run>

# 2) Render via FBSR — Maven handles the classpath via the exec plugin
cd Factorio-FBSR/FactorioBlueprintStringRenderer
mvn exec:java `
  -Dexec.mainClass=com.demod.fbsr.cli.ReplaySvgRender `
  -Dexec.args="../../tools/output/<run>.json ../../tools/output/<run>.svg"
cd ../..

# 3) Join the manifest with timing sidecar; write the dashboard inputs
node dashboard/scripts/map-prep.mjs <run>
```

`<run>` is the run folder name under `extracted-data/`, e.g. `DS-2_14_45`.

The dashboard's [RunMapPlayer.tsx](../dashboard/src/components/RunMapPlayer.tsx) fetches the resulting `.map.json` and `map-sprites/<run>.json` at runtime.

## What's in here

| File | Purpose |
|---|---|
| [replay-tool.ps1](replay-tool.ps1) | Windows wrapper for the data-collection-layer side (inject control.lua, extract, clean). Doesn't currently cover the FBSR step. |
| [fbsr-prep.mjs](fbsr-prep.mjs) | `extracted-data/<run>/` → `output/<run>.{json,timing.json}`. |
| [bp-export.mjs](bp-export.mjs) | Smoke test — generates a tiny sample blueprint to validate the FBSR install before running on a real run. |
| `output/` | FBSR build outputs + the synthetic-blueprint inputs. Gitignored. |
| `jdk21/`, `maven/`, `dl/` | Portable toolchain + download stash. All gitignored. |
