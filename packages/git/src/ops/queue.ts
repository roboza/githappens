import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GitError, makeError } from '../errors/classify';
import type { GitService } from '../service/git-service';
import type { ProgressEvent, RefreshScope, SerializedGitError } from '../types';
import type { GitOperation, GitOperationType, OperationMeta, OpResult, OpStateEvent, OpOf } from './types';
import { IDENTITY_OPS, identityConfigArgs, readLocalIdentity, type CommitIdentity } from './behaviour';
import { gitProcessRunningIn, recoverLocks, STALE_LOCK_MS, type AsyncMutex } from './locks';

/** What an executor gets for one run of one operation. */
export interface OpContext {
  opId: string;
  service: GitService;
  signal: AbortSignal;
  progress: (p: ProgressEvent) => void;
  /** Path to the askpass shim + per-op token env, when credentials may be needed (spec 02 §6.3). */
  credentialEnv?: () => Record<string, string>;
  /** True for background ops (auto-fetch): never prompt. */
  background: boolean;
  /** `-c key=value` pairs prepended to every command of this op (profile identity, spec 13 §6). */
  identityArgs?: string[];
}

export type OpExecutor<T extends GitOperationType = GitOperationType> = (
  ctx: OpContext,
  op: OpOf<T>,
) => Promise<Omit<OpResult, 'opId'>>;

export interface OpDefinition<T extends GitOperationType = GitOperationType> {
  meta: OperationMeta;
  execute: OpExecutor<T>;
}

export type OpRegistry = { [T in GitOperationType]?: OpDefinition<T> };

/** Undo journal integration (spec 05 §6, spec 02 §6.13 rule 6). */
export interface JournalHooks {
  begin(op: GitOperation, opId: string): Promise<string | null>;
  commit(entryId: string, op: GitOperation, result: Omit<OpResult, 'opId'>): Promise<void>;
  fail(entryId: string, op: GitOperation, error: SerializedGitError): Promise<void>;
}

export interface QueueHooks {
  onState?: (e: OpStateEvent) => void;
  onProgress?: (opId: string, p: ProgressEvent) => void;
  /** Emitted once after each op with its `touches` scopes (watcher is muted meanwhile). */
  onRefresh?: (scopes: RefreshScope[]) => void;
  muteWatcher?: () => void;
  unmuteWatcher?: () => void;
  journal?: JournalHooks;
  credentialEnv?: (opId: string, background: boolean) => Record<string, string>;
  /** Active profile identity; injected as `-c user.*` into commit-creating ops unless repo-local config sets it. */
  identity?: () => CommitIdentity | null | undefined;
  /**
   * The repository's shared lane (one per `commonDir`, see `RepoLanes`): every queue of a linked worktree
   * of the same repository takes it before a ref-mutating op (spec 02 §6.13). Index-only ops skip it.
   */
  repoLane?: AsyncMutex;
  /** "Is a git process working in this repo?" for the stale-lock heuristic (default: best-effort OS scan). */
  isGitRunning?: (dirs: string[]) => Promise<boolean>;
  /** Lock files deleted by post-cancel / post-crash recovery (spec 02 §6.2: logged to the output log). */
  onLocksRemoved?: (opId: string, paths: string[]) => void;
}

export interface EnqueueOptions {
  background?: boolean;
}

/**
 * Queue classes (spec 02 §6.13): `index` ops (stage/unstage) only touch this worktree's index, `fetch`
 * only touches refs / FETCH_HEAD (so it may run alongside index ops), `maintenance` (commit-graph write,
 * spec 02 §6.15.1) touches no refs, index or worktree and runs alongside anything but another maintenance
 * op; everything else is exclusive.
 */
export type OpClass = 'index' | 'fetch' | 'maintenance' | 'exclusive';

/** Background maintenance: never blocks (or is blocked by) user ops, one at a time. */
export const MAINTENANCE_OPS: ReadonlySet<GitOperationType> = new Set<GitOperationType>([
  'maintenance.commitGraph',
]);

export const INDEX_ONLY_OPS: ReadonlySet<GitOperationType> = new Set<GitOperationType>([
  'wip.stage',
  'wip.unstage',
  'wip.stageAll',
  'wip.unstageAll',
  'wip.stageHunk',
  'wip.unstageHunk',
  'wip.stageLines',
  'wip.unstageLines',
  'index.refresh',
]);

/** Background ops that a user op aborts when they are already running (pure cache warming). */
const PREEMPTIBLE: ReadonlySet<GitOperationType> = new Set<GitOperationType>(['index.refresh']);

export function opClass(op: GitOperation): OpClass {
  if (op.type === 'fetch') return 'fetch';
  if (MAINTENANCE_OPS.has(op.type)) return 'maintenance';
  return INDEX_ONLY_OPS.has(op.type) ? 'index' : 'exclusive';
}

