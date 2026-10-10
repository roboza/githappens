import type { CheckoutTarget, DirtyStrategy, MergeMode, PullStrategy, ResetMode } from '@githappens/git/ops';
import type { RefInfo, RepoId, Sha } from '@githappens/git/types';

import { choose, confirm, prompt } from '../components/Dialogs';
import { invoke, IpcError } from '../lib/api';
import { shortSha } from '../lib/format';
import { quiet, runOp } from '../lib/ops';
import type { SettingKey, SettingValue } from '../../../shared/settings/registry';
import { useRepoUiStore } from '../stores/repo-ui';
import { useSettingsStore } from '../stores/settings';
import { useToastStore } from '../stores/toasts';
import {
  cherryPickCommits,
  confirmHardReset,
  defaultMergeMode,
  guardDetachedHead,
  resolveRemoteCheckout,
  runMerge,
  validateBranchName,
  warnCaseOnly,
} from '../views/ops/branching-actions';
import { redo as redoAction, undo as undoAction } from '../views/undo/undo-actions';
import { forcePush, runFetch, runPull, runPush } from '../views/sync/sync-actions';

/**
 * User-level git actions (specs 05, 06, 09): dialogs + op + follow-up. Shared by the
 * toolbar, context menus, keyboard shortcuts and the command palette.
 */

const setting = <K extends SettingKey>(k: K): SettingValue<K> | undefined =>
  useSettingsStore.getState().values?.[k];

/** git's rules, existence and case-only clashes (spec 05 §4.3, §8; Phase 8 `validateBranchName`). */
function validateNewBranch(repoId: RepoId, name: string): Promise<string | null> {
  return validateBranchName(repoId, name);
}

// ---------------------------------------------------------------------------
// branches & checkout (spec 05)

export async function createBranch(
  repoId: RepoId,
  startPoint: string = 'HEAD',
  label?: string,
): Promise<void> {
  const r = await prompt({
    title: 'Create branch',
    label: `Start point: ${label ?? (startPoint === 'HEAD' ? 'HEAD' : shortSha(startPoint))}`,
    placeholder: 'feature/my-branch',
    okLabel: 'Create branch',
    validate: (v) => validateNewBranch(repoId, v),
    checkbox: { label: 'Check out the new branch', initial: true },
  });
  if (!r) return;
  void warnCaseOnly(repoId, r.value.trim());
  quiet(
    runOp(
      repoId,
      { type: 'branch.create', name: r.value.trim(), startPoint, checkout: r.checked },
      { successToast: `Created branch ${r.value.trim()}` },
    ),
  );
}

/** Checkout with dirty-tree handling (spec 05 §4 checkout flow). */
export async function checkout(repoId: RepoId, target: CheckoutTarget): Promise<void> {
  const pre = await invoke('git:checkout:preflight', { repoId, target });
  // Remote branch whose local counterpart exists: RemoteCheckoutConflictDialog (spec 05 §4.5).
  if (target.kind === 'remoteBranch' && pre.localExists) {
    const resolved = await resolveRemoteCheckout(repoId, target, pre);
    if (!resolved) return;
    target = resolved;
  }
  // Leaving a detached HEAD with commits on no branch (spec 05 §8).
  if (!(await guardDetachedHead(repoId, target))) return;
  let strategy: DirtyStrategy = 'carry';
  if (pre.blockingPaths.length) {
    const mode = setting('checkout.autostash') ?? 'ask';
    if (mode === 'always') strategy = 'stash';
    else {
      const files = pre.blockingPaths.slice(0, 6).join('\n');
      const pick = await choose({
        title: 'Uncommitted changes would be overwritten',
        message: `These files have local changes that conflict with the checkout:\n${files}${
          pre.blockingPaths.length > 6 ? '\n…' : ''
        }`,
        choices: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'discard', label: 'Discard changes', danger: true },
          { value: 'stash', label: 'Stash & checkout', primary: true },
        ],
      });
      if (!pick || pick.value === 'cancel') return;
      strategy = pick.value as DirtyStrategy;
      if (
        strategy === 'discard' &&
        !(await confirm(
          'Discard changes?',
          'Your local changes will be discarded. You can undo this.',
          'Discard',
          true,
        ))
      ) {
        return;
      }
    }
  }
  const r = await runOp(repoId, { type: 'checkout.run', target, dirtyStrategy: strategy }).catch(() => null);
  // spec 05 §4.5: after "Stash & checkout", main pops it when `checkout.autoPopStash`; otherwise offer it.
  const data = r?.data as { stashSha?: Sha; stashPopped?: boolean } | undefined;
  if (data?.stashSha && data.stashPopped === undefined) {
    const sha = data.stashSha;
    useToastStore.getState().push({
      kind: 'info',
      title: 'Your changes were stashed',
      body: 'Pop the stash now to re-apply them here?',
      timeoutMs: 15_000,
      actions: [{ label: 'Pop stash', run: () => stashPop(repoId, 0, sha) }],
    });
  } else if (data?.stashPopped) {
    useToastStore.getState().push({ kind: 'success', title: 'Re-applied your stashed changes' });
  }
}

