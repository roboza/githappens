import type { QueryClient } from '@tanstack/react-query';

import type { RepoGroup } from '../../../../shared/ipc/repos2-contract';
import type { RepoRecord } from '../../../../shared/ipc/shell-contract';
import type { MenuEntry } from '../../components/ContextMenu';
import { prompt } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import {
  copyFullPath,
  openInEditor,
  openInTerminal,
  showInFolder,
  showInFolderLabel,
} from '../../tools/actions';
import { errorText, reposInvoke } from './api';
import { openRepoWithRecovery } from './open-flow';
import { normPath } from './repo-groups';

export const REPOS_QUERY_KEY = ['repos:state'] as const;

export function refreshRepos(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: REPOS_QUERY_KEY });
  void qc.invalidateQueries({ queryKey: ['repos:list'] });
}

const fail = (title: string) => (e: unknown) =>
  useToastStore.getState().push({ kind: 'error', title, body: errorText(e) });

/** Open in a new tab even when the repo already has one (spec 03 §4.3 "Open in new tab"). */
export async function openInNewTab(path: string): Promise<void> {
  const tabs = useTabsStore.getState();
  const existing = tabs.tabs.find(
    (t) => t.kind === 'repo' && t.repoPath && normPath(t.repoPath) === normPath(path),
  );
  if (existing) tabs.duplicate(existing.id);
  else await openRepoWithRecovery(path);
}

/** "Locate…" for a missing repo: pick its new folder, keep alias + favorite, drop the stale entry. */
export async function locateRepo(r: RepoRecord, qc: QueryClient): Promise<void> {
  const dir = await invoke('repos:pickFolder', {});
  if (!dir) return;
  const ok = await openRepoWithRecovery(dir);
  if (!ok) return;
  try {
    const v = await reposInvoke('repos:validate', { path: dir });
    const newPath = v.ok ? v.repo.path : dir;
    if (normPath(newPath) !== normPath(r.path)) {
      if (r.alias) await invoke('repos:setAlias', { path: newPath, alias: r.alias });
      if (r.favorite) await invoke('repos:setFavorite', { path: newPath, favorite: true });
      await invoke('repos:removeRecent', { path: r.path });
    }
  } catch (e) {
    fail('Could not update the repository list')(e);
  }
  refreshRepos(qc);
}

export async function renameAlias(r: RepoRecord, qc: QueryClient): Promise<void> {
  const res = await prompt({
    title: 'Rename repository',
    label: 'Display name (leave empty to use the folder name)',
    initial: r.alias ?? r.name,
    okLabel: 'Rename',
  });
  if (!res) return;
  const alias = res.value.trim();
  await invoke('repos:setAlias', { path: r.path, alias: alias && alias !== r.name ? alias : null }).catch(
    fail('Could not rename'),
  );
  refreshRepos(qc);
}

export function repoRowMenu(
  r: RepoRecord,
  o: { qc: QueryClient; groups: RepoGroup[]; isOpen: boolean; showDetails(): void },
): MenuEntry[] {
  const { qc } = o;
  if (r.missing) {
    return [
      { label: 'Locate…', onSelect: () => void locateRepo(r, qc) },
      { label: 'Copy path', onSelect: () => void copyFullPath(r.path) },
      'separator',
      {
        label: 'Remove from list',
        danger: true,
        onSelect: () =>
          void invoke('repos:removeRecent', { path: r.path }).then(
            () => refreshRepos(qc),
            fail('Could not remove'),
          ),
      },
    ];
  }
  const custom = o.groups.filter((g) => g.kind === 'custom');
  return [
    {
      label: o.isOpen ? 'Switch to tab' : 'Open',
      onSelect: () => void openRepoWithRecovery(r.path).then(() => refreshRepos(qc)),
    },
    { label: 'Open in new tab', onSelect: () => void openInNewTab(r.path).then(() => refreshRepos(qc)) },
    { label: 'Show details', onSelect: o.showDetails },
    'separator',
    { label: showInFolderLabel(), onSelect: () => void showInFolder(r.path) },
    { label: 'Open in terminal', onSelect: () => void openInTerminal(r.path) },
    { label: 'Open in editor', onSelect: () => void openInEditor(r.path) },
    { label: 'Copy path', onSelect: () => void copyFullPath(r.path) },
    'separator',
    {
      label: r.favorite ? 'Remove from favorites' : 'Add to favorites',
      onSelect: () =>
        void invoke('repos:setFavorite', { path: r.path, favorite: !r.favorite }).then(
          () => refreshRepos(qc),
          fail('Could not update favorites'),
        ),
    },
    ...custom.map((g): MenuEntry => {
      const member = (r.groupIds ?? []).includes(g.id);
      return {
        label: member ? `Remove from "${g.name}"` : `Add to "${g.name}"`,
        onSelect: () =>
          void reposInvoke('repos:groups:assign', { path: r.path, groupId: g.id, member: !member }).then(
            () => refreshRepos(qc),
            fail('Could not update the group'),
          ),
      };
    }),
    { label: 'Rename alias…', onSelect: () => void renameAlias(r, qc) },
    'separator',
    {
      label: 'Remove from list',
      danger: true,
      onSelect: () =>
        void invoke('repos:removeRecent', { path: r.path }).then(
          () => refreshRepos(qc),
          fail('Could not remove'),
        ),
    },
  ];
}
