import { describe, expect, it } from 'vitest';

import {
  buildGroupViews,
  matchesFilter,
  moveGroup,
  remoteLabel,
  reorderedFavorites,
} from '../src/renderer/src/views/repos/repo-groups';
import type { RepoGroup } from '../src/shared/ipc/repos2-contract';
import { folderFromUrl } from '../src/shared/ipc/repos2-contract';
import type { RepoRecord } from '../src/shared/ipc/shell-contract';

const repo = (name: string, o: Partial<RepoRecord> = {}): RepoRecord => ({
  path: `C:\\src\\${name}`,
  name,
  isBare: false,
  favorite: false,
  groupIds: [],
  ...o,
});

const groups: RepoGroup[] = [
  { id: 'open', kind: 'open', name: 'Open', collapsed: false, order: 0 },
  { id: 'favorites', kind: 'favorites', name: 'Favorites', collapsed: false, order: 1 },
  { id: 'custom:w', kind: 'custom', name: 'Work', collapsed: false, order: 2 },
  { id: 'recent', kind: 'recent', name: 'Recent', collapsed: false, order: 3 },
];

describe('Repository Management model', () => {
  const repos = [
    repo('alpha', { lastOpenedAt: 1, favorite: true, favoriteOrder: 2 }),
    repo('beta', { lastOpenedAt: 3, remoteUrl: 'git@github.com:acme/beta.git', groupIds: ['custom:w'] }),
    repo('gamma', { lastOpenedAt: 2, favorite: true, favoriteOrder: 1 }),
  ];

  it('builds Open / Favorites / custom / Recent groups', () => {
    const v = buildGroupViews(repos, groups, ['c:/src/beta'], '');
    expect(v.map((g) => [g.group.id, g.repos.map((r) => r.name)])).toEqual([
      ['open', ['beta']],
      ['favorites', ['gamma', 'alpha']],
      ['custom:w', ['beta']],
      ['recent', ['beta', 'gamma', 'alpha']],
    ]);
  });

  it('filters by name, path and remote', () => {
    expect(matchesFilter(repos[1]!, 'acme')).toBe(true);
    expect(matchesFilter(repos[1]!, 'bta')).toBe(true);
    expect(
      buildGroupViews(repos, groups, [], 'gamma').find((g) => g.group.id === 'recent')!.repos,
    ).toHaveLength(1);
  });

  it('reorders groups and favorites', () => {
    expect(moveGroup(groups, 'recent', 0).map((g) => [g.id, g.order])).toEqual([
      ['recent', 0],
      ['open', 1],
      ['favorites', 2],
      ['custom:w', 3],
    ]);
    expect(reorderedFavorites(['/a', '/b', '/c'], '/c', '/a')).toEqual(['/c', '/a', '/b']);
    expect(reorderedFavorites(['/a', '/b', '/c'], '/a', null)).toEqual(['/b', '/c', '/a']);
  });

  it('labels remotes and derives folder names', () => {
    expect(remoteLabel('https://github.com/acme/repo.git')).toBe('acme/repo');
    expect(remoteLabel('git@gitlab.com:grp/proj')).toBe('grp/proj');
    expect(remoteLabel(undefined)).toBe('');
    expect(folderFromUrl('git@host:o/repo.git')).toBe('repo');
    expect(folderFromUrl('C:\\src\\thing\\')).toBe('thing');
  });
});
