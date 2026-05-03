// Strategic build phase boundaries derived from per-tick game state.
//
// Phases (DS speedrun, single-player, post-2.0):
//   Burner end       = electric-mining-drill research completed
//   Front side end   = first sustained leave-base after pumpjack appears in player inventory
//   Oil end          = first sustained leave-base after the initial in-base roboport cluster is placed
//   Mixed end        = first sustained leave-base after first BC (processing-unit) AND first LDS production cycles
//   Full build end   = first utility-science-pack (yellow) production cycle
//   Late game end    = first rocket launch
//
// "Leaving the base" is detected against an axis-aligned bbox of all base machines built so far
// (assemblers, refineries, chemical plants, labs, beacons, furnaces). A leave event requires
// the player to remain outside the padded bbox for LEAVE_SUSTAIN_SAMPLES consecutive position
// samples — this filters out brief train teleports.
import * as fs from 'fs';
import * as path from 'path';

const COLORS = {
  Burner: '#57534e',
  'Front side': '#1d4ed8',
  Oil: '#b45309',
  Mixed: '#15803d',
  'Full build': '#6b21a8',
  'Late game': '#b91c1c',
};

const BASE_MACHINE_TYPES = new Set([
  'assembling-machine-1', 'assembling-machine-2', 'assembling-machine-3',
  'oil-refinery', 'chemical-plant',
  'lab', 'beacon',
  'stone-furnace', 'steel-furnace', 'electric-furnace',
]);

const LEAVE_PADDING_TILES = 15;
const LEAVE_SUSTAIN_SAMPLES = 30;
const ROBOPORT_CLUSTER_GAP_TICKS = 10000;

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function pickPlayerName(data) {
  const names = Object.keys(data.players);
  if (names.length === 0) throw new Error('no players in data');
  return names[0];
}

// Sorted snapshots of the cumulative bbox over base machines, one entry per build event.
function buildBaseBBoxTimeline(machineProduction) {
  const events = machineProduction.machines
    .filter(m => BASE_MACHINE_TYPES.has(m.name))
    .map(m => ({ tick: m.timeBuilt, x: m.location.x, y: m.location.y }))
    .sort((a, b) => a.tick - b.tick);
  const snapshots = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of events) {
    if (e.x < minX) minX = e.x;
    if (e.x > maxX) maxX = e.x;
    if (e.y < minY) minY = e.y;
    if (e.y > maxY) maxY = e.y;
    snapshots.push({ tick: e.tick, minX, maxX, minY, maxY });
  }
  return snapshots;
}

function bboxAt(snapshots, tick) {
  let lo = 0, hi = snapshots.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].tick <= tick) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx === -1 ? null : snapshots[idx];
}

function isOutside(pos, bbox, padding = LEAVE_PADDING_TILES) {
  if (!bbox) return false;
  return pos[0] < bbox.minX - padding || pos[0] > bbox.maxX + padding
      || pos[1] < bbox.minY - padding || pos[1] > bbox.maxY + padding;
}

