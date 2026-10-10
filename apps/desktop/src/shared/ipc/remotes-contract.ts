/**
 * Remotes / worktrees / submodules / LFS side channels (spec 09 §5, Phase 8). Writes go through
 * `git:op:run` (`remote.*`, `worktree.*`, `submodule.*`, `lfs.*` ops); these are read helpers the
 * left-panel dialogs need.
 *
 * - `git:lfs:locks`: `git lfs locks --verify --json` (falls back to `--json` without ownership).
 * - `git:worktree:status`: change count of one of the repo's worktrees (Remove Worktree dirty warning).
 * - `git:submodule:parent`: when the repo is a submodule, its superproject + gitlink pointer state
 *   ("Back to parent" banner, spec 09 §6.9 "Open").
 */
import type { RepoId, Sha } from '@githappens/git/types';

export interface LfsLockInfo {
  id: string;
  /** Repo-relative path (`/`-separated). */
  path: string;
  owner: string;
  lockedAt: string;
  /** Held by the current user; null when the server could not verify ownership. */
  ours: boolean | null;
}

export interface LfsLocksResult {
  /** False when git-lfs is missing or the server does not support locking (404/501). */
  supported: boolean;
  locks: LfsLockInfo[];
  /** Short reason when `supported` is false or the listing failed. */
  error?: string;
}

export interface WorktreeStatusInfo {
  path: string;
  /** Number of changed / untracked / conflicted entries (`status --porcelain=v2`). */
  changed: number;
  /** Checked-out branch short name, or null when detached. */
  branch: string | null;
  locked: boolean;
}

export interface SubmoduleParentInfo {
  /** Superproject worktree root (native path). */
  parentPath: string;
  /** This submodule's path inside the parent (`/`-separated). */
  path: string;
  /** Gitlink recorded in the parent's HEAD (null when not committed yet). */
  recordedSha: Sha | null;
  /** Gitlink in the parent's index (staged pointer). */
  indexSha: Sha | null;
  /** The submodule's checked-out commit. */
  headSha: Sha | null;
  /** HEAD differs from the parent's index entry → "Stage pointer" is meaningful. */
  pointerChanged: boolean;
}

export interface RemotesIpcContract {
  'git:lfs:locks': { req: { repoId: RepoId }; res: LfsLocksResult };
  'git:worktree:status': { req: { repoId: RepoId; path: string }; res: WorktreeStatusInfo };
  'git:submodule:parent': { req: { repoId: RepoId }; res: SubmoduleParentInfo | null };
}

export const REMOTES_INVOKE_CHANNELS = [
  'git:lfs:locks',
  'git:worktree:status',
  'git:submodule:parent',
] as const satisfies readonly (keyof RemotesIpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof RemotesIpcContract, (typeof REMOTES_INVOKE_CHANNELS)[number]> = true;
void invokeExhaustive;
