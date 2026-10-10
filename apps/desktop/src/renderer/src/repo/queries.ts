import type { RepoId } from '@githappens/git/types';
import { useQuery, type QueryClient } from '@tanstack/react-query';

import type { RefreshScope } from '../../../shared/ipc/git-contract';
import { invoke, on } from '../lib/api';
import { useRepoUiStore } from '../stores/repo-ui';

/** Query keys per repo; refresh scopes map onto them (spec 02 §5.3 `git:repo:changed`). */
export const qk = {
  info: (r: RepoId) => ['repoInfo', r] as const,
  refs: (r: RepoId) => ['refs', r] as const,
  status: (r: RepoId) => ['status', r] as const,
  stashes: (r: RepoId) => ['stashes', r] as const,
  remotes: (r: RepoId) => ['remotes', r] as const,
  commit: (r: RepoId, sha: string) => ['commit', r, sha] as const,
  diff: (r: RepoId, key: string) => ['diff', r, key] as const,
  numstat: (r: RepoId, key: string) => ['numstat', r, key] as const,
  file: (r: RepoId, rev: string, path: string) => ['file', r, rev, path] as const,
};

const SCOPE_KEYS: Partial<Record<RefreshScope, (r: RepoId) => readonly unknown[][]>> = {
  status: (r) => [[...qk.status(r)], ['diff', r], ['numstat', r]],
  // Worktree rows show each worktree's branch, which moves with checkouts.
  refs: (r) => [[...qk.refs(r)], [...qk.info(r)], ['worktrees', r]],
  stash: (r) => [[...qk.stashes(r)]],
  repoState: (r) => [[...qk.info(r)], ['conflictState', r]],
  remotes: (r) => [[...qk.remotes(r)]],
  config: (r) => [[...qk.remotes(r)], ['lfsStatus', r]],
  submodules: (r) => [['submodules', r]],
  worktrees: (r) => [['worktrees', r]],
  conflicts: (r) => [['conflictState', r]],
};

const dirtyKeys = new WeakMap<QueryClient, Set<string>>();

/**
 * Coalescing with reads (spec 02 §6.14): when a refresh of `key` is already in flight, mark it dirty and
 * re-run once after it completes instead of cancelling it and stacking another git process.
 */
export function invalidateCoalesced(qc: QueryClient, key: readonly unknown[]): void {
  if (qc.isFetching({ queryKey: key }) === 0) {
    void qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    return;
  }
  let dirty = dirtyKeys.get(qc);
  if (!dirty) dirtyKeys.set(qc, (dirty = new Set()));
  const id = JSON.stringify(key);
  if (dirty.has(id)) return;
  dirty.add(id);
  const unsubscribe = qc.getQueryCache().subscribe(() => {
    if (qc.isFetching({ queryKey: key }) > 0) return;
    unsubscribe();
    dirty.delete(id);
    void qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
  });
}

export function refreshScopes(qc: QueryClient, repoId: RepoId, scopes: RefreshScope[]): void {
  for (const scope of scopes) {
    for (const key of SCOPE_KEYS[scope]?.(repoId) ?? []) invalidateCoalesced(qc, key);
  }
  // Ref and stash changes reach the graph through the refs / stash queries above: it compares the visible
  // tip set and reloads history only when that changed, so a tag or branch created at an existing commit
  // just updates pills (spec 04 §6.10). A bare `graph` scope (no ref data involved) still reloads.
  if (scopes.includes('graph') && !scopes.includes('refs') && !scopes.includes('stash'))
    useRepoUiStore.getState().bumpGraph(repoId);
}

/** Wire watcher events to the query cache once per app. */
export function installRepoChangeListener(qc: QueryClient): () => void {
  return on('git:repo:changed', ({ repoId, scopes }) => refreshScopes(qc, repoId, scopes));
}

export const useRepoInfo = (repoId: RepoId) =>
  useQuery({ queryKey: qk.info(repoId), queryFn: () => invoke('git:repo:info', { repoId }) });

export const useRefs = (repoId: RepoId) =>
  useQuery({ queryKey: qk.refs(repoId), queryFn: () => invoke('git:refs', { repoId }) });

export const useStatus = (repoId: RepoId, enabled = true) =>
  useQuery({ queryKey: qk.status(repoId), queryFn: () => invoke('git:status', { repoId }), enabled });

export const useStashes = (repoId: RepoId) =>
  useQuery({ queryKey: qk.stashes(repoId), queryFn: () => invoke('git:stash:list', { repoId }) });

export const useRemotes = (repoId: RepoId) =>
  useQuery({ queryKey: qk.remotes(repoId), queryFn: () => invoke('git:remotes', { repoId }) });

export const useCommitDetail = (repoId: RepoId, sha: string | null) =>
  useQuery({
    queryKey: qk.commit(repoId, sha ?? ''),
    queryFn: () => invoke('git:commit:detail', { repoId, sha: sha! }),
    enabled: !!sha,
    staleTime: Infinity, // commits are immutable
  });
