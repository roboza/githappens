import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';

import type { BulkOp, BulkOpProgress, Workspace } from '../../../shared/ipc/workspaces-contract';
import { useToastStore } from '../stores/toasts';
import { wsInvoke, wsOn } from './api';

/** TanStack Query keys (spec 11 §5.5). */
export const wk = {
  list: () => ['workspaces'] as const,
  status: (id: string) => ['workspace-status', id] as const,
  branches: (id: string) => ['workspace-branches', id] as const,
  details: (id: string, repoId: string) => ['workspace-repo', id, repoId] as const,
};

/** Status of the not-open repos is re-polled this often while a WorkspaceView is visible (§6.1). */
const STATUS_POLL_MS = 60_000;

let listenersFor: QueryClient | null = null;

/** Push events → query cache (installed once per QueryClient). */
function ensureListeners(qc: QueryClient): void {
  if (listenersFor === qc) return;
  listenersFor = qc;
  wsOn('workspace:bulkProgress', onBulkProgress);
  wsOn('workspace:changed', ({ workspaces, sync }) => {
    qc.setQueryData(wk.list(), workspaces);
    if (sync) void qc.invalidateQueries({ queryKey: wk.status(sync.workspaceId) });
  });
  wsOn('workspace:statusUpdated', ({ workspaceId, summaries }) =>
    qc.setQueryData(wk.status(workspaceId), summaries),
  );
}

export function useWorkspaces() {
  const qc = useQueryClient();
  useEffect(() => ensureListeners(qc), [qc]);
  return useQuery({ queryKey: wk.list(), queryFn: () => wsInvoke('workspace:list', {}), staleTime: 30_000 });
}

export function useWorkspace(id: string | null): Workspace | undefined {
  const list = useWorkspaces();
  return id ? list.data?.find((w) => w.id === id) : undefined;
}

export const useWorkspaceStatus = (id: string, enabled = true) =>
  useQuery({
    queryKey: wk.status(id),
    queryFn: () => wsInvoke('workspace:status', { workspaceId: id }),
    enabled,
    staleTime: 5_000,
    refetchInterval: STATUS_POLL_MS,
    refetchOnWindowFocus: true,
  });

export const useBranchMatrix = (id: string, enabled = true) =>
  useQuery({
    queryKey: wk.branches(id),
    queryFn: () => wsInvoke('workspace:branches', { workspaceId: id }),
    enabled,
    staleTime: 10_000,
  });

export const useRepoDetails = (id: string, repoId: string, enabled = true) =>
  useQuery({
    queryKey: wk.details(id, repoId),
    queryFn: () => wsInvoke('workspace:repoDetails', { workspaceId: id, repoId }),
    enabled,
    staleTime: 10_000,
  });

// ---- bulk progress ----

export interface BulkRun {
  bulkId: string;
  op: BulkOp;
  rows: Record<string, BulkOpProgress>;
  finished: boolean;
}

interface BulkState {
  /** Latest run per workspace. */
  runs: Record<string, BulkRun>;
  clear(workspaceId: string): void;
}

const TERMINAL = new Set(['done', 'failed', 'skipped']);

export const useBulkStore = create<BulkState>((set) => ({
  runs: {},
  clear: (workspaceId) =>
    set((s) => {
      const runs = { ...s.runs };
      delete runs[workspaceId];
      return { runs };
    }),
}));

const OP_LABEL: Record<BulkOp, string> = { fetch: 'Fetch', pull: 'Pull', push: 'Push', clone: 'Clone' };

function onBulkProgress(p: BulkOpProgress): void {
  const prev = useBulkStore.getState().runs[p.workspaceId];
  const run: BulkRun =
    prev && prev.bulkId === p.bulkId ? prev : { bulkId: p.bulkId, op: p.op, rows: {}, finished: false };
  const rows = { ...run.rows, [p.repoId]: p };
  const finished = Object.values(rows).every((r) => TERMINAL.has(r.state));
  useBulkStore.setState((s) => ({ runs: { ...s.runs, [p.workspaceId]: { ...run, rows, finished } } }));
  if (finished && !run.finished) {
    const all = Object.values(rows);
    const failed = all.filter((r) => r.state === 'failed').length;
    const done = all.filter((r) => r.state === 'done').length;
    const skipped = all.length - failed - done;
    useToastStore.getState().push({
      kind: failed ? 'warning' : 'success',
      title: `${OP_LABEL[p.op]} finished`,
      body: [`${done} done`, failed ? `${failed} failed` : '', skipped ? `${skipped} skipped` : '']
        .filter(Boolean)
        .join(' · '),
    });
  }
}

// ---- selection (shared with Home / Launchpad / palette) ----

interface WorkspaceUi {
  selectedId: string | null;
  select(id: string | null): void;
}

export const useWorkspaceUi = create<WorkspaceUi>((set) => ({
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
}));
