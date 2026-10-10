import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Auto-update UI end to end (spec 15 §4, §6.5) against a local generic feed: the dev build runs the real
 * electron-updater via the env-only GH_UPDATE_FEED_URL override (updater.ts `updateFeedOverride`), which
 * also turns off install-on-quit so the dummy artifact is never executed. "Restart now" is never clicked.
 *
 *  - every OS: "What's new" opens once after an update (lastSeenVersion older than the running version);
 *  - Windows: Stable offers 0.2.0 (latest.yml); switching to Preview offers 0.3.0-preview.1 (preview.yml);
 *    Download → progress → "Version … is ready" with Restart now / Later; "Later" hides the card but the
 *    dot on the Preferences button stays until restart;
 *  - Linux (dev = not an AppImage → deb/rpm behaviour): the offer links to the download page instead and
 *    nothing is downloaded;
 *  - macOS: Squirrel.Mac needs a signed bundle, so only the What's-new part runs there.
 */

test.describe.configure({ mode: 'serial' });

const appDir = path.resolve(__dirname, '..');
const version = (
  JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) as { version: string }
).version;
const STABLE = '99.0.0';
const PREVIEW = '99.1.0-preview.1';
const ARTIFACT = crypto.randomBytes(512 * 1024);
const sha512 = crypto.createHash('sha512').update(ARTIFACT).digest('base64');
const artifact = (v: string): string => `GitHappens-Setup-${v}-${process.arch}.exe`;
const manifest = (v: string): string =>
  [
    `version: ${v}`,
    'files:',
    `  - url: ${artifact(v)}`,
    `    sha512: ${sha512}`,
    `    size: ${ARTIFACT.length}`,
    `path: ${artifact(v)}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-10T00:00:00.000Z'",
    '',
  ].join('\n');

const feedMode = process.platform === 'win32' ? 'auto' : process.platform === 'linux' ? 'manual' : 'none';
const requests: string[] = [];
let server: http.Server;
let tmp: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    requests.push(p);
    const yml = /^\/(latest|preview)(-mac|-linux(?:-arm64)?)?\.yml$/.exec(p);
    if (yml) {
      res
        .writeHead(200, { 'content-type': 'text/yaml' })
        .end(manifest(yml[1] === 'preview' ? PREVIEW : STABLE));
      return;
    }
    if (p === `/${artifact(STABLE)}` || p === `/${artifact(PREVIEW)}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': ARTIFACT.length });
      // Two halves 1.2 s apart so the progress state is observable.
      res.write(ARTIFACT.subarray(0, ARTIFACT.length / 2));
      setTimeout(() => res.end(ARTIFACT.subarray(ARTIFACT.length / 2)), 1200);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-update-e2e-')));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  // As if the previous launch ran an older version → "What's new" for this one.
  fs.writeFileSync(path.join(userData, 'update-state.json'), JSON.stringify({ lastSeenVersion: '0.0.1' }));

  app = await electron.launch({
    args: [appDir, ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [])],
    cwd: appDir,
    env: {
      ...process.env,
      GITHAPPENS_USER_DATA_DIR: userData,
      ELECTRON_RENDERER_URL: '',
      GH_UPDATE_FEED_URL: feedUrl,
      // The test drives every check itself.
      GH_UPDATE_CHECK_DELAY_MS: '3600000',
    },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  // electron-updater keeps downloads in <app cache dir>/<updaterCacheDirName> (getAppCacheDir()); the
  // override uses a test-only name, so this only removes the dummy download.
  const cacheRoot =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches')
        : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'));
  fs.rmSync(path.join(cacheRoot, 'githappens-updater-test'), { recursive: true, force: true });
});

const notifier = () => page.getByTestId('update-notifier');
const prefs = () => page.getByRole('dialog', { name: 'Preferences' });
const ymlRequests = (): string[] => requests.filter((r) => r.endsWith('.yml'));

test("shows What's new once after an update", async () => {
  const dialog = page.getByRole('dialog', { name: `What's new in GitHappens ${version}` });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).not.toBeEmpty();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'update-state.json'), 'utf8')) as {
    lastSeenVersion: string;
  };
  expect(state.lastSeenVersion).toBe(version);
});

