import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  GitError,
  GitService,
  makeError,
  OperationQueue,
  RepoLanes,
  UndoJournal,
  type GitOperation,
  type OpRegistry,
  type OpResult,
  type OpStateEvent,
  type ProgressEvent,
  type GitProcessRunner,
  type GitFeatureFlags,
  type LogCursor,
  type LogPage,
  type LogQuery,
  type RepoId,
  type RepoInfo,
  type CommitIdentity,
  type UndoPeek,
} from '@githappens/git';

import type { RefreshScope } from '../../shared/ipc/git-contract';
import { RepoWatcher, type WatcherBackend, type WatchMode } from './repo-watcher';
import { canonicalKey } from './canonical-path';

interface OpenRepo {
  service: GitService;
  watcher: RepoWatcher | null;
  queue: OperationQueue;
  journal: UndoJournal;
  refCount: number;
  cursors: Map<string, { cursor: LogCursor; lastUsed: number }>;
  autoFetch: ReturnType<typeof setTimeout> | null;
  /** Background `index.refresh` (fsmonitor token / untracked cache, spec 02 §6.15.2). */
  indexRefresh: { timer: ReturnType<typeof setTimeout> | null; last: number };
}

interface WarmService {
  service: GitService;
  at: number;
  keys: string[];
  timer: ReturnType<typeof setTimeout>;
}
/** How long a validated-but-not-opened repo's GitService is kept for reuse. */
const WARM_MS = 10_000;
/** Canonical key (native realpath: 8.3 short names expanded, case-folded on win32/darwin). */
const warmKey = (p: string): string => canonicalKey(p);

/** Network ops are undo barriers (spec 05: undo can't pass a push/fetch/pull). */
const NETWORK_OPS = new Set<GitOperation['type']>([
  'fetch',
  'pull',
  'push',
  'push.tags',
  'push.delete',
  'fastForwardBranch',
  'branch.renameRemote',
]);

export interface RepoManagerOptions {
  runner: () => GitProcessRunner;
  features: () => GitFeatureFlags | undefined;
  watcherBackend: WatcherBackend | null;
  onChanged: (repoId: RepoId, scopes: RefreshScope[], reason: 'watcher' | 'op' | 'focus' | 'manual') => void;
  onWatchError?: (repoId: RepoId, err: Error) => void;
  /** Lock files removed after a cancelled / crashed op (spec 02 §6.2): log them to the output log. */
  onLocksRemoved?: (repoId: RepoId, opId: string, paths: string[]) => void;
  /** Stale-lock heuristic override (tests); default is a best-effort OS process scan. */
  isGitRunning?: (dirs: string[]) => Promise<boolean>;
  /** Background tabs suspend the worktree watch after this long (spec 02 §6.14: 60 s). */
  suspendWatchAfterMs?: number;
  /** Idle log cursors are disposed after this long (the git process is killed). */
  cursorIdleMs?: number;
  /** At most one background `index.refresh` per repo per this long (default 5 min; 0 = never). */
  indexRefreshIntervalMs?: number;
  /** First `index.refresh` after open / after a burst of worktree changes (default 3 s). */
  indexRefreshDelayMs?: number;
  /** Operation executors (spec 02 §5.5); built per repo because undo ops bind to that repo's journal. */
  registry: (journal: UndoJournal) => OpRegistry;
  /** Where per-repo undo journals are persisted (`<dir>/<repoId>.json`). */
  journalDir?: string;
  onOpState?: (repoId: RepoId, e: OpStateEvent) => void;
  /** Undo/redo stacks changed (spec 05 §5 `undo:changed` event). */
  onUndoChanged?: (repoId: RepoId, peek: UndoPeek) => void;
  onOpProgress?: (repoId: RepoId, opId: string, p: ProgressEvent) => void;
  credentialEnv?: (opId: string, background: boolean) => Record<string, string>;
  /** Called when an op settles (credential cleanup); `errorCode` set on failure. */
  onOpFinished?: (opId: string, errorCode?: string) => void;
  /** Lets the credential layer reclassify failures (e.g. a cancelled prompt → AuthCancelled). */
  mapError?: (opId: string, err: GitError) => GitError;
  /** Auto-fetch settings (spec 09 §6.2); interval in minutes, 0 = off. */
  autoFetch?: () => { intervalMin: number; prune: boolean };
  /** Active profile identity, injected as `-c user.*` into commit-creating ops (spec 13 §6). */
  identity?: () => CommitIdentity | null | undefined;
  /** Settings-driven op rewrite + follow-ups around every op (Phase 7 `OpBehaviour`). */
  behaviour?: {
    prepare(service: GitService, op: GitOperation): Promise<{ op: GitOperation; state: unknown }>;
    after(
      repoId: RepoId,
      service: GitService,
      op: GitOperation,
      r: OpResult,
      state: unknown,
    ): Promise<OpResult>;
  };
  /** Repo lifecycle (external auto-fetch scheduler, output log). */
  onOpened?: (repoId: RepoId) => void;
  onClosed?: (repoId: RepoId) => void;
}

