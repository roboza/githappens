/**
 * Mutating operations (spec 02 §5.5). Every mutating action is a `GitOperation`
 * variant run through `git:op:run`; `type` is the logical channel name with `:`
 * replaced by `.` (spec 05 §5 "Mapping to the spec 02 contract").
 * Pure types — imported by the renderer via '@githappens/git/ops'.
 */
export { diffHash, STAGING_DIFF_OPTIONS } from './diff-hash';
export * from './ignore-pattern';
export * from './raw-path';
import type { DiffSpec, RefreshScope, SerializedGitError, Sha, TodoItem } from '../types';
import type { GitflowBranchKind, GitflowFinishKind, GitflowSettings } from '../service/gitflow';

// ---- staging & committing (spec 06 §5) ----
export type Side = 'unstaged' | 'staged';
export interface LineRef {
  hunkIndex: number;
  lineIndex: number;
}
export interface CoAuthor {
  name: string;
  email: string;
}
export interface CommitReq {
  summary: string;
  description: string;
  coAuthors: CoAuthor[];
  amend: boolean;
  skipHooks: boolean;
  allowEmpty: boolean;
  sign: 'config' | 'force' | 'off';
  cleanup: 'strip' | 'whitespace' | 'verbatim';
  author?: { name: string; email: string };
}

// ---- branches, checkout, tags, stash (spec 05 §5) ----
export type CheckoutTarget =
  | { kind: 'branch'; name: string }
  | {
      kind: 'remoteBranch';
      remote: string;
      name: string;
      localName?: string;
      /**
       * When the local branch already exists (spec 05 §4.5 RemoteCheckoutConflictDialog): `ff` = switch to it and
       * fast-forward when behind; `reset` = switch to it and move it to the remote branch (`reset --keep`).
       */
      onExisting?: 'ff' | 'reset';
    }
  | { kind: 'commit'; sha: Sha }
  | { kind: 'tag'; name: string };
export type DirtyStrategy = 'carry' | 'stash' | 'discard';

// ---- remotes (spec 09 §5) ----
/** `merge-no-ff` (spec 09 §6.4 extension): always create a merge commit. */
export type PullStrategy = 'ff-if-possible' | 'ff-only' | 'rebase' | 'merge-no-ff';

