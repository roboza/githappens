import type { RepoId, RepoOperationState } from '@githappens/git/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { invoke, on } from '../../lib/api';
import type { ChunkState } from './merge-model';

/** Query keys owned by the conflict UI (spec 08). */
export const conflictKeys = {
  state: (r: RepoId) => ['conflictState', r] as const,
  file: (r: RepoId, path: string) => ['conflictFile', r, path] as const,
};

const STATE_SCOPES = new Set(['conflicts', 'repoState', 'status']);

/**
 * In-progress operation + conflicted files (`git:conflict:state`). Refreshes itself on
 * `git:repo:changed` events carrying the conflicts / repoState / status scopes.
 */
export function useConflictState(repoId: RepoId) {
  const qc = useQueryClient();
  useEffect(
    () =>
      on('git:repo:changed', (e) => {
        if (e.repoId === repoId && e.scopes.some((s) => STATE_SCOPES.has(s)))
          void qc.invalidateQueries({ queryKey: conflictKeys.state(repoId) });
      }),
    [qc, repoId],
  );
  return useQuery({
    queryKey: conflictKeys.state(repoId),
    queryFn: () => invoke('git:conflict:state', { repoId }),
  });
}

export type { RepoOperationState };

/** In-memory merge-tool session per repo/path, so reopening a file restores its picks (spec 08 §4.5). */
export interface MergeSession {
  /** `mergedDiff3` the session was built from; a different one invalidates it. */
  fingerprint: string;
  text: string;
  states: ChunkState[];
  regions: { start: number; end: number }[];
  dirty: boolean;
  /**
   * The working file when the session was built / last saved: a different file on disk means it was
   * changed outside the tool ("Load current file contents" vs "Start fresh", spec 08 §6.4).
   */
  working?: string | null;
}
const sessions = new Map<string, MergeSession>();
const generations = new Map<RepoId, number>();
/** Bumped by `clearMergeSessions`; an open tool only persists its session if unchanged. */
export const sessionGeneration = (repoId: RepoId): number => generations.get(repoId) ?? 0;
const skey = (repoId: RepoId, path: string): string => `${repoId}|${path}`;

export const getMergeSession = (repoId: RepoId, path: string): MergeSession | undefined =>
  sessions.get(skey(repoId, path));
export function setMergeSession(repoId: RepoId, path: string, s: MergeSession | null): void {
  if (s) sessions.set(skey(repoId, path), s);
  else sessions.delete(skey(repoId, path));
}
/** Paths with unsaved merge-tool output (abort guard, spec 08 §6.7). */
export function unsavedMergePaths(repoId: RepoId): string[] {
  const prefix = `${repoId}|`;
  return [...sessions]
    .filter(([k, v]) => k.startsWith(prefix) && v.dirty)
    .map(([k]) => k.slice(prefix.length));
}
/** Drop all sessions of a repo (after abort / continue). */
export function clearMergeSessions(repoId: RepoId): void {
  generations.set(repoId, sessionGeneration(repoId) + 1);
  const prefix = `${repoId}|`;
  for (const k of [...sessions.keys()]) if (k.startsWith(prefix)) sessions.delete(k);
}
