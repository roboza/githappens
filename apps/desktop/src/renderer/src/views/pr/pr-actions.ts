import type { RepoId } from '@githappens/git/types';
import type { PullRequest, RepoRef } from '@githappens/providers/types';

import type { MenuEntry } from '../../components/ContextMenu';
import { choose, confirm } from '../../components/Dialogs';
import { runOp } from '../../lib/ops';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useToastStore } from '../../stores/toasts';
import { copyText, errorLine, intInvoke, openExternal } from '../../integrations/api';

/** Open the PR center view (spec 10 §4.7) in the repo tab. */
export function openPullRequestView(repoId: RepoId, ref: RepoRef, number: number): void {
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'pr', ref, number } }));
}

export function closePullRequestView(repoId: RepoId): void {
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'graph' } }));
}

const toast = useToastStore.getState;

const sameRepo = (a: { owner: string; name: string }, b: { owner: string; name: string }): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/**
 * Cross-repo PR whose fork isn't a remote yet: offer "Add remote `owner`" (spec 10 §6.3 step 2) so the
 * branch tracks the fork. Returns false when the user cancelled.
 */
export async function ensureForkRemote(repoId: RepoId, pr: PullRequest): Promise<boolean> {
  const head = pr.head.repo;
  if (!pr.isCrossRepository || !head || !pr.head.repoCloneUrl) return true;
  const remotes = await intInvoke('provider:resolveRemotes', { repoId }).catch(() => []);
  if (remotes.some((r) => r.ref && sameRepo(r.ref, head))) return true;
  const taken = new Set(remotes.map((r) => r.remote));
  let name = head.owner;
  for (let i = 2; taken.has(name); i++) name = `${head.owner}-${i}`;
  const r = await choose({
    title: `PR #${pr.number} comes from ${head.owner}/${head.name}`,
    message: `Add the fork as remote "${name}" so the branch can track it, or check out the pull request ref only.`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'ref', label: 'Use PR ref only' },
      { value: 'add', label: `Add remote ${name}`, primary: true },
    ],
  });
  if (!r || r.value === 'cancel') return false;
  if (r.value === 'add') {
    const ok = await runOp(
      repoId,
      { type: 'remote.add', name, fetchUrl: pr.head.repoCloneUrl, fetchAfter: false },
      { successToast: `Added remote ${name}` },
    ).catch(() => null);
    if (!ok) return false;
  }
  return true;
}

/**
 * Fetch the PR head and check it out (spec 10 §6.3): as a local branch, or in a new worktree
 * (`../<repo>.worktrees/pr-<n>`).
 */
export async function checkoutPullRequest(
  repoId: RepoId,
  pr: PullRequest,
  mode: 'branch' | 'worktree' = 'branch',
): Promise<void> {
  if (!(await ensureForkRemote(repoId, pr))) return;
  const id = toast().push({ kind: 'progress', title: `Checking out PR #${pr.number}…` });
  try {
    const r = await intInvoke('pr:checkout', { repoId, pr, mode });
    toast().dismiss(id);
    toast().push({
      kind: 'success',
      title: r.path ? `Checked out ${r.branch} in a new worktree` : `Checked out ${r.branch}`,
      body: r.path,
    });
  } catch (e) {
    toast().dismiss(id);
    toast().push({ kind: 'error', title: `Could not check out PR #${pr.number}`, body: errorLine(e) });
  }
}

export async function closePullRequest(pr: PullRequest, after?: () => void): Promise<void> {
  if (!(await confirm(`Close PR #${pr.number}?`, pr.title, 'Close pull request', true))) return;
  try {
    await intInvoke('pr:close', { ref: pr.repo, number: pr.number });
    toast().push({ kind: 'success', title: `Closed PR #${pr.number}` });
    after?.();
  } catch (e) {
    toast().push({ kind: 'error', title: `Could not close PR #${pr.number}`, body: errorLine(e) });
  }
}

export async function reopenPullRequest(pr: PullRequest, after?: () => void): Promise<void> {
  try {
    await intInvoke('pr:reopen', { ref: pr.repo, number: pr.number });
    toast().push({ kind: 'success', title: `Reopened PR #${pr.number}` });
    after?.();
  } catch (e) {
    toast().push({ kind: 'error', title: `Could not reopen PR #${pr.number}`, body: errorLine(e) });
  }
}

/** Draft ↔ ready for review. */
export async function setPullRequestDraft(
  pr: PullRequest,
  draft: boolean,
  after?: () => void,
): Promise<void> {
  try {
    await intInvoke('pr:setDraft', { ref: pr.repo, number: pr.number, draft });
    toast().push({
      kind: 'success',
      title: draft ? `Converted #${pr.number} to draft` : `#${pr.number} is ready for review`,
    });
    after?.();
  } catch (e) {
    toast().push({ kind: 'error', title: `Could not update PR #${pr.number}`, body: errorLine(e) });
  }
}

/** Context menu for a PR row (spec 10 §4.5). */
export function prMenu(repoId: RepoId, pr: PullRequest, refresh: () => void): MenuEntry[] {
  const open = pr.state === 'open' || pr.state === 'draft';
  const canFetch = open || !!pr.head.repo;
  return [
    { label: 'Open', onSelect: () => openPullRequestView(repoId, pr.repo, pr.number) },
    { label: 'Open in browser', onSelect: () => openExternal(pr.webUrl) },
    'separator',
    {
      label: 'Checkout',
      disabled: !canFetch,
      onSelect: () => void checkoutPullRequest(repoId, pr),
    },
    {
      label: 'Checkout in new worktree',
      disabled: !canFetch,
      onSelect: () => void checkoutPullRequest(repoId, pr, 'worktree'),
    },
    'separator',
    { label: 'Copy link', onSelect: () => copyText(pr.webUrl) },
    { label: 'Copy number', onSelect: () => copyText(`#${pr.number}`) },
    'separator',
    {
      label: 'Merge…',
      disabled: !open || !pr.viewer.canMerge,
      title: pr.viewer.canMerge ? undefined : 'You do not have permission to merge',
      onSelect: () => openPullRequestView(repoId, pr.repo, pr.number),
    },
    pr.state === 'closed'
      ? {
          label: 'Reopen pull request',
          disabled: !pr.viewer.canEdit,
          onSelect: () => void reopenPullRequest(pr, refresh),
        }
      : {
          label: 'Close pull request…',
          danger: true,
          disabled: !open || !pr.viewer.canEdit,
          onSelect: () => void closePullRequest(pr, refresh),
        },
  ];
}
