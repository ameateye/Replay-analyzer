// Factorio-styled dark UI tokens. Panel/inset/bevel triplet matches the
// 3-tone frame system the game uses for every UI window. Chart series
// colors are tuned to read against the dark inset panels.
//
// Per-pack / per-recipe / per-phase colors live in game-data/*.json and are
// looked up at runtime via useGameData() — see src/server/gameData.ts.

export const COLORS = {
  // Surfaces
  bg: '#1a1816',           // desktop background
  panel: '#313130',        // primary panel face
  surface: '#232322',      // inset chart-plot face (recessed)
  surfaceMuted: '#3c3c3a',
  border: '#0a0a09',       // outer shadow edge
  borderStrong: '#5a5957', // inner highlight edge

  // Lines / labels in chart area
  grid: '#3a3835',
  axis: '#8a8478',
  text: '#c9bea3',
  textStrong: '#ffe6c0',

  // Factorio brand accents
  accent: '#ff9d28',
  accentHot: '#fbbb27',
  accentStrong: '#c4750e',

  // Lab-saturation chart series — bumped for dark-bg legibility
  potentialFill: '#0c4a5b',  // deep teal under total curve
  potentialLine: '#67e8f9',  // bright cyan
  saturated:     '#1e9bbf',  // active labs fill
  saturatedLine: '#7dd3e8',  // active labs edge
  idle:          '#6a5a3c',  // muted brown for "no research" overlay
  idleBorder:    '#a8956c',
};

export const FONT = '"Titillium Web", "Segoe UI", Inter, system-ui, -apple-system, sans-serif';

export function fmtTime(min: number): string {
  const total = Math.max(0, Math.round(min * 60));
  const h = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export function fmtTimeNoSec(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const mm = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(mm)}` : `${mm}`;
}
