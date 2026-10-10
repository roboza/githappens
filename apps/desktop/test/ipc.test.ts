import { GitError, makeError, type GitExecutableInfo } from '@githappens/git';
import { describe, expect, it, vi } from 'vitest';

import { createHandlers } from '../src/main/ipc/handlers';
import {
  createBroadcaster,
  registerIpcHandlers,
  type IpcHandlers,
  type IpcMainLike,
} from '../src/main/ipc/registry';
import { EVENT_CHANNELS, INVOKE_CHANNELS, isEventChannel, isInvokeChannel } from '../src/shared/ipc/contract';
import { PREFS_INVOKE_CHANNELS } from '../src/shared/ipc/prefs-contract';
import { createAgentsHandlers } from '../src/main/ipc/agents-handlers';
import { createGitflowHandlers } from '../src/main/ipc/gitflow-handlers';
import { createAiHandlers } from '../src/main/ipc/ai-handlers';
import { createCloudHandlers } from '../src/main/ipc/cloud-handlers';
import { createConflictsHandlers } from '../src/main/ipc/conflicts-handlers';
import { createPatchesHandlers } from '../src/main/ipc/patches-handlers';
import { createNetworkHandlers } from '../src/main/ipc/network-handlers';
import { createToolsHandlers } from '../src/main/ipc/tools-handlers';
import { createGraphHandlers } from '../src/main/ipc/graph-handlers';
import { createFilesHandlers } from '../src/main/ipc/files-handlers';
import { createRemotesHandlers } from '../src/main/ipc/remotes-handlers';
import { createShell2Handlers } from '../src/main/ipc/shell2-handlers';
import { createCommitHandlers } from '../src/main/ipc/commit-handlers';
import { createSyncHandlers } from '../src/main/ipc/sync-handlers';
import { createUndoHandlers } from '../src/main/ipc/undo-handlers';
import { createRepos2Handlers } from '../src/main/ipc/repos2-handlers';
import { createSuggestHandlers } from '../src/main/ipc/suggest-handlers';
import { createInsightsHandlers } from '../src/main/ipc/insights-handlers';
import { createCloudWorkspacesHandlers } from '../src/main/ipc/cloud-workspaces-handlers';
import { createBehaviourHandlers } from '../src/main/ipc/behaviour-handlers';
import { createOutputHandlers } from '../src/main/ipc/output-handlers';
import { createLaunchpadHandlers } from '../src/main/ipc/launchpad-handlers';
import { createWorkspacesHandlers } from '../src/main/ipc/workspaces-handlers';
import { createIntegrationsHandlers } from '../src/main/ipc/integrations-handlers';
import { createUpdateHandlers } from '../src/main/ipc/update-handlers';
import { createAboutHandlers } from '../src/main/ipc/about-handlers';

type Listener = Parameters<IpcMainLike['handle']>[1];

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const ipc: IpcMainLike = { handle: (c, l) => void handlers.set(c, l) };
  const call = (channel: string, req: unknown = {}, url = 'file:///app/index.html') =>
    handlers.get(channel)!({ sender: { id: 1 }, senderFrame: { url } }, req);
  return { ipc, handlers, call };
}

const info: GitExecutableInfo = {
  kind: 'bundled',
  path: '/g/bin/git',
  version: '2.53.0',
  versionTuple: [2, 53, 0],
  features: {
    worktreeListZ: true,
    statusShowStash: true,
    pathspecFromFile: true,
    forceIfIncludes: true,
    mergeTreeWriteTree: true,
    builtinFsmonitor: false,
    configShowScope: true,
  },
};

function stubHandlers(over: Partial<IpcHandlers> = {}): IpcHandlers {
  const unused = () => {
    throw new Error('not used');
  };
  return Object.fromEntries(INVOKE_CHANNELS.map((c) => [c, over[c] ?? unused])) as unknown as IpcHandlers;
}

