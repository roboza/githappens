import fs from 'node:fs';
import path from 'node:path';

import { parseStatusV2, type GitProcessRunner } from '@githappens/git';

import type {
  BranchTrack,
  OperationInProgress,
  RepoStatusSummary,
  WorkspaceRepo,
  WorkspaceRepoDetails,
} from '../../shared/ipc/workspaces-contract';
import { canonicalPath } from '../services/canonical-path';
import { mapLimit, pathKey } from './util';

/** Spec 11 §6.1: read-only, ≤ 6 repos at once, 5 s per repo. */
export const STATUS_CONCURRENCY = 6;
export const STATUS_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 3000;

type Summary = Omit<RepoStatusSummary, 'workspaceRepoId' | 'localPath'>;

const EMPTY_WIP = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };

const OP_MARKERS: Array<[string, OperationInProgress]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

export interface RepoLocation {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

/** `[ahead 1, behind 2]` / `[gone]` / `` → counts. */
export function parseTrack(track: string, upstream?: string): BranchTrack {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ...(upstream ? { upstream } : {}),
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.includes('gone'),
  };
}

/** Counts porcelain-v2 entries into the overview's WIP buckets. */
export function countWip(entries: ReturnType<typeof parseStatusV2>['entries']): RepoStatusSummary['wip'] {
  const wip = { ...EMPTY_WIP };
  for (const e of entries) {
    if (e.kind === 'ordinary' || e.kind === 'renamed') {
      if (e.index !== '.') wip.staged++;
      if (e.worktree !== '.') wip.unstaged++;
    } else if (e.kind === 'unmerged') wip.conflicted++;
    else if (e.kind === 'untracked') wip.untracked++;
  }
  return wip;
}

/**
 * Workspace overview status (spec 11 §5.5 WorkspaceStatus, §6.1). Uses the git runner directly
 * (no GitService / watcher) so closed repos cost nothing but a few read-only commands. Results
 * are cached by realpath so a repo shared by several workspaces is computed once.
 */
export class WorkspaceStatus {
  private readonly cache = new Map<string, { at: number; summary: Promise<Summary> }>();

  constructor(
    private readonly runner: () => GitProcessRunner,
    private readonly timeoutMs = STATUS_TIMEOUT_MS,
  ) {}

  async forRepos(repos: WorkspaceRepo[], force = false): Promise<RepoStatusSummary[]> {
    return mapLimit(repos, STATUS_CONCURRENCY, async (r) => {
      const base = { workspaceRepoId: r.id, ...(r.localPath ? { localPath: r.localPath } : {}) };
      if (!r.localPath) return { ...base, ...notCloned() };
      return { ...base, ...(await this.forPath(r.localPath, force)) };
    });
  }

  forPath(p: string, force = false): Promise<Summary> {
    const key = pathKey(p);
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.summary;
    const summary = this.compute(p);
    this.cache.set(key, { at: Date.now(), summary });
    // Failed computations are summaries too (`error`), so nothing to evict on rejection.
    return summary;
  }

  invalidate(p?: string): void {
    if (p === undefined) this.cache.clear();
    else this.cache.delete(pathKey(p));
  }

  /** `rev-parse` → toplevel + git dirs, or null when `p` is not inside a work tree. */
  async locate(p: string, signal?: AbortSignal): Promise<RepoLocation | null> {
    try {
      const r = await this.runner().run({
        cwd: p,
        args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
        readOnly: true,
        signal,
        timeoutMs: this.timeoutMs,
      });
      const [toplevel, gitDir, commonDir] = r.stdout.split(/\r?\n/);
      if (!toplevel || !gitDir) return null;
      return {
        toplevel: canonicalPath(toplevel),
        gitDir: path.resolve(gitDir),
        commonDir: path.resolve(p, commonDir || gitDir),
      };
    } catch (e) {
      if (signal?.aborted) throw e;
      return null;
    }
  }

