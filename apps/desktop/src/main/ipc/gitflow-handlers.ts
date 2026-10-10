import { gitflowStatus, type GitService, type RepoId } from '@githappens/git';

import type { GitflowIpcContract } from '../../shared/ipc/gitflow-contract';
import type { HandlerContext } from './registry';

export type GitflowHandlers = {
  [C in keyof GitflowIpcContract]: (
    req: GitflowIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => GitflowIpcContract[C]['res'] | Promise<GitflowIpcContract[C]['res']>;
};

/** What the handlers need from the RepoManager. */
export interface GitflowRepos {
  get(repoId: RepoId): GitService;
}

/** Git Flow IPC (spec 12 §6.9). Mutations go through `git:op:run` (`gitflow.*` ops). */
export function createGitflowHandlers(repos: GitflowRepos): GitflowHandlers {
  return {
    'gitflow:get': ({ repoId }) => gitflowStatus(repos.get(repoId)),
  };
}
