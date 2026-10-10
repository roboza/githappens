/**
 * Commit-graph side channels (spec 04 §5.4, spec 10 §4.10):
 * - `avatar:resolve`: author emails / provider avatar URLs → `githappens-avatar://` URLs served by the
 *   main-process AvatarService (the renderer never loads remote images; CSP `img-src` has no `https:`).
 * - `repoUi:get` / `repoUi:save`: per-repository graph UI state (hide / solo / pin, column layout)
 *   persisted in `userData/repos/<repoKey>/graph.json` (spec 04 §4.2, spec 01 §4.5).
 * - `graph:countCommits`: total commits of the graph rev-set (footer estimate).
 */
import type { RepoId, SearchProgress } from '@githappens/git/types';

export const AVATAR_SCHEME = 'githappens-avatar';

export interface AvatarResolveItem {
  /** Commit author email (Gravatar / provider lookup / GitHub noreply mapping). */
  email?: string;
  /** Provider avatar URL (https) from an integration (PR authors, reviewers, accounts). */
  url?: string;
}

export interface AvatarResolveRequest {
  items: AvatarResolveItem[];
  /** CSS px; the image is fetched at 2× for HiDPI. Default 32. */
  size?: number;
}

/** One entry per request item: a `githappens-avatar://avatar/<hash>?s=<size>` URL, or null (use initials). */
export type AvatarResolveResult = (string | null)[];

export type GraphColumnId = 'refs' | 'graph' | 'message' | 'author' | 'date' | 'sha';

/** Column layout (spec 04 §4.2 `ColumnLayout`). Missing entries fall back to defaults. */
export interface GraphColumnLayout {
  order: GraphColumnId[];
  widths: Partial<Record<GraphColumnId, number>>;
  visible: Partial<Record<GraphColumnId, boolean>>;
}

/** Left-panel section layout (spec 01 §4.5 "collapsed/expanded sections and section heights"). */
export interface LeftPanelLayout {
  /** Collapsed section ids. */
  collapsed: string[];
  /** Sections the user hid (header menu). */
  hidden: string[];
  /** Opt-in sections (hidden by default, e.g. `submodules`) the user enabled. */
  enabled: string[];
  /** Section body heights in px (resized sections); missing = natural height. */
  heights: Record<string, number>;
  /** Maximized section (others collapse to their headers), or null. */
  maximized: string | null;
}

/** Persisted per-repo graph state. */
export interface RepoUiState {
  /** Hidden full ref names / `refs/remotes/<r>/*` globs / `stash:<sha>`. */
  hiddenRefs: string[];
  /** Soloed full ref names / globs. */
  soloRefs: string[];
  /** Pinned branch full names (lane order). */
  pinnedRefs: string[];
  /** Column layout; null = defaults. */
  columns: GraphColumnLayout | null;
  /** Left-panel sections; null = defaults (Phase 8). */
  leftPanel: LeftPanelLayout | null;
}

export interface GraphIpcContract {
  'avatar:resolve': { req: AvatarResolveRequest; res: AvatarResolveResult };
  'repoUi:get': { req: { repoId: RepoId }; res: RepoUiState };
  /** Merges the given fields into the stored state and returns the result. */
  'repoUi:save': { req: { repoId: RepoId; patch: Partial<RepoUiState> }; res: RepoUiState };
  /**
   * `git rev-list --count` over the graph rev-set (spec 04 §5.4 `graph:countCommits`), background
   * priority. Feeds the "Showing N of ~M" footer and the >50k load confirmations.
   */
  'graph:countCommits': {
    req: { repoId: RepoId; revs: string[] | 'all'; hiddenRefs?: string[] };
    res: number;
  };
  /**
   * Abort a running full-history search started by `graph:search` with `query.searchId` (spec 12 §6.7:
   * pickaxe is slow → cancellable). The `graph:search` call then rejects with `Cancelled`.
   */
  'graph:search:cancel': { req: { searchId: string }; res: void };
  /**
   * Progress + partial results of a search (spec 12 §8 "partial results streamed"): matches from index
   * `from` on, commits scanned, how far back the scan reached. Null when the id is unknown.
   */
  'graph:search:progress': { req: { searchId: string; from?: number }; res: SearchProgress | null };
}

export const GRAPH_INVOKE_CHANNELS = [
  'avatar:resolve',
  'repoUi:get',
  'repoUi:save',
  'graph:countCommits',
  'graph:search:cancel',
  'graph:search:progress',
] as const satisfies readonly (keyof GraphIpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof GraphIpcContract, (typeof GRAPH_INVOKE_CHANNELS)[number]> = true;
void invokeExhaustive;
