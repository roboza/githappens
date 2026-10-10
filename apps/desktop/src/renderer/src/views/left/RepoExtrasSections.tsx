import type { RepoId, SubmoduleInfo, WorktreeInfo } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Boxes, FolderTree, GitBranch, Lock, Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { useContextMenu } from '../../components/ContextMenu';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { useTabsStore } from '../../stores/tabs';
import { openCreateWorktree } from '../remotes/dialog-store';
import { submoduleAbsPath, submoduleMenu } from '../submodules/submodule-actions';
import { submoduleStateLabel } from '../submodules/submodule-model';
import { openWorktree, worktreeMenu } from '../worktrees/worktree-actions';
import { worktreeLabel, worktreeSubtitle } from '../worktrees/worktree-model';
import styles from './LeftPanel.module.css';

/** Left-panel Submodules and Worktrees rows (spec 01 §4.5, spec 09 §4.1). */

export const useWorktrees = (repoId: RepoId) =>
  useQuery({ queryKey: ['worktrees', repoId], queryFn: () => invoke('git:worktrees', { repoId }) });
export const useSubmodules = (repoId: RepoId) =>
  useQuery({ queryKey: ['submodules', repoId], queryFn: () => invoke('git:submodules', { repoId }) });

export function SubmoduleRow({
  repoId,
  m,
  repoRoot,
  label,
}: {
  repoId: RepoId;
  m: SubmoduleInfo;
  repoRoot: string | null;
  label?: ReactNode;
}) {
  const showMenu = useContextMenu((s) => s.show);
  const openRepo = useTabsStore((s) => s.openRepo);
  const state = submoduleStateLabel(m.state);
  const sha = m.checkedOutSha ?? m.recordedSha;
  return (
    <div
      role="treeitem"
      tabIndex={0}
      className={styles.row}
      style={{ paddingLeft: 25 }}
      title={`${m.path}\n${m.url}${m.recordedSha ? `\nrecorded ${shortSha(m.recordedSha)}` : ''}${
        m.checkedOutSha && m.checkedOutSha !== m.recordedSha
          ? `\nchecked out ${shortSha(m.checkedOutSha)}`
          : ''
      }\n${state.text}`}
      onDoubleClick={() => m.state !== 'uninitialized' && void openRepo(submoduleAbsPath(repoRoot, m.path))}
      onKeyDown={(e) =>
        e.key === 'Enter' && m.state !== 'uninitialized' && void openRepo(submoduleAbsPath(repoRoot, m.path))
      }
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, submoduleMenu(repoId, m, repoRoot));
      }}
    >
      <Boxes size={13} />
      <span className={styles.name}>{label ?? m.path}</span>
      {sha && <span className={styles.track}>{shortSha(sha)}</span>}
      <span className={styles.stateIcon} data-state={m.state} aria-label={state.text} title={state.text}>
        {state.icon}
      </span>
    </div>
  );
}

export function WorktreeRow({ repoId, w, label }: { repoId: RepoId; w: WorktreeInfo; label?: ReactNode }) {
  const showMenu = useContextMenu((s) => s.show);
  const subtitle = worktreeSubtitle(w);
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-current={w.isCurrent || undefined}
      className={`${styles.row} ${w.isCurrent ? styles.current : ''}`}
      style={{ paddingLeft: 25 }}
      title={`${w.path}${w.locked ? `\nlocked${typeof w.locked === 'string' ? `: ${w.locked}` : ''}` : ''}${
        w.prunable ? `\nprunable${typeof w.prunable === 'string' ? `: ${w.prunable}` : ''}` : ''
      }${w.isCurrent ? '\n(current)' : ''}`}
      onDoubleClick={() => !w.isCurrent && openWorktree(w.path, 'current')}
      onKeyDown={(e) => e.key === 'Enter' && !w.isCurrent && openWorktree(w.path, 'current')}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, worktreeMenu(repoId, w));
      }}
    >
      {w.isMain ? <FolderTree size={13} /> : <GitBranch size={13} />}
      <span className={styles.name}>
        {label ?? worktreeLabel(w)}
        {subtitle && <span className={styles.subtitle}> {subtitle}</span>}
      </span>
      {w.isCurrent && <span className={styles.track}>current</span>}
      {w.prunable && <AlertTriangle size={12} aria-label="prunable" className={styles.warn} />}
      {w.locked && <Lock size={12} aria-label="locked" />}
    </div>
  );
}

/** "+" on the Worktrees header and the `worktree.create` palette command (spec 09 §4.3). */
export function createWorktree(repoId: RepoId, _repoRoot?: string | null): void {
  openCreateWorktree(repoId);
}

export function AddButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      className={styles.headerAdd}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          onClick();
        }
      }}
    >
      <Plus size={13} />
    </span>
  );
}
