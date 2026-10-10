import type { GitService, RepoId } from '@githappens/git';

import type { RemotesIpcContract } from '../../shared/ipc/remotes-contract';
import { listLfsLocks, submoduleParent, worktreeStatus } from '../remotes/remote-reads';
import type { HandlerContext } from './registry';

export type RemotesHandlers = {
  [C in keyof RemotesIpcContract]: (
    req: RemotesIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => RemotesIpcContract[C]['res'] | Promise<RemotesIpcContract[C]['res']>;
};

/** What the handlers need from the RepoManager. */
export interface RemotesRepos {
  get(repoId: RepoId): GitService;
}

/** Remotes / worktrees / submodules / LFS read channels (spec 09, Phase 8). */
export function createRemotesHandlers(repos: RemotesRepos): RemotesHandlers {
  return {
    'git:lfs:locks': ({ repoId }) => listLfsLocks(repos.get(repoId)),
    'git:worktree:status': ({ repoId, path }) => {
      if (typeof path !== 'string' || !path || /[\0\r\n]/.test(path)) throw new Error('Invalid path.');
      return worktreeStatus(repos.get(repoId), path);
    },
    'git:submodule:parent': ({ repoId }) => submoduleParent(repos.get(repoId)),
  };
}
