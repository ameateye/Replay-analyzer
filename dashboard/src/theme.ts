// Visual tokens shared across the dashboard. Keep aligned with the existing
// chart aesthetic (light theme, Segoe UI, dim text #5f6368 / strong #202124).

export const COLORS = {
  bg: '#fbfbf9',
  surface: '#ffffff',
  border: '#e5e5e2',
  grid: '#ececec',
  axis: '#9aa0a6',
  text: '#5f6368',
  textStrong: '#202124',
  potentialFill: '#e8f7fa',
  potentialLine: '#67e8f9',
  saturated: '#0e7490',
  saturatedLine: '#155e75',
  idle: '#dcc8a0',
  idleBorder: '#a8956c',
};

export const PACK_COLOR: Record<string, string> = {
  'automation-science-pack': '#c8312a',
  'logistic-science-pack': '#5cb834',
  'military-science-pack': '#3a3a3a',
  'chemical-science-pack': '#3aa8f0',
  'production-science-pack': '#b14df5',
  'utility-science-pack': '#f2c94f',
  'space-science-pack': '#d8d8d8',
};

export const PACK_SHORT: Record<string, string> = {
  'automation-science-pack': 'automation',
  'logistic-science-pack': 'logistic',
  'military-science-pack': 'military',
  'chemical-science-pack': 'chemical',
  'production-science-pack': 'production',
  'utility-science-pack': 'utility',
  'space-science-pack': 'space',
};

export const FONT = '"Segoe UI", Inter, system-ui, -apple-system, sans-serif';

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
