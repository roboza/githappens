import type { CommitSummary, DiffSpec, RepoId, Sha } from '@githappens/git/types';

import { shortSha } from '../../lib/format';
import { useRepoUiStore } from '../../stores/repo-ui';

/** Range `to` sentinel for the working tree (GitService `WORKTREE_REV`). */
export const WORKTREE_TO = ':worktree';

export const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const;

const label = (rev: string): string =>
  rev === WORKTREE_TO ? 'Working directory' : /^[0-9a-f]{40,64}$/i.test(rev) ? shortSha(rev) : rev;

/**
 * Open the comparison of two refs/commits in the center area (spec 07 §4.8 "Compare `X` with `B`"): a file
 * list plus the diff of the selected file, with swap and two-dot / three-dot toggles. `b` may be
 * `':worktree'` (commit vs working directory). Exported for ref/commit context menus.
 */
export function compareRefs(repoId: RepoId, a: string, b: string, o: { threeDot?: boolean } = {}): void {
  const threeDot = b === WORKTREE_TO ? false : (o.threeDot ?? true);
  useRepoUiStore.getState().update(repoId, () => ({
    center: {
      kind: 'diff',
      spec: { kind: 'range', from: a, to: b, threeDot },
      path: '',
      title: `${label(a)} ↔ ${label(b)}`,
      oldRev: a,
      newRev: b === WORKTREE_TO ? 'WORKTREE' : b,
    },
  }));
}

/** "Compare commit against working directory" (spec 07 §2.1, §4.8). */
export function compareWithWorkingDir(repoId: RepoId, rev: string): void {
  compareRefs(repoId, rev, WORKTREE_TO);
}

/**
 * Order selected commits oldest → newest and check that they form one first-parent chain (spec 07 §2.1:
 * a contiguous range gives the combined changes). Returns null when they don't.
 */
export function contiguousRange(
  commits: Pick<CommitSummary, 'sha' | 'parents' | 'commitTime'>[],
): Sha[] | null {
  if (commits.length < 2) return null;
  const byParent = new Map<Sha, Pick<CommitSummary, 'sha' | 'parents'>>();
  const shas = new Set(commits.map((c) => c.sha));
  for (const c of commits) if (c.parents[0] && shas.has(c.parents[0])) byParent.set(c.parents[0], c);
  // the oldest is the one whose first parent is not selected
  const roots = commits.filter((c) => !c.parents[0] || !shas.has(c.parents[0]));
  if (roots.length !== 1) return null;
  const order: Sha[] = [roots[0]!.sha];
  for (let next = byParent.get(order[0]!); next; next = byParent.get(next.sha)) order.push(next.sha);
  return order.length === commits.length ? order : null;
}

/** Diff spec for the combined changes of `oldest..newest` (`oldest^` or the empty tree for a root). */
export function rangeSpec(
  oldestParent: Sha | undefined,
  newest: Sha,
  objectFormat: 'sha1' | 'sha256',
): DiffSpec {
  return { kind: 'range', from: oldestParent ?? EMPTY_TREE[objectFormat], to: newest };
}
