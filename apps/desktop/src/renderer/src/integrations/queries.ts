import type { RepoId } from '@githappens/git/types';
import type { IssueFilter, IssueRef, PrFilter, PrIndexEntry, RepoRef } from '@githappens/providers/types';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import type { CiRun } from '../../../shared/ipc/integrations-contract';

import { useToastStore } from '../stores/toasts';
import { intInvoke, intOn } from './api';
import { buildPrIndex, prFilterKey, refKey } from './helpers';
import { installIntegrationEventStores } from './stores';
import { IpcError } from '../lib/api';

/** TanStack Query keys (spec 10 §5.5). */
export const ik = {
  integrations: () => ['integrations'] as const,
  oauthAvailability: () => ['integrations', 'oauth'] as const,
  remotes: (repoId: RepoId) => ['provider', 'remotes', repoId] as const,
  owners: (key: string) => ['repos', key, '@owners'] as const,
  repos: (key: string, owner: string, query: string) => ['repos', key, owner, query] as const,
  prList: (repoId: RepoId, filter: PrFilter) => ['pr', 'list', repoId, prFilterKey(filter)] as const,
  pr: (ref: RepoRef, n: number) => ['pr', refKey(ref), ref.owner, ref.name, n] as const,
  timeline: (ref: RepoRef, n: number) => ['pr', 'timeline', refKey(ref), ref.owner, ref.name, n] as const,
  checks: (ref: RepoRef, sha: string) => ['pr', 'checks', refKey(ref), ref.owner, ref.name, sha] as const,
  prIndex: (repoId: RepoId) => ['pr', 'index', repoId] as const,
  templates: (repoId: RepoId, ref: RepoRef, branch: string) =>
    ['pr', 'templates', repoId, refKey(ref), ref.owner, ref.name, branch] as const,
  labels: (ref: RepoRef) => ['pr', 'labels', refKey(ref), ref.owner, ref.name] as const,
  issueScopes: (key: string) => ['issues', key, '@scopes'] as const,
  issues: (key: string, scope: string, filter: IssueFilter) =>
    ['issues', key, scope, `${filter.preset ?? ''}|${filter.query ?? ''}`] as const,
  issue: (key: string, scope: string, issueKey: string) =>
    ['issues', key, scope, '@issue', issueKey] as const,
  issueComments: (key: string, scope: string, issueKey: string) =>
    ['issues', key, scope, '@comments', issueKey] as const,
  issueTransitions: (key: string, scope: string, issueKey: string) =>
    ['issues', key, scope, '@transitions', issueKey] as const,
  issueLinks: (repoId: RepoId) => ['issues', '@links', repoId] as const,
  milestones: (ref: RepoRef) => ['pr', 'milestones', refKey(ref), ref.owner, ref.name] as const,
  prFilters: () => ['pr', 'filters'] as const,
  prCommits: (repoId: RepoId, base: string, head: string) => ['pr', 'commits', repoId, base, head] as const,
  conflictCheck: (repoId: RepoId, source: string, target: string) =>
    ['pr', 'conflicts', repoId, source, target] as const,
  ciRuns: (ref: RepoRef, branch: string) => ['ci', refKey(ref), ref.owner, ref.name, branch] as const,
  orgs: (key: string) => ['integrations', 'orgs', key] as const,
};

const NO_RETRY_CODES = new Set([
  'auth_required',
  'token_expired',
  'insufficient_scope',
  'rate_limited',
  'not_found',
  'forbidden_org_policy',
  'validation',
  'unsupported',
]);

/** Don't hammer providers on errors that won't fix themselves. */
export const providerRetry = (count: number, e: unknown): boolean => {
  if (e instanceof IpcError) {
    const code = e.error.details?.providerCode;
    if (typeof code === 'string' && NO_RETRY_CODES.has(code)) return false;
  }
  return count < 2;
};