/**
 * Owns one GitService + RepoWatcher per open repository (spec 02 §5.4, spec 03 `repos:close`).
 * Several tabs may share a repo; it is disposed when the last one closes.
 */
export class RepoManager {
  private readonly repos = new Map<RepoId, OpenRepo>();
  private readonly warm = new Map<string, WarmService>();
  private readonly sweep: ReturnType<typeof setInterval>;
  /** One lane per repository commonDir: linked worktrees serialize ref-mutating ops (spec 02 §6.13). */
  private readonly lanes = new RepoLanes();
  /** undefined until the renderer reports the focused tab. */
  private activeRepo: RepoId | null | undefined = undefined;

  constructor(private readonly o: RepoManagerOptions) {
    this.sweep = setInterval(() => this.disposeIdleCursors(), 60_000);
    this.sweep.unref?.();
  }

  /**
   * A GitService for a quick read of `repoPath` (validation before opening, spec 03): the open repo's own
   * service, or one discovered now and kept warm for a few seconds, so the `repos:validate` →
   * `repos:open` → `git:repo:open` sequence of one repo open discovers it once instead of three times
   * (≈ 0.5 s of sequential git spawns each on Windows). Callers must not dispose it.
   */
  async borrow(repoPath: string): Promise<GitService> {
    const key = warmKey(repoPath);
    for (const e of this.repos.values()) {
      if (warmKey(e.service.repo.worktreeRoot ?? e.service.repo.gitDir) === key) return e.service;
    }
    const warm = this.warm.get(key);
    if (warm) return warm.service;
    const service = await GitService.open(this.o.runner(), repoPath, { features: this.o.features() });
    const entry = {
      service,
      at: Date.now(),
      keys: [...new Set([key, warmKey(service.repo.worktreeRoot ?? service.repo.gitDir)])],
      timer: setTimeout(() => this.dropWarm(entry, true), WARM_MS),
    };
    entry.timer.unref?.();
    for (const k of entry.keys) if (!this.warm.has(k)) this.warm.set(k, entry);
    return service;
  }

  private dropWarm(entry: WarmService, dispose: boolean): void {
    clearTimeout(entry.timer);
    for (const k of entry.keys) if (this.warm.get(k) === entry) this.warm.delete(k);
    if (dispose) entry.service.dispose();
  }

