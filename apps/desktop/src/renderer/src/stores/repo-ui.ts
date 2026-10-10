import type { ComposeSource } from '@githappens/git/ops';
import type { DiffSpec, RepoId, Sha } from '@githappens/git/types';
import type { RepoRef } from '@githappens/providers/types';
import { create } from 'zustand';

/** Selection-driven right panel (spec 01 §5 `Selection`). */
export type Selection =
  | { kind: 'none' }
  | { kind: 'wip' }
  | { kind: 'commit'; sha: Sha }
  | { kind: 'commits'; shas: Sha[] }
  | { kind: 'stash'; sha: Sha; index: number };

/** What the center area shows: the graph, or a file diff opened from the right panel (spec 07). */
export type CenterView =
  | { kind: 'graph' }
  | {
      kind: 'diff';
      spec: DiffSpec;
      path: string;
      oldPath?: string;
      title: string;
      oldRev: string;
      newRev: string;
      /**
       * Set for WIP diffs: enables hunk/line staging in the hunk view (spec 06 §4.3). `key`: the file's
       * raw path key when its name is not valid UTF-8 (whole-file stage / unstage only).
       */
      stage?: { side: 'unstaged' | 'staged'; untracked: boolean; key?: string };
    }
  /** Built-in 3-way merge tool for one conflicted file (spec 08). */
  | { kind: 'merge'; path: string }
  /** Interactive rebase editor: rewrite commits after `upstream`, replayed onto `onto` (spec 05/12). */
  | { kind: 'rebase'; upstream: string; onto: string; label: string }
  /** File history / blame / editor (spec 07). */
  | { kind: 'file'; path: string; mode: 'history' | 'blame' | 'edit'; rev?: string }
  /** Pull request detail (spec 10 §6.2). */
  | { kind: 'pr'; ref: RepoRef; number: number }
  /** AI Commit Composer: split staged changes or a range ending at HEAD into commits (spec 12 §4.6). */
  | { kind: 'compose'; source: ComposeSource }
  /** Cloud Patch opened from a link or the CLOUD PATCHES section (spec 14 §4.2); data in `useOpenedPatches`. */
  | { kind: 'patch'; patchId: string };

/** What the AI Explain panel explains (spec 12 §4.4). */
export type ExplainTarget =
  { kind: 'commits'; shas: Sha[] } | { kind: 'branch'; branch: string; base?: string } | { kind: 'wip' };

export interface SearchState {
  text: string;
  mode: 'highlight' | 'filter';
  /** Full-history hits from `graph:search`, or null while only loaded rows are searched. */
  deepHits: Sha[] | null;
  activeIndex: number;
}

/** Commit composer draft, kept per repo across selection changes (spec 06 `ComposerDraft`). */
export interface ComposerDraft {
  summary: string;
  description: string;
  amend: boolean;
  skipHooks: boolean;
}

export interface RepoUi {
  selection: Selection;
  draft: ComposerDraft;
  center: CenterView;
  search: SearchState;
  leftFilter: string;
  collapsedSections: string[];
  collapsedFolders: string[];
  /** Bumped to ask the graph to scroll to a commit (`graph:revealCommit` semantics). */
  reveal: { sha: Sha; nonce: number } | null;
  /** Bumped by the `graph` refresh scope to reload history. */
  graphVersion: number;
  /** AI Explain panel shown over the right panel; the nonce restarts it for the same target. */
  explain: { target: ExplainTarget; nonce: number } | null;
}

const initial = (): RepoUi => ({
  selection: { kind: 'none' },
  draft: { summary: '', description: '', amend: false, skipHooks: false },
  center: { kind: 'graph' },
  search: { text: '', mode: 'highlight', deepHits: null, activeIndex: 0 },
  leftFilter: '',
  collapsedSections: [],
  collapsedFolders: [],
  reveal: null,
  graphVersion: 0,
  explain: null,
});

interface RepoUiStore {
  repos: Record<RepoId, RepoUi>;
  get(repoId: RepoId): RepoUi;
  update(repoId: RepoId, fn: (ui: RepoUi) => Partial<RepoUi>): void;
  select(repoId: RepoId, sel: Selection): void;
  reveal(repoId: RepoId, sha: Sha): void;
  bumpGraph(repoId: RepoId): void;
}

export const useRepoUiStore = create<RepoUiStore>((set, get) => ({
  repos: {},
  get: (repoId) => get().repos[repoId] ?? initial(),
  update: (repoId, fn) =>
    set((s) => {
      const cur = s.repos[repoId] ?? initial();
      return { repos: { ...s.repos, [repoId]: { ...cur, ...fn(cur) } } };
    }),
  select: (repoId, selection) =>
    get().update(repoId, () => ({ selection, center: { kind: 'graph' }, explain: null })),
  reveal: (repoId, sha) =>
    get().update(repoId, (ui) => ({
      reveal: { sha, nonce: (ui.reveal?.nonce ?? 0) + 1 },
      selection: { kind: 'commit', sha },
      center: { kind: 'graph' },
    })),
  bumpGraph: (repoId) => get().update(repoId, (ui) => ({ graphVersion: ui.graphVersion + 1 })),
}));

export function useRepoUi<T>(repoId: RepoId, pick: (ui: RepoUi) => T): T {
  return useRepoUiStore((s) => pick(s.repos[repoId] ?? DEFAULT_UI));
}

const DEFAULT_UI = initial();
