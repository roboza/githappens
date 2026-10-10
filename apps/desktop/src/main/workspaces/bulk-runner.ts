import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { GitOperation, RepoId } from '@githappens/git';

import type {
  BulkOpProgress,
  BulkOpRequest,
  BulkRepoState,
  Workspace,
  WorkspaceRepo,
} from '../../shared/ipc/workspaces-contract';
import type { WorkspaceStatus } from './workspace-status';
import { normalizeRemoteUrl } from './util';

export interface CloneJob {
  url: string;
  parentDir: string;
  folderName: string;
  signal: AbortSignal;
  /** 0..1 */
  onProgress(fraction: number | null, text: string): void;
}

export interface BulkRunnerDeps {
  workspace(id: string): Workspace;
  /** Persist a clone / auto-locate result. */
  setRepoPath(workspaceId: string, repoId: string, localPath: string, remoteUrl?: string): void;
  status: Pick<WorkspaceStatus, 'forPath' | 'invalidate' | 'locate' | 'remotes'>;
  /** Open a repo in the RepoManager (ref-counted) so ops go through its OperationQueue. */
  openRepo(path: string): Promise<RepoId>;
  closeRepo(id: RepoId): Promise<void>;
  /** Run an op through the repo's queue; must cancel it when `signal` aborts. */
  runOp(id: RepoId, op: GitOperation, signal: AbortSignal): Promise<unknown>;
  /** `git clone --progress` into parentDir/folderName (removes the partial dir on failure/cancel). */
  clone(job: CloneJob): Promise<{ path: string }>;
  /** HEAD sha of a work tree (pull result messages). */
  headSha(repoPath: string): Promise<string | null>;
  /** Commits in `from..to`. */
  countCommits(repoPath: string, from: string, to: string): Promise<number>;
  /** `workspaces.bulkConcurrency`. */
  concurrency(): number;
  emit(p: BulkOpProgress): void;
}

class Skip extends Error {}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Bulk fetch / pull / clone across a workspace (spec 11 §6.3). Each repo runs independently: a
 * failure is reported on its row and never aborts the batch; cancel aborts running repos and marks
 * the rest `skipped`.
 */
