import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Phase 3 (power operations) end-to-end: drag-and-drop merge with conflict prediction,
 * the conflict list + 3-way merge tool, commit merge; cherry-pick / reset / interactive
 * rebase from menus; file history & blame; terminal; preferences.
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..', '..');
const shots = path.join(appDir, 'test-results');

interface Session {
  tmp: string;
  repo: string;
  app: ElectronApplication;
  page: Page;
}

async function launch(fixture: string): Promise<Session> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kl-p3-${fixture}-`)));
  execFileSync(
    'pnpm',
    ['--filter', '@githappens/fixtures', 'make', fixture, `--root=${path.join(tmp, 'repos')}`],
    {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    },
  );
  const repo = path.join(tmp, 'repos', fixture);
  const app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: { ...process.env, GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'), ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 20_000 });
  return { tmp, repo, app, page };
}

const gitIn =
  (repo: string) =>
  (...args: string[]): string =>
    // Polling `git status` must not take index.lock and race the app's own ops.
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();

// ---------------------------------------------------------------------------

test.describe('merge with conflicts', () => {
  let s: Session;
  test.beforeAll(async () => {
    s = await launch('conflict');
  });
  test.afterAll(async () => {
    await s?.app.close();
    if (s) fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  test('drag feature onto main → merge with predicted conflicts → resolve → commit', async () => {
    const { page, repo } = s;
    const git = gitIn(repo);
    const graph = page.getByRole('grid', { name: 'Commit graph' });

    await graph.getByText('feature', { exact: true }).dragTo(graph.getByText('main', { exact: true }));
    const mergeItem = page.getByRole('menuitem', { name: /^Merge feature into main —/ });
    await expect(mergeItem).toBeVisible();
    await expect(mergeItem).toContainText(/⚠ will conflict in \d+ files?/);
    await mergeItem.click();

    await expect(page.getByRole('button', { name: 'Commit merge' })).toBeDisabled({ timeout: 15_000 });
    const list = page.getByRole('listbox', { name: 'Conflicted files' });
    // Resolved files stay listed with a ✓ until the merge is committed; count unresolved rows only.
    const unresolved = (name: RegExp) =>
      list.getByRole('option', { name }).filter({ hasNot: page.getByLabel('resolved', { exact: true }) });
    await expect(list.getByRole('option')).toHaveCount(4);
    await page.screenshot({ path: path.join(shots, 'phase3-conflicts.png') });

    // Resolve the text conflict in the 3-way merge tool.
    await list.getByRole('option', { name: /content\.txt/ }).click();
    await page.getByRole('button', { name: /Take all A/ }).click();
    await page.screenshot({ path: path.join(shots, 'phase3-merge-tool.png') });
    await page.getByRole('button', { name: /Save & mark resolved/ }).click();
    await expect(unresolved(/content\.txt/)).toHaveCount(0, { timeout: 10_000 });

    // Whole-file resolutions for the rest.
    for (const [file, side] of [
      ['add-add.txt', 'A'],
      ['binary.dat', 'B'],
      ['delete-modify.txt', 'B'],
    ] as const) {
      const row = unresolved(new RegExp(file.replace('.', '\\.')));
      await row.hover();
      await row.getByRole('button', { name: side, exact: true }).click();
      await expect(row).toHaveCount(0, { timeout: 10_000 });
    }

    // "Commit merge…" hands over to the commit composer, prefilled from MERGE_MSG.
    await page.getByRole('button', { name: /^Commit merge/ }).click();
    await page.getByRole('button', { name: 'Commit and Merge' }).click();
    await expect.poll(() => git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length).toBe(3);
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'content.txt'), 'utf8')).toContain('line 3 changed on main');
    expect(fs.existsSync(path.join(repo, 'delete-modify.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

test.describe('history tools', () => {
  let s: Session;
  test.beforeAll(async () => {
    s = await launch('branchy');
  });
  test.afterAll(async () => {
    await s?.app.close();
    if (s) fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  const menu = async (rowText: string, item: RegExp | string) => {
    const graph = s.page.getByRole('grid', { name: 'Commit graph' });
    const entry = s.page.getByRole('menuitem', { name: item });
    // The graph may still be re-rendering after the previous test (e.g. an undo removing a row), so
    // rows can shift under the cursor on slow runners: retry until the intended commit's menu is open.
    await expect(async () => {
      if (await s.page.getByRole('menu').isVisible()) await s.page.keyboard.press('Escape');
      await graph.getByText(rowText, { exact: true }).click({ button: 'right' });
      await expect(entry).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await entry.click();
  };

  test('cherry-pick a commit onto main, then undo it', async () => {
    const git = gitIn(s.repo);
    const before = git('rev-parse', 'HEAD');
    await menu('feature-b: WIP', 'Cherry pick commit');
    await expect.poll(() => git('log', '-1', '--format=%s'), { timeout: 20_000 }).toBe('feature-b: WIP');
    // Undo is always enabled (reflog fallback); click once it names the cherry-pick.
    await s.page.getByTitle(/^Undo .*cherry/i).click();
    await expect.poll(() => git('rev-parse', 'HEAD'), { timeout: 20_000 }).toBe(before);
    await expect.poll(() => git('status', '--porcelain'), { timeout: 20_000 }).toBe('');
  });

  test('hard reset asks for confirmation and moves the branch; undo restores it', async () => {
    const git = gitIn(s.repo);
    const before = git('rev-parse', 'HEAD');
    const target = git('log', '--format=%H', '--grep=^Add config$', '-n', '1');
    await menu('Add config', `Reset main to ${target.slice(0, 7)} (hard)`);
    await s.page.getByRole('button', { name: 'Reset hard' }).click();
    await expect.poll(() => git('rev-parse', 'HEAD'), { timeout: 20_000 }).toBe(target);
    expect(git('status', '--porcelain')).toBe('');
    await s.page.getByTitle(/^Undo .*reset/i).click();
    await expect.poll(() => git('rev-parse', 'HEAD'), { timeout: 20_000 }).toBe(before);
    await expect.poll(() => git('status', '--porcelain'), { timeout: 20_000 }).toBe('');
  });

  test('interactive rebase drops a commit without opening an editor', async () => {
    const git = gitIn(s.repo);
    // The app may briefly hold index.lock (background status refresh); retry the external checkout.
    await expect(async () => void git('checkout', '-q', 'feature-a')).toPass({ timeout: 10_000 });
    // Wait until the app has picked up the external checkout (watcher refresh).
    await expect(async () => {
      await s.page
        .getByRole('grid', { name: 'Commit graph' })
        .getByText('Add config', { exact: true })
        .click({ button: 'right' });
      try {
        await expect(
          s.page.getByRole('menuitem', { name: /^Interactive rebase feature-a from here/ }),
        ).toBeVisible({
          timeout: 500,
        });
      } catch (e) {
        await s.page.keyboard.press('Escape');
        throw e;
      }
    }).toPass({ timeout: 15_000 });
    await s.page.getByRole('menuitem', { name: /^Interactive rebase feature-a from here/ }).click();
    const todo = s.page.getByRole('listbox', { name: 'Rebase todo' });
    await expect(todo.getByRole('combobox', { name: /^Action for / })).toHaveCount(2);
    // Drop the newest commit (dropping part 1 would make part 2 conflict, since it edits a.txt).
    const tip = git('rev-parse', '--short', 'feature-a');
    await s.page.getByRole('combobox', { name: `Action for ${tip}` }).selectOption('drop');
    await s.page.screenshot({ path: path.join(shots, 'phase3-rebase-editor.png') });
    await s.page.getByRole('button', { name: 'Start rebase' }).click();
    await expect
      .poll(() => git('log', '--format=%s', '-1', 'feature-a'), { timeout: 20_000 })
      .toBe('feature-a: part 1');
    expect(git('status', '--porcelain')).toBe('');
    await expect(async () => void git('checkout', '-q', 'main')).toPass({ timeout: 10_000 });
  });

  test('file history and blame', async () => {
    const graph = s.page.getByRole('grid', { name: 'Commit graph' });
    await graph.getByText('Initial commit', { exact: true }).click();
    await s.page
      .getByRole('button', { name: /app\.txt/ })
      .first()
      .click({ button: 'right' });
    await s.page.getByRole('menuitem', { name: 'File history' }).click();
    await expect(
      s.page.getByRole('listbox', { name: 'File history' }).getByRole('option').first(),
    ).toBeVisible();
    await s.page.getByRole('tab', { name: /Blame/ }).click();
    await expect(s.page.getByRole('table', { name: 'Blame' })).toContainText('line 1');
    await s.page.screenshot({ path: path.join(shots, 'phase3-blame.png') });
    await s.page.getByRole('button', { name: 'Close file view' }).click();
  });

  test('integrated terminal runs git', async () => {
    await s.page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const term = s.page.locator('.xterm');
    await expect(term).toBeVisible({ timeout: 15_000 });
    await term.click();
    const rows = s.page.locator('.xterm-rows');
    // Wait for the shell to echo the command before pressing Enter: a slow shell start can drop it.
    await s.page.keyboard.type('git status');
    await expect(rows).toContainText('git status', { timeout: 20_000 });
    await s.page.keyboard.press('Enter');
    await expect(rows).toContainText('On branch main', { timeout: 20_000 });
    await s.page.screenshot({ path: path.join(shots, 'phase3-terminal.png') });
  });

  test('preferences open with sections', async () => {
    await s.page.getByRole('button', { name: 'Preferences' }).click();
    await expect(s.page.getByText('Keybindings').first()).toBeVisible();
    await expect(s.page.getByText('Themes').first()).toBeVisible();
    await s.page.screenshot({ path: path.join(shots, 'phase3-preferences.png') });
    await s.page.keyboard.press('Escape');
  });
});
