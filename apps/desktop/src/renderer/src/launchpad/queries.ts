import type {
  ClassifiedItem,
  LaunchpadFilters,
  LaunchpadTab,
  SavedView,
  SnoozeState,
} from '@githappens/launchpad';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import type { LaunchpadQueryResult } from '../../../shared/ipc/launchpad-contract';
import { useSetting } from '../stores/settings';
import { useToastStore } from '../stores/toasts';
import { lpInvoke, lpOn } from './api';
import { filtersKey, serverFilters } from './helpers';
import { shouldRefreshOnFocus, useAttentionPause, useOnline } from './polling';

/** TanStack Query keys (spec 11 §5.5). */
export const lk = {
  all: () => ['launchpad'] as const,
  query: (filters: LaunchpadFilters, tab: LaunchpadTab) => ['launchpad', filtersKey(filters), tab] as const,
  views: () => ['launchpad', '@views'] as const,
  summary: () => ['launchpad-summary'] as const,
  /** Under `['launchpad']` so `launchpad:updated` invalidates it too. */
  prCounts: (workspaceId: string) => ['launchpad', '@prCounts', workspaceId] as const,
};

const installed = new WeakSet<QueryClient>();
/** `launchpad:updated` → refetch lists + status-bar summary. Idempotent per QueryClient. */
export function useLaunchpadListeners(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (installed.has(qc)) return;
    installed.add(qc);
    lpOn('launchpad:updated', () => {
      void qc.invalidateQueries({ queryKey: ['launchpad'] });
      void qc.invalidateQueries({ queryKey: lk.summary() });
    });
  }, [qc]);
}

/**
 * Launchpad items for a scope/mode/tab (§6.5). Polls while `active` (tab visible) every
 * `launchpad.refreshMinutes` (personal) or 5 min (team); TanStack pauses polling while the window
 * is hidden, and polling also pauses once the window has been blurred for 10 minutes. On focus the
 * list refetches when the snapshot is older than 2 min (main refreshes providers past that age).
 * Offline: no provider requests, the cached snapshot is served (`offline` in the result).
 */
export function useLaunchpad(filters: LaunchpadFilters, tab: LaunchpadTab, active = true) {
  useLaunchpadListeners();
  const minutes = useSetting('launchpad.refreshMinutes') ?? 3;
  const interval = (filters.mode === 'team' ? 5 : minutes) * 60_000;
  const online = useOnline();
  const qc = useQueryClient();
  const fk = filtersKey(filters);
  const onFocus = useCallback(() => {
    const key = ['launchpad', fk, tab] as const;
    const cur = qc.getQueryData<LaunchpadQueryResult>(key);
    if (shouldRefreshOnFocus(cur?.fetchedAt, Date.now()))
      void qc.refetchQueries({ queryKey: key, exact: true });
  }, [qc, fk, tab]);
  const paused = useAttentionPause(active ? onFocus : undefined);
  const q = useQuery({
    queryKey: lk.query(filters, tab),
    queryFn: async () => {
      const r = await lpInvoke('launchpad:query', {
        filters: serverFilters(filters),
        tab,
        maxAgeMs: Math.min(interval, 120_000),
        offline: !online,
      });
      return { ...r, offline: !online };
    },
    refetchInterval: active && online && !paused ? interval : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
  // Online ↔ offline: refetch right away (back online → main refreshes the stale snapshot).
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online !== wasOnline.current && active) void q.refetch();
    wasOnline.current = online;
  }, [online, active, q]);
  return q;
}

/** Status-bar summary: refreshed every 10 min in the background (personal queries only, §6.5). */
export function useLaunchpadSummary(enabled = true) {
  useLaunchpadListeners();
  const online = useOnline();
  const paused = useAttentionPause();
  return useQuery({
    queryKey: lk.summary(),
    queryFn: () => lpInvoke('launchpad:summary', { maxAgeMs: 10 * 60_000, offline: !online }),
    refetchInterval: enabled && online && !paused ? 10 * 60_000 : false,
    refetchIntervalInBackground: false,
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Open PRs per repo of a workspace (mine / total / needs my review) for the overview table.
 * Answered from main's memory; refetched on `launchpad:updated` and every 5 minutes.
 */
export function useWorkspacePrCounts(workspaceId: string, enabled = true) {
  useLaunchpadListeners();
  const online = useOnline();
  return useQuery({
    queryKey: lk.prCounts(workspaceId),
    queryFn: () => lpInvoke('launchpad:prCounts', { workspaceId, offline: !online }),
    enabled,
    refetchInterval: enabled && online ? 5 * 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
}

export const useLaunchpadViews = () =>
  useQuery({ queryKey: lk.views(), queryFn: () => lpInvoke('launchpad:views', {}), staleTime: Infinity });

export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (view: Omit<SavedView, 'id'> & { id?: string }) => lpInvoke('launchpad:saveView', { view }),
    onSuccess: () => qc.invalidateQueries({ queryKey: lk.views() }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => lpInvoke('launchpad:deleteView', { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: lk.views() }),
  });
}

/** Optimistically apply a pin/snooze to every cached list, then persist (§6.5 "Mutation"). */
export async function setItemState(
  qc: QueryClient,
  item: Pick<ClassifiedItem, 'uid'>,
  change: { pin?: boolean; snooze?: SnoozeState | null },
): Promise<void> {
  const nowIso = new Date().toISOString();
  qc.setQueriesData<LaunchpadQueryResult>({ queryKey: lk.all() }, (prev) => {
    if (!prev || !Array.isArray(prev.items)) return prev;
    const items = prev.items.flatMap((i): ClassifiedItem[] => {
      if (i.uid !== item.uid) return [i];
      if (change.snooze) return []; // leaves the current list (shows up under Snoozed after refetch)
      if (change.pin === true) return [{ ...i, group: 'pinned', pinnedAt: nowIso, snoozed: undefined }];
      if (change.pin === false || change.snooze === null)
        return [{ ...i, group: i.statusGroup, pinnedAt: undefined, snoozed: undefined }];
      return [i];
    });
    return { ...prev, items };
  });
  try {
    await lpInvoke('launchpad:setItemState', { uid: item.uid, ...change });
  } catch (e) {
    useToastStore.getState().push({
      kind: 'error',
      title: 'Could not update the item',
      body: e instanceof Error ? e.message : String(e),
    });
  } finally {
    void qc.invalidateQueries({ queryKey: lk.all() });
    void qc.invalidateQueries({ queryKey: lk.summary() });
  }
}

export async function refreshLaunchpad(qc: QueryClient, workspaceId?: string): Promise<void> {
  try {
    await lpInvoke('launchpad:refresh', { force: true, workspaceId });
  } finally {
    void qc.invalidateQueries({ queryKey: lk.all() });
    void qc.invalidateQueries({ queryKey: lk.summary() });
  }
}