/** Two classes that may run at the same time in one worktree. */
const compatible = (a: OpClass, b: OpClass): boolean =>
  (a === 'maintenance') !== (b === 'maintenance') ||
  (a === 'fetch' && b === 'index') ||
  (a === 'index' && b === 'fetch');

interface Job {
  opId: string;
  op: GitOperation;
  def: OpDefinition;
  cls: OpClass;
  background: boolean;
  controller: AbortController;
  resolve: (r: OpResult) => void;
  reject: (e: unknown) => void;
  promise: Promise<OpResult>;
  started: boolean;
  /** The executor (or the lock pre-check) started: past the lane wait. */
  executing: boolean;
  startedAt: number;
}

export interface LockTiming {
  /** A lock younger than this is assumed to belong to a live process: wait for it. */
  fresh: number;
  /** How long to wait for a fresh lock. */
  wait: number;
  poll: number;
  /** Older than this (and no git process found) → `details.stale = 1` (default 60 s). */
  stale?: number;
}

const LOCK_FRESH_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 250;

/** Exit codes of a crashed / killed git (abort, SIGKILL, SIGSEGV; Windows NTSTATUS codes). */
const CRASH_EXIT = (code: number | null): boolean =>
  code !== null && (code < 0 || code > 255 || code === 134 || code === 137 || code === 139);

/**
 * Per-worktree FIFO queue for mutating operations (spec 02 §6.13). Reads never go through it. Exclusive
 * ops run one at a time (and, through the shared `repoLane`, one at a time per repository across linked
 * worktrees), so the app never races itself on `index.lock` or ref locks. A fetch may overlap with
 * index-only ops (stage/unstage).
 */
export class OperationQueue {
  private readonly jobs: Job[] = [];
  private readonly running = new Set<Job>();

  constructor(
    private readonly service: GitService,
    private readonly registry: OpRegistry,
    private readonly hooks: QueueHooks = {},
    private readonly lockTiming: LockTiming = {
      fresh: LOCK_FRESH_MS,
      wait: LOCK_WAIT_MS,
      poll: LOCK_POLL_MS,
    },
  ) {}

