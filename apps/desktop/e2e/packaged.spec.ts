import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

import { findGitOnPath, makeNoGitEnv } from './no-git-env';

/**
 * Smoke test of a packaged build (release workflow): the installed layout must start on a machine
 * without git (git is stripped from PATH for the app, spec 15 §3), find its bundled git in
 * resources/git and load the native modules (node-pty, @parcel/watcher). Skipped unless
 * GH_PACKAGED_APP points at the packaged executable.
 */
const exe = process.env.GH_PACKAGED_APP;

test.skip(!exe, 'set GH_PACKAGED_APP to the packaged executable');

test('packaged app opens a repo with bundled git (no system git) and runs a terminal', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pkg-')));
  const noGit = makeNoGitEnv();
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  // The harness itself may use the runner's git to build the fixture.
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'Packaged smoke commit');

  const pathKey = Object.keys(noGit.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  expect(findGitOnPath(noGit.env[pathKey] ?? ''), 'no git on the app PATH').toBeNull();

  const app = await electron.launch({
    executablePath: exe!,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    env: { ...noGit.env, GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData') },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Packaged smoke commit')).toBeVisible();
    // Status bar shows the resolved engine; the bundled one lives in resources/git.
    await expect(
      page
        .locator('footer')
        .getByText(/Git 2\.\d+/)
        .first(),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Preferences' }).click();
    const prefs = page.getByRole('dialog', { name: 'Preferences' });
    await prefs
      .getByRole('navigation', { name: 'Preference sections' })
      .getByRole('button', { name: 'About', exact: true })
      .click();
    const engine = prefs.getByRole('region', { name: 'Git engine' });
    await expect(engine.getByText('bundled', { exact: true })).toBeVisible();
    const gitPath = (await engine.locator('dd.mono').first().textContent()) ?? '';
    const resources = path.normalize(
      process.platform === 'darwin'
        ? path.join(path.dirname(path.dirname(exe!)), 'Resources', 'git')
        : path.join(path.dirname(exe!), 'resources', 'git'),
    );
    expect(path.normalize(gitPath).toLowerCase().startsWith(resources.toLowerCase())).toBe(true);
    await expect(prefs.getByRole('region', { name: 'Environment' })).toContainText('Bundled Git');
    await prefs.getByRole('button', { name: 'Close preferences' }).click();

    // node-pty loads and a shell runs; git is not on the system PATH, so `git` here is the bundled
    // one the terminal appends as a fallback.
    await page.getByRole('button', { name: 'Terminal' }).click();
    const term = page.locator('.xterm');
    await expect(term).toBeVisible({ timeout: 20_000 });
    await term.click();
    await page.keyboard.type('echo kl-terminal-$((40+2))\r');
    await expect(page.locator('.xterm-rows')).toContainText('kl-terminal-42', { timeout: 20_000 });
    await page.keyboard.type('git log --oneline -1\r');
    await expect(page.locator('.xterm-rows')).toContainText('Packaged smoke commit', { timeout: 20_000 });
  } finally {
    await app.close();
    fs.rmSync(noGit.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
