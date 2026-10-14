import type { RepoStatusSummary, WorkspaceRepo } from '../../../shared/ipc/workspaces-contract';

export interface PushPlanItem {
  repo: WorkspaceRepo;
  branch: string;
  /** `origin/main`; for a new branch the remote it will be published to. */
  target: string;
  /** Commits ahead; null for a branch published for the first time. */
  commits: number | null;
}

/**
 * What a bulk push will do, for the confirmation dialog. Mirrors the BulkRunner's rules: the current
 * branch only, never forced; nothing to push, behind/diverged, detached or mid-operation repos are
 * skipped; branches without an upstream only with `setUpstream` (published to `origin`).
 */
export function planPush(
  repos: WorkspaceRepo[],
  statuses: Map<string, RepoStatusSummary>,
  setUpstream: boolean,
): { items: PushPlanItem[]; skipped: number } {
  const items: PushPlanItem[] = [];
  for (const repo of repos) {
    const st = statuses.get(repo.id);
    const branch = st?.head?.branch;
    if (!st?.exists || !branch || st.head?.detached || st.operationInProgress) continue;
    if (st.upstream) {
      if (st.ahead > 0 && st.behind === 0)
        items.push({ repo, branch, target: st.upstream, commits: st.ahead });
    } else if (setUpstream) {
      items.push({ repo, branch, target: `origin/${branch}`, commits: null });
    }
  }
  return { items, skipped: repos.length - items.length };
}