export type GitOperation =
  // staging (spec 06)
  | { type: 'wip.stage'; paths: string[] }
  | { type: 'wip.unstage'; paths: string[] }
  | { type: 'wip.stageAll' }
  /** Locking status: writes the fsmonitor token + untracked cache (background, spec 02 §6.15.2). */
  | { type: 'index.refresh' }
  | { type: 'wip.unstageAll' }
  | { type: 'wip.stageHunk'; path: string; hunkIndex: number; diffHash: string }
  | { type: 'wip.unstageHunk'; path: string; hunkIndex: number; diffHash: string }
  | { type: 'wip.discardHunk'; path: string; hunkIndex: number; diffHash: string }
  | { type: 'wip.stageLines'; path: string; lines: LineRef[]; diffHash: string }
  | { type: 'wip.unstageLines'; path: string; lines: LineRef[]; diffHash: string }
  | { type: 'wip.discardLines'; path: string; lines: LineRef[]; diffHash: string }
  | { type: 'wip.discard'; paths: string[]; includeUntracked: boolean }
  | { type: 'wip.discardAll'; includeUntracked: boolean }
  | { type: 'wip.ignore'; pattern: string; stopTracking?: string[] }
  | ({ type: 'commit.create' } & CommitReq)
  | { type: 'commit.rewordHead'; summary: string; description: string }
  /** Write the commit template (`commit.template`, else `.git/githappens/commit-template.txt`). */
  | { type: 'commit.saveTemplate'; scope: 'repo' | 'global'; text: string }
  // branches & checkout (spec 05)
  | { type: 'branch.create'; name: string; startPoint: string; checkout: boolean; track?: string }
  | { type: 'branch.rename'; from: string; to: string }
  | {
      type: 'branch.delete';
      branches: { name: string; deleteRemote?: { remote: string; remoteBranch: string } }[];
      force: boolean;
    }
  | { type: 'branch.setUpstream'; localBranch: string; upstream: string | null }
  /**
   * Rename a branch on a remote (spec 05 §6.1 opt-in): push `<r>/<from>` as `<to>`, delete `<from>` and point the
   * local branch tracking it (if any) at the new name. Network op (undo barrier).
   */
  | { type: 'branch.renameRemote'; remote: string; from: string; to: string; localBranch?: string }
  | { type: 'checkout.run'; target: CheckoutTarget; dirtyStrategy: DirtyStrategy }
  | { type: 'tag.create'; name: string; target: Sha; annotated?: { message: string; sign?: boolean } }
  | { type: 'tag.delete'; name: string; local: boolean; remotes: string[] }
  | { type: 'tag.push'; name: string; remote: string }
  | {
      type: 'stash.push';
      message?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
      /** `--staged` (git >= 2.35): stash only the staged changes. */
      stagedOnly?: boolean;
      paths?: string[];
    }
  | { type: 'stash.apply'; index: number; sha: Sha }
  | { type: 'stash.pop'; index: number; sha: Sha }
  | { type: 'stash.drop'; index: number; sha: Sha }
  // Phase 8 (spec 05 §4.9, §6.10): stash extras
  /** Edit the message: rebuild the stash list so the entry keeps its position. */
  | { type: 'stash.rename'; index: number; sha: Sha; message: string }
  /** Apply one file of a stash (tracked: `checkout stash -- path`; untracked: from the stash's 3rd parent). */
  | { type: 'stash.applyFile'; index: number; sha: Sha; path: string }
  /** `git stash branch <name> stash@{n}`. */
  | { type: 'stash.branch'; index: number; sha: Sha; name: string }
  // remotes & sync (spec 09)
  | { type: 'fetch'; remote: string | 'all'; prune?: boolean; background?: boolean }
  | {
      type: 'pull';
      strategy: PullStrategy;
      remote?: string;
      branch?: string;
      autostash?: boolean;
      /** Rebase strategy only: `--rebase-merges` (setting `git.pullRebaseMerges`, spec 09 §6.4). */
      rebaseMerges?: boolean;
    }
  | { type: 'fastForwardBranch'; localBranch: string; upstream: string }
  | {
      type: 'push';
      localRef: string;
      remote: string;
      remoteBranch: string;
      setUpstream?: boolean;
      force?: 'lease' | 'none';
      expectedRemoteSha?: Sha | null;
      followTags?: boolean;
      noVerify?: boolean;
      /** With `force: 'lease'`: also pass `--force-if-includes` (git ≥ 2.30). */
      forceIfIncludes?: boolean;
    }
  | { type: 'push.tags'; remote: string; tags: string[] | 'all'; noVerify?: boolean }
  | { type: 'push.delete'; remote: string; refs: string[]; noVerify?: boolean }
  | {
      type: 'remote.add';
      name: string;
      fetchUrl: string;
      pushUrl?: string;
      fetchAfter?: boolean;
      /** Shallow repos (spec 09 §4.3): constraints for the first fetch of the new remote. */
      shallow?: { depth?: number; since?: string; extraArgs?: string[] };
    }
  | { type: 'remote.edit'; name: string; newName?: string; fetchUrl?: string; pushUrl?: string | null }
  | { type: 'remote.remove'; name: string }
  // history rewriting (spec 05, Phase 3)
  | { type: 'merge.run'; source: string; mode: MergeMode; message?: string }
  | { type: 'merge.continue'; message?: string }
  | { type: 'merge.abort' }
  | { type: 'rebase.run'; onto: string; branch?: string; upstream?: string }
  | {
      type: 'rebase.interactive';
      /** Commit the todo list is replayed on top of. */
      onto: Sha;
      /** Exclusive lower bound: commits after `upstream` up to HEAD are rewritten. */
      upstream: Sha;
      /** Oldest first. */
      todo: TodoItem[];
      /** Message for each squash group, keyed by the sha of the group's first (target) commit. */
      squashMessages?: Record<Sha, string>;
    }
  | { type: 'rebase.continue'; message?: string }
  | { type: 'rebase.skip' }
  | { type: 'rebase.abort' }
  | { type: 'cherryPick.run'; shas: Sha[]; noCommit?: boolean; mainline?: number }
  | { type: 'revert.run'; shas: Sha[]; noCommit?: boolean; mainline?: number }
  | { type: 'sequencer.continue'; message?: string }
  | { type: 'sequencer.skip' }
  | { type: 'sequencer.abort' }
  | { type: 'reset.run'; target: Sha; mode: ResetMode }
  /**
   * Move a branch that is not checked out (spec 05 §6.9): `update-ref` with compare-and-swap. Soft and mixed are
   * the same for a branch without an index; hard needs a checkout and is refused.
   */
  | { type: 'reset.branch'; branch: string; target: string; mode: 'soft' | 'mixed' }
  /** Reflog fallback of Undo (spec 05 §4.7): `reset --keep` HEAD's branch to an earlier reflog position. */
  | { type: 'reflog.restore'; target: Sha; selector: string }
  /**
   * Squash N commits into one (spec 05 §6.9): a contiguous first-parent range ending at HEAD or below it, without
   * merges. Fast path `reset --soft` + commit when it ends at HEAD; otherwise an interactive rebase.
   */
  | { type: 'squash.run'; shas: Sha[]; message: string }
  /** Fast-forward a branch (current: merge --ff-only; other: update-ref after ancestry check). */
  | { type: 'ff.run'; branch: string; to: string }
  // conflict resolution (spec 08)
  | {
      type: 'conflict.saveFile';
      path: string;
      text: string;
      markResolved: boolean;
      /** Mode conflict chooser (spec 08 §4.6): `update-index --chmod=±x` after staging. */
      executable?: boolean;
    }
  | { type: 'conflict.take'; paths: string[]; side: 'ours' | 'theirs' | 'base' }
  | { type: 'conflict.resolveSpecial'; path: string; action: SpecialResolution }
  /** Stash apply/pop conflicts have no native abort (spec 08 §6.7): `git reset --merge`; the stash is kept. */
  | { type: 'conflict.resetMerge' }
  /** `git am` in progress (spec 08 §6.7). */
  | { type: 'am.continue' }
  | { type: 'am.skip' }
  | { type: 'am.abort' }
  | { type: 'conflict.markResolved'; paths: string[] }
  | { type: 'conflict.markUnresolved'; paths: string[] }
  /**
   * Strategy A external merge tool (spec 08 §6.8): `git mergetool --no-prompt [--tool=<t>] -- <path>`. git writes the
   * stage temp files, waits for the tool and `git add`s on success, so it runs through the queue like markResolved.
   */
  | {
      type: 'conflict.mergetool';
      path: string;
      /** git's tool name (`bc`, `kdiff3`, `vscode`…); omitted = the `merge.tool` from git config. */
      tool?: string;
      /** Executable override (`-c mergetool.<tool>.path=`). */
      toolPath?: string;
      /** `mergetool.keepBackup` (default false → no `.orig`). */
      keepBackup?: boolean;
      /** `mergetool.<tool>.trustExitCode`. */
      trustExitCode?: boolean;
    }
  // in-app editor (spec 07)
  | { type: 'file.write'; path: string; content: string }
  // diff viewer (spec 07 §6.6): reverse-apply one hunk (or every hunk) of a commit/compare diff to the worktree
  | {
      type: 'diff.revertHunk';
      spec: DiffSpec;
      path: string;
      oldPath?: string;
      hunkIndex: number | 'all';
      /** `diffHash` of the file diff the UI showed (computed with `contextLines`, whitespace shown). */
      diffHash: string;
      contextLines?: number;
    }
  /** "Checkout file at this commit" (spec 07 §2.3): `git checkout <rev> -- <path>` (index + worktree). */
  | { type: 'file.checkoutAt'; rev: string; path: string }
  // submodules, worktrees, LFS (spec 09)
  | { type: 'submodule.add'; url: string; path: string; branch?: string }
  | { type: 'submodule.update'; paths?: string[]; init?: boolean; recursive?: boolean; remote?: boolean }
  | { type: 'submodule.remove'; path: string }
  /** Edit URL (spec 09 §6.9): `git submodule set-url` (updates `.gitmodules` + syncs), stages `.gitmodules`. */
  | { type: 'submodule.setUrl'; path: string; url: string }
  | {
      type: 'worktree.add';
      path: string;
      branch?: string;
      newBranch?: string;
      startPoint?: string;
      detach?: boolean;
    }
  | { type: 'worktree.remove'; path: string; force?: boolean }
  | { type: 'worktree.lock'; path: string; reason?: string }
  | { type: 'worktree.unlock'; path: string }
  | { type: 'worktree.prune' }
  | { type: 'lfs.install' }
  | { type: 'lfs.track'; patterns: string[] }
  | { type: 'lfs.untrack'; patterns: string[] }
  | { type: 'lfs.pull'; remote?: string }
  | { type: 'lfs.fetch'; all?: boolean }
  | { type: 'lfs.push'; remote: string; all?: boolean }
  | { type: 'lfs.prune' }
  /** "Convert existing files" (spec 09 §6.8): track + re-add matching tracked files through the LFS filter. */
  | { type: 'lfs.convert'; patterns: string[] }
  | { type: 'lfs.lock'; path: string }
  | { type: 'lfs.unlock'; path: string; force?: boolean }
  // sparse checkout management (spec 03 §7 step 17); `cone` defaults to "no globs in patterns"
  | { type: 'sparse.set'; patterns: string[]; cone?: boolean }
  | { type: 'sparse.add'; patterns: string[] }
  | { type: 'sparse.disable' }
  | { type: 'sparse.reapply' }
  // pull requests (spec 10 §6.3)
  | {
      type: 'pr.checkout';
      /** Remote that hosts the PR (base repo remote). */
      remote: string;
      number: number;
      headBranch: string;
      /** Same-repo PR: track `<remote>/<headBranch>`. */
      sameRepo: boolean;
      /** Provider PR ref with `{n}`, e.g. 'refs/pull/{n}/head' (fork PRs). */
      refspec: string | null;
      /** Fork clone URL, used when the provider has no PR refspec. */
      headCloneUrl?: string;
      localBranch: string;
      checkout: boolean;
      /**
       * `branch` (default): create/update `localBranch` (and check it out when `checkout`);
       * `worktree`: same branch, checked out in a new worktree at `worktreePath`;
       * `fetch`: only fetch the head (and `baseBranch`) into `refs/githappens/pr/{n}` — no branch is touched.
       */
      mode?: 'branch' | 'worktree' | 'fetch';
      worktreePath?: string;
      /** `fetch` mode: also refresh `<remote>/<baseBranch>`. */
      baseBranch?: string;
    }
  // AI Commit Composer (spec 12 §6.6)
  | {
      type: 'ai.compose';
      source: ComposeSource;
      /** `composeHash` of the diff the proposal was made from; the op refuses when it changed. */
      diffHash: string;
      /** Oldest first. `hunkId`s come from `composeUnits`; unassigned hunks stay staged. */
      commits: { message: string; hunks: { path: string; hunkId: string }[] }[];
      /** Default true: hooks that modify the index would break the plan (spec 12 §8). */
      skipHooks?: boolean;
    }
  // Git Flow (spec 05 §6.12, spec 12 §6.9)
  | ({ type: 'gitflow.init' } & GitflowSettings)
  | {
      type: 'gitflow.start';
      kind: GitflowBranchKind;
      /** Without the prefix (`login` → `feature/login`). */
      name: string;
      /**
       * Defaults to develop (feature/bugfix/release) or the production branch (hotfix). Required for
       * support (`git flow support start <name> <base>`: usually a version tag).
       */
      base?: string;
      publish?: { remote: string };
    }
  | {
      type: 'gitflow.finish';
      /** Support branches are long-lived and cannot be finished (as in AVH git-flow). */
      kind: GitflowFinishKind;
      name: string;
      /** Feature/bugfix only: rebase the branch onto develop before merging. */
      rebase?: boolean;
      deleteBranch: boolean;
      /** Release/hotfix: annotated tag on the production branch (message required). */
      tag?: { name: string; message: string };
      /** Push develop (and production + tag for release/hotfix) afterwards; such a finish is not undoable. */
      push?: { remote: string };
    }
  /** Resume a finish paused on a conflict (after the merge/rebase was resolved). */
  | { type: 'gitflow.continue' }
  /** Drop a paused finish: aborts the merge/rebase and rolls back the steps already done. */
  | { type: 'gitflow.abort' }
  /** Remove every `gitflow.*` key from the repo config (spec 13 Gitflow "Reset"). Branches are kept. */
  | { type: 'gitflow.reset' }
  // Cloud Patches (spec 14 §6.3)
  | {
      type: 'patch.apply';
      /** Absolute path of the patch file (`git diff --binary` or `git format-patch --stdout` output). */
      patchFile: string;
      /** `am`: commit with the patch's author/message (format-patch input, branch targets). */
      mode: 'apply' | 'am';
      target: PatchApplyTarget;
      /** Default true: `git apply --3way` first. */
      threeWay?: boolean;
      /** `--ignore-whitespace` (CRLF / autocrlf differences). */
      ignoreWhitespace?: boolean;
      /** Fall back to `git apply --reject` (partial apply, `.rej` files) when nothing else applies. */
      reject?: boolean;
      /** Branch targets, mode `apply`: commit the applied changes with this message. */
      commitMessage?: string;
      /** Patch title for the op label / undo entry. */
      title?: string;
    }
  // config writes take config.lock, so they are queued (spec 02 §6.11, `git:config:set`)
  | { type: 'config.set'; key: string; value: string | null; scope: 'global' | 'local' | 'worktree' }
  // background `git commit-graph write` (spec 02 §6.15.1): a cancellable maintenance op that never blocks
  // user ops (touches no refs or index); one at a time per repository
  | { type: 'maintenance.commitGraph'; changedPaths?: boolean }
  // undo journal (spec 05)
  | { type: 'undo.run' }
  | { type: 'redo.run' };

