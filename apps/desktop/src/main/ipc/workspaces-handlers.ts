import path from 'node:path';

import type {
  BulkOpRequest,
  NewWorkspaceRepo,
  WorkspaceDirectorySync,
  WorkspacesIpcContract,
} from '../../shared/ipc/workspaces-contract';
import type { WorkspaceService } from '../workspaces/workspace-service';
import type { HandlerContext } from './registry';

export type WorkspacesHandlers = {
  [C in keyof WorkspacesIpcContract]: (
    req: WorkspacesIpcContract[C]['req'],
    ctx: HandlerContext,
  ) => WorkspacesIpcContract[C]['res'] | Promise<WorkspacesIpcContract[C]['res']>;
};

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid ${name}`);
  return v;
}

function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return str(v, name);
}

function absPath(v: unknown, name: string): string {
  const p = str(v, name);
  if (/\0/.test(p) || !path.isAbsolute(p)) throw new Error(`Invalid ${name}`);
  return p;
}

function strArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`Invalid ${name}`);
  return v as string[];
}

function newRepos(v: unknown): NewWorkspaceRepo[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('Invalid repos');
  return v.map((r: NewWorkspaceRepo) => {
    if (!r || typeof r !== 'object') throw new Error('Invalid repo');
    const p = r.provider;
    return {
      ...(r.name !== undefined ? { name: str(r.name, 'repo name') } : {}),
      ...(r.localPath !== undefined ? { localPath: absPath(r.localPath, 'repo path') } : {}),
      ...(r.remoteUrl !== undefined ? { remoteUrl: str(r.remoteUrl, 'remote URL') } : {}),
      ...(p
        ? {
            provider: {
              integrationKey: str(p.integrationKey, 'integration'),
              owner: str(p.owner, 'owner'),
              name: str(p.name, 'name'),
              cloneUrlHttps: String(p.cloneUrlHttps ?? ''),
              cloneUrlSsh: String(p.cloneUrlSsh ?? ''),
              webUrl: String(p.webUrl ?? ''),
            },
          }
        : {}),
    };
  });
}

function directory(v: WorkspaceDirectorySync | undefined): WorkspaceDirectorySync | undefined {
  if (!v) return undefined;
  return {
    root: absPath(v.root, 'root folder'),
    depth: Number(v.depth),
    includeNested: !!v.includeNested,
    ignore: v.ignore === undefined ? [] : strArray(v.ignore, 'ignore globs'),
  };
}

function bulkRequest(req: BulkOpRequest): BulkOpRequest {
  if (!['fetch', 'pull', 'push', 'clone'].includes(req.op)) throw new Error('Invalid bulk operation');
  const o = req.options ?? {};
  if (o.pullMode !== undefined && !['ff-if-possible', 'ff-only', 'rebase'].includes(o.pullMode)) {
    throw new Error('Invalid pull mode');
  }
  if (o.protocol !== undefined && o.protocol !== 'https' && o.protocol !== 'ssh') {
    throw new Error('Invalid protocol');
  }
  return {
    workspaceId: str(req.workspaceId, 'workspace id'),
    repoIds: strArray(req.repoIds, 'repo ids'),
    op: req.op,
    options: {
      ...(o.pullMode ? { pullMode: o.pullMode } : {}),
      ...(o.autostash ? { autostash: true } : {}),
      ...(o.setUpstream ? { setUpstream: true } : {}),
      ...(o.cloneRoot ? { cloneRoot: absPath(o.cloneRoot, 'clone folder') } : {}),
      ...(o.protocol ? { protocol: o.protocol } : {}),
      ...(o.concurrency !== undefined ? { concurrency: Number(o.concurrency) } : {}),
    },
  };
}

/** Workspaces IPC (spec 11 §5.4). All persistence / git work lives in WorkspaceService. */
export function createWorkspacesHandlers(svc: WorkspaceService): WorkspacesHandlers {
  return {
    'workspace:list': () => svc.list(),
    'workspace:create': (input) =>
      svc.create({
        kind: input.kind,
        name: str(input.name, 'name'),
        description: optStr(input.description, 'description'),
        color: optStr(input.color, 'color'),
        icon: optStr(input.icon, 'icon'),
        repos: newRepos(input.repos),
        directory: directory(input.directory),
        defaultCloneRoot: input.defaultCloneRoot
          ? absPath(input.defaultCloneRoot, 'clone folder')
          : undefined,
      }),
    'workspace:update': ({ id, patch }) => {
      if (!patch || typeof patch !== 'object') throw new Error('Invalid patch');
      return svc.update(str(id, 'workspace id'), {
        ...patch,
        ...(patch.directory ? { directory: directory(patch.directory) } : {}),
        ...(patch.defaultCloneRoot
          ? { defaultCloneRoot: absPath(patch.defaultCloneRoot, 'clone folder') }
          : {}),
      });
    },
    'workspace:delete': ({ id }) => svc.delete(str(id, 'workspace id')),
    'workspace:reorder': ({ ids }) => svc.store.reorder(strArray(ids, 'ids')),
    'workspace:addRepos': ({ workspaceId, repos }) =>
      svc.addRepos(str(workspaceId, 'workspace id'), newRepos(repos)),
    'workspace:removeRepos': ({ workspaceId, repoIds }) =>
      svc.store.removeRepos(str(workspaceId, 'workspace id'), strArray(repoIds, 'repo ids')),
    'workspace:setReposHidden': ({ workspaceId, repoIds, hidden }) =>
      svc.setReposHidden(str(workspaceId, 'workspace id'), strArray(repoIds, 'repo ids'), !!hidden),
    'workspace:scanDirectory': ({ root, depth, ignore, includeNested }) =>
      svc.scan({
        root: absPath(root, 'folder'),
        depth: depth === undefined ? undefined : Number(depth),
        ignore: ignore === undefined ? undefined : strArray(ignore, 'ignore globs'),
        includeNested: !!includeNested,
      }),
    'workspace:importCodeWorkspace': ({ filePath }) =>
      svc.importCodeWorkspace(filePath ? absPath(filePath, 'file') : undefined),
    'workspace:exportJson': ({ workspaceId, filePath }) =>
      svc.exportJson(str(workspaceId, 'workspace id'), filePath ? absPath(filePath, 'file') : undefined),
    'workspace:importJson': ({ filePath }) =>
      svc.importJson(filePath ? absPath(filePath, 'file') : undefined),
    'workspace:status': ({ workspaceId, force }) => svc.statusOf(str(workspaceId, 'workspace id'), !!force),
    'workspace:locate': ({ workspaceId, repoId, path: p, force }) =>
      svc.locate(str(workspaceId, 'workspace id'), str(repoId, 'repo id'), absPath(p, 'folder'), !!force),
    'workspace:bulk': (req) => svc.startBulk(bulkRequest(req)),
    'workspace:bulkCancel': ({ bulkId }) => svc.bulk.cancel(str(bulkId, 'bulk id')),
    'workspace:openAll': ({ workspaceId, repoIds }) =>
      svc.openAll(
        str(workspaceId, 'workspace id'),
        repoIds === undefined ? undefined : strArray(repoIds, 'repo ids'),
      ),
    'workspace:branches': ({ workspaceId }) => svc.branches(str(workspaceId, 'workspace id')),
    'workspace:repoDetails': ({ workspaceId, repoId }) =>
      svc.repoDetails(str(workspaceId, 'workspace id'), str(repoId, 'repo id')),
  };
}
