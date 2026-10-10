import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Phase 0 smoke test: launches the built app (run `pnpm build` first) against a
 * throwaway profile and checks IPC → settings → git engine → theming end to end.
 */

const appDir = path.resolve(__dirname, '..');
const version = (
  JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) as { version: string }
).version;
let userData: string;
let app: ElectronApplication;
let page: Page;

async function section(name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name, exact: true })
    .click();
}

async function pickTheme(name: 'Light' | 'Dark'): Promise<void> {
  await section('Themes');
  const follow = page.getByRole('switch', { name: 'Follow OS light/dark mode' });
  // The switch is controlled by the settings store, so its state flips after the IPC round-trip.
  if (await follow.isChecked()) {
    await follow.click();
    await expect(follow).not.toBeChecked();
  }
  await page
    .getByRole('listitem')
    .getByRole('button', { name: new RegExp(`^${name}\\b`) })
    .click();
}

async function launch(): Promise<void> {
  app = await electron.launch({
    // package.json "main" → out/main/index.js. CI Linux runners can't use Chromium's SUID sandbox.
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [])],
    cwd: appDir,
    env: { ...process.env, GITHAPPENS_USER_DATA_DIR: userData, ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Phase 0 diagnostics live in Preferences › Git since Phase 3.
  await page.getByRole('button', { name: 'Preferences' }).click();
  await section('Git');
}

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-'));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('shows the git engine resolved to bundled git', async () => {
  const engine = page.getByRole('region', { name: 'Git engine' });
  await expect(engine).toBeVisible();
  await expect(engine).toContainText(/bundled\s*Git \d+\.\d+\.\d+/);
  await expect(engine.getByText('bundled', { exact: true })).toBeVisible();
  await expect(engine.getByText('merge-tree --write-tree')).toBeVisible();
  await section('About');
  await expect(page.getByRole('region', { name: 'Environment' })).toContainText(`App${version}`);
  await section('Git');
});

test('renderer is isolated from Node and only sees the typed api', async () => {
  const probe = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    api: Object.keys(window.api).sort(),
  }));
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    api: ['git', 'invoke', 'on', 'pathForFile', 'platform'],
  });
  const blocked = await page.evaluate(() =>
    (window.api.invoke as (c: string, r: unknown) => Promise<unknown>)('fs:readFile', {}).then(
      () => 'allowed',
      (e: Error) => e.message,
    ),
  );
  expect(blocked).toMatch(/Blocked IPC channel/);
});

test('theme setting applies instantly and persists across restarts', async () => {
  await pickTheme('Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: path.join(appDir, 'test-results', 'phase0-light.png') });

  await app.close();
  await launch();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const profiles = JSON.parse(fs.readFileSync(path.join(userData, 'profiles', 'index.json'), 'utf8')) as {
    id: string;
  }[];
  const saved = JSON.parse(
    fs.readFileSync(path.join(userData, 'profiles', profiles[0]!.id, 'settings.json'), 'utf8'),
  ) as { values: Record<string, unknown> };
  expect(saved.values).toMatchObject({ 'ui.theme': 'builtin:light', 'ui.themeFollowOs': false });

  await pickTheme('Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: path.join(appDir, 'test-results', 'phase0-dark.png') });
  await section('Git');
});

test('switching to an invalid custom git path falls back with a warning toast', async () => {
  const engine = page.getByRole('region', { name: 'Git engine' });
  await engine.getByLabel('Custom path').check();
  await engine.getByLabel('Path to git executable').fill(path.join(userData, 'no-such-git'));
  await engine.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    /could not be run|Using bundled Git/,
  );
  await expect(engine.getByText('bundled', { exact: true })).toBeVisible();
});
