import type { RemoteInfo, RepoId } from '@githappens/git/types';
import { create } from 'zustand';

import type { WorktreeForm } from '../worktrees/worktree-model';

/**
 * Left-panel dialogs (Phase 8): Add/Edit Remote, Set Upstream, Create Worktree, Add Submodule,
 * Edit Submodule URL, LFS Locks. One open at a time; `<LeftDialogsHost/>` renders it.
 */
export type LeftDialog =
  | { kind: 'remote'; repoId: RepoId; edit?: RemoteInfo }
  | { kind: 'upstream'; repoId: RepoId; branch: string; current: string | null }
  | { kind: 'worktree'; repoId: RepoId; initial?: Partial<WorktreeForm> }
  | { kind: 'submodule'; repoId: RepoId }
  | { kind: 'submoduleUrl'; repoId: RepoId; path: string; url: string }
  | { kind: 'lfsLocks'; repoId: RepoId };

interface Store {
  current: LeftDialog | null;
  /** App-level hosts mounted (then the per-panel hosts stay inert). */
  globalHosts: number;
  open(d: LeftDialog): void;
  close(): void;
}

export const useLeftDialogs = create<Store>((set) => ({
  current: null,
  globalHosts: 0,
  open: (current) => set({ current }),
  close: () => set({ current: null }),
}));

export const openLeftDialog = (d: LeftDialog): void => useLeftDialogs.getState().open(d);
export const closeLeftDialog = (): void => useLeftDialogs.getState().close();

// Convenience openers (for menus, palette commands and other agents' views).
export const openAddRemote = (repoId: RepoId): void => openLeftDialog({ kind: 'remote', repoId });
export const openEditRemote = (repoId: RepoId, remote: RemoteInfo): void =>
  openLeftDialog({ kind: 'remote', repoId, edit: remote });
export const openSetUpstream = (repoId: RepoId, branch: string, current: string | null): void =>
  openLeftDialog({ kind: 'upstream', repoId, branch, current });
export const openCreateWorktree = (repoId: RepoId, initial?: Partial<WorktreeForm>): void =>
  openLeftDialog({ kind: 'worktree', repoId, initial });
export const openAddSubmodule = (repoId: RepoId): void => openLeftDialog({ kind: 'submodule', repoId });
export const openEditSubmoduleUrl = (repoId: RepoId, path: string, url: string): void =>
  openLeftDialog({ kind: 'submoduleUrl', repoId, path, url });
export const openLfsLocks = (repoId: RepoId): void => openLeftDialog({ kind: 'lfsLocks', repoId });
