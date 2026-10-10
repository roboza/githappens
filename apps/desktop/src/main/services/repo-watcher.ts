import fs from 'node:fs';
import path from 'node:path';

import type { RefreshScope } from '../../shared/ipc/git-contract';

/**
 * RepoWatcher (spec 02 §6.14): maps file-system events in the worktree and `.git`
 * to refresh scopes, debounced (trailing 300 ms, max-wait 1500 ms).
 */

export type FsEventType = 'create' | 'update' | 'delete';

const STATE_FILES = new Set([
  'MERGE_HEAD',
  'MERGE_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_LOG',
]);

/** Scopes for a path relative to gitDir/commonDir (posix separators). */
export function scopesForGitPath(rel: string, type: FsEventType): RefreshScope[] {
  if (rel.endsWith('.lock')) {
    // A lock disappearing means another process finished writing (spec 02 §6.14).
    return type === 'delete' && rel === 'index.lock' ? ['status'] : [];
  }
  if (rel === 'HEAD' || rel === 'ORIG_HEAD') return ['refs', 'graph', 'status', 'repoState'];
  if (rel === 'index') return ['status'];
  if (rel === 'refs/stash' || rel === 'logs/refs/stash') return ['stash', 'graph'];
  if (rel.startsWith('refs/githappens/')) return [];
  if (rel === 'packed-refs' || /^refs\/(heads|remotes|tags)\//.test(rel)) return ['refs', 'graph'];
  if (rel === 'FETCH_HEAD') return ['refs'];
  if (STATE_FILES.has(rel) || /^(rebase-merge|rebase-apply|sequencer)(\/|$)/.test(rel)) {
    return ['repoState', 'conflicts', 'status'];
  }
  if (rel === 'config') return ['config', 'remotes', 'submodules'];
  if (rel.startsWith('worktrees/')) return ['worktrees'];
  if (/^modules\/.+\/HEAD$/.test(rel)) return ['submodules'];
  if (rel === 'info/exclude') return ['status'];
  return [];
}

/** Scopes for a path relative to the worktree root. */
export function scopesForWorktreePath(rel: string): RefreshScope[] {
  const base = rel.split('/').pop();
  if (base === '.gitmodules') return ['submodules', 'status'];
  return ['status'];
}

/** Paths under gitDir never worth watching (spec 02 §6.14 "Ignored"). */
export const GIT_DIR_IGNORES = [
  'objects',
  'logs/HEAD',
  'logs/refs/heads',
  'logs/refs/remotes',
  'lfs',
  'hooks',
  'fsmonitor--daemon',
  'rr-cache',
  'gc.pid',
  'refs/githappens',
];

/** Heavy directories skipped in the worktree (status is still the source of truth). */
export const WORKTREE_IGNORES = [
  '.git',
  '**/node_modules',
  '**/.venv',
  '**/target',
  '**/dist',
  '**/out',
  '**/bin/obj',
  '**/.turbo',
  '**/.next',
];

export interface DebounceOptions {
  /** Trailing quiet period (spec 02 §6.14: 300 ms). */
  waitMs?: number;
  /** Max wait while events keep coming (1500 ms). */
  maxWaitMs?: number;
  /** More events than this in one window = a flood (`npm install`): 1000. */
  floodThreshold?: number;
  /** Safety cap while flooding, so a never-ending flood still refreshes eventually (10 s). */
  floodMaxWaitMs?: number;
  /**
   * Leading edge: the first event after a quiet period (no window open, no leading emit in the last
   * `waitMs`) is emitted at once; events that follow are debounced as usual (trailing / max-wait /
   * flood). Takes the 300 ms debounce out of a single external save (spec 02 §9: save → WIP < 500 ms).
   *
   * Follow-ups: the few events arriving right after a leading emit (a delete after a save, the second
   * half of an editor's write-and-rename) are emitted at once too, up to `followUpEvents` raw events per
   * burst, instead of waiting for the trailing window. The renderer coalesces a refresh requested while
   * one is in flight into a single re-run as soon as it completes (spec 02 §6.14 "coalescing with
   * reads"), so the follow-up refresh starts right after the leading one. A bigger burst falls back to
   * the debounce (and flood mode) as before.
   */
  leading?: boolean;
  /** Leading mode: raw events per burst emitted immediately after the leading emit (default 4). */
  followUpEvents?: number;
}

/**
 * Per-window scope debouncer (spec 02 §6.14): trailing 300 ms with max-wait 1500 ms. Under an event flood
 * (> 1000 events in one window) it switches to a single full `status` refresh once the flood goes quiet,
 * so a 50k-file `npm install` costs one refresh instead of one per 1.5 s.
 */
export class ScopeDebouncer {
  private pending = new Set<RefreshScope>();
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private maxWait: ReturnType<typeof setTimeout> | null = null;
  private events = 0;
  private flooding = false;
  /** Armed for `waitMs` after a leading-edge (or follow-up) emit. */
  private cooldown: ReturnType<typeof setTimeout> | null = null;
  /** Raw events since the burst's leading emit (follow-up budget). */
  private burstEvents = 0;
  private readonly o: Required<DebounceOptions>;

  constructor(
    private readonly emit: (scopes: RefreshScope[]) => void,
    waitMs: number | DebounceOptions = 300,
    maxWaitMs = 1500,
  ) {
    const opts = typeof waitMs === 'number' ? { waitMs, maxWaitMs } : waitMs;
    this.o = {
      waitMs: opts.waitMs ?? 300,
      maxWaitMs: opts.maxWaitMs ?? 1500,
      floodThreshold: opts.floodThreshold ?? 1000,
      floodMaxWaitMs: opts.floodMaxWaitMs ?? 10_000,
      leading: opts.leading ?? false,
      followUpEvents: opts.followUpEvents ?? 4,
    };
  }

  /** True while the current window is in flood mode. */
  get isFlooding(): boolean {
    return this.flooding;
  }

  /** `eventCount`: raw file-system events behind these scopes (flood detection). */
  push(scopes: Iterable<RefreshScope>, eventCount = 1): void {
    let added = false;
    for (const s of scopes) {
      this.pending.add(s);
      added = true;
    }
    if (!added) return;
    const n = Math.max(1, eventCount);
    if (this.o.leading && !this.trailing && !this.maxWait && !this.flooding) {
      if (!this.cooldown) {
        // idle: refresh now (leading edge)
        this.burstEvents = 0;
        this.emitNow();
        return;
      }
      if (this.burstEvents + n <= this.o.followUpEvents) {
        // right after a leading emit (e.g. the delete after a save): refresh now as well; a refresh still
        // in flight in the renderer re-runs once it completes instead of stacking
        this.burstEvents += n;
        this.emitNow();
        return;
      }
    }
    this.burstEvents += n;
    this.events += Math.max(1, eventCount);
    if (!this.flooding && this.events > this.o.floodThreshold) {
      // flood: drop the max-wait cadence, refresh status once after quiet (safety cap only)
      this.flooding = true;
      this.pending.add('status');
      if (this.maxWait) clearTimeout(this.maxWait);
      this.maxWait = setTimeout(() => this.flush(), this.o.floodMaxWaitMs);
    }
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = setTimeout(() => this.flush(), this.o.waitMs);
    this.maxWait ??= setTimeout(() => this.flush(), this.o.maxWaitMs);
  }

  /** Emit what is pending now and (re)arm the leading-edge cooldown. */
  private emitNow(): void {
    if (this.cooldown) clearTimeout(this.cooldown);
    this.cooldown = setTimeout(() => {
      this.cooldown = null;
    }, this.o.waitMs);
    this.cooldown.unref?.();
    const scopes = [...this.pending];
    this.pending.clear();
    this.emit(scopes);
  }

  flush(): void {
    if (this.trailing) clearTimeout(this.trailing);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.trailing = this.maxWait = null;
    this.events = 0;
    this.flooding = false;
    if (this.pending.size === 0) return;
    const scopes = [...this.pending];
    this.pending.clear();
    this.emit(scopes);
  }

  cancel(): void {
    if (this.trailing) clearTimeout(this.trailing);
    if (this.maxWait) clearTimeout(this.maxWait);
    if (this.cooldown) clearTimeout(this.cooldown);
    this.trailing = this.maxWait = this.cooldown = null;
    this.events = 0;
    this.burstEvents = 0;
    this.flooding = false;
    this.pending.clear();
  }
}

/** Minimal surface of @parcel/watcher (injectable for tests). */
export interface WatcherBackend {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: { type: FsEventType; path: string }[]) => void,
    opts: { ignore?: string[]; backend?: NativeBackendName },
  ): Promise<{ unsubscribe(): Promise<void> }>;
}

