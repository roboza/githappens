import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import {
  accessToken,
  api,
  devLogin,
  footprintHash,
  startCloudServer,
  type CloudServer,
} from './cloud-server';

/**
 * Phase 6 end-to-end (optional cloud), fully offline: the real `services/cloud` backend runs on
 * 127.0.0.1 (dev mode: in-memory store + dev IdP). `shell.openExternal` is stubbed in the main process
 * so the test drives the dev sign-in page over HTTP and then hits the app's loopback callback.
 *
 * Machines (each an Electron instance with its own user-data dir):
 *   A  ana@example.com — repos alpha + bravo; sign-in, sync (A side), org, Cloud Patches, team footprints
 *   B  ana@example.com — no repo; sync (B side: unlock with the passphrase, preference arrives)
 *   C  no cloud at all — conflict prevention against origin/main
 *
 * Layout under a temp dir:
 *   origin.git        bare remote; alpha + bravo pretend it is github.com/acme/app (url.insteadOf)
 *   alpha, bravo      clones of origin.git (same repo identity)
 *   conflicts.git     bare remote for machine C; charlie = its clone with a conflicting branch
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const shots = path.join(appDir, 'test-results');
const FAKE_URL = 'https://github.com/acme/app.git';
const REPO_ID = { provider: 'github', host: 'github.com', owner: 'acme', name: 'app' };
const ANA = { email: 'ana@example.com', name: 'Ana Example' };
const BOB = { email: 'bob@example.com', name: 'Bob Builder' };
const PASSPHRASE = 'correct horse battery';
const ORG = 'Acme Robotics';

let tmp: string;
let cloud: CloudServer;
let alpha: string;
let bravo: string;
let charlie: string;
let appA: ElectronApplication;
let pageA: Page;
const rendererHttp: string[] = [];
let patchLink = '';

const gitIn =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const identity = (git: (...a: string[]) => string): void => {
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
};

const quiet = { stdio: 'ignore' } as const;

/** Bare `main` remote with one commit pushed from a throwaway seed clone; returns the seed's git. */
function makeRemote(bare: string, files: Record<string, string>): (...a: string[]) => string {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], quiet);
  const seedDir = `${bare}-seed`;
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', pathToFileURL(bare).href, seedDir], quiet);
  const seed = gitIn(seedDir);
  identity(seed);
  seed('checkout', '-q', '-B', 'main');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(seedDir, f), c);
  seed('add', '-A');
  seed('commit', '-q', '-m', 'Initial commit');
  seed('push', '-q', 'origin', 'main');
  return seed;
}

function clone(bare: string, dir: string, fakeUrl?: string): (...a: string[]) => string {
  // no autocrlf: checked-out files must match the (LF) blobs exactly
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', pathToFileURL(bare).href, dir], quiet);
  const git = gitIn(dir);
  identity(git);
  if (fakeUrl) {
    git('config', `url.${pathToFileURL(bare).href}.insteadOf`, fakeUrl);
    git('remote', 'set-url', 'origin', fakeUrl);
  }
  return git;
}

function launch(userData: string, repos: string[]): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      appDir,
      ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...repos.flatMap((r) => ['-p', r]),
    ],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: userData,
      ELECTRON_RENDERER_URL: '',
      GH_OAUTH_GITHUB_CLIENT_ID: '',
      GH_OAUTH_BROKER_URL: '',
    },
  });
}

/** Replace `shell.openExternal` in main: URLs are recorded instead of opening a browser. */
async function captureExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __klOpened: string[] };
    g.__klOpened = [];
    shell.openExternal = (async (url: string) => {
      g.__klOpened.push(url);
    }) as typeof shell.openExternal;
  });
}

const openedUrls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __klOpened?: string[] }).__klOpened ?? []);

const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);

const prefsDialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' });

async function openPrefs(page: Page, section: string): Promise<ReturnType<typeof prefsDialog>> {
  const prefs = prefsDialog(page);
  if (!(await prefs.isVisible())) await page.getByRole('button', { name: 'Preferences' }).click();
  await prefs
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: section, exact: true })
    .click();
  return prefs;
}

async function closePrefs(page: Page): Promise<void> {
  const prefs = prefsDialog(page);
  if (await prefs.isVisible()) await prefs.getByRole('button', { name: 'Close preferences' }).click();
  await expect(prefs).toBeHidden();
}

