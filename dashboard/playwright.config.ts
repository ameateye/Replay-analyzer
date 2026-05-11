// Visual parity harness: boot the local dev server and screenshot widgets
// alongside the published dashboard for diffing. Tests live under e2e/.
// The data parity test (src/__tests__/parity.test.ts) is a separate vitest
// suite — Playwright's testDir is scoped here to keep them independent.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    viewport: { width: 1600, height: 1200 },
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
