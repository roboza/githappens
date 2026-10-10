import type { RepoId, WorktreeInfo } from '@githappens/git/types';

import type { MenuEntry } from '../../components/ContextMenu';
import { choose, confirm, prompt } from '../../components/Dialogs';
import { invoke, IpcError } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import { openCreateWorktree } from '../remotes/dialog-store';
import { remotesInvoke } from '../remotes/remotes-ipc';
import { folderName, removePlan, type OpenAfter } from './worktree-model';
import { worktreeTerminalMenuItem } from '../agents/agent-actions';

/** Worktree actions (spec 09 §4.1 WORKTREES menu, §6.10). */

const samePath = (a?: string, b?: string): boolean =>
  !!a &&
  !!b &&
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
    b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Open a repository in the active tab (replacing its repo) — "Open this worktree" / "Back to parent".
 * Falls back to activating an existing tab of that path.
 */
export async function openRepoInCurrentTab(path: string): Promise<boolean> {
  let result;
  try {
    result = await invoke('repos:open', { path });
  } catch (e) {
    const msg = e instanceof IpcError ? e.error.message : (e as Error).message;
    useToastStore.getState().push({ kind: 'error', title: 'Could not open repository', body: msg });
    return false;
  }
  if (!result.ok) {
    useToastStore
      .getState()
      .push({ kind: 'error', title: 'Could not open repository', body: result.message });
    return false;
  }
  const repo = result.repo;
  const { tabs, activeTabId } = useTabsStore.getState();
  const existing = tabs.find((t) => t.kind === 'repo' && samePath(t.repoPath, repo.path));
  if (existing) {
    useTabsStore.setState({ activeTabId: existing.id });
    return true;
  }
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active || (active.kind !== 'repo' && active.kind !== 'newTab'))
    return useTabsStore.getState().openRepo(repo.path);
  // a fresh id remounts the repo view for the new path
  const id = crypto.randomUUID();
  useTabsStore.setState({
    tabs: tabs.map((t) =>
      t.id === active.id ? { id, kind: 'repo', repoPath: repo.path, worktreeOf: repo.commonDir } : t,
    ),
    activeTabId: id,
  });
  return true;
}

export function openWorktree(path: string, where: OpenAfter): void {
  if (where === 'none') return;
  if (where === 'current') void openRepoInCurrentTab(path);
  else void useTabsStore.getState().openRepo(path);
}

async function deleteBranchAfter(repoId: RepoId, branch: string): Promise<void> {
  const op = { type: 'branch.delete' as const, branches: [{ name: branch }], force: false };
  try {
    await runOp(repoId, op, { handled: ['BranchNotFullyMerged'], successToast: `Deleted branch ${branch}` });
  } catch (e) {
    if (e instanceof IpcError && e.code === 'BranchNotFullyMerged') {
      const force = await confirm(
        'Branch is not fully merged',
        `${branch} has commits that are not merged into the current branch. Delete it anyway?`,
        'Force delete',
        true,
      );
      if (force) quiet(runOp(repoId, { ...op, force: true }, { successToast: `Deleted branch ${branch}` }));
    }
  }
}

/** Remove a worktree (dirty → force confirm), optionally deleting its branch (spec 09 §4.3 Remove Worktree). */
export async function removeWorktree(repoId: RepoId, wt: WorktreeInfo, deleteBranch: boolean): Promise<void> {
  let changed = 0;
  try {
    changed = (await remotesInvoke('git:worktree:status', { repoId, path: wt.path })).changed;
  } catch {
    /* unreadable worktree (e.g. folder gone): nothing to lose */
  }
  const plan = removePlan(wt, { changed }, deleteBranch);
  const name = folderName(wt.path);
  const notes = [
    changed > 0
      ? `It has ${changed} uncommitted change${changed === 1 ? '' : 's'} that will be discarded.`
      : 'The worktree folder will be deleted.',
    wt.locked ? `It is locked${typeof wt.locked === 'string' ? ` (${wt.locked})` : ''}.` : '',
    plan.branch ? `The branch ${plan.branch} will be deleted too.` : wt.branch ? 'Its branch is kept.' : '',
  ].filter(Boolean);
  const pick = await choose({
    title: `Remove worktree ${name}?`,
    message: notes.join(' '),
    choices: [
      { value: 'cancel', label: 'Cancel' },
      {
        value: 'remove',
        label: plan.needsForce ? 'Force remove' : plan.branch ? 'Remove and delete branch' : 'Remove',
        danger: true,
      },
    ],
  });
  if (pick?.value !== 'remove') return;
  try {
    await runOp(repoId, plan.op, { successToast: `Removed worktree ${name}` });
  } catch {
    return;
  }
  if (plan.branch) await deleteBranchAfter(repoId, plan.branch);
}

