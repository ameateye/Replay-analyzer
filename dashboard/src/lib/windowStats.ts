// Aggregate a single production row's missed output by reason over a
// user-selected time window. Mirrors the standalone low-power-impact analysis
// (ad-hoc-analysis/low-power-impact.mjs) but scoped to one recipe and one
// window, reading the already-projected render-time series.
//
// Units: the row's `actual` / `potential` / `*Loss[*]` arrays are smoothed
// items-per-minute aligned to `minutes[]`, each index covering `period/3600`
// minutes (see projectProduction.ts). `cum` is the raw integer cumulative
// item count, so `produced` is exact; everything else is integrated from the
// smoothed rate series and is therefore an estimate (marked "~" in the UI).
//
//   items lost in window  = Σ loss[i] · periodMin
//   equiv-min lost        = Σ (loss[i] / potential[i]) · periodMin
//                           — the fraction of full capacity erased each
//                             period, integrated → minutes the line was
//                             effectively switched off by that reason.

import type { StatusKey } from './runDatasets';
import { ITEM_PALETTE, FLUID_PALETTE, STATUS_COLOR, STATUS_LABEL, LOSS_STATUS_ORDER } from './lossColors';

// Minimal shape the aggregation needs — satisfied structurally by the Recipe
// / RecipeRow render shapes.
export type WindowStatsRow = {
  potential: number[];
  cum: number[];
  statusLoss: Record<string, number[] | undefined>;
  itemLoss: Record<string, number[] | undefined>;
  fluidLoss: Record<string, number[] | undefined>;
  itemsByLoss: string[];
  fluidsByLoss: string[];
};

export type LossEntry = {
  key: string;
  kind: 'status' | 'item' | 'fluid';
  label: string;
  color: string;
  items: number;          // items lost in window (estimate)
  equivMin: number;       // equivalent minutes of full-rate output lost
  pctOfPotential: number; // items / window potential × 100
};

export type WindowStats = {
  startMin: number;
  endMin: number;
  windowMin: number;
  produced: number;       // exact items produced in window (from cum)
  potential: number;      // ≈ produced + missed
  missed: number;         // Σ losses across all reasons
  achievedPct: number;    // produced / potential × 100
  totalEquivMin: number;  // Σ equivMin across reasons
  losses: LossEntry[];    // reasons with items > 0, sorted desc by items
};

export function computeWindowStats(
  row: WindowStatsRow,
  minutes: number[],
  periodMin: number,
  sel: { m0: number; m1: number },
): WindowStats | null {
  const N = minutes.length;
  if (N === 0) return null;
  const lo = Math.min(sel.m0, sel.m1);
  const hi = Math.max(sel.m0, sel.m1);

  // Inclusive index range of periods whose timestamp falls within [lo, hi].
  let i0 = 0;
  while (i0 < N && minutes[i0] < lo) i0++;
  let i1 = N - 1;
  while (i1 >= 0 && minutes[i1] > hi) i1--;
  if (i0 > i1) return null; // window narrower than one period — nothing to show

  // Exact produced count from the raw cumulative series.
  const produced = Math.max(0, row.cum[i1] - (i0 > 0 ? row.cum[i0 - 1] : 0));

  const integrate = (arr: number[] | undefined): { items: number; equivMin: number } => {
    if (!arr) return { items: 0, equivMin: 0 };
    let items = 0;
    let equivMin = 0;
    for (let i = i0; i <= i1; i++) {
      const v = arr[i] || 0;
      items += v * periodMin;
      const pot = row.potential[i] || 0;
      if (pot > 0) equivMin += (v / pot) * periodMin;
    }
    return { items, equivMin };
  };

  const raw: LossEntry[] = [];
  row.itemsByLoss.forEach((name, idx) => {
    const { items, equivMin } = integrate(row.itemLoss[name]);
    if (items > 0.05) {
      raw.push({ key: name, kind: 'item', label: name.replace(/-/g, ' '), color: ITEM_PALETTE[idx % ITEM_PALETTE.length], items, equivMin, pctOfPotential: 0 });
    }
  });
  row.fluidsByLoss.forEach((name, idx) => {
    const { items, equivMin } = integrate(row.fluidLoss[name]);
    if (items > 0.05) {
      raw.push({ key: name, kind: 'fluid', label: name.replace(/-/g, ' '), color: FLUID_PALETTE[idx % FLUID_PALETTE.length], items, equivMin, pctOfPotential: 0 });
    }
  });
  for (const name of LOSS_STATUS_ORDER) {
    const { items, equivMin } = integrate(row.statusLoss[name]);
    if (items > 0.05) {
      raw.push({ key: name, kind: 'status', label: STATUS_LABEL[name as StatusKey], color: STATUS_COLOR[name as StatusKey], items, equivMin, pctOfPotential: 0 });
    }
  }

  const missed = raw.reduce((s, l) => s + l.items, 0);
  const totalEquivMin = raw.reduce((s, l) => s + l.equivMin, 0);
  const potential = produced + missed;
  for (const l of raw) l.pctOfPotential = potential > 0 ? (l.items / potential) * 100 : 0;
  raw.sort((a, b) => b.items - a.items);

  return {
    startMin: minutes[i0],
    endMin: minutes[i1],
    windowMin: minutes[i1] - minutes[i0],
    produced,
    potential,
    missed,
    achievedPct: potential > 0 ? (produced / potential) * 100 : produced > 0 ? 100 : 0,
    totalEquivMin,
    losses: raw,
  };
}
