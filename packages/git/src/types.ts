// Core engine types. Names follow spec 02 §5 (authoritative for all specs).

export type Sha = string; // 40 (or 64 for sha256 repos) hex chars
export type RepoId = string; // stable hash of absolute, realpath'd worktree root

export type VersionTuple = [number, number, number];

export interface GitFeatureFlags {
  worktreeListZ: boolean; // >= 2.36
  statusShowStash: boolean; // >= 2.35
  pathspecFromFile: boolean; // >= 2.26
  forceIfIncludes: boolean; // >= 2.30
  mergeTreeWriteTree: boolean; // >= 2.38 (conflict prediction, specs 08/10/14)
  builtinFsmonitor: boolean; // >= 2.37 on win/mac
  configShowScope: boolean; // >= 2.26
}

export interface GitExecutableInfo {
  kind: 'bundled' | 'system';
  path: string;
  version: string; // "2.47.1"
  versionTuple: VersionTuple;
  lfsVersion?: string; // "3.6.0" or undefined if git-lfs missing
  features: GitFeatureFlags;
}

export type GitErrorCode =
  | 'NotARepository'
  | 'GitNotFound'
  | 'GitTooOld'
  | 'AuthenticationFailed'
  | 'AuthCancelled'
  | 'HostKeyVerificationFailed'
  | 'PermissionDenied'
  | 'RepositoryNotFound'
  | 'NetworkUnreachable'
  | 'ProxyAuthRequired'
  | 'SslError'
  | 'Timeout'
  | 'PushRejectedNonFastForward'
  | 'PushRejectedStaleLease'
  | 'PushRejectedByRemote'
  | 'ProtectedBranch'
  | 'NoUpstream'
  | 'UpstreamGone'
  | 'NotFastForwardable'
  | 'MergeConflict'
  | 'RebaseConflict'
  | 'CherryPickConflict'
  | 'RevertConflict'
  | 'StashConflict'
  | 'LocalChangesWouldBeOverwritten'
  | 'UntrackedWouldBeOverwritten'
  | 'DirtyWorktree'
  | 'NothingToCommit'
  | 'EmptyCommitMessage'
  | 'HookFailed'
  | 'IndexLocked'
  | 'RefLocked'
  | 'BranchAlreadyExists'
  | 'BranchNotFullyMerged'
  | 'BranchCheckedOutInWorktree'
  | 'InvalidRefName'
  | 'TagAlreadyExists'
  | 'RemoteAlreadyExists'
  | 'RemoteNotFound'
  | 'UnbornBranch'
  | 'DetachedHead'
  | 'ShallowRepository'
  | 'LfsMissing'
  | 'LfsError'
  | 'SubmoduleError'
  | 'GpgSigningFailed'
  | 'OutputTooLarge' // spec 02 §5.4 maxBuffer ("GitOutputTooLarge")
  | 'Cancelled'
  | 'Unknown';

export interface SerializedGitError {
  code: GitErrorCode;
  message: string; // human, localized in renderer from code + details
  details?: Record<string, string | number | string[]>;
  exitCode: number | null;
  stderr: string; // redacted
  command: string; // redacted argv, e.g. "git push --porcelain origin main"
  opId?: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedGitError };

export interface ProgressEvent {
  phase: string;
  percent: number | null;
  current?: number;
  total?: number;
  overall: number | null; // 0..1, monotonically non-decreasing per op
  text: string;
}

export interface CommandLogEntry {
  id: string;
  opId?: string;
  argv: string[];
  cwd: string;
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  stdoutPreview: string;
  stderr: string;
}

// ---- repo (spec 02 §5.1) ----

export interface RepoInfo {
  id: RepoId;
  worktreeRoot: string | null; // null for bare
  gitDir: string; // absolute
  commonDir: string; // differs from gitDir inside linked worktrees
  isBare: boolean;
  isShallow: boolean;
  isLinkedWorktree: boolean;
  objectFormat: 'sha1' | 'sha256';
  head: HeadInfo;
  state: RepoState;
}
export type HeadInfo =
  | { kind: 'branch'; name: string; sha: Sha | null } // sha null => unborn branch (empty repo)
  | { kind: 'detached'; sha: Sha };
