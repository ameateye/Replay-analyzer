// Manual gathering analysis — wood / stone / coal accumulated by the
// player from chopping trees and mining rocks. Detected by walking the
// player-inventory snapshots and counting positive deltas, with three
// layered filters that strip out non-mining sources of those deltas.
//
// Filter 1 — per-snapshot delta cap. A single-second snapshot can
// physically only contain so much hand-mining (caps below). Anything
// larger is dropped as an obvious pickup (untracked container, ship-
// wreck cache, picked-up entity returning fuel/input slot, etc.).
//
// Filter 2 — chest-amount-decrease verification (the buffer data, per
// the user's request). For each item, look at all chests that ever held
// that item (heldItems check against the new `contents` shape) and check
// whether they collectively lost amounts of that item inside a wide window
// around the snapshot. If yes, attribute up to the chest decrease as a
// pickup and only count the residual as gathered.
//
// Filter 3 — player-position proximity to pickup-source entities. Each
// item has its own list:
//   wood:  chests with content=wood
//   stone: chests with content=stone + burner-mining-drills on stone +
//          stone / steel furnaces. Furnaces are included because the
//          player can shift-right-click stone back out of a furnace's
//          input slot, which lands as a +stone delta with no chest or
//          miner involvement.
//   coal:  chests with content=coal + ALL burner-mining-drills + stone /
//          steel furnaces. Coal is the universal fuel, so proximity to
//          any of those entities means the player could have shift-
//          right-clicked the fuel slot back into inventory.
//
// Limitations:
//  - Very young chests (built just before the pickup) may have no samples
//    yet in the window, so their decrease won't be detected. Rare in the
//    DS opening; the ~10 s window on each side covers most cases.
//  - Manual mining done immediately adjacent to a placed pickup-source
//    entity (e.g. mining a coal rock right next to a stone furnace
//    cluster) is excluded as a likely pickup. Rare in practice — players
//    don't typically hand-mine inside their factory footprint.
//  - The position sample at the snapshot tick is the only one consulted
//    per snapshot; a player who picked up at an entity then ran ≥10
//    tiles away in the same 60-tick window can leak through. The
//    snapshot period (60 ticks ≈ 1 s) limits how far this can stretch.

import * as fs from 'fs';
import * as path from 'path';
import { RECIPES_GAME_DATA, emptyRecipeRow, tickToMin } from './lib/common.mjs';
import { normalizeBufferFile, heldItems, seriesForItem } from './lib/buffer.mjs';

// Items whose gathering is meaningful past the burner phase. Stone and
// coal mining post-burner-phase is irrelevant to the run analysis (the
// player has electric drills + furnace stacks at that point), and any
// remaining inventory bumps for those items are dominated by pickup
// noise no heuristic catches reliably. Wood chopping continues to
// matter — chests and poles keep being crafted past burner phase end.
const TRACK_POST_BURNER = new Set(['wood']);
// Player reach is 10 tiles in vanilla; a touch wider absorbs jitter from
// a snapshot landing 1–2 tiles after the player turned away from a
// pickup, plus the case of a fast-moving (in-vehicle) player passing
// just outside reach in the middle of an inv-period window.
const PROXIMITY_TILES = 12;
const PROXIMITY_TILES_SQ = PROXIMITY_TILES * PROXIMITY_TILES;
// Buffer-amounts are sampled every ~5 s, so the snapshot window must be
// widened to bracket at least one chest sample on each side. 10 s on each
// side comfortably brackets two samples and absorbs the small jitter
// between the inventory snapshot tick and the chest's next sample tick.
const CHEST_DELTA_WINDOW_TICKS = 10 * 60;
// When the player picks up an entity (e.g. a burner-mining-drill they
// built on a coal/stone patch and is now retiring), the entity vanishes
// from the world and its output buffer + fuel slot return as +inventory
// to the player. The +inventory shows up on the *next* snapshot, by
// which point the entity has timeRemoved ≤ t. Treat entities removed
// within this grace window as still pickup-eligible.
const RECENTLY_REMOVED_GRACE_TICKS = 10 * 60;

// Per-second physical-plausibility cap on a single snapshot delta. Rocks
// in this map yield 20-50 stone or 24-50 coal each; mining one takes
// ~1-2 s, so the snapshot can occasionally bracket two rocks completing.
// Trees yield 4 wood, ~0.5 s each — 4 trees / sec is a stretch.
//   coal:   2 × ~50-yield rocks
//   stone:  same, plus pure-stone rocks
//   wood:   4 trees
// Anything above the cap is dropped as an obvious pickup (untracked
// chest, ship-wreck-style cache, or fuel slot returned by a picked-up
// entity we don't track).
const MAX_DELTA_PER_SEC = { wood: 16, stone: 110, coal: 110 };

