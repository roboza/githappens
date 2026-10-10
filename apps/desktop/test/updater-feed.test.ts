import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { NsisUpdater, type AppUpdater } from 'electron-updater';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  applyUpdateFeedOverride,
  CHECK_INTERVAL_MS,
  RELEASES_URL,
  updateFeedOverride,
  UpdaterService,
  type AutoUpdaterLike,
  type UpdaterServiceOptions,
} from '../src/main/services/updater';
import type { UpdateChannel, UpdateStatus } from '../src/shared/ipc/update-contract';

/**
 * Integration test of the update pipeline (spec 15 §6.5) with the *real* electron-updater: an
 * `NsisUpdater` + `GenericProvider` talk HTTP to a local feed laid out like the R2 bucket
 * (docs/releases.md): `releases/latest.yml` / `releases/preview.yml` listing x64 + arm64 dummy
 * installers with matching sha512/size. Only Electron's `net` is swapped for Node's http (the test runs
 * outside Electron) and the app adapter is a plain object. Nothing is ever installed.
 */

// builder-util-runtime is electron-updater's own dependency (not hoisted under pnpm).
const runtime = createRequire(createRequire(import.meta.url).resolve('electron-updater'))(
  'builder-util-runtime',
) as {
  HttpExecutor: new () => object;
  configureRequestUrl(url: URL, options: object): void;
  configureRequestOptions(options: object): void;
};

interface DownloadOptions {
  headers?: Record<string, string>;
  cancellationToken: {
    createPromise<T>(
      cb: (resolve: (v: T) => void, reject: (e: Error) => void, onCancel: (fn: () => void) => void) => void,
    ): Promise<T>;
  };
}

/** Node-http twin of electron-updater's ElectronHttpExecutor (same `download` shape). */
const HttpExecutorBase = runtime.HttpExecutor as unknown as new () => {
  doDownload(requestOptions: object, options: object, redirectCount: number): void;
};
class NodeHttpExecutor extends HttpExecutorBase {
  createRequest(
    options: http.RequestOptions & { protocol?: string },
    callback: (r: http.IncomingMessage) => void,
  ): http.ClientRequest {
    // No keep-alive agent: each request gets its own socket (as Electron's net does per request).
    return (options.protocol === 'https:' ? https : http).request({ ...options, agent: false }, callback);
  }

  download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined };
      runtime.configureRequestUrl(url, requestOptions);
      runtime.configureRequestOptions(requestOptions);
      this.doDownload(
        requestOptions,
        {
          destination,
          options,
          onCancel,
          callback: (error: Error | null) => (error == null ? resolve(destination) : reject(error)),
          responseHandler: null,
        },
        0,
      );
    });
  }
}

// ---- local generic feed ------------------------------------------------------------------------------

const STABLE = '0.2.0';
const PREVIEW = '0.3.0-preview.1';
/** 1 MiB served in slow chunks so electron-updater reports progress (it throttles to 1/s). */
const ARTIFACT = crypto.randomBytes(1024 * 1024);
const sha512 = (b: Buffer): string => crypto.createHash('sha512').update(b).digest('base64');

/** Feed directory on the download host (electron-builder.yml `publish.url` = <host>/releases). */
const FEED_DIR = '/releases/';
/** The installer electron-updater must pick on this machine (it matches `process.arch` in the url). */
const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const OTHER_ARCH = HOST_ARCH === 'x64' ? 'arm64' : 'x64';
const artifactName = (v: string, arch: string = HOST_ARCH): string => `GitHappens-Setup-${v}-${arch}.exe`;
/** A merged Windows manifest (release.yml): x64 first (legacy `path`), then arm64; the client picks by arch. */
const manifest = (version: string, body = ARTIFACT): string =>
  [
    `version: ${version}`,
    'files:',
    ...['x64', 'arm64'].flatMap((arch) => [
      `  - url: ${artifactName(version, arch)}`,
      `    sha512: ${sha512(body)}`,
      `    size: ${body.length}`,
    ]),
    `path: ${artifactName(version, 'x64')}`,
    `sha512: ${sha512(body)}`,
    `releaseDate: '2026-10-10T00:00:00.000Z'`,
    '',
  ].join('\n');

