import type { CloudWorkspacesIpcContract } from '../../shared/ipc/cloud-workspaces-contract';
import type { CloudWorkspaceService, LaunchpadStateSync } from '../cloud/workspaces';
import { toIpcCloudError } from './cloud-handlers';
import type { HandlerContext } from './registry';

export type CloudWorkspacesHandlers = {
  [C in keyof CloudWorkspacesIpcContract]: (
    req: CloudWorkspacesIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => CloudWorkspacesIpcContract[C]['res'] | Promise<CloudWorkspacesIpcContract[C]['res']>;
};

function wrap<A extends unknown[], R>(fn: (...a: A) => R | Promise<R>): (...a: A) => Promise<R> {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      throw toIpcCloudError(e);
    }
  };
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid ${name}`);
  return v;
};

/** Cloud workspaces + Launchpad server state IPC (spec 11 §6.6, spec 14). */
export function createCloudWorkspacesHandlers(svc: {
  workspaces: CloudWorkspaceService;
  launchpadState: LaunchpadStateSync;
}): CloudWorkspacesHandlers {
  const w = svc.workspaces;
  return {
    'cloudWorkspace:list': wrap(() => w.list()),
    'cloudWorkspace:publish': wrap(({ workspaceId, orgId, force }) =>
      w.publish(str(workspaceId, 'workspace'), orgId, !!force),
    ),
    'cloudWorkspace:share': wrap(({ id, shares }) => {
      if (!Array.isArray(shares)) throw new Error('Invalid shares');
      return w.share(str(id, 'workspace'), shares);
    }),
    'cloudWorkspace:shareTargets': wrap(({ orgId }) => w.shareTargets(orgId)),
    'cloudWorkspace:open': wrap(({ id, cloneRoot }) => w.open(str(id, 'workspace'), cloneRoot)),
    'cloudWorkspace:cloneMissing': wrap(({ workspaceId, cloneRoot, protocol }) =>
      w.cloneMissing(str(workspaceId, 'workspace'), cloneRoot, protocol),
    ),
    'cloudWorkspace:status': wrap(({ workspaceId }) => w.status(str(workspaceId, 'workspace'))),
    'cloudWorkspace:unlink': wrap(({ workspaceId }) => w.unlink(str(workspaceId, 'workspace'))),
    'cloudWorkspace:delete': wrap(({ id }) => w.delete(str(id, 'workspace'))),
    'launchpadState:status': () => svc.launchpadState.status(),
    'launchpadState:syncNow': wrap(() => svc.launchpadState.syncNow()),
  };
}
