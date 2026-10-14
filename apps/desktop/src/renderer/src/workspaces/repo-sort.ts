import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { RepoStatusSummary, WorkspaceRepo } from '../../../shared/ipc/workspaces-contract';

/** Sortable columns of the workspace overview table. */
export type RepoSortKey = 'name' | 'branch' | 'sync' | 'wip' | 'stash' | 'prs' | 'fetched' | 'status';
export type SortDir = 'asc' | 'desc';
export interface RepoSort {
  key: RepoSortKey;
  dir: SortDir;
}

/** First click: names and status ascending (status: most urgent first), counts and dates biggest/newest first. */
const FIRST_DIR: Record<RepoSortKey, SortDir> = {
  name: 'asc',
  branch: 'asc',
  sync: 'desc',
  wip: 'desc',
  stash: 'desc',
  prs: 'desc',
  fetched: 'desc',
  status: 'asc',
};

export const wipTotal = (st?: RepoStatusSummary): number =>
  st ? st.wip.staged + st.wip.unstaged + st.wip.untracked + st.wip.conflicted : 0;

/** Heading click: first direction → the other one → back to the workspace's own order. */
export function nextSort(cur: RepoSort | null, key: RepoSortKey): RepoSort | null {
  if (cur?.key !== key) return { key, dir: FIRST_DIR[key] };
  return cur.dir === FIRST_DIR[key] ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : null;
}

/** Lower = needs attention sooner. */
function statusRank(st: RepoStatusSummary): number {
  if (st.operationInProgress || st.wip.conflicted) return 0;
  if (st.error) return 1;
  if (wipTotal(st) > 0) return 2;
  if (st.behind > 0) return 3;
  if (st.ahead > 0) return 4;
  return 5;
}

type Value = Array<string | number>;

/** The column's sort value; null (no status, not cloned, no upstream…) always sorts last. */
function valueOf(key: RepoSortKey, r: WorkspaceRepo, st?: RepoStatusSummary): Value | null {
  switch (key) {
    case 'name':
      return [r.name];
    case 'branch':
      return st?.head ? [st.head.branch ?? ''] : null;
    case 'sync':
      return st?.upstream ? [st.behind, st.ahead] : null;
    case 'wip':
      return st?.isRepo ? [wipTotal(st)] : null;
    case 'stash':
      return st?.isRepo ? [st.stashCount] : null;
    case 'prs':
      return st?.openPrs ? [st.openPrs.mine, st.openPrs.total] : null;
    case 'fetched':
      return st?.lastFetchAt ? [Date.parse(st.lastFetchAt)] : null;
    case 'status':
      return st?.exists ? [statusRank(st)] : null;
  }
}

function compare(a: Value, b: Value): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    if (c) return c;
  }
  return 0;
}

/** Sorted copy of `repos`; ties keep the workspace's order. */
export function sortRepos(
  repos: WorkspaceRepo[],
  statuses: Map<string, RepoStatusSummary>,
  sort: RepoSort | null,
): WorkspaceRepo[] {
  if (!sort) return repos;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const rows = repos.map((r, i) => ({ r, i, v: valueOf(sort.key, r, statuses.get(r.id)) }));
  rows.sort((a, b) => {
    if (!a.v || !b.v) return a.v ? -1 : b.v ? 1 : a.i - b.i;
    return sign * compare(a.v, b.v) || a.i - b.i;
  });
  return rows.map((x) => x.r);
}

interface RepoSortState {
  sort: RepoSort | null;
  setSort(sort: RepoSort | null): void;
}

const storage = createJSONStorage(() => {
  try {
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
});

/** The overview's column sort, shared by all workspaces and remembered across sessions. */
export const useRepoSort = create<RepoSortState>()(
  persist(
    (set) => ({
      sort: null,
      setSort: (sort) => set({ sort }),
    }),
    { name: 'kl.workspaces.repoSort', storage, partialize: (s) => ({ sort: s.sort }) },
  ),
);
