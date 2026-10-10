# 02 — Git Engine (GitService, IPC Contract, Parsers, Watcher, OperationQueue)

> Binding decisions from `00-overview.md` apply: every git command runs in the **main process** through a typed `GitService` that wraps the **git CLI**. Each open repo has one `OperationQueue` and one `RepoWatcher`. Pure command builders and output parsers live in `/packages/git`. Process orchestration, queueing, watching, and IPC handlers live in `/apps/desktop/src/main/git`.

---

## 1. Purpose

Everything the user sees, including the graph, the WIP/staging panel, diffs, blame, branches, remotes, and conflicts, is derived from git output. The engine must:

- run git **correctly** (right binary, right environment, never hangs on a prompt, deterministic machine-readable output);
- run git **safely** (no `index.lock` races, cancellable, credentials never in argv or logs);
- run git **fast** (incremental graph paging, minimal refresh on file changes, tuned for 100k+ commit and 100k+ file repos);
- expose a **typed, versioned IPC contract** so renderer features never parse git output or know command lines.

The same engine powers every other spec. Spec 05 (operations), 06 (staging), 07 (diff/blame), 08 (conflicts), and 09 (remotes) only add command builders and parsers on top of this foundation.

## 2. Reference behavior

- Desktop Git clients have historically run most operations through **NodeGit (libgit2)**, with the git executable as a later, experimental option; current clients ship a bundled git that is updated with app releases. GitHappens runs the CLI from day one, as binding decision #2 requires.
- LFS workflows need a **system** Git (2.39.3+) and Git LFS (3.0+) installed and on PATH. A missing LFS section in Preferences means git or git-lfs is not on PATH. On macOS, GUI apps do not inherit shell PATH, so Homebrew paths can be missing. We handle this with shell-env resolution (§6.1).
- The app **auto-refreshes** when files change on disk and when the window regains focus (inferred from observed behavior). The WIP node updates without user action.
- The app shows a toast with an action when an operation fails. For example, a stale `index.lock` produces a message telling the user that another git process may be running, with an option to delete the lock (inferred).
- Hooks run with the repo's hooks path, or a per-repo custom path. Any non-zero exit blocks the action and surfaces an error notification (see spec 09 §Hooks).
- Long operations show a progress bar in the toolbar or status area, and some can be cancelled (inferred).

## 3. User stories

1. As a user, I want the app to work with no git installed, so that onboarding is one step. The bundled git covers this.
2. As a power user, I want to point the app at my system git, so that my custom build, credential helper, and config behave exactly as on the CLI.
3. As a user on a huge monorepo, I want the graph to appear in under a second and scroll smoothly, so that I am not waiting on a full `git log`.
4. As a user, I want external changes (editor saves, CLI commits) reflected in the app within about 0.5 s without manual refresh.
5. As a user, I want to cancel a slow fetch or clone and have the repo left in a consistent state.
6. As a user, I want clear, actionable error messages ("Push rejected: remote has commits you don't have. Pull first?") instead of raw stderr. The raw output should still be one click away.
7. As a developer of this app, I want every parser unit-tested against captured git output and real fixture repos, so that git upgrades don't silently break the UI.

## 4. UI specification (engine-facing surfaces only)

The engine has little UI of its own, but it owns these surfaces:

| Surface | Description |
|---|---|
| **Activity / Output log** | A bottom drawer listing each git invocation for the active repo: time, op label, duration, exit code, and expandable stdout/stderr (redacted). Opened from the status bar or from "View output" on error toasts. The latest 500 entries per repo are kept in memory. |
| **Progress indicator** | The toolbar shows an indeterminate or determinate bar for the current queued op, with a label from the progress phase ("Receiving objects 43%") and a **Cancel** button when `cancellable`. |
| **Error toast** | Typed error → title, human message, and actions (`Retry`, `Pull`, `Force push…`, `Delete lock file`, `View output`). |
| **Git executable setting** | Preferences > Git: radio **Bundled git (version x)** / **System git** with a path picker and "Detected: /usr/bin/git 2.45.1". Validation message if version < minimum. |
| **Busy state** | While a mutating op runs, drag-and-drop targets and mutating context menu items are disabled. Reads keep working. |
| **Lock dialog** | "A git lock file exists (`.git/index.lock`, created 3 min ago). Another git process may be running." → **Delete lock & retry** / **Cancel**. |

States: when git is unavailable (bundled git missing or corrupt and no system git), a blocking full-window error shows a "Choose git executable…" action.

## 5. Data model & IPC

### 5.1 Core types (`/apps/desktop/src/shared/git-types.ts`)

```ts
export type Sha = string;            // 40 (or 64 for sha256 repos) hex chars
export type RepoId = string;         // stable hash of absolute, realpath'd worktree root

export interface GitExecutableInfo {
  kind: 'bundled' | 'system';
  path: string;
  version: string;                   // "2.47.1"
  versionTuple: [number, number, number];
  lfsVersion?: string;               // "3.6.0" or undefined if git-lfs missing
  features: GitFeatureFlags;
}
export interface GitFeatureFlags {
  worktreeListZ: boolean;            // >= 2.36
  statusShowStash: boolean;          // >= 2.35
  pathspecFromFile: boolean;         // >= 2.26
  forceIfIncludes: boolean;          // >= 2.30
  mergeTreeWriteTree: boolean;       // >= 2.38 (conflict prediction, specs 08/10/14)
  builtinFsmonitor: boolean;         // >= 2.37 on win/mac
  configShowScope: boolean;          // >= 2.26
}

export interface RepoInfo {
  id: RepoId;
  worktreeRoot: string | null;       // null for bare
  gitDir: string;                    // absolute
  commonDir: string;                 // differs from gitDir inside linked worktrees
  isBare: boolean;
  isShallow: boolean;
  isLinkedWorktree: boolean;
  objectFormat: 'sha1' | 'sha256';
  head: HeadInfo;
  state: RepoState;
}
export type HeadInfo =
  | { kind: 'branch'; name: string; sha: Sha | null }   // sha null => unborn branch (empty repo)
  | { kind: 'detached'; sha: Sha };
export type RepoState =
  | 'clean' | 'merging' | 'rebasing' | 'rebasing-interactive' | 'applying-mailbox'
  | 'cherry-picking' | 'reverting' | 'bisecting';

// ---- status (porcelain v2) ----
export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U';
export interface StatusEntryBase { path: string; }
export interface OrdinaryEntry extends StatusEntryBase {
  kind: 'ordinary'; index: StatusCode; worktree: StatusCode;
  submodule: SubmoduleStatusFlags | null;
  modeHead: string; modeIndex: string; modeWorktree: string; shaHead: Sha; shaIndex: Sha;
}
export interface RenamedEntry extends Omit<OrdinaryEntry, 'kind'> {
  kind: 'renamed'; origPath: string; op: 'R' | 'C'; score: number;
}
export interface UnmergedEntry extends StatusEntryBase {
  kind: 'unmerged';
  conflict: 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU';
  submodule: SubmoduleStatusFlags | null;
  stages: { base?: Sha; ours?: Sha; theirs?: Sha };
}
export interface UntrackedEntry extends StatusEntryBase { kind: 'untracked'; }
export interface IgnoredEntry extends StatusEntryBase { kind: 'ignored'; }
export type StatusEntry = OrdinaryEntry | RenamedEntry | UnmergedEntry | UntrackedEntry | IgnoredEntry;
export interface SubmoduleStatusFlags { commitChanged: boolean; modified: boolean; untracked: boolean; }
export interface StatusResult {
  branch: { oid: Sha | null; head: string | null; upstream?: string; ahead?: number; behind?: number };
  stashCount: number;
  entries: StatusEntry[];
  truncatedUntracked?: boolean;      // see §8 huge repos
}

// ---- commits / log ----
export interface CommitSummary {
  sha: Sha; parents: Sha[];
  authorName: string; authorEmail: string; authorTime: number;   // unix seconds
  committerName: string; committerEmail: string; commitTime: number;
  subject: string;
  body?: string;                     // only on detail fetch
  signature?: 'G' | 'B' | 'U' | 'X' | 'Y' | 'R' | 'E' | 'N';   // %G?, only when requested
}
export interface LogPage { commits: CommitSummary[]; cursor: string | null; done: boolean; }

// ---- refs ----
export interface RefInfo {
  fullName: string;                  // refs/heads/main
  shortName: string;                 // main / origin/main / v1.0
  type: 'local' | 'remote' | 'tag' | 'stash' | 'other';
  sha: Sha;                          // tip (peeled for annotated tags)
  tagObjectSha?: Sha;                // annotated tag object
  upstream?: { fullName: string; ahead: number; behind: number; gone: boolean };
  isHead: boolean;
  worktreePath?: string;             // branch checked out in some worktree
  symrefTarget?: string;             // refs/remotes/origin/HEAD -> refs/remotes/origin/main
  subject?: string; creatorDate?: number;
}

// ---- diff ----
export interface FileDiff {
  oldPath: string | null; newPath: string | null;
  status: 'A' | 'D' | 'M' | 'R' | 'C' | 'T' | 'U';
  similarity?: number;
  oldMode?: string; newMode?: string;
  binary: boolean;
  lfsPointer?: { oid: string; size: number };     // detected pointer (spec 09)
  submodule?: { oldSha?: Sha; newSha?: Sha };
  hunks: DiffHunk[];
  tooLarge?: boolean;                // > limits; hunks empty
  additions: number; deletions: number;
  noNewlineAtEof?: { old: boolean; new: boolean };
}
export interface DiffHunk {
  header: string;                    // "@@ -1,4 +1,5 @@ fn foo()"
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  section?: string;
  lines: DiffLine[];
}
export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'nonewline';
  content: string;                   // without the leading +/-/space
  oldLineNo?: number; newLineNo?: number;
  patchOffset: number;               // index within hunk, used to build partial patches (spec 06)
}

// ---- blame ----
export interface BlameLine { sha: Sha; origLine: number; finalLine: number; content: string; }
export interface BlameCommitInfo {
  sha: Sha; author: string; authorMail: string; authorTime: number; authorTz: string;
  committer: string; committerTime: number; summary: string;
  previous?: { sha: Sha; path: string }; filename: string; boundary: boolean;
}
export interface BlameResult { commits: Record<Sha, BlameCommitInfo>; lines: BlameLine[]; }

// ---- misc ----
export interface StashEntry { index: number; ref: string; sha: Sha; parents: Sha[]; message: string; time: number; }
export interface RemoteInfo { name: string; fetchUrl: string; pushUrl: string; fetchRefspecs: string[]; }
export interface ConfigEntry { scope: 'system' | 'global' | 'local' | 'worktree' | 'command'; origin: string; key: string; value: string; }
export interface WorktreeInfo {
  path: string; head: Sha | null; branch?: string;   // refs/heads/x
  detached: boolean; bare: boolean; locked?: string | true; prunable?: string | true;
  isMain: boolean; isCurrent: boolean;
}
export interface SubmoduleInfo {
  name: string; path: string; url: string; branch?: string;
  recordedSha: Sha | null; checkedOutSha: Sha | null;
  state: 'uninitialized' | 'in-sync' | 'out-of-sync' | 'conflict';
  describe?: string;
}
export interface ConflictStage { mode: string; sha: Sha; }
export interface ConflictFile { path: string; stages: { base?: ConflictStage; ours?: ConflictStage; theirs?: ConflictStage }; }
```

