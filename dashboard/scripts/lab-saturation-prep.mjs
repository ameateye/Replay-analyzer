// Lab saturation prep. Pure logic, no D3.
//
// Saturation = % of existing labs holding >=1 of every science pack required
// by the currently active research.
//
// Inputs:
//   <replayDir>/labContents.json
//   <replayDir>/researchTiming.json
//   <techReqPath>           game-data/factorio-tech-requirements.json
import * as fs from 'fs';
import * as path from 'path';

export const PACK_TIER_ORDER = [
  'automation-science-pack',
  'logistic-science-pack',
  'military-science-pack',
  'chemical-science-pack',
  'production-science-pack',
  'utility-science-pack',
  'space-science-pack',
];

export function prepareLabSaturationData(replayDir, techReqPath) {
  const labFile = JSON.parse(fs.readFileSync(path.join(replayDir, 'labContents.json'), 'utf8'));
  const researchFile = JSON.parse(fs.readFileSync(path.join(replayDir, 'researchTiming.json'), 'utf8'));
  const techReq = JSON.parse(fs.readFileSync(techReqPath, 'utf8'));

  const PERIOD = labFile.period;
  const PACK_NAMES = labFile.sciencePacks;
  const PACK_IDX = {};
  PACK_NAMES.forEach((n, i) => { PACK_IDX[n] = i; });

  const techRequiredIdx = {};
  for (const [tech, packs] of Object.entries(techReq.technologies)) {
    techRequiredIdx[tech] = packs.map(p => PACK_IDX[p]).filter(i => i !== undefined);
  }

  const intervals = [];
  let current = null;
  const orderedEvents = [...researchFile.events].sort((a, b) => a.time - b.time);
  for (const ev of orderedEvents) {
    if (ev.type === 'started') {
      if (current && current.name === ev.research) continue;
      if (current) {
        intervals.push({ name: current.name, start: current.start, end: ev.time, requiredIdx: techRequiredIdx[current.name] ?? [] });
      }
      current = { name: ev.research, start: ev.time };
    } else if (ev.type === 'completed' || ev.type === 'cancelled') {
      if (current && current.name === ev.research) {
        intervals.push({ name: current.name, start: current.start, end: ev.time, requiredIdx: techRequiredIdx[current.name] ?? [] });
        current = null;
      }
    }
  }

  let firstTick = Infinity;
  let lastTick = -Infinity;
  for (const lab of labFile.labs) {
    if (!lab.packs || lab.packs.length === 0) continue;
    if (lab.packs[0][0] < firstTick) firstTick = lab.packs[0][0];
    if (lab.packs[lab.packs.length - 1][0] > lastTick) lastTick = lab.packs[lab.packs.length - 1][0];
  }
  firstTick = Math.floor(firstTick / PERIOD) * PERIOD;
  lastTick = Math.floor(lastTick / PERIOD) * PERIOD;

  if (current) {
    intervals.push({ name: current.name, start: current.start, end: lastTick, requiredIdx: techRequiredIdx[current.name] ?? [] });
    current = null;
  }
  intervals.sort((a, b) => a.start - b.start);

  const labMaps = labFile.labs.map(lab => {
    const m = new Map();
    for (const entry of lab.packs) m.set(entry[0], entry.slice(1));
    return { unitNumber: lab.unitNumber, timeBuilt: lab.timeBuilt, samples: m };
  });

  let intervalCursor = 0;
  const activeAt = (tick) => {
    while (intervalCursor < intervals.length && intervals[intervalCursor].end <= tick) intervalCursor++;
    if (intervalCursor >= intervals.length) return null;
    const iv = intervals[intervalCursor];
    return tick >= iv.start && tick < iv.end ? iv : null;
  };

  const tierIdxArr = PACK_TIER_ORDER.map(n => PACK_IDX[n]).filter(i => i !== undefined);
  const intervalRequiredOrdered = new Map();
  for (const iv of intervals) {
    const reqSet = new Set(iv.requiredIdx);
    intervalRequiredOrdered.set(iv, tierIdxArr.filter(i => reqSet.has(i)));
  }

  const points = [];
  for (let tick = firstTick; tick <= lastTick; tick += PERIOD) {
    const active = activeAt(tick);
    const requiredOrdered = active ? intervalRequiredOrdered.get(active) : null;
    const measurable = requiredOrdered !== null && requiredOrdered.length > 0;

    let totalAlive = 0;
    let saturated = 0;
    const missingByPack = {};
    for (const lab of labMaps) {
      if (lab.timeBuilt > tick) continue;
      const packs = lab.samples.get(tick);
      if (!packs) continue;
      totalAlive++;
      if (measurable) {
        const missingIdxs = [];
        for (const idx of requiredOrdered) {
          if ((packs[idx] ?? 0) < 1) missingIdxs.push(idx);
        }
        if (missingIdxs.length === 0) {
          saturated++;
        } else {
          const share = 1 / missingIdxs.length;
          for (const idx of missingIdxs) {
            const name = PACK_NAMES[idx];
            missingByPack[name] = (missingByPack[name] ?? 0) + share;
          }
        }
      }
    }

    points.push({
      tick,
      minute: tick / 3600,
      total: totalAlive,
      active: measurable ? saturated : null,
      activeTech: active?.name ?? null,
      requiredPacks: requiredOrdered ? requiredOrdered.map(i => PACK_NAMES[i]) : null,
      missingByPack: measurable ? missingByPack : null,
    });
  }

  const idleRects = [];
  let idleStart = null;
  for (const p of points) {
    if (p.active === null) {
      if (idleStart === null) idleStart = p.minute;
    } else if (idleStart !== null) {
      idleRects.push({ startMin: idleStart, widthMin: p.minute - idleStart });
      idleStart = null;
    }
  }
  if (idleStart !== null) idleRects.push({ startMin: idleStart, widthMin: (lastTick / 3600) - idleStart });

  const usedSet = new Set();
  for (const iv of intervals) {
    for (const idx of intervalRequiredOrdered.get(iv)) usedSet.add(PACK_NAMES[idx]);
  }
  const packsUsed = PACK_TIER_ORDER.filter(p => usedSet.has(p));

  const researchIntervals = intervals.map(iv => ({
    name: iv.name,
    startMin: iv.start / 3600,
    endMin: iv.end / 3600,
    requiredPacks: intervalRequiredOrdered.get(iv).map(i => PACK_NAMES[i]),
  }));

  return { points, idleRects, packsUsed, researchIntervals, firstTick, lastTick };
}
