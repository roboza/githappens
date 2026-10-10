import type {
  CommitDetail,
  DiffOptions,
  DiffSpec,
  FileChangeSummary,
  FileDiff,
  GitExecutableInfo,
  LogPage,
  LogQuery,
  RefInfo,
  RemoteInfo,
  RepoId,
  RepoInfo,
  SearchQuery,
  Sha,
  ShowFileResult,
  StashEntry,
  StatusResult,
  BlameResult,
  ConfigEntry,
  ConfigScope,
  ConflictFile,
  ConflictFileContents,
  PerfAdvice,
  ConflictPrediction,
  LfsStatus,
  RepoOperationState,
  SubmoduleInfo,
  TodoItem,
  WorktreeInfo,
} from '@githappens/git/types';
import type { SignatureInfo } from '@githappens/git/signature';
import type {
  CheckoutPreflight,
  CheckoutTarget,
  GitOperation,
  OpResult,
  OpStateEvent,
  UndoPeek,
} from '@githappens/git/ops';

/** Scopes the renderer refreshes when a repo changes (spec 02 §5.3). */
export type { RefreshScope } from '@githappens/git/types';
import type { RefreshScope } from '@githappens/git/types';

/**
 * Git IPC contract (spec 02 §5.3 — authoritative). Channels are added here as
 * phases implement them.
 */