const installedClients = new WeakSet<QueryClient>();
/** Event → cache wiring, once per QueryClient (auth changes, re-auth prompts). */
function ensureListeners(qc: QueryClient): void {
  installIntegrationEventStores();
  if (installedClients.has(qc)) return;
  installedClients.add(qc);
  intOn('auth:changed', ({ integrations }) => {
    qc.setQueryData(ik.integrations(), integrations);
    for (const key of [['provider'], ['pr'], ['repos'], ['issues']] as QueryKey[]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  });
  intOn('auth:reauthRequired', ({ integrationKey, reason }) => {
    const [kind, host] = integrationKey.split(':');
    useToastStore.getState().push({
      id: `reauth:${integrationKey}`, // one prompt per account, never repeated
      kind: 'warning',
      title: `Reconnect ${host ?? kind ?? 'account'}`,
      body: `${reason}\nOpen Preferences → Integrations to reconnect.`,
    });
  });
  intOn('pr:indexUpdated', ({ repoId, entries }) => qc.setQueryData(ik.prIndex(repoId), entries));
}

/** Call once in any component that uses integration data (cheap and idempotent). */
export function useIntegrationListeners(): void {
  const qc = useQueryClient();
  useEffect(() => ensureListeners(qc), [qc]);
}

export function useIntegrations() {
  useIntegrationListeners();
  return useQuery({
    queryKey: ik.integrations(),
    queryFn: () => intInvoke('auth:list', {}),
    staleTime: 60_000,
  });
}

export const useOAuthAvailability = () =>
  useQuery({
    queryKey: ik.oauthAvailability(),
    queryFn: () => intInvoke('auth:oauthAvailability', {}),
    staleTime: Infinity,
  });

export const useResolvedRemotes = (repoId: RepoId, enabled = true) =>
  useQuery({
    queryKey: ik.remotes(repoId),
    queryFn: () => intInvoke('provider:resolveRemotes', { repoId }),
    staleTime: 30_000,
    enabled,
  });

export const useOwners = (integrationKey: string | undefined) =>
  useQuery({
    queryKey: ik.owners(integrationKey ?? ''),
    queryFn: () => intInvoke('provider:listOwners', { integrationKey: integrationKey! }),
    enabled: !!integrationKey,
    staleTime: 5 * 60_000,
    retry: providerRetry,
  });

export const useRemoteRepos = (integrationKey: string | undefined, owner: string, query: string) =>
  useInfiniteQuery({
    queryKey: ik.repos(integrationKey ?? '', owner, query),
    queryFn: ({ pageParam }) =>
      intInvoke('provider:listRepos', {
        integrationKey: integrationKey!,
        owner: owner || undefined,
        query: query || undefined,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!integrationKey,
    staleTime: 2 * 60_000,
    retry: providerRetry,
  });

/** A refetch of data we already have counts as background polling (paused when the rate budget is low). */
const isBackground = (qc: QueryClient, key: QueryKey): boolean =>
  (qc.getQueryState(key)?.dataUpdatedAt ?? 0) > 0;

export const usePrList = (repoId: RepoId, filter: PrFilter, enabled = true) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ik.prList(repoId, filter),
    queryFn: () =>
      intInvoke('pr:list', { repoId, filter, background: isBackground(qc, ik.prList(repoId, filter)) }),
    enabled,
    staleTime: 30_000,
    refetchInterval: 120_000,
    retry: providerRetry,
  });
};

export const usePullRequest = (ref: RepoRef, number: number) =>
  useQuery({
    queryKey: ik.pr(ref, number),
    queryFn: () => intInvoke('pr:get', { ref, number }),
    staleTime: 15_000,
    retry: providerRetry,
    // Mergeability is computed lazily by GitHub: re-poll after 3 s, up to 5 times (spec 10 §8).
    refetchInterval: (q) =>
      q.state.data?.mergeable === 'unknown' && q.state.dataUpdateCount < 6 ? 3000 : false,
  });

export const usePrTimeline = (ref: RepoRef, number: number) =>
  useInfiniteQuery({
    queryKey: ik.timeline(ref, number),
    queryFn: ({ pageParam }) => intInvoke('pr:timeline', { ref, number, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    retry: providerRetry,
  });

export const usePrChecks = (ref: RepoRef, sha: string | undefined) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ik.checks(ref, sha ?? ''),
    queryFn: () =>
      intInvoke('pr:checks', { ref, sha: sha!, background: isBackground(qc, ik.checks(ref, sha ?? '')) }),
    enabled: !!sha,
    retry: providerRetry,
    refetchInterval: (q) =>
      q.state.data?.some((c) => c.status === 'queued' || c.status === 'in_progress') ? 15_000 : false,
  });
};

