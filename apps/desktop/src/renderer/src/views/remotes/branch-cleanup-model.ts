import type { GitOperation } from '@githappens/git/ops';
import type { BranchCleanupCandidate, BranchCleanupReason } from '@githappens/git/types';

/** "Clean up branches" dialog model (spec 05 §6.13): groups, default selection and the delete op. */

export type CleanupGroupId = 'merged' | 'gone';

export interface CleanupGroup {
  id: CleanupGroupId;
  title: string;
  hint: string;
  /** Checked when the dialog opens: only work that is already in the base branch. */
  preselected: boolean;
  items: BranchCleanupCandidate[];
}

export const REASON_LABEL: Record<BranchCleanupReason, string> = {
  merged: 'merged',
  'squash-merged': 'squash-merged',
  'rebase-merged': 'rebase-merged',
  'upstream-gone': 'remote deleted',
};

export function groupCandidates(candidates: readonly BranchCleanupCandidate[], base: string): CleanupGroup[] {
  const merged = candidates.filter((c) => c.reason !== 'upstream-gone');
  const gone = candidates.filter((c) => c.reason === 'upstream-gone');
  return [
    {
      id: 'merged' as const,
      title: 'Merged',
      hint: `Their work is already in ${base}`,
      preselected: true,
      items: merged,
    },
    {
      id: 'gone' as const,
      title: 'Remote deleted, not merged',
      hint: `May contain work that is not in ${base}`,
      preselected: false,
      items: gone,
    },
  ].filter((g) => g.items.length);
}

export function defaultSelection(groups: readonly CleanupGroup[]): Set<string> {
  return new Set(groups.filter((g) => g.preselected).flatMap((g) => g.items.map((c) => c.name)));
}

/** Selected branches with commits not found in the base (the dialog warns before deleting them). */
export function unmergedSelected(
  candidates: readonly BranchCleanupCandidate[],
  selected: ReadonlySet<string>,
): BranchCleanupCandidate[] {
  return candidates.filter((c) => selected.has(c.name) && c.reason === 'upstream-gone');
}

/**
 * Local-only delete. `force` because squash-merged and remote-deleted branches fail `git branch -d`;
 * `expectedSha` keeps any branch that moved since the scan.
 */
export function cleanupOp(
  candidates: readonly BranchCleanupCandidate[],
  selected: ReadonlySet<string>,
): Extract<GitOperation, { type: 'branch.delete' }> {
  return {
    type: 'branch.delete',
    branches: candidates
      .filter((c) => selected.has(c.name))
      .map((c) => ({ name: c.name, expectedSha: c.sha })),
    force: true,
  };
}
