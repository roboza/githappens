import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as CommandsModule from '../src/renderer/src/commands';
import type * as SessionsModule from '../src/renderer/src/repo/sessions';
import type * as TabsModule from '../src/renderer/src/stores/tabs';

/**
 * Palette argument providers and the new commands (spec 01 §4.8, spec 12 §4.8). The renderer modules
 * are imported against a stubbed `window.api`.
 */

const replies: Record<string, unknown> = {
  'profiles:list': {
    profiles: [
      { id: 'p1', name: 'Work', authorEmail: 'me@work.example' },
      { id: 'p2', name: 'Home', authorEmail: '' },
    ],
    activeId: 'p1',
    defaultId: 'p1',
  },
  'themes:list': [
    { id: 'builtin:dark', name: 'Dark', scheme: 'dark', source: 'builtin', preview: [] },
    { id: 'user:mine', name: 'Mine', scheme: 'light', source: 'user', preview: [] },
    { id: 'user:broken', name: 'Broken', scheme: 'light', source: 'user', preview: [], errors: [{}] },
  ],
  'git:worktrees': [
    {
      path: '/r/app',
      head: 'a',
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      isMain: true,
      isCurrent: true,
    },
    {
      path: '/r/app-x',
      head: 'b',
      branch: 'refs/heads/x',
      detached: false,
      bare: false,
      isMain: false,
      isCurrent: false,
    },
  ],
  'files:list': ['src/App.tsx', 'src/main.ts', 'README.md'],
  'repos:list': [
    { path: '/fav/one', name: 'one', favorite: true, groupIds: [] },
    { path: '/rec/two', name: 'two', favorite: false, groupIds: [] },
  ],
};
const invoke = vi.fn(async (channel: string) => ({ ok: true, data: replies[channel] }));

let commands: typeof CommandsModule;
let dispose: () => void;
let tabs: typeof TabsModule;
let sessions: typeof SessionsModule;

beforeAll(async () => {
  vi.stubGlobal('window', {
    api: { invoke, on: () => () => undefined, platform: 'linux', git: { invoke, on: () => () => undefined } },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
  commands = await import('../src/renderer/src/commands');
  tabs = await import('../src/renderer/src/stores/tabs');
  sessions = await import('../src/renderer/src/repo/sessions');
  const { installAppCommands } = await import('../src/renderer/src/commands/app-commands');
  dispose = installAppCommands(new QueryClient(), {
    openPreferences: () => undefined,
    openRepo: () => undefined,
    openClone: () => undefined,
    openInit: () => undefined,
  });
  // An open repo tab with a ready session.
  tabs.useTabsStore
    .getState()
    .hydrate({ tabs: [{ id: 't', kind: 'repo', repoPath: '/r/app' }], activeTabId: 't' });
  sessions.useSessionStore.setState({
    byPath: {
      '/r/app': { state: 'ready', repoId: 'R1', info: { head: { kind: 'branch', name: 'main' } } as never },
    },
  });
});

afterAll(() => dispose?.());

describe('spec 01 §4.8 command table', () => {
  it('registers every command of the table', () => {
    const ids = new Set(commands.getCommands().map((c) => c.id));
    const required = [
      'repo.closeTab',
      'repo.open',
      'repo.openInFileManager',
      'repo.openInIde',
      'repo.openInExternalEditor',
      'repo.openExternalDiff',
      'repo.openInTerminal',
      'repoMgmt.clone',
      'repoMgmt.init',
      'repoMgmt.show',
      'repo.maintenance',
      'gitflow.configure',
      'lfs.configure',
      'lfs.init',
      'signing.configure',
      'theme.light',
      'theme.dark',
      'theme.select',
      'account.manage',
      'prefs.open',
      'profile.switch',
      'view.toggleLeftPanel',
      'view.toggleRightPanel',
      'view.toggleSyntaxHighlighting',
      'view.toggleTheme',
      'view.toggleTerminal',
      'view.fullscreen',
      'view.closeCurrent',
      'history.blame',
      'history.file',
      'history.searchCommits',
      'core.undo',
      'core.redo',
      'file.create',
      'file.delete',
      'file.open',
      'file.view',
      'file.edit',
      'wip.discardAll',
      'wip.stageAll',
      'wip.unstageAll',
      'stash.create',
      'stash.apply',
      'stash.pop',
      'branch.create',
      'branch.rename',
      'tag.create',
      'tag.createAnnotated',
      'remote.fetchAll',
      'remote.pull',
      'remote.push',
      'pr.start',
      'wip.view',
      'branch.checkout',
      'patch.createFromWip',
      'patch.apply',
      'logs.open',
      'app.releaseNotes',
      'worktree.open',
      'worktree.create',
      'finder.files',
      'terminal.newTab',
      'ai.commitMessage',
      'favorite.open.1',
      'favorite.open.9',
    ];
    expect(required.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('computes context and enablement', () => {
    const ctx = commands.getContext();
    expect(ctx.activeRepo).toBe('R1');
    expect(ctx.lfsEnabled).toBe(false);
    expect(ctx.gitflowEnabled).toBe(false);
    const lfsInit = commands.getCommand('lfs.init')!;
    expect(commands.isCommandEnabled(lfsInit, ctx)).toBe(true);
    expect(commands.isCommandEnabled(lfsInit, { ...ctx, lfsEnabled: true })).toBe(false);
    expect(commands.disabledReason(commands.getCommand('pr.start')!, { ...ctx, hasRemotes: false })).toBe(
      'No remotes',
    );
  });
});

describe('argument providers', () => {
  it('profiles', async () => {
    expect(await commands.fetchArgItems('profile', '')).toEqual([
      { id: 'p1', label: 'Work', detail: 'current', icon: 'profile' },
      { id: 'p2', label: 'Home', detail: undefined, icon: 'profile' },
    ]);
    expect(commands.acceptsFreeText('profile')).toBe(false);
  });

  it('themes (broken themes hidden)', async () => {
    const items = await commands.fetchArgItems('theme', '');
    expect(items.map((i) => [i.id, i.detail])).toEqual([
      ['builtin:dark', 'dark'],
      ['user:mine', 'light · custom'],
    ]);
  });

  it('worktrees', async () => {
    const items = await commands.fetchArgItems('worktree', '');
    expect(items.map((i) => [i.id, i.label])).toEqual([
      ['/r/app', 'main'],
      ['/r/app-x', 'x'],
    ]);
  });

  it('files: fuzzy-ranked by the finder (no free text, no second filtering)', async () => {
    const items = await commands.fetchArgItems('file', 'app');
    expect(items[0]).toEqual({ id: 'src/App.tsx', label: 'src/App.tsx', icon: 'file' });
    expect(items.map((i) => i.id)).not.toContain('src/main.ts');
    expect(commands.getArgProvider('file')!.filter).toBe('none');
    expect(commands.acceptsFreeText('file')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('files:list', { repoId: 'R1' });
  });

  it('the # prefix opens files with file.open', () => {
    expect(commands.parsePrefix('#app')).toMatchObject({
      mode: { kind: 'file', commandId: 'file.open' },
      rest: 'app',
    });
  });

  it('favorite.open.N opens the Nth favorite', async () => {
    const openRepo = vi.spyOn(tabs.useTabsStore.getState(), 'openRepo').mockResolvedValue(true);
    tabs.useTabsStore.setState({ openRepo });
    expect(await commands.runCommand('favorite.open.1')).toBe('ran');
    await vi.waitFor(() => expect(openRepo).toHaveBeenCalledWith('/fav/one'));
  });
});