export async function renameBranch(repoId: RepoId, from: string): Promise<void> {
  const r = await prompt({
    title: `Rename branch ${from}`,
    initial: from,
    okLabel: 'Rename',
    validate: (v) => (v.trim() === from ? 'Choose a different name.' : validateBranchName(repoId, v, from)),
  });
  if (r) quiet(runOp(repoId, { type: 'branch.rename', from, to: r.value.trim() }));
}

export async function deleteBranch(repoId: RepoId, ref: RefInfo): Promise<void> {
  const upstream =
    ref.upstream && !ref.upstream.gone ? ref.upstream.fullName.replace(/^refs\/remotes\//, '') : null;
  const pick = await choose({
    title: `Delete branch ${ref.shortName}?`,
    message: 'The local branch will be deleted. You can undo this.',
    checkbox: upstream ? { label: `Also delete ${upstream} on the remote`, initial: false } : undefined,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'delete', label: 'Delete', danger: true },
    ],
  });
  if (!pick || pick.value !== 'delete') return;
  const [remote, ...rest] = (upstream ?? '').split('/');
  const branches = [
    {
      name: ref.shortName,
      ...(pick.checked && upstream
        ? { deleteRemote: { remote: remote!, remoteBranch: rest.join('/') } }
        : {}),
    },
  ];
  try {
    await runOp(
      repoId,
      { type: 'branch.delete', branches, force: false },
      { handled: ['BranchNotFullyMerged'] },
    );
  } catch (e) {
    if (e instanceof IpcError && e.code === 'BranchNotFullyMerged') {
      const force = await confirm(
        'Branch is not fully merged',
        `${ref.shortName} has commits that are not merged into the current branch. Delete it anyway?`,
        'Force delete',
        true,
      );
      if (force) quiet(runOp(repoId, { type: 'branch.delete', branches, force: true }));
    }
  }
}

export async function deleteRemoteBranch(repoId: RepoId, ref: RefInfo): Promise<void> {
  const [remote, ...rest] = ref.shortName.split('/');
  const ok = await confirm(
    `Delete ${ref.shortName} on the remote?`,
    'The branch will be deleted from the remote for everyone. This cannot be undone from here.',
    'Delete from remote',
    true,
  );
  if (ok)
    quiet(runOp(repoId, { type: 'push.delete', remote: remote!, refs: [`refs/heads/${rest.join('/')}`] }));
}

// ---------------------------------------------------------------------------
// tags (spec 05)

