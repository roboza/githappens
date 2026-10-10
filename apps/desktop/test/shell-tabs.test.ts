import type { RefInfo } from '@githappens/git/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type * as TabsModule from '../src/renderer/src/stores/tabs';
import type { TabDescriptor } from '../src/shared/ipc/shell-contract';
import { shortcutRows } from '../src/renderer/src/shell/shortcuts-model';
import { branchSwitcherItems, repoSwitcherItems } from '../src/renderer/src/shell/switcher-model';
import {
  arrangeTabs,
  closeTargets,
  hiddenTabIds,
  nextZoneIndex,
  tabLabel,
  worktreeGroupKey,
} from '../src/renderer/src/shell/tab-model';

const repo = (id: string, repoPath: string, extra: Partial<TabDescriptor> = {}): TabDescriptor => ({
  id,
  kind: 'repo',
  repoPath,
  ...extra,
});

describe('tab model (spec 01 §4.2)', () => {
  it('labels: alias, folder name, special tabs', () => {
    expect(tabLabel(repo('a', 'C:\\Code\\githappens\\'))).toBe('githappens');
    expect(tabLabel(repo('a', '/home/me/app', { alias: '  Fork  ' }))).toBe('Fork');
    expect(tabLabel(repo('a', '/home/me/app', { alias: '   ' }))).toBe('app');
    expect(tabLabel({ id: 'l', kind: 'launchpad' })).toBe('Launchpad');
    expect(tabLabel({ id: 'n', kind: 'newTab' })).toBe('New Tab');
  });

  it('groups worktrees of one repository next to each other', () => {
    const tabs: TabDescriptor[] = [
      { id: 'lp', kind: 'launchpad' },
      repo('main', 'C:\\src\\app'),
      repo('other', 'C:\\src\\lib'),
      repo('wt1', 'C:\\src\\app-feature', { worktreeOf: 'C:/src/app/.git' }),
      { id: 'new', kind: 'newTab' },
      repo('wt2', 'C:\\src\\app-fix', { worktreeOf: 'c:\\src\\app\\.git\\' }),
    ];
    expect(worktreeGroupKey(tabs[1]!)).toBe(worktreeGroupKey(tabs[3]!));
    const views = arrangeTabs(tabs, true);
    expect(views.map((v) => v.tab.id)).toEqual(['lp', 'main', 'wt1', 'wt2', 'other', 'new']);
    expect(views.map((v) => v.group?.position ?? '-')).toEqual(['-', 'first', 'middle', 'last', '-', '-']);
    expect(views[1]!.group!.size).toBe(3);
    // Grouping off: store order, no brackets.
    expect(arrangeTabs(tabs, false).map((v) => [v.tab.id, v.group])).toEqual(
      tabs.map((t) => [t.id, undefined]),
    );
    // A lone repo is never a group.
    expect(arrangeTabs([repo('x', '/a')], true)[0]!.group).toBeUndefined();
  });

  it('computes close-others / close-to-the-right targets, never the pinned Launchpad', () => {
    const tabs: TabDescriptor[] = [
      { id: 'lp', kind: 'launchpad' },
      repo('a', '/a'),
      repo('b', '/b'),
      repo('c', '/c'),
    ];
    expect(closeTargets(tabs, 'b', 'others')).toEqual(['a', 'c']);
    expect(closeTargets(tabs, 'a', 'right')).toEqual(['b', 'c']);
    expect(closeTargets(tabs, 'c', 'right')).toEqual([]);
    expect(closeTargets(tabs, 'zzz', 'others')).toEqual([]);
  });

  it('finds tabs outside the visible strip (overflow dropdown)', () => {
    const items = [
      { id: 'a', left: -50, right: 70 },
      { id: 'b', left: 70, right: 190 },
      { id: 'c', left: 190, right: 310 },
      { id: 'd', left: 310, right: 430 },
    ];
    expect(hiddenTabIds(items, { left: 0, right: 320 })).toEqual(['a', 'd']);
    expect(hiddenTabIds(items.slice(1, 3), { left: 0, right: 320 })).toEqual([]);
  });

  it('cycles focus zones with F6 / Shift+F6', () => {
    expect(nextZoneIndex(-1, 4, 1)).toBe(0);
    expect(nextZoneIndex(-1, 4, -1)).toBe(3);
    expect(nextZoneIndex(3, 4, 1)).toBe(0);
    expect(nextZoneIndex(0, 4, -1)).toBe(3);
    expect(nextZoneIndex(0, 0, 1)).toBe(-1);
  });
});