export type NativeBackendName = 'windows' | 'fs-events' | 'inotify';

/**
 * The OS backend, named explicitly. Without one, @parcel/watcher probes for watchman on EVERY `subscribe`
 * by spawning `watchman --output-encoding=bser get-sockname` through a synchronous popen (cmd.exe on
 * Windows): 0.35–0.4 s of blocked main process per subscribe on an idle machine, seconds under load,
 * three subscribes per repo open. With the backend named, subscribe returns in < 5 ms.
 */
export function nativeBackendFor(
  platform: NodeJS.Platform = process.platform,
): NativeBackendName | undefined {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'fs-events';
  if (platform === 'linux') return 'inotify';
  return undefined;
}

export interface RepoWatcherOptions {
  worktreeRoot: string | null; // null for bare repos
  gitDir: string;
  commonDir: string;
  onChange: (scopes: RefreshScope[]) => void;
  onError?: (err: Error) => void;
  /** Watch mode changed (status-bar "File watching unavailable" while polling, spec 02 §6.14). */
  onModeChange?: (mode: WatchMode) => void;
  backend: WatcherBackend;
  /** Native backend passed to `subscribe` (default `nativeBackendFor(process.platform)`; null = let it pick). */
  nativeBackend?: NativeBackendName | null;
  pollIntervalMs?: number;
  /** Background tabs drop the worktree watch after this long (spec 02 §6.14: 60 s). */
  suspendAfterMs?: number;
  debounce?: DebounceOptions;
}