/** Preferences → Account: configure the server, sign in with the dev IdP, wait for the account button. */
async function signIn(app: ElectronApplication, page: Page, user: { email: string; name: string }) {
  await captureExternal(app);
  const prefs = await openPrefs(page, 'Account');
  const panel = prefs.getByTestId('account-panel');
  await panel.getByRole('textbox', { name: 'Cloud server address' }).fill(cloud.url);
  await panel.getByRole('button', { name: 'Validate' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Developer login' })).toContainText(
    `at ${cloud.url}`,
  );
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByRole('button', { name: 'Continue with Developer login' }).click();

  let authorize = '';
  await expect
    .poll(async () => {
      authorize = (await openedUrls(app)).find((u) => u.includes('/oauth/authorize')) ?? '';
      return authorize;
    })
    .toContain(`${cloud.url}/oauth/authorize?`);
  expect(authorize).toContain('idp=dev');
  const callback = await devLogin(authorize, user.email, user.name);
  expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  const res = await fetch(callback); // the app's loopback listener finishes the sign-in
  expect(res.ok).toBe(true);

  await expect(page.getByRole('button', { name: `Account: ${user.name}` })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(`${user.email} · ${cloud.url.replace('http://', '')}`)).toBeVisible();
  return prefs;
}

// -----------------------------------------------------------------------------------------------------

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-p6-')));
  cloud = await startCloudServer(path.join(tmp, 'cloud-data'));

  // alpha + bravo: two clones of one remote that claims to be github.com/acme/app
  const origin = path.join(tmp, 'origin.git');
  makeRemote(origin, { 'README.md': '# Alpha\n\nShared project.\n', 'src.txt': 'one\ntwo\nthree\n' });
  alpha = path.join(tmp, 'alpha');
  bravo = path.join(tmp, 'bravo');
  clone(origin, alpha, FAKE_URL);
  clone(origin, bravo, FAKE_URL);
  // uncommitted work in alpha: a modified tracked file + a new untracked file
  fs.writeFileSync(path.join(alpha, 'README.md'), '# Alpha (edited)\n\nShared project.\n');
  fs.writeFileSync(path.join(alpha, 'new-file.txt'), 'brand new\n');

  // charlie: branch "feature" edits line 2 of conflict.txt, origin/main edits it differently
  const conflictsRemote = path.join(tmp, 'conflicts.git');
  const seed = makeRemote(conflictsRemote, {
    'conflict.txt': 'line 1\nline 2\nline 3\n',
    'other.txt': 'other\n',
  });
  charlie = path.join(tmp, 'charlie');
  const c = clone(conflictsRemote, charlie);
  c('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(charlie, 'conflict.txt'), 'line 1\nline 2 from feature\nline 3\n');
  c('commit', '-q', '-am', 'Feature edits line 2');
  c('checkout', '-q', '-b', 'harmless', 'main');
  fs.writeFileSync(path.join(charlie, 'other.txt'), 'other, harmless change\n');
  c('commit', '-q', '-am', 'Harmless change');
  c('checkout', '-q', 'feature');
  const seedDir = `${conflictsRemote}-seed`;
  fs.writeFileSync(path.join(seedDir, 'conflict.txt'), 'line 1\nline 2 from main\nline 3\n');
  seed('commit', '-q', '-am', 'Main edits line 2');
  seed('push', '-q', 'origin', 'main');
  c('fetch', '-q', 'origin');

  appA = await launch(path.join(tmp, 'userData-A'), [alpha, bravo]);
  pageA = await appA.firstWindow();
  pageA.on('request', (r) => {
    if (/^https?:/i.test(r.url())) rendererHttp.push(r.url());
  });
  await expect(pageA.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 30_000 });
  await pageA.getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name: /alpha/ }).click();
  await expect(pageA.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
});