  async open(repoPath: string): Promise<RepoInfo> {
    const warm = this.warm.get(warmKey(repoPath));
    let service: GitService;
    if (warm) {
      // discovered by a validation moments ago: adopt it (HEAD / state re-read unless very fresh)
      this.dropWarm(warm, false);
      service = warm.service;
      if (Date.now() - warm.at > 1000) await service.refreshRepoInfo();
    } else {
      service = await GitService.open(this.o.runner(), repoPath, { features: this.o.features() });
    }
    const id = service.repo.id;
    const existing = this.repos.get(id);
    if (existing) {
      service.dispose();
      existing.refCount++;
      return existing.service.refreshRepoInfo();
    }
    const journal = new UndoJournal({
      service,
      persistFile: this.o.journalDir ? path.join(this.o.journalDir, `${id}.json`) : undefined,
      onChange: (peek) => this.o.onUndoChanged?.(id, peek),
    });
    const entry: OpenRepo = {
      service,
      watcher: null,
      journal,
      queue: null as unknown as OperationQueue,
      refCount: 1,
      cursors: new Map(),
      autoFetch: null,
      indexRefresh: { timer: null, last: 0 },
    };
    entry.queue = new OperationQueue(service, this.o.registry(journal), {
      // our own index maintenance is not a user-visible operation
      onState: (e) => e.type !== 'index.refresh' && this.o.onOpState?.(id, e),
      onProgress: (opId, p) => this.o.onOpProgress?.(id, opId, p),
      onRefresh: (scopes) => {
        void service.refreshRepoInfo().catch(() => undefined);
        this.o.onChanged(id, scopes, 'op');
      },
      muteWatcher: () => entry.watcher?.mute(),
      unmuteWatcher: () => entry.watcher?.unmute(),
      journal,
      credentialEnv: this.o.credentialEnv,
      identity: this.o.identity,
      repoLane: this.lanes.acquire(service.repo.commonDir),
      isGitRunning: this.o.isGitRunning,
      onLocksRemoved: (opId, paths) => this.o.onLocksRemoved?.(id, opId, paths),
    });
    this.repos.set(id, entry);
    // Lazily computed upstream ahead/behind arrived (many tracking branches, spec 02 §6.15.5).
    service.onTrackUpdated(() => {
      if (this.repos.get(id) === entry) this.o.onChanged(id, ['refs'], 'watcher');
    });
    this.scheduleAutoFetch(id, entry);
    this.scheduleIndexRefresh(id, entry);
    this.o.onOpened?.(id);
    if (this.o.watcherBackend) {
      const info = service.repo;
      entry.watcher = new RepoWatcher({
        worktreeRoot: info.worktreeRoot,
        gitDir: info.gitDir,
        commonDir: info.commonDir,
        backend: this.o.watcherBackend,
        onChange: (scopes) => {
          if (scopes.includes('status')) this.scheduleIndexRefresh(id, entry);
          if (scopes.includes('repoState') || scopes.includes('refs')) {
            void service.refreshRepoInfo().catch(() => undefined);
          }
          this.o.onChanged(id, scopes, 'watcher');
        },
        onError: (err) => this.o.onWatchError?.(id, err),
        suspendAfterMs: this.o.suspendWatchAfterMs,
        // first event after a quiet period refreshes at once (spec 02 §9 save → WIP < 500 ms)
        debounce: { leading: true },
      });
      // Not awaited: the repo is usable before the watch is armed. Whatever changed in between is caught
      // by one status refresh once it is (refs / HEAD are re-read by the renderer's first queries anyway).
      const watcher = entry.watcher;
      void watcher.start().then(() => watcher.notify(['status']));
      if (this.activeRepo !== undefined && this.activeRepo !== id) watcher.setActive(false);
    }
    return service.repo;
  }

  async close(repoId: RepoId): Promise<void> {
    const entry = this.repos.get(repoId);
    if (!entry) return;
    if (--entry.refCount > 0) return;
    this.repos.delete(repoId);
    this.o.onClosed?.(repoId);
    if (entry.autoFetch) clearTimeout(entry.autoFetch);
    if (entry.indexRefresh.timer) clearTimeout(entry.indexRefresh.timer);
    entry.queue.dispose();
    this.lanes.release(entry.service.repo.commonDir);
    for (const { cursor } of entry.cursors.values()) cursor.dispose();
    entry.service.dispose();
    await entry.watcher?.dispose();
  }