interface Feed {
  url: string;
  requests: string[];
  /** Override the next responses: `500` for the channel file, or a corrupt artifact. */
  mode: 'ok' | 'server-error' | 'corrupt';
  slow: boolean;
  close(): Promise<void>;
}

async function startFeed(): Promise<Feed> {
  const feed = { requests: [] as string[], mode: 'ok', slow: true } as Feed;
  const server = http.createServer((req, res) => {
    const full = new URL(req.url ?? '/', 'http://x').pathname;
    if (!full.startsWith(FEED_DIR)) {
      res.writeHead(404).end();
      return;
    }
    const pathname = `/${full.slice(FEED_DIR.length)}`;
    feed.requests.push(pathname);
    const ymlMatch = /^\/(latest|preview)(-mac|-linux(?:-arm64)?)?\.yml$/.exec(pathname);
    if (ymlMatch) {
      if (feed.mode === 'server-error') {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('feed exploded\n<html>details</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(manifest(ymlMatch[1] === 'preview' ? PREVIEW : STABLE));
      return;
    }
    const artifacts = [STABLE, PREVIEW].flatMap((v) => ['x64', 'arm64'].map((a) => `/${artifactName(v, a)}`));
    if (artifacts.includes(pathname)) {
      const body = feed.mode === 'corrupt' ? Buffer.alloc(ARTIFACT.length, 7) : ARTIFACT;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      if (!feed.slow) {
        res.end(body);
        return;
      }
      // 4 chunks over ~1.6 s → at least one throttled `download-progress` event.
      let i = 0;
      const chunk = body.length / 4;
      const timer = setInterval(() => {
        res.write(body.subarray(i * chunk, (i + 1) * chunk));
        if (++i === 4) {
          clearInterval(timer);
          res.end();
        }
      }, 400);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  feed.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${FEED_DIR}`;
  feed.close = () => new Promise((resolve) => server.close(() => resolve()));
  return feed;
}

// ---- real electron-updater, Node-hosted ------------------------------------------------------------------

let feed: Feed;
let tmp: string;
const services: UpdaterService[] = [];

beforeAll(async () => {
  feed = await startFeed();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-update-feed-'));
});

afterAll(async () => {
  await feed.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  feed.mode = 'ok';
  feed.slow = true;
  feed.requests.length = 0;
});

function realUpdater(name: string): {
  updater: NsisUpdater;
  cacheDir: string;
  quitAndInstall: ReturnType<typeof vi.fn>;
} {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  // Same file the app writes for the GH_UPDATE_FEED_URL override (generic provider, no publisherName).
  const override = updateFeedOverride({ GH_UPDATE_FEED_URL: feed.url }, false, dir);
  if (!override) throw new Error('override rejected');
  const updater = new NsisUpdater(undefined, {
    version: '0.1.0',
    name: 'GitHappens',
    isPackaged: false,
    appUpdateConfigPath: override.configPath,
    userDataPath: path.join(dir, 'userData'),
    baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  });
  applyUpdateFeedOverride(updater, override);
  const internals = updater as unknown as {
    httpExecutor: unknown;
    _testOnlyOptions: { platform: NodeJS.Platform; isUseDifferentialDownload: boolean };
  };
  internals.httpExecutor = new NodeHttpExecutor();
  // Manifest names are platform-specific (latest.yml vs latest-linux.yml): pin Windows semantics.
  internals._testOnlyOptions = { platform: 'win32', isUseDifferentialDownload: false };
  updater.logger = null;
  // Belt and braces: installing is never part of this test.
  const quitAndInstall = vi.fn();
  updater.quitAndInstall = quitAndInstall;
  return { updater, cacheDir: path.join(dir, 'cache', 'githappens-updater-test'), quitAndInstall };
}

function service(
  updater: AppUpdater,
  over: Partial<UpdaterServiceOptions> & { channel?: UpdateChannel; autoDownload?: boolean } = {},
) {
  const statuses: UpdateStatus[] = [];
  const settings = { channel: over.channel ?? 'stable', autoDownload: over.autoDownload ?? true };
  const svc = new UpdaterService({
    updater: updater as AutoUpdaterLike,
    currentVersion: '0.1.0',
    isPackaged: true,
    platform: 'win32',
    env: {},
    installOnQuit: false,
    getChannel: () => settings.channel,
    getAutoDownload: () => settings.autoDownload,
    onStatus: (s) => statuses.push(s),
    log: () => undefined,
    ...over,
  });
  services.push(svc);
  return { svc, statuses, settings };
}

const states = (statuses: UpdateStatus[]): string[] =>
  statuses.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]);

describe('update feed (real electron-updater + local generic feed)', () => {
  it('checking → available → downloading → ready, verifying sha512, without installing', async () => {
    const { updater, cacheDir, quitAndInstall } = realUpdater('manual-download');
    const { svc, statuses } = service(updater, { autoDownload: false });

    const afterCheck = await svc.check();
    expect(afterCheck).toMatchObject({ state: 'available', version: STABLE, channel: 'stable' });
    expect(feed.requests).toContain('/latest.yml');
    expect(feed.requests.some((r) => r.endsWith('.exe'))).toBe(false);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    await svc.installAndRestart(); // `available` → start the download
    await vi.waitFor(() => expect(svc.current.state).toBe('ready'), { timeout: 15_000 });

    expect(states(statuses)).toEqual(['checking', 'available', 'downloading', 'ready']);
    const progress = statuses.filter((s) => s.state === 'downloading').map((s) => s.progress ?? 0);
    expect(progress.some((p) => p > 0 && p < 1)).toBe(true);
    expect(svc.current).toMatchObject({ state: 'ready', version: STABLE, progress: 1 });
    // This machine's installer was picked from the merged x64 + arm64 manifest.
    expect(feed.requests).toContain(`/${artifactName(STABLE)}`);
    expect(feed.requests).not.toContain(`/${artifactName(STABLE, OTHER_ARCH)}`);
    const downloaded = path.join(cacheDir, 'pending', artifactName(STABLE));
    expect(fs.readFileSync(downloaded).equals(ARTIFACT)).toBe(true);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('auto-downloads in the background when enabled', async () => {
    feed.slow = false;
    const { updater, quitAndInstall } = realUpdater('auto-download');
    const { svc, statuses } = service(updater);
    await svc.check();
    await vi.waitFor(() => expect(svc.current.state).toBe('ready'), { timeout: 15_000 });
    expect(states(statuses)).toEqual(['checking', 'downloading', 'ready']);
    expect(updater.autoDownload).toBe(true);
    // A further check while `ready` is a no-op (no re-download, no feed hit).
    const before = feed.requests.length;
    expect((await svc.check()).state).toBe('ready');
    expect(feed.requests.length).toBe(before);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('switching to Preview reads preview.yml and offers the prerelease', async () => {
    feed.slow = false;
    const { updater } = realUpdater('channels');
    const { svc, settings } = service(updater, { autoDownload: false });
    expect((await svc.check()).version).toBe(STABLE);
    expect(feed.requests.filter((r) => r.endsWith('.yml'))).toEqual(['/latest.yml']);

    settings.channel = 'preview';
    svc.refreshSettings(); // a channel switch triggers a check by itself
    await vi.waitFor(() => expect(svc.current.version).toBe(PREVIEW));
    expect(feed.requests.filter((r) => r.endsWith('.yml'))).toEqual(['/latest.yml', '/preview.yml']);
    expect(svc.current).toMatchObject({ state: 'available', channel: 'preview' });
    // preview*.yml and its installers live in the same releases/ directory as the stable feed.
    expect(feed.requests.some((r) => r.endsWith('.exe'))).toBe(false);
    expect(updater.channel).toBe('preview');
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);

    // Back to Stable: latest.yml again, and 0.2.0 is not offered as a "downgrade" from the preview.
    settings.channel = 'stable';
    svc.refreshSettings();
    await vi.waitFor(() => expect(svc.current.channel).toBe('stable'));
    await vi.waitFor(() =>
      expect(feed.requests.filter((r) => r.endsWith('.yml')).at(-1)).toBe('/latest.yml'),
    );
    expect(updater.allowPrerelease).toBe(false);
  });

  it('a feed failure becomes an error status (first line only) and recovers on the next check', async () => {
    feed.mode = 'server-error';
    const { updater } = realUpdater('error');
    const { svc } = service(updater);
    const st = await svc.check();
    expect(st.state).toBe('error');
    expect(st.error).toMatch(/500/);
    expect(st.error).not.toContain('\n');

    feed.mode = 'ok';
    feed.slow = false;
    await svc.check();
    await vi.waitFor(() => expect(svc.current.state).toBe('ready'), { timeout: 15_000 });
    expect(svc.current.error).toBeUndefined();
  });

  it('a corrupted download (sha512 mismatch) is rejected as an error, never "ready"', async () => {
    feed.mode = 'corrupt';
    feed.slow = false;
    const { updater, cacheDir } = realUpdater('corrupt');
    const { svc, statuses } = service(updater);
    await svc.check();
    await vi.waitFor(() => expect(svc.current.state).toBe('error'), { timeout: 15_000 });
    expect(svc.current.error).toMatch(/sha512 checksum mismatch/);
    expect(statuses.some((s) => s.state === 'ready')).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, 'pending', artifactName(STABLE)))).toBe(false);
  });

  it('Linux deb/rpm: links the website download page and never downloads', async () => {
    feed.slow = false;
    const { updater } = realUpdater('deb');
    const { svc, statuses } = service(updater, { platform: 'linux', env: {} });
    expect(RELEASES_URL).toBe('https://githappens.dev/#download');
    expect(svc.current).toMatchObject({ state: 'manual', downloadUrl: RELEASES_URL });
    await svc.check();
    expect(svc.current).toMatchObject({ state: 'manual', version: STABLE, downloadUrl: RELEASES_URL });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(statuses.every((s) => s.state === 'manual')).toBe(true);
    // Give a would-be background download a moment, then make sure none happened.
    await new Promise((r) => setTimeout(r, 300));
    expect(feed.requests.some((r) => r.endsWith('.exe'))).toBe(false);
    // Installing is a no-op in manual mode.
    await svc.installAndRestart();
    expect(svc.current.state).toBe('manual');
  });
});

describe('update schedule (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks shortly after startup and then every 4 hours', async () => {
    vi.useFakeTimers();
    const checkForUpdates = vi.fn(async () => null);
    const updater = {
      channel: null,
      allowPrerelease: false,
      allowDowngrade: false,
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: () => updater,
      checkForUpdates,
      downloadUpdate: async () => null,
      quitAndInstall: () => undefined,
    } satisfies AutoUpdaterLike;
    const svc = new UpdaterService({
      updater,
      currentVersion: '0.1.0',
      isPackaged: true,
      platform: 'win32',
      env: {},
      getChannel: () => 'stable',
      getAutoDownload: () => true,
      log: () => undefined,
    });
    services.push(svc);
    expect(CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
    svc.start();
    svc.start(); // idempotent
    await vi.advanceTimersByTimeAsync(9_999);
    expect(checkForUpdates).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 10_001);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * CHECK_INTERVAL_MS);
    expect(checkForUpdates).toHaveBeenCalledTimes(4);
    svc.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(checkForUpdates).toHaveBeenCalledTimes(4);
  });

  it('never schedules anything in unpackaged builds without the override', async () => {
    vi.useFakeTimers();
    const checkForUpdates = vi.fn(async () => null);
    const svc = new UpdaterService({
      updater: {
        channel: null,
        allowPrerelease: false,
        allowDowngrade: false,
        autoDownload: true,
        autoInstallOnAppQuit: true,
        on: () => undefined,
        checkForUpdates,
        downloadUpdate: async () => null,
        quitAndInstall: () => undefined,
      },
      currentVersion: '0.1.0',
      isPackaged: false,
      getChannel: () => 'stable',
      getAutoDownload: () => true,
    });
    svc.start();
    await vi.advanceTimersByTimeAsync(2 * CHECK_INTERVAL_MS);
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(svc.current.state).toBe('disabled');
  });
});

describe('updateFeedOverride (dev/test-only, env only)', () => {
  const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-feed-override-'));

  it('is off unless GH_UPDATE_FEED_URL is set', () => {
    expect(updateFeedOverride({}, false, dir())).toBeNull();
    expect(updateFeedOverride({ GH_UPDATE_FEED_URL: '  ' }, false, dir())).toBeNull();
  });

  it('writes a generic-provider dev-app-update.yml for unpackaged builds', () => {
    const d = dir();
    const o = updateFeedOverride({ GH_UPDATE_FEED_URL: 'http://127.0.0.1:4567/feed' }, false, d);
    expect(o).toEqual({ url: 'http://127.0.0.1:4567/feed/', configPath: path.join(d, 'dev-app-update.yml') });
    const yml = fs.readFileSync(o!.configPath, 'utf8');
    expect(JSON.parse(yml)).toEqual({
      provider: 'generic',
      url: 'http://127.0.0.1:4567/feed/',
      updaterCacheDirName: 'githappens-updater-test',
    });
  });

  it('is ignored in packaged builds unless explicitly allowed', () => {
    const env = { GH_UPDATE_FEED_URL: 'https://updates.example.test/' };
    expect(updateFeedOverride(env, true, dir())).toBeNull();
    expect(updateFeedOverride({ ...env, GH_ALLOW_UPDATE_FEED_OVERRIDE: 'true' }, true, dir())).toBeNull();
    expect(updateFeedOverride({ ...env, GH_ALLOW_UPDATE_FEED_OVERRIDE: '1' }, true, dir())?.url).toBe(
      'https://updates.example.test/',
    );
  });

  it('optionally delays the automatic startup check (tests drive checks themselves)', () => {
    const url = 'http://127.0.0.1:1/';
    expect(updateFeedOverride({ GH_UPDATE_FEED_URL: url }, false, dir())?.startupDelayMs).toBeUndefined();
    expect(
      updateFeedOverride({ GH_UPDATE_FEED_URL: url, GH_UPDATE_CHECK_DELAY_MS: '600000' }, false, dir())
        ?.startupDelayMs,
    ).toBe(600_000);
    expect(
      updateFeedOverride({ GH_UPDATE_FEED_URL: url, GH_UPDATE_CHECK_DELAY_MS: 'soon' }, false, dir())
        ?.startupDelayMs,
    ).toBeUndefined();
  });

  it('accepts plain http for loopback only', () => {
    expect(updateFeedOverride({ GH_UPDATE_FEED_URL: 'http://evil.example/' }, false, dir())).toBeNull();
    expect(updateFeedOverride({ GH_UPDATE_FEED_URL: 'file:///etc/' }, false, dir())).toBeNull();
    expect(updateFeedOverride({ GH_UPDATE_FEED_URL: 'not a url' }, false, dir())).toBeNull();
    expect(updateFeedOverride({ GH_UPDATE_FEED_URL: 'http://localhost:1/' }, false, dir())).not.toBeNull();
  });

  it('forces electron-updater to use the dev config', () => {
    const u = { forceDevUpdateConfig: false, updateConfigPath: null as string | null };
    applyUpdateFeedOverride(u, { url: 'http://127.0.0.1/', configPath: '/tmp/x.yml' });
    expect(u).toEqual({ forceDevUpdateConfig: true, updateConfigPath: '/tmp/x.yml' });
  });
});
