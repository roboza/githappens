import fs from 'node:fs';
import path from 'node:path';

import type { AppUpdater } from 'electron-updater';

import type { UpdateChannel, UpdateStatus, WhatsNew } from '../../shared/ipc/update-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';

/** GitHub repository that hosts releases (electron-builder.yml `publish`: provider github). */
export const RELEASES_REPO = { owner: 'roboza', repo: 'githappens' } as const;
/**
 * The newest stable GitHub release, which lists every installer (docs/releases.md). Used for the deb/rpm
 * "download the new version" link. The update feed itself is the github provider in electron-builder.yml
 * `publish`, baked into the app as app-update.yml.
 */
export const RELEASES_URL = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/latest`;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** The subset of electron-updater's `AppUpdater` we use — a fake implements it in tests. */
export interface AutoUpdaterLike {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Compile-time proof that the real updater satisfies `AutoUpdaterLike`. */
export const asAutoUpdaterLike = (u: AppUpdater): AutoUpdaterLike => u;

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const nodeTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface UpdaterServiceOptions {
  /** electron-updater's `autoUpdater` (or a fake). Not touched at all when updates are disabled. */
  updater: AutoUpdaterLike;
  currentVersion: string;
  /** `app.isPackaged` — unpackaged/dev builds never update. */
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  getChannel(): UpdateChannel;
  getAutoDownload(): boolean;
  /** Broadcast hook for `update:status`. */
  onStatus?(status: UpdateStatus): void;
  /** Bundled CHANGELOG.md (see `defaultChangelogPath`). */
  changelogPath?: string;
  /** Small JSON file remembering the last version whose notes were shown. */
  stateFile?: string;
  startupDelayMs?: number;
  intervalMs?: number;
  timers?: TimerApi;
  /**
   * Install a downloaded update when the app quits (electron-updater `autoInstallOnAppQuit`). Default
   * true; the test feed override turns it off so a dummy artifact is never executed.
   */
  installOnQuit?: boolean;
  log?(message: string, error?: unknown): void;
}

/** Where CHANGELOG.md lives: `resources/` when packaged (extraResources), the app dir in dev. */
export function defaultChangelogPath(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'CHANGELOG.md') : path.join(appPath, 'CHANGELOG.md');
}

/** Env vars of the dev/test-only update feed override (see `updateFeedOverride`). */
export const FEED_URL_ENV = 'GH_UPDATE_FEED_URL';
export const FEED_OVERRIDE_IN_PACKAGED_ENV = 'GH_ALLOW_UPDATE_FEED_OVERRIDE';
/** Optional: delay of the automatic startup check while the override is active (default: normal). */
export const FEED_CHECK_DELAY_ENV = 'GH_UPDATE_CHECK_DELAY_MS';

export interface UpdateFeedOverride {
  url: string;
  /** Generated `dev-app-update.yml` (generic provider) for electron-updater's `updateConfigPath`. */
  configPath: string;
  /** From GH_UPDATE_CHECK_DELAY_MS, for tests that drive checks themselves. */
  startupDelayMs?: number;
}

/**
 * Dev/test-only override of the update feed (e2e against a local generic feed). Read from the main
 * process environment only — there is no IPC or setting for it, so the renderer cannot redirect
 * updates. Ignored in packaged builds unless `GH_ALLOW_UPDATE_FEED_OVERRIDE=1` is also set (a packaged
 * smoke test may opt in; end users never have either variable). Plain http is accepted for loopback
 * hosts only. Returns null when not active or invalid.
 */
export function updateFeedOverride(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
  configDir: string,
): UpdateFeedOverride | null {
  const raw = env[FEED_URL_ENV]?.trim();
  if (!raw) return null;
  if (isPackaged && env[FEED_OVERRIDE_IN_PACKAGED_ENV] !== '1') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return null;
  const href = url.href.endsWith('/') ? url.href : `${url.href}/`;
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'dev-app-update.yml');
  // JSON is valid YAML; no publisherName → electron-updater skips the Authenticode check of the dummy.
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ provider: 'generic', url: href, updaterCacheDirName: 'githappens-updater-test' }, null, 2)}\n`,
  );
  const delay = Number(env[FEED_CHECK_DELAY_ENV]);
  return Number.isFinite(delay) && delay >= 0 && env[FEED_CHECK_DELAY_ENV]?.trim()
    ? { url: href, configPath, startupDelayMs: delay }
    : { url: href, configPath };
}

/** Point electron-updater at an override feed (`forceDevUpdateConfig` lets it run unpackaged). */
export function applyUpdateFeedOverride(
  updater: { forceDevUpdateConfig: boolean; updateConfigPath: string | null },
  override: UpdateFeedOverride,
): void {
  updater.forceDevUpdateConfig = true;
  updater.updateConfigPath = override.configPath;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the body of the `## [x.y.z]` / `## x.y.z` / `## vx.y.z` section of a Keep-a-Changelog style
 * file (up to the next level-1/2 heading), or `null` when the version has no entry.
 */
export function extractChangelogSection(markdown: string, version: string): string | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const head = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?=\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  return body.length > 0 ? body : null;
}

