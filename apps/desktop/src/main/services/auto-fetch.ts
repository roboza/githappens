import { GitError, type GitErrorCode, type OpStateEvent, type RepoId } from '@githappens/git';

import type { AutoFetchState } from '../../shared/ipc/behaviour-contract';

/** Failures that need the user (credentials / host key): pause instead of retrying (spec 09 §6.2 step 4). */
export const AUTH_PAUSE_CODES: ReadonlySet<GitErrorCode> = new Set<GitErrorCode>([
  'AuthenticationFailed',
  'AuthCancelled',
  'HostKeyVerificationFailed',
  'PermissionDenied',
  'ProxyAuthRequired',
]);

export interface AutoFetchDeps {
  /** `general.autoFetchInterval` (minutes, 0 = off) and `general.autoPrune`. */
  settings: () => { intervalMin: number; prune: boolean };
  /** Run `fetch --all` as a background op (never prompts). Rejects with GitError on failure. */
  fetch: (repoId: RepoId, prune: boolean) => Promise<unknown>;
  hasRemotes: (repoId: RepoId) => Promise<boolean>;
  isBare?: (repoId: RepoId) => boolean;
  /** A mutating op is running or queued in this repo (skip the tick, spec 09 §6.2 step 2). */
  isBusy?: (repoId: RepoId) => boolean;
  /** Electron `net.isOnline()`. */
  isOnline?: () => boolean;
  /** `sync:autoFetch:state`. */
  emit?: (state: AutoFetchState) => void;
  /** Called on every failed auto-fetch (toast when `notifications.autoFetchErrors`). */
  onFailure?: (repoId: RepoId, error: { code: GitErrorCode; message: string }, paused: boolean) => void;
  /** Timing knobs (tests). */
  firstDelayMs?: number;
  backgroundMinMs?: number;
  maxBackoffMs?: number;
  backoffBaseMs?: number;
  jitterMs?: number;
  maxConcurrent?: number;
  random?: () => number;
  now?: () => number;
}

interface RepoState {
  timer: ReturnType<typeof setTimeout> | null;
  lastFetchAt: number | null;
  nextFetchAt: number | null;
  lastError?: AutoFetchState['lastError'];
  paused: boolean;
  failures: number;
  running: boolean;
  /** Fired at least once (the first run is 10 s after open). */
  started: boolean;
}

const MIN = 60_000;

/**
 * Auto-fetch scheduler (spec 09 §6.2, spec 13 §6/§8): per open repo, first run ~10 s after open,
 * interval from settings, background tabs throttled to ≥ 5 min, skip while busy/offline/no remotes,
 * pause on auth failures (resumed by a successful manual fetch or "Resume"), exponential backoff
 * (1, 2, 4 … 30 min) on other failures, and at most 3 concurrent fetches app-wide with jitter.
 */
