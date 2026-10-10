import type { RepoId } from '@githappens/git/types';

import type { MenuEntry } from '../../components/ContextMenu';
import { confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { getRepoGraphState, hideRef, soloRef } from '../graph/repo-graph-state';
import { openAddRemote, openEditRemote } from './dialog-store';
import { remoteWebUrl, type RemoteGroup } from './remote-model';

/** REMOTE section actions (spec 09 §4.1). */

export function fetchRemote(repoId: RepoId, remote: string): void {
  quiet(runOp(repoId, { type: 'fetch', remote }, { successToast: `Fetched ${remote}` }));
}

export async function removeRemote(repoId: RepoId, remote: string): Promise<void> {
  const ok = await confirm(
    `Remove remote ${remote}?`,
    'The remote and its remote-tracking branches are removed from this repository. Branches tracking it lose their upstream. Nothing is deleted on the server.',
    'Remove remote',
    true,
  );
  if (ok)
    quiet(
      runOp(repoId, { type: 'remote.remove', name: remote }, { successToast: `Removed remote ${remote}` }),
    );
}

const providerName = (url: string): string => {
  const host = /^https:\/\/([^/]+)/.exec(url)?.[1]?.toLowerCase() ?? '';
  if (host.includes('github')) return 'GitHub';
  if (host.includes('gitlab')) return 'GitLab';
  if (host.includes('bitbucket')) return 'Bitbucket';
  if (host.includes('azure') || host.includes('visualstudio')) return 'Azure DevOps';
  return host || 'provider';
};

/** Context menu of a remote row. */
export function remoteMenu(repoId: RepoId, g: RemoteGroup): MenuEntry[] {
  const url = g.remote?.fetchUrl ?? '';
  const web = url ? remoteWebUrl(url) : null;
  const glob = `refs/remotes/${g.name}/*`;
  const { vis } = getRepoGraphState(repoId);
  const hidden = vis.hidden.includes(glob);
  const solo = vis.solo.includes(glob);
  return [
    { label: `Fetch ${g.name}`, disabled: !g.remote, onSelect: () => fetchRemote(repoId, g.name) },
    {
      label: 'Edit remote…',
      disabled: !g.remote,
      onSelect: () => g.remote && openEditRemote(repoId, g.remote),
    },
    {
      label: 'Copy remote URL',
      disabled: !url,
      onSelect: () => void invoke('shell:copyText', { text: url }),
    },
    {
      label: web ? `Open on ${providerName(web)}` : 'Open on provider',
      disabled: !web,
      title: web ?? 'This remote has no web page',
      onSelect: () => web && void invoke('shell:openExternal', { url: web }),
    },
    'separator',
    {
      label: hidden ? `Show ${g.name} in graph` : `Hide ${g.name}`,
      onSelect: () => hideRef(repoId, glob, !hidden),
    },
    { label: solo ? `Unsolo ${g.name}` : `Solo ${g.name}`, onSelect: () => soloRef(repoId, glob, !solo) },
    'separator',
    { label: 'Add remote…', onSelect: () => openAddRemote(repoId) },
    {
      label: `Remove remote ${g.name}…`,
      danger: true,
      disabled: !g.remote,
      onSelect: () => void removeRemote(repoId, g.name),
    },
  ];
}

/** Extra entries of the REMOTE section header menu. */
export function remoteSectionItems(repoId: RepoId): MenuEntry[] {
  return [
    { label: 'Add remote…', onSelect: () => openAddRemote(repoId) },
    {
      label: 'Fetch all remotes',
      onSelect: () =>
        quiet(runOp(repoId, { type: 'fetch', remote: 'all' }, { successToast: 'Fetched all remotes' })),
    },
  ];
}