export class BulkRunner {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly d: BulkRunnerDeps) {}

  start(req: BulkOpRequest): { bulkId: string; done: Promise<void> } {
    const ws = this.d.workspace(req.workspaceId);
    if (!['fetch', 'pull', 'clone'].includes(req.op))
      throw new Error(`Unsupported bulk operation: ${req.op}`);
    const wanted = new Set(req.repoIds);
    const repos = ws.repos.filter((r) => wanted.has(r.id));
    if (!repos.length) throw new Error('No repositories selected.');
    const bulkId = randomUUID();
    const controller = new AbortController();
    this.running.set(bulkId, controller);
    const limit = Math.max(
      1,
      Math.min(16, Math.floor(req.options?.concurrency ?? this.d.concurrency()) || 4),
    );
    const done = this.run(bulkId, ws, repos, req, limit, controller.signal).finally(() =>
      this.running.delete(bulkId),
    );
    return { bulkId, done };
  }

  cancel(bulkId: string): void {
    this.running.get(bulkId)?.abort();
  }

  cancelAll(): void {
    for (const c of this.running.values()) c.abort();
  }

  private async run(
    bulkId: string,
    ws: Workspace,
    repos: WorkspaceRepo[],
    req: BulkOpRequest,
    limit: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Let the invoke resolve (with bulkId) before the first events go out.
    await new Promise((r) => setImmediate(r));
    const emit = (repoId: string, state: BulkRepoState, message?: string, progress?: number): void =>
      this.d.emit({
        bulkId,
        workspaceId: ws.id,
        op: req.op,
        repoId,
        state,
        ...(message !== undefined ? { message } : {}),
        ...(progress !== undefined ? { progress } : {}),
      });
    for (const r of repos) emit(r.id, 'queued');
    const claimed = new Set<string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < repos.length) {
        const repo = repos[next++]!;
        if (signal.aborted) {
          emit(repo.id, 'skipped', 'Cancelled');
          continue;
        }
        emit(repo.id, 'running');
        try {
          const message = await this.one(ws, repo, req, signal, claimed, (p, text) =>
            emit(repo.id, 'running', text, p ?? undefined),
          );
          emit(repo.id, 'done', message);
        } catch (e) {
          if (e instanceof Skip) emit(repo.id, 'skipped', e.message);
          else if (signal.aborted) emit(repo.id, 'skipped', 'Cancelled');
          else emit(repo.id, 'failed', e instanceof Error ? e.message : String(e));
        } finally {
          if (repo.localPath) this.d.status.invalidate(repo.localPath);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, repos.length) }, worker));
  }

  private async one(
    ws: Workspace,
    repo: WorkspaceRepo,
    req: BulkOpRequest,
    signal: AbortSignal,
    claimed: Set<string>,
    progress: (p: number | null, text: string) => void,
  ): Promise<string> {
    if (req.op === 'clone') return this.clone(ws, repo, req, signal, claimed, progress);
    if (!repo.localPath || !fs.existsSync(repo.localPath)) throw new Skip('Not cloned');
    if (req.op === 'fetch') {
      await this.withRepo(repo.localPath, (id) =>
        this.d.runOp(id, { type: 'fetch', remote: 'all', prune: true }, signal),
      );
      return 'Fetched';
    }
    return this.pull(repo.localPath, req, signal);
  }

  private async pull(repoPath: string, req: BulkOpRequest, signal: AbortSignal): Promise<string> {
    const st = await this.d.status.forPath(repoPath, true);
    if (st.error) throw new Error(st.error);
    if (st.operationInProgress) throw new Error(`A ${st.operationInProgress} is in progress — open repo`);
    if (st.wip.conflicted) throw new Error('Unresolved conflicts — open repo');
    if (st.head?.detached) throw new Skip('Detached HEAD');
    if (!st.upstream) throw new Skip('No upstream branch');
    const strategy = req.options?.pullMode ?? 'ff-if-possible';
    const before = st.head?.sha || null;
    await this.withRepo(repoPath, (id) =>
      this.d.runOp(
        id,
        { type: 'pull', strategy, ...(req.options?.autostash ? { autostash: true } : {}) },
        signal,
      ),
    );
    const after = await this.d.headSha(repoPath);
    if (!after || after === before) return 'Up to date';
    const n = before ? await this.d.countCommits(repoPath, before, after).catch(() => 0) : 0;
    if (!n) return 'Updated';
    if (strategy === 'rebase') return `Rebased onto ${plural(n, 'new commit')}`;
    return strategy === 'ff-only' ? `Fast-forwarded ${plural(n, 'commit')}` : `Pulled ${plural(n, 'commit')}`;
  }

  private async withRepo<T>(repoPath: string, fn: (id: RepoId) => Promise<T>): Promise<T> {
    const id = await this.d.openRepo(repoPath);
    try {
      return await fn(id);
    } finally {
      await this.d.closeRepo(id).catch(() => undefined);
    }
  }

  private async clone(
    ws: Workspace,
    repo: WorkspaceRepo,
    req: BulkOpRequest,
    signal: AbortSignal,
    claimed: Set<string>,
    progress: (p: number | null, text: string) => void,
  ): Promise<string> {
    if (repo.localPath && fs.existsSync(repo.localPath)) throw new Skip('Already cloned');
    const ssh = req.options?.protocol === 'ssh';
    const url =
      (repo.provider && (ssh ? repo.provider.cloneUrlSsh : repo.provider.cloneUrlHttps)) ||
      repo.provider?.cloneUrlHttps ||
      repo.remoteUrl;
    if (!url) throw new Skip('No remote URL to clone from');
    const root = req.options?.cloneRoot || ws.defaultCloneRoot;
    if (!root) throw new Error('Choose a folder to clone into.');
    const parentDir = path.resolve(root);
    const want = normalizeRemoteUrl(url);

    // `{root}/{name}`; an existing clone of the same remote is located instead, else `{name}-2`, …
    const base = repo.name.replace(/[\\/:*?"<>|\0]/g, '-').trim() || 'repository';
    for (let i = 1; i <= 50; i++) {
      const folderName = i === 1 ? base : `${base}-${i}`;
      const target = path.join(parentDir, folderName);
      const key = target.toLowerCase();
      if (claimed.has(key)) continue;
      if (fs.existsSync(target)) {
        const entries = safeReaddir(target);
        if (entries === null) continue;
        if (entries.length > 0) {
          const loc = await this.d.status.locate(target, signal);
          if (loc && path.resolve(loc.toplevel) === path.resolve(target)) {
            const remotes = await this.d.status.remotes(target, signal).catch(() => []);
            if (remotes.some((r) => normalizeRemoteUrl(r.url) === want)) {
              claimed.add(key);
              this.d.setRepoPath(ws.id, repo.id, target, url);
              return 'Already cloned — located';
            }
          }
          continue;
        }
      }
      claimed.add(key);
      progress(0, 'Cloning…');
      const r = await this.d.clone({
        url,
        parentDir,
        folderName,
        signal,
        onProgress: (p, text) => progress(p, text),
      });
      this.d.setRepoPath(ws.id, repo.id, r.path, url);
      return i === 1 ? 'Cloned' : `Cloned into ${folderName}`;
    }
    throw new Error('No free folder name for this repository.');
  }
}

function safeReaddir(p: string): string[] | null {
  try {
    return fs.readdirSync(p);
  } catch {
    return null;
  }
}
