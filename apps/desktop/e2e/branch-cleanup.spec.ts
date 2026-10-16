import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Clean up branches (spec 05 §6.13), offline over a file:// remote. A second clone plays the forge:
 * it merges one PR, squash-merges another, and deletes those branches plus a closed PR's branch. The
 * dialog fetches with prune, preselects the merged ones, deletes them, and Undo brings them back.
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const shots = path.join(appDir, 'test-results');

let tmp: string;
let repo: string;
let app: ElectronApplication;
let page: Page;

const gitIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const identity = (git: (...a: string[]) => string): void => {
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'commit.gpgsign', 'false');
};

const commit = (cwd: string, file: string, message: string): void => {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  gitIn(cwd)('add', '-A');
  gitIn(cwd)('commit', '-q', '-m', message);
};

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-cleanup-')));
  const origin = path.join(tmp, 'origin.git');
  gitIn(tmp)('init', '-q', '--bare', '-b', 'main', origin);

  repo = path.join(tmp, 'repo');
  gitIn(tmp)('clone', '-q', origin, repo);
  const git = gitIn(repo);
  identity(git);
  git('switch', '-q', '-c', 'main');
  commit(repo, 'README.md', 'Base');
  git('push', '-q', '-u', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  for (const [branch, files] of [
    ['feature/merged', ['m.txt']],
    ['feature/squash', ['s1.txt', 's2.txt']],
    ['spike/closed', ['x.txt']],
    ['wip/active', ['y.txt']],
  ] as const) {
    git('switch', '-q', '-c', branch, 'main');
    for (const f of files) commit(repo, f, `${branch} ${f}`);
    git('push', '-q', '-u', 'origin', branch);
  }
  git('switch', '-q', 'main');

  // the "forge": merge two PRs, close one, delete their branches
  const forge = path.join(tmp, 'forge');
  gitIn(tmp)('clone', '-q', origin, forge);
  const f = gitIn(forge);
  identity(f);
  f('merge', '-q', '--no-ff', '-m', 'Merge PR #1', 'origin/feature/merged');
  f('merge', '-q', '--squash', 'origin/feature/squash');
  f('commit', '-q', '-m', 'PR #2 (squash)');
  f('push', '-q', 'origin', 'main');
  f('push', '-q', 'origin', '--delete', 'feature/merged', 'feature/squash', 'spike/closed');

  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'),
      ELECTRON_RENDERER_URL: '',
      GH_OAUTH_GITHUB_CLIENT_ID: '',
      GH_OAUTH_BROKER_URL: '',
    },
  });
  page = await app.firstWindow();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const localBranches = (): string[] =>
  gitIn(repo)('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

test('finds merged and closed-PR branches, deletes the merged ones, undo restores them', async () => {
  await page.getByRole('button', { name: 'Branch options' }).click();
  await page.getByRole('menuitem', { name: 'Clean up branches…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Clean up branches' });
  await expect(dialog.getByText('Compared against')).toBeVisible({ timeout: 30_000 });

  const merged = dialog.getByRole('region', { name: 'Merged' });
  const gone = dialog.getByRole('region', { name: 'Remote deleted, not merged' });
  await expect(merged.getByRole('checkbox', { name: /feature\/merged/ })).toBeChecked();
  await expect(merged.getByRole('checkbox', { name: /feature\/squash/ })).toBeChecked();
  await expect(merged.getByText('squash-merged')).toBeVisible();
  await expect(gone.getByRole('checkbox', { name: /spike\/closed/ })).not.toBeChecked();
  await expect(gone.getByText('1 commit not merged')).toBeVisible();
  await expect(dialog.getByText('wip/active')).toHaveCount(0);
  await expect(dialog.getByText(/Never deleted: main/)).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'branch-cleanup-dialog.png') });

  // selecting the unmerged one warns; unselect it again
  await gone.getByRole('checkbox', { name: /spike\/closed/ }).check();
  await expect(dialog.getByRole('alert')).toContainText('1 selected branch has commits');
  await expect(dialog.getByRole('button', { name: 'Delete 3 branches' })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'branch-cleanup-warning.png') });
  await gone.getByRole('checkbox', { name: /spike\/closed/ }).uncheck();

  await dialog.getByRole('button', { name: 'Delete 2 branches' }).click();
  await expect(dialog).toBeHidden();
  const undo = page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  expect(localBranches()).toEqual(['main', 'spike/closed', 'wip/active']);
  await page.screenshot({ path: path.join(shots, 'branch-cleanup-toast.png') });

  await undo.click();
  await expect
    .poll(localBranches)
    .toEqual(['feature/merged', 'feature/squash', 'main', 'spike/closed', 'wip/active']);
});
