import type { RepoId } from '@githappens/git/types';
import { useEffect } from 'react';
import { create } from 'zustand';

import type { AutoFetchState } from '../../../shared/ipc/behaviour-contract';
import { behaviourInvoke, behaviourOn } from './api';

interface AutoFetchStore {
  byRepo: Record<string, AutoFetchState>;
}

/** Latest `sync:autoFetch:state` per repo (spec 09 §6.2 step 6). */
export const useAutoFetchStore = create<AutoFetchStore>(() => ({ byRepo: {} }));

let subscribed = false;
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  behaviourOn('sync:autoFetch:state', (st) =>
    useAutoFetchStore.setState((s) => ({ byRepo: { ...s.byRepo, [st.repoId]: st } })),
  );
}

export function useAutoFetchState(repoId: RepoId | undefined): AutoFetchState | undefined {
  ensureSubscribed();
  const st = useAutoFetchStore((s) => (repoId ? s.byRepo[repoId] : undefined));
  useEffect(() => {
    if (!repoId || useAutoFetchStore.getState().byRepo[repoId]) return;
    behaviourInvoke('autofetch:state', { repoId })
      .then((r) => {
        if (r) useAutoFetchStore.setState((s) => ({ byRepo: { ...s.byRepo, [repoId]: r } }));
      })
      .catch(() => undefined);
  }, [repoId]);
  return st;
}

export const resumeAutoFetch = (repoId: RepoId): Promise<void> =>
  behaviourInvoke('autofetch:resume', { repoId });

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

/** One-line description for the Fetch / Pull button tooltip. */
export function describeAutoFetch(st: AutoFetchState | undefined, now = Date.now()): string {
  if (!st) return '';
  if (!st.enabled) return 'Auto-fetch is off';
  const parts: string[] = [];
  if (st.paused) parts.push('Auto-fetch paused: authentication required');
  else if (st.running) parts.push('Auto-fetching…');
  else if (st.nextFetchAt) parts.push(`Next auto-fetch in ${ago(st.nextFetchAt - now)}`);
  if (st.lastFetchAt) parts.push(`last fetched ${ago(now - st.lastFetchAt)} ago`);
  if (st.lastError && !st.paused) {
    parts.push(
      `last attempt failed (${st.lastError.message})${st.failures > 1 ? `, retrying with backoff` : ''}`,
    );
  }
  return parts.join(' · ');
}