function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // electron-updater errors can embed whole HTTP bodies / XML feeds; keep the first line.
  const first = raw.split('\n', 1)[0]?.trim() || 'Update failed';
  return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

interface UpdateInfoLike {
  version?: string;
}
interface ProgressLike {
  percent?: number;
  bytesPerSecond?: number;
}

/**
 * Auto-update service (spec 15 §6.5): wraps electron-updater, maps its events to `UpdateStatus`,
 * checks on start and every 4 h. Never throws into callers; failures become `state: 'error'`.
 */
export class UpdaterService {
  private status: UpdateStatus;
  private readonly mode: 'disabled' | 'manual' | 'auto';
  private readonly timers: TimerApi;
  private readonly handles: unknown[] = [];
  private inflight: Promise<UpdateStatus> | null = null;
  private listening = false;
  private appliedChannel: UpdateChannel | null = null;

  constructor(private readonly o: UpdaterServiceOptions) {
    const env = o.env ?? process.env;
    const platform = o.platform ?? process.platform;
    this.timers = o.timers ?? nodeTimers;
    if (!o.isPackaged || env.GITHAPPENS_DISABLE_UPDATES === '1') this.mode = 'disabled';
    // Only the AppImage can replace itself; deb/rpm/tar.gz get a download link (spec 15 §6.5).
    else if (platform === 'linux' && !env.APPIMAGE) this.mode = 'manual';
    else this.mode = 'auto';

    const channel = this.safeChannel();
    this.status =
      this.mode === 'disabled'
        ? { state: 'disabled', currentVersion: o.currentVersion, channel }
        : this.mode === 'manual'
          ? { state: 'manual', currentVersion: o.currentVersion, channel, downloadUrl: RELEASES_URL }
          : { state: 'idle', currentVersion: o.currentVersion, channel };
  }

  get current(): UpdateStatus {
    return { ...this.status };
  }

  /** Begin the startup check and the periodic schedule. Idempotent. */
  start(): void {
    if (this.mode === 'disabled' || this.handles.length > 0) return;
    const tick = (): void => void this.check();
    this.handles.push(this.timers.setTimeout(tick, this.o.startupDelayMs ?? 10_000));
    this.handles.push(this.timers.setInterval(tick, this.o.intervalMs ?? CHECK_INTERVAL_MS));
  }

  stop(): void {
    for (const h of this.handles.splice(0)) this.timers.clear(h);
  }

  /** Re-read `updates.*` settings (call on `settings:changed`); a channel switch triggers a check. */
  refreshSettings(): void {
    if (this.mode === 'disabled') {
      this.set({ channel: this.safeChannel() });
      return;
    }
    const before = this.appliedChannel;
    this.configure();
    const st = this.status.state;
    if (before !== null && before !== this.appliedChannel && st !== 'ready' && st !== 'downloading') {
      void this.check();
    }
  }

