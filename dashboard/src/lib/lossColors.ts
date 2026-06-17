// Loss-decomposition colors + labels, shared by the production rate chart
// (ProductionWidget) and the time-window readout (WindowStatsPanel) so the
// stacked bands and the by-reason table never drift apart. Status colors are
// the in-game-ish palette tuned for the dark plot panel; item/fluid losses
// cycle their own palettes by first-seen order (itemsByLoss / fluidsByLoss).

import type { StatusKey } from './runDatasets';

export const ITEM_PALETTE = ['#e74634', '#f3934e', '#cf833a', '#fbbb27', '#a23b1c', '#c4690b'];
export const FLUID_PALETTE = ['#5fbff4', '#67e8f9', '#3aa8f0', '#7d5bd1'];

export const STATUS_COLOR: Record<StatusKey, string> = {
  no_ingredients: '#a8865a',
  no_fuel:        '#1a1a1a',
  full_output:    '#fbbb27',
  low_power:      '#b14df5',
  depleted:       '#6b8e23',
  unknown:        '#a09c97',
};

// Bottom-up stack order for the rate-mode loss bands; also the display order
// in the window readout.
export const LOSS_STATUS_ORDER: StatusKey[] = [
  'no_ingredients',
  'no_fuel',
  'full_output',
  'low_power',
  'depleted',
  'unknown',
];

// Human-facing labels for the status reasons (the raw keys use underscores).
export const STATUS_LABEL: Record<StatusKey, string> = {
  no_ingredients: 'no ingredients',
  no_fuel:        'no fuel',
  full_output:    'output full',
  low_power:      'low power',
  depleted:       'depleted',
  unknown:        'unknown',
};
