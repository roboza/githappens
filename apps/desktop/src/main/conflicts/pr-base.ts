import type { RepoId } from '@githappens/git';
import type { PrFilter, PrIndexEntry, PullRequest } from '@githappens/providers';

/** The slice of IntegrationService the conflict check uses (spec 10 PrIndex). */
export interface PrSource {
  prIndex(repoId: RepoId): Promise<PrIndexEntry[]>;
  listPullRequests(repoId: RepoId, filter: PrFilter): Promise<PullRequest[]>;
}

const TTL_MS = 5 * 60_000;

/**
 * PR base of a branch with an open PR: the (cached, shared) PrIndex says whether the branch has one;
 * only then the open PR list is read (cached 5 min per repo) for its base branch.
 */
export function createPrBaseLookup(src: PrSource, now: () => number = Date.now) {
  const cache = new Map<RepoId, { at: number; prs: PullRequest[] }>();
  return async (repoId: RepoId, branch: string): Promise<{ remote: string; branch: string } | null> => {
    const index = await src.prIndex(repoId).catch(() => [] as PrIndexEntry[]);
    const entry = index.find((e) => e.branch === branch && (e.pr.state === 'open' || e.pr.state === 'draft'));
    if (!entry) return null;
    let hit = cache.get(repoId);
    if (!hit || now() - hit.at > TTL_MS || !hit.prs.some((p) => p.number === entry.pr.number)) {
      const prs = await src.listPullRequests(repoId, { preset: 'all', state: 'open' }).catch(() => null);
      if (!prs) return null;
      hit = { at: now(), prs };
      cache.set(repoId, hit);
    }
    const pr = hit.prs.find((p) => p.number === entry.pr.number && p.head.branch === branch);
    return pr?.base.branch ? { remote: entry.remote, branch: pr.base.branch } : null;
  };
}