export class AutoFetchScheduler {
  private readonly repos = new Map<RepoId, RepoState>();
  private active: RepoId | null = null;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly d: AutoFetchDeps) {}

  /** A repository was opened. */
  add(repoId: RepoId): void {
    if (this.repos.has(repoId) || this.disposed) return;
    this.repos.set(repoId, {
      timer: null,
      lastFetchAt: null,
      nextFetchAt: null,
      paused: false,
      failures: 0,
      running: false,
      started: false,
    });
    this.schedule(repoId);
  }

  /** The repository was closed. */
  remove(repoId: RepoId): void {
    const s = this.repos.get(repoId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.repos.delete(repoId);
    if (this.active === repoId) this.active = null;
  }

  /** The repo in the focused tab; every other repo is a background tab. */
  setActive(repoId: RepoId | null): void {
    if (this.active === repoId) return;
    const prev = this.active;
    this.active = repoId;
    // re-arm both so the new interval applies (a background tab becoming active fetches sooner)
    for (const id of [prev, repoId]) if (id && this.repos.has(id)) this.schedule(id);
  }

  /** Interval / prune setting changed. */
  reschedule(): void {
    for (const id of this.repos.keys()) this.schedule(id);
  }

  /** "Resume auto-fetch" after an auth pause: fetch again soon. */
  resume(repoId: RepoId): void {
    const s = this.repos.get(repoId);
    if (!s) return;
    s.paused = false;
    s.failures = 0;
    s.lastError = undefined;
    this.schedule(repoId, this.d.firstDelayMs ?? 10_000);
  }

  /**
   * Feed `git:op:state`: a successful fetch/pull that was not ours (manual) resumes a paused repo
   * and counts as a fresh fetch.
   */
  onOpState(repoId: RepoId, e: Pick<OpStateEvent, 'type' | 'state'>): void {
    const s = this.repos.get(repoId);
    if (!s || s.running) return;
    if ((e.type === 'fetch' || e.type === 'pull') && e.state === 'succeeded') {
      s.lastFetchAt = this.now();
      if (s.paused || s.failures) {
        s.paused = false;
        s.failures = 0;
        s.lastError = undefined;
      }
      this.schedule(repoId);
    }
  }

  /** True while the scheduler's own fetch for this repo runs (lets callers tag op events as background). */
  isRunning(repoId: RepoId): boolean {
    return this.repos.get(repoId)?.running ?? false;
  }

  state(repoId: RepoId): AutoFetchState | null {
    const s = this.repos.get(repoId);
    if (!s) return null;
    return {
      repoId,
      enabled: this.enabled(repoId),
      lastFetchAt: s.lastFetchAt,
      nextFetchAt: s.nextFetchAt,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      paused: s.paused,
      failures: s.failures,
      running: s.running,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.repos.values()) if (s.timer) clearTimeout(s.timer);
    this.repos.clear();
    for (const w of this.waiters.splice(0)) w();
  }

  // ---------------------------------------------------------------------------

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private enabled(repoId: RepoId): boolean {
    const cfg = this.d.settings();
    return cfg.intervalMin > 0 && !this.d.isBare?.(repoId);
  }

  /** Delay before the next attempt (without jitter). */
  delayFor(repoId: RepoId): number {
    const s = this.repos.get(repoId);
    const cfg = this.d.settings();
    let delay = cfg.intervalMin * MIN;
    if (this.active !== null && this.active !== repoId)
      delay = Math.max(delay, this.d.backgroundMinMs ?? 5 * MIN);
    if (s && s.failures > 0) {
      const base = this.d.backoffBaseMs ?? MIN;
      const backoff = Math.min(base * 2 ** (s.failures - 1), this.d.maxBackoffMs ?? 30 * MIN);
      delay = Math.max(delay, backoff);
    }
    return delay;
  }

  private schedule(repoId: RepoId, explicitDelay?: number): void {
    const s = this.repos.get(repoId);
    if (!s || this.disposed) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.nextFetchAt = null;
    if (!this.enabled(repoId) || s.paused) {
      this.emit(repoId);
      return;
    }
    let delay = explicitDelay ?? (s.started ? this.delayFor(repoId) : (this.d.firstDelayMs ?? 10_000));
    delay += Math.floor((this.d.random ?? Math.random)() * (this.d.jitterMs ?? 5_000));
    s.nextFetchAt = this.now() + delay;
    s.timer = setTimeout(() => void this.tick(repoId), delay);
    (s.timer as { unref?: () => void }).unref?.();
    this.emit(repoId);
  }

  private async tick(repoId: RepoId): Promise<void> {
    const s = this.repos.get(repoId);
    if (!s || this.disposed) return;
    s.timer = null;
    s.started = true;
    const skip =
      !this.enabled(repoId) ||
      s.paused ||
      (this.d.isOnline && !this.d.isOnline()) ||
      (this.d.isBusy && this.d.isBusy(repoId)) ||
      !(await this.d.hasRemotes(repoId).catch(() => false));
    if (skip) {
      if (this.repos.get(repoId) === s) this.schedule(repoId);
      return;
    }
    await this.acquire();
    if (this.repos.get(repoId) !== s || this.disposed) {
      this.release();
      return;
    }
    s.running = true;
    this.emit(repoId);
    try {
      await this.d.fetch(repoId, this.d.settings().prune);
      s.lastFetchAt = this.now();
      s.failures = 0;
      s.lastError = undefined;
    } catch (e) {
      const code: GitErrorCode = e instanceof GitError ? e.code : 'Unknown';
      const message = e instanceof Error ? e.message : String(e);
      if (code === 'Cancelled') {
        // repo closed / user cancelled: not a failure
      } else {
        s.lastError = { code, message, at: this.now() };
        if (AUTH_PAUSE_CODES.has(code)) s.paused = true;
        else s.failures++;
        try {
          this.d.onFailure?.(repoId, { code, message }, s.paused);
        } catch {
          /* listener errors don't stop the scheduler */
        }
      }
    } finally {
      s.running = false;
      this.release();
    }
    if (this.repos.get(repoId) === s) this.schedule(repoId);
  }

  private acquire(): Promise<void> {
    if (this.inFlight < (this.d.maxConcurrent ?? 3)) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.waiters.shift()?.();
  }

  private emit(repoId: RepoId): void {
    const st = this.state(repoId);
    if (st) this.d.emit?.(st);
  }

  /** Concurrency in use (tests). */
  get running(): number {
    return this.inFlight;
  }
}
