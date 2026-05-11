// Miners dataset: lifted miner list from minerActivity.json, with the
// per-miner status timeline dropped. Aggregation-free — every miner entry
// is preserved as-is, just stripped of the (~80% size) `statuses` array.
// Stays small enough (~80 KB per run vs ~400 KB raw) to ship inline in
// `<run>.json` and supports both render-time projection (the burner-
// phase widget builds per-resource count series from these) and the map
// pipeline's end-of-run direction folding (uses unitNumber + direction +
// timeRemoved).
//
// Shape:
//   {
//     miners: [
//       {
//         name:       "burner-mining-drill" | "electric-mining-drill" | "pumpjack",
//         unitNumber: 52,                 // stable id; matches entityLayout's
//                                         //   unitNumber and timing sidecar's `un`
//         location:   { x: 36, y: -72 }, // raw entity position
//         direction:  4,                  // raw (build-time) facing — map-prep
//                                         //   uses this to detect rotations
//         timeBuilt:  2097,
//         resources:  ["iron-ore"],       // primary mining target(s)
//         timeRemoved: 145284             // optional, omitted if still alive
//       },
//       ...
//     ]
//   }
//
// Returns null for legacy runs without minerActivity.json so downstream
// consumers (burner widget, map-prep) can degrade gracefully.

import * as fs from 'fs';
import * as path from 'path';

export function buildMiners(runDir) {
  const minerPath = path.join(runDir, 'minerActivity.json');
  if (!fs.existsSync(minerPath)) return null;
  const data = JSON.parse(fs.readFileSync(minerPath, 'utf8'));
  const miners = (data.miners ?? []).map(m => {
    const out = {
      name: m.name,
      unitNumber: m.unitNumber,
      location: m.location,
      direction: m.direction ?? 0,
      timeBuilt: m.timeBuilt,
      resources: m.resources ?? [],
    };
    if (m.timeRemoved != null) out.timeRemoved = m.timeRemoved;
    return out;
  });
  return { miners };
}
