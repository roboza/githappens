import fs from 'node:fs';
import path from 'node:path';

/**
 * Background `git commit-graph write` (spec 04 §6.2 "Performance", spec 02 §6.15.1, setting
 * `graph.maintainCommitGraph`).
 *
 * - On first graph open: if `objects/info/commit-graph` (or a `commit-graphs/` chain) is missing and the
 *   repository has at least `threshold` commits, write it once.
 * - After history-changing operations (fetch, pull, merge, rebase, …) succeed, refresh it when the repo
 *   already has one or is large, at most once per `minIntervalMs` per repository.
 * - One write at a time app-wide, at background priority, never for bare-less broken repos; failures are
 *   logged and ignored. Turning the setting off cancels nothing already running but stops new writes.
 * - With `write` (the app), the write is a `maintenance.commitGraph` op in the repository's queue: shown
 *   with a Cancel button like other background ops, never blocking user ops, and cleaning up its lock /
 *   temp files when cancelled. A cancelled write is not retried before `minIntervalMs`.
 */

export interface MaintainedRepo {
  /** Working directory to run git in (worktree root, or the git dir for bare repos). */
  cwd: string;
  /** The repository's common git dir (`objects/` lives there). */
  commonDir: string;
  /** Open repository id (the op queue the write goes through). */
  repoId?: string;
}

export interface CommitGraphMaintainerOptions {
  enabled: () => boolean;
  /** Runs git at background priority; resolves with stdout. */
  run: (cwd: string, args: string[]) => Promise<string>;
  /**
   * Writes the commit-graph through the repository's op queue (`maintenance.commitGraph`, cancellable);
   * without it (tests) `run(cwd, WRITE_ARGS)` is used.
   */
  write?: (repo: MaintainedRepo) => Promise<void>;
  threshold?: number;
  minIntervalMs?: number;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

/** Op types after which the commit-graph is refreshed. */
export const COMMIT_GRAPH_REFRESH_OPS: ReadonlySet<string> = new Set([
  'fetch',
  'pull',
  'merge.run',
  'merge.continue',
  'rebase.run',
  'rebase.continue',
  'rebase.interactive',
  'cherryPick.run',
  'revert.run',
  'reset.run',
  'ff.run',
  'fastForwardBranch',
  'pr.checkout',
]);

export const WRITE_ARGS = ['commit-graph', 'write', '--reachable', '--changed-paths'];
const DEFAULT_THRESHOLD = 10_000;

/**
 * Commit count over branches, remotes and tags, stopping at the threshold (spec 02 §6.15.1; never the
 * hidden refs/githappens/*). Unbounded it walks the whole history (≈ 1.4 s for 200k commits).
 */
export const countArgs = (threshold = DEFAULT_THRESHOLD): string[] => [
  'rev-list',
  '--count',
  `--max-count=${threshold}`,
  '--branches',
  '--remotes',
  '--tags',
];
export const COUNT_ARGS = countArgs();

/** True when the repo has a commit-graph file or a split chain. */
export function hasCommitGraph(commonDir: string): boolean {
  const info = path.join(commonDir, 'objects', 'info');
  return (
    fs.existsSync(path.join(info, 'commit-graph')) ||
    fs.existsSync(path.join(info, 'commit-graphs', 'commit-graph-chain'))
  );
}

type Reason = 'open' | 'op';

export class CommitGraphMaintainer {
  private readonly queue: Array<{ repo: MaintainedRepo; reason: Reason }> = [];
  private running: Promise<void> | null = null;
  private readonly lastWrite = new Map<string, number>();
  private readonly checkedOnOpen = new Set<string>();
  /** Completed writes (for tests / diagnostics). */
  writes = 0;

  constructor(private readonly o: CommitGraphMaintainerOptions) {}

  /** First graph open of a repository in this session. */
  onRepoOpened(repo: MaintainedRepo): void {
    const k = key(repo);
    if (this.checkedOnOpen.has(k)) return;
    this.checkedOnOpen.add(k);
    this.enqueue(repo, 'open');
  }

  /** Feed `git:op:state` events; schedules a refresh after successful history-changing ops. */
  onOpState(repo: MaintainedRepo | null | undefined, e: { type: string; state: string }): void {
    if (!repo || e.state !== 'succeeded' || !COMMIT_GRAPH_REFRESH_OPS.has(e.type)) return;
    this.enqueue(repo, 'op');
  }

  /** Resolves when the queue is drained (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private enqueue(repo: MaintainedRepo, reason: Reason): void {
    if (!this.o.enabled()) return;
    if (this.queue.some((q) => key(q.repo) === key(repo))) return;
    this.queue.push({ repo, reason });
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
  }

  private async drain(): Promise<void> {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      try {
        await this.process(job.repo, job.reason);
      } catch (e) {
        this.o.log?.('commit-graph maintenance failed', e);
      }
    }
  }

  private async process(repo: MaintainedRepo, reason: Reason): Promise<void> {
    if (!this.o.enabled()) return;
    const k = key(repo);
    const exists = hasCommitGraph(repo.commonDir);
    if (reason === 'open' && exists) return;
    const now = (this.o.now ?? Date.now)();
    const last = this.lastWrite.get(k);
    if (reason === 'op' && last !== undefined && now - last < (this.o.minIntervalMs ?? 10 * 60_000)) return;
    if (!exists) {
      const threshold = this.o.threshold ?? DEFAULT_THRESHOLD;
      const count = Number((await this.o.run(repo.cwd, countArgs(threshold))).trim());
      if (!Number.isFinite(count) || count < threshold) return;
    }
    try {
      if (this.o.write && repo.repoId) await this.o.write(repo);
      else await this.o.run(repo.cwd, WRITE_ARGS);
    } catch (e) {
      // cancelled by the user: don't start again on the next fetch
      if (isCancelled(e)) this.lastWrite.set(k, now);
      throw e;
    }
    this.lastWrite.set(k, now);
    this.writes++;
  }
}

const key = (r: MaintainedRepo): string => path.resolve(r.commonDir).toLowerCase();

const isCancelled = (e: unknown): boolean =>
  !!e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'Cancelled';
