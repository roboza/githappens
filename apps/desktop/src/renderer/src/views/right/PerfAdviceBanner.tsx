import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { invoke, IpcError } from '../../lib/api';
import { showError } from '../../lib/ops';
import s2 from './StagingPanel.module.css';

/**
 * Huge-worktree offer (spec 02 §6.15.2): over 50k tracked files, offer `core.fsmonitor=true` (builtin
 * daemon, git ≥ 2.37 on Windows/macOS) and `core.untrackedCache=true`. A custom fsmonitor hook is never
 * replaced. "Not now" hides it for this session.
 */
export function PerfAdviceBanner({ repoId }: { repoId: RepoId }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const advice = useQuery({
    queryKey: ['perfAdvice', repoId],
    queryFn: () => invoke('git:perf:advice', { repoId }),
    staleTime: Infinity,
    retry: false,
  });
  const offer = advice.data?.offer;
  if (hidden || !offer || (!offer.fsmonitor && !offer.untrackedCache)) return null;
  const what = [offer.fsmonitor && 'the file system monitor', offer.untrackedCache && 'the untracked cache']
    .filter(Boolean)
    .join(' and ');
  const enable = async (): Promise<void> => {
    setBusy(true);
    try {
      if (offer.fsmonitor)
        await invoke('git:config:set', { repoId, key: 'core.fsmonitor', value: 'true', scope: 'local' });
      if (offer.untrackedCache)
        await invoke('git:config:set', { repoId, key: 'core.untrackedCache', value: 'true', scope: 'local' });
      setHidden(true);
      void advice.refetch();
    } catch (e) {
      if (e instanceof IpcError) showError(e.error, { repoId });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s2.banner} role="region" aria-label="Large repository performance">
      Large repository ({advice.data!.trackedFiles.toLocaleString()} files): enable {what} for faster status?{' '}
      <button type="button" disabled={busy} onClick={() => void enable()}>
        Enable
      </button>{' '}
      <button type="button" onClick={() => setHidden(true)}>
        Not now
      </button>
    </div>
  );
}
