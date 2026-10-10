import { buildRevSet, cancelSearch, searchProgress } from '@githappens/git';
import type { RepoId } from '@githappens/git/types';

import type { GraphIpcContract } from '../../shared/ipc/graph-contract';
import type { AvatarService } from '../avatars/avatar-service';
import type { CommitGraphMaintainer, MaintainedRepo } from '../repo-ui/commit-graph-maintenance';
import type { RepoUiStore } from '../repo-ui/repo-ui-store';
import type { HandlerContext } from './registry';

export type GraphHandlers = {
  [C in keyof GraphIpcContract]: (
    req: GraphIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => GraphIpcContract[C]['res'] | Promise<GraphIpcContract[C]['res']>;
};

export interface GraphHandlerDeps {
  avatars: Pick<AvatarService, 'resolve'>;
  repoUi: Pick<RepoUiStore, 'get' | 'save'>;
  /** Open repository → paths (throws for unknown ids, like every repo channel). */
  repo: (repoId: RepoId) => MaintainedRepo;
  commitGraph?: Pick<CommitGraphMaintainer, 'onRepoOpened'>;
  /** `git rev-list --count <args>` in the repo (background priority). */
  runGit?: (cwd: string, args: string[]) => Promise<string>;
}

/** `rev-list --count` over the same rev-set the graph log uses (spec 02 `buildRevSet`). */
export async function countCommits(
  run: (args: string[]) => Promise<string>,
  revs: string[] | 'all',
  hiddenRefs?: string[],
): Promise<number> {
  const count = async (includeHead: boolean): Promise<number> => {
    const args = buildRevSet({
      revs: revs === 'all' ? 'all' : revs.filter((r) => includeHead || r !== 'HEAD'),
      hiddenRefs,
      includeHead,
    });
    if (!args.length) return 0;
    const n = Number((await run(['rev-list', '--count', ...args, '--'])).trim());
    return Number.isFinite(n) ? n : 0;
  };
  try {
    return await count(true);
  } catch {
    return count(false).catch(() => 0); // unborn HEAD
  }
}

/** Avatar + per-repo graph UI state channels (spec 04 §5.4, spec 10 §4.10). */
export function createGraphHandlers(d: GraphHandlerDeps): GraphHandlers {
  return {
    'avatar:resolve': (req) =>
      d.avatars.resolve({ items: Array.isArray(req?.items) ? req.items : [], size: req?.size }),
    'repoUi:get': ({ repoId }) => {
      const repo = d.repo(repoId);
      // The graph asks for its UI state when it opens: a good moment to check the commit-graph file.
      d.commitGraph?.onRepoOpened(repo);
      return d.repoUi.get(repo.commonDir);
    },
    'repoUi:save': ({ repoId, patch }) => d.repoUi.save(d.repo(repoId).commonDir, patch),
    'graph:countCommits': ({ repoId, revs, hiddenRefs }) => {
      const run = d.runGit;
      if (!run) return 0;
      const cwd = d.repo(repoId).cwd;
      return countCommits((args) => run(cwd, args), revs, Array.isArray(hiddenRefs) ? hiddenRefs : undefined);
    },
    // Searches run in GitService.search (`graph:search`); ids are renderer-generated UUIDs.
    'graph:search:cancel': ({ searchId }) => {
      if (typeof searchId === 'string') cancelSearch(searchId);
    },
    'graph:search:progress': ({ searchId, from }) =>
      typeof searchId === 'string' ? searchProgress(searchId, typeof from === 'number' ? from : 0) : null,
  };
}
