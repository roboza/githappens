import { isRawPathKey, shownPath, type CheckoutTarget } from '@githappens/git/ops';
import type { RefInfo, RepoId, Sha, StashEntry } from '@githappens/git/types';

import type { MenuEntry, MenuItem } from '../components/ContextMenu';
import { openCompose, openExplain } from '../ai/actions';
import { aiEnabled } from '../ai/hooks';
import { shareCommit, shareMenuItem, shareStash, shareWip } from '../cloud-patches/actions';
import { intInvoke } from '../integrations/api';
import { invoke } from '../lib/api';
import { shortSha } from '../lib/format';
import { useRepoUiStore } from '../stores/repo-ui';
import { useToastStore } from '../stores/toasts';
import { fileToolsMenu, type FileDiffContext } from '../tools/menus';
import { commitFileMenuItems } from '../views/diff/file-actions';
import { withConflictPrediction } from '../views/merge/prediction';
import { openCreatePullRequest } from '../views/pr/CreatePullRequest';
import { pushBranch, setUpstreamFor } from '../views/remotes/branch-actions';
import { openCreateWorktree } from '../views/remotes/dialog-store';
import { stashVisibilityItems, visibilityMenuItems } from '../views/graph/visibility-ui';
import { issueMenuItems } from '../views/issues/IssueHost';
import {
  checkout,
  createBranch,
  createTag,
  deleteBranch,
  deleteRemoteBranch,
  deleteTag,
  discardAll,
  fetchAll,
  pull,
  push,
  pushTag,
  renameBranch,
  cherryPick,
  fastForward,
  interactiveRebase,
  merge,
  rebase,
  reset,
  revert,
  stashApply,
  stashDrop,
  stashPop,
  stashSave,
} from './git-actions';
import {
  copyLink,
  mergeWithOptions,
  moveBranchHere,
  rebaseCommitsOnto,
  renameRemoteBranch,
  stashExtraMenuItems,
  stashWithOptions,
} from '../views/ops/branching-actions';

/** Context menus as data (spec 04 §4.10), shared by the graph and the left panel. */

/** "Reset <branch> to <x>" in its three modes (no submenus in our menu component). */
const resetItems = (repoId: RepoId, target: Sha, label: string, branch: string): MenuEntry[] =>
  (['soft', 'mixed', 'hard'] as const).map((mode) => ({
    label: `Reset ${branch} to ${label} (${mode})`,
    danger: mode === 'hard',
    onSelect: () => void reset(repoId, target, mode, label),
  }));

/**
 * "Merge X into H" / "Rebase H onto X" with a lazy conflict prediction: "— ⚠ will conflict in N files" and the
 * file list on hover, patched into the open menu when `git merge-tree` answers (spec 08 §4.9).
 */
function integrateItems(repoId: RepoId, ref: RefInfo, allRefs: RefInfo[]): MenuItem[] {
  const head = allRefs.find((r) => r.type === 'local' && r.isHead);
  const into = head?.shortName ?? 'current branch';
  return [
    withConflictPrediction(
      repoId,
      { label: `Merge ${ref.shortName} into ${into}`, onSelect: () => merge(repoId, ref.shortName) },
      head?.sha,
      ref.sha,
    ),
    {
      label: `Merge ${ref.shortName} into ${into}…`,
      title: 'Choose: fast-forward if possible, merge commit, fast-forward only or squash',
      onSelect: () => void mergeWithOptions(repoId, ref.shortName, into),
    },
    withConflictPrediction(
      repoId,
      { label: `Rebase ${into} onto ${ref.shortName}`, onSelect: () => rebase(repoId, ref.shortName) },
      head?.sha,
      ref.sha,
    ),
  ];
}

/** "Open on provider" (spec 10 §11): resolve the web link via `provider:webUrl` and open it. */
async function openOnProvider(
  repoId: RepoId,
  target: { kind: 'commit'; sha: Sha } | { kind: 'branch'; name: string },
  remote?: string,
): Promise<void> {
  const url = await intInvoke('provider:webUrl', { repoId, remote, target }).catch(() => null);
  if (url) void invoke('shell:openExternal', { url });
  else
    useToastStore.getState().push({
      kind: 'warning',
      title: 'No web link available',
      body: 'None of the remotes points to a known hosting provider.',
    });
}

const openFile = (repoId: RepoId, path: string, mode: 'history' | 'blame' | 'edit') => (): void =>
  useRepoUiStore.getState().update(repoId, () => ({ center: { kind: 'file', path, mode } }));

