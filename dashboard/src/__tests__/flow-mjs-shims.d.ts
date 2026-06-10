// Ambient signatures for the plain-ESM flow prep modules under
// dashboard/scripts/, so the TypeScript tests can import them without an
// implicit-any error. The prep modules are JS by design (no bundler for the
// offline build); these wildcard declarations type just the surface the tests
// touch. Production .ts never imports these, so the loose typing is test-only.

declare module '*/flow-prep.mjs' {
  export function buildFlow(runDir: string, durationTick: number, opts?: { merged?: unknown }): any;
  export function synthesiseEventsForRun(runDir: string, durationTick?: number): any[];
}

declare module '*/state.mjs' {
  export function createFlowState(): any;
  export function registerEvent(state: any, ev: any): any;
}

declare module '*/segments.mjs' {
  export function reconcile(state: any, dirty: Set<number>, tick: number): any[];
  export function advance(state: any, dirty: Set<number>, tick: number): void;
}

declare module '*/edges.mjs' {
  export function finalize(state: any): { edges: any[] };
}
