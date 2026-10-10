import { defineConfig } from '@playwright/test';

// Every e2e app window opens at a small, CI-like size (GitHub's Windows runner screen is ~1024x768), so
// local runs match CI and narrow-layout regressions are caught. Override by setting the variable.
process.env.GITHAPPENS_WINDOW_SIZE ??= '1024x768';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Each worker runs a full Electron app plus git; more than a few in parallel starves them.
  // Serial on CI: shared runners have few cores and several Electron + git processes at once made
  // timing-sensitive specs flaky. Locally 3 workers keep the suite fast.
  workers: process.env.CI ? 1 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: './test-results',
});