/** File-level actions from the diff/file lists (spec 07). */
export function fileMenu(
  repoId: RepoId,
  path: string,
  inWorktree: boolean,
  /** The diff the row shows, for "Open in external diff tool" (spec 07 §2.3). */
  diff?: FileDiffContext,
): MenuEntry[] {
  if (isRawPathKey(path)) {
    // a name that is not valid UTF-8 (spec 02 §8): only what can address it by its bytes
    return [
      { label: 'File history', onSelect: openFile(repoId, path, 'history') },
      'separator',
      { label: 'Copy file path', onSelect: copy(shownPath(path)) },
    ];
  }
  return [
    { label: 'File history', onSelect: openFile(repoId, path, 'history') },
    { label: 'Blame', onSelect: openFile(repoId, path, 'blame') },
    ...(inWorktree ? [{ label: 'Edit file', onSelect: openFile(repoId, path, 'edit') }] : []),
    // Checkout / revert file at this commit, create patch (spec 07 §2.3; commit diffs only)
    ...commitFileMenuItems(repoId, path, diff),
    'separator',
    // Open in external editor / default program / show in folder / external diff / copy full path (spec 12 §4.10)
    ...fileToolsMenu(repoId, path, { diff }),
    { label: 'Copy file path', onSelect: copy(path) },
  ];
}
const copy = (text: string) => (): void => void invoke('shell:copyText', { text });

/** AI entries (spec 12 §4.4); hidden entirely when AI is disabled. */
const ai = (items: MenuEntry[]): MenuEntry[] => (aiEnabled() ? ['separator', ...items] : []);

const changelog = (repoId: RepoId, from: string, to: string) => (): void =>
  void import('../views/ai/ChangelogDialog').then((m) => m.openChangelog(repoId, { from, to }));

/** Target for checking out a ref (remote → tracking branch, spec 05). */
export function checkoutTargetFor(ref: RefInfo): CheckoutTarget {
  if (ref.type === 'remote') {
    const [remote, ...rest] = ref.shortName.split('/');
    return { kind: 'remoteBranch', remote: remote!, name: rest.join('/') };
  }
  if (ref.type === 'tag') return { kind: 'tag', name: ref.shortName };
  return { kind: 'branch', name: ref.shortName };
}

export function commitMenu(
  repoId: RepoId,
  sha: Sha,
  subject: string | undefined,
  headSha: Sha | null,
  opts: { headBranch?: string | null; isMerge?: boolean } = {},
): MenuEntry[] {
  const branch = opts.headBranch ?? 'HEAD';
  const isHead = sha === headSha;
  return [
    {
      label: 'Checkout this commit',
      disabled: sha === headSha,
      onSelect: () => void checkout(repoId, { kind: 'commit', sha }),
    },
    { label: 'Create branch here…', onSelect: () => void createBranch(repoId, sha) },
    { label: 'Create tag here…', onSelect: () => void createTag(repoId, sha) },
    { label: 'Create annotated tag here…', onSelect: () => void createTag(repoId, sha, true) },
    'separator',
    {
      label: 'Cherry pick commit',
      disabled: isHead || !headSha,
      onSelect: () => cherryPick(repoId, [sha], opts.isMerge),
    },
    { label: 'Revert commit', onSelect: () => void revert(repoId, [sha], opts.isMerge) },
    ...(isHead ? [] : resetItems(repoId, sha, shortSha(sha), branch)),
    {
      label: 'Move another branch here…',
      title: 'Reset a branch that is not checked out to this commit (update-ref)',
      onSelect: () => void moveBranchHere(repoId, sha),
    },
    'separator',
    {
      label: `Interactive rebase ${branch} from here…`,
      disabled: isHead || !opts.headBranch,
      title: 'Rewrite the commits after this one',
      onSelect: () => interactiveRebase(repoId, sha, shortSha(sha)),
    },
    { label: `Rebase ${branch} onto this commit`, disabled: isHead, onSelect: () => rebase(repoId, sha) },
    {
      label: `Rebase ${branch} from this commit onto…`,
      disabled: !opts.headBranch || opts.isMerge,
      title: 'Move this commit and the ones above it onto another branch or commit (pivot rebase)',
      onSelect: () => opts.headBranch && void rebaseCommitsOnto(repoId, sha, opts.headBranch),
    },
    ...shareMenuItem('Share commit as Cloud Patch…', () => void shareCommit(repoId, sha, subject)),
    ...ai([
      { label: 'Explain commit', onSelect: () => openExplain(repoId, { kind: 'commits', shas: [sha] }) },
      {
        label: isHead ? 'Recompose this commit with AI' : `Recompose commits from here to HEAD with AI`,
        disabled: !opts.headBranch || opts.isMerge,
        title: 'Split the changes of this commit and the ones above it into new commits',
        onSelect: () => openCompose(repoId, { kind: 'range', from: sha, to: 'HEAD' }),
      },
    ]),
    'separator',
    { label: 'Copy commit SHA', onSelect: copy(sha) },
    { label: 'Copy short SHA', onSelect: copy(shortSha(sha)) },
    { label: 'Copy link to commit', onSelect: () => void copyLink(repoId, { kind: 'commit', sha }) },
    { label: 'Open on provider', onSelect: () => void openOnProvider(repoId, { kind: 'commit', sha }) },
    ...(subject ? [{ label: 'Copy commit message', onSelect: copy(subject) }] : []),
  ];
}

