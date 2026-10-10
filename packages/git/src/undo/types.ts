import type { GitOperation } from '../ops/types';
import type { RepoId, Sha } from '../types';

/** Full ref name, e.g. `refs/heads/main` (or `HEAD` for a detached HEAD). */
export type RefName = string;

/** Journal entry kinds (spec 05 §5) plus the network barrier kinds (spec 05 §6.11 "not undoable"). */
export type JournalKind =
  | 'checkout'
  | 'commit'
  | 'amend'
  | 'discard'
  | 'branch-create'
  | 'branch-delete'
  | 'branch-rename'
  | 'reset'
  | 'rebase'
  | 'interactive-rebase'
  | 'cherry-pick'
  | 'revert'
  | 'merge'
  | 'fast-forward'
  | 'stash-push'
  | 'stash-pop'
  | 'stash-drop'
  | 'tag-create'
  | 'tag-delete'
  | 'remote-remove'
  | 'ai-compose'
  | 'gitflow-finish'
  | 'revert-hunk'
  | 'mark-resolved'
  | 'patch-apply'
  // Phase 8 (spec 05 §6.9, §6.10)
  | 'squash'
  | 'stash-rename'
  | 'stash-apply'
  // barriers
  | 'fetch'
  | 'pull'
  | 'push'
  | 'remote-delete'
  | 'network';

export type SnapshotHead = { kind: 'branch'; name: string } | { kind: 'detached'; sha: Sha };

export interface StashListEntry {
  sha: Sha;
  /** Reflog subject as shown by `git stash list` ("On main: msg"); re-used by `git stash store -m`. */
  message: string;
}

/** spec 05 §5 `RepoSnapshot`, extended with the extra state some kinds need. */
export interface RepoSnapshot {
  head: SnapshotHead;
  headSha: Sha | null;
  /** Only refs the op may change (`null` = absent). */
  touchedRefs: Record<RefName, Sha | null>;
  /** `git write-tree` of the index (when the op touches the index). */
  indexTree?: Sha;
  /**
   * Tree of the whole worktree incl. untracked (non-ignored) files, captured through a temporary index
   * (`GIT_INDEX_FILE=<tmp> git add -A && git write-tree`). Replaces spec 05's `worktreeStash` + separate
   * untracked tree: one tree holds both.
   */
  worktreeTree?: Sha;
  /** Full stash list, newest first (when the op touches the stash). */
  stash?: StashListEntry[];
  /** `branch.<name>.*` config entries (upstream etc.) for branches the op may create/delete. */
  branchConfig?: Record<string, [key: string, value: string][]>;
  /** Remote config + remote-tracking refs of the scope's remotes (remote-remove, spec 05 §6.11). */
  remotes?: Record<string, { config: [key: string, value: string][]; refs: Record<RefName, Sha> }>;
  /** Every `branch.*` config entry, by branch (removing a remote also drops the upstreams that use it). */
  allBranchConfig?: Record<string, [key: string, value: string][]>;
  /** `git ls-files -s -z` of the scope's `indexEntries` paths, incl. conflict stages (mark-resolved). */
  indexEntries?: string;
}

/** What a kind's snapshot covers; derived from the op at `begin()`. */
export interface SnapshotScope {
  /**
   * How HEAD is involved:
   * - `none`: not captured/compared;
   * - `check`: compared (kind/name) but moved only through `touchedRefs` (commit/amend = soft reset);
   * - `switch`: moved with `git switch` carrying local changes (checkout "carry", branch create + checkout);
   * - `set`: moved with `symbolic-ref`/`update-ref --no-deref` while index+worktree are restored from trees.
   */
  head: 'none' | 'check' | 'switch' | 'set';
  refs: RefName[];
  trees: boolean;
  stash: boolean;
  configBranches: string[];
  /** branch rename: undo/redo with `git branch -m` (moves HEAD, config and reflog too). */
  rename?: { from: string; to: string };
  /** Remotes whose config and remote-tracking refs are captured (remote-remove). */
  remotes?: string[];
  /**
   * Paths whose raw index entries (all stages) are captured and restored with `update-index --index-info`
   * (mark-resolved, spec 05 §11): undo re-creates the conflict without touching the worktree file.
   */
  indexEntries?: string[];
}

export interface JournalEntry {
  id: string;
  repoId: RepoId;
  ts: number;
  kind: JournalKind;
  /** "Checkout feature/x" */
  label: string;
  /** The operation that produced this entry (for diagnostics). */
  op: GitOperation;
  scope: SnapshotScope;
  before: RepoSnapshot;
  /** Filled when the op succeeds. */
  after?: RepoSnapshot;
  extra?: {
    /** Paths whose index entry differs between before and after. */
    indexPaths?: string[];
    /** Paths whose worktree content differs between before and after. */
    worktreePaths?: string[];
  };
  /** Keep-alive refs (`refs/githappens/undo/<id>/<n>`) created for this entry. */
  pins: RefName[];
  undoable: boolean;
  status: 'pending' | 'done' | 'undone' | 'failed';
}
