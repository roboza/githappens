import type { GitOperation } from '@githappens/git/ops';
import type { WorktreeInfo } from '@githappens/git/types';

/** Pure Create / Remove Worktree helpers (spec 09 §4.3, §6.10). */

export type WorktreeMode = 'existing' | 'new' | 'detached';
export type OpenAfter = 'current' | 'new' | 'none';

export interface WorktreeForm {
  mode: WorktreeMode;
  /** Existing local branch (mode `existing`). */
  branch: string;
  /** New branch name (mode `new`). */
  newBranch: string;
  /** Start point for `new` / commit for `detached` (default HEAD). */
  startPoint: string;
  path: string;
  open: OpenAfter;
}

/** Folder-safe slug of a branch name (`feature/x` → `feature-x`). */
export function branchSlug(name: string): string {
  return (
    name
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'worktree'
  );
}

/** Default path `<repoParent>/<repoName>.worktrees/<branchSlug>` (spec 09 §4.3, inferred). */
export function defaultWorktreePath(repoRoot: string | null, label: string): string {
  if (!repoRoot) return '';
  const sep = repoRoot.includes('\\') ? '\\' : '/';
  const trimmed = repoRoot.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const parent = i >= 0 ? trimmed.slice(0, i) : '';
  const name = i >= 0 ? trimmed.slice(i + 1) : trimmed;
  return `${parent}${parent ? sep : ''}${name}.worktrees${sep}${branchSlug(label)}`;
}

/** The label the default path is derived from for the current form. */
export function pathLabel(f: WorktreeForm): string {
  if (f.mode === 'existing') return f.branch;
  if (f.mode === 'new') return f.newBranch;
  return `detached-${(f.startPoint || 'HEAD').replace(/^refs\/(heads|tags|remotes)\//, '')}`;
}

/**
 * Validate the form and build the `worktree.add` op. `branches` are local branch short names,
 * `checkedOut` the ones checked out in some worktree (git refuses those).
 */
export function buildWorktreeAddOp(
  f: WorktreeForm,
  branches: readonly string[],
  checkedOut: readonly string[],
): { op: Extract<GitOperation, { type: 'worktree.add' }> } | { error: string } {
  const p = f.path.trim();
  if (!p) return { error: 'Choose a folder for the worktree.' };
  if (/[\0\r\n]/.test(p)) return { error: 'Invalid folder.' };
  if (f.mode === 'existing') {
    const b = f.branch.trim();
    if (!b) return { error: 'Choose a branch.' };
    if (!branches.includes(b)) return { error: `Branch ${b} does not exist.` };
    if (checkedOut.includes(b))
      return { error: `${b} is already checked out in a worktree. Create a new branch from it instead.` };
    return { op: { type: 'worktree.add', path: p, branch: b } };
  }
  if (f.mode === 'new') {
    const b = f.newBranch.trim();
    if (!b) return { error: 'Enter a name for the new branch.' };
    if (branches.includes(b)) return { error: `A branch named ${b} already exists.` };
    const start = f.startPoint.trim();
    return { op: { type: 'worktree.add', path: p, newBranch: b, ...(start ? { startPoint: start } : {}) } };
  }
  const start = f.startPoint.trim() || 'HEAD';
  return { op: { type: 'worktree.add', path: p, detach: true, startPoint: start } };
}

/** Row label: branch name, or `detached @ abc1234` (spec 09 §4.1). */
export function worktreeLabel(w: Pick<WorktreeInfo, 'branch' | 'detached' | 'head' | 'path'>): string {
  if (w.branch) return w.branch.replace(/^refs\/heads\//, '');
  if (w.head) return `detached @ ${w.head.slice(0, 7)}`;
  return folderName(w.path);
}

export const folderName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;

/** Folder subtitle when it differs from the branch slug (spec 09 §4.1 "folder name subtitle"). */
export function worktreeSubtitle(w: Pick<WorktreeInfo, 'branch' | 'path'>): string | null {
  const folder = folderName(w.path);
  const b = w.branch?.replace(/^refs\/heads\//, '');
  return b && (folder === b || folder === branchSlug(b)) ? null : folder;
}

/** Filter: worktrees match on folder or branch (spec 09 §2 "Search matches folder or branch"). */
export function worktreeMatchText(w: Pick<WorktreeInfo, 'branch' | 'path' | 'head' | 'detached'>): string {
  return `${worktreeLabel(w)} ${folderName(w.path)}`;
}

/** Remove-worktree plan: force when dirty or locked; branch deletion as a follow-up op. */
export function removePlan(
  w: Pick<WorktreeInfo, 'path' | 'branch' | 'locked'>,
  status: { changed: number },
  deleteBranch: boolean,
): {
  op: Extract<GitOperation, { type: 'worktree.remove' }>;
  needsForce: boolean;
  branch: string | null;
} {
  const needsForce = status.changed > 0 || !!w.locked;
  return {
    op: { type: 'worktree.remove', path: w.path, ...(needsForce ? { force: true } : {}) },
    needsForce,
    branch: deleteBranch && w.branch ? w.branch.replace(/^refs\/heads\//, '') : null,
  };
}
