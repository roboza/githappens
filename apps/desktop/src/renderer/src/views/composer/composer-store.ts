import type { CoAuthor } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';
import { create } from 'zustand';

import type { SignChoice } from '../../../../shared/ipc/commit-contract';

/** Hook run shown in the drawer (spec 06 §4.6). */
export interface HookRun {
  running: boolean;
  output: string;
  /** Set when the commit failed in a hook; the drawer auto-expands with Retry / Commit skipping hooks. */
  failed: { hook: string; exitCode: number | null; message: string } | null;
  open: boolean;
}

/** Composer state beyond the shared `RepoUi.draft` (summary/description/amend/skipHooks). */
export interface ComposerExtras {
  coAuthors: CoAuthor[];
  pushAfter: boolean;
  sign: SignChoice;
  allowEmpty: boolean;
  /** Message the user had before turning Amend on; restored when Amend is turned off. */
  preAmend: { summary: string; description: string } | null;
  hook: HookRun;
  /** EOL conversion warnings from the last staging ops, by path (spec 06 §4.8). */
  eolWarnings: Record<string, 'lf-to-crlf' | 'crlf-to-lf'>;
  eolBannerDismissed: boolean;
}

const PUSH_KEY = (repoId: RepoId): string => `composer:pushAfter:${repoId}`;
const readPushAfter = (repoId: RepoId): boolean => {
  try {
    return localStorage.getItem(PUSH_KEY(repoId)) === '1';
  } catch {
    return false;
  }
};
const EOL_DISMISS_KEY = 'composer:eolBannerDismissed';
const readEolDismissed = (): boolean => {
  try {
    return localStorage.getItem(EOL_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

export const EMPTY_HOOK: HookRun = { running: false, output: '', failed: null, open: false };
/** Keep the drawer bounded (a runaway hook must not grow the store without limit). */
export const MAX_HOOK_OUTPUT = 200_000;

const initial = (repoId: RepoId): ComposerExtras => ({
  coAuthors: [],
  pushAfter: readPushAfter(repoId),
  sign: 'config',
  allowEmpty: false,
  preAmend: null,
  hook: EMPTY_HOOK,
  eolWarnings: {},
  eolBannerDismissed: readEolDismissed(),
});

interface ComposerStore {
  repos: Record<RepoId, ComposerExtras>;
  get(repoId: RepoId): ComposerExtras;
  update(repoId: RepoId, fn: (c: ComposerExtras) => Partial<ComposerExtras>): void;
  /** Append streamed hook output (trimmed from the front past `MAX_HOOK_OUTPUT`). */
  appendHook(repoId: RepoId, chunk: string): void;
  setPushAfter(repoId: RepoId, v: boolean): void;
  dismissEolBanner(repoId: RepoId): void;
}

export const useComposerStore = create<ComposerStore>((set, get) => ({
  repos: {},
  get: (repoId) => get().repos[repoId] ?? initial(repoId),
  update: (repoId, fn) =>
    set((s) => {
      const cur = s.repos[repoId] ?? initial(repoId);
      return { repos: { ...s.repos, [repoId]: { ...cur, ...fn(cur) } } };
    }),
  appendHook: (repoId, chunk) =>
    get().update(repoId, (c) => {
      const output = (c.hook.output + chunk).slice(-MAX_HOOK_OUTPUT);
      return { hook: { ...c.hook, output, running: true } };
    }),
  setPushAfter: (repoId, v) => {
    try {
      localStorage.setItem(PUSH_KEY(repoId), v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    get().update(repoId, () => ({ pushAfter: v }));
  },
  dismissEolBanner: (repoId) => {
    try {
      localStorage.setItem(EOL_DISMISS_KEY, '1');
    } catch {
      /* storage unavailable */
    }
    get().update(repoId, () => ({ eolBannerDismissed: true }));
  },
}));

const DEFAULTS: Record<RepoId, ComposerExtras> = {};
export function useComposer<T>(repoId: RepoId, pick: (c: ComposerExtras) => T): T {
  return useComposerStore((s) => pick(s.repos[repoId] ?? (DEFAULTS[repoId] ??= initial(repoId))));
}

/** Record EOL warnings returned by a staging op (`OpResult.data.eolWarnings`). */
export function noteEolWarnings(repoId: RepoId, data: unknown): void {
  const list = (data as { eolWarnings?: { path: string; kind: 'lf-to-crlf' | 'crlf-to-lf' }[] } | undefined)
    ?.eolWarnings;
  if (!Array.isArray(list) || !list.length) return;
  useComposerStore.getState().update(repoId, (c) => {
    const next = { ...c.eolWarnings };
    for (const w of list) next[w.path] = w.kind;
    return { eolWarnings: next };
  });
}