### 5.2 Errors (typed taxonomy)

```ts
export type GitErrorCode =
  | 'NotARepository' | 'GitNotFound' | 'GitTooOld'
  | 'AuthenticationFailed' | 'AuthCancelled' | 'HostKeyVerificationFailed' | 'PermissionDenied'
  | 'RepositoryNotFound' | 'NetworkUnreachable' | 'ProxyAuthRequired' | 'SslError' | 'Timeout'
  | 'PushRejectedNonFastForward' | 'PushRejectedStaleLease' | 'PushRejectedByRemote' | 'ProtectedBranch'
  | 'NoUpstream' | 'UpstreamGone' | 'NotFastForwardable'
  | 'MergeConflict' | 'RebaseConflict' | 'CherryPickConflict' | 'RevertConflict' | 'StashConflict'
  | 'LocalChangesWouldBeOverwritten' | 'UntrackedWouldBeOverwritten' | 'DirtyWorktree'
  | 'NothingToCommit' | 'EmptyCommitMessage' | 'HookFailed'
  | 'IndexLocked' | 'RefLocked'
  | 'BranchAlreadyExists' | 'BranchNotFullyMerged' | 'BranchCheckedOutInWorktree' | 'InvalidRefName'
  | 'TagAlreadyExists' | 'RemoteAlreadyExists' | 'RemoteNotFound'
  | 'UnbornBranch' | 'DetachedHead' | 'ShallowRepository'
  | 'LfsMissing' | 'LfsError' | 'SubmoduleError'
  | 'GpgSigningFailed'
  | 'Cancelled' | 'Unknown';

export interface SerializedGitError {
  code: GitErrorCode;
  message: string;                   // human, localized in renderer from code + details
  details?: Record<string, string | number | string[]>;  // e.g. { files: [...] }, { lockPath }
  exitCode: number | null;
  stderr: string;                    // redacted
  command: string;                   // redacted argv, e.g. "git push --porcelain origin main"
  opId?: string;
}
```

Conflict codes (`MergeConflict`, `RebaseConflict`, `CherryPickConflict`, `RevertConflict`, `StashConflict`) are returned as `{ ok: false, error }` with `details.files` listing the unmerged paths. The renderer treats them as an expected "completed with conflicts" outcome that hands off to spec 08 (§6.10 there), not as an error toast. Specs 05, 08 and 09 rely on this.

### 5.3 IPC envelope

All channels go through `window.api.git.invoke(channel, req)` and `window.api.git.on(event, cb)`, both exposed by the preload via `contextBridge`. The contract lives in `/apps/desktop/src/shared/ipc/git-contract.ts` as a single mapped type, so preload and handlers are type-checked against one source.

```ts
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedGitError };

export interface GitIpcContract {
  // ---- repo lifecycle ----
  'git:repo:open':            { req: { path: string };                     res: RepoInfo };
  'git:repo:close':           { req: { repoId: RepoId };                   res: void };
  'git:repo:info':            { req: { repoId: RepoId };                   res: RepoInfo };
  'git:engine:info':          { req: {};                                   res: GitExecutableInfo };
  'git:engine:setExecutable': { req: { kind: 'bundled' | 'system'; path?: string }; res: GitExecutableInfo };
  // ---- reads ----
  'git:status':               { req: { repoId: RepoId; untracked?: 'all' | 'normal' | 'no'; worktreePath?: string }; res: StatusResult };  // worktreePath: status of another linked worktree (§11)
  'git:log:start':            { req: { repoId: RepoId; query: LogQuery; pageSize: number }; res: LogPage };
  'git:log:next':             { req: { repoId: RepoId; cursor: string; pageSize: number };  res: LogPage };
  'git:log:dispose':          { req: { repoId: RepoId; cursor: string };   res: void };
  'git:commit:detail':        { req: { repoId: RepoId; sha: Sha };         res: CommitSummary & { body: string; files: FileChangeSummary[] } };
  'git:refs':                 { req: { repoId: RepoId };                   res: RefInfo[] };
  'git:revParse':             { req: { repoId: RepoId; rev: string };      res: Sha | null };
  'git:mergeBase':            { req: { repoId: RepoId; a: string; b: string; mode?: 'default' | 'fork-point' }; res: Sha | null };
  'git:isAncestor':           { req: { repoId: RepoId; ancestor: string; descendant: string }; res: boolean };
  'git:diff':                 { req: { repoId: RepoId; spec: DiffSpec };   res: FileDiff[] };
  'git:diff:numstat':         { req: { repoId: RepoId; spec: DiffSpec };   res: FileChangeSummary[] };
  'git:show:file':            { req: { repoId: RepoId; rev: string; path: string; maxBytes?: number }; res: { content: string | null; binary: boolean; size: number; encoding: 'utf8' | 'base64' } };
  'git:blame':                { req: { repoId: RepoId; path: string; rev?: string; range?: [number, number]; ignoreWhitespace?: boolean }; res: BlameResult };
  'git:stash:list':           { req: { repoId: RepoId };                   res: StashEntry[] };
  'git:remotes':              { req: { repoId: RepoId };                   res: RemoteInfo[] };
  'git:config:list':          { req: { repoId?: RepoId; scope?: ConfigEntry['scope']; pattern?: string }; res: ConfigEntry[] };  // pattern => --get-regexp, e.g. '^gitflow\.'
  'git:config:get':           { req: { repoId?: RepoId; key: string; scope?: ConfigEntry['scope'] }; res: string | null };
  'git:worktrees':            { req: { repoId: RepoId };                   res: WorktreeInfo[] };
  'git:submodules':           { req: { repoId: RepoId };                   res: SubmoduleInfo[] };
  'git:conflicts':            { req: { repoId: RepoId };                   res: ConflictFile[] };
  // ---- writes (always queued) ----
  'git:config:set':           { req: { repoId?: RepoId; key: string; value: string | null; scope: 'global' | 'local' }; res: void };
  'git:op:run':               { req: { repoId: RepoId; op: GitOperation }; res: OpResult };  // see 5.5
  'git:op:cancel':            { req: { repoId: RepoId; opId: string };     res: void };
  'git:lock:remove':          { req: { repoId: RepoId; lockPath: string }; res: void };
  'git:output:list':          { req: { repoId: RepoId; limit?: number };   res: CommandLogEntry[] };
}

export interface GitEventContract {
  'git:progress':       { repoId: RepoId; opId: string; phase: string; percent: number | null; current?: number; total?: number; overall: number | null; text: string };
  'git:op:state':       { repoId: RepoId; opId: string; label: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; error?: SerializedGitError };
  'git:repo:changed':   { repoId: RepoId; scopes: RefreshScope[]; reason: 'watcher' | 'op' | 'focus' | 'manual' };
  'git:output:append':  { repoId: RepoId; entry: CommandLogEntry };
  'git:prompt':         { promptId: string; repoId?: RepoId; kind: 'username' | 'password' | 'passphrase' | 'hostkey' | 'generic'; text: string; host?: string };
  'git:engine:changed': GitExecutableInfo;
}
export type RefreshScope = 'status' | 'refs' | 'graph' | 'stash' | 'repoState' | 'config' | 'remotes' | 'worktrees' | 'submodules' | 'conflicts';
```

