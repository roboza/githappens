import type { CommitSummary, RepoId, Sha } from '@githappens/git/types';

/**
 * Sync safety IPC (spec 09 §4.3, §5, §6.5, §6.12). Reads only: every mutation (fetch / pull / push with
 * `--force-with-lease`) stays a `git:op:run` variant.
 */

/** `git:push:preview` (spec 09 §5): what a (force) push would do to the remote branch right now. */
export interface PushPreviewResult {
  /** Fresh `ls-remote` sha of the target branch (null = the branch doesn't exist on the remote). */
  remoteSha: Sha | null;
  localSha: Sha | null;
  /** Remote commits a force push would overwrite (`<local>..<remote>`), newest first. */
  wouldLose: CommitSummary[];
  truncated: boolean;
  isFastForward: boolean;
  /** Pass as `expectedRemoteSha` so the push fails safely if the remote moved after the preview. */
  leaseSha: Sha | null;
}

/** A hook as git will see it (honours `core.hooksPath`, spec 09 §6.12). */
export interface HookStatus {
  name: string;
  path: string;
  exists: boolean;
  /** false = git ignores it (POSIX, missing `chmod +x`). */
  executable: boolean;
}

export interface SyncIpcContract {
  'git:push:preview': {
    req: { repoId: RepoId; localRef: string; remote: string; remoteBranch: string };
    res: PushPreviewResult;
  };
  'sync:hooks': { req: { repoId: RepoId; names?: string[] }; res: HookStatus[] };
}

export const SYNC_INVOKE_CHANNELS = [
  'git:push:preview',
  'sync:hooks',
] as const satisfies readonly (keyof SyncIpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const syncExhaustive: Exhaustive<keyof SyncIpcContract, (typeof SYNC_INVOKE_CHANNELS)[number]> = true;
void syncExhaustive;
