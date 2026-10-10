import type { RepoId, SubmoduleInfo } from '@githappens/git/types';

import type { MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { useTabsStore } from '../../stores/tabs';
import { openAddSubmodule, openEditSubmoduleUrl } from '../remotes/dialog-store';
import { openRepoInCurrentTab } from '../worktrees/worktree-actions';

/** SUBMODULES actions (spec 09 §4.1 "Open, Open in new tab, Initialize, Update, Update to latest remote, Edit URL…, Copy path, Delete…"). */

/** Absolute path of a submodule (paths are repo-relative, `/`-separated). */
export function submoduleAbsPath(repoRoot: string | null, rel: string): string {
  if (!repoRoot) return rel;
  const sep = repoRoot.includes('\\') ? '\\' : '/';
  return `${repoRoot.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}

function update(repoId: RepoId, m: SubmoduleInfo, remote: boolean): void {
  quiet(
    runOp(
      repoId,
      {
        type: 'submodule.update',
        paths: [m.path],
        init: true,
        recursive: true,
        ...(remote ? { remote: true } : {}),
      },
      { successToast: (r) => r.summary ?? `Updated ${m.path}` },
    ),
  );
}

async function remove(repoId: RepoId, m: SubmoduleInfo): Promise<void> {
  const ok = await confirm(
    `Delete submodule ${m.path}?`,
    'The submodule is deinitialized, removed from .gitmodules and the index, and its git directory is deleted. Commit the result to record the removal.',
    'Delete submodule',
    true,
  );
  if (ok)
    quiet(
      runOp(
        repoId,
        { type: 'submodule.remove', path: m.path },
        { successToast: `Removed submodule ${m.path}` },
      ),
    );
}

export function submoduleMenu(repoId: RepoId, m: SubmoduleInfo, repoRoot: string | null): MenuEntry[] {
  const abs = submoduleAbsPath(repoRoot, m.path);
  const uninit = m.state === 'uninitialized';
  return [
    { label: 'Open submodule', disabled: uninit, onSelect: () => void openRepoInCurrentTab(abs) },
    {
      label: 'Open submodule in a new tab',
      disabled: uninit,
      onSelect: () => void useTabsStore.getState().openRepo(abs),
    },
    'separator',
    uninit
      ? { label: 'Initialize & update', onSelect: () => update(repoId, m, false) }
      : { label: 'Update to recorded commit', onSelect: () => update(repoId, m, false) },
    {
      label: 'Update to latest remote',
      title: m.branch
        ? `git submodule update --remote (tracks ${m.branch})`
        : 'git submodule update --remote',
      onSelect: () => update(repoId, m, true),
    },
    { label: 'Edit URL…', onSelect: () => openEditSubmoduleUrl(repoId, m.path, m.url) },
    { label: 'Copy path', onSelect: () => void invoke('shell:copyText', { text: m.path }) },
    {
      label: 'Reveal in file manager',
      disabled: uninit,
      onSelect: () => void invoke('shell:openPath', { path: abs }),
    },
    'separator',
    { label: 'Delete submodule…', danger: true, onSelect: () => void remove(repoId, m) },
  ];
}

/** SUBMODULES section header menu entries. */
export function submoduleSectionItems(repoId: RepoId, hasItems: boolean): MenuEntry[] {
  return [
    { label: 'Add submodule…', onSelect: () => openAddSubmodule(repoId) },
    {
      label: 'Update all submodules',
      disabled: !hasItems,
      onSelect: () =>
        quiet(
          runOp(
            repoId,
            { type: 'submodule.update', init: true, recursive: true },
            { successToast: 'Updated submodules' },
          ),
        ),
    },
  ];
}