describe('breadcrumb switchers (spec 01 §4.4)', () => {
  it('repo switcher: open tabs, then favorites, then recents, without duplicates or missing repos', () => {
    const items = repoSwitcherItems([repo('t1', 'C:\\r\\app'), { id: 'n', kind: 'newTab' }], 't1', [
      { path: 'c:/r/app', name: 'app', favorite: true },
      { path: '/r/fav', name: 'fav', favorite: true },
      { path: '/r/old', name: 'old', alias: 'Old one', favorite: false },
      { path: '/r/gone', name: 'gone', favorite: false, missing: true },
    ]);
    expect(items.map((i) => [i.id, i.label, i.group, !!i.current])).toEqual([
      ['tab:t1', 'app', 'Open tabs', true],
      ['path:/r/fav', 'fav', 'Favorites', false],
      ['path:/r/old', 'Old one', 'Recent', false],
    ]);
  });

  it('branch switcher: locals (current marked, ahead/behind) then remotes without a local twin', () => {
    const ref = (p: Partial<RefInfo> & Pick<RefInfo, 'fullName' | 'shortName' | 'type'>): RefInfo =>
      ({ sha: 'a'.repeat(40), isHead: false, ...p }) as RefInfo;
    const items = branchSwitcherItems([
      ref({
        fullName: 'refs/heads/main',
        shortName: 'main',
        type: 'local',
        isHead: true,
        upstream: { fullName: 'refs/remotes/origin/main', ahead: 2, behind: 1, gone: false },
      } as Partial<RefInfo> as RefInfo),
      ref({ fullName: 'refs/heads/feat', shortName: 'feat', type: 'local' }),
      ref({ fullName: 'refs/remotes/origin/main', shortName: 'origin/main', type: 'remote' }),
      ref({ fullName: 'refs/remotes/origin/HEAD', shortName: 'origin/HEAD', type: 'remote' }),
      ref({ fullName: 'refs/remotes/origin/wip', shortName: 'origin/wip', type: 'remote' }),
      ref({ fullName: 'refs/tags/v1', shortName: 'v1', type: 'tag' }),
    ]);
    expect(items.map((i) => [i.label, i.group, !!i.current, i.detail])).toEqual([
      ['main', 'Local', true, '↑2 ↓1'],
      ['feat', 'Local', false, undefined],
      ['origin/wip', 'Remote', false, undefined],
    ]);
  });
});

describe('shortcuts overlay rows', () => {
  it('groups effective bindings by category and filters', () => {
    const rows = shortcutRows(
      [
        { id: 'tab.new', title: 'New Tab', category: 'Repo' },
        { id: 'view.zoomIn', title: 'Zoom In', category: 'View' },
        { id: 'unbound', title: 'Unbound', category: 'View' },
      ],
      [
        { command: 'tab.new', key: 'ctrl+t' },
        { command: 'view.zoomIn', key: 'ctrl+=' },
        { command: 'view.zoomIn', key: 'ctrl+numpadadd' },
      ],
      '',
      (k) => k.toUpperCase(),
    );
    expect(rows).toEqual([
      { category: 'Repo', rows: [{ id: 'tab.new', title: 'New Tab', keys: ['CTRL+T'] }] },
      {
        category: 'View',
        rows: [{ id: 'view.zoomIn', title: 'Zoom In', keys: ['CTRL+=', 'CTRL+NUMPADADD'] }],
      },
    ]);
    expect(
      shortcutRows(
        [{ id: 'tab.new', title: 'New Tab', category: 'Repo' }],
        [{ command: 'tab.new', key: 'ctrl+t' }],
        'zoom',
        String,
      ),
    ).toEqual([]);
  });
});

describe('tabs store: alias, close many, duplicate, relocate', () => {
  const invoke = vi.fn(async (channel: string, req: unknown): Promise<unknown> => {
    if (channel === 'repos:open') {
      const p = (req as { path: string }).path;
      return {
        ok: true,
        data: { ok: true, repo: { path: p, name: 'moved', isBare: false, favorite: false, groupIds: [] } },
      };
    }
    return { ok: true, data: undefined };
  });
  let store: typeof TabsModule;

  beforeAll(async () => {
    vi.stubGlobal('window', { api: { invoke, on: () => () => undefined, platform: 'linux' } });
    store = await import('../src/renderer/src/stores/tabs');
  });

  it('sets and removes aliases (persisting repo aliases), closes several tabs, duplicates', async () => {
    const s = store.useTabsStore;
    s.getState().hydrate({
      tabs: [repo('a', '/a'), repo('b', '/b'), repo('c', '/c')],
      activeTabId: 'b',
    });
    s.getState().setAlias('a', '  Work  ');
    expect(s.getState().tabs.find((t) => t.id === 'a')!.alias).toBe('Work');
    expect(invoke).toHaveBeenCalledWith('repos:setAlias', { path: '/a', alias: 'Work' });
    s.getState().setAlias('a', '');
    expect('alias' in s.getState().tabs.find((t) => t.id === 'a')!).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith('repos:setAlias', { path: '/a', alias: null });

    const dup = s.getState().duplicate('a')!;
    expect(s.getState().tabs.map((t) => t.id)).toEqual(['launchpad', 'a', dup, 'b', 'c']);
    expect(s.getState().activeTabId).toBe(dup);

    s.getState().closeMany([dup, 'b', 'launchpad']);
    expect(s.getState().tabs.map((t) => t.id)).toEqual(['launchpad', 'a', 'c']);
    expect(s.getState().activeTabId).toBe('a');

    s.getState().closeMany(['a', 'c']);
    const left = s.getState().tabs;
    expect(left).toHaveLength(2);
    expect(left[1]!.kind).toBe('newTab');
  });

  it('relocates a missing repository tab', async () => {
    const s = store.useTabsStore;
    s.getState().hydrate({ tabs: [repo('m', '/old', { alias: 'Keep' })], activeTabId: 'm' });
    expect(await s.getState().relocate('m', '/new')).toBe(true);
    expect(s.getState().tabs.find((t) => t.id === 'm')).toMatchObject({ repoPath: '/new', alias: 'Keep' });
  });
});