test.afterAll(async () => {
  await appA?.close().catch(() => undefined);
  await cloud?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

// ---- 1. No server configured -------------------------------------------------------------------------

test('no server configured: "Sign in" entry only, no cloud sections, no network', async () => {
  const signIn = pageA.getByTestId('account-sign-in');
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveText('Sign in');
  await expect(signIn).toHaveAttribute('title', 'Set up a GitHappens Cloud account (optional)');
  await expect(pageA.getByTestId('account-button')).toHaveCount(0);

  const nav = pageA.getByRole('navigation', { name: 'Repository references' });
  await expect(nav.getByRole('tree', { name: 'Local' })).toBeVisible();
  await expect(nav.getByText('Cloud Patches', { exact: true })).toHaveCount(0);
  await expect(nav.getByText('Team', { exact: true })).toHaveCount(0);

  // the WIP header has no "Share as Cloud Patch" icon
  await pageA.getByRole('grid', { name: 'Commit graph' }).getByText('// WIP').click({ timeout: 15_000 });
  await expect(pageA.getByRole('listbox', { name: 'Unstaged files' }).getByText('README.md')).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageA.getByRole('button', { name: 'Share as Cloud Patch' })).toHaveCount(0);

  // Preferences → Account says cloud is off; Organization asks to sign in
  const prefs = await openPrefs(pageA, 'Account');
  await expect(prefs.getByText('Cloud features are off.')).toBeVisible();
  await expect(
    prefs.getByText('Sign in to GitHappens Cloud to create or join an organization.'),
  ).toBeVisible();
  await expect(prefs.getByRole('button', { name: /Continue with/ })).toHaveCount(0);
  await pageA.screenshot({ path: path.join(shots, 'phase6-no-cloud.png') });
  await closePrefs(pageA);

  // nothing reached the cloud server, and the renderer made no http(s) requests at all
  expect(cloud.requestCount()).toBe(0);
  expect(rendererHttp).toEqual([]);
});

// ---- 2. Sign in --------------------------------------------------------------------------------------

test('sign in with the dev IdP through the system-browser flow', async () => {
  await pageA.getByTestId('account-sign-in').click();
  await signIn(appA, pageA, ANA);
  await pageA.screenshot({ path: path.join(shots, 'phase6-signed-in.png') });
  await closePrefs(pageA);

  const button = pageA.getByRole('button', { name: `Account: ${ANA.name}` });
  await button.click();
  const menu = pageA.getByRole('menu', { name: 'Account' });
  await expect(menu.getByText(ANA.email)).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await pageA.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // the cloud sections appear once signed in
  const nav = pageA.getByRole('navigation', { name: 'Repository references' });
  await expect(nav.getByText('Cloud Patches', { exact: true })).toBeVisible();
  await expect(nav.getByText('Team', { exact: true })).toBeVisible();
  // the desktop never handed a token to the renderer
  const html = await pageA.evaluate(() => document.documentElement.outerHTML + JSON.stringify(localStorage));
  expect(html).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
});

// ---- 3. Settings sync between two machines -----------------------------------------------------------

test('settings sync: passphrase on A, preference arrives on B, server stores ciphertext only', async () => {
  test.setTimeout(150_000);
  // A: turn sync on and create the passphrase → recovery key is shown once
  let prefs = await openPrefs(pageA, 'Account');
  const sync = prefs.getByTestId('sync-section');
  // controlled by main's sync status: the click toggles it asynchronously
  await sync.getByRole('switch', { name: 'Sync settings across computers' }).click();
  await expect(sync.getByRole('switch', { name: 'Sync settings across computers' })).toBeChecked();
  await sync.getByLabel('Sync passphrase', { exact: true }).fill(PASSPHRASE);
  await sync.getByLabel('Repeat sync passphrase').fill(PASSPHRASE);
  await sync.getByRole('button', { name: 'Set up sync' }).click();
  const recovery = sync.getByRole('region', { name: 'Recovery key' });
  await expect(recovery).toBeVisible({ timeout: 20_000 });
  const recoveryKey = (await recovery.getByTestId('recovery-key').textContent())?.trim() ?? '';
  expect(recoveryKey).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/);
  await pageA.screenshot({ path: path.join(shots, 'phase6-sync-recovery-key.png') });
  await recovery.getByRole('button', { name: 'I saved it' }).click();
  await expect(recovery).toBeHidden();

  // A: change a synced preference (Editor & Diff → Context lines)
  prefs = await openPrefs(pageA, 'Editor & Diff');
  const ctx = prefs.getByRole('spinbutton', { name: 'Context lines' });
  await ctx.fill('7');
  await ctx.press('Enter');
  await expect(prefs.getByRole('button', { name: 'Reset Context lines to default' })).toBeVisible();

  // A: Sync now
  await openPrefs(pageA, 'Account');
  const syncNow = sync.getByRole('button', { name: 'Sync now' });
  await syncNow.click();
  await expect(syncNow).toBeEnabled({ timeout: 20_000 });
  await expect(sync.getByText(/^Last synced/)).toBeVisible({ timeout: 20_000 });
  await closePrefs(pageA);

  // The server holds only ciphertext: read the category with our own token for the same account.
  const token = await accessToken(cloud.url, ANA.email, ANA.name);
  const cats = await api<Array<{ category: string }>>(cloud.url, token, 'GET', '/v1/sync');
  expect(cats.data.map((x) => x.category)).toEqual(expect.arrayContaining(['_keys', 'preferences']));
  const item = await api<{ ciphertext: string; nonce: string; version: number }>(
    cloud.url,
    token,
    'GET',
    '/v1/sync/preferences',
  );
  expect(item.data.ciphertext.length).toBeGreaterThan(16);
  const bytes = Buffer.from(item.data.ciphertext, 'base64url');
  for (const plain of ['diff.contextLines', 'contextLines', '"diff']) {
    expect(item.raw).not.toContain(plain);
    expect(bytes.includes(Buffer.from(plain, 'utf8'))).toBe(false);
  }
  const keys = await api<{ ciphertext: string }>(cloud.url, token, 'GET', '/v1/sync/_keys');
  expect(keys.raw).not.toContain(PASSPHRASE);
  expect(keys.raw).not.toContain(recoveryKey);

  // B: a second computer, same account
  const appB = await launch(path.join(tmp, 'userData-B'), []);
  try {
    const pageB = await appB.firstWindow();
    await expect(pageB.getByRole('button', { name: 'Preferences' })).toBeVisible({ timeout: 30_000 });
    let prefsB = await openPrefs(pageB, 'Account');
    await signIn(appB, pageB, ANA);
    const syncB = prefsB.getByTestId('sync-section');
    // controlled by main's sync status: the click toggles it asynchronously
    await syncB.getByRole('switch', { name: 'Sync settings across computers' }).click();
    await expect(syncB.getByRole('switch', { name: 'Sync settings across computers' })).toBeChecked();
    await expect(syncB.getByText('Unlock sync on this computer', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // a wrong passphrase is refused
    await syncB.getByLabel('Sync passphrase', { exact: true }).fill('not the passphrase');
    await syncB.getByRole('button', { name: 'Unlock' }).click();
    await expect(syncB.getByRole('alert')).toBeVisible({ timeout: 20_000 });
    await syncB.getByLabel('Sync passphrase', { exact: true }).fill(PASSPHRASE);
    await syncB.getByRole('button', { name: 'Unlock' }).click();
    await expect(syncB.getByRole('button', { name: 'Sync now' })).toBeVisible({ timeout: 20_000 });
    await expect(syncB.getByText(/^Last synced/)).toBeVisible({ timeout: 20_000 });

    prefsB = await openPrefs(pageB, 'Editor & Diff');
    await expect(prefsB.getByRole('spinbutton', { name: 'Context lines' })).toHaveValue('7', {
      timeout: 20_000,
    });
    await pageB.screenshot({ path: path.join(shots, 'phase6-sync-machine-b.png') });
  } finally {
    await appB.close();
  }
});

// ---- 4. Organization ---------------------------------------------------------------------------------

test('organization: create one in Preferences, it shows in the account menu', async () => {
  const prefs = await openPrefs(pageA, 'Account');
  const org = prefs.getByTestId('organization-panel');
  await org.getByRole('textbox', { name: 'New organization name' }).fill(ORG);
  await org.getByRole('button', { name: 'Create organization' }).click();
  await expect(org.getByRole('heading', { name: `${ORG} · Owner` })).toBeVisible({ timeout: 15_000 });
  await expect(org.getByRole('heading', { name: 'Members (1)' })).toBeVisible();
  await expect(org.getByRole('combobox', { name: 'Active organization' })).toHaveValue(/.+/);
  await pageA.screenshot({ path: path.join(shots, 'phase6-org.png') });
  await closePrefs(pageA);

  await pageA.getByRole('button', { name: `Account: ${ANA.name}` }).click();
  const menu = pageA.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitemradio', { name: ORG })).toHaveAttribute('aria-checked', 'true');
  await pageA.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

// ---- 5. Cloud Patch round trip -----------------------------------------------------------------------

test('cloud patch: share WIP from alpha (e2e link), open and apply it in bravo, undo', async () => {
  test.setTimeout(120_000);
  const gitA = gitIn(alpha);
  const gitB = gitIn(bravo);
  const statusBefore = gitA('status', '--porcelain');

  await pageA.getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name: /alpha/ }).click();
  await pageA.getByRole('grid', { name: 'Commit graph' }).getByText('// WIP').click({ timeout: 15_000 });
  const share = pageA.getByRole('button', { name: 'Share as Cloud Patch' });
  await expect(share).toBeEnabled({ timeout: 15_000 });
  await share.click();

  const dialog = pageA.getByRole('dialog', { name: 'Share as Cloud Patch' });
  await expect(dialog).toBeVisible();
  // nothing is staged → all working changes, including the untracked file
  await expect(dialog.getByRole('radio', { name: /All working changes/ })).toBeChecked({ timeout: 15_000 });
  const files = dialog.getByRole('tree', { name: 'Files' });
  await expect(files.getByRole('checkbox', { name: 'README.md' })).toBeChecked();
  await expect(files.getByRole('checkbox', { name: 'new-file.txt' })).toBeChecked();
  await expect(dialog.getByText(/^2 of 2 files/)).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Anyone with the link' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /End-to-end encrypt/ })).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Edited readme and a new file');
  await dialog.getByRole('button', { name: 'Create Cloud Patch' }).click();

  const created = pageA.getByRole('dialog', { name: 'Cloud Patch created' });
  await expect(created).toBeVisible({ timeout: 20_000 });
  await expect(created.getByText('the server cannot read the patch')).toBeVisible();
  const link = await created.getByRole('textbox', { name: 'Cloud Patch link' }).inputValue();
  expect(link).toMatch(new RegExp(`^${cloud.url.replace(/[.]/g, '\\.')}/p/[A-Za-z0-9]{16,32}#k=[\\w-]+$`));
  expect(await appA.evaluate(({ clipboard }) => clipboard.readText())).toBe(link);
  await pageA.screenshot({ path: path.join(shots, 'phase6-patch-created.png') });
  await created.getByRole('button', { name: 'Done' }).click();
  await expect(created).toBeHidden();

  // sharing never touched alpha's index or working tree
  expect(gitA('diff', '--cached', '--name-only')).toBe('');
  expect(gitA('status', '--porcelain')).toBe(statusBefore);
  const nav = pageA.getByRole('navigation', { name: 'Repository references' });
  await expect(
    nav.getByRole('list', { name: 'Created by me' }).getByText('Edited readme and a new file'),
  ).toBeVisible({
    timeout: 15_000,
  });

  // the server only has ciphertext: anonymous metadata has no file list, the blob no plaintext
  const id = /\/p\/([A-Za-z0-9]+)/.exec(link)![1]!;
  const meta = (await (await fetch(`${cloud.url}/v1/patches/${id}`)).json()) as {
    e2e: boolean;
    files?: unknown[];
    downloadUrl: string;
  };
  expect(meta.e2e).toBe(true);
  expect(meta.files).toBeUndefined();
  const blob = Buffer.from(await (await fetch(meta.downloadUrl)).arrayBuffer());
  expect(blob.length).toBeGreaterThan(0);
  for (const plain of ['brand new', 'Alpha (edited)', 'new-file.txt', 'README.md']) {
    expect(blob.includes(Buffer.from(plain, 'utf8'))).toBe(false);
  }
  const viewer = await (await fetch(`${cloud.url}/p/${id}`)).text();
  expect(viewer).not.toContain('brand new');
  patchLink = link;

  const palette = async (): Promise<void> => {
    await pageA.getByRole('grid', { name: 'Commit graph' }).click();
    await pageA.keyboard.press('ControlOrMeta+p');
    await expect(pageA.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await pageA.keyboard.type('Open Cloud Patch link');
    await pageA.keyboard.press('Enter');
  };
  const prompt = pageA.getByRole('dialog', { name: 'Open Cloud Patch link' });

  // the full link: both open repos match the patch → pick bravo
  await palette();
  await prompt.getByRole('textbox', { name: 'Link' }).fill(link);
  await prompt.getByRole('button', { name: 'Open', exact: true }).click();
  const which = pageA.getByRole('dialog', { name: 'Apply Cloud Patch to which repository?' });
  await expect(which).toBeVisible({ timeout: 15_000 });
  await which.getByRole('button', { name: /^bravo/ }).click();

  await expect(
    pageA.getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name: /bravo/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(pageA.getByRole('heading', { name: 'Edited readme and a new file' })).toBeVisible({
    timeout: 15_000,
  });
  const patchFiles = pageA.getByRole('navigation', { name: 'Files in this patch' });
  await expect(patchFiles.getByText('README.md')).toBeVisible();
  await expect(patchFiles.getByText('new-file.txt')).toBeVisible();
  await expect(pageA.getByText('available locally')).toBeVisible({ timeout: 15_000 });
  await pageA.screenshot({ path: path.join(shots, 'phase6-patch-view.png') });

  await pageA.getByRole('button', { name: 'Apply to working tree' }).click();
  await expect(toast(pageA, 'Applied Cloud Patch to the working tree')).toBeVisible({ timeout: 20_000 });
  expect(fs.readFileSync(path.join(bravo, 'README.md'), 'utf8')).toBe(
    '# Alpha (edited)\n\nShared project.\n',
  );
  expect(fs.readFileSync(path.join(bravo, 'new-file.txt'), 'utf8')).toBe('brand new\n');
  // (the 3-way apply goes through the index, so the changes arrive staged)
  expect(gitB('status', '--porcelain', '--untracked-files=all').split('\n').sort()).toEqual([
    'A  new-file.txt',
    'M  README.md',
  ]);

  // one Undo reverts the apply
  // Undo is always enabled (reflog fallback); wait until it names the patch apply.
  const undo = pageA.getByTitle(/^Undo .*patch/i);
  await expect(undo).toBeVisible({ timeout: 15_000 });
  await undo.click();
  const confirmUndo = pageA.getByRole('dialog').getByRole('button', { name: /^Undo/ });
  await expect(async () => {
    if (await confirmUndo.isVisible()) await confirmUndo.click();
    expect(gitB('status', '--porcelain')).toBe('');
  }).toPass({ timeout: 20_000 });
  expect(fs.existsSync(path.join(bravo, 'new-file.txt'))).toBe(false);
});

// ---- 6. Team footprints ------------------------------------------------------------------------------

test('team footprints: a teammate editing the same lines shows as an overlap', async () => {
  test.setTimeout(120_000);
  // Bob joins Ana's org over the HTTP API and uploads a footprint for README.md lines 1–3 on his branch.
  // (The desktop uploads after a 2-minute debounce; the shaping is replicated here instead.)
  const anaToken = await accessToken(cloud.url, ANA.email, ANA.name);
  const me = await api<{ orgs: Array<{ id: string; name: string }> }>(cloud.url, anaToken, 'GET', '/v1/me');
  const orgId = me.data.orgs.find((o) => o.name === ORG)!.id;
  await api(cloud.url, anaToken, 'PATCH', `/v1/orgs/${orgId}/policies`, { footprintShareBranchNames: true });
  const invite = await api<{ acceptUrl: string }>(cloud.url, anaToken, 'POST', `/v1/orgs/${orgId}/invites`, {
    email: BOB.email,
    role: 'member',
  });
  const bobToken = await accessToken(cloud.url, BOB.email, BOB.name);
  const inviteToken = invite.data.acceptUrl.split('/').pop()!;
  await api(cloud.url, bobToken, 'POST', `/v1/invites/${encodeURIComponent(inviteToken)}/accept`);
  const org = await api<{ footprintSalt: string }>(cloud.url, bobToken, 'GET', `/v1/orgs/${orgId}`);
  const gitA = gitIn(alpha);
  const root = gitA('rev-list', '--max-parents=0', 'HEAD');
  const repo = { ...REPO_ID, initialCommitSha: root };
  const salt = org.data.footprintSalt;
  await api(cloud.url, bobToken, 'PUT', `/v1/orgs/${orgId}/footprints`, {
    repo,
    branchHash: footprintHash(salt, repo, 'bob/readme'),
    branchLabel: 'bob/readme',
    baseRef: 'origin/main',
    headSha: gitA('rev-parse', 'HEAD'),
    files: [{ pathHash: footprintHash(salt, repo, 'README.md'), ranges: [[1, 3]] }],
  });

  // Ana opts in from the TEAM section, then starts a branch that keeps her README edit (line 1)
  await pageA.getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name: /alpha/ }).click();
  const nav = pageA.getByRole('navigation', { name: 'Repository references' });
  const team = nav.getByRole('tree', { name: 'Team' });
  await team.scrollIntoViewIfNeeded();
  await team.getByRole('button', { name: 'Share work footprints' }).click();
  await expect(team.getByRole('button', { name: 'Share work footprints' })).toHaveCount(0, {
    timeout: 15_000,
  });
  gitA('checkout', '-q', '-b', 'ana/readme');

  const indicator = pageA.getByRole('button', { name: /^Conflict prevention:/ });
  await expect(indicator).toHaveAttribute('aria-label', /1 teammate overlap/, { timeout: 30_000 });
  await expect(indicator).toHaveAttribute('aria-label', /No conflicts with origin\/main/);
  await indicator.click();
  const popover = pageA.getByRole('dialog', { name: 'Conflict prevention' });
  const mates = popover.getByRole('region', { name: 'Teammates' });
  await expect(mates.getByText(BOB.name).first()).toBeVisible();
  await expect(mates.getByText('README.md').first()).toBeVisible();
  await pageA.screenshot({ path: path.join(shots, 'phase6-team-overlap.png') });
  await pageA.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // TEAM section lists Bob's branch
  await expect(async () => {
    await nav.getByRole('button', { name: 'Refresh team' }).click();
    await expect(team.getByRole('group', { name: BOB.name }).getByText('bob/readme')).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await pageA.screenshot({ path: path.join(shots, 'phase6-team.png') });
});

// ---- 7. Conflict prevention (no backend) -------------------------------------------------------------

test('machine without cloud: conflict prevention vs origin/main; a key-less patch link fails', async () => {
  test.setTimeout(120_000);
  const appC = await launch(path.join(tmp, 'userData-C'), [charlie]);
  try {
    const page = await appC.firstWindow();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('account-sign-in')).toBeVisible();

    const indicator = page.getByRole('button', { name: /^Conflict prevention:/ });
    await expect(indicator).toHaveAttribute(
      'aria-label',
      'Conflict prevention: feature conflicts with origin/main in 1 file',
      { timeout: 30_000 },
    );
    await expect(indicator).toHaveText('1');
    await indicator.click();
    const popover = page.getByRole('dialog', { name: 'Conflict prevention' });
    const target = popover.getByRole('region', { name: 'Target branch' });
    await expect(target).toContainText('feature conflicts with origin/main in 1 file');
    await expect(target.getByText('conflict.txt', { exact: true })).toBeVisible();
    await expect(popover.getByRole('region', { name: 'Teammates' })).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, 'phase6-conflicts.png') });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // a branch that does not conflict → grey indicator, no badge
    gitIn(charlie)('checkout', '-q', 'harmless');
    await expect(indicator).toHaveAttribute(
      'aria-label',
      'Conflict prevention: No conflicts with origin/main',
      {
        timeout: 30_000,
      },
    );
    await expect(indicator).toHaveText('');
    await indicator.click();
    await expect(popover.getByRole('region', { name: 'Target branch' })).toContainText(
      'No conflicts between harmless and origin/main',
    );
    await page.screenshot({ path: path.join(shots, 'phase6-no-conflicts.png') });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // A recipient without the key (this machine has no account): the link minus #k= can't be decrypted.
    // (Machine A keeps the keys of patches it created, so it is not a valid "recipient" for this check.)
    expect(patchLink).not.toBe('');
    await page.getByRole('grid', { name: 'Commit graph' }).click();
    await page.keyboard.press('ControlOrMeta+p');
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await page.keyboard.type('Open Cloud Patch link');
    await page.keyboard.press('Enter');
    const prompt = page.getByRole('dialog', { name: 'Open Cloud Patch link' });
    await prompt.getByRole('textbox', { name: 'Link' }).fill(patchLink.replace(/#.*$/, ''));
    await prompt.getByRole('button', { name: 'Open', exact: true }).click();
    const other = page.getByRole('dialog', { name: 'Open link from another server?' });
    await expect(other).toBeVisible({ timeout: 15_000 });
    await other.getByRole('button', { name: 'Open anyway' }).click();
    await expect(toast(page, 'This Cloud Patch is encrypted')).toBeVisible({ timeout: 15_000 });
    await expect(toast(page, /missing its key/)).toBeVisible();
  } finally {
    await appC.close();
  }
});