export type PatchApplyTarget =
  | { kind: 'worktree' }
  /** `base` defaults to HEAD (the patch base sha when available). */
  | { kind: 'new-branch'; name: string; base?: string; autostash?: boolean }
  | { kind: 'existing-branch'; name: string; autostash?: boolean };

/**
 * `conflict.resolveSpecial` actions (spec 08 §4.6, §5): keep/delete (DU/UD/AU/UA/DD), a whole side, a submodule
 * commit (`update-index --cacheinfo 160000,<sha>,<path>`), a new symlink target, the executable bit, or a
 * rename/rename group (keep some of the paths, delete the others).
 */
export type SpecialResolution =
  | 'keep'
  | 'delete'
  | 'take-ours'
  | 'take-theirs'
  | { submoduleSha: Sha }
  | { symlinkTarget: string }
  | { executable: boolean }
  | { rename: { keep: string[]; remove: string[] } };

export type MergeMode = 'default' | 'no-ff' | 'ff-only' | 'squash';
/** Compose input: the staged changes, or a contiguous range `from^..to` that must end at HEAD (v1). */
export type ComposeSource = { kind: 'staged' } | { kind: 'range'; from: string; to: string };
export type ResetMode = 'soft' | 'mixed' | 'hard';

export type GitOperationType = GitOperation['type'];
export type OpOf<T extends GitOperationType> = Extract<GitOperation, { type: T }>;