export function pruneWorktrees(repoId: RepoId): void {
  quiet(
    runOp(
      repoId,
      { type: 'worktree.prune' },
      {
        successToast: (r) => {
          const pruned = (r.data as { pruned?: string[] } | undefined)?.pruned ?? [];
          return pruned.length ? `${r.summary}: ${pruned.join(', ')}` : (r.summary ?? 'Pruned worktrees');
        },
      },
    ),
  );
}

async function lockWorktree(repoId: RepoId, wt: WorktreeInfo): Promise<void> {
  const r = await prompt({
    title: `Lock worktree ${folderName(wt.path)}`,
    label: 'Reason (optional)',
    okLabel: 'Lock',
    validate: (v) => (/[\r\n]/.test(v) ? 'Use a single line.' : null),
  });
  if (r)
    quiet(
      runOp(repoId, {
        type: 'worktree.lock',
        path: wt.path,
        ...(r.value.trim() ? { reason: r.value.trim() } : {}),
      }),
    );
}

export function worktreeMenu(repoId: RepoId, wt: WorktreeInfo): MenuEntry[] {
  const branch = wt.branch?.replace(/^refs\/heads\//, '');
  return [
    { label: 'Open this worktree', disabled: wt.isCurrent, onSelect: () => openWorktree(wt.path, 'current') },
    {
      label: 'Open worktree in a new tab',
      disabled: wt.isCurrent,
      onSelect: () => openWorktree(wt.path, 'new'),
    },
    { label: 'Reveal in file manager', onSelect: () => void invoke('shell:openPath', { path: wt.path }) },
    worktreeTerminalMenuItem(repoId, wt.path),
    { label: 'Copy path', onSelect: () => void invoke('shell:copyText', { text: wt.path }) },
    'separator',
    wt.locked
      ? { label: 'Unlock', onSelect: () => quiet(runOp(repoId, { type: 'worktree.unlock', path: wt.path })) }
      : { label: 'Lock…', onSelect: () => void lockWorktree(repoId, wt) },
    {
      label: 'Create worktree from here…',
      disabled: !wt.head,
      onSelect: () => openCreateWorktree(repoId, { mode: 'new', startPoint: branch ?? wt.head ?? 'HEAD' }),
    },
    'separator',
    {
      label: 'Remove this worktree…',
      danger: true,
      disabled: wt.isMain || wt.isCurrent,
      title: wt.isMain
        ? 'The main worktree cannot be removed'
        : wt.isCurrent
          ? 'Open another worktree first'
          : undefined,
      onSelect: () => void removeWorktree(repoId, wt, false),
    },
    {
      label: branch ? `Remove worktree and delete ${branch}…` : 'Remove worktree and delete branch…',
      danger: true,
      disabled: wt.isMain || wt.isCurrent || !branch,
      onSelect: () => void removeWorktree(repoId, wt, true),
    },
  ];
}

/** WORKTREES section header menu entries. */
export function worktreeSectionItems(repoId: RepoId): MenuEntry[] {
  return [
    { label: 'Create worktree…', onSelect: () => openCreateWorktree(repoId) },
    { label: 'Prune stale worktrees', onSelect: () => pruneWorktrees(repoId) },
  ];
}