export type RepoState =
  | 'clean'
  | 'merging'
  | 'rebasing'
  | 'rebasing-interactive'
  | 'applying-mailbox'
  | 'cherry-picking'
  | 'reverting'
  | 'bisecting';

// ---- status (porcelain v2) ----

export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U';
export interface StatusEntryBase {
  path: string;
  /**
   * Raw path bytes (base64) when the path is not valid UTF-8 (spec 02 §8, Linux only). Pass
   * `rawPathKey(rawPath)` instead of `path` to ops so they target the right file.
   */
  rawPath?: string;
}
export interface OrdinaryEntry extends StatusEntryBase {
  kind: 'ordinary';
  index: StatusCode;
  worktree: StatusCode;
  submodule: SubmoduleStatusFlags | null;
  modeHead: string;
  modeIndex: string;
  modeWorktree: string;
  shaHead: Sha;
  shaIndex: Sha;
}
export interface RenamedEntry extends Omit<OrdinaryEntry, 'kind'> {
  kind: 'renamed';
  origPath: string;
  /** Raw bytes (base64) of `origPath` when it is not valid UTF-8. */
  origRawPath?: string;
  op: 'R' | 'C';
  score: number;
}
export interface UnmergedEntry extends StatusEntryBase {
  kind: 'unmerged';
  conflict: 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU';
  submodule: SubmoduleStatusFlags | null;
  stages: { base?: Sha; ours?: Sha; theirs?: Sha };
}
export interface UntrackedEntry extends StatusEntryBase {
  kind: 'untracked';
}
export interface IgnoredEntry extends StatusEntryBase {
  kind: 'ignored';
}
export type StatusEntry = OrdinaryEntry | RenamedEntry | UnmergedEntry | UntrackedEntry | IgnoredEntry;
export interface SubmoduleStatusFlags {
  commitChanged: boolean;
  modified: boolean;
  untracked: boolean;
}
export interface StatusResult {
  branch: { oid: Sha | null; head: string | null; upstream?: string; ahead?: number; behind?: number };
  stashCount: number;
  entries: StatusEntry[];
  truncatedUntracked?: boolean; // see spec 02 §8 huge repos
}

// ---- commits / log ----

export interface CommitSummary {
  sha: Sha;
  parents: Sha[];
  authorName: string;
  authorEmail: string;
  authorTime: number; // unix seconds
  committerName: string;
  committerEmail: string;
  commitTime: number;
  subject: string;
  body?: string; // only on detail fetch
  signature?: 'G' | 'B' | 'U' | 'X' | 'Y' | 'R' | 'E' | 'N'; // %G?, only when requested
}
export interface LogPage {
  commits: CommitSummary[];
  cursor: string | null;
  done: boolean;
}
export interface CommitDetail extends CommitSummary {
  body: string;
  files: FileChangeSummary[];
}

export interface LogQuery {
  revs: string[] | 'all'; // 'all' => branches, remotes, tags + HEAD + stash tips (spec 02 §6.6)
  order: 'topo' | 'date' | 'author-date';
  paths?: string[]; // file history (spec 07)
  follow?: boolean; // only valid with exactly one path
  author?: string | string[]; // multiple values are ORed (repeated --author)
  grep?: string;
  since?: number;
  until?: number;
  firstParent?: boolean;
  hiddenRefs?: string[]; // refs hidden in left panel (excluded with --exclude)
  includeSignatureStatus?: boolean; // expensive; off by default
}

// ---- refs ----