export function buildManualGathering(runDir, xMaxTick, phaseEndTick) {
  const invPath = path.join(runDir, 'playerInventory.json');
  const posPath = path.join(runDir, 'playerPosition.json');
  if (!fs.existsSync(invPath) || !fs.existsSync(posPath)) return null;

  const cfg = RECIPES_GAME_DATA.manualGatheringDisplay;
  const groups = cfg?.groups ?? [];
  const rowConfigs = cfg?.rows ?? [];
  if (rowConfigs.length === 0) return null;

  const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
  const pos = JSON.parse(fs.readFileSync(posPath, 'utf8'));
  const buf = normalizeBufferFile(readOptional(path.join(runDir, 'bufferAmounts.json'), { period: 0, buffers: [] }));
  const mine = readOptional(path.join(runDir, 'minerActivity.json'), { period: 0, miners: [] });
  const mp = readOptional(path.join(runDir, 'machineProduction.json'), { period: 0, machines: [] });

  const playerName = Object.keys(inv.players)[0];
  if (!playerName) return null;
  const invSnapshots = inv.players[playerName].inventory;
  const invPeriod = inv.period;

  const positions = pos.players[playerName] ?? [];
  const posPeriod = pos.period;

  const itemKeys = rowConfigs.map(r => r.recipe);
  const allBurnerMiners = mine.miners.filter(m => m.name === 'burner-mining-drill');
  const furnaces = mp.machines.filter(m => m.name === 'stone-furnace' || m.name === 'steel-furnace');

  // Per-item list of "if you're near one of these, your +inventory is
  // probably a pickup, not gathering". Filtered once instead of every
  // tick so the per-snapshot check stays cheap.
  const itemChests = Object.fromEntries(
    itemKeys.map(item => [item, buf.buffers.filter(b => b.type === 'chest' && heldItems(b).includes(item))]),
  );
  const pickupSources = Object.fromEntries(itemKeys.map(item => {
    const chests = itemChests[item];
    if (item === 'coal') {
      return [item, [...chests, ...allBurnerMiners, ...furnaces]];
    }
    if (item === 'stone') {
      const stoneMiners = allBurnerMiners.filter(m => m.resources?.[0] === 'stone');
      // Furnaces hold stone in the input slot when smelting stone-bricks;
      // shift-right-click pulls it back out as a +stone delta without
      // chest or miner involvement.
      return [item, [...chests, ...stoneMiners, ...furnaces]];
    }
    // wood (and any future item without miner / furnace pickup sources)
    return [item, chests];
  }));

  // Convert per-second caps to per-snapshot caps so the heuristic
  // travels across runs that may sample inventory at a different period.
  const periodSec = invPeriod / 60;
  const maxDelta = Object.fromEntries(
    Object.entries(MAX_DELTA_PER_SEC).map(([k, rate]) => [k, Math.ceil(rate * periodSec)]),
  );

  const minutes = [];
  const cum = Object.fromEntries(itemKeys.map(k => [k, []]));
  const totals = Object.fromEntries(itemKeys.map(k => [k, 0]));
  const prev = Object.fromEntries(itemKeys.map(k => [k, 0]));
  const cumAtPhaseEnd = Object.fromEntries(itemKeys.map(k => [k, 0]));
  const phaseEndCaptured = Object.fromEntries(itemKeys.map(k => [k, false]));

  for (let i = 0; i < invSnapshots.length; i++) {
    const tick = i * invPeriod;
    if (tick > xMaxTick) break;
    minutes.push(tickToMin(tick));
    const snap = invSnapshots[i] ?? {};

    // Compute all deltas first so cross-item rules (coal must co-occur
    // with stone — rocks in this map yield both together) can read them.
    const deltas = {};
    for (const item of itemKeys) {
      const cur = snap[item] ?? 0;
      deltas[item] = cur - prev[item];
      prev[item] = cur;
    }

    for (const item of itemKeys) {
      const delta = deltas[item];
      if (delta > 0) {
        const cap = maxDelta[item] ?? Infinity;
        const tooLargeToBeMining = delta > cap;
        // Sweep player positions across the inv-period window — a fast-
        // moving player (often in a vehicle) can be at a pickup source
        // mid-window and far away by the snapshot tick.
        const nearPickupSource = isNearAnyDuringWindow(
          pickupSources[item],
          positions,
          posPeriod,
          tick - invPeriod,
          tick,
        );
        // Coal-only inventory bumps in this map are never from mining —
        // the coal-bearing rocks always drop stone alongside coal. So a
        // +coal sample without a co-occurring +stone sample is a pickup.
        const lacksStonePairing = item === 'coal' && (deltas['stone'] ?? 0) <= 0;
        // Cross-check against the chest data: if any tracked chest of
        // this content lost amounts in a window bracketing this snapshot,
        // attribute up to that drop as pickup and only credit the residual.
        const chestDrop = chestDecreaseInWindow(
          itemChests[item],
          item,
          tick - CHEST_DELTA_WINDOW_TICKS,
          tick + CHEST_DELTA_WINDOW_TICKS,
        );
        const minedPart = Math.max(0, delta - chestDrop);
        const pastBurnerPhase = phaseEndTick != null && tick > phaseEndTick;
        const skipPastPhase = pastBurnerPhase && !TRACK_POST_BURNER.has(item);
        if (!tooLargeToBeMining && !nearPickupSource && !lacksStonePairing && !skipPastPhase) {
          totals[item] += minedPart;
        }
      }
      cum[item].push(totals[item]);
      // Snapshot the running total at the burner-phase boundary so the
      // widget can show "N at phase end" instead of the chart-end total.
      if (!phaseEndCaptured[item] && phaseEndTick != null && tick >= phaseEndTick) {
        cumAtPhaseEnd[item] = totals[item];
        phaseEndCaptured[item] = true;
      }
    }
  }
  // Falling out before phaseEndTick (xMax shorter than phaseEnd) means
  // the phase-end snapshot is just whatever total we ended with.
  for (const item of itemKeys) {
    if (!phaseEndCaptured[item]) cumAtPhaseEnd[item] = totals[item];
  }

  const N = minutes.length;
  // Each row is a Recipe shape with only `cum` populated — tracks how the
  // gathered total grew over time. Phase-end snapshot ships alongside.
  const rows = rowConfigs.map(cfgRow => ({
    ...emptyRecipeRow(N),
    key: cfgRow.key,
    mode: cfgRow.mode,
    recipe: cfgRow.recipe,
    finalCum: totals[cfgRow.recipe] ?? 0,
    cum: cum[cfgRow.recipe] ?? new Array(N).fill(0),
    cumAtPhaseEnd: cumAtPhaseEnd[cfgRow.recipe] ?? totals[cfgRow.recipe] ?? 0,
  }));

  return {
    minutes,
    groups,
    rows,
  };
}

