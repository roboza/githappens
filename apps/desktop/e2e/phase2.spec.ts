import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Phase 2 (everyday Git) end-to-end against a local clone with a file:// remote that
 * is 1 commit ahead / 1 behind: stage → commit → undo/redo, hunk staging, branches,
 * pull/push, stash, palette, clone.
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const shots = path.join(appDir, 'test-results');
let tmp: string;
let repo: string;
let remote: string;
let app: ElectronApplication;
let page: Page;

// GIT_OPTIONAL_LOCKS=0: polling `git status` must not take index.lock and race the app's own ops.
const git = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-p2-')));
  execFileSync(
    'pnpm',
    ['--filter', '@githappens/fixtures', 'make', 'remote-pair', `--root=${path.join(tmp, 'repos')}`],
    { cwd: repoRoot, stdio: 'ignore', shell: process.platform === 'win32' },
  );
  repo = path.join(tmp, 'repos', 'remote-pair', 'local');
  remote = path.join(tmp, 'repos', 'remote-pair', 'remote.git');
  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: { ...process.env, GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'), ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const graph = () => page.getByRole('grid', { name: 'Commit graph' });
/** A commit row (not the WIP row, which also shows the composer draft). */
const commitRow = (text: string) =>
  graph().getByRole('row').filter({ hasNotText: '// WIP' }).filter({ hasText: text });
const toast = (text: string | RegExp) => page.getByRole('region', { name: 'Notifications' }).getByText(text);

test('stage a file, commit it, undo and redo the commit', async () => {
  fs.writeFileSync(path.join(repo, 'README.md'), '# Remote pair\n\nchanged in e2e\n');
  await graph().getByText('// WIP').click({ timeout: 10_000 });
  const unstaged = page.getByRole('listbox', { name: 'Unstaged files' });
  const row = unstaged.getByRole('option', { name: /README\.md/ });
  await row.hover();
  await row.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(page.getByRole('listbox', { name: 'Staged files' }).getByText('README.md')).toBeVisible();

  await page.getByRole('textbox', { name: 'Commit summary' }).fill('Update readme from e2e');
  await page.getByRole('button', { name: /Commit changes to 1 file/ }).click();
  // The WIP row also shows the composer draft, so check git and the real commit rows only.
  await expect
    .poll(() => git('log', '-1', '--format=%s'), { timeout: 15_000 })
    .toBe('Update readme from e2e');
  await expect(commitRow('Update readme from e2e')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, 'phase2-committed.png') });

  await page.getByTitle(/^Undo /).click();
  await expect.poll(() => git('diff', '--cached', '--name-only'), { timeout: 15_000 }).toBe('README.md');
  await expect(commitRow('Update readme from e2e')).toHaveCount(0);

  await page.getByTitle(/^Redo /).click();
  await expect
    .poll(() => git('log', '-1', '--format=%s'), { timeout: 15_000 })
    .toBe('Update readme from e2e');
  await expect(commitRow('Update readme from e2e')).toBeVisible({ timeout: 15_000 });
  expect(git('status', '--porcelain')).toBe('');
});

test('stage a single hunk from the diff view', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(repo, 'hunks.txt'), `${lines.join('\n')}\n`);
  git('add', 'hunks.txt');
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'Add hunks.txt');
  lines[1] = 'line 2 changed';
  lines[27] = 'line 28 changed';
  fs.writeFileSync(path.join(repo, 'hunks.txt'), `${lines.join('\n')}\n`);

  await graph().getByText('// WIP').click({ timeout: 10_000 });
  await page.getByRole('listbox', { name: 'Unstaged files' }).getByText('hunks.txt').click();
  const hunks = page.getByRole('table', { name: 'Diff hunks' });
  await expect(hunks.getByRole('button', { name: 'Stage hunk' })).toHaveCount(2);
  await hunks.getByRole('button', { name: 'Stage hunk' }).first().click();
  await expect.poll(() => git('diff', '--cached', '--unified=0', 'hunks.txt')).toContain('+line 2 changed');
  expect(git('diff', '--cached', 'hunks.txt')).not.toContain('line 28 changed');
  expect(git('diff', 'hunks.txt')).toContain('+line 28 changed');
  await page.screenshot({ path: path.join(shots, 'phase2-hunk-staging.png') });

  // clean up for later tests
  git('reset', '-q', '--hard');
  await page.keyboard.press('Escape');
});

test('create a branch from the toolbar and check main out again by double-click', async () => {
  await page.getByRole('button', { name: 'Branch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create branch' });
  await dialog.getByRole('textbox').fill('feature/e2e');
  await dialog.getByRole('button', { name: 'Create branch' }).click();
  await expect.poll(() => git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/e2e');
  await expect(page.getByText('feature/e2e', { exact: true }).first()).toBeVisible();

  const refsNav = page.getByRole('navigation', { name: 'Repository references' });
  await refsNav.getByRole('tree', { name: 'Local' }).getByRole('treeitem', { name: /^main/ }).dblclick();
  await expect.poll(() => git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
});

test('pull merges the remote commit, then push publishes', async () => {
  await page.getByRole('button', { name: /^Pull( \d+)?$/ }).click();
  await expect(toast(/Pulled and merged|Fast-forwarded/)).toBeVisible({ timeout: 20_000 });
  expect(git('log', '--format=%s', '-n', '20')).toContain('Pushed by someone else');

  await page.getByRole('button', { name: /^Push( \d+)?$/ }).click();
  await expect(toast(/Pushed main to origin\/main/)).toBeVisible({ timeout: 20_000 });
  expect(execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe(
    git('rev-parse', 'HEAD'),
  );
});

test('stash changes from the toolbar and pop them back', async () => {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'stash me\n');
  await expect(graph().getByText('// WIP')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Stash', exact: true }).click();
  await expect(toast('Changes stashed')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => git('stash', 'list'), { timeout: 15_000 }).toContain('stash@{0}');
  await expect.poll(() => git('status', '--porcelain'), { timeout: 15_000 }).toBe('');

  await page.getByRole('button', { name: 'Pop', exact: true }).click();
  await expect.poll(() => git('status', '--porcelain'), { timeout: 15_000 }).toContain('a.txt');
  await expect.poll(() => git('stash', 'list'), { timeout: 15_000 }).toBe('');
  git('checkout', '--', 'a.txt');
});

test('command palette runs Fetch All', async () => {
  await page.getByRole('grid', { name: 'Commit graph' }).click();
  await page.keyboard.press('Control+p');
  const palette = page.getByRole('dialog', { name: /command palette/i });
  await expect(palette).toBeVisible();
  await page.keyboard.type('fetch all');
  await page.keyboard.press('Enter');
  await expect(toast(/^Fetched /).first()).toBeVisible({ timeout: 20_000 });
});

test('clone a repository from the New Tab page', async () => {
  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('button', { name: 'Clone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clone a repository' });
  await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(pathToFileURL(remote).href);
  await dialog.getByRole('textbox', { name: 'Parent folder' }).fill(path.join(tmp, 'clones'));
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^remote/ })).toBeVisible({ timeout: 30_000 });
  expect(fs.existsSync(path.join(tmp, 'clones', 'remote', 'README.md'))).toBe(true);
  await expect(graph().getByText('Pushed by someone else')).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'phase2-cloned.png') });
});
