# dashboard/scripts/diagnostics/

Generalized, parameterized probes for interrogating the flow pipeline. Unlike the
one-off investigation in `ad-hoc-analysis/` (gitignored), these are **tracked,
reusable tools**.

They replace a family of deleted one-off probes that each hardcoded a single
segment / tile / unit (`_probe-721`, `inspect-S285`, `_atloc`, `trace-s727-iron`, …).
The shape was evergreen; the hardcoded target wasn't.

## "Across datasets" = across data layers, one run

A single run fans out into many datasets — the **raw collector** JSONs
(`entityLayout`, `machineProduction`, `minerActivity`, `bufferAmounts`) and the
**derived flow stack** (merged entities → events → segments → edges). The probes
take ONE target and show what **every layer** says about it, joined on
`unitNumber`, and flag where the layers **diverge** — which is exactly how you
catch pipeline bugs (a belt linking to a non-existent unit = ghost belt; an entity
in one layer but missing from the next; a live belt in no segment).

The shared core in `probe-lib.mjs` is the **per-unit cross-layer dossier**; the
three probes are entry points into it by space / topology / time. They operate on
**one run** (defaults to the newest dataset by mtime; `--run <name>` to pick;
`--until <tick>` to clip to a tick, e.g. rocket launch — full save otherwise).
Output is terse: one line per unit, full per-layer breakdown behind `--verbose`,
lists capped with an explicit `+N more`.

> The cluster layer (`lib/flow/clusters.mjs`) is not yet wired into `buildFlow`,
> so the dossier marks it pending rather than show possibly-wrong groupings.

## probe-at `<x> <y> [w] [h] [--run X] [--verbose]` — spatial
Every entity at a tile (or w×h region anchored at x,y), each across all layers.
```
node dashboard/scripts/diagnostics/probe-at.mjs 90 0
node dashboard/scripts/diagnostics/probe-at.mjs 88 -4 10 24 --run DS-2_14_45 --verbose
```
Entities match by anchor location; a multi-tile machine/splitter is reported at
its anchor, not every tile it covers.

## probe-segment `<segId> [--run X] [--verbose]` — topology
A belt segment's record (lifetime, bbox, lineage), each **member belt** across the
layers, and the edges feeding / draining it.
```
node dashboard/scripts/diagnostics/probe-segment.mjs S-159
node dashboard/scripts/diagnostics/probe-segment.mjs 159 --run DS-2_14_45 --verbose
```

## probe-events `(--unit N | --seg S | --from T --to T | --type K) [--run X] [--limit N]` — temporal
With `--unit`, a **unified timeline** for one entity: synthesised flow events +
raw `machineProduction` / `minerActivity` / `bufferAmounts` transitions + edge
births/retires, interleaved by tick. With `--seg`, the events of a segment's
member belts. Otherwise a filtered event stream (each line annotated with its
segment).
```
node dashboard/scripts/diagnostics/probe-events.mjs --unit 36
node dashboard/scripts/diagnostics/probe-events.mjs --seg S-159 --from 139000 --to 140000
```

## check-belt-reciprocity `<run-name | run-folder | path/to/entityLayout.json>` — post-collection gate
Not a probe — a **pass/fail regression check** over the raw `entityLayout`. A
physical feed edge `f->c` is reciprocal iff `f.beltOutputs` lists `c` AND
`c.beltInputs` lists `f`; it checks both directions at every tick of each edge's
shared lifetime. The game keeps `belt_neighbours` reciprocal every tick (verified
headless), so any one-sided edge is a collector read/update-timing bug. Exits
non-zero on any one-sided edge — `replay-tool extract` runs it automatically after
each collection.
```
node dashboard/scripts/diagnostics/check-belt-reciprocity.mjs DS-2_02_56
```

## probe-lib.mjs
The layer loader (`loadLayers` → raw collectors + merged + events + segments +
edges), the cross-layer `dossierLine` / `dossierBlock` and `divergences`, the
`edgesForUnit` join, run selection (`selectRun`), the segment-state pipeline
(`segStateFromEvents` → `state.segOf` / `.belts` / `.segs`, `membersOf`), and the
`emit` / `fmtLife` / `bboxOf` formatters. Build new probes on these.