function readOptional(p, fallback) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}

function isNearAnyDuringWindow(entities, positions, posPeriod, t0, t1) {
  if (!positions.length || !posPeriod) return false;
  const i0 = Math.max(0, Math.floor(t0 / posPeriod));
  const i1 = Math.min(positions.length - 1, Math.floor(t1 / posPeriod));
  for (let i = i0; i <= i1; i++) {
    const xy = positions[i];
    if (!xy) continue;
    for (const e of entities) {
      if (e.timeBuilt > t1) continue;
      // Include entities that are alive in the window OR were removed
      // within the recently-removed grace — picking up an entity returns
      // its contents on the *next* inventory snapshot, by which time the
      // entity has timeRemoved ≤ snapshot tick.
      if (e.timeRemoved != null && e.timeRemoved <= t0 - RECENTLY_REMOVED_GRACE_TICKS) continue;
      const dx = e.location.x - xy[0];
      const dy = e.location.y - xy[1];
      if (dx * dx + dy * dy <= PROXIMITY_TILES_SQ) return true;
    }
  }
  return false;
}

// Sum of amount drops for `item` across all tracked chests inside [t0, t1].
// The chest's last sample at-or-before t0 is the "before" snapshot; the last
// sample at-or-before t1 is the "after". A negative difference means an
// inserter or player pulled that item from the chest in this window — we count
// both, conservatively over-attributing pickups when an inserter was the actual
// drain. Acceptable: false negatives on gathering are preferred over false
// positives. Uses seriesForItem so chests that held several items are probed
// only for the item we care about (the new `contents` shape).
function chestDecreaseInWindow(chests, item, t0, t1) {
  let total = 0;
  for (const c of chests) {
    if (c.timeBuilt > t1) continue;
    let amtBefore = 0, amtAfter = 0;
    for (const [t, a] of seriesForItem(c, item)) {
      if (t <= t0) amtBefore = a;
      if (t <= t1) amtAfter = a;
      else break;
    }
    if (amtBefore > amtAfter) total += amtBefore - amtAfter;
  }
  return total;
}