/** Per-variant metadata (spec 02 §5.5). */
export interface OperationMeta {
  label: (op: GitOperation) => string;
  mutating: boolean;
  /** Enables askpass; no read timeout. */
  network: boolean;
  cancellable: boolean;
  /** Scopes to refresh after completion. */
  touches: RefreshScope[];
  /** Records an undo-journal entry (spec 05). */
  undoable: boolean;
  exclusive: 'repo' | 'none';
}

/** Result of `git:op:run` (spec 02 §5.5). `data` carries the variant-specific outcome. */
export interface OpResult<D = unknown> {
  opId: string;
  summary?: string;
  warnings?: string[];
  data?: D;
}

export type OpStateName = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface OpStateEvent {
  opId: string;
  type: GitOperationType;
  label: string;
  state: OpStateName;
  error?: SerializedGitError;
}

// ---- variant-specific outcomes (carried in OpResult.data) ----
export interface CommitOutcome {
  sha: Sha;
  hookOutput?: string;
}
export interface PushOutcome {
  /** Parsed `git push --porcelain` ref lines. */
  refs: { flag: string; from: string; to: string; summary: string }[];
  /** `remote:` lines of the push output (spec 09 §6.5 step 5). */
  remoteMessages?: string[];
  /** "Create a pull request" / merge request URL printed by the remote. */
  prUrlHint?: string;
}
/** Result of `fetch` (spec 09 §5 `FetchResult`). */
export interface FetchOutcome {
  remotes: string[];
  /** Flag: ' ' fast-forward, '+' forced, '-' pruned, 't' tag update, '*' new, '!' rejected. */
  updatedRefs: { flag: string; ref: string; old?: Sha; new?: Sha; summary?: string }[];
  pruned: string[];
}
export interface PullOutcome {
  /** What actually happened: nothing to do, fast-forward, merge commit, or rebase. */
  result: 'up-to-date' | 'fast-forward' | 'merge' | 'rebase';
  /** Rebase pulls only: local merge commits that were flattened (no `--rebase-merges`). */
  flattenedMerges?: number;
  /** The pull autostashed local changes (`autostash`) and re-applied them. */
  autostashed?: boolean;
}
export interface CheckoutPreflight {
  dirty: boolean;
  /** Changed paths that the checkout would overwrite. */
  blockingPaths: string[];
  localExists?: {
    name: string;
    upstream?: string;
    relation: 'same' | 'behind' | 'ahead' | 'diverged' | 'unrelated';
  };
}
export interface PatchApplyOutcome {
  applied: boolean;
  /** Files left with conflict markers / unmerged index entries (3-way). */
  conflicts: string[];
  /** `.rej` files written by `git apply --reject` (repo-relative). */
  rejects: string[];
  /** Branch the patch was applied on (branch targets). */
  branch?: string;
  /** Commit created (`am` or `commitMessage`). */
  commit?: Sha;
  /** Stash created for local changes before switching branches. */
  autostash?: Sha;
}
export interface UndoPeek {
  undo?: { id: string; label: string; kind: string; ts: number };
  redo?: { id: string; label: string; kind: string; ts: number };
  /** Why undo is blocked (e.g. the last action was a push). */
  blockedBy?: string;
}