export async function createTag(repoId: RepoId, target: Sha, annotated = false): Promise<void> {
  const name = await prompt({
    title: annotated ? 'Create annotated tag' : 'Create tag',
    label: `At ${shortSha(target)}`,
    placeholder: 'v1.0.0',
    okLabel: 'Create tag',
    validate: async (v) => {
      if (!v.trim()) return 'Enter a tag name.';
      const refs = await invoke('git:refs', { repoId });
      return refs.some((r) => r.type === 'tag' && r.shortName === v.trim())
        ? 'A tag with that name already exists.'
        : null;
    },
  });
  if (!name) return;
  let message: string | undefined;
  let sign = false;
  if (annotated) {
    const m = await prompt({
      title: `Message for ${name.value.trim()}`,
      multiline: true,
      okLabel: 'Create tag',
      // `git tag -s` (spec 05 §6.4); needs a configured signing key
      checkbox: { label: 'Sign the tag (GPG/SSH signing key)', initial: false },
    });
    if (!m) return;
    message = m.value;
    sign = m.checked;
  }
  quiet(
    runOp(repoId, {
      type: 'tag.create',
      name: name.value.trim(),
      target,
      ...(message !== undefined ? { annotated: { message, ...(sign ? { sign: true } : {}) } } : {}),
    }),
  );
}

export async function deleteTag(repoId: RepoId, name: string): Promise<void> {
  const remotes = await invoke('git:remotes', { repoId });
  const pick = await choose({
    title: `Delete tag ${name}?`,
    message: 'The tag will be deleted locally.',
    checkbox: remotes.length
      ? { label: `Also delete from ${remotes.map((r) => r.name).join(', ')}`, initial: false }
      : undefined,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      // spec 05 §2.2: delete from the remote only, keeping the local tag
      ...(remotes.length ? [{ value: 'remote', label: 'Delete from remote only', danger: true }] : []),
      { value: 'delete', label: 'Delete', danger: true },
    ],
  });
  if (pick?.value === 'remote') {
    const names = remotes.map((r) => r.name);
    quiet(
      runOp(
        repoId,
        { type: 'tag.delete', name, local: false, remotes: names },
        { successToast: `Deleted tag ${name} from ${names.join(', ')}` },
      ),
    );
    return;
  }
  if (pick?.value === 'delete') {
    quiet(
      runOp(repoId, {
        type: 'tag.delete',
        name,
        local: true,
        remotes: pick.checked ? remotes.map((r) => r.name) : [],
      }),
    );
  }
}

export async function pushTag(repoId: RepoId, name: string): Promise<void> {
  const remote = await pickRemote(repoId, `Push tag ${name} to`);
  if (remote)
    quiet(
      runOp(repoId, { type: 'tag.push', name, remote }, { successToast: `Pushed tag ${name} to ${remote}` }),
    );
}

// ---------------------------------------------------------------------------
// stash (spec 05)

export async function stashSave(repoId: RepoId, askMessage = false): Promise<void> {
  let message: string | undefined;
  if (askMessage && setting('ai.enabled')) {
    // stash dialog with the AI sparkle (spec 12 §4.4)
    const { promptStashMessage } = await import('../views/ai/StashMessageDialog');
    const v = await promptStashMessage(repoId);
    if (v === null) return;
    message = v.trim() || undefined;
  } else if (askMessage) {
    const r = await prompt({ title: 'Stash changes', label: 'Message (optional)', okLabel: 'Stash' });
    if (!r) return;
    message = r.value.trim() || undefined;
  }
  const includeUntracked = setting('general.stashIncludeUntracked') ?? true;
  quiet(
    runOp(repoId, { type: 'stash.push', message, includeUntracked }, { successToast: 'Changes stashed' }),
  );
}

export async function stashPop(repoId: RepoId, index = 0, sha?: Sha): Promise<void> {
  const s = sha ?? (await invoke('git:stash:list', { repoId }))[index]?.sha;
  if (s) quiet(runOp(repoId, { type: 'stash.pop', index, sha: s }));
}

export async function stashApply(repoId: RepoId, index: number, sha: Sha): Promise<void> {
  quiet(runOp(repoId, { type: 'stash.apply', index, sha }));
}

export async function stashDrop(repoId: RepoId, index: number, sha: Sha, message: string): Promise<void> {
  if (await confirm('Delete stash?', `"${message}" will be deleted. You can undo this.`, 'Delete', true)) {
    quiet(runOp(repoId, { type: 'stash.drop', index, sha }));
  }
}

// ---------------------------------------------------------------------------
// remotes & sync (spec 09)