export interface RefInfo {
  fullName: string; // refs/heads/main
  shortName: string; // main / origin/main / v1.0
  type: 'local' | 'remote' | 'tag' | 'stash' | 'other';
  sha: Sha; // tip (peeled for annotated tags)
  tagObjectSha?: Sha; // annotated tag object
  upstream?: {
    fullName: string;
    ahead: number;
    behind: number;
    gone: boolean;
    /**
     * Ahead/behind not computed yet (repos with many tracking branches, spec 02 §6.15.5): the counts are
     * the last known ones (0 when never computed); a `refs` refresh follows once they are.
     */
    trackPending?: boolean;
  };
  isHead: boolean;
  worktreePath?: string; // branch checked out in some (other) worktree
  symrefTarget?: string; // refs/remotes/origin/HEAD -> refs/remotes/origin/main
  subject?: string;
  creatorDate?: number;
}

// ---- branch cleanup (spec 05 §6.13) ----

/**
 * Why a local branch is a cleanup candidate. `merged` / `squash-merged` / `rebase-merged` mean its work is
 * already in the base branch; `upstream-gone` means the remote branch was deleted but the work was not
 * found in the base (e.g. a PR closed without merging).
 */
export type BranchCleanupReason = 'merged' | 'squash-merged' | 'rebase-merged' | 'upstream-gone';

export interface BranchCleanupCandidate {
  name: string; // feature/x
  sha: Sha; // tip at scan time; the delete is skipped if it moved
  reason: BranchCleanupReason;
  upstream?: string; // origin/feature/x
  upstreamGone: boolean;
  /** Commits on the branch that are not ancestors of the base (0 for `merged`). */
  aheadOfBase: number;
  committerDate: number; // unix seconds of the tip
  authorName: string;
  subject: string;
}

export interface BranchCleanupScan {
  /** Short name of the branch compared against (`origin/main`); null when none could be found. */
  base: string | null;
  baseSha: Sha | null;
  candidates: BranchCleanupCandidate[];
  /** Local branches never offered: current, checked out in a worktree, the base and its local twin, main/master/develop. */
  protectedBranches: string[];
}

// ---- diff ----

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: 'A' | 'D' | 'M' | 'R' | 'C' | 'T' | 'U';
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  lfsPointer?: { oid: string; size: number }; // detected pointer (spec 09)
  submodule?: { oldSha?: Sha; newSha?: Sha };
  hunks: DiffHunk[];
  tooLarge?: boolean; // > limits; hunks empty
  additions: number;
  deletions: number;
  noNewlineAtEof?: { old: boolean; new: boolean };
}
export interface DiffHunk {
  header: string; // "@@ -1,4 +1,5 @@ fn foo()"
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: DiffLine[];
}
export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'nonewline';
  content: string; // without the leading +/-/space
  oldLineNo?: number;
  newLineNo?: number;
  patchOffset: number; // index within hunk, used to build partial patches (spec 06)
}

export type DiffSpec =
  | { kind: 'workdir'; paths?: string[] } // index -> worktree
  | { kind: 'staged'; paths?: string[] } // HEAD -> index (--cached)
  | { kind: 'commit'; sha: Sha; parentIndex?: number; paths?: string[] } // parent -> commit
  | { kind: 'range'; from: string; to: string; threeDot?: boolean; paths?: string[] }
  | { kind: 'untracked'; path: string }; // --no-index /dev/null path

export interface FileChangeSummary {
  path: string;
  oldPath?: string;
  status: FileDiff['status'];
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface DiffOptions {
  contextLines?: number;
  ignoreWhitespace?: 'none' | 'eol' | 'amount' | 'all';
  /** Default 2 MiB; beyond => tooLarge with empty hunks. */
  maxBytesPerFile?: number;
  /** `--ignore-blank-lines` (spec 07 §4.5). */
  ignoreBlankLines?: boolean;
  /** `-l<n>` rename detection limit (spec 07 §6.2; preference `diff.renameLimit`). */
  renameLimit?: number;
}

export interface ShowFileResult {
  content: string | null;
  binary: boolean;
  size: number;
  encoding: 'utf8' | 'base64';
  /** Object does not exist at that revision (content null, size 0). */
  missing?: boolean;
  /** Blob is larger than maxBytes (content null). */
  tooLarge?: boolean;
}

// ---- misc ----

export interface StashEntry {
  index: number;
  ref: string;
  sha: Sha;
  parents: Sha[];
  message: string;
  time: number;
}
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  fetchRefspecs: string[];
}