export function refMenu(repoId: RepoId, ref: RefInfo, allRefs: RefInfo[]): MenuEntry[] {
  const reveal = (): void => useRepoUiStore.getState().reveal(repoId, ref.sha);
  if (ref.type === 'local') {
    const isHead = ref.isHead;
    return [
      {
        label: `Checkout ${ref.shortName}`,
        disabled: isHead,
        onSelect: () => void checkout(repoId, checkoutTargetFor(ref)),
      },
      ...(isHead
        ? [
            { label: 'Pull', disabled: !ref.upstream, onSelect: () => pull(repoId) },
            { label: 'Push', onSelect: () => void push(repoId) },
            {
              label: 'Force push (with lease)',
              disabled: !ref.upstream,
              onSelect: () => void push(repoId, { force: true }),
            },
          ]
        : [
            {
              label: ref.upstream && !ref.upstream.gone ? `Push ${ref.shortName}` : `Push ${ref.shortName}…`,
              title: 'Push this branch without checking it out (asks for a target when it has no upstream)',
              onSelect: () => void pushBranch(repoId, ref),
            },
          ]),
      { label: 'Fetch', onSelect: () => fetchAll(repoId) },
      { label: 'Set upstream…', onSelect: () => setUpstreamFor(repoId, ref) },
      {
        label: 'Create worktree…',
        onSelect: () =>
          openCreateWorktree(
            repoId,
            isHead || ref.worktreePath
              ? { mode: 'new', startPoint: ref.shortName }
              : { mode: 'existing', branch: ref.shortName },
          ),
      },
      'separator',
      ...(isHead
        ? []
        : [
            ...integrateItems(repoId, ref, allRefs),
            {
              label: `Interactive rebase current branch onto ${ref.shortName}…`,
              onSelect: () => interactiveRebase(repoId, ref.sha, ref.shortName),
            },
            {
              label: `Fast-forward current branch to ${ref.shortName}`,
              onSelect: () => fastForwardHead(repoId, ref.shortName),
            },
            ...resetItems(repoId, ref.sha, ref.shortName, 'current branch'),
          ]),
      'separator',
      { label: 'Create branch here…', onSelect: () => void createBranch(repoId, ref.sha, ref.shortName) },
      { label: 'Create tag here…', onSelect: () => void createTag(repoId, ref.sha) },
      {
        label: `Start a pull request from ${ref.shortName}…`,
        onSelect: () => openCreatePullRequest(repoId, { headBranch: ref.shortName }),
      },
      { label: `Rename ${ref.shortName}…`, onSelect: () => void renameBranch(repoId, ref.shortName) },
      ...ai([
        {
          label: 'Explain branch changes',
          onSelect: () => openExplain(repoId, { kind: 'branch', branch: ref.shortName }),
        },
      ]),
      {
        label: `Delete ${ref.shortName}`,
        danger: true,
        disabled: isHead,
        title: isHead ? 'You cannot delete the checked-out branch' : undefined,
        onSelect: () => void deleteBranch(repoId, ref),
      },
      'separator',
      { label: 'Show in graph', onSelect: reveal },
      ...visibilityMenuItems(repoId, ref),
      { label: 'Copy branch name', onSelect: copy(ref.shortName) },
      { label: 'Copy commit SHA', onSelect: copy(ref.sha) },
      {
        label: 'Copy link to branch',
        onSelect: () => void copyLink(repoId, { kind: 'branch', name: ref.shortName }),
      },
      {
        label: 'Open on provider',
        onSelect: () => void openOnProvider(repoId, { kind: 'branch', name: ref.shortName }),
      },
      ...issueMenuItems(repoId, ref.shortName),
    ];
  }
  if (ref.type === 'remote') {
    const [, ...rest] = ref.shortName.split('/');
    const localName = rest.join('/');
    const local = allRefs.find((r) => r.type === 'local' && r.shortName === localName);
    return [
      {
        label: local ? `Checkout ${localName}` : `Checkout as new local branch ${localName}`,
        onSelect: () => void checkout(repoId, checkoutTargetFor(ref)),
      },
      { label: 'Fetch', onSelect: () => fetchAll(repoId) },
      'separator',
      ...integrateItems(repoId, ref, allRefs),
      {
        label: `Fast-forward current branch to ${ref.shortName}`,
        onSelect: () => fastForwardHead(repoId, ref.shortName),
      },
      'separator',
      { label: 'Create branch here…', onSelect: () => void createBranch(repoId, ref.sha, ref.shortName) },
      {
        label: `Start a pull request from ${ref.shortName}…`,
        onSelect: () => openCreatePullRequest(repoId, { headBranch: ref.shortName }),
      },
      { label: `Rename ${ref.shortName} on remote…`, onSelect: () => void renameRemoteBranch(repoId, ref) },
      {
        label: `Delete ${ref.shortName} on remote`,
        danger: true,
        onSelect: () => void deleteRemoteBranch(repoId, ref),
      },
      'separator',
      { label: 'Show in graph', onSelect: reveal },
      ...visibilityMenuItems(repoId, ref),
      { label: 'Copy branch name', onSelect: copy(ref.shortName) },
      {
        label: 'Copy link to branch',
        onSelect: () => void copyLink(repoId, { kind: 'branch', name: localName }),
      },
      {
        label: 'Open on provider',
        onSelect: () =>
          void openOnProvider(repoId, { kind: 'branch', name: localName }, ref.shortName.split('/')[0]),
      },
    ];
  }
  if (ref.type === 'tag') {
    return [
      {
        label: `Checkout ${ref.shortName} (detached)`,
        onSelect: () => void checkout(repoId, checkoutTargetFor(ref)),
      },
      { label: 'Create branch here…', onSelect: () => void createBranch(repoId, ref.sha, ref.shortName) },
      { label: `Push ${ref.shortName} to remote…`, onSelect: () => void pushTag(repoId, ref.shortName) },
      ...ai([
        {
          label: `Generate changelog ${ref.shortName}..HEAD`,
          onSelect: changelog(repoId, ref.shortName, 'HEAD'),
        },
      ]),
      {
        label: `Delete ${ref.shortName}…`,
        danger: true,
        onSelect: () => void deleteTag(repoId, ref.shortName),
      },
      'separator',
      { label: 'Show in graph', onSelect: reveal },
      ...visibilityMenuItems(repoId, ref),
      { label: 'Copy tag name', onSelect: copy(ref.shortName) },
    ];
  }
  return [{ label: 'Show in graph', onSelect: reveal }];
}

