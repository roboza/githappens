import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { findGitOnPath, makeNoGitEnv, type NoGitEnv } from './no-git-env';

/**
 * Spec 15 §3 / §9: the app works on a machine without git. Launches the dev build (`out/`) with git
 * removed from PATH (and no login shell / GIT_* env to find one through), then opens a repo, renders the
 * graph, commits through the UI and checks that the status bar and About report the bundled git
 * (node_modules/dugite/git in development; resources/git when packaged — see packaged.spec.ts).
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
let tmp: string;
let repo: string;
let noGit: NoGitEnv;
let app: ElectronApplication;
let page: Page;

/** The *test harness* may use the developer's git to build and inspect the fixture repo. */
const git = (...args: string[]): string =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: noGit.env.GIT_CONFIG_GLOBAL,
    },
  }).trim();

const graph = () => page.getByRole('grid', { name: 'Commit graph' });
const commitRow = (text: string) =>
  graph().getByRole('row').filter({ hasNotText: '// WIP' }).filter({ hasText: text });
const prefs = () => page.getByRole('dialog', { name: 'Preferences' });
const bundledDir = path.join(
  path.dirname(require.resolve('dugite/package.json', { paths: [appDir] })),
  'git',
);

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-nogit-')));
  noGit = makeNoGitEnv();
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# no git\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Initial commit without system git');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Second commit');

  // Sanity: the environment really has no git, and the bundled one exists.
  const pathKey = Object.keys(noGit.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  expect(findGitOnPath(noGit.env[pathKey] ?? '')).toBeNull();
  expect(noGit.env.SHELL).toBeUndefined();
  expect(noGit.env.GIT_EXEC_PATH).toBeUndefined();
  expect(fs.existsSync(bundledDir)).toBe(true);

  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), '-p', repo],
    cwd: appDir,
    env: { ...noGit.env, GITHAPPENS_USER_DATA_DIR: path.join(tmp, 'userData'), ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  if (noGit) fs.rmSync(noGit.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

test('opens the repository and renders the graph with bundled git', async () => {
  await expect(graph()).toBeVisible({ timeout: 30_000 });
  await expect(commitRow('Second commit')).toBeVisible({ timeout: 15_000 });
  await expect(commitRow('Initial commit without system git')).toBeVisible();
  // The status bar shows the active engine's version.
  const bundledVersion = /git version (\d+\.\d+\.\d+)/.exec(
    execFileSync(
      process.platform === 'win32'
        ? path.join(bundledDir, 'cmd', 'git.exe')
        : path.join(bundledDir, 'bin', 'git'),
      ['--version'],
      {
        encoding: 'utf8',
        env: {
          ...noGit.env,
          GIT_EXEC_PATH:
            process.platform === 'win32'
              ? path.join(
                  bundledDir,
                  process.arch === 'arm64' ? 'clangarm64' : 'mingw64',
                  'libexec',
                  'git-core',
                )
              : path.join(bundledDir, 'libexec', 'git-core'),
        },
      },
    ),
  )?.[1];
  expect(bundledVersion).toBeTruthy();
  await expect(page.locator('footer').getByText(`Git ${bundledVersion}`)).toBeVisible();
});

test('commits through the UI', async () => {
  fs.writeFileSync(path.join(repo, 'README.md'), '# no git\n\ncommitted by bundled git\n');
  await graph().getByText('// WIP').click({ timeout: 15_000 });
  const row = page
    .getByRole('listbox', { name: 'Unstaged files' })
    .getByRole('option', { name: /README\.md/ });
  await row.hover();
  await row.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(page.getByRole('listbox', { name: 'Staged files' }).getByText('README.md')).toBeVisible();
  await page.getByRole('textbox', { name: 'Commit summary' }).fill('Commit from a machine without git');
  await page.getByRole('button', { name: /Commit changes to 1 file/ }).click();
  await expect
    .poll(() => git('log', '-1', '--format=%s'), { timeout: 15_000 })
    .toBe('Commit from a machine without git');
  expect(git('log', '-1', '--format=%an <%ae>')).toBe('No Git E2E <nogit@example.com>');
  await expect(commitRow('Commit from a machine without git')).toBeVisible({ timeout: 15_000 });
  expect(git('status', '--porcelain')).toBe('');
});

test('About reports the bundled git and its path; diagnostics can be copied', async () => {
  await page.getByRole('button', { name: 'Preferences' }).click();
  await prefs()
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: 'About', exact: true })
    .click();
  const engine = prefs().getByRole('region', { name: 'Git engine' });
  await expect(engine.getByText('bundled', { exact: true })).toBeVisible();
  const enginePath = (await engine.locator('dd.mono').first().textContent()) ?? '';
  expect(path.normalize(enginePath).toLowerCase()).toContain(path.normalize(bundledDir).toLowerCase());

  const about = prefs().getByRole('region', { name: 'Environment' });
  await expect(about).toContainText('Bundled Git');
  await expect(about).toContainText(/Git path/);
  await expect(about).toContainText(path.join('dugite', 'git'));

  await about.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(about.getByText('Diagnostics copied to the clipboard.')).toBeVisible();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toMatch(/^GitHappens \d+\.\d+\.\d+/);
  expect(copied).toMatch(/Git \(active\): \d+\.\d+\.\d+ \(bundled\) .*dugite/);
  expect(copied).not.toContain('nogit@example.com');
});

test('choosing System git on a machine without git falls back to bundled with a warning', async () => {
  const engine = prefs().getByRole('region', { name: 'Git engine' });
  await engine.getByLabel('System (PATH)').check();
  await engine.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'System Git was not found on PATH. Using bundled Git instead.',
  );
  await expect(engine.getByText('bundled', { exact: true })).toBeVisible();
  await prefs().getByRole('button', { name: 'Close preferences' }).click();
  // Still fully functional afterwards.
  await expect(commitRow('Commit from a machine without git')).toBeVisible();
});
