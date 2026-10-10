import type { ConflictIgnoreScope, ConflictsIpcContract } from '../../shared/ipc/conflicts-contract';
import type { ConflictService } from '../conflicts/conflict-service';
import type { TeamService } from '../cloud/team/team-service';
import type { HandlerContext } from './registry';

export type ConflictsHandlers = {
  [C in keyof ConflictsIpcContract]: (
    req: ConflictsIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => ConflictsIpcContract[C]['res'] | Promise<ConflictsIpcContract[C]['res']>;
};

export interface ConflictsHandlerDeps {
  conflicts: Pick<ConflictService, 'check' | 'hunks' | 'ignore' | 'listIgnores' | 'setTarget'>;
  team: Pick<TeamService, 'status' | 'view'>;
}

const SCOPES = new Set<ConflictIgnoreScope>(['file', 'branch', 'target']);

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v || v.includes('\0')) throw new Error(`Invalid ${name}`);
  return v;
}

/** Conflict Prevention + Team view IPC (spec 14 §5.4). */
export function createConflictsHandlers(deps: ConflictsHandlerDeps): ConflictsHandlers {
  const { conflicts, team } = deps;
  return {
    'conflicts:check': ({ repoId, force }) => conflicts.check(str(repoId, 'repoId'), { force: !!force }),
    'conflicts:hunks': ({ repoId, path }) => conflicts.hunks(str(repoId, 'repoId'), str(path, 'path')),
    'conflicts:ignore': ({ repoId, scope, value, until, remove }) => {
      if (!SCOPES.has(scope)) throw new Error('Invalid scope');
      if (until !== undefined && (typeof until !== 'string' || Number.isNaN(Date.parse(until)))) {
        throw new Error('Invalid until');
      }
      return conflicts.ignore(
        str(repoId, 'repoId'),
        { scope, value: str(value, 'value'), ...(until ? { until } : {}) },
        !!remove,
      );
    },
    'conflicts:ignores': ({ repoId }) => conflicts.listIgnores(str(repoId, 'repoId')),
    'conflicts:setTarget': ({ repoId, branch, target }) =>
      conflicts.setTarget(
        str(repoId, 'repoId'),
        branch ? str(branch, 'branch') : undefined,
        target === null ? null : str(target, 'target'),
      ),
    'team:status': () => team.status(),
    'team:view': ({ repoId }) => team.view(repoId ? str(repoId, 'repoId') : undefined),
  };
}