export function stashMenu(repoId: RepoId, s: StashEntry): MenuEntry[] {
  return [
    { label: 'Apply stash', onSelect: () => void stashApply(repoId, s.index, s.sha) },
    { label: 'Pop stash', onSelect: () => void stashPop(repoId, s.index, s.sha) },
    ...stashExtraMenuItems(repoId, s),
    ...shareMenuItem('Share stash as Cloud Patch…', () => void shareStash(repoId, s.sha, s.message)),
    {
      label: 'Delete stash',
      danger: true,
      onSelect: () => void stashDrop(repoId, s.index, s.sha, s.message),
    },
    'separator',
    ...stashVisibilityItems(repoId, s.sha),
    { label: 'Copy SHA', onSelect: copy(s.sha) },
  ];
}

export function wipMenu(repoId: RepoId, viewChanges: () => void): MenuEntry[] {
  return [
    { label: 'View changes', onSelect: viewChanges },
    { label: 'Stash all changes', onSelect: () => void stashSave(repoId) },
    { label: 'Stash with message…', onSelect: () => void stashSave(repoId, true) },
    { label: 'Stash with options…', onSelect: () => void stashWithOptions(repoId) },
    { label: 'Create branch with these changes…', onSelect: () => void createBranch(repoId) },
    ...shareMenuItem('Share as Cloud Patch…', () => void shareWip(repoId)),
    ...ai([
      { label: 'Explain changes', onSelect: () => openExplain(repoId, { kind: 'wip' }) },
      { label: 'Compose commits with AI', onSelect: () => openCompose(repoId, { kind: 'staged' }) },
    ]),
    'separator',
    { label: 'Discard all changes', danger: true, onSelect: () => void discardAll(repoId) },
  ];
}

/** Fast-forward the checked-out branch (spec 05: merge --ff-only under the hood). */
function fastForwardHead(repoId: RepoId, to: string): void {
  void invoke('git:repo:info', { repoId }).then((info) => {
    if (info.head.kind === 'branch') fastForward(repoId, info.head.name, to);
  });
}
