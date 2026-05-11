import { defineConfig } from 'vitest/config';

// Tests live under src/__tests__/ alongside the modules they exercise so they
// share the same tsconfig (paths, resolver, lib) as production code. Vite
// ignores them at build time because nothing in main.tsx imports them.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
