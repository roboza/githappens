import { diffHash } from '@githappens/git/ops';
import type { DiffSpec, RepoId } from '@githappens/git/types';

import type { MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { quiet, runOp, showError } from '../../lib/ops';
import { IpcError } from '../../lib/api';
import { useToastStore } from '../../stores/toasts';
import { filesInvoke } from '../file/files-api';

/** The diff a commit file row stands for (same shape as the tools agent's `FileDiffContext`). */
interface CommitFileDiff {
  spec: DiffSpec;
  oldPath?: string;
  oldRev: string;
  newRev: string;
}

/** Revert/Checkout/Patch actions need a commit diff; returns its sha. */
const commitSha = (d: CommitFileDiff | undefined): string | null =>
  d?.spec.kind === 'commit' ? d.spec.sha : null;

/** "Checkout file at this commit" (spec 07 §2.3): index + worktree copy from that commit; undoable. */
export async function checkoutFileAt(repoId: RepoId, path: string, rev: string): Promise<void> {
  const ok = await confirm(
    'Checkout file at this commit?',
    `${path} in the working tree and index is replaced with its content at ${shortSha(rev)}. You can undo this.`,
    'Checkout file',
  );
  if (ok)
    quiet(
      runOp(
        repoId,
        { type: 'file.checkoutAt', rev, path },
        { successToast: `Checked out ${path} at ${shortSha(rev)}` },
      ),
    );
}

/** "Revert file changes from this commit": reverse-apply every hunk of the file's diff to the worktree. */
export async function revertFileChanges(repoId: RepoId, path: string, d: CommitFileDiff): Promise<void> {
  const paths = d.oldPath && d.oldPath !== path ? [d.oldPath, path] : [path];
  const spec = { ...d.spec, paths } as DiffSpec;
  const files = await invoke('git:diff', {
    repoId,
    spec,
    options: { contextLines: 3, ignoreWhitespace: 'none' },
  });
  const file = files.find((f) => f.newPath === path || f.oldPath === path);
  if (!file) return;
  quiet(
    runOp(
      repoId,
      {
        type: 'diff.revertHunk',
        spec: d.spec,
        path,
        ...(d.oldPath && d.oldPath !== path ? { oldPath: d.oldPath } : {}),
        hunkIndex: 'all',
        diffHash: diffHash(file),
        contextLines: 3,
      },
      { successToast: `Reverted the commit's changes to ${path} (unstaged). Undo with Ctrl+Z.` },
    ),
  );
}

/** "Create patch from file" (spec 07 §2.3): `format-patch` of that commit limited to the file. */
export async function savePatchForFile(repoId: RepoId, sha: string, paths: string[]): Promise<void> {
  try {
    const r = await filesInvoke('diff:savePatch', { repoId, sha, paths });
    if (r.saved) useToastStore.getState().push({ kind: 'success', title: 'Patch saved', body: r.path });
  } catch (e) {
    if (e instanceof IpcError) showError(e.error);
    else
      useToastStore.getState().push({ kind: 'error', title: 'Could not create the patch', body: String(e) });
  }
}

/** Commit-only file menu entries (spec 07 §2.3), inserted by `fileMenu` for commit diffs. */
export function commitFileMenuItems(
  repoId: RepoId,
  path: string,
  d: CommitFileDiff | undefined,
): MenuEntry[] {
  const sha = commitSha(d);
  if (!sha || !d) return [];
  const deleted = d.newRev === '';
  return [
    {
      label: 'Checkout file at this commit…',
      disabled: deleted,
      title: deleted ? 'The file was deleted in this commit' : undefined,
      onSelect: () => void checkoutFileAt(repoId, path, sha),
    },
    {
      label: 'Revert file changes from this commit',
      onSelect: () => void revertFileChanges(repoId, path, d),
    },
    {
      label: 'Create patch from file…',
      onSelect: () =>
        void savePatchForFile(repoId, sha, d.oldPath && d.oldPath !== path ? [d.oldPath, path] : [path]),
    },
  ];
}