// ---- search ----

export type SearchKind = 'message' | 'author' | 'sha' | 'file' | 'content' | 'regex';
/** Field of one search term (spec 12 §5 `GraphSearchReq.fields`); `any` = message OR author OR sha. */
export type SearchField = 'any' | 'message' | 'author' | 'sha' | 'path' | 'content';
/** One term of a multi-term query (spec 12 §11); terms are ANDed. */
export interface SearchTerm {
  field: SearchField;
  text: string;
  /** message: ERE (`--grep … -E`); content: `-G` diff regex instead of pickaxe `-S`. */
  regex?: boolean;
}
export interface SearchQuery {
  kind: SearchKind;
  text: string;
  limit?: number; // default 1000
  caseSensitive?: boolean;
  /** ANDed terms (spec 12 §11 query syntax). When present, `kind` / `text` are ignored. */
  terms?: SearchTerm[];
  /** Registers the search for `graph:search:cancel` and `graph:search:progress` (spec 12 §6.7). */
  searchId?: string;
}
/** Snapshot of a running / finished full-history search (spec 12 §8 "partial results streamed"). */
export interface SearchProgress {
  searchId: string;
  /** Commits examined so far; null when git does all the filtering (only matches are printed). */
  scanned: number | null;
  /** Matches so far, newest first (from the `from` offset of the request). */
  shas: Sha[];
  /** Total matches so far (independent of `from`). */
  total: number;
  /** Committer time (unix s) of the last commit output: how far back the scan has reached. */
  reachedTime: number | null;
  done: boolean;
  cancelled: boolean;
}

// ---- refresh scopes (spec 02 §5.3) ----

/** Parts of the UI to refresh after a watcher event or an operation. */
export type RefreshScope =
  | 'status'
  | 'refs'
  | 'graph'
  | 'stash'
  | 'repoState'
  | 'config'
  | 'remotes'
  | 'worktrees'
  | 'submodules'
  | 'conflicts';

// ---- blame, worktrees, submodules, conflicts (spec 02 §5.1; Phase 3) ----

export interface BlameLine {
  sha: Sha;
  origLine: number;
  finalLine: number;
  content: string;
}
export interface BlameCommitInfo {
  sha: Sha;
  author: string;
  authorMail: string;
  authorTime: number;
  authorTz: string;
  committer: string;
  committerTime: number;
  summary: string;
  previous?: { sha: Sha; path: string };
  filename: string;
  boundary: boolean;
}
export interface BlameResult {
  commits: Record<Sha, BlameCommitInfo>;
  lines: BlameLine[];
}

export interface WorktreeInfo {
  path: string;
  head: Sha | null;
  branch?: string; // refs/heads/x
  detached: boolean;
  bare: boolean;
  locked?: string | true;
  prunable?: string | true;
  isMain: boolean;
  isCurrent: boolean;
}

export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string;
  branch?: string;
  recordedSha: Sha | null;
  checkedOutSha: Sha | null;
  state: 'uninitialized' | 'in-sync' | 'out-of-sync' | 'conflict';
  describe?: string;
}

export interface ConflictStage {
  mode: string;
  sha: Sha;
}
export interface ConflictFile {
  path: string;
  stages: { base?: ConflictStage; ours?: ConflictStage; theirs?: ConflictStage };
}

