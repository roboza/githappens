import type { OrgDetail } from '@githappens/cloud-api/types';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { CloudStatus, SyncStatus } from '../../../shared/ipc/cloud-contract';
import { cloudCode, cloudInvoke, cloudOn } from './api';

/** TanStack Query keys for account / sync / organizations (spec 14). */
export const ck = {
  status: () => ['cloud', 'status'] as const,
  serverInfo: (url: string) => ['cloud', 'serverInfo', url] as const,
  sync: () => ['cloud', 'sync'] as const,
  org: (orgId: string) => ['cloud', 'org', orgId] as const,
  invites: (orgId: string) => ['cloud', 'org', orgId, 'invites'] as const,
};

const NO_RETRY = new Set([
  'network',
  'signed_out',
  'not_configured',
  'forbidden',
  'not_found',
  'unauthorized',
]);
export const cloudRetry = (count: number, e: unknown): boolean =>
  !NO_RETRY.has(cloudCode(e) ?? '') && count < 1;

const installed = new WeakSet<QueryClient>();

/** Push events → cache, once per QueryClient. */
function ensureListeners(qc: QueryClient): void {
  if (installed.has(qc)) return;
  installed.add(qc);
  cloudOn('cloud:sessionChanged', (status) => {
    const prev = qc.getQueryData<CloudStatus>(ck.status());
    qc.setQueryData(ck.status(), status);
    // Account or org membership changed → org data and sync status are stale.
    if (
      prev?.session?.user.id !== status.session?.user.id ||
      JSON.stringify(prev?.session?.orgs) !== JSON.stringify(status.session?.orgs)
    ) {
      void qc.invalidateQueries({ queryKey: ['cloud', 'org'] });
      void qc.invalidateQueries({ queryKey: ck.sync() });
    }
    // Server, account or active org changed → the TEAM section's status/view (polled only every
    // minute) is stale too.
    if (
      prev?.serverUrl !== status.serverUrl ||
      prev?.session?.user.id !== status.session?.user.id ||
      prev?.session?.activeOrgId !== status.session?.activeOrgId
    ) {
      void qc.invalidateQueries({ queryKey: ['team'] });
    }
  });
  cloudOn('sync:statusChanged', (status) => qc.setQueryData(ck.sync(), status));
}

export function useCloudListeners(): void {
  const qc = useQueryClient();
  useEffect(() => ensureListeners(qc), [qc]);
}

/** Account state; IPC only (main makes no network call for this). */
export function useCloudStatus() {
  useCloudListeners();
  return useQuery({
    queryKey: ck.status(),
    queryFn: () => cloudInvoke('cloud:state', {}),
    staleTime: Infinity,
  });
}

export function useSyncStatus(enabled = true) {
  useCloudListeners();
  return useQuery({
    queryKey: ck.sync(),
    queryFn: () => cloudInvoke('sync:status', {}),
    enabled,
    staleTime: Infinity,
  });
}

/** ServerInfo of the configured server (network call — only when a server is configured). */
export function useServerInfo(serverUrl: string | null | undefined) {
  return useQuery({
    queryKey: ck.serverInfo(serverUrl ?? ''),
    queryFn: () => cloudInvoke('cloud:serverInfo', {}),
    enabled: !!serverUrl,
    staleTime: 10 * 60_000,
    retry: cloudRetry,
  });
}

export function useOrgDetail(orgId: string | undefined, enabled = true) {
  return useQuery<OrgDetail>({
    queryKey: ck.org(orgId ?? ''),
    queryFn: () => cloudInvoke('org:get', { orgId: orgId! }),
    enabled: !!orgId && enabled,
    staleTime: 60_000,
    retry: cloudRetry,
  });
}

export function useOrgInvites(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ck.invites(orgId ?? ''),
    queryFn: () => cloudInvoke('org:invites', { orgId: orgId! }),
    enabled: !!orgId && enabled,
    staleTime: 60_000,
    retry: cloudRetry,
  });
}

/** Apply a SyncStatus returned by a mutation. */
export function setSyncStatus(qc: QueryClient, s: SyncStatus): void {
  qc.setQueryData(ck.sync(), s);
}