// Earliest tick at or after `fromTick` where the player is outside the (padded) base
// bbox for at least LEAVE_SUSTAIN_SAMPLES consecutive samples. Returns the first tick
// of the sustained outside run.
function firstSustainedLeaveAfter(positions, period, snapshots, fromTick) {
  const startIdx = Math.max(0, Math.floor(fromTick / period));
  let runStart = -1;
  let runLen = 0;
  for (let i = startIdx; i < positions.length; i++) {
    const tick = i * period;
    if (isOutside(positions[i], bboxAt(snapshots, tick))) {
      if (runStart === -1) runStart = tick;
      runLen++;
      if (runLen >= LEAVE_SUSTAIN_SAMPLES) return runStart;
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  return null;
}

function firstResearchCompleted(researchTiming, name) {
  return researchTiming.timeCompleted?.[name] ?? null;
}

function firstItemInInventory(playerInv, item) {
  const playerName = pickPlayerName(playerInv);
  const inv = playerInv.players[playerName].inventory;
  for (let i = 0; i < inv.length; i++) {
    if ((inv[i][item] ?? 0) > 0) return i * playerInv.period;
  }
  return null;
}

// Earliest tick where any machine reports status === 'working' for the recipe.
function firstRecipeWorking(machineProduction, recipe) {
  let earliest = Infinity;
  for (const m of machineProduction.machines) {
    if (!m.recipes) continue;
    for (const r of m.recipes) {
      if (r.recipe !== recipe || !r.production) continue;
      for (const row of r.production) {
        if (row[4] === 'working' && row[0] < earliest) earliest = row[0];
      }
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
}

// Last roboport built inside the base during the initial cluster.
// Cluster ends at the first gap of >= ROBOPORT_CLUSTER_GAP_TICKS between successive builds.
function lastInitialInBaseRoboport(roboportUsage, snapshots) {
  const robos = [...roboportUsage.roboports].sort((a, b) => a.timeBuilt - b.timeBuilt);
  let lastInBase = null;
  let prevTick = null;
  for (const r of robos) {
    if (prevTick != null && r.timeBuilt - prevTick > ROBOPORT_CLUSTER_GAP_TICKS) break;
    prevTick = r.timeBuilt;
    const b = bboxAt(snapshots, r.timeBuilt);
    if (b && !isOutside([r.location.x, r.location.y], b)) {
      lastInBase = r.timeBuilt;
    }
  }
  return lastInBase;
}

export function computePhases(replayDir) {
  const mp = readJSON(path.join(replayDir, 'machineProduction.json'));
  const rocket = readJSON(path.join(replayDir, 'rocketLaunchTime.json'));
  const research = readJSON(path.join(replayDir, 'researchTiming.json'));
  const inv = readJSON(path.join(replayDir, 'playerInventory.json'));
  const robo = readJSON(path.join(replayDir, 'roboportUsage.json'));
  const posData = readJSON(path.join(replayDir, 'playerPosition.json'));

  const playerName = pickPlayerName(posData);
  const positions = posData.players[playerName];
  const posPeriod = posData.period;
  const snapshots = buildBaseBBoxTimeline(mp);

  const burnerEnd = firstResearchCompleted(research, 'electric-mining-drill');

  const pumpjackTick = firstItemInInventory(inv, 'pumpjack');
  const frontEnd = pumpjackTick != null
    ? firstSustainedLeaveAfter(positions, posPeriod, snapshots, pumpjackTick)
    : null;

  const lastRoboTick = lastInitialInBaseRoboport(robo, snapshots);
  const oilEnd = lastRoboTick != null
    ? firstSustainedLeaveAfter(positions, posPeriod, snapshots, lastRoboTick)
    : null;

  const bcTick = firstRecipeWorking(mp, 'processing-unit');
  const ldsTick = firstRecipeWorking(mp, 'low-density-structure');
  const bcLdsTick = (bcTick != null && ldsTick != null) ? Math.max(bcTick, ldsTick) : null;
  const mixedEnd = bcLdsTick != null
    ? firstSustainedLeaveAfter(positions, posPeriod, snapshots, bcLdsTick)
    : null;

  const fullBuildEnd = firstRecipeWorking(mp, 'utility-science-pack');

  const lateGameEnd = rocket.rocketLaunchTimes[0];

  const order = [
    { name: 'Burner', startTick: 0, endTick: burnerEnd },
    { name: 'Front side', startTick: burnerEnd, endTick: frontEnd },
    { name: 'Oil', startTick: frontEnd, endTick: oilEnd },
    { name: 'Mixed', startTick: oilEnd, endTick: mixedEnd },
    { name: 'Full build', startTick: mixedEnd, endTick: fullBuildEnd },
    { name: 'Late game', startTick: fullBuildEnd, endTick: lateGameEnd },
  ];

  return order.map(p => ({
    name: p.name,
    color: COLORS[p.name],
    startTick: p.startTick,
    endTick: p.endTick,
    startMin: p.startTick != null ? p.startTick / 3600 : null,
    endMin: p.endTick != null ? p.endTick / 3600 : null,
  }));
}

export function computeRocketLaunchTick(replayDir) {
  const rocket = readJSON(path.join(replayDir, 'rocketLaunchTime.json'));
  return rocket.rocketLaunchTimes[0];
}
