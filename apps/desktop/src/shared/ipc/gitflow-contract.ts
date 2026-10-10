import type {
  GitflowBranches,
  GitflowBranchKind,
  GitflowConfig,
  GitflowFinishKind,
  GitflowPendingFinish,
  GitflowSettings,
} from '@githappens/git/gitflow';
import type { RepoId } from '@githappens/git/types';

export type {
  GitflowBranches,
  GitflowBranchKind,
  GitflowConfig,
  GitflowFinishKind,
  GitflowPendingFinish,
  GitflowSettings,
};

/**
 * Git Flow IPC (spec 12 §5, §6.9). Only the read lives here: every mutation is a `git:op:run` variant
 * (`gitflow.init` / `gitflow.start` / `gitflow.finish` / `gitflow.continue` / `gitflow.abort` /
 * `gitflow.reset`), so the op queue, progress, undo journal and conflict UX apply unchanged.
 */
export interface GitflowState {
  /** null when Git Flow is not initialized (no `gitflow.branch.develop`). */
  config: GitflowConfig | null;
  /** Full local branch names (`feature/login`), grouped by flow prefix. */
  branches: GitflowBranches;
  /** A finish paused on a conflict (`<gitdir>/githappens/gitflow-finish.json`). */
  pendingFinish: GitflowPendingFinish | null;
}

export interface GitflowIpcContract {
  'gitflow:get': { req: { repoId: RepoId }; res: GitflowState };
}

export const GITFLOW_INVOKE_CHANNELS = [
  'gitflow:get',
] as const satisfies readonly (keyof GitflowIpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const gitflowExhaustive: Exhaustive<keyof GitflowIpcContract, (typeof GITFLOW_INVOKE_CHANNELS)[number]> =
  true;
void gitflowExhaustive;
