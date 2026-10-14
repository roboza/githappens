import { describe, expect, it } from 'vitest';

import { planPush } from '../src/renderer/src/workspaces/push-plan';
import { nextSort, sortRepos } from '../src/renderer/src/workspaces/repo-sort';
import type { RepoStatusSummary, WorkspaceRepo } from '../src/shared/ipc/workspaces-contract';

const repo = (name: string): WorkspaceRepo => ({ id: name, name, localPath: `/r/${name}`, addedAt: '' });

const st = (id: string, over: Partial<RepoStatusSummary> = {}): RepoStatusSummary => ({
  workspaceRepoId: id,
  exists: true,
  isRepo: true,
  head: { branch: 'main', detached: false, sha: 'a' },
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  wip: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  stashCount: 0,
  ...over,
});

const names = (rs: WorkspaceRepo[]) => rs.map((r) => r.name);

describe('workspace overview sorting', () => {
  it('cycles first direction → other → workspace order', () => {
    expect(nextSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name')).toBeNull();
    // Counts start with the biggest first.
    expect(nextSort({ key: 'name', dir: 'asc' }, 'wip')).toEqual({ key: 'wip', dir: 'desc' });
    expect(nextSort({ key: 'wip', dir: 'desc' }, 'wip')).toEqual({ key: 'wip', dir: 'asc' });
  });

  it('sorts names naturally and case-insensitively', () => {
    const repos = ['web10', 'Api', 'web2', 'api-b'].map(repo);
    expect(names(sortRepos(repos, new Map(), { key: 'name', dir: 'asc' }))).toEqual([
      'Api',
      'api-b',
      'web2',
      'web10',
    ]);
    expect(sortRepos(repos, new Map(), null)).toBe(repos);
  });

  it('keeps repos without a value last in both directions and ties in workspace order', () => {
    const repos = ['missing', 'a', 'b', 'c', 'noStatus'].map(repo);
    const statuses = new Map([
      ['missing', st('missing', { exists: false, isRepo: false })],
      ['a', st('a', { wip: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 } })],
      ['b', st('b', { wip: { staged: 0, unstaged: 3, untracked: 0, conflicted: 0 } })],
      ['c', st('c', { wip: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 } })],
    ]);
    expect(names(sortRepos(repos, statuses, { key: 'wip', dir: 'desc' }))).toEqual([
      'b',
      'a',
      'c',
      'missing',
      'noStatus',
    ]);
    expect(names(sortRepos(repos, statuses, { key: 'wip', dir: 'asc' }))).toEqual([
      'a',
      'c',
      'b',
      'missing',
      'noStatus',
    ]);
  });

  it('sorts status by urgency and ↑↓ by behind, then ahead', () => {
    const repos = ['clean', 'ahead', 'dirty', 'merging', 'behind'].map(repo);
    const statuses = new Map([
      ['clean', st('clean')],
      ['ahead', st('ahead', { ahead: 3 })],
      ['dirty', st('dirty', { wip: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } })],
      ['merging', st('merging', { operationInProgress: 'merge' })],
      ['behind', st('behind', { behind: 1, ahead: 1 })],
    ]);
    expect(names(sortRepos(repos, statuses, { key: 'status', dir: 'asc' }))).toEqual([
      'merging',
      'dirty',
      'behind',
      'ahead',
      'clean',
    ]);
    expect(names(sortRepos(repos, statuses, { key: 'sync', dir: 'desc' }))).toEqual([
      'behind',
      'ahead',
      'clean',
      'dirty',
      'merging',
    ]);
  });
});

describe('bulk push plan', () => {
  it('lists the branches a push will send and counts the rest as skipped', () => {
    const repos = ['ahead', 'behind', 'clean', 'new', 'detached'].map(repo);
    const statuses = new Map([
      ['ahead', st('ahead', { ahead: 2 })],
      ['behind', st('behind', { ahead: 1, behind: 1 })],
      ['clean', st('clean')],
      ['new', st('new', { upstream: undefined, head: { branch: 'feat', detached: false, sha: 'a' } })],
      ['detached', st('detached', { head: { detached: true, sha: 'a' }, ahead: 1 })],
    ]);
    expect(planPush(repos, statuses, false)).toEqual({
      items: [{ repo: repos[0], branch: 'main', target: 'origin/main', commits: 2 }],
      skipped: 4,
    });
    expect(planPush(repos, statuses, true).items.map((i) => [i.repo.name, i.target, i.commits])).toEqual([
      ['ahead', 'origin/main', 2],
      ['new', 'origin/feat', null],
    ]);
  });
});
