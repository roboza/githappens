import type { LaunchpadIpcContract } from '../../shared/ipc/launchpad-contract';
import type { LaunchpadService } from '../launchpad/launchpad-service';
import type { HandlerContext } from './registry';

export type LaunchpadHandlers = {
  [C in keyof LaunchpadIpcContract]: (
    req: LaunchpadIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => LaunchpadIpcContract[C]['res'] | Promise<LaunchpadIpcContract[C]['res']>;
};

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`Invalid ${name}`);
  return v;
}

/** Launchpad IPC (spec 11 §5.4). */
export function createLaunchpadHandlers(svc: LaunchpadService): LaunchpadHandlers {
  return {
    'launchpad:query': (req) => {
      if (!req?.filters || typeof req.filters !== 'object') throw new Error('Invalid filters');
      return svc.query(req);
    },
    'launchpad:refresh': async ({ force, workspaceId }) => {
      await svc.refresh({ force: !!force, workspaceId: workspaceId || undefined });
      return { fetchedAt: svc.lastFetchedAt };
    },
    'launchpad:setItemState': (req) => svc.setItemState({ ...req, uid: str(req.uid, 'uid') }),
    'launchpad:views': () => svc.views(),
    'launchpad:saveView': ({ view }) => svc.saveView(view),
    'launchpad:deleteView': ({ id }) => svc.deleteView(str(id, 'id')),
    'launchpad:summary': (req) => svc.summary(req ?? {}),
    'launchpad:prCounts': (req) =>
      svc.workspacePrCounts({
        workspaceId: str(req?.workspaceId, 'workspace id'),
        maxAgeMs: typeof req.maxAgeMs === 'number' ? req.maxAgeMs : undefined,
        offline: !!req.offline,
      }),
  };
}
