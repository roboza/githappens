import type { RepoId } from '@githappens/git/types';
import { useEffect } from 'react';
import { create } from 'zustand';

import type { LeftPanelLayout } from '../../../../shared/ipc/graph-contract';
import { DEFAULT_LEFT_LAYOUT, sanitizeLeftPanelLayout } from '../../../../shared/left-panel/layout';
import { graphInvoke } from '../graph/graph-ipc';

/**
 * Per-repo left-panel section layout (spec 01 §4.5), persisted through `repoUi:get` / `repoUi:save`
 * (`leftPanel` field of `userData/repos/<repoKey>/graph.json`). Saves are debounced.
 */

interface Entry {
  loaded: boolean;
  layout: LeftPanelLayout;
}

const EMPTY: Entry = Object.freeze({ loaded: false, layout: DEFAULT_LEFT_LAYOUT as LeftPanelLayout });

interface Store {
  repos: Record<RepoId, Entry>;
}

export const useLeftLayoutStore = create<Store>(() => ({ repos: {} }));

const loading = new Set<RepoId>();
const timers = new Map<RepoId, ReturnType<typeof setTimeout>>();

const get = (repoId: RepoId): Entry => useLeftLayoutStore.getState().repos[repoId] ?? EMPTY;
const put = (repoId: RepoId, e: Entry): void =>
  useLeftLayoutStore.setState((s) => ({ repos: { ...s.repos, [repoId]: e } }));

export function ensureLeftLayout(repoId: RepoId): void {
  if (loading.has(repoId) || get(repoId).loaded) return;
  loading.add(repoId);
  graphInvoke('repoUi:get', { repoId })
    .then((s) => {
      // a local edit made while loading wins
      if (get(repoId).loaded) return;
      put(repoId, {
        loaded: true,
        layout: sanitizeLeftPanelLayout(s.leftPanel) ?? { ...DEFAULT_LEFT_LAYOUT },
      });
    })
    .catch(() => {
      if (!get(repoId).loaded) put(repoId, { loaded: true, layout: { ...DEFAULT_LEFT_LAYOUT } });
    })
    .finally(() => loading.delete(repoId));
}

export function updateLeftLayout(repoId: RepoId, fn: (l: LeftPanelLayout) => LeftPanelLayout): void {
  const layout = fn(get(repoId).layout);
  put(repoId, { loaded: true, layout });
  const t = timers.get(repoId);
  if (t) clearTimeout(t);
  timers.set(
    repoId,
    setTimeout(() => {
      timers.delete(repoId);
      const current = get(repoId).layout;
      graphInvoke('repoUi:save', { repoId, patch: { leftPanel: current } }).catch(() => undefined);
    }, 300),
  );
}

export function useLeftLayout(repoId: RepoId): LeftPanelLayout {
  useEffect(() => ensureLeftLayout(repoId), [repoId]);
  return useLeftLayoutStore((s) => (s.repos[repoId] ?? EMPTY).layout);
}