async function pickRemote(repoId: RepoId, title: string): Promise<string | null> {
  const remotes = await invoke('git:remotes', { repoId });
  if (remotes.length === 0) {
    await confirm('No remotes', 'This repository has no remotes. Add one first.', 'OK');
    return null;
  }
  if (remotes.length === 1) return remotes[0]!.name;
  const pick = await choose({
    title,
    message: 'Choose a remote.',
    choices: [
      { value: '', label: 'Cancel' },
      ...remotes.map((r, i) => ({ value: r.name, label: r.name, primary: i === 0 })),
    ],
  });
  return pick?.value || null;
}

export function fetchAll(repoId: RepoId): void {
  // spec 09 §6.2: "Fetched 3 updates on origin" with the updated refs (views/sync)
  quiet(runFetch(repoId, { type: 'fetch', remote: 'all', prune: setting('general.autoPrune') ?? true }));
}

export function pull(repoId: RepoId, strategy?: PullStrategy): void {
  const s = strategy ?? setting('git.pullMode') ?? 'ff-if-possible';
  // Stash & Pull / diverged Merge-Rebase recovery (spec 09 §6.4, views/sync)
  quiet(
    runPull(repoId, { type: 'pull', strategy: s, autostash: setting('checkout.autostash') === 'always' }),
  );
}