/** In-progress operation as seen by the conflict UI (spec 08 §5). */
export type InProgressOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash-apply' | 'am';
export type ConflictCode = 'UU' | 'AA' | 'DU' | 'UD' | 'AU' | 'UA' | 'DD';
export interface ConflictFileInfo extends ConflictFile {
  code: ConflictCode;
  kind: 'text' | 'binary' | 'submodule' | 'symlink' | 'lfs';
  /**
   * Text conflicts: conflict-marker blocks left in the working file (spec 08 §4.2 "2 conflicts"). 0 while the
   * path is still unmerged = edited outside the app until no markers remain ("Resolved outside the app").
   */
  unresolvedChunks?: number;
  /** A custom `merge=<driver>` attribute (spec 08 §6.4): the built-in text tool is disabled. */
  mergeDriver?: string;
}
export interface RepoOperationState {
  op: InProgressOp | null;
  /** Pane A ("ours") and pane B ("theirs") labels, e.g. "main" / "feature/x" or the commit being applied. */
  current: { label: string; sha: Sha | null };
  incoming: { label: string; sha: Sha | null };
  base?: { sha: Sha | null };
  rebase?: {
    step: number;
    total: number;
    ontoLabel: string;
    currentCommit: { sha: Sha; subject: string } | null;
  };
  sequencer?: { remaining: Sha[] };
  /** MERGE_MSG (or the commit message being replayed). */
  message?: string;
  conflicts: ConflictFileInfo[];
  /** Paths resolved (staged) during this operation: index resolve-undo entries no longer unmerged (spec 08 §5). */
  resolvedPending?: string[];
  /** Stash apply/pop conflicts: the newest stash (kept by git on conflict), offered for dropping afterwards. */
  stash?: { index: number; sha: Sha; message: string };
}

/** Contents for the 3-way merge tool (spec 08 `conflict:loadFile`). `null` = side absent (add/delete). */
export interface ConflictFileContents {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string | null;
  /** `git merge-file -p --diff3` output (conflict markers with base section). */
  mergedDiff3: string | null;
  binary: boolean;
  eol: '\n' | '\r\n';
  /** `.gitattributes` `merge=<driver>`: `mergedDiff3` is the working file as the driver left it (spec 08 §6.4). */
  mergeDriver?: string;
  /** `binary` / `-merge` attribute: never offer a text merge (spec 08 §8). */
  attrBinary?: boolean;
}

export interface ConflictPrediction {
  supported: boolean;
  conflicts: string[];
}

export type TodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
export interface TodoItem {
  sha: Sha;
  action: TodoAction;
  summary: string;
  /** For reword / the target of squashes. */
  newMessage?: string;
}

export interface LfsStatus {
  /** git-lfs available on PATH/bundle. */
  available: boolean;
  /** `git lfs install` hooks present for this repo. */
  initialized: boolean;
  tracked: { pattern: string; lockable: boolean }[];
  locks: { id: string; path: string; owner: string; lockedAt: string }[];
}

// ---- config (spec 02 §5.1, §6.11) ----

export type ConfigScope = 'system' | 'global' | 'local' | 'worktree' | 'command';
export interface ConfigEntry {
  scope: ConfigScope;
  /** `file:<path>`, `command line:`, `blob:<oid>` … */
  origin: string;
  key: string;
  value: string;
  /** The value was masked (secret key or credentials in a URL). */
  redacted?: boolean;
}

// ---- huge repositories (spec 02 §6.15) ----

/** fsmonitor / untracked-cache offer for large worktrees (spec 02 §6.15.2). */
export interface PerfAdvice {
  trackedFiles: number;
  /** Over the 50k tracked-file threshold. */
  large: boolean;
  fsmonitor: {
    /** Builtin daemon available (git ≥ 2.37 on Windows/macOS). */
    supported: boolean;
    /** `core.fsmonitor` value: builtin (`true`), a custom hook path, or unset/false. */
    mode: 'builtin' | 'hook' | 'off';
  };
  untrackedCache: boolean;
  /** What the app should offer to enable (both false when nothing to offer). */
  offer: { fsmonitor: boolean; untrackedCache: boolean };
}
