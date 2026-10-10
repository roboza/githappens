import type { RepoId } from '@githappens/git/types';
import { useEffect } from 'react';

import { LfsLocksDialog } from '../lfs/LfsLocksDialog';
import { AddSubmoduleDialog, SubmoduleUrlDialog } from '../submodules/SubmoduleDialogs';
import { WorktreeDialog } from '../worktrees/WorktreeDialog';
import { useLeftDialogs } from './dialog-store';
import { RemoteDialog } from './RemoteDialog';
import { UpstreamDialog } from './UpstreamDialog';

/**
 * Renders the open left-panel dialog (Add/Edit Remote, Set Upstream, Create Worktree, Add Submodule,
 * Edit Submodule URL, LFS Locks).
 *
 * Mount once app-wide as `<LeftDialogsHost />` (recommended, App.tsx). Each LeftPanel also mounts a
 * scoped `<LeftDialogsHost repoId={…} />` that only renders while no app-wide host exists and the dialog
 * belongs to its repo.
 */
export function LeftDialogsHost({ repoId }: { repoId?: RepoId }) {
  const current = useLeftDialogs((s) => s.current);
  const globalHosts = useLeftDialogs((s) => s.globalHosts);
  const close = useLeftDialogs((s) => s.close);
  const global = repoId === undefined;
  useEffect(() => {
    if (!global) return;
    useLeftDialogs.setState((s) => ({ globalHosts: s.globalHosts + 1 }));
    return () => useLeftDialogs.setState((s) => ({ globalHosts: s.globalHosts - 1 }));
  }, [global]);
  if (!current) return null;
  if (!global && (globalHosts > 0 || current.repoId !== repoId)) return null;
  const key = `${current.kind}:${current.repoId}`;
  switch (current.kind) {
    case 'remote':
      return <RemoteDialog key={key} repoId={current.repoId} edit={current.edit} onClose={close} />;
    case 'upstream':
      return (
        <UpstreamDialog
          key={key}
          repoId={current.repoId}
          branch={current.branch}
          current={current.current}
          onClose={close}
        />
      );
    case 'worktree':
      return <WorktreeDialog key={key} repoId={current.repoId} initial={current.initial} onClose={close} />;
    case 'submodule':
      return <AddSubmoduleDialog key={key} repoId={current.repoId} onClose={close} />;
    case 'submoduleUrl':
      return (
        <SubmoduleUrlDialog
          key={key}
          repoId={current.repoId}
          path={current.path}
          url={current.url}
          onClose={close}
        />
      );
    case 'lfsLocks':
      return <LfsLocksDialog key={key} repoId={current.repoId} onClose={close} />;
  }
}