  /** Check the feed now. Concurrent calls share one check. Resolves with the settled status. */
  check(): Promise<UpdateStatus> {
    if (this.mode === 'disabled') return Promise.resolve(this.current);
    const st = this.status.state;
    if (st === 'ready' || st === 'downloading') return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        this.configure();
        if (this.mode === 'auto') this.set({ state: 'checking', error: undefined, progress: undefined });
        const result = await this.o.updater.checkForUpdates();
        // With autoDownload, electron-updater starts the download and hands back its promise; failures
        // (network, sha512 mismatch, signature) also arrive as an 'error' event, so only swallow here to
        // avoid an unhandled rejection in the main process.
        const download = (result as { downloadPromise?: Promise<unknown> | null } | null)?.downloadPromise;
        download?.catch(() => undefined);
      } catch (e) {
        this.fail(e);
      } finally {
        this.inflight = null;
      }
      // The updater can resolve without emitting anything (e.g. inactive) — don't stay "checking".
      if (this.status.state === 'checking') this.set({ state: 'idle', checkedAt: Date.now() });
      return this.current;
    })();
    return this.inflight;
  }

  /** `ready` → quit and install; `available` (manual download) → start downloading. */
  async installAndRestart(): Promise<void> {
    if (this.mode !== 'auto') return;
    if (this.status.state === 'ready') {
      // Let the IPC reply go out before the app quits.
      this.timers.setTimeout(() => {
        try {
          this.o.updater.quitAndInstall(false, true);
        } catch (e) {
          this.fail(e);
        }
      }, 0);
      return;
    }
    if (this.status.state === 'available') {
      this.set({ state: 'downloading', progress: 0 });
      try {
        await this.o.updater.downloadUpdate();
      } catch (e) {
        this.fail(e);
      }
    }
  }

  /** Notes for the running version — once per version after an update, or always with `force`. */
  whatsNew(force = false): WhatsNew | null {
    const version = this.o.currentVersion;
    let shouldShow = force;
    if (!force && this.o.stateFile) {
      const st = readJson<{ lastSeenVersion?: string }>(this.o.stateFile);
      const last = st.kind === 'ok' ? st.value.lastSeenVersion : undefined;
      if (last !== version) {
        try {
          writeFileAtomic(this.o.stateFile, JSON.stringify({ lastSeenVersion: version }, null, 2));
        } catch (e) {
          this.log('could not persist update state', e);
        }
        // Fresh installs (no record yet) don't get release notes; upgrades do.
        shouldShow = last !== undefined;
      }
    }
    if (!shouldShow || !this.o.changelogPath) return null;
    let text: string;
    try {
      text = fs.readFileSync(this.o.changelogPath, 'utf8');
    } catch (e) {
      this.log('CHANGELOG.md not readable', e);
      return null;
    }
    const markdown = extractChangelogSection(text, version);
    return markdown === null ? null : { version, markdown };
  }

  // ---- internals ------------------------------------------------------------------------------------

  private safeChannel(): UpdateChannel {
    try {
      return this.o.getChannel() === 'preview' ? 'preview' : 'stable';
    } catch {
      return 'stable';
    }
  }

  private safeAutoDownload(): boolean {
    try {
      return this.o.getAutoDownload();
    } catch {
      return true;
    }
  }

  /** Apply channel/autoDownload to the updater and attach listeners on first use. */
  private configure(): void {
    const u = this.o.updater;
    const channel = this.safeChannel();
    if (!this.listening) this.listen();
    if (channel === 'preview') {
      // GitHub provider: allowPrerelease makes it look past /releases/latest at the newest `-preview.N`
      // prerelease in the releases feed and read its `preview.yml` / `preview-mac.yml` / `preview-linux.yml`.
      u.channel = 'preview';
      u.allowPrerelease = true;
    } else {
      // Stable: only the latest non-prerelease release (/releases/latest) and its latest*.yml.
      u.channel = 'latest';
      u.allowPrerelease = false;
    }
    // Setting `channel` flips allowDowngrade on; switching preview → stable must wait, not downgrade.
    u.allowDowngrade = false;
    u.autoDownload = this.mode === 'auto' && this.safeAutoDownload();
    u.autoInstallOnAppQuit = this.mode === 'auto' && this.o.installOnQuit !== false;
    this.appliedChannel = channel;
    if (this.status.channel !== channel) this.set({ channel });
  }

  private listen(): void {
    this.listening = true;
    const u = this.o.updater;
    const on = (event: string, fn: (...args: unknown[]) => void): void => {
      u.on(event, ((...args: unknown[]) => {
        try {
          fn(...args);
        } catch (e) {
          this.log(`updater ${event} handler failed`, e);
        }
      }) as (...args: never[]) => void);
    };
    on('checking-for-update', () => {
      if (this.mode === 'auto') this.set({ state: 'checking', error: undefined });
    });
    on('update-available', (info) => {
      const version = (info as UpdateInfoLike | undefined)?.version;
      if (this.mode === 'manual') {
        this.set({ state: 'manual', version, downloadUrl: RELEASES_URL, checkedAt: Date.now() });
      } else if (this.o.updater.autoDownload) {
        this.set({ state: 'downloading', version, progress: 0, checkedAt: Date.now() });
      } else {
        this.set({ state: 'available', version, checkedAt: Date.now() });
      }
    });
    on('update-not-available', () => {
      if (this.mode === 'manual') this.set({ checkedAt: Date.now() });
      else
        this.set({ state: 'not-available', version: undefined, progress: undefined, checkedAt: Date.now() });
    });
    on('download-progress', (p) => {
      if (this.mode !== 'auto' || this.status.state === 'ready') return;
      const prog = p as ProgressLike | undefined;
      const pct = typeof prog?.percent === 'number' && Number.isFinite(prog.percent) ? prog.percent : 0;
      this.set({
        state: 'downloading',
        progress: Math.min(1, Math.max(0, pct / 100)),
        bytesPerSecond: prog?.bytesPerSecond,
      });
    });
    on('update-downloaded', (info) => {
      if (this.mode !== 'auto') return;
      const version = (info as UpdateInfoLike | undefined)?.version ?? this.status.version;
      this.set({ state: 'ready', version, progress: 1, bytesPerSecond: undefined });
    });
    on('update-cancelled', () => {
      if (this.mode === 'auto') this.set({ state: 'available', progress: undefined });
    });
    on('error', (err) => this.fail(err));
  }

  private fail(e: unknown): void {
    this.log('update check failed', e);
    // Manual (deb/rpm) installs keep their download link; a failed feed check isn't actionable.
    if (this.mode === 'manual') return;
    if (this.status.state === 'ready') return;
    this.set({ state: 'error', error: errorMessage(e), progress: undefined, checkedAt: Date.now() });
  }

  private set(patch: Partial<UpdateStatus>): void {
    const next: UpdateStatus = { ...this.status, ...patch };
    for (const k of Object.keys(next) as (keyof UpdateStatus)[]) if (next[k] === undefined) delete next[k];
    this.status = next;
    try {
      this.o.onStatus?.(this.current);
    } catch (e) {
      this.log('update status listener failed', e);
    }
  }

  private log(message: string, error?: unknown): void {
    if (this.o.log) this.o.log(message, error);
    else console.warn(`[updater] ${message}`, error ?? '');
  }
}
