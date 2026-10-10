import {
  EMPTY_VISIBILITY,
  setHidden,
  setPinned,
  setSolo,
  showAll,
  type RefVisibilityState,
} from '@githappens/graph';
import type { RepoId } from '@githappens/git/types';
import { useEffect } from 'react';
import { create } from 'zustand';

import type { GraphColumnLayout, RepoUiState } from '../../../../shared/ipc/graph-contract';
import { graphInvoke } from './graph-ipc';

/**
 * Per-repo graph UI state (hide / solo / pin, column layout), loaded from and saved to main
 * (`repoUi:get` / `repoUi:save`, `userData/repos/<repoKey>/graph.json`). Shared by the graph, its
 * context menus and the left panel's eye / solo toggles.
 */

export interface RepoGraphState {
  /** True once the persisted state arrived (or failed to load → defaults). */
  loaded: boolean;
  vis: RefVisibilityState;
  columns: GraphColumnLayout | null;
}

const EMPTY: RepoGraphState = Object.freeze({ loaded: false, vis: EMPTY_VISIBILITY, columns: null });

interface Store {
  repos: Record<RepoId, RepoGraphState>;
  patch(repoId: RepoId, p: Partial<RepoGraphState>): void;
}

export const useRepoGraphStore = create<Store>((set) => ({
  repos: {},
  patch: (repoId, p) =>
    set((s) => ({ repos: { ...s.repos, [repoId]: { ...(s.repos[repoId] ?? EMPTY), ...p } } })),
}));

const loading = new Set<RepoId>();
const pending = new Map<RepoId, { patch: Partial<RepoUiState>; timer: ReturnType<typeof setTimeout> }>();

export function getRepoGraphState(repoId: RepoId): RepoGraphState {
  return useRepoGraphStore.getState().repos[repoId] ?? EMPTY;
}

/** Loads the persisted state once per repo (idempotent). */
export function ensureRepoGraphState(repoId: RepoId): void {
  if (loading.has(repoId) || getRepoGraphState(repoId).loaded) return;
  loading.add(repoId);
  graphInvoke('repoUi:get', { repoId })
    .then((s) =>
      useRepoGraphStore.getState().patch(repoId, {
        loaded: true,
        vis: { hidden: s.hiddenRefs, solo: s.soloRefs, pinned: s.pinnedRefs },
        columns: s.columns,
      }),
    )
    .catch(() => useRepoGraphStore.getState().patch(repoId, { loaded: true }))
    .finally(() => loading.delete(repoId));
}

function save(repoId: RepoId, p: Partial<RepoUiState>): void {
  const cur = pending.get(repoId);
  if (cur) clearTimeout(cur.timer);
  const patch = { ...cur?.patch, ...p };
  const timer = setTimeout(() => {
    pending.delete(repoId);
    graphInvoke('repoUi:save', { repoId, patch }).catch(() => undefined);
  }, 250);
  pending.set(repoId, { patch, timer });
}

export function updateVisibility(repoId: RepoId, fn: (v: RefVisibilityState) => RefVisibilityState): void {
  const vis = fn(getRepoGraphState(repoId).vis);
  useRepoGraphStore.getState().patch(repoId, { vis });
  save(repoId, { hiddenRefs: [...vis.hidden], soloRefs: [...vis.solo], pinnedRefs: [...vis.pinned] });
}

export function updateColumns(repoId: RepoId, columns: GraphColumnLayout | null): void {
  useRepoGraphStore.getState().patch(repoId, { columns });
  save(repoId, { columns });
}

export const hideRef = (repoId: RepoId, name: string, hidden?: boolean): void =>
  updateVisibility(repoId, (v) => setHidden(v, name, hidden));
export const soloRef = (repoId: RepoId, name: string, solo?: boolean): void =>
  updateVisibility(repoId, (v) => setSolo(v, name, solo));
export const pinRef = (repoId: RepoId, name: string, pinned?: boolean): void =>
  updateVisibility(repoId, (v) => setPinned(v, name, pinned));
export const showAllRefs = (repoId: RepoId): void => updateVisibility(repoId, showAll);

/** Subscribes to (and lazily loads) a repo's graph state. */
export function useRepoGraphState(repoId: RepoId): RepoGraphState {
  useEffect(() => ensureRepoGraphState(repoId), [repoId]);
  return useRepoGraphStore((s) => s.repos[repoId] ?? EMPTY);
}
