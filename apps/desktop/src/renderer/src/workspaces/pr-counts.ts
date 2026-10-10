import type { OpenPrCounts } from '@githappens/launchpad';

import type { RepoStatusSummary } from '../../../shared/ipc/workspaces-contract';

/**
 * Fill `RepoStatusSummary.openPrs` from the Launchpad's per-repo counts (spec 11 §4.1 / §5.1).
 * Repos without provider data keep `openPrs` undefined (shown as "—"); with complete data
 * (team listing loaded) a repo without PRs gets zeros.
 */
export function withPrCounts(
  summaries: readonly RepoStatusSummary[],
  counts: Record<string, OpenPrCounts> | undefined,
  complete = false,
): RepoStatusSummary[] {
  if (!counts) return [...summaries];
  return summaries.map((s) => {
    const c = counts[s.workspaceRepoId];
    if (c) return { ...s, openPrs: { ...c } };
    return complete ? { ...s, openPrs: { mine: 0, total: 0, needsMyReview: 0 } } : s;
  });
}

/** "N open PRs" chip text; null when there is nothing to show. */
export function openPrsChip(total: number, needsMyReview: number): string | null {
  if (total <= 0) return null;
  const base = `${total} open PR${total === 1 ? '' : 's'}`;
  return needsMyReview > 0
    ? `${base} · ${needsMyReview} need${needsMyReview === 1 ? 's' : ''} your review`
    : base;
}

/** Overview cell: "mine / total" (+ review marker), or "—" when unknown. */
export function prCell(p: RepoStatusSummary['openPrs']): { text: string; title: string } {
  if (!p) return { text: '—', title: 'No pull request data for this repository' };
  return {
    text: `${p.mine} / ${p.total}`,
    title: `${p.mine} mine · ${p.total} open${p.needsMyReview ? ` · ${p.needsMyReview} need your review` : ''}`,
  };
}