describe('IPC contract', () => {
  it('allowlists have no duplicates and channel guards work', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length);
    expect(isInvokeChannel('settings:set')).toBe(true);
    expect(isInvokeChannel('fs:readFile')).toBe(false);
    expect(isEventChannel('git:engine:changed')).toBe(true);
  });

  it('main registers a handler for every invoke channel', () => {
    const { ipc, handlers } = fakeIpcMain();
    registerIpcHandlers(ipc, stubHandlers());
    expect([...handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('the per-area handler factories together cover every channel', () => {
    const h = createHandlers({
      settings: {} as never,
      secrets: {} as never,
      engine: {} as never,
      ptys: {} as never,
      versions: { app: '0', electron: '0', chrome: '0', node: '0' },
    } as never);
    const integrations = createIntegrationsHandlers({} as never, {} as never);
    const updates = createUpdateHandlers({} as never);
    const agents = createAgentsHandlers({
      ptys: { onChange: () => () => {} } as never,
      settings: {} as never,
      broadcast: () => {},
      probe: null,
    });
    const gitflow = createGitflowHandlers({} as never);
    const workspaces = createWorkspacesHandlers({} as never);
    const launchpad = createLaunchpadHandlers({} as never);
    const ai = createAiHandlers({} as never);
    const cloud = createCloudHandlers({} as never);
    const conflicts = createConflictsHandlers({} as never);
    const patches = createPatchesHandlers({} as never);
    const network = createNetworkHandlers({} as never);
    const behaviour = { ...createBehaviourHandlers({} as never), ...createOutputHandlers({} as never) };
    const covered = [
      ...Object.keys(h),
      ...PREFS_INVOKE_CHANNELS,
      ...Object.keys(integrations),
      ...Object.keys(updates),
      ...Object.keys(agents),
      ...Object.keys(gitflow),
      ...Object.keys(workspaces),
      ...Object.keys(launchpad),
      ...Object.keys(ai),
      ...Object.keys(cloud),
      ...Object.keys(conflicts),
      ...Object.keys(patches),
      ...Object.keys(network),
      ...Object.keys(behaviour),
      ...Object.keys(createToolsHandlers({} as never)),
      ...Object.keys(createGraphHandlers({} as never)),
      ...Object.keys(createFilesHandlers({} as never)),
      ...Object.keys(createRemotesHandlers({} as never)),
      ...Object.keys(createShell2Handlers({} as never)),
      ...Object.keys(createCommitHandlers({} as never)),
      ...Object.keys(createSyncHandlers({} as never)),
      ...Object.keys(createUndoHandlers({} as never)),
      ...Object.keys(createRepos2Handlers({} as never)),
      ...Object.keys(createAboutHandlers({} as never)),
      ...Object.keys(createSuggestHandlers({} as never)),
      ...Object.keys(createInsightsHandlers({} as never)),
      ...Object.keys(createCloudWorkspacesHandlers({} as never)),
    ].sort();
    expect(covered).toEqual([...INVOKE_CHANNELS].sort());
  });
});

describe('registerIpcHandlers', () => {
  it('wraps results as { ok: true, data }', async () => {
    const { ipc, call } = fakeIpcMain();
    registerIpcHandlers(ipc, stubHandlers({ 'git:engine:info': () => info }));
    await expect(call('git:engine:info')).resolves.toEqual({ ok: true, data: info });
  });

  it('serializes GitError and plain errors instead of rejecting', async () => {
    const { ipc, call } = fakeIpcMain();
    registerIpcHandlers(
      ipc,
      stubHandlers({
        'git:engine:info': () => {
          throw new GitError(makeError('GitNotFound', { argv: ['--version'] }));
        },
        'settings:set': () => {
          throw new Error('Invalid value for "ui.zoom"');
        },
      }),
    );
    await expect(call('git:engine:info')).resolves.toMatchObject({
      ok: false,
      error: { code: 'GitNotFound' },
    });
    await expect(call('settings:set', { key: 'ui.zoom', value: 9 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'Unknown',
        message: 'Invalid value for "ui.zoom"',
        details: { channel: 'settings:set' },
      },
    });
  });

  it('rejects untrusted senders', async () => {
    const { ipc, call } = fakeIpcMain();
    const handler = vi.fn(() => info);
    registerIpcHandlers(
      ipc,
      stubHandlers({ 'git:engine:info': handler }),
      (url) => !!url?.startsWith('file://'),
    );
    await expect(call('git:engine:info', {}, 'https://evil.example')).resolves.toMatchObject({ ok: false });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createBroadcaster', () => {
  it('sends to live webContents only', () => {
    const live = { isDestroyed: () => false, send: vi.fn() };
    const dead = { isDestroyed: () => true, send: vi.fn() };
    createBroadcaster(() => [live, dead])('git:engine:changed', info);
    expect(live.send).toHaveBeenCalledWith('git:engine:changed', info);
    expect(dead.send).not.toHaveBeenCalled();
  });
});

describe('git:engine:setExecutable handler', () => {
  const settings = { set: vi.fn() };
  const mk = (selected: GitExecutableInfo) =>
    createHandlers({
      settings: settings as never,
      secrets: {} as never,
      engine: { select: vi.fn(async () => selected) } as never,
      versions: { app: '0', electron: '0', chrome: '0', node: '0' },
    });

  it('persists a custom path when it was selected', async () => {
    settings.set.mockClear();
    await mk({ ...info, kind: 'system', path: '/opt/git' })['git:engine:setExecutable'](
      { kind: 'system', path: '/opt/git' },
      { senderId: 1 },
    );
    expect(settings.set).toHaveBeenCalledWith('git.executable', '/opt/git');
  });

  it('does not persist when the locator fell back to bundled', async () => {
    settings.set.mockClear();
    await mk(info)['git:engine:setExecutable']({ kind: 'system' }, { senderId: 1 });
    expect(settings.set).not.toHaveBeenCalled();
  });
});