/** Push the current branch; prompts for an upstream when missing (spec 09 §4 push flow). */
export async function push(repoId: RepoId, opts: { force?: boolean } = {}): Promise<void> {
  const info = await invoke('git:repo:info', { repoId });
  if (info.head.kind !== 'branch') {
    await confirm('Cannot push', 'HEAD is detached. Check out a branch to push.', 'OK');
    return;
  }
  const branch = info.head.name;
  const refs = await invoke('git:refs', { repoId });
  const local = refs.find((r) => r.type === 'local' && r.shortName === branch);
  let remote: string;
  let remoteBranch: string;
  let setUpstream = false;
  if (local?.upstream && !local.upstream.gone) {
    const up = local.upstream.fullName.replace(/^refs\/remotes\//, '');
    remote = up.split('/')[0]!;
    remoteBranch = up.slice(remote.length + 1);
  } else {
    const r = await pickRemote(repoId, `Push ${branch} to`);
    if (!r) return;
    const name = await prompt({
      title: `Push ${branch} to ${r}`,
      label: 'Remote branch name (upstream will be set)',
      initial: branch,
      okLabel: 'Push',
      validate: (v) => (v.trim() ? null : 'Enter a branch name.'),
    });
    if (!name) return;
    remote = r;
    remoteBranch = name.value.trim();
    setUpstream = true;
  }
  const op = {
    type: 'push' as const,
    localRef: branch,
    remote,
    remoteBranch,
    setUpstream,
    force: opts.force ? ('lease' as const) : ('none' as const),
  };
  // rejected → Pull / Force push… with a preview of the lost commits, hooks modal, PR link (views/sync)
  if (opts.force) await forcePush(repoId, op, `Force pushed ${branch} to ${remote}/${remoteBranch}`);
  else await runPush(repoId, op, `Pushed ${branch} to ${remote}/${remoteBranch}`);
}

// ---------------------------------------------------------------------------
// working tree (spec 06)

export async function discardAll(repoId: RepoId): Promise<void> {
  if (
    await confirm(
      'Discard all changes?',
      'All uncommitted changes, including untracked files, will be discarded. You can undo this.',
      'Discard all',
      true,
    )
  ) {
    quiet(runOp(repoId, { type: 'wip.discardAll', includeUntracked: true }));
  }
}

export async function discardFiles(repoId: RepoId, paths: string[], untracked: boolean): Promise<void> {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  if (
    await confirm(
      `Discard changes to ${what}?`,
      'The changes will be discarded. You can undo this.',
      'Discard',
      true,
    )
  ) {
    quiet(runOp(repoId, { type: 'wip.discard', paths, includeUntracked: untracked }));
  }
}

export function ignorePattern(repoId: RepoId, pattern: string): void {
  quiet(runOp(repoId, { type: 'wip.ignore', pattern }, { successToast: `Added ${pattern} to .gitignore` }));
}

// ---------------------------------------------------------------------------
// undo / redo (spec 05)

/** Toast with a Redo link, drift explanation, reflog fallback (spec 05 §4.7; Phase 8 `views/undo`). */
export function undo(repoId: RepoId): Promise<void> {
  return undoAction(repoId);
}

export function redo(repoId: RepoId): Promise<void> {
  return redoAction(repoId);
}

// ---------------------------------------------------------------------------
// history rewriting (spec 05, Phase 3)

const shortRef = (r: string): string => r.replace(/^refs\/(heads|remotes|tags)\//, '');

/**
 * Merge `source` into the checked-out branch; the mode defaults to the `git.mergeBehavior` preference.
 * Conflicts hand off to the operation banner (spec 08).
 */
export function merge(repoId: RepoId, source: string, mode?: MergeMode): void {
  runMerge(repoId, source, mode ?? defaultMergeMode());
}

export function rebase(repoId: RepoId, onto: string): void {
  quiet(runOp(repoId, { type: 'rebase.run', onto }, { successToast: `Rebased onto ${shortRef(onto)}` }));
}

/** Open the interactive rebase editor for commits after `upstream` (spec 05 §4.5). */
export function interactiveRebase(repoId: RepoId, upstream: string, label: string): void {
  useRepoUiStore
    .getState()
    .update(repoId, () => ({ center: { kind: 'rebase', upstream, onto: upstream, label } }));
}

export function fastForward(repoId: RepoId, branch: string, to: string): void {
  quiet(
    runOp(
      repoId,
      { type: 'ff.run', branch, to },
      { successToast: `Fast-forwarded ${branch} to ${shortRef(to)}` },
    ),
  );
}

export async function reset(
  repoId: RepoId,
  target: Sha,
  mode: ResetMode,
  label = shortSha(target),
): Promise<void> {
  if (mode === 'hard' && !(await confirmHardReset(repoId, 'The current branch', label))) return;
  quiet(runOp(repoId, { type: 'reset.run', target, mode }, { successToast: `Reset (${mode}) to ${label}` }));
}

/** Cherry-pick; a merge commit prompts for its mainline parent (spec 05 §6.9). */
export function cherryPick(repoId: RepoId, shas: Sha[], isMerge = false): void {
  void cherryPickCommits(
    repoId,
    shas.map((sha) => ({ sha, parents: isMerge ? ['', ''] : [''] })),
  );
}

/** Revert commits; merge commits need a mainline parent (spec 05 §4.7). */
export async function revert(repoId: RepoId, shas: Sha[], isMerge = false): Promise<void> {
  let mainline: number | undefined;
  if (isMerge) {
    const pick = await choose({
      title: 'Revert merge commit',
      message: 'Which parent is the mainline (the side whose changes are kept)?',
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: '2', label: 'Parent 2 (merged branch)' },
        { value: '1', label: 'Parent 1 (target branch)', primary: true },
      ],
    });
    if (!pick || pick.value === 'cancel') return;
    mainline = Number(pick.value);
  }
  quiet(
    runOp(
      repoId,
      { type: 'revert.run', shas, ...(mainline ? { mainline } : {}) },
      {
        successToast:
          shas.length === 1 ? `Reverted ${shortSha(shas[0]!)}` : `Reverted ${shas.length} commits`,
      },
    ),
  );
}

/** Push local branch `local` to `remote/remoteBranch` (drag local → remote branch, spec 05 §4.4). */
export function pushTo(
  repoId: RepoId,
  local: string,
  remote: string,
  remoteBranch: string,
  force = false,
): void {
  const op = {
    type: 'push' as const,
    localRef: local,
    remote,
    remoteBranch,
    setUpstream: false,
    force: 'none' as const,
  };
  quiet(
    force
      ? forcePush(repoId, op, `Force pushed ${local} to ${remote}/${remoteBranch}`)
      : runPush(repoId, op, `Pushed ${local} to ${remote}/${remoteBranch}`),
  );
}
