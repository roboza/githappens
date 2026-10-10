import type { IpcResult, RepoId } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { GitflowIpcContract, GitflowState } from '../../../shared/ipc/gitflow-contract';
import { IpcError, on } from '../lib/api';

/**
 * Typed access to the Git Flow IPC channel (spec 12 §6.9). Goes through `window.api` like `invoke` in
 * lib/api.ts, typed against the gitflow contract directly. Mutations use `runOp` with `gitflow.*` ops.
 */

type LooseInvoke = (channel: string, req: unknown) => Promise<IpcResult<unknown>>;

export type GitflowChannel = keyof GitflowIpcContract;

export async function gitflowInvoke<C extends GitflowChannel>(
  channel: C,
  req: GitflowIpcContract[C]['req'],
): Promise<GitflowIpcContract[C]['res']> {
  const r = await (window.api.invoke as unknown as LooseInvoke)(channel, req);
  if (r.ok) return r.data as GitflowIpcContract[C]['res'];
  throw new IpcError(r.error);
}

export const gitflowKey = (repoId: RepoId) => ['gitflow', repoId] as const;

/** Git Flow config, flow branches and paused finish; refetched whenever refs/config/repo state change. */
export function useGitflow(repoId: RepoId) {
  const qc = useQueryClient();
  useEffect(
    () =>
      on('git:repo:changed', ({ repoId: changed, scopes }) => {
        if (changed !== repoId) return;
        if (scopes.some((s) => s === 'refs' || s === 'config' || s === 'repoState' || s === 'conflicts'))
          void qc.invalidateQueries({ queryKey: gitflowKey(repoId) });
      }),
    [qc, repoId],
  );
  return useQuery<GitflowState>({
    queryKey: gitflowKey(repoId),
    queryFn: () => gitflowInvoke('gitflow:get', { repoId }),
  });
}

/** Ask a mounted GitFlowSection to open the init dialog (command palette entry). */
export const GITFLOW_INIT_EVENT = 'kl:gitflow-init';
export function requestGitflowInit(repoId: RepoId): void {
  window.dispatchEvent(new CustomEvent(GITFLOW_INIT_EVENT, { detail: repoId }));
}

/** Ask a mounted GitFlowSection to show the inline start input for a flow type. */
export const GITFLOW_START_EVENT = 'kl:gitflow-start';
export function requestGitflowStart(repoId: RepoId, kind: 'feature' | 'release' | 'hotfix'): void {
  window.dispatchEvent(new CustomEvent(GITFLOW_START_EVENT, { detail: { repoId, kind } }));
}
