import type { RepoId } from '@githappens/git/types';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { invoke } from '../../lib/api';
import { remotesInvoke } from '../remotes/remotes-ipc';
import { lfsMatcher } from './lfs-model';

/** Shares the toolbar's `['lfsStatus', repoId]` query (invalidated by the `config` refresh scope). */
export const useLfsStatus = (repoId: RepoId, enabled = true) =>
  useQuery({
    queryKey: ['lfsStatus', repoId],
    queryFn: () => invoke('git:lfs:status', { repoId }),
    enabled,
    staleTime: 15_000,
  });

export const lfsLocksKey = (repoId: RepoId) => ['lfsLocks', repoId] as const;

/** `git lfs locks --verify` (network; on demand). */
export const useLfsLocks = (repoId: RepoId, enabled = true) =>
  useQuery({
    queryKey: lfsLocksKey(repoId),
    queryFn: () => remotesInvoke('git:lfs:locks', { repoId }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });

/**
 * `(path) => boolean`: whether a repo-relative path matches a tracked LFS pattern. For the staging
 * panel's "LFS" file badge (spec 09 §2 "Tracked files show an LFS tag in the commit panel").
 */
export function useLfsMatcher(repoId: RepoId): (path: string) => boolean {
  const tracked = useLfsStatus(repoId).data?.tracked;
  return useMemo(() => lfsMatcher(tracked ?? []), [tracked]);
}

/** Map path → lock (for 🔒 markers); empty until locks were loaded. */
export function useLfsLockMap(repoId: RepoId, enabled = true) {
  const locks = useLfsLocks(repoId, enabled).data?.locks;
  return useMemo(() => new Map((locks ?? []).map((l) => [l.path, l])), [locks]);
}
