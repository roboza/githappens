import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ItemUserState, SavedView } from '@githappens/launchpad';
import type { ConnectedIntegration } from '@githappens/providers/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  integrationsListSource,
  isSyncablePreference,
  keybindingsSource,
  launchpadSource,
  mergeSyncedWorkspaces,
  preferencesSource,
  sanitizeRemoteUrl,
  serializeWorkspace,
  SYNCABLE_PREFERENCE_KEYS,
  themesSource,
  workspacesSource,
} from '../src/main/cloud/sync/adapters';
import { SettingsStore } from '../src/main/settings/settings-store';
import type { ReconnectHint } from '../src/shared/ipc/cloud-contract';
import type { Workspace } from '../src/shared/ipc/workspaces-contract';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sync-adapters-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function settingsStore(): SettingsStore {
  const s = new SettingsStore({ dir });
  s.load();
  return s;
}

describe('preferences adapter', () => {
  it('never syncs paths, commands, keys, proxies or the cloud/sync settings themselves', () => {
    for (const k of [
      'ssh.privateKeyPath',
      'ssh.publicKeyPath',
      'terminal.shell',
      'terminal.shellArgs',
      'tools.editorPath',
      'tools.customMergeCmd',
      'signing.signingKey',
      'network.proxyUrl',
      'network.caBundlePath',
      'git.executable',
      'general.defaultCloneDirectory',
      'cloud.serverUrl',
      'sync.enabled',
      'sync.themes',
      'team.footprints',
      'updates.channel',
      'ai.consent',
    ]) {
      expect(isSyncablePreference(k), k).toBe(false);
    }
    expect(isSyncablePreference('ui.zoom')).toBe(true);
    expect(SYNCABLE_PREFERENCE_KEYS).toContain('editor.tabSize');
  });

  it('reads sparse non-default values and applies a synced record (missing = default)', async () => {
    const s = settingsStore();
    s.set('ui.zoom', 1.25);
    s.set('ssh.privateKeyPath', '/home/me/.ssh/id_ed25519');
    s.set('network.proxyUrl', 'http://secret-proxy.corp:8080');
    s.set('terminal.shell', '/bin/zsh');
    s.set('sync.enabled', true);
    const src = preferencesSource(s);
    const data = await src.read();
    expect(data).toEqual({ 'ui.zoom': 1.25 });
    expect(JSON.stringify(data)).not.toMatch(/ssh|secret|zsh/);

    const changed = vi.fn();
    const off = src.onChange(changed);
    await src.write({ 'editor.tabSize': 2, 'ssh.privateKeyPath': '/evil', 'ui.zoom': 'not-a-number' });
    expect(s.get('editor.tabSize')).toBe(2);
    expect(s.get('ui.zoom')).toBe(1.25); // invalid synced value ignored
    expect(s.get('ssh.privateKeyPath')).toBe('/home/me/.ssh/id_ed25519');
    await src.write({});
    expect(s.get('editor.tabSize')).toBe(4); // back to default
    expect(s.get('ui.zoom')).toBe(1);
    expect(changed).toHaveBeenCalled();
    off();
    changed.mockClear();
    s.set('ssh.useLocalAgent', false);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('keybindings adapter', () => {
  it('groups overrides by command and writes them back', async () => {
    const s = settingsStore();
    s.writeKeybindings([
      { command: 'a', key: 'ctrl+a' },
      { command: 'a', key: 'ctrl+shift+a', when: 'textInputFocus' },
      { command: 'b', key: '' },
    ]);
    const applied = vi.fn();
    const src = keybindingsSource(s, applied);
    expect(await src.read()).toEqual({
      a: [
        { command: 'a', key: 'ctrl+a' },
        { command: 'a', key: 'ctrl+shift+a', when: 'textInputFocus' },
      ],
      b: [{ command: 'b', key: '' }],
    });
    const changed = vi.fn();
    src.onChange(changed);
    await src.write({ c: [{ command: 'c', key: 'ctrl+k' }] });
    expect(s.readKeybindings()).toEqual([{ command: 'c', key: 'ctrl+k' }]);
    expect(applied).toHaveBeenCalledWith([{ command: 'c', key: 'ctrl+k' }]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('themes adapter', () => {
  it('syncs *.jsonc files and keeps a copy of themes deleted elsewhere', async () => {
    const tdir = path.join(dir, 'themes');
    fs.mkdirSync(tdir);
    fs.writeFileSync(path.join(tdir, 'mine.jsonc'), '{"name":"Mine"}');
    fs.writeFileSync(path.join(tdir, 'dark.jsonc-default'), 'template');
    const src = themesSource(tdir);
    expect(await src.read()).toEqual({ 'mine.jsonc': '{"name":"Mine"}' });
    await src.write({ 'other.jsonc': '{"name":"Other"}', '../escape.jsonc': 'x' });
    expect(fs.readdirSync(tdir).sort()).toEqual(['dark.jsonc-default', 'mine.jsonc-removed', 'other.jsonc']);
  });
});

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w1',
  kind: 'local',
  name: 'Work',
  order: 0,
  hidden: false,
  repos: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

describe('workspaces adapter', () => {
  it('strips local paths, clone roots and credentials from remotes', () => {
    expect(sanitizeRemoteUrl('https://me:ghp_secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('ssh://git@host:22/o/r.git')).toBe('ssh://git@host:22/o/r.git');
    expect(sanitizeRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(sanitizeRemoteUrl('C:\\repos\\r')).toBeUndefined();
    expect(sanitizeRemoteUrl('/srv/git/r.git')).toBeUndefined();
    expect(sanitizeRemoteUrl('file:///srv/r')).toBeUndefined();

    const doc = serializeWorkspace(
      ws({
        defaultCloneRoot: 'C:\\code',
        repos: [
          {
            id: 'r1',
            name: 'r',
            localPath: 'C:\\code\\r',
            remoteUrl: 'https://me:tok@github.com/o/r.git',
            addedAt: 'x',
          },
        ],
      }),
    );
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/code|tok|updatedAt/);
    expect(doc).toMatchObject({ id: 'w1', repos: [{ id: 'r1', remoteUrl: 'https://github.com/o/r.git' }] });
  });

  it('merging keeps local paths of repos that exist here (by id, provider or remote)', () => {
    const provider = {
      integrationKey: 'github:github.com:1',
      owner: 'o',
      name: 'p',
      cloneUrlHttps: 'https://github.com/o/p.git',
      cloneUrlSsh: '',
      webUrl: '',
    };
    const local = [
      ws({
        defaultCloneRoot: '/code',
        repos: [
          { id: 'r1', name: 'r', localPath: '/code/r', addedAt: 'x' },
          { id: 'r9', name: 'gone', localPath: '/missing', addedAt: 'x' },
        ],
      }),
      ws({
        id: 'w2',
        repos: [
          { id: 'q', name: 'p', localPath: '/code/p', provider, addedAt: 'x' },
          { id: 'z', name: 'z', localPath: '/code/z', remoteUrl: 'git@github.com:o/z.git', addedAt: 'x' },
        ],
      }),
    ];
    const synced = {
      w1: {
        id: 'w1',
        name: 'Renamed',
        order: 0,
        hidden: false,
        createdAt: 'c',
        repos: [{ id: 'r1', name: 'r', addedAt: 'x' }],
      },
      w3: {
        id: 'w3',
        name: 'New',
        order: 1,
        hidden: false,
        createdAt: 'c',
        repos: [
          { id: 'n1', name: 'p', provider, addedAt: 'x' },
          { id: 'n2', name: 'z', remoteUrl: 'https://github.com/o/z', addedAt: 'x' },
          { id: 'n3', name: 'other', remoteUrl: 'https://github.com/o/other', addedAt: 'x' },
          { id: 'n4', name: 'gone', addedAt: 'x' },
        ],
      },
    };
    const exists = (p: string): boolean => p !== '/missing';
    const out = mergeSyncedWorkspaces(synced, local, exists, 'now');
    expect(out.map((w) => w.id)).toEqual(['w1', 'w3']);
    expect(out[0]).toMatchObject({
      name: 'Renamed',
      defaultCloneRoot: '/code',
      repos: [{ localPath: '/code/r' }],
    });
    expect(out[1]!.repos.map((r) => r.localPath)).toEqual(['/code/p', '/code/z', undefined, undefined]);
  });

  it('only syncs local workspaces and replaces them on write', async () => {
    const list: Workspace[] = [
      ws({}),
      ws({
        id: 'd',
        kind: 'directory',
        directory: { root: '/x', depth: 1, includeNested: false, ignore: [] },
      }),
    ];
    const replace = vi.fn();
    const src = workspacesSource(
      { list: () => list, replaceLocalWorkspaces: replace, onDidChange: () => () => undefined },
      () => true,
    );
    expect(Object.keys(await src.read())).toEqual(['w1']);
    await src.write({ w1: serializeWorkspace(list[0]!) });
    expect(replace).not.toHaveBeenCalled(); // unchanged
    await src.write({});
    expect(replace).toHaveBeenCalledWith([]);
  });
});

describe('launchpad adapter', () => {
  it('syncs pins, snoozes and saved views without machine-local lastSeenAt', async () => {
    const view: SavedView = {
      id: 'v1',
      name: 'Mine',
      tab: 'prs',
      groupBy: 'status' as SavedView['groupBy'],
      filters: { scope: { kind: 'all' }, mode: 'personal' } as SavedView['filters'],
    };
    let state = {
      itemStates: {
        u1: { uid: 'u1', pinnedAt: 'p', lastSeenAt: 'seen' },
        u2: { uid: 'u2', lastSeenAt: 'seen' },
      } as Record<string, ItemUserState>,
      savedViews: [view],
    };
    const apply = vi.fn((itemStates: Record<string, ItemUserState>, savedViews: SavedView[]) => {
      state = { itemStates, savedViews };
    });
    const src = launchpadSource(
      { userState: () => state, applyUserState: apply, onUserStateChange: () => () => undefined },
      () => 'now',
    );
    const data = await src.read();
    expect(data).toEqual({ 's:u1': { uid: 'u1', pinnedAt: 'p' }, 'v:v1': view });
    await src.write(data);
    expect(apply).not.toHaveBeenCalled();
    await src.write({
      's:u1': { uid: 'u1', pinnedAt: 'p' },
      's:u3': { uid: 'u3', snooze: { snoozedAt: 's', indefinite: true } },
    });
    expect(state.itemStates).toEqual({
      u1: { uid: 'u1', pinnedAt: 'p', lastSeenAt: 'seen' },
      u3: { uid: 'u3', snooze: { snoozedAt: 's', indefinite: true }, lastSeenAt: 'now' },
    });
    expect(state.savedViews).toEqual([]);
  });
});

describe('integrations list adapter', () => {
  it('syncs kind/host/login only and turns unknown accounts into reconnect hints', async () => {
    const accounts: ConnectedIntegration[] = [
      {
        kind: 'github',
        host: 'github.com',
        accountId: '1',
        key: 'github:github.com:1',
        login: 'ada',
        authType: 'oauth',
        scopes: ['repo'],
        connectedAt: 1,
        avatarUrl: 'https://a',
      },
    ];
    let hints: ReconnectHint[] = [];
    const src = integrationsListSource(
      { list: () => accounts, onDidChange: () => () => undefined },
      { get: () => hints, set: (h) => (hints = h) },
    );
    expect(await src.read()).toEqual({
      'github|github.com|ada': { kind: 'github', host: 'github.com', login: 'ada' },
    });
    await src.write({
      'github|github.com|ada': { kind: 'github', host: 'github.com', login: 'ada' },
      'gitlab|gitlab.com|ada': { kind: 'gitlab', host: 'gitlab.com', login: 'ada', token: 'nope' },
    });
    expect(hints).toEqual([
      { key: 'gitlab|gitlab.com|ada', kind: 'gitlab', host: 'gitlab.com', login: 'ada' },
    ]);
    // Hints stay in the synced list until dismissed.
    expect(Object.keys(await src.read()).sort()).toEqual(['github|github.com|ada', 'gitlab|gitlab.com|ada']);
  });
});