export const useIssueScopes = (integrationKey: string | undefined) =>
  useQuery({
    queryKey: ik.issueScopes(integrationKey ?? ''),
    queryFn: () => intInvoke('issues:scopes', { integrationKey: integrationKey! }),
    enabled: !!integrationKey,
    staleTime: 5 * 60_000,
    retry: providerRetry,
  });

export const useIssues = (
  integrationKey: string | undefined,
  scope: string | undefined,
  filter: IssueFilter,
) =>
  useInfiniteQuery({
    queryKey: ik.issues(integrationKey ?? '', scope ?? '', filter),
    queryFn: ({ pageParam }) =>
      intInvoke('issues:list', { integrationKey: integrationKey!, scope: scope!, filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!integrationKey && !!scope,
    staleTime: 60_000,
    retry: providerRetry,
  });

const EMPTY_ENTRIES: PrIndexEntry[] = [];

/**
 * Branch → PR map for graph badges (spec 10 §4.6), kept fresh from `pr:index` + `pr:indexUpdated`.
 * Keys are branch short names: `feature/x` (local) and `origin/feature/x` (remote-tracking).
 */
export function usePrIndex(repoId: RepoId): Map<string, PrIndexEntry> {
  useIntegrationListeners();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ik.prIndex(repoId),
    queryFn: () => intInvoke('pr:index', { repoId, background: isBackground(qc, ik.prIndex(repoId)) }),
    staleTime: 60_000,
    retry: false,
  });
  const entries = q.data ?? EMPTY_ENTRIES;
  return useMemo(() => buildPrIndex(entries), [entries]);
}

/** Invalidate everything a PR mutation can affect. */
export function invalidatePr(qc: QueryClient, repoId: RepoId | null, ref: RepoRef, number: number): void {
  void qc.invalidateQueries({ queryKey: ik.pr(ref, number) });
  void qc.invalidateQueries({ queryKey: ik.timeline(ref, number) });
  void qc.invalidateQueries({ queryKey: ['pr', 'list'] });
  void qc.invalidateQueries({ queryKey: repoId ? ik.prIndex(repoId) : ['pr', 'index'] });
}

// ---- spec 10 phase-9 additions: PR editing lookups, filters, CI, issue detail, links ----

export const useMilestones = (ref: RepoRef | undefined, enabled = true) =>
  useQuery({
    queryKey: ref ? ik.milestones(ref) : ['pr', 'milestones', 'none'],
    queryFn: () => intInvoke('pr:milestones', { ref: ref! }),
    enabled: !!ref && enabled,
    staleTime: 30 * 60_000,
    retry: providerRetry,
  });

export const useLabels = (ref: RepoRef | undefined, enabled = true) =>
  useQuery({
    queryKey: ref ? ik.labels(ref) : ['pr', 'labels', 'none'],
    queryFn: () => intInvoke('pr:labels', { ref: ref! }),
    enabled: !!ref && enabled,
    staleTime: 30 * 60_000,
    retry: providerRetry,
  });

/** Custom PR filters of the active profile (`pr-filters.json`). */
export const usePrFilters = () =>
  useQuery({
    queryKey: ik.prFilters(),
    queryFn: () => intInvoke('pr:filters', {}),
    staleTime: Infinity,
  });

/** Local `git log base..head` (create-PR preview, PR Commits tab). */
export const usePrCommits = (repoId: RepoId, base: string | undefined, head: string | undefined) =>
  useQuery({
    queryKey: ik.prCommits(repoId, base ?? '', head ?? ''),
    queryFn: () => intInvoke('pr:commits', { repoId, base: base!, head: head! }),
    enabled: !!base && !!head,
    staleTime: 30_000,
    retry: false,
  });

