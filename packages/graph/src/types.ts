/**
 * Input and output types of the commit-graph layout (spec 04 §5).
 *
 * The input types are minimal structural subsets of spec 02's `CommitSummary`,
 * `StashEntry` and `RefInfo`, so values of those types can be passed directly
 * without this package depending on `@githappens/git`.
 */

export type Sha = string;

/** Row key of the synthetic WIP / conflict row (spec 04 §4.9: `'WIP'` is a valid selection key). */
export const WIP_SHA = 'WIP';

/** A commit as streamed by `git log --date-order` (structural subset of spec 02 `CommitSummary`). */
export interface GraphCommitInput {
  sha: Sha;
  /** Parent SHAs, first parent first. Empty for a root commit. */
  parents: readonly Sha[];
  /** Committer time in unix seconds. Used only to interleave stash rows (§6.4). */
  commitTime?: number;
}

/** A stash (structural subset of spec 02 `StashEntry`). `parents[0]` is the base commit. */
export interface GraphStashInput {
  sha: Sha;
  parents: readonly Sha[];
  /** Unix seconds. */
  time: number;
  index?: number;
  ref?: string;
  message?: string;
}

/** Node shapes (spec 04 §5.2). */
export const NodeKind = { Commit: 0, Merge: 1, Wip: 2, Stash: 3, Conflict: 4 } as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

/** Edge kinds; stored in the low 3 bits of an edge's `kindFlags` (spec 04 §5.2). */
export const EdgeKind = { Pass: 0, MergeOut: 1, BranchIn: 2 } as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

/** Edge flag bits OR-ed into `kindFlags`. */
export const EdgeFlag = {
  /** WIP / conflict / stash edge, drawn dashed. */
  Dashed: 8,
  /** Line toward a parent that was never loaded (history complete); drawn fading out. */
  Fade: 16,
} as const;

/** Per-row flag bits. */
export const RowFlag = {
  /** No loaded child expected this commit: a new lane started here (branch tip). */
  Tip: 1,
  /** Commit has no parents (root) — its lane ends here. */
  Root: 2,
  /** Row is the HEAD commit (`options.headSha`). */
  Head: 4,
  /** Row's lane is a pinned lane (HEAD or a user-pinned branch tip). */
  Pinned: 8,
} as const;

export type ColorMode = 'column' | 'branch';
export type MergeLanePlacement = 'right-first' | 'leftmost';

export interface WipRowOptions {
  /** `'conflict'` renders the merge-in-progress row (spec 04 §4.4). Default `'wip'`. */
  kind?: 'wip' | 'conflict';
  /**
   * Parents of the synthetic row. Default `[headSha]` (or `[]` when HEAD is unborn).
   * For a conflict row pass `[headSha, MERGE_HEAD]`.
   */
  parents?: readonly Sha[];
}

export interface GraphLayoutOptions {
  /** HEAD commit. Its lane is reserved as lane 0 before any row is laid out (§6.3.4). */
  headSha?: Sha | null;
  /** User-pinned branch tips (v11.10 "Pin to left"), reserved as lanes 1..k after HEAD. */
  pinnedTips?: readonly Sha[];
  /** Synthetic WIP / conflict row at index 0 (§4.4, §6.3.8). Falsy = none. */
  wip?: WipRowOptions | boolean | null;
  /** Stash rows, interleaved by time but always above their base commit (§6.4). */
  stashes?: readonly GraphStashInput[];
  /** Lane coloring (§6.3.6). Default `'column'`. */
  colorMode?: ColorMode;
  /** Number of palette entries color indices are taken modulo. Default 12. */
  paletteSize?: number;
  /** Rows a freed lane stays unusable (§6.3.4). Default 1. */
  laneReuseCooldown?: number;
  /** Where new merge-parent lanes go (§5.5). Default `'right-first'`. */
  mergeLanePlacement?: MergeLanePlacement;
  /**
   * Commits that never become rows even when the log stream contains them (hidden stashes and their
   * index/untracked helper commits, spec 04 §6.4).
   */
  omit?: readonly Sha[];
  /** Convergence checkpoint interval in rows (§6.10). Default 1024. */
  checkpointInterval?: number;
  /** Rows that must match after a checkpoint before an old suffix is adopted (§6.10). Default 64. */
  convergenceVerify?: number;
}

/** One edge in a gap (between row `gap` and row `gap + 1`). */
export interface GraphEdge {
  gap: number;
  /** Column at row `gap`. */
  from: number;
  /** Column at row `gap + 1`. */
  to: number;
  kind: EdgeKind;
  dashed: boolean;
  fade: boolean;
  /** Palette index. */
  color: number;
  /** Row whose parent expectation produced this line (for ancestry highlighting, §6.6). */
  owner: number;
}

export type EdgeVisitor = (
  gap: number,
  from: number,
  to: number,
  kindFlags: number,
  color: number,
  owner: number,
) => void;
