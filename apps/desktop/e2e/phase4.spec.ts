import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Phase 4 (integrations) end-to-end, fully offline: the repo's `origin` claims to be
 * github.com/acme/app but `url.<local>.insteadOf` sends every git call to the local bare
 * fixture, so remote resolution, the PR/Issues panels, Preferences → Integrations and the
 * "Start a pull request" entry points run without any provider traffic. Provider clients
 * themselves are covered by msw-backed unit tests in packages/providers.
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const shots = path.join(appDir, 'test-results');
const FAKE_URL = 'https://github.com/acme/app.git';

let tmp: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-p4-')));
  execFileSync(
    'pnpm',
    ['--filter', '@githappens/fixtures', 'make', 'remote-pair', `--root=${path.join(tmp, 'repos')}`],
    { cwd: repoRoot, stdio: 'ignore', shell: process.platform === 'win32' },
  );
  const dir = path.join(tmp, 'repos', 'remote-pair');
  const repo = path.join(dir, 'local');
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('config', `url.${pathToFileURL(path.join(dir, 'remote.git')).href}.insteadOf`, FAKE_URL);
  git('remote', 'set-url', 'origin', FAKE_URL);

  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'),
      ELECTRON_RENDERER_URL: '',
      // No OAuth apps configured: only personal access tokens are offered.
      GH_OAUTH_GITHUB_CLIENT_ID: '',
      GH_OAUTH_BROKER_URL: '',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('the Pull requests and Issues panels ask to connect an account', async () => {
  const refsNav = page.getByRole('navigation', { name: 'Repository references' });
  await expect(refsNav.getByRole('button', { name: /Pull requests/ })).toBeVisible();
  await expect(
    refsNav
      .getByRole('region', { name: 'Pull requests' })
      .getByText('Connect a hosting account to see pull requests.'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(refsNav.getByRole('button', { name: /Issues/ })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase4-pr-panel.png') });
});

test('"Connect an account" opens Preferences at Integrations with the token form', async () => {
  await page
    .getByRole('navigation', { name: 'Repository references' })
    .getByRole('region', { name: 'Pull requests' })
    .getByRole('button', { name: 'Connect an account' })
    .click();
  const integrations = page.getByRole('list', { name: 'Integrations' });
  await expect(integrations).toBeVisible();
  await expect(integrations.getByRole('button', { name: /GitHub/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Connect with token/ })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase4-integrations.png') });
  await page.keyboard.press('Escape');
  await expect(integrations).toBeHidden();
});

test('"Start a pull request" from a branch explains that no account is linked', async () => {
  const refsNav = page.getByRole('navigation', { name: 'Repository references' });
  await refsNav
    .getByRole('tree', { name: 'Local' })
    .getByRole('treeitem', { name: /^main/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Start a pull request from main/ }).click();
  await expect(page.getByText(/No remote of this repository is linked to a connected account/)).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase4-create-pr.png') });
  await page.keyboard.press('Escape');
});

test('the clone dialog offers browsing connected accounts', async () => {
  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('button', { name: 'Clone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clone a repository' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Browse connected accounts')).toBeVisible();
  await page.keyboard.press('Escape');
});
