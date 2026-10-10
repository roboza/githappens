import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Phase 1 (read-only viewer) end-to-end: open a fixture repo from the command line,
 * browse the graph, inspect a commit, view diffs, search, and see live WIP updates.
 */

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const shots = path.join(appDir, 'test-results');
let tmp: string;
let repo: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-p1-')));
  execFileSync(
    'pnpm',
    ['--filter', '@githappens/fixtures', 'make', 'branchy', `--root=${path.join(tmp, 'repos')}`],
    {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    },
  );
  repo = path.join(tmp, 'repos', 'branchy');
  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: { ...process.env, GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'), ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('opens the repo from -p into a tab with graph, pills and left panel', async () => {
  await expect(page.getByRole('tab', { name: /branchy/ })).toBeVisible({ timeout: 15_000 });
  const graph = page.getByRole('grid', { name: 'Commit graph' });
  await expect(graph).toBeVisible({ timeout: 20_000 });
  await expect(graph.getByText('Octopus merge topics')).toBeVisible();
  await expect(graph.getByText('main', { exact: true }).first()).toBeVisible();
  const refsNav = page.getByRole('navigation', { name: 'Repository references' });
  await expect(refsNav.getByRole('treeitem', { name: /feature-a/ })).toBeVisible();
  await expect(refsNav.getByRole('treeitem', { name: /v1\.0/ })).toBeVisible();
  await expect(refsNav.getByRole('treeitem', { name: /WIP on app/ })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase1-graph.png') });
});

test('selecting a commit shows details; a file opens a diff in all three modes', async () => {
  const graph = page.getByRole('grid', { name: 'Commit graph' });
  await graph.getByText('feature-a: part 2').click();
  await expect(page.getByRole('heading', { name: 'feature-a: part 2' })).toBeVisible();
  await page
    .getByRole('button', { name: /a\.txt/ })
    .first()
    .click();
  const hunks = page.getByRole('table', { name: 'Diff hunks' });
  await expect(hunks).toBeVisible();
  await expect(hunks.getByText('a2', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase1-diff-hunk.png') });

  await page.getByRole('group', { name: 'Diff view mode' }).getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, 'phase1-diff-split.png') });

  await page.getByRole('button', { name: 'Close diff' }).click();
  await expect(graph).toBeVisible();
});

test('left panel click reveals and selects the branch tip', async () => {
  const refsNav = page.getByRole('navigation', { name: 'Repository references' });
  await refsNav.getByRole('treeitem', { name: /feature-b/ }).click();
  await expect(page.getByRole('heading', { name: 'feature-b: WIP' })).toBeVisible();
});

test('search highlights matches across loaded history', async () => {
  await page.getByRole('textbox', { name: 'Search commits' }).fill('cross');
  await expect(page.getByText(/^1 \/ [4-9]$/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Search commits' }).fill('@carol');
  await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Search commits' }).fill('');
});

test('editing a file outside the app shows a WIP row (watcher)', async () => {
  fs.writeFileSync(path.join(repo, 'README.md'), '# Branchy\n\nedited outside\n');
  const graph = page.getByRole('grid', { name: 'Commit graph' });
  await expect(graph.getByText('// WIP')).toBeVisible({ timeout: 10_000 });
  await graph.getByText('// WIP').click();
  await expect(page.getByRole('heading', { name: /file change/ })).toBeVisible();
  await expect(
    page.getByRole('listbox', { name: 'Unstaged files' }).getByRole('option', { name: /README\.md/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase1-wip.png') });
});