/** `native`: file-system events; `polling`: the watcher failed, `.git` mtimes are polled every 5 s. */
export type WatchMode = 'native' | 'polling';

const toPosix = (p: string): string => p.split(path.sep).join('/');

type Sub = { unsubscribe(): Promise<void> };

export class RepoWatcher {
  private gitSubs: Sub[] = [];
  private worktreeSub: Sub | null = null;
  private worktreeStarting: Promise<void> | null = null;
  private readonly debouncer: ScopeDebouncer;
  private muted = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private active = true;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;

  constructor(private readonly o: RepoWatcherOptions) {
    this.debouncer = new ScopeDebouncer((scopes) => {
      if (!this.disposed) o.onChange(scopes);
    }, o.debounce);
  }

  /**
   * Subscribe `.git` (+ the common dir of a linked worktree) and the worktree, in parallel. Safe to call
   * without awaiting: a dispose or suspension that lands while a subscribe is in flight drops it.
   */
  async start(): Promise<void> {
    const { gitDir, commonDir } = this.o;
    // Linked worktree: shared refs/config live in commonDir.
    const dirs = path.resolve(commonDir) !== path.resolve(gitDir) ? [gitDir, commonDir] : [gitDir];
    try {
      await Promise.all([
        ...dirs.map(async (dir) => {
          const sub = await this.subscribe(dir, this.gitHandler(dir), GIT_DIR_IGNORES);
          if (this.disposed) await sub.unsubscribe().catch(() => undefined);
          else this.gitSubs.push(sub);
        }),
        this.watchWorktree(),
      ]);
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private subscribe(
    dir: string,
    cb: (err: Error | null, events: { type: FsEventType; path: string }[]) => void,
    ignore: string[],
  ): Promise<Sub> {
    const backend = this.o.nativeBackend === undefined ? nativeBackendFor() : this.o.nativeBackend;
    return this.o.backend.subscribe(dir, cb, backend ? { ignore, backend } : { ignore });
  }

  /** Queue scopes through the debouncer as if the file system had reported them (ignored while muted). */
  notify(scopes: RefreshScope[]): void {
    if (!this.disposed && !this.muted) this.debouncer.push(scopes);
  }

  /** Suspend while our own mutating op runs; the queue emits one refresh afterwards (spec 02 §6.13). */
  mute(): void {
    this.muted++;
  }

  unmute(): void {
    this.muted = Math.max(0, this.muted - 1);
  }

  get isPolling(): boolean {
    return this.poll !== null;
  }

  get mode(): WatchMode {
    return this.poll ? 'polling' : 'native';
  }

  /** The worktree watch is suspended (background tab, spec 02 §6.14). */
  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Tab activation (spec 02 §6.14 "Inactive tabs"): a background repo keeps its `.git` watch but drops the
   * worktree watch after 60 s; on activation the worktree watch resumes with a full status refresh.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (!active) {
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        void this.suspendWorktree();
      }, this.o.suspendAfterMs ?? 60_000);
      this.suspendTimer.unref?.();
      return;
    }
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (!this.suspended) return;
    this.suspended = false;
    void this.watchWorktree()
      .catch((e: unknown) => this.fail(e as Error))
      .finally(() => {
        this.debouncer.push(['status']);
        this.debouncer.flush();
      });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.debouncer.cancel();
    if (this.poll) clearInterval(this.poll);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    const subs = [...this.gitSubs, ...(this.worktreeSub ? [this.worktreeSub] : [])];
    this.gitSubs = [];
    this.worktreeSub = null;
    await Promise.allSettled(subs.map((s) => s.unsubscribe()));
  }

  private watchWorktree(): Promise<void> {
    this.worktreeStarting ??= this.subscribeWorktree().finally(() => {
      this.worktreeStarting = null;
    });
    return this.worktreeStarting;
  }

  private async subscribeWorktree(): Promise<void> {
    const root = this.o.worktreeRoot;
    if (!root || this.worktreeSub || this.disposed) return;
    const sub = await this.subscribe(
      root,
      (err, events) => {
        if (err) return this.fail(err);
        if (this.muted) return;
        const scopes = new Set<RefreshScope>();
        for (const e of events) {
          const rel = toPosix(path.relative(root, e.path));
          if (rel === '.git' || rel.startsWith('.git/')) continue; // gitDir handled separately
          for (const s of scopesForWorktreePath(rel)) scopes.add(s);
        }
        this.debouncer.push(scopes, events.length);
      },
      WORKTREE_IGNORES,
    );
    // disposed or sent to the background while subscribing
    if (this.disposed || this.suspended) await sub.unsubscribe().catch(() => undefined);
    else this.worktreeSub = sub;
  }

  private async suspendWorktree(): Promise<void> {
    if (this.active || this.disposed || this.suspended) return;
    this.suspended = true;
    const sub = this.worktreeSub;
    this.worktreeSub = null;
    await sub?.unsubscribe().catch(() => undefined);
  }

  private gitHandler(root: string) {
    return (err: Error | null, events: { type: FsEventType; path: string }[]): void => {
      if (err) return this.fail(err);
      if (this.muted) return;
      const scopes = new Set<RefreshScope>();
      for (const e of events)
        for (const s of scopesForGitPath(toPosix(path.relative(root, e.path)), e.type)) scopes.add(s);
      this.debouncer.push(scopes, events.length);
    };
  }

  /** Watching failed (inotify limit, network drive): poll key `.git` mtimes instead. */
  private fail(err: Error): void {
    this.o.onError?.(err);
    if (this.poll || this.disposed) return;
    const roots = [...new Set([this.o.gitDir, this.o.commonDir])];
    let last = pollSnapshot(roots);
    this.poll = setInterval(() => {
      if (this.muted) return;
      const now = pollSnapshot(roots);
      // Refs/HEAD/state changed → full refresh; otherwise still re-read status, since worktree
      // edits can't be detected without a watcher (spec 02 §6.14 fallback).
      this.debouncer.push(
        now !== last ? ['status', 'refs', 'graph', 'stash', 'repoState', 'conflicts'] : ['status'],
      );
      last = now;
    }, this.o.pollIntervalMs ?? 5000);
    this.o.onModeChange?.('polling');
  }
}

const POLL_FILES = [
  'HEAD',
  'index',
  'packed-refs',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
];
const MAX_REF_ENTRIES = 5000;

/** mtimes of key `.git` files plus every loose ref (names + mtimes), as one comparable string. */
export function pollSnapshot(gitDirs: string[]): string {
  const parts: string[] = [];
  const stat = (f: string): number => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  for (const dir of gitDirs) {
    for (const f of POLL_FILES) parts.push(`${f}:${stat(path.join(dir, f))}`);
    const stack = [path.join(dir, 'refs')];
    while (stack.length && parts.length < MAX_REF_ENTRIES) {
      const d = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'githappens') stack.push(p);
        } else parts.push(`${p}:${stat(p)}`);
      }
    }
  }
  return parts.join('|');
}