  /** Enqueue an op; returns immediately with its id and a completion promise. */
  enqueue(op: GitOperation, o: EnqueueOptions = {}): { opId: string; done: Promise<OpResult> } {
    const def = this.registry[op.type] as OpDefinition | undefined;
    if (!def) {
      const opId = randomUUID();
      return {
        opId,
        done: Promise.reject(
          new GitError(makeError('Unknown', { argv: [] }, `Operation "${op.type}" is not implemented yet.`)),
        ),
      };
    }
    // Coalesce a second fetch of the same remote into the queued/running one (spec 02 §6.13).
    if (op.type === 'fetch') {
      const same = [...this.running, ...this.jobs].find(
        (j) => j.op.type === 'fetch' && j.op.remote === op.remote && !!j.op.prune === !!op.prune,
      );
      if (same) return { opId: same.opId, done: same.promise };
    }
    let resolve!: (r: OpResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<OpResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = {
      opId: randomUUID(),
      op,
      def,
      cls: def.meta.mutating ? opClass(op) : 'index',
      background: !!o.background,
      controller: new AbortController(),
      resolve,
      reject,
      promise,
      started: false,
      executing: false,
      startedAt: 0,
    };
    // Background ops yield to user ops: user ops jump ahead of queued background ones, and an
    // opportunistic op already running (a locking status that only warms caches) is aborted so it
    // never delays the user's action; it is rescheduled later by its owner.
    if (!job.background) {
      const firstBg = this.jobs.findIndex((j) => j.background);
      if (firstBg >= 0) this.jobs.splice(firstBg, 0, job);
      else this.jobs.push(job);
      for (const r of this.running) if (PREEMPTIBLE.has(r.op.type)) r.controller.abort();
    } else this.jobs.push(job);
    this.emit(job, 'queued');
    this.pump();
    return { opId: job.opId, done: promise };
  }

  /** Cancel a queued op immediately, or abort a running cancellable one. */
  cancel(opId: string): boolean {
    const idx = this.jobs.findIndex((j) => j.opId === opId);
    if (idx >= 0) {
      const [job] = this.jobs.splice(idx, 1);
      this.emit(job!, 'cancelled');
      job!.reject(new GitError(makeError('Cancelled', { argv: [], opId })));
      return true;
    }
    const running = [...this.running].find((j) => j.opId === opId);
    // still waiting for the repository lane: nothing has run yet, so any op can be withdrawn
    if (running && (!running.executing || running.def.meta.cancellable)) {
      running.controller.abort();
      return true;
    }
    return false;
  }

  /** A user-relevant op is running or queued (background maintenance does not count). */
  get busy(): boolean {
    for (const j of this.running) if (j.cls !== 'maintenance') return true;
    return this.jobs.some((j) => j.cls !== 'maintenance');
  }

  get pending(): { opId: string; type: GitOperationType; running: boolean }[] {
    return [...this.running, ...this.jobs].map((j) => ({
      opId: j.opId,
      type: j.op.type,
      running: this.running.has(j),
    }));
  }

  /** Reject everything (repo closed). */
  dispose(): void {
    for (const j of this.jobs.splice(0))
      j.reject(new GitError(makeError('Cancelled', { argv: [], opId: j.opId })));
    for (const j of this.running) j.controller.abort();
  }

  // ---------------------------------------------------------------------------

  /** Start the head of the queue while it is compatible with everything running (FIFO, no overtaking). */
  private pump(): void {
    while (this.jobs.length) {
      const head = this.jobs[0]!;
      for (const r of this.running) if (!compatible(r.cls, head.cls)) return;
      this.jobs.shift();
      this.running.add(head);
      head.started = true;
      void this.settle(head);
    }
  }

  private async settle(job: Job): Promise<void> {
    let result: OpResult | undefined;
    let error: unknown;
    let ok = false;
    try {
      result = await this.run(job);
      ok = true;
    } catch (e) {
      error = e;
    }
    this.running.delete(job);
    if (ok) job.resolve(result!);
    else job.reject(error);
    this.pump();
  }

  private async run(job: Job): Promise<OpResult> {
    const { op, def, opId } = job;
    let entryId: string | null = null;
    let releaseLane: (() => void) | null = null;
    let muted = false;
    try {
      const maintenance = job.cls === 'maintenance';
      // Ref-mutating ops serialize per repository (commonDir) across linked worktrees (spec 02 §6.13).
      if (def.meta.mutating && job.cls !== 'index' && !maintenance && this.hooks.repoLane) {
        releaseLane = await this.hooks.repoLane.lock(job.controller.signal).catch(() => {
          throw new GitError(makeError('Cancelled', { argv: [], opId }));
        });
      }
      job.executing = true;
      job.startedAt = Date.now();
      this.emit(job, 'running');
      // maintenance changes nothing the watcher reports (objects/ is ignored): keep it live, no refresh
      if (!maintenance) {
        this.hooks.muteWatcher?.();
        muted = true;
      }
      if (def.meta.mutating && !maintenance) await this.lockPreCheck(job);
      if (def.meta.undoable && this.hooks.journal) entryId = await this.hooks.journal.begin(op, opId);
      const ctx: OpContext = {
        opId,
        service: this.service,
        signal: job.controller.signal,
        progress: (p) => this.hooks.onProgress?.(opId, p),
        credentialEnv: def.meta.network
          ? () => this.hooks.credentialEnv?.(opId, job.background) ?? {}
          : undefined,
        background: job.background,
      };
      if (this.hooks.identity && IDENTITY_OPS.has(op.type)) {
        const profile = this.hooks.identity();
        if (profile?.name || profile?.email) {
          const local = await readLocalIdentity(this.service).catch(() => ({}));
          ctx.identityArgs = identityConfigArgs(profile, local);
        }
      }
      const result = await def.execute(ctx, op as never);
      if (entryId && this.hooks.journal) await this.hooks.journal.commit(entryId, op, result);
      this.emit(job, 'succeeded');
      return { ...result, opId };
    } catch (e) {
      const err =
        e instanceof GitError
          ? e
          : new GitError(
              makeError('Unknown', { argv: [], opId }, e instanceof Error ? e.message : String(e)),
            );
      if (!err.serialized.opId) err.serialized.opId = opId;
      if (job.executing && def.meta.mutating && job.cls !== 'maintenance' && this.needsRecovery(err))
        await this.recover(job);
      if (entryId && this.hooks.journal)
        await this.hooks.journal.fail(entryId, op, err.serialized).catch(() => undefined);
      this.emit(job, err.code === 'Cancelled' ? 'cancelled' : 'failed', err.serialized);
      throw err;
    } finally {
      releaseLane?.();
      if (muted) {
        this.hooks.unmuteWatcher?.();
        // Always refresh status as well: an op can leave the worktree in any state (spec 02 §6.13 rule 2).
        const scopes = new Set<RefreshScope>([...def.meta.touches, 'status']);
        this.hooks.onRefresh?.([...scopes]);
      }
    }
  }

  private needsRecovery(err: GitError): boolean {
    return err.code === 'Cancelled' || err.code === 'Timeout' || CRASH_EXIT(err.serialized.exitCode);
  }

  /**
   * spec 02 §6.2 step 4: after a cancel (or a crashed git) delete lock files our processes created
   * (mtime ≥ op start). `index.lock` is left alone while another op of ours may hold it.
   */
  private async recover(job: Job): Promise<void> {
    const { gitDir, commonDir } = this.dirs();
    let removed: string[];
    if (job.cls === 'index') {
      removed = await recoverIndexLock(gitDir, job.startedAt);
    } else {
      const indexBusy = [...this.running].some((r) => r !== job && r.cls === 'index');
      removed = await recoverLocks({ gitDir, commonDir, since: job.startedAt, skipIndex: indexBusy });
    }
    if (removed.length) this.hooks.onLocksRemoved?.(job.opId, removed);
  }

  private dirs(): { gitDir: string; commonDir: string; worktreeRoot: string | null } {
    const repo = this.service.repo;
    return {
      gitDir: repo.gitDir,
      commonDir: repo.commonDir ?? repo.gitDir,
      worktreeRoot: repo.worktreeRoot ?? null,
    };
  }

  /** Lock files checked before an op (spec 02 §6.13 rule 3). */
  private locksFor(job: Job): { path: string; code: 'IndexLocked' | 'RefLocked' }[] {
    const { gitDir, commonDir } = this.dirs();
    if (job.cls === 'fetch') return []; // touches neither the index nor HEAD
    const out: { path: string; code: 'IndexLocked' | 'RefLocked' }[] = [
      { path: path.join(gitDir, 'index.lock'), code: 'IndexLocked' },
    ];
    if (job.cls === 'exclusive') out.push({ path: path.join(gitDir, 'HEAD.lock'), code: 'RefLocked' });
    if (job.op.type === 'config.set' && job.op.scope !== 'global') {
      out.push({
        path:
          job.op.scope === 'worktree'
            ? path.join(gitDir, 'config.worktree.lock')
            : path.join(commonDir, 'config.lock'),
        code: 'RefLocked',
      });
    }
    return out;
  }

  /**
   * spec 02 §6.13 rule 3: a lock younger than 10 s → poll every 250 ms for up to 5 s (another git process
   * is likely active); still present or older → fail fast with `IndexLocked` / `RefLocked`,
   * `details.lockPath`, `details.ageSec` and `details.stale` (age > 60 s and no git process in the repo).
   */
  private async lockPreCheck(job: Job): Promise<void> {
    const locks = this.locksFor(job);
    if (!locks.length) return;
    const t = this.lockTiming;
    const deadline = Date.now() + t.wait;
    let waiting = false;
    for (;;) {
      let found: { path: string; code: 'IndexLocked' | 'RefLocked'; ageMs: number } | null = null;
      for (const l of locks) {
        try {
          const st = await fs.promises.stat(l.path);
          found = { ...l, ageMs: Math.max(0, Date.now() - st.mtimeMs) };
          break;
        } catch {
          /* no lock */
        }
      }
      if (!found) return;
      if ((!waiting && found.ageMs >= t.fresh) || Date.now() >= deadline) {
        throw new GitError(
          makeError(
            found.code,
            { argv: [], opId: job.opId },
            `Another Git process is using this repository (${path.basename(found.path)} exists).`,
            {
              lockPath: found.path,
              ageSec: Math.round(found.ageMs / 1000),
              stale: (await this.isStale(found.ageMs)) ? 1 : 0,
            },
          ),
        );
      }
      waiting = true;
      if (job.controller.signal.aborted)
        throw new GitError(makeError('Cancelled', { argv: [], opId: job.opId }));
      await new Promise((r) => setTimeout(r, t.poll));
    }
  }

  private async isStale(ageMs: number): Promise<boolean> {
    if (ageMs <= (this.lockTiming.stale ?? STALE_LOCK_MS)) return false;
    const { gitDir, commonDir, worktreeRoot } = this.dirs();
    const dirs = [gitDir, commonDir, ...(worktreeRoot ? [worktreeRoot] : [])];
    const running = await (this.hooks.isGitRunning ?? gitProcessRunningIn)(dirs).catch(() => false);
    return !running;
  }

  private emit(job: Job, state: OpStateEvent['state'], error?: SerializedGitError): void {
    this.hooks.onState?.({
      opId: job.opId,
      type: job.op.type,
      label: job.def.meta.label(job.op),
      state,
      ...(error ? { error } : {}),
    });
  }
}

/** Remove `index.lock` if it was created at or after `since` (an index-only op was cancelled). */
async function recoverIndexLock(gitDir: string, since: number): Promise<string[]> {
  const p = path.join(gitDir, 'index.lock');
  try {
    const st = await fs.promises.stat(p);
    if (st.mtimeMs < Math.floor(since / 1000) * 1000) return [];
    await fs.promises.rm(p, { force: true });
    return [p];
  } catch {
    return [];
  }
}
