import type { RepoId } from '@githappens/git/types';
import { create } from 'zustand';

import type { OpenedPatch } from '../../../shared/ipc/patches-contract';

/** Decrypted patches opened in this window, by patch id (the CloudPatchView reads them from here). */
interface OpenedPatchStore {
  byId: Record<string, OpenedPatch>;
  /** Repo the user chose for a patch (overrides `localMatch.repoId`). */
  repoFor: Record<string, RepoId>;
  put(p: OpenedPatch): void;
  setRepo(patchId: string, repoId: RepoId): void;
  remove(patchId: string): void;
}

export const useOpenedPatches = create<OpenedPatchStore>((set) => ({
  byId: {},
  repoFor: {},
  put: (p) => set((s) => ({ byId: { ...s.byId, [p.patch.id]: p } })),
  setRepo: (patchId, repoId) => set((s) => ({ repoFor: { ...s.repoFor, [patchId]: repoId } })),
  remove: (patchId) =>
    set((s) => {
      const byId = { ...s.byId };
      delete byId[patchId];
      return { byId };
    }),
}));
