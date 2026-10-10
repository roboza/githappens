import type { RepoId, RepoInfo } from '@githappens/git/types';
import { create } from 'zustand';

import { invoke, IpcError } from '../lib/api';
import { useTabsStore } from '../stores/tabs';

export type Session =
  | { state: 'opening' }
  | { state: 'ready'; repoId: RepoId; info: RepoInfo }
  | { state: 'error'; message: string; code?: string };

interface SessionStore {
  byPath: Record<string, Session>;
  ensure(path: string): void;
  release(path: string): void;
}

const key = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/**
 * One main-process GitService per repo tab (spec 03 `repos:open` → spec 02 `git:repo:open`).
 * Opened lazily when a tab is first shown, closed when its last tab closes.
 */
export const useSessionStore = create<SessionStore>((set, get) => ({
  byPath: {},
  ensure(path) {
    const k = key(path);
    const cur = get().byPath[k];
    if (cur && cur.state !== 'error') return;
    set((s) => ({ byPath: { ...s.byPath, [k]: { state: 'opening' } } }));
    invoke('git:repo:open', { path }).then(
      (info) => set((s) => ({ byPath: { ...s.byPath, [k]: { state: 'ready', repoId: info.id, info } } })),
      (e: unknown) =>
        set((s) => ({
          byPath: {
            ...s.byPath,
            [k]: {
              state: 'error',
              message: e instanceof IpcError ? e.error.message : String(e),
              code: e instanceof IpcError ? e.code : undefined,
            },
          },
        })),
    );
  },
  release(path) {
    const k = key(path);
    const cur = get().byPath[k];
    if (!cur) return;
    set((s) => {
      const next = { ...s.byPath };
      delete next[k];
      return { byPath: next };
    });
    if (cur.state === 'ready') void invoke('git:repo:close', { repoId: cur.repoId });
  },
}));

export const useSession = (path: string | undefined): Session | undefined =>
  useSessionStore((s) => (path ? s.byPath[key(path)] : undefined));

// Close sessions whose tabs are gone.
useTabsStore.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  const open = new Set(s.tabs.filter((t) => t.repoPath).map((t) => key(t.repoPath!)));
  for (const t of prev.tabs) {
    if (t.repoPath && !open.has(key(t.repoPath))) useSessionStore.getState().release(t.repoPath);
  }
});