export const useConflictCheck = (repoId: RepoId, source: string | undefined, target: string | undefined) =>
  useQuery({
    queryKey: ik.conflictCheck(repoId, source ?? '', target ?? ''),
    queryFn: () => intInvoke('pr:conflictCheck', { repoId, source: source!, target: target! }),
    enabled: !!source && !!target && source !== target,
    staleTime: 60_000,
    retry: false,
  });

const EMPTY_RUNS: CiRun[] = [];
/** CI runs (spec 10 §4.8): polled only while `enabled` (section expanded) — 60 s, 15 s while running. */
export function useCiRuns(ref: RepoRef | undefined, branch: string | undefined, enabled = true) {
  const qc = useQueryClient();
  const key: QueryKey = ref ? ik.ciRuns(ref, branch ?? '') : ['ci', 'none'];
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      intInvoke('ci:list', {
        ref: ref!,
        branch: branch || undefined,
        cursor: pageParam,
        background: !pageParam && isBackground(qc, key),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!ref && enabled,
    staleTime: 15_000,
    retry: providerRetry,
    refetchInterval: (q) =>
      (q.state.data?.pages.flatMap((p) => p.items) ?? EMPTY_RUNS).some(
        (r) => r.status === 'queued' || r.status === 'in_progress',
      )
        ? 15_000
        : 60_000,
  });
}

export const useIssue = (
  integrationKey: string | undefined,
  scope: string | undefined,
  key: string | undefined,
) =>
  useQuery({
    queryKey: ik.issue(integrationKey ?? '', scope ?? '', key ?? ''),
    queryFn: () => intInvoke('issues:get', { integrationKey: integrationKey!, scope: scope!, key: key! }),
    enabled: !!integrationKey && !!scope && !!key,
    staleTime: 30_000,
    retry: providerRetry,
  });

export const useIssueComments = (
  integrationKey: string | undefined,
  scope: string | undefined,
  key: string | undefined,
) =>
  useQuery({
    queryKey: ik.issueComments(integrationKey ?? '', scope ?? '', key ?? ''),
    queryFn: () =>
      intInvoke('issues:comments', { integrationKey: integrationKey!, scope: scope!, key: key! }),
    enabled: !!integrationKey && !!scope && !!key,
    staleTime: 30_000,
    retry: providerRetry,
  });

export const useIssueTransitions = (
  integrationKey: string | undefined,
  scope: string | undefined,
  key: string | undefined,
  enabled = true,
) =>
  useQuery({
    queryKey: ik.issueTransitions(integrationKey ?? '', scope ?? '', key ?? ''),
    queryFn: () =>
      intInvoke('issues:transitions', { integrationKey: integrationKey!, scope: scope!, key: key! }),
    enabled: !!integrationKey && !!scope && !!key && enabled,
    staleTime: 60_000,
    retry: providerRetry,
  });

const EMPTY_LINKS: Record<string, IssueRef> = {};
/** Branch → linked issue for every local branch (stored + inferred), for tracker icons on refs. */
export function useIssueLinks(repoId: RepoId | null | undefined): Record<string, IssueRef> {
  const q = useQuery({
    queryKey: ik.issueLinks(repoId ?? ''),
    queryFn: () => intInvoke('issues:links', { repoId: repoId! }),
    enabled: !!repoId,
    staleTime: 60_000,
    retry: false,
  });
  return q.data ?? EMPTY_LINKS;
}

export const useIntegrationOrgs = (integrationKey: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ik.orgs(integrationKey ?? ''),
    queryFn: () => intInvoke('auth:organizations', { integrationKey: integrationKey! }),
    enabled: !!integrationKey && enabled,
    staleTime: 5 * 60_000,
    retry: providerRetry,
  });

/** Invalidate everything an issue mutation can affect. */
export function invalidateIssue(qc: QueryClient, integrationKey: string, scope: string, key: string): void {
  void qc.invalidateQueries({ queryKey: ik.issue(integrationKey, scope, key) });
  void qc.invalidateQueries({ queryKey: ik.issueComments(integrationKey, scope, key) });
  void qc.invalidateQueries({ queryKey: ik.issueTransitions(integrationKey, scope, key) });
  void qc.invalidateQueries({ queryKey: ['issues', integrationKey, scope] });
}
