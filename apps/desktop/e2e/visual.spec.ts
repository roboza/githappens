import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { closeApp, GRID, launchApp, makeFixture, setSetting, type Session } from './perf-utils';

/**
 * Visual regression of the commit graph in the light and dark themes (spec 15 §7 "Visual", spec 04 §7
 * step 9). Opt-in: GH_VISUAL=1. Baselines are per platform (`*-win32.png`, `*-linux.png`, …) because
 * fonts and antialiasing differ; create/refresh them with `--update-snapshots`.
 *
 * Determinism: fixed fixture (branchy: merges, octopus, criss-cross, tags, stash), ISO dates in UTC,
 * initials instead of avatars (no network), fixed window size, no hover, theme set through the app's
 * own settings channel (`settings:set`, as the Preferences UI does).
 */

test.skip(process.env.GH_VISUAL !== '1', 'visual suite: set GH_VISUAL=1');
test.describe.configure({ mode: 'serial' });

let s: Session | undefined;
let fixtures = '';

test.beforeAll(async () => {
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-visual-')));
  const repo = makeFixture('branchy', fixtures);
  s = await launchApp(repo, { env: { TZ: 'UTC' } });
  await s.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    if (w.isMaximized()) w.unmaximize();
    w.setContentSize(1280, 800);
  });
  await setSetting(s.page, 'ui.dateFormat', 'iso');
  await setSetting(s.page, 'ui.authorDisplay', 'initials');
  await setSetting(s.page, 'ui.themeFollowOs', false);
});

test.afterAll(async () => {
  await closeApp(s);
  if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

for (const theme of ['light', 'dark'] as const) {
  test(`graph — ${theme} theme`, async () => {
    const { page } = s!;
    await setSetting(page, 'ui.theme', `builtin:${theme}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.mouse.move(0, 0);
    const grid = page.locator(GRID);
    await expect(grid.getByRole('row').first()).toBeVisible();
    // let avatars/initials, pills and the canvas settle after the theme switch
    await page.waitForTimeout(500);
    await expect(grid).toHaveScreenshot(`graph-${theme}.png`, {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    });
  });
}
