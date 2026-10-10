import type { RepoId } from '@githappens/git';

import type { BehaviourIpcContract } from '../../shared/ipc/behaviour-contract';
import type { OutputLog } from '../output/output-log';
import type { HandlerContext } from './registry';

type OutputChannel = 'git:output:list' | 'git:output:clear';

export type OutputHandlers = {
  [C in OutputChannel]: (
    req: BehaviourIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => BehaviourIpcContract[C]['res'] | Promise<BehaviourIpcContract[C]['res']>;
};

/** Git output log (spec 02 §5.3 `git:output:list`); `git:output:append` is broadcast by the OutputLog. */
export function createOutputHandlers(log: Pick<OutputLog, 'list' | 'clear'>): OutputHandlers {
  return {
    'git:output:list': ({ repoId, limit }) => log.list(repoId as RepoId, limit),
    'git:output:clear': ({ repoId }) => log.clear(repoId as RepoId),
  };
}