  /** `remote -> url` for every configured remote. */
  async remotes(p: string, signal?: AbortSignal): Promise<Array<{ name: string; url: string }>> {
    const r = await this.runner().run({
      cwd: p,
      args: ['config', '--get-regexp', '^remote\\..*\\.url$'],
      readOnly: true,
      expectedExitCodes: [0, 1],
      signal,
      timeoutMs: this.timeoutMs,
    });
    const out: Array<{ name: string; url: string }> = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
      if (m) out.push({ name: m[1]!, url: m[2]! });
    }
    return out;
  }

  /** Local branches with upstream tracking (Branches tab, `for-each-ref`, spec 11 §7 step 17). */
  async branches(p: string): Promise<WorkspaceRepoDetails['branches']> {
    const r = await this.runner().run({
      cwd: p,
      args: [
        'for-each-ref',
        '--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)',
        'refs/heads',
      ],
      readOnly: true,
      timeoutMs: this.timeoutMs,
    });
    return r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [head, name, upstream, track] = line.split('\0');
        return { name: name!, current: head === '*', ...parseTrack(track ?? '', upstream || undefined) };
      });
  }

  async details(p: string): Promise<WorkspaceRepoDetails> {
    const [branches, log] = await Promise.all([
      this.branches(p),
      this.runner()
        .run({
          cwd: p,
          args: ['log', '-3', '--format=%H%x00%s%x00%an%x00%ct', 'HEAD', '--'],
          readOnly: true,
          timeoutMs: this.timeoutMs,
        })
        .catch(() => ({ stdout: '' })),
    ]);
    const commits = log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, author, date] = line.split('\0');
        return { sha: sha!, subject: subject ?? '', author: author ?? '', date: Number(date) || 0 };
      });
    return { branches, commits };
  }

  private async compute(p: string): Promise<Summary> {
    if (!fs.existsSync(p)) return { ...notCloned(), error: 'Folder not found' };
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const loc = await this.locate(p, signal);
      if (!loc) return { ...notCloned(), exists: true, error: 'Not a git repository' };
      const r = await this.runner().run({
        cwd: p,
        args: ['status', '--porcelain=v2', '--branch', '--show-stash', '-z'],
        readOnly: true,
        signal,
        timeoutMs: this.timeoutMs,
      });
      const st = parseStatusV2(r.stdout);
      let stashCount = st.stashCount;
      // git < 2.35 has no `# stash` header; fall back to the stash reflog.
      if (
        !/(^|\0)# stash /.test(r.stdout) &&
        fs.existsSync(path.join(loc.commonDir, 'logs', 'refs', 'stash'))
      ) {
        const c = await this.runner()
          .run({
            cwd: p,
            args: ['rev-list', '--walk-reflogs', '--count', 'refs/stash'],
            readOnly: true,
            signal,
          })
          .catch(() => null);
        stashCount = Number(c?.stdout.trim()) || 0;
      }
      const summary: Summary = {
        exists: true,
        isRepo: true,
        head: {
          ...(st.branch.head ? { branch: st.branch.head } : {}),
          detached: !st.branch.head,
          sha: st.branch.oid ?? '',
        },
        ahead: st.branch.ahead ?? 0,
        behind: st.branch.behind ?? 0,
        wip: countWip(st.entries),
        stashCount,
      };
      if (st.branch.upstream) summary.upstream = st.branch.upstream;
      const op = OP_MARKERS.find(([f]) => fs.existsSync(path.join(loc.gitDir, f)));
      if (op) summary.operationInProgress = op[1];
      try {
        summary.lastFetchAt = fs.statSync(path.join(loc.gitDir, 'FETCH_HEAD')).mtime.toISOString();
      } catch {
        /* never fetched */
      }
      return summary;
    } catch (e) {
      return {
        ...notCloned(),
        exists: true,
        isRepo: true,
        error: signal.aborted ? 'Status timed out' : e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function notCloned(): Summary {
  return { exists: false, isRepo: false, ahead: 0, behind: 0, wip: { ...EMPTY_WIP }, stashCount: 0 };
}