  /** Every open repository (one per repo tab / worktree). */
  list(): GitService[] {
    return [...this.repos.values()].map((e) => e.service);
  }

  get(repoId: RepoId): GitService {
    const entry = this.repos.get(repoId);
    if (!entry) {
      throw new GitError(
        makeError('NotARepository', { argv: [] }, 'This repository is not open.', { repoId }),
      );
    }
    return entry.service;
  }

  /** Run a mutating op through the repo's queue (spec 02 `git:op:run`). */
  async runOp(repoId: RepoId, op: GitOperation, background = false, signal?: AbortSignal): Promise<OpResult> {
    const entry = this.entry(repoId);
    const prepared = this.o.behaviour
      ? await this.o.behaviour.prepare(entry.service, op).catch(() => ({ op, state: undefined }))
      : { op, state: undefined };
    op = prepared.op;
    const { opId, done } = entry.queue.enqueue(op, { background });
    const onAbort = (): void => void entry.queue.cancel(opId);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const result = await done;
      this.o.onOpFinished?.(opId);
      return this.o.behaviour
        ? await this.o.behaviour.after(repoId, entry.service, op, result, prepared.state).catch(() => result)
        : result;
    } catch (e) {
      const err = e instanceof GitError && this.o.mapError ? this.o.mapError(opId, e) : e;
      this.o.onOpFinished?.(opId, err instanceof GitError ? err.code : 'Unknown');
      throw err;
    } finally {
      // A push/fetch/pull is a point undo can't move past (spec 05), even when it failed half-way.
      // Background auto-fetches are exempt: they only move remote-tracking refs, which no journal entry
      // restores, and an auto-fetch landing between Undo and Redo must not silently drop the redo.
      if (NETWORK_OPS.has(op.type) && !(background && op.type === 'fetch')) entry.journal.barrier(op);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The repo in the focused tab (spec 02 §6.14 "Inactive tabs"): every other open repo keeps its `.git`
   * watch but suspends its worktree watch after 60 s; re-activation resumes it with a status refresh.
   */
  setActiveRepo(repoId: RepoId | null): void {
    this.activeRepo = repoId;
    for (const [id, entry] of this.repos) entry.watcher?.setActive(id === repoId);
  }

  /** How changes are detected for a repo (status-bar warning while polling, spec 02 §6.14). */
  watchMode(repoId: RepoId): WatchMode | 'off' {
    const w = this.repos.get(repoId)?.watcher;
    return w ? w.mode : 'off';
  }

  /** A mutating op is running or queued (auto-fetch skips the tick, spec 09 §6.2). */
  isBusy(repoId: RepoId): boolean {
    return this.repos.get(repoId)?.queue.busy ?? false;
  }

  cancelOp(repoId: RepoId, opId: string): void {
    this.repos.get(repoId)?.queue.cancel(opId);
  }

  journal(repoId: RepoId): UndoJournal {
    return this.entry(repoId).journal;
  }

  /** Re-arm auto-fetch timers after the interval setting changes. */
  rescheduleAutoFetch(): void {
    for (const [id, entry] of this.repos) this.scheduleAutoFetch(id, entry);
  }

  async logStart(repoId: RepoId, query: LogQuery, pageSize: number): Promise<LogPage> {
    const entry = this.entry(repoId);
    const cursor = entry.service.log(query);
    const id = randomUUID();
    entry.cursors.set(id, { cursor, lastUsed: Date.now() });
    return this.page(entry, id, pageSize);
  }

  async logNext(repoId: RepoId, cursorId: string, pageSize: number): Promise<LogPage> {
    const entry = this.entry(repoId);
    if (!entry.cursors.has(cursorId)) {
      throw new GitError(
        makeError('Unknown', { argv: ['log'] }, 'The history cursor expired; reload the graph.'),
      );
    }
    return this.page(entry, cursorId, pageSize);
  }

  logDispose(repoId: RepoId, cursorId: string): void {
    const entry = this.repos.get(repoId);
    const c = entry?.cursors.get(cursorId);
    if (!c) return;
    c.cursor.dispose();
    entry!.cursors.delete(cursorId);
  }

  async disposeAll(): Promise<void> {
    clearInterval(this.sweep);
    for (const w of new Set(this.warm.values())) this.dropWarm(w, true);
    const ids = [...this.repos.keys()];
    for (const id of ids) {
      const e = this.repos.get(id)!;
      e.refCount = 1;
      await this.close(id);
    }
  }

  /** Background `fetch --all` on an interval (spec 09 §6.2); never prompts, failures are quiet. */
  private scheduleAutoFetch(id: RepoId, entry: OpenRepo): void {
    if (entry.autoFetch) clearTimeout(entry.autoFetch);
    entry.autoFetch = null;
    const cfg = this.o.autoFetch?.();
    if (!cfg || cfg.intervalMin <= 0 || entry.service.repo.isBare) return;
    entry.autoFetch = setTimeout(async () => {
      if (!this.repos.has(id)) return;
      const remotes = await entry.service.remotes().catch(() => []);
      if (remotes.length) {
        await this.runOp(
          id,
          { type: 'fetch', remote: 'all', prune: cfg.prune, background: true },
          true,
        ).catch(() => undefined);
      }
      if (this.repos.get(id) === entry) this.scheduleAutoFetch(id, entry);
    }, cfg.intervalMin * 60_000);
    entry.autoFetch.unref?.();
  }

  /**
   * spec 02 §6.15.2: the app's status runs with GIT_OPTIONAL_LOCKS=0 and never writes the fsmonitor token
   * or the untracked cache into the index, so with `core.fsmonitor` / `core.untrackedCache` on, a locking
   * status runs through the queue (background, index class: never alongside our own index ops) a few
   * seconds after open and after worktree changes, at most once per interval.
   */
  private scheduleIndexRefresh(id: RepoId, entry: OpenRepo, delayMs?: number): void {
    const interval = this.o.indexRefreshIntervalMs ?? 5 * 60_000;
    const r = entry.indexRefresh;
    if (interval <= 0 || r.timer || entry.service.repo.isBare) return;
    entry.service.indexCachesEnabled(); // starts the (cached, background) config read
    const delay = delayMs ?? this.o.indexRefreshDelayMs ?? 3000;
    r.timer = setTimeout(
      async () => {
        r.timer = null;
        const enabled = await entry.service.indexCachesEnabledNow().catch(() => false);
        if (this.repos.get(id) !== entry || !enabled || r.timer) return;
        if (entry.queue.busy) return this.scheduleIndexRefresh(id, entry, 10_000);
        r.last = Date.now();
        entry.queue.enqueue({ type: 'index.refresh' }, { background: true }).done.catch(() => undefined);
      },
      Math.max(delay, r.last + interval - Date.now()),
    );
    r.timer.unref?.();
  }

  private entry(repoId: RepoId): OpenRepo {
    this.get(repoId);
    return this.repos.get(repoId)!;
  }

  private async page(entry: OpenRepo, id: string, pageSize: number): Promise<LogPage> {
    const c = entry.cursors.get(id)!;
    c.lastUsed = Date.now();
    const page = await c.cursor.next(pageSize);
    if (page.done) {
      c.cursor.dispose();
      entry.cursors.delete(id);
      return { ...page, cursor: null };
    }
    return { ...page, cursor: id };
  }

  private disposeIdleCursors(): void {
    const cutoff = Date.now() - (this.o.cursorIdleMs ?? 10 * 60_000);
    for (const entry of this.repos.values()) {
      for (const [id, c] of entry.cursors) {
        if (c.lastUsed < cutoff) {
          c.cursor.dispose();
          entry.cursors.delete(id);
        }
      }
    }
  }
}