test('Stable channel: Check now offers the latest.yml version', async () => {
  test.skip(feedMode === 'none', 'macOS updates need a signed app bundle (Squirrel.Mac)');
  await page.getByRole('button', { name: 'Preferences' }).click();
  await prefs()
    .getByRole('navigation', { name: 'Preference sections' })
    .getByRole('button', { name: 'General', exact: true })
    .click();
  const panel = prefs().getByTestId('updates-prefs');
  await expect(panel).toContainText(`Current version ${version}.`);
  const auto = panel.getByRole('switch', { name: 'Automatically download updates' });
  if (feedMode === 'auto') {
    await auto.uncheck();
    await expect(auto).not.toBeChecked();
  } else {
    await expect(auto).toBeDisabled(); // deb/rpm can't update in place
  }
  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(notifier()).toContainText(`Version ${STABLE} is available`, { timeout: 20_000 });
  await expect(panel).toContainText(`Version ${STABLE} is available`);
  expect(ymlRequests()).toEqual([process.platform === 'linux' ? latestLinux() : '/latest.yml']);
  if (feedMode === 'manual') {
    await expect(panel.getByRole('button', { name: 'Open downloads' })).toBeVisible();
    await expect(panel).toContainText("can't update itself");
  }
});

test('switching to Preview checks preview.yml and offers the prerelease', async () => {
  test.skip(feedMode === 'none', 'macOS updates need a signed app bundle (Squirrel.Mac)');
  const panel = prefs().getByTestId('updates-prefs');
  await panel.getByLabel('Update channel').selectOption('preview');
  await expect(notifier()).toContainText(`Version ${PREVIEW} is available`, { timeout: 20_000 });
  expect(ymlRequests().at(-1)).toBe(process.platform === 'linux' ? latestLinux('preview') : '/preview.yml');
});

test('Download → ready toast with Restart now / Later and a persistent dot', async () => {
  test.skip(feedMode !== 'auto', 'in-place updates only (Windows here)');
  await prefs().getByRole('button', { name: 'Close preferences' }).click();
  await expect(page.getByTestId('update-dot')).toHaveCount(0);
  await notifier().getByRole('button', { name: 'Download' }).click();
  await expect(notifier()).toContainText(`Downloading version ${PREVIEW.toLowerCase()}`, { timeout: 10_000 });
  await expect(notifier().getByRole('progressbar')).toBeVisible();
  await expect(notifier()).toContainText(`Version ${PREVIEW} is ready`, { timeout: 30_000 });
  await expect(notifier()).toContainText('Restart GitHappens to finish updating.');
  await expect(notifier().getByRole('button', { name: 'Restart now' })).toBeEnabled();
  expect(requests).toContain(`/${artifact(PREVIEW)}`);
  const dot = page.getByRole('button', { name: 'Preferences' }).getByTestId('update-dot');
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute('title', `Version ${PREVIEW} is ready — restart to update`);

  await notifier().getByRole('button', { name: 'Later' }).click();
  await expect(notifier()).toBeHidden();
  await expect(dot).toBeVisible(); // until restart
  // The app is still running: "Restart now" was never pressed and install-on-quit is off.
  expect(await app.evaluate(({ app: a }) => a.getVersion())).toBe(version);
});

test('deb/rpm: nothing is downloaded and the card offers a download link', async () => {
  test.skip(feedMode !== 'manual', 'Linux non-AppImage only');
  await prefs().getByRole('button', { name: 'Close preferences' }).click();
  await expect(notifier().getByRole('button', { name: 'Download' })).toBeVisible();
  expect(requests.some((r) => r.endsWith('.exe') || r.endsWith('.AppImage'))).toBe(false);
  await notifier().getByRole('button', { name: 'Later' }).click();
  await expect(notifier()).toBeHidden();
  await expect(page.getByTestId('update-dot')).toHaveCount(0);
});

/** electron-updater's Linux manifest name for this arch. */
function latestLinux(channel = 'latest'): string {
  return `/${channel}-linux${process.arch === 'x64' ? '' : `-${process.arch}`}.yml`;
}
