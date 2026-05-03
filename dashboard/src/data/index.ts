import r0 from './DS-2_19_20.json';
import r1 from './DS-2_17_29.json';

export type Run = typeof r0;
export const runs: Run[] = [r0, r1 as unknown as Run];
export const defaultRun = runs[0];
