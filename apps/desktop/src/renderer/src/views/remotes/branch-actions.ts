import type { RefInfo, RepoId } from '@githappens/git/types';

import { deleteBranch } from '../../actions/git-actions';
import { choose, confirm, prompt } from '../../components/Dialogs';
import { invoke, IpcError } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { openSetUpstream } from './dialog-store';
import { splitRemoteBranch } from './remote-model';

/** Branch actions added in Phase 8: push any branch, set upstream, multi-delete (spec 05 / 09). */

const upstreamShort = (r: RefInfo): string | null =>
  r.upstream && !r.upstream.gone ? r.upstream.fullName.replace(/^refs\/remotes\//, '') : null;

async function pickRemote(repoId: RepoId, title: string): Promise<string | null> {
  const remotes = await invoke('git:remotes', { repoId });
  if (!remotes.length) {
    await confirm('No remotes', 'This repository has no remotes. Add one first.', 'OK');
    return null;
  }
  if (remotes.length === 1) return remotes[0]!.name;
  const ordered = [...remotes].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
  const pick = await choose({
    title,
    message: 'Choose a remote.',
    choices: [
      { value: '', label: 'Cancel' },
      ...ordered.map((r, i) => ({ value: r.name, label: r.name, primary: i === 0 })),
    ],
  });
  return pick?.value || null;
}

/**
 * "Push" / "Push or set upstream" for any local branch (also when it is not checked out, spec 09 §2):
 * pushes to the upstream, or asks for remote + name (setting the upstream by default).
 */
export async function pushBranch(repoId: RepoId, ref: RefInfo): Promise<void> {
  const branch = ref.shortName;
  let remote: string;
  let remoteBranch: string;
  let setUpstream = false;
  const up = upstreamShort(ref);
  const remotes = (await invoke('git:remotes', { repoId })).map((r) => r.name);
  const split = up ? splitRemoteBranch(up, remotes) : null;
  if (split) {
    [remote, remoteBranch] = split;
  } else {
    const r = await pickRemote(repoId, `Push ${branch} to`);
    if (!r) return;
    const name = await prompt({
      title: `Push ${branch} to ${r}`,
      label: 'Remote branch name',
      initial: branch,
      okLabel: 'Push',
      checkbox: { label: 'Set as upstream', initial: true },
      validate: (v) => (v.trim() ? null : 'Enter a branch name.'),
    });
    if (!name) return;
    remote = r;
    remoteBranch = name.value.trim();
    setUpstream = name.checked;
  }
  const op = {
    type: 'push' as const,
    localRef: branch,
    remote,
    remoteBranch,
    setUpstream,
    force: 'none' as const,
  };
  try {
    await runOp(repoId, op, {
      successToast: `Pushed ${branch} to ${remote}/${remoteBranch}`,
      handled: ['PushRejectedNonFastForward'],
    });
  } catch (e) {
    if (e instanceof IpcError && e.code === 'PushRejectedNonFastForward') {
      const force = await confirm(
        'Push rejected',
        `${remote}/${remoteBranch} has commits that ${branch} doesn't have. Force push (with lease) to overwrite them?`,
        'Force push',
        true,
      );
      if (force) quiet(runOp(repoId, { ...op, force: 'lease' }, { successToast: `Force pushed ${branch}` }));
    }
  }
}

/** "Set upstream…" from a branch menu. */
export function setUpstreamFor(repoId: RepoId, ref: RefInfo): void {
  openSetUpstream(repoId, ref.shortName, upstreamShort(ref));
}

/** Multi-select "Delete N branches" (spec 05; the `branch.delete` op batches). */
export async function deleteBranches(repoId: RepoId, refs: readonly RefInfo[]): Promise<void> {
  const list = refs.filter((r) => r.type === 'local' && !r.isHead);
  if (!list.length) return;
  if (list.length === 1) return deleteBranch(repoId, list[0]!);
  const remotes = (await invoke('git:remotes', { repoId })).map((r) => r.name);
  const withRemote = list.filter((r) => upstreamShort(r));
  const pick = await choose({
    title: `Delete ${list.length} branches?`,
    message: `${list
      .slice(0, 8)
      .map((r) => r.shortName)
      .join(
        ', ',
      )}${list.length > 8 ? ` and ${list.length - 8} more` : ''} will be deleted. You can undo this.`,
    checkbox: withRemote.length
      ? {
          label: `Also delete ${withRemote.length} upstream branch${withRemote.length === 1 ? '' : 'es'} on the remote`,
          initial: false,
        }
      : undefined,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'delete', label: `Delete ${list.length} branches`, danger: true },
    ],
  });
  if (!pick || pick.value !== 'delete') return;
  const branches = list.map((r) => {
    const up = upstreamShort(r);
    const split = pick.checked && up ? splitRemoteBranch(up, remotes) : null;
    return {
      name: r.shortName,
      ...(split ? { deleteRemote: { remote: split[0], remoteBranch: split[1] } } : {}),
    };
  });
  try {
    await runOp(
      repoId,
      { type: 'branch.delete', branches, force: false },
      { handled: ['BranchNotFullyMerged'], successToast: `Deleted ${branches.length} branches` },
    );
  } catch (e) {
    if (e instanceof IpcError && e.code === 'BranchNotFullyMerged') {
      const force = await confirm(
        'Some branches are not fully merged',
        `${e.message} Delete them anyway?`,
        'Force delete',
        true,
      );
      if (force)
        quiet(
          runOp(
            repoId,
            { type: 'branch.delete', branches, force: true },
            { successToast: `Deleted ${branches.length} branches` },
          ),
        );
    }
  }
}