The answer to a prompt goes back via `'git:prompt:answer': { req: { promptId: string; value: string | null; remember?: boolean }; res: void }`. A `null` value means cancel.

Supporting types:

```ts
export interface LogQuery {
  revs: string[] | 'all';           // 'all' => --branches --remotes --tags + HEAD + stash tips (see 6.6)
  order: 'topo' | 'date' | 'author-date';
  paths?: string[];                  // file history (spec 07)
  follow?: boolean;                  // only valid with exactly one path
  author?: string | string[];        // multiple values are ORed (repeated --author), spec 04 author filter
  grep?: string; since?: number; until?: number;
  firstParent?: boolean;
  hiddenRefs?: string[];             // refs hidden in left panel (excluded with --exclude)
  includeSignatureStatus?: boolean;  // expensive; off by default
}
export type DiffSpec =
  | { kind: 'workdir'; paths?: string[] }                       // index -> worktree
  | { kind: 'staged'; paths?: string[] }                        // HEAD -> index (--cached)
  | { kind: 'commit'; sha: Sha; parentIndex?: number; paths?: string[] }   // parent -> commit
  | { kind: 'range'; from: string; to: string; threeDot?: boolean; paths?: string[] }
  | { kind: 'untracked'; path: string };                        // --no-index /dev/null path
export interface FileChangeSummary { path: string; oldPath?: string; status: FileDiff['status']; additions: number | null; deletions: number | null; binary: boolean; }
export interface CommandLogEntry { id: string; opId?: string; argv: string[]; cwd: string; startedAt: number; durationMs: number; exitCode: number | null; stdoutPreview: string; stderr: string; }
```

### 5.4 Main-process service interfaces

```ts
export interface GitRunOptions {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string | Buffer | NodeJS.ReadableStream;
  signal?: AbortSignal;
  readOnly?: boolean;                  // sets GIT_OPTIONAL_LOCKS=0
  progress?: (p: ProgressEvent) => void;
  maxBuffer?: number;                  // default 64 MiB; beyond => GitOutputTooLarge
  encoding?: 'utf8' | 'buffer';
  expectedExitCodes?: number[];        // e.g. [0,1] for `diff --exit-code`, `merge-base --is-ancestor`
  credentialContext?: CredentialContext; // repo/remote/profile, enables askpass (spec 09)
  timeoutMs?: number;                  // network ops default none (user cancels), reads 60s
}
export interface GitRunResult { exitCode: number; stdout: string | Buffer; stderr: string; durationMs: number; }

export interface GitProcessRunner {      // the only code that calls child_process.spawn
  run(o: GitRunOptions): Promise<GitRunResult>;
  stream(o: GitRunOptions): GitProcessStream; // stdout as async iterator of Buffers, with backpressure
}

export interface GitService {            // one instance per open repo
  readonly repo: RepoInfo;
  status(o?: { untracked?: 'all' | 'normal' | 'no' }): Promise<StatusResult>;
  refs(): Promise<RefInfo[]>;
  log(q: LogQuery): LogCursor;
  // ... one method per IPC read channel, plus `execute(op: GitOperation)` for mutating ops
}
```

### 5.5 Operations

Mutating actions are a discriminated union `GitOperation`. Specs 05, 06, and 09 each contribute variants: `{ type: 'commit'; ... }`, `{ type: 'push'; ... }`, and so on. Every variant declares metadata in a registry:

```ts
export interface OperationMeta {
  label: (op) => string;                // "Push main to origin"
  mutating: boolean;                    // true for nearly all
  network: boolean;                     // enables askpass, no read timeout
  cancellable: boolean;
  touches: RefreshScope[];              // scopes to refresh after completion
  undoable: boolean;                    // records undo journal entry (spec 05)
  exclusive: 'repo' | 'none';           // 'repo' => blocks other mutating ops in this repo
}
export interface OpResult { opId: string; summary?: string; warnings?: string[]; data?: unknown; }
```

## 6. Git implementation

### 6.1 Executable selection & environment

**Resolution order** (stored in settings `git.executable`):
1. User-chosen **System git** → validate path with `git --version`. Fall back to bundled with a warning toast if invalid.
2. Default **Bundled git**: a dugite-style portable distribution unpacked to `resources/git` (under `app.asar.unpacked`). Binary is `cmd/git.exe` on Windows and `bin/git` elsewhere.
3. If bundled is broken, auto-detect system git via `where git` / `which git` using the resolved shell PATH. Otherwise show the "GitNotFound" blocking state.

**Bundled-git environment** (mirrors how dugite sets it up):
- `GIT_EXEC_PATH=<gitDir>/libexec/git-core`. On Windows: `<gitDir>/<mingw64|clangarm64>/libexec/git-core`.
- Windows: prepend `<gitDir>/<arch>/bin` and `<gitDir>/usr/bin` to `PATH`. The latter provides `sh`, `ssh`, and `ssh-keygen` for hooks and SSH.
- macOS/Linux: `GIT_CONFIG_SYSTEM=<gitDir>/etc/gitconfig` (unless already set) and `GIT_TEMPLATE_DIR=<gitDir>/share/git-core/templates`. Linux also gets `PREFIX=<gitDir>` and, if unset, `GIT_SSL_CAINFO=<gitDir>/ssl/cacert.pem`.
- The bundle includes `git-lfs`, which is placed on PATH via `libexec/git-core`.

**Shell environment resolution** (macOS/Linux): at startup, spawn the user's login shell once (`$SHELL -ilc 'env -0'`, 5 s timeout), parse the NUL-separated env, and merge `PATH`, `SSH_AUTH_SOCK`, proxy vars, `GIT_*`, `GNUPGHOME`, and `NVM_*` into the base env. This lets hooks (husky/npx), git-lfs, gpg, and agents work when the app is launched from the Dock or desktop. Cache the result, and re-resolve via "Reload shell environment" in Preferences > Git.

**Per-invocation env/args policy** (applied by `GitProcessRunner`, bundled or system):

| Setting | Value | Why |
|---|---|---|
| `GIT_TERMINAL_PROMPT` | `0` | Never block on a tty prompt. Credentials go through askpass. |
| `GIT_ASKPASS`, `SSH_ASKPASS` | path to askpass shim (§6.3) | Credential, passphrase, and host-key prompts are routed to the UI. |
| `SSH_ASKPASS_REQUIRE` | `force` | OpenSSH ≥ 8.4 uses askpass even without DISPLAY. |
| `DISPLAY` | keep, or `:0` placeholder if unset (non-Windows) | Older OpenSSH only uses askpass when DISPLAY is set. |
| `GIT_OPTIONAL_LOCKS` | `0` for `readOnly` runs | `git status` won't take `index.lock` to refresh stat info, which avoids races with mutating ops. |
| `LC_ALL` | unset | Keep the UTF-8 locale for path bytes. |
| `LANG` | keep the user's value; default `en_US.UTF-8` if unset | |
| `LC_MESSAGES` / `LANGUAGE` | `C` / `en` | Stderr in English so the error regexes (§6.12) match. |
| `GIT_PAGER`, `PAGER` | `cat` | Also pass `--no-pager`. |
| `GIT_EDITOR` | path to `editor-shim` that exits 0 without modifying (non-interactive ops) | Merge/revert messages never open vim. Spec 12 overrides `GIT_SEQUENCE_EDITOR` for interactive rebase. |
| `GIT_MERGE_AUTOEDIT` | `no` | |
| `GCM_INTERACTIVE` | keep the user's value | GCM may still show its own GUI, which is acceptable. |
| Global `-c` args | `-c color.ui=false -c core.quotepath=false -c log.showSignature=false -c diff.noprefix=false -c diff.mnemonicPrefix=false -c core.pager=cat` | Neutralize user config that changes output shape. |

