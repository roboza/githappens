import type { RepoId } from '@githappens/git/types';
import { create } from 'zustand';

/**
 * Next/previous file for the diff viewer (spec 07 §4.3 "when the last change is reached, next moves to the
 * next file", §4.15 Ctrl+↓/↑). The visible file list (commit panel, compare view) registers its order and
 * how to open an entry; the diff view steps through it.
 */
export interface FileNavList {
  paths: string[];
  open(path: string): void;
}

interface NavState {
  lists: Record<RepoId, FileNavList | undefined>;
  register(repoId: RepoId, list: FileNavList): () => void;
}

export const useDiffNavStore = create<NavState>((set, get) => ({
  lists: {},
  register(repoId, list) {
    set((s) => ({ lists: { ...s.lists, [repoId]: list } }));
    return () => {
      if (get().lists[repoId] === list) set((s) => ({ lists: { ...s.lists, [repoId]: undefined } }));
    };
  },
}));

/** Open the next (`dir` 1) or previous (-1) file after `current`; false when there is none. */
export function stepFile(repoId: RepoId, current: string, dir: 1 | -1): boolean {
  const list = useDiffNavStore.getState().lists[repoId];
  if (!list) return false;
  const i = list.paths.indexOf(current);
  const next = list.paths[i < 0 ? (dir > 0 ? 0 : list.paths.length - 1) : i + dir];
  if (next === undefined || next === current) return false;
  list.open(next);
  return true;
}

/** Index in `count` items after moving `dir` from `cur` (-1 = nothing selected); null past the ends. */
export function stepIndex(cur: number, count: number, dir: 1 | -1): number | null {
  if (count === 0) return null;
  if (cur < 0) return dir > 0 ? 0 : count - 1;
  const n = cur + dir;
  return n < 0 || n >= count ? null : n;
}
