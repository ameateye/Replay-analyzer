// Color tokens for the in-game Factorio palette — neutral grays from the
// GUI sprite atlas, NOT the factorio.com website's warm brown chrome.
// Cream `textStrong` matches data.raw `caption_color = {255, 230, 192}`.
//
// Per-pack / per-recipe / per-phase colors live in game-data/*.json and are
// looked up at runtime via useGameData() — see src/server/gameData.ts.

export const COLORS = {
  // Surfaces — neutral grays
  bg: '#191919',
  bgDeep: '#0c0c0c',
  panel: '#313131',
  panelLight: '#414141',
  surface: '#1d1d1d',          // recessed plot panel
  surfaceMuted: '#3a3a3a',
  border: '#161616',           // frame border (near-black)
  borderStrong: '#8f8f8f',     // inner highlight bevel

  // Chart axis / labels — neutral grays so they read on dark gray surfaces
  grid: '#414141',
  axis: '#888888',
  text: '#b8b8b8',
  textStrong: '#ffe6c0',       // authentic caption cream

  // Brand orange — used sparingly per game style (label accents, glow,
  // active markers). Not a surface color.
  accent: '#e39827',
  accentHot: '#f9b44b',
  accentWarm: '#f1be64',
  accentStrong: '#a46200',

  // Fixed time markers drawn across a production row. Green is the one hue no
  // chart series here uses (teal, blue, gray, red, purple, yellow), so the
  // marker never reads as data; the lighter tone is for the caption, which has
  // to stay legible where it crosses a saturated area fill.
  marker: '#3ddc84',
  markerText: '#8ff5bb',

  // Lab-saturation chart series — bumped for dark-bg legibility
  potentialFill: '#1a3845',
  potentialLine: '#9ad1ea',
  saturated:     '#2ea9c9',
  saturatedLine: '#7dcaed',
  idle:          '#8b6325',
  idleBorder:    '#cf994b',
};

export const FONT = "'Titillium Web', sans-serif";

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