Also set `-c diff.external=` and `--no-ext-diff` for diff/show/log -p, and `--no-textconv` except where the UI explicitly wants textconv.

**Spawning rules**:
- `child_process.spawn(gitPath, args, { cwd, env, windowsHide: true, shell: false })`. Never use a shell and never build strings, which closes off injection. User-supplied values (branch names, paths) go **after `--`** or through `--pathspec-from-file=- --pathspec-file-nul` on stdin.
- Windows command line limit (~32 KB): any command with more than 50 paths, or more than 8 KB of path data, uses `--pathspec-from-file`. This applies to `add`, `reset`, `restore`, `checkout`, `stash push`, `rm`, `commit`, and `ls-files`. Commands without that flag get batched.
- `maxBuffer` is enforced on non-streaming runs. Large outputs (log, ls-files, blame, diff of big files) use `stream()`.
- Concurrency cap: at most 8 concurrent git processes app-wide (read pool). Interactive-priority reads (the selected commit's diff) jump ahead of background reads (auto-fetch, worktree status).

**Version gating**: parse `git version 2.47.1.windows.1` → `[2,47,1]`. Minimum supported system git is **2.36** (needed for `worktree list -z`). The `GitFeatureFlags` toggle fallbacks.

### 6.2 Cancellation

1. Each op gets an `AbortController`. `git:op:cancel` aborts it.
2. On abort the runner sends `SIGTERM` (POSIX) to the process group (spawn with `detached: true` on POSIX and kill `-pid`). On Windows it runs `taskkill /pid <pid> /T /F` so ssh, git-remote-https, and hook children die too.
3. If the process is still alive after 3 s, send `SIGKILL`.
4. The op rejects with `Cancelled`. After cancel, the queue runs **post-cancel recovery**:
   - If `index.lock` or a `refs/**.lock` file exists **and its mtime ≥ op start time** → we created it, so delete it automatically. Log this to the output log.
   - Clone cancel: delete the partially created target directory only if we created it, which is tracked at op start.
   - Fetch cancel is safe: ref updates are atomic, and leftover `objects/pack/tmp_pack_*` files are garbage-collected by git.
   - Rebase, merge, cherry-pick, and revert are not cancellable mid-process. Instead the user gets **Abort** (`git rebase --abort`, etc.) once the op stops at conflicts.

### 6.3 Askpass bridge (credentials)

- `askpass.sh` / `askpass.cmd` runs `"<electronExe>" "<resources>/askpass-main.js" "$@"` with `ELECTRON_RUN_AS_NODE=1`.
- Environment passed per git invocation: `GITHAPPENS_ASKPASS_PIPE=<named pipe / unix socket path>` and `GITHAPPENS_ASKPASS_TOKEN=<random 32-byte hex, per op>`.
- `askpass-main.js` connects to the pipe and sends `{ token, prompt: argv[1] }`. It prints the answer to stdout and exits 0, or exits 1 on cancel. The main process rejects unknown tokens.
- The main process classifies the prompt text:
  - `^Username for '(.+)': $` → username
  - `^Password for '(.+)': $` → password. The URL contains `user@host`.
  - `Enter passphrase for key '(.+)':` → SSH key passphrase
  - `Are you sure you want to continue connecting` → host key. Answer `yes` or `no`.
  - Anything else → generic.
- Resolution chain, detailed in spec 09: integration token for host → stored credential in keychain → `git:prompt` event to the renderer.
- **Background ops** (auto-fetch) set `nonInteractive: true`. Askpass then exits 1 without prompting, so auto-fetch never pops dialogs.
- Responses never appear in logs. The output log redacts URLs with credentials (`https://user:***@host`) and any `Authorization` / `extraheader` value.

### 6.4 Progress parsing

- Network/checkout ops pass `--progress`. Git writes to stderr with `\r` updates, so split on `/[\r\n]/`.
- Line regex: `^(?:remote: )?([A-Za-z ]+):\s+(\d{1,3})% \((\d+)\/(\d+)\)` → `{ phase, percent, current, total }`. An indeterminate variant (`^(?:remote: )?([A-Za-z ]+):\s+(\d+)`, e.g. "Counting objects: 1234") gives `percent: null`.
- Overall weighting:
  - Clone: remote counting/compressing 10%, Receiving objects 50%, Resolving deltas 20%, Checking out / Updating files 20%.
  - Fetch: remote 10%, receiving 70%, resolving 20%.
  - Push: Enumerating/Counting/Compressing 30%, Writing objects 70%.
  - Unknown phases keep `overall` unchanged.
- Throttle `git:progress` events to at most 10 per second per op.
- Non-progress stderr lines (errors, `remote:` messages, hook output) are kept for error classification and the output log.
- LFS progress comes through `GIT_LFS_PROGRESS=<tmpfile>`, tailed while the op runs. Format: `<download|upload|checkout> <n>/<m> <bytes>/<total> <name>`.

### 6.5 Status

```
git --no-optional-locks status --porcelain=v2 -z --branch --show-stash --untracked-files=all --ignore-submodules=none --find-renames
```
(`--show-stash` only when `features.statusShowStash`. Otherwise use `git rev-list --walk-reflogs --count refs/stash`, where exit ≠ 0 means 0 stashes.)

Parsing, with the output split on `\0`:
- `# branch.oid <sha|(initial)>`, `# branch.head <name|(detached)>`, `# branch.upstream <ref>`, `# branch.ab +A -B`, `# stash N`.
- `1 XY sub mH mI mW hH hI path` → ordinary. Split the header on spaces with a **limit of 8**. The rest of the token is the path, which may contain spaces.
- `2 XY sub mH mI mW hH hI Xscore path`, then the **next NUL token** is `origPath` → renamed/copied.
- `u XY sub m1 m2 m3 mW h1 h2 h3 path` → unmerged. Base/ours/theirs SHAs are `h1/h2/h3`, and all-zero means absent.
- `? path` untracked, `! path` ignored (only with `--ignored`).
- `sub` field: `N...` = not a submodule. `S<c><m><u>`: C = commit changed, M = tracked modifications, U = untracked.
- Directories in untracked mode `normal` end with `/`.

### 6.6 Log (graph data)

```
git log -z --format=<FMT> --topo-order|--date-order --no-color --decorate=no \
  <revs...> [--exclude=<hidden>...] [--not <excluded>] [-- <paths>]
FMT = %H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s   (9 fields)
```
- With `-z`, every field is NUL-terminated by our `%x00` and each record by git's NUL. Consume tokens in chunks of exactly 9 plus 1 (an empty token from the record terminator). Robust parsing: buffer a partial record across stream chunks.
- `%P` is space-separated parents. Empty means root commit.
- `revs: 'all'` → `--branches --remotes --tags HEAD` plus stash tips via `refs/stash` reflog SHAs passed explicitly. Stashes show as graph nodes (spec 04). Hidden refs (spec 04) are passed as `--exclude=<pattern>` options, e.g. `--exclude=refs/remotes/upstream/* --remotes`. Each `--exclude` must come before the `--branches`/`--remotes`/`--tags` option it applies to.
- The body is **not** fetched in the graph log. `git:commit:detail` uses `git show -s -z --format=%H%x00%B <sha>` plus `git diff-tree` (§6.8).
- Refs are **not** taken from `%D`. Labels are joined in the renderer from `git:refs` by sha, so refs refresh independently of the graph.
- Signature status `%G?` is opt-in. It invokes gpg per commit and is slow.

**Paging** (cursor = id of a live streaming process):
1. `git:log:start` spawns one `git log` stream, reads until `pageSize` commits are parsed, then **pauses** stdout. Backpressure makes git block on the pipe, so it costs no CPU.
2. `git:log:next` resumes until the next `pageSize`.
3. The cursor is disposed when `done` is reached, on `git:log:dispose`, after 5 min idle (process killed), or on any `refs`/`graph` refresh. On refresh the renderer restarts paging and keeps already-rendered rows via sha diff (spec 04).
4. Default page sizes: 500 first page (first paint), then 2000. The setting `general.initialCommitCount` (spec 13) defaults to 2000 visible ("commits to load", inferred), with "Load more" or auto-load on scroll.
5. Fallback when a stream can't be held (e.g. process killed): re-run with `--skip=<n>`. This is slower but correct.

### 6.7 Refs

```
git for-each-ref --format=<F> refs/heads refs/remotes refs/tags refs/stash
F = %(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(symref)%00%(worktreepath)%00%(creatordate:unix)%00%(contents:subject)%1e
```
- `for-each-ref` has no `-z`. Use literal `%00` field separators and `%1e` (record separator) plus newline between records. Split on `\x1e\n`. Ref names can't contain control characters, and subjects with `\x1e` are vanishingly rare. If one appears, the record has the wrong field count and is dropped with a log warning.
- For annotated tags, `objecttype=tag` and `*objectname` is the peeled commit, so `sha` = peeled.
- Track field: `ahead 2, behind 1` / `ahead 2` / `behind 1` / `gone` / empty.
- `%(worktreepath)` needs git ≥ 2.23. Otherwise derive it from the worktree list.
- HEAD: `git symbolic-ref -q HEAD`, where exit 1 means detached, then `git rev-parse -q --verify HEAD`, where failure means unborn.

### 6.8 rev-parse, merge-base, show

- Repo discovery, in one call:
  `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir --is-bare-repository --is-shallow-repository --show-object-format`
  outputs one value per line, in order. In a bare repo `--show-toplevel` errors, so run discovery as two calls: `rev-parse --is-bare-repository --absolute-git-dir --git-common-dir` first, then `--show-toplevel` if not bare. Exit 128 + `not a git repository` → `NotARepository`.
- Resolve: `git rev-parse -q --verify <rev>^{commit}`. Exit 1 → `null`.
- Merge base: `git merge-base <a> <b>`. Exit 1 with empty output means no common ancestor (`null`). `--fork-point` variant. `git merge-base --is-ancestor a b`: exit 0 = true, 1 = false, other = error.
- Repo state from files in `gitDir`:
  - `rebase-merge/` (interactive if `rebase-merge/interactive` exists), `rebase-apply/` (`applying-mailbox` if `rebase-apply/applying` exists)
  - `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`
  - This is checked with `fs.stat`, with no process spawn.
- Commit detail files: `git diff-tree -z --no-commit-id -r -M --root --numstat <sha>` for counts, plus `--name-status` (or a single `--raw --numstat`, parsing the raw block then the numstat block). Merge commits default to diff against the first parent (`<sha>^1 <sha>`), and the UI can switch parent.
- File at revision: `git cat-file --batch` long-lived process per repo for blobs (`<rev>:<path>\n` on stdin → `<sha> blob <size>\n<bytes>\n`). This avoids spawning per file. Binary detection is a NUL byte in the first 8000 bytes. Over `maxBytes` (default 5 MiB) → content null, `tooLarge`.

### 6.9 Diff

Patch:
```
git diff --no-color --no-ext-diff [--no-textconv] -M [-C] --patch-with-raw -z --full-index [--unified=N] [--ignore-all-space] <spec> -- <paths>
```
- spec mapping: workdir → *(no rev)*; staged → `--cached` (`--root`-like handling for unborn HEAD: use the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, or `git hash-object -t tree /dev/null` for sha256); commit → `<sha>^<n> <sha>` (root commit → empty tree); range → `a b` or `a...b`; untracked → `git diff --no-index -- /dev/null <path>` (exit code 1 is success).
- With `--patch-with-raw -z`, the raw section comes first: `:<oldmode> <newmode> <oldsha> <newsha> <status>[score]\0<path>\0[<path2>\0]`, then the patch text. Parse the raw block to get authoritative file list, status, and paths. Then parse the patch text line by line:
  - `diff --git a/x b/y` starts a file. Map it to raw entries **by order**, which avoids ambiguous path parsing.
  - Header lines (`old mode`, `new mode`, `similarity index`, `rename from/to`, `index`, `Binary files ... differ`, `GIT binary patch`) set flags.
  - `@@ -a,b +c,d @@ section` → hunk. Missing `,b` means 1.
  - Lines starting with ` `, `+`, `-` are assigned line numbers. `\ No newline at end of file` → `nonewline` line attached to the previous line's side.
  - Content lines are split on `\n` only, keeping `\r`. Spec 07 renders CRLF markers.
- Limits: if a single file's patch exceeds 3 MB or 20k lines, mark it `tooLarge` and skip hunks. The UI offers "Load anyway".
- Numstat (`git:diff:numstat`): `git diff --numstat -z -M <spec>` → `A\tD\tpath\0`. For renames it is `A\tD\t\0old\0new\0`, and `-\t-` means binary.
- Submodule diffs: `--submodule=short` (default) yields `Subproject commit <sha>` lines. Parse them into `submodule.{oldSha,newSha}`.
- Encoding: decode as UTF-8 by default. The per-repo setting `encoding` (a repo-specific Encoding preference) uses `iconv-lite` on file contents.

### 6.10 Blame

```
git blame --porcelain [-w] [-M] [-C] [-L a,b] [<rev>] -- <path>
```
(`--incremental` is used for progressive display on huge files, same per-entry grammar.)
- Each group: `<sha> <origLine> <finalLine> [<numLines>]`, then (the first time a sha is seen) `author`, `author-mail <x>`, `author-time`, `author-tz`, `committer*`, `summary`, optional `previous <sha> <path>`, optional `boundary`, `filename <path>`. Then one `\t<content>` line.
- Subsequent lines of the same group have only the header line plus `\t<content>`.
- Uncommitted lines show sha `0000000…`. Map these to a synthetic "Not committed yet" entry.
- Paths with special characters in `filename` are C-quoted when they contain control chars or quotes. Unquote with a C-style unescape helper (`unquoteCPath`).

### 6.11 Stash, remotes, config, worktrees, submodules, conflicts

- **Stash list**: `git stash list -z --format=%gd%x00%H%x00%P%x00%gs%x00%ct`, 5 fields per record. `%gd` = `stash@{n}`, and `index` is parsed from it. `%gs` = reflog subject ("WIP on main: abc123 msg" / "On main: custom").
- **Remotes**: `git remote -v` → `name\turl (fetch|push)` lines. Fetch refspecs come from `git config --get-all remote.<name>.fetch`. Alternative single call: `git config -z --get-regexp '^remote\..+\.(url|pushurl|fetch)$'` → `key\nvalue\0`. Note that a remote name may contain dots, so parse the key as `remote.` + name + `.` + last segment.
- **Config list**: `git config --list -z --show-origin --show-scope` → tokens: `scope\0origin\0key\nvalue\0`. The key has no newline, so split at the first `\n`. Scoped reads use `--global`, `--local`, or `--system`. Write: `git config --<scope> <key> <value>`, unset: `git config --<scope> --unset-all <key>`. Exit code 5 on unset of a missing key = no-op. Config writes go through the OperationQueue because they take `config.lock`.
- **Worktrees**: `git worktree list --porcelain -z`. Records are separated by an empty token. Lines: `worktree <path>`, `HEAD <sha>`, `branch <ref>` | `detached`, `bare`, `locked [reason]`, `prunable [reason]`. The first record is the main worktree. On git < 2.36, fall back to the newline format (a path with a newline is unsupported).
- **Submodules**:
  1. `git config -z --file .gitmodules --get-regexp '^submodule\..*\.(path|url|branch)$'` → declared modules (from the HEAD blob when the file is missing in the worktree).
  2. `git submodule status --recursive`: prefix char ` ` in sync, `-` uninitialized, `+` checked-out sha ≠ recorded, `U` conflict. Format: `<p><sha> <path>( (<describe>))?`.
  3. Recorded sha: `git ls-tree -z HEAD -- <path>` (mode 160000).
- **Conflicts**: `git ls-files -u -z` → `<mode> <sha> <stage>\t<path>\0`. Group by path, stage 1/2/3 = base/ours/theirs. Combine with porcelain v2 `u` entries for the conflict type.

### 6.12 Error classification

`classifyError(argv, exitCode, stderr, stdout): SerializedGitError`. Patterns are an ordered table of regexes tested against stderr (and stdout for `commit`/`merge` messages). The first match wins. Representative rules:

| Code | Pattern(s) (case-insensitive) |
|---|---|
| NotARepository | `not a git repository` |
| AuthenticationFailed | `Authentication failed for`, `could not read Username`, `could not read Password`, `HTTP Basic: Access denied`, `Invalid username or password`, `remote: Invalid username or token`, `fatal: .*403` with auth context |
| AuthCancelled | askpass returned cancel (tracked out-of-band by the askpass bridge, not by regex) |
| HostKeyVerificationFailed | `Host key verification failed` |
| PermissionDenied | `Permission denied \(publickey`, `ERROR: Permission to .* denied`, `The requested URL returned error: 403` |
| RepositoryNotFound | `Repository not found`, `repository '.*' not found`, `does not appear to be a git repository` |
| NetworkUnreachable | `Could not resolve host`, `Failed to connect to`, `Connection timed out`, `Connection refused`, `Network is unreachable`, `ssh: connect to host .* port \d+:` |
| ProxyAuthRequired | `407 Proxy Authentication Required` |
| SslError | `SSL certificate problem`, `server certificate verification failed`, `schannel:` |
| PushRejectedNonFastForward | push porcelain flag `!` with `(non-fast-forward)` or `(fetch first)`; `Updates were rejected because the tip` |
| PushRejectedStaleLease | `(stale info)` |
| ProtectedBranch | `protected branch hook declined`, `GH006: Protected branch`, `You are not allowed to push code to protected branches` |
| PushRejectedByRemote | `! \[remote rejected\]` (otherwise) |
| NoUpstream | `has no upstream branch`, `There is no tracking information for the current branch` |
| UpstreamGone | `your configuration specifies to merge with the ref .* but no such ref was fetched` |
| NotFastForwardable | `Not possible to fast-forward, aborting`, `fatal: Not possible to fast-forward` |
| MergeConflict / RebaseConflict / CherryPickConflict / RevertConflict | `CONFLICT \(`, `Automatic merge failed`, `could not apply`, `after resolving the conflicts`. The specific code is chosen from op type + repo state. |
| StashConflict | `Conflicts in index`, `CONFLICT` during stash apply/pop |
| LocalChangesWouldBeOverwritten | `Your local changes to the following files would be overwritten` (details.files = indented lines that follow) |
| UntrackedWouldBeOverwritten | `untracked working tree files would be (overwritten\|removed)` |
| DirtyWorktree | `cannot (pull\|rebase) with rebase: You have unstaged changes`, `Please commit or stash them` |
| NothingToCommit | `nothing to commit`, `no changes added to commit` |
| EmptyCommitMessage | `Aborting commit due to empty commit message` |
| HookFailed | `hook .* (failed\|declined)`, or a commit/push exit ≠ 0 whose stderr matches no other rule while an executable hook exists for the op (see spec 09 §Hooks) |
| IndexLocked | `Unable to create '(.+index\.lock)': File exists` → details.lockPath |
| RefLocked | `cannot lock ref '(.+)'`, `Unable to create '(.+\.lock)'` (non-index) |
| BranchAlreadyExists | `A branch named '(.+)' already exists` |
| BranchNotFullyMerged | `is not fully merged` |
| BranchCheckedOutInWorktree | `is already (checked out\|used by worktree) at '(.+)'` |
| InvalidRefName | `is not a valid branch name`, `not a valid ref name` |
| TagAlreadyExists | `tag '(.+)' already exists` |
| RemoteAlreadyExists | `remote (.+) already exists` |
| RemoteNotFound | `No such remote` |
| ShallowRepository | `shallow update not allowed`, `does not support shallow` |
| LfsMissing | `git-lfs: command not found`, `'lfs' is not a git command`, `This repository is configured for Git LFS but 'git-lfs' was not found` |
| LfsError | `batch response:`, `LFS:` prefixed errors |
| GpgSigningFailed | `gpg failed to sign the data`, `error: cannot run gpg` |
| Unknown | fallback: message = last non-empty stderr line, prefixed `fatal:`/`error:` stripped |

The rules table lives in `/packages/git/src/errors/rules.ts`. Each rule has a fixture stderr sample in tests.

### 6.13 OperationQueue

- **Per-repo**, keyed by **`commonDir`**. Linked worktrees share refs and objects, so ref-mutating ops across worktrees of one repo serialize too. A secondary per-`gitDir` index lane exists for index-only ops (stage/unstage), which may run in parallel with ops in other worktrees.
- **Classes**:
  - `read`: runs immediately in the read pool with `GIT_OPTIONAL_LOCKS=0`. Not queued.
  - `mutating`: FIFO, exclusive per repo. Examples: commit, stage, checkout, merge, rebase, reset, stash, branch/tag ops, config set, push.
  - `network-fetch`: fetch is mutating (refs, FETCH_HEAD), but a fetch may run **concurrently with index-only ops**. A queued second fetch for the same remote is **coalesced** into the running one, so its promise resolves with the same result.
- **Rules**:
  1. Enqueue returns `opId` immediately and emits `git:op:state queued`. Then `running`, then a terminal state.
  2. While a mutating op runs, the RepoWatcher is **muted** for that repo. On completion, the queue emits one `git:repo:changed` with `reason: 'op'` and the op's `touches` scopes. The watcher's buffered events for that window are dropped, except for paths outside `.git` and the worktree's tracked state. Simplest correct approach: always also refresh `status`.
  3. Before each mutating op, the **lock pre-check** runs: `fs.stat(<gitDir>/index.lock)` (and `HEAD.lock`, `config.lock` when relevant).
     - Lock exists and **mtime < 10 s ago** → wait and poll every 250 ms for up to 5 s, since another process (CLI or IDE) is likely active.
     - Still present or older → fail fast with `IndexLocked` + `details.lockPath`, `details.ageSec`. The UI offers "Delete lock & retry" (`git:lock:remove`), which only deletes files matching `/\.lock$/` inside `gitDir`/`commonDir`.
     - "Stale" heuristic shown in the dialog: age > 60 s **and** no `git` process found whose cwd is in this repo. The process scan is best-effort; it uses `ps -o pid,command` / `wmic`/`Get-CimInstance` and is skipped if slow.
  4. Auto-fetch and background ops yield: if a user op is enqueued while a background fetch runs, the fetch continues, but no further background ops start until the queue drains.
  5. Ops exceeding 60 s with no output or progress emit a "still running…" hint. There is no auto-timeout for network or hook ops.
  6. Undo journal (spec 05) entry is written **before** the op starts and marked complete or failed after.

### 6.14 RepoWatcher

- Implementation: `@parcel/watcher` for the worktree (native recursive, handles 100k+ files on all OSes). `chokidar` with explicit paths for `.git`. Both binding options in §2 are allowed. Rationale: chokidar's recursive polling over huge trees is costly.
- **Worktree watch**: root recursive, ignore `.git/**` and, via the watcher's ignore globs, the heavy directories that are also git-ignored (`node_modules`, `target`, `dist`, `.venv`, `bin/obj`). The ignore list is built once from `git check-ignore`-verified top-level dirs and a built-in list. Ignored-file events are still harmless, because status is the source of truth.
- **.git watch** (paths relative to `gitDir`, plus `commonDir` for shared refs):

| Path | Scope(s) triggered |
|---|---|
| `HEAD`, `ORIG_HEAD` | refs, graph, status |
| `index` | status |
| `refs/heads/**`, `refs/remotes/**`, `refs/tags/**`, `packed-refs` | refs, graph |
| `refs/stash`, `logs/refs/stash` | stash, graph |
| `FETCH_HEAD` | refs (cheap ahead/behind recompute) |
| `MERGE_HEAD`, `MERGE_MSG`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `rebase-merge/**`, `rebase-apply/**`, `sequencer/**`, `BISECT_LOG` | repoState, conflicts, status |
| `config` | config, remotes, submodules |
| `worktrees/**` (commonDir) | worktrees |
| `modules/**` HEAD files | submodules |
| `info/exclude` | status |

  - **Ignored**: `objects/**`, `logs/**` (except `logs/refs/stash`), `lfs/**`, `hooks/**`, `*.lock`, `gc.pid`, `FETCH_HEAD.lock`, `fsmonitor--daemon/**`, `rr-cache/**`.
  - Lock file **removal** is useful: `index.lock` disappearing triggers a status refresh. Watch `*.lock` deletion events only.
  - Worktree file events → `status`. A `.gitignore` / `.gitattributes` change → `status`. A `.gitmodules` change → `submodules` + `status`.
- **Debounce**: per scope, trailing 300 ms with max-wait 1500 ms. Under event floods (> 1000 events in a window, e.g. `npm install`), switch to a single full status refresh after quiet.
- **Coalescing with reads**: if a `status` refresh is in flight and another is requested, mark it dirty and re-run once after completion. Never stack.
- **Focus refresh**: on window focus or tab activation, refresh `status` + `refs` (cheap) if more than 2 s have passed since the last refresh. Covers network filesystems where watching fails.
- **Fallback**: if the watcher errors (ENOSPC inotify limit, network drive), switch to polling every 5 s for `.git` mtimes plus focus refresh, and show a status bar warning "File watching unavailable".
- Inactive tabs: keep the `.git` watch, and suspend the worktree watch after 60 s in background. Resume with a full status refresh on activation.

### 6.15 Performance for huge repos

1. **commit-graph**: after open, if `objects/info/commit-graph` and `objects/info/commit-graphs/` are absent and the commit count is over 10k (`git rev-list --count --branches --remotes --tags`, run lazily in the background), run `git commit-graph write --reachable --changed-paths` in the background at low priority when the setting `graph.maintainCommitGraph` (spec 13, default on) is enabled. It runs as a cancellable `maintenance` op that does not block user ops (it touches no refs or index; a second run is never started while one is in flight), and a non-blocking toast reports completion. With the setting off, nothing is written. Offer `git config fetch.writeCommitGraph true` as an opt-in checkbox. This is our addition. Spec 04 §6.2 relies on this behavior.
2. **fsmonitor**: offer `core.fsmonitor=true` (builtin daemon, git ≥ 2.37, Windows/macOS) plus `core.untrackedCache=true` for repos with over 50k tracked files (`git ls-files | count` streamed). Status must still work when a user's custom fsmonitor hook is configured.
3. **Untracked explosion**: if status returns over 20k untracked entries, re-run with `--untracked-files=normal` (directories collapsed), set `truncatedUntracked`, and the staging panel shows "Large number of untracked files; showing folders" (inferred handling).
4. **Graph**: first page of 500 rendered under 300 ms on a 1M-commit repo with commit-graph. `--topo-order` must stream, which it does when the commit-graph has generation numbers. Without a commit-graph, `--topo-order` buffers everything, so default to `--date-order` until the graph is written, then switch (inferred tradeoff).
5. **Refs**: for-each-ref with `%(upstream:track)` computes ahead/behind per branch, which is costly for over 1000 branches. Compute `track` only for local branches (separate call: `for-each-ref refs/heads` with track, `refs/remotes refs/tags` without).
6. **Diff**: lazy per-file patch fetch. The commit detail lists files from numstat, and the patch runs only for the selected file (`-- <path>`).
7. **Persistent helpers**: one `git cat-file --batch` and one `git cat-file --batch-check` process per repo, restarted on crash.
8. **Avoid** `git status` on every keystroke. Rely on debounced watcher scopes.

### 6.16 Test strategy

- **Parser unit tests** (`/packages/git/test`, Vitest): each parser has golden input files captured from real git (`fixtures/output/status-v2/*.bin`, kept binary to preserve NULs) and expected JSON. Cases include unicode and space-containing paths, renames, copies, all 7 conflict types, submodule flags, `(initial)`, detached, CRLF content, no-newline-at-EOF, binary, mode-only change, empty repo, sha256 repo, and annotated vs lightweight tags.
- **Fixture repo generators** (`/test/fixtures/*.ts`): deterministic scripts run with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` fixed, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_CONFIG_NOSYSTEM=1`. They build: linear, merges/octopus, criss-cross, conflicts (each type), rebase in progress, submodules (nested), LFS (with a local `lfs.url` file:// standalone transfer agent, or `lfs-test-server` in CI), worktrees, a shallow clone, a bare repo, a 100k-commit synthetic repo (via `git fast-import`) for perf benchmarks, and huge untracked dirs. Remotes are bare repos on disk (`file://`) so tests run offline.
- **Integration tests**: run `GitService` against fixtures with **bundled git** and with the **minimum supported system git (2.36)** in CI matrix (Docker image on Linux).
- **Error rule tests**: each rule has captured stderr samples from multiple git versions and hosts (GitHub/GitLab/Bitbucket messages).
- **Queue/watcher tests**: fake clock; assert debouncing, coalescing, mute-during-op, and lock wait/fail behavior. Simulate an `index.lock` with controlled mtime.
- **Cancellation tests**: spawn a fetch against a slow `file://` remote served via a throttling proxy script. Cancel and assert no leftover lock files and the queue continues.
- **Perf benchmarks** (nightly): first log page, status on a 100k-file repo, and refs on 5k branches, with thresholds in §9.

## 7. Step-by-step implementation plan

1. **Shared contract**: create `git-types.ts`, `git-contract.ts`, `IpcResult`, and error codes. Preload exposes typed `invoke` and `on`. Test: type-check compile, plus a mock handler round-trip test.
2. **GitProcessRunner**: spawn with env policy (§6.1), `run` and `stream`, maxBuffer, abort (tree kill), and redacted command log. Test: run `git --version`, abort a `sleep`-like long command (`git hash-object --stdin` waiting on stdin).
3. **Executable resolver** (`GitLocator`, as named in spec 15) + shell env resolution + version/feature detection + settings toggle + `git:engine:*` channels. Test: fake paths and version strings.
4. **Repo discovery** (`git:repo:open`): rev-parse parser, repo state detection, RepoManager registry with RepoId by realpath. Test: on fixtures (normal, bare, linked worktree, not-a-repo, unborn).
5. **Error classifier** with rules table plus fixture tests. Wire it into the runner so every failure is a `SerializedGitError`.
6. **Status parser + channel**. Test: golden files and fixture repos.
7. **Refs parser + channel** (for-each-ref, HEAD resolution, track parsing).
8. **Log streaming + paging cursor** (pause/resume, dispose, idle kill, `--skip` fallback). Test: 100k fixture first page < 300 ms.
9. **cat-file batch helper** and `git:show:file`.
10. **Diff**: raw + patch parser, numstat, all `DiffSpec` kinds, limits, submodule and LFS pointer detection hook.
11. **Commit detail**, **blame**, **stash list**, **remotes**, **config list/get/set**, **worktrees**, **submodules**, **conflicts**, **merge-base/isAncestor**: each a builder + parser + channel + tests.
12. **OperationQueue**: classes, FIFO, coalescing fetches, lock pre-check, op state events, post-cancel recovery, undo journal hook (interface only, spec 05 implements it).
13. **Progress parser** and throttled `git:progress` events. Test: recorded stderr streams from clone, fetch, and push.
14. **Askpass bridge**: shim scripts, pipe server, token auth, prompt classification, `git:prompt` / answer channel, non-interactive mode (resolution chain filled in spec 09).
15. **RepoWatcher**: parcel watcher + .git chokidar, scope mapping, debouncing, mute/unmute API used by the queue, focus refresh, fallback polling.
16. **Output log** (`git:output:list`, `git:output:append`) and the bottom drawer UI.
17. **Huge-repo features**: commit-graph prompt, fsmonitor/untracked-cache offer, untracked truncation, split refs track.
18. **CI**: Vitest parsers, integration matrix (bundled + git 2.36), nightly perf benchmarks.

## 8. Edge cases

- **Empty repo / unborn branch**: `branch.oid (initial)`. Log returns 0 commits, with no error (`git log` exits 128 on unborn HEAD with "does not have any commits yet". Treat that as empty). Staged diff uses the empty tree.
- **Detached HEAD**: `branch.head (detached)`. Refs show HEAD as its own label (spec 04).
- **Bare repos**: no status, no watcher on worktree. Graph, refs, and remotes only. Mutating worktree ops are disabled.
- **Linked worktrees**: `gitDir` ≠ `commonDir`. Refs come from commonDir, and index/HEAD from gitDir. The watcher must watch both.
- **Submodule opened as repo**: `.git` is a file (`gitdir: ../.git/modules/x`). rev-parse handles this. Watch the resolved gitDir.
- **Unicode / spaces / newlines in paths**: always `-z` + `core.quotepath=false`. Paths are decoded as UTF-8. Invalid UTF-8 bytes are decoded with replacement chars for display, and the **raw bytes are kept** (`Buffer` → base64 key) for subsequent commands so the op targets the correct file (rare; Linux only).
- **Paths starting with `-`**: always pass paths after `--`.
- **CRLF / autocrlf**: diff content keeps `\r`. Status may show files modified only by line endings when `core.autocrlf` changes. Document this; no special handling.
- **Case-insensitive filesystems**: case-only renames show as rename in status. Watcher paths are compared with case folding on Windows/macOS.
- **Very long paths on Windows**: bundled git sets `core.longpaths=true` in its system gitconfig (a Longpaths preference is exposed too; see spec 13).
- **sha256 repositories**: 64-char SHAs; empty-tree constant differs.
- **Shallow clones**: graph shows a "shallow boundary" marker on commits whose parents are missing (`.git/shallow` lists the SHAs). `merge-base` may return null.
- **Replace refs / grafts**: honored by git. Set `GIT_NO_REPLACE_OBJECTS` only if the user opts out (not by default).
- **User config surprises**: `status.showUntrackedFiles=no`, `log.showSignature`, `diff.noprefix`, `color.ui=always`, `core.pager`, `pager.*`, `format.pretty` are all neutralized by explicit flags and `-c` overrides.
- **Locale**: messages forced to English. Paths still UTF-8.
- **Antivirus / Windows Defender** delaying file creation: lock wait window (§6.13) absorbs transient locks.
- **Git process crash / zombie**: runner resolves on `close`, not `exit`, to ensure stdio is drained. Kill on app quit: all child processes in the registry.
- **Repo moved/deleted while open**: watcher error → `NotARepository` on next read → tab shows "Repository not found" with "Locate…" / "Remove" actions (spec 03).
- **Network filesystems / WSL paths** (`\\wsl$\`): watcher falls back to polling. Prefer the Windows git for performance, and warn that git inside WSL is not used (out of scope).

## 9. Acceptance criteria

- [ ] With no system git installed, the app opens, clones, commits, and pushes using the bundled git on Windows, macOS, and Linux.
- [ ] Switching to system git in Preferences takes effect for the next command with no restart. Versions below 2.36 are rejected with a clear message.
- [ ] No git invocation can block on a terminal prompt (verified by tests that run with stdin closed and `GIT_TERMINAL_PROMPT=0`).
- [ ] Every IPC channel in §5.3 is implemented, typed end-to-end, and returns `IpcResult` with typed errors.
- [ ] Parsers pass golden tests for status v2, log, for-each-ref, diff (raw+patch, numstat), blame porcelain, stash list, remote -v, config list, worktree list, submodule status, ls-files -u.
- [ ] Each error code in §6.12 has at least one stderr fixture mapped correctly.
- [ ] Two rapid mutating ops in the same repo never produce an `index.lock` error from our own concurrency.
- [ ] A pre-existing `index.lock` produces the lock dialog. "Delete lock & retry" succeeds.
- [ ] Cancelling a fetch or clone within 1 s stops all child processes (no orphan `git-remote-https`/`ssh`), and leaves no lock files we created.
- [ ] External change to a tracked file appears in the WIP panel within 500 ms (p95) of the save. A CLI `git commit` updates the graph within 1 s.
- [ ] `npm install` creating 50k files in an ignored folder does not cause more than one status refresh per 1.5 s.
- [ ] On a 1M-commit fixture with commit-graph: first graph page < 300 ms. Next page < 150 ms. Memory < 300 MB for 100k loaded commits.
- [ ] `git status` on a 100k-file fixture with fsmonitor enabled < 200 ms (warm).
- [ ] Credentials never appear in the output log, crash reports, or argv.
- [ ] Progress events for clone/fetch/push show monotonically non-decreasing `overall`.

## 10. Out of scope / later

- libgit2/NodeGit backend (never required; could be added behind `GitService` for specific reads).
- Running git inside WSL or over remote SSH hosts.
- Partial clone / sparse-checkout UI (engine passes through. UI later in spec 03).
- `git maintenance` scheduling UI (we only offer a one-time commit-graph write).
- Scalar / VFS for Git.
- Persisted cross-session graph cache (possible future: cache parsed log by tip set in userData).

## 11. Cross-spec dependencies

Requirements other specs place on the engine. The IPC channel names and type names in §5 are authoritative for all specs.

- **`gitflow.*` config (specs 05 §6.12, 12 §6.9, 13 §4.2):** `git:config:list` accepts `pattern` and runs `git config -z --get-regexp <pattern>` (`--local` when `scope: 'local'`). `GitflowConfig` (spec 13 §5.2) is read with `pattern: '^gitflow\.'`. Writes go through `git:config:set`, which is queued (§6.11). No spec parses `gitflow.*` keys by spawning git itself.
- **Pre-op `index.lock` check (specs 05, 06, 08, 09):** the lock pre-check, wait window and "Delete lock & retry" flow in §6.13 rule 3 are the only lock policy. Feature specs must not add their own retry loops. They surface `IndexLocked` / `RefLocked` through the shared lock dialog (§4).
- **`--pathspec-from-file` helper (specs 05 stash push, 06 §6.2, 08 §6.6, 09 LFS convert):** `/packages/git` exports `withPathspec(args: string[], paths: string[]): { args: string[]; stdin?: Buffer }`. Above the §6.1 thresholds (50 paths or 8 KB) it emits `--pathspec-from-file=- --pathspec-file-nul` with a NUL-joined stdin buffer, and otherwise `-- <paths>`. Commands without that flag (for example `git clean`, `git lfs track`, `git update-index --chmod`) are batched by the same helper. It sets `GIT_LITERAL_PATHSPECS=1` unless the caller opts into glob magic.
- **Hidden `refs/githappens/*` (00 "Reserved ref namespace", specs 01, 04, 05):** `git:refs` never returns refs under `refs/githappens/`, because `for-each-ref` (§6.7) only lists `refs/heads`, `refs/remotes`, `refs/tags` and `refs/stash`. Every rev-set the engine builds (graph log §6.6, search, file history, deleted-file search in spec 07 §6.11, deep search in spec 12 §6.7) goes through `buildRevSet(query)`. It never passes a bare `--all`. When "all refs" is wanted it emits `--exclude=refs/githappens/* --all` (the `--exclude` must precede `--all`). Unit test: a fixture with an undo keep-alive ref must not show that commit in the log.
- **Long-lived blob reader (specs 07 §6.3, 08 §6.3, 06 diff building):** the per-repo `git cat-file --batch` and `--batch-check` processes from §6.8 / §6.15.7 are exposed in main as `BlobReader` (`read(rev, path, maxBytes)`, `stat(rev, path)`, stage syntax `:1:<path>`..`:3:<path>` supported). They are restarted on crash and disposed with the repo. Other specs never spawn `git show <rev>:<path>` per file.
- **`.git` state files drive operation banners (specs 05 §4.1 `OperationBanner`, 06 §4.2 WIP states, 08 §4.2 conflict banner):** the RepoWatcher table in §6.14 covers `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` (plus `sequencer/`, `BISECT_LOG`). Paths are resolved with `git rev-parse --git-path <name>` so linked worktrees work. Changes emit `git:repo:changed` with scopes `repoState`, `conflicts` and `status`. `RepoInfo.state` (`RepoState`) is the single source of truth. Spec 05 `OpState`, spec 04 `RepoHeadState.inProgress` and spec 08 `RepoOperationState.op` are derived views of it.
- **Background commit-graph (spec 04 §6.2):** §6.15.1 runs `git commit-graph write --reachable --changed-paths` in the background, gated by the spec 13 setting `graph.maintainCommitGraph`.
- **Stash tips in the graph log (spec 04 §6.4):** `LogQuery.revs: 'all'` includes the `refs/stash` reflog SHAs (§6.6). Spec 04 places stash rows from those SHAs and `git:stash:list`.
- **`--exclude` for hidden refs (specs 01 `RepoUiState.hiddenRefs`, 04 `GraphQuery.hiddenRefs`):** `LogQuery.hiddenRefs` becomes `--exclude=<ref>` options placed before the `--branches`/`--remotes`/`--tags` pseudo-option they apply to. Soloed refs are passed as explicit `revs`.
- **One WIP status per worktree (specs 04, 06, 09 §6.10):** each linked worktree has its own `RepoId` (realpath of its root), its own index lane in the OperationQueue (§6.13) and its own `git:status`. For the graph's per-worktree WIP nodes, `git:status` with `worktreePath` runs `git -C <path> --no-optional-locks status --porcelain=v2 -z --untracked-files=normal` in the read pool. The result is cached per worktree, refreshed on the `worktrees` scope and every 30 s while the graph is visible, and capped at 20 worktrees.
- **PR checkout and cloud-patch apply (specs 10 §6.3, 14 §6):** these are `GitOperation` variants `{ type: 'pr.checkout' }` and `{ type: 'patch.apply' }`, run through `git:op:run`. Both have `OperationMeta.undoable = true` and write an undo-journal entry before executing (spec 05 kinds `checkout` / `branch-create` for PR checkout, `patch-apply` for patches). Neither spec spawns git outside the OperationQueue.
