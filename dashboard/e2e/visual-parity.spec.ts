// Visual parity test: screenshot each phase widget in the local dev build
// and the live published dashboard, then pixel-diff. Any drift introduced
// by the per-run data redesign should fall well below the threshold because
// the redesign was designed to preserve render fidelity.
//
// How to run:    npm run test:visual
// First time:    npx playwright install chromium   (Chromium download)
//
// Why this exists alongside the numeric parity test (src/__tests__/parity.test.ts):
// numeric parity confirms the underlying series match, but chrome (axes,
// fonts, swatches, tooltips) lives outside the cube and can regress
// independently. Visual diff catches that.

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

// Resolve `__dirname` under ESM (Playwright transpiles this spec as ESM).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLISHED = 'https://ameateye.github.io/Replay-analyzer/';
const LOCAL = 'http://localhost:5173/';

// Drift threshold: percentage of pixels that may differ between local and
// published. Subpixel anti-aliasing on chart lines / labels can produce a
// few hundred px of "noise" diff per widget on a 1600×1200 viewport, so
// 1.5 % leaves headroom without masking real regressions.
const DRIFT_PCT_THRESHOLD = 1.5;
// pixelmatch `threshold` is the per-pixel YIQ difference — 0.1 is strict,
// 0.2 absorbs typical antialiasing wobble. 0.15 is the sweet spot here.
const PIXEL_THRESHOLD = 0.15;
// `KEEP_SCREENSHOTS=1` writes local + published + diff PNGs on every run
// (not just failures) under e2e/screenshots/. Useful for manual review
// after a green run. Default behaviour writes only on failure.
const KEEP_SCREENSHOTS = process.env.KEEP_SCREENSHOTS === '1';

// One run, all four converted-widget phases. DS-2_14_45 is the historical
// reference run and has full data across every phase. Adding more runs is a
// matter of appending to CASES; tests are sequential (Playwright config
// fullyParallel:false) because we share one dev server. ~20s per case.
const CASES: Array<{ run: string; phase: string }> = [
  { run: 'DS-2_14_45', phase: 'Mixed' },
  { run: 'DS-2_14_45', phase: 'Oil' },
  { run: 'DS-2_14_45', phase: 'Full build' },
  { run: 'DS-2_14_45', phase: 'Late game' },
];

async function gotoAndSelect(page: Page, url: string, runName: string, phase: string) {
  await page.goto(url, { waitUntil: 'networkidle' });
  // Wait for the run picker to materialize (game-data fetched + react render)
  await page.locator('.run-picker').waitFor({ state: 'visible' });
  await page.locator('.run-picker__tab', { hasText: runName }).click();
  // The phase strip block lives inside the SVG; aria-label is "Select X phase analyzer"
  await page
    .getByRole('button', { name: new RegExp(`Select ${escapeRegex(phase)} phase`) })
    .click();
  // Give react + the SVG time to commit the widget swap and let any
  // animation settle. The widgets themselves don't animate but the
  // phase-strip block opacity does.
  await page.waitForTimeout(600);
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function screenshotWidget(page: Page): Promise<Buffer> {
  // Each converted widget renders inside <section class="end-game">. Only
  // one widget is mounted at a time (PhaseAnalyzer swaps), so the first
  // match is correct.
  const widget = page.locator('section.end-game').first();
  await widget.waitFor({ state: 'visible' });
  return widget.screenshot({ animations: 'disabled', scale: 'css' });
}

for (const { run, phase } of CASES) {
  test(`visual parity — ${run} / ${phase}`, async ({ browser }) => {
    const ctxLocal = await browser.newContext();
    const ctxPub = await browser.newContext();
    const pageLocal = await ctxLocal.newPage();
    const pagePub = await ctxPub.newPage();

    try {
      await Promise.all([
        gotoAndSelect(pageLocal, LOCAL, run, phase),
        gotoAndSelect(pagePub, PUBLISHED, run, phase),
      ]);
      const [localBuf, pubBuf] = await Promise.all([
        screenshotWidget(pageLocal),
        screenshotWidget(pagePub),
      ]);

      const localPng = PNG.sync.read(localBuf);
      const pubPng = PNG.sync.read(pubBuf);
      // The widgets render at the same logical width (W=1500) and a fixed
      // row height, so identical viewport ⇒ identical screenshot dims. If
      // dims differ, that itself is a regression worth surfacing.
      expect(
        localPng.width,
        `width mismatch local=${localPng.width} published=${pubPng.width}`,
      ).toBe(pubPng.width);
      expect(
        localPng.height,
        `height mismatch local=${localPng.height} published=${pubPng.height}`,
      ).toBe(pubPng.height);

      const diff = new PNG({ width: localPng.width, height: localPng.height });
      const diffPixels = pixelmatch(
        localPng.data,
        pubPng.data,
        diff.data,
        localPng.width,
        localPng.height,
        { threshold: PIXEL_THRESHOLD },
      );
      const totalPixels = localPng.width * localPng.height;
      const diffPct = (diffPixels / totalPixels) * 100;

      if (diffPct >= DRIFT_PCT_THRESHOLD || KEEP_SCREENSHOTS) {
        const outDir = path.join(__dirname, 'screenshots');
        fs.mkdirSync(outDir, { recursive: true });
        const tag = `${run}-${phase.replace(/\s+/g, '_')}`;
        fs.writeFileSync(path.join(outDir, `${tag}-local.png`), localBuf);
        fs.writeFileSync(path.join(outDir, `${tag}-published.png`), pubBuf);
        fs.writeFileSync(path.join(outDir, `${tag}-diff.png`), PNG.sync.write(diff));
      }

      expect(
        diffPct,
        `${diffPixels.toLocaleString()} px differ (${diffPct.toFixed(2)} %). ` +
        `Threshold: ${DRIFT_PCT_THRESHOLD} %. PNGs written to e2e/screenshots/ on failure.`,
      ).toBeLessThan(DRIFT_PCT_THRESHOLD);
    } finally {
      await ctxLocal.close();
      await ctxPub.close();
    }
  });
}
