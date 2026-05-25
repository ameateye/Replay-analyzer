import r0 from './DS-2_16_34.json';
import r1 from './DS-2_11_10.json';
import r2 from './DS-2_08_21.json';
import r3 from './DS-2_22_15.json';
import r4 from './DS-2_19_20.json';
import r5 from './DS-2_17_29.json';
import r6 from './DS-2_16_04.json';
import r7 from './DS-2_14_45.json';
import r8 from './DS-2_09_42.json';

export type Run = typeof r0;
export const runs: Run[] = [r0, r1 as unknown as Run, r2 as unknown as Run, r3 as unknown as Run, r4 as unknown as Run, r5 as unknown as Run, r6 as unknown as Run, r7 as unknown as Run, r8 as unknown as Run];
export const defaultRun = runs[0];
