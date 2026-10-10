import type { RepoId } from '@githappens/git/types';
import type { Issue, IssueRef, TrackerKind } from '@githappens/providers/types';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useSession } from '../../repo/sessions';
import { useTabsStore } from '../../stores/tabs';

/**
 * UI state of the issue panel + dialogs (spec 10 §4.9). They render in their own React root (see
 * IssueHost.tsx) so they can be opened from menus, graph badges and the Launchpad without a host component
 * in the app shell.
 */

export interface DetailTarget {
  ref: IssueRef;
  /** Repo the panel was opened for (Create branch target); falls back to the active repo. */
  repoId?: RepoId;
}

export interface BranchRequest {
  repoId: RepoId;
  issue: Issue;
  integrationKey: string;
  /** Default base ref (current HEAD branch). */
  base: string;
  resolve: () => void;
}

export interface CreateIssueRequest {
  integrationKey: string;
  scope: string;
  trackerKind: TrackerKind | string;
  scopeLabel?: string;
  repoId?: RepoId;
}

interface IssueUiState {
  detail: DetailTarget | null;
  branch: BranchRequest | null;
  create: CreateIssueRequest | null;
}

export const useIssueUi = create<IssueUiState>(() => ({ detail: null, branch: null, create: null }));

// ---- QueryClient bridge: menus / actions run outside React but need the app's cache ----

let appQueryClient: QueryClient | null = null;
const listeners = new Set<(qc: QueryClient) => void>();

export function rememberQueryClient(qc: QueryClient): void {
  if (appQueryClient === qc) return;
  appQueryClient = qc;
  for (const l of listeners) l(qc);
}

export const rememberedQueryClient = (): QueryClient | null => appQueryClient;

export function onQueryClient(cb: (qc: QueryClient) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Components of the main tree call this so non-React code (menus) can read the query cache. */
export function useRememberQueryClient(): QueryClient {
  const qc = useQueryClient();
  useEffect(() => rememberQueryClient(qc), [qc]);
  return qc;
}

/** Repo of the active tab (when its session is ready). */
export function useActiveRepoId(): RepoId | undefined {
  const path = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.repoPath);
  const session = useSession(path);
  return session?.state === 'ready' ? session.repoId : undefined;
}