export interface GitIpcContract {
  // ---- engine ----
  'git:engine:info': { req: Record<string, never>; res: GitExecutableInfo };
  'git:engine:setExecutable': { req: { kind: 'bundled' | 'system'; path?: string }; res: GitExecutableInfo };
  // ---- repo lifecycle ----
  'git:repo:open': { req: { path: string }; res: RepoInfo };
  'git:repo:close': { req: { repoId: RepoId }; res: void };
  'git:repo:info': { req: { repoId: RepoId }; res: RepoInfo };
  // ---- reads ----
  /** `worktreePath`: status of another linked worktree of this repo (spec 02 §11, `--untracked-files=normal`). */
  'git:status': {
    req: { repoId: RepoId; untracked?: 'all' | 'normal' | 'no'; worktreePath?: string };
    res: StatusResult;
  };
  'git:log:start': { req: { repoId: RepoId; query: LogQuery; pageSize: number }; res: LogPage };
  'git:log:next': { req: { repoId: RepoId; cursor: string; pageSize: number }; res: LogPage };
  'git:log:dispose': { req: { repoId: RepoId; cursor: string }; res: void };
  'git:commit:detail': { req: { repoId: RepoId; sha: Sha }; res: CommitDetail };
  'git:refs': { req: { repoId: RepoId }; res: RefInfo[] };
  'git:revParse': { req: { repoId: RepoId; rev: string }; res: Sha | null };
  'git:diff': { req: { repoId: RepoId; spec: DiffSpec; options?: DiffOptions }; res: FileDiff[] };
  'git:diff:numstat': { req: { repoId: RepoId; spec: DiffSpec }; res: FileChangeSummary[] };
  'git:show:file': {
    req: { repoId: RepoId; rev: string; path: string; maxBytes?: number };
    res: ShowFileResult;
  };
  /** Working-tree side of WIP diffs (our addition; spec 07 split/inline views need full file text). */
  'git:worktree:readFile': { req: { repoId: RepoId; path: string; maxBytes?: number }; res: ShowFileResult };
  'git:stash:list': { req: { repoId: RepoId }; res: StashEntry[] };
  'git:remotes': { req: { repoId: RepoId }; res: RemoteInfo[] };
  /** Full-history search (spec 04 §4.12 / spec 12). Phase 1 returns all hits at once instead of streaming. */
  'graph:search': { req: { repoId: RepoId; query: SearchQuery }; res: { shas: Sha[] } };
  // ---- read helpers for write flows (specs 05, 06) ----
  'git:checkout:preflight': { req: { repoId: RepoId; target: CheckoutTarget }; res: CheckoutPreflight };
  'git:branch:validateName': {
    req: { repoId: RepoId; name: string };
    res: { valid: boolean; reason?: string };
  };
  'git:commit:headMessage': { req: { repoId: RepoId }; res: { summary: string; description: string } };
  'git:undo:peek': { req: { repoId: RepoId }; res: UndoPeek };
  // ---- Phase 3 reads (specs 05, 07, 08, 09) ----
  'git:conflict:state': { req: { repoId: RepoId }; res: RepoOperationState };
  'git:conflict:loadFile': { req: { repoId: RepoId; path: string }; res: ConflictFileContents };
  'git:conflict:predict': { req: { repoId: RepoId; ours: string; theirs: string }; res: ConflictPrediction };
  'git:rebase:todoFor': { req: { repoId: RepoId; upstream: string; branch?: string }; res: TodoItem[] };
  /** `opts` map to `-w` / `-M` / `-C` (spec 07 §4.10); the streaming variant is `blame:start`. */
  'git:blame': {
    req: {
      repoId: RepoId;
      path: string;
      rev?: string;
      opts?: { ignoreWhitespace?: boolean; detectMoves?: boolean; detectCopies?: boolean };
    };
    res: BlameResult;
  };
  'git:worktrees': { req: { repoId: RepoId }; res: WorktreeInfo[] };
  'git:submodules': { req: { repoId: RepoId }; res: SubmoduleInfo[] };
  'git:lfs:status': { req: { repoId: RepoId }; res: LfsStatus };
  /** Commit signature status for "Verified" badges (spec 06 §6.8). */
  'git:commit:verify': { req: { repoId: RepoId; shas: Sha[] }; res: Record<Sha, SignatureInfo> };
  'git:isAncestor': { req: { repoId: RepoId; ancestor: string; descendant: string }; res: boolean };
  /** `null` = no common ancestor (spec 02 §6.8); `fork-point` uses the reflog of `a`. */
  'git:mergeBase': {
    req: { repoId: RepoId; a: string; b: string; mode?: 'default' | 'fork-point' };
    res: Sha | null;
  };
  /** Unmerged paths with their index stages (`ls-files -u`, spec 02 §6.11). */
  'git:conflicts': { req: { repoId: RepoId }; res: ConflictFile[] };
  /**
   * Config entries (spec 02 §6.11); `pattern` → `--get-regexp` (e.g. `^gitflow.`). Without a repo only
   * system/global entries. Secret values (tokens, passwords, credentials in URLs) come back masked.
   */
  'git:config:list': {
    req: { repoId?: RepoId; scope?: ConfigEntry['scope']; pattern?: string };
    res: ConfigEntry[];
  };
  'git:config:get': { req: { repoId?: RepoId; key: string; scope?: ConfigScope }; res: string | null };
  /** fsmonitor / untracked-cache offer for huge worktrees (spec 02 §6.15.2). */
  'git:perf:advice': { req: { repoId: RepoId }; res: PerfAdvice };
  /** How file changes are detected: `polling` → status-bar "File watching unavailable" (spec 02 §6.14). */
  'git:watch:state': { req: { repoId: RepoId }; res: { mode: 'native' | 'polling' | 'off' } };
  // ---- writes (always queued, spec 02 §5.3) ----
  /** Queued (`config.set` op) when `repoId` is set; `value: null` unsets (`--unset-all`). */
  'git:config:set': {
    req: { repoId?: RepoId; key: string; value: string | null; scope: 'global' | 'local' | 'worktree' };
    res: void;
  };
  'git:op:run': { req: { repoId: RepoId; op: GitOperation }; res: OpResult };
  'git:op:cancel': { req: { repoId: RepoId; opId: string }; res: void };
  'git:lock:remove': { req: { repoId: RepoId; lockPath: string }; res: void };
  'git:prompt:answer': { req: { promptId: string; value: string | null; remember?: boolean }; res: void };
}

export interface GitEventContract {
  'git:engine:changed': GitExecutableInfo;
  'git:repo:changed': {
    repoId: RepoId;
    scopes: RefreshScope[];
    reason: 'watcher' | 'op' | 'focus' | 'manual';
  };
  'git:op:state': OpStateEvent & { repoId: RepoId };
  'git:progress': {
    repoId: RepoId;
    opId: string;
    phase: string;
    percent: number | null;
    current?: number;
    total?: number;
    overall: number | null;
    text: string;
  };
  /** Credential / passphrase / host-key prompt routed from askpass (spec 02 §6.3). */
  'git:prompt': {
    promptId: string;
    kind: 'username' | 'password' | 'passphrase' | 'hostkey' | 'generic';
    text: string;
    host?: string;
  };
}
