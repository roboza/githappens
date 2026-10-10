import type { IpcResult, RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import type {
  ConflictReport,
  ConflictsEventContract,
  ConflictsIpcContract,
} from '../../../shared/ipc/conflicts-contract';
import { IpcError } from '../lib/api';
import { useSetting } from '../stores/settings';

/**
 * Typed access to the Conflict Prevention / Team IPC channels (spec 14 §5.4). Goes through `window.api`
 * like `invoke`/`on` in lib/api.ts, typed against the conflicts contract directly.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;
type LooseOn = (event: string, cb: (payload: unknown) => void) => () => void;

export type ConflictsChannel = keyof ConflictsIpcContract;

export async function conflictsInvoke<C extends ConflictsChannel>(
  channel: C,
  req: ConflictsIpcContract[C]['req'],
): Promise<ConflictsIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as ConflictsIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export function conflictsOn<E extends keyof ConflictsEventContract>(
  event: E,
  cb: (payload: ConflictsEventContract[E]) => void,
): () => void {
  return (window.api.on as unknown as LooseOn)(event, cb as (p: unknown) => void);
}

export const conflictsKey = (repoId: RepoId) => ['conflicts', repoId] as const;
export const teamStatusKey = ['team', 'status'] as const;
export const teamViewKey = (repoId: RepoId) => ['team', 'view', repoId] as const;

/** The repo's ConflictReport, kept current by `conflicts:updated` pushes from main. */
export function useConflictReport(repoId: RepoId) {
  const qc = useQueryClient();
  const settingsSig = [
    useSetting('conflicts.detectTarget'),
    useSetting('conflicts.includeWip'),
    useSetting('team.footprints'),
  ].join('|');
  useEffect(
    () =>
      conflictsOn('conflicts:updated', ({ repoId: changed, report }) => {
        if (changed === repoId) qc.setQueryData<ConflictReport>(conflictsKey(repoId), report);
      }),
    [qc, repoId],
  );
  // Main reads the settings itself; re-check when they change (not on mount).
  const lastSig = useRef(settingsSig);
  useEffect(() => {
    if (lastSig.current === settingsSig) return;
    lastSig.current = settingsSig;
    void qc.invalidateQueries({ queryKey: conflictsKey(repoId) });
  }, [qc, repoId, settingsSig]);
  return useQuery<ConflictReport>({
    queryKey: conflictsKey(repoId),
    queryFn: () => conflictsInvoke('conflicts:check', { repoId }),
    staleTime: Infinity,
    retry: false,
  });
}

export function useTeamStatus() {
  return useQuery({
    queryKey: teamStatusKey,
    queryFn: () => conflictsInvoke('team:status', {}),
    refetchInterval: 60_000,
  });
}

/** Team view for one repo; polled every 5 minutes while mounted (main makes no call when inactive). */
export function useTeamView(repoId: RepoId, enabled: boolean) {
  return useQuery({
    queryKey: teamViewKey(repoId),
    queryFn: () => conflictsInvoke('team:view', { repoId }),
    enabled,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}
