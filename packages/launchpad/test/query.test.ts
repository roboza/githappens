import { describe, expect, it } from 'vitest';

import { classify } from '../src/classify';
import { dedupeItems, normalizePath, prUid, wipUid } from '../src/ids';
import {
  compactGroups,
  facets,
  filterItems,
  fuzzyIncludes,
  groupItems,
  matchesFilters,
  matchesSearch,
  parseSearch,
  sortItems,
  summarize,
  tabCounts,
  topItems,
} from '../src/query';
import type { ClassifiedItem, LaunchpadFilters, LaunchpadItem } from '../src/types';
import { BOB, ctx, issue, issueIt, mine, NOW, pr, prIt, wip, wipIt } from './fixtures';

const loginPr = prIt(
  pr({
    number: 42,
    title: 'Add login form',
    labels: [{ name: 'feature' }],
    milestone: { id: '1', title: 'v1.0' },
    head: { repo: null, branch: 'feature/ABC-7-login', sha: 'x' },
  }),
);
const jira = issueIt(issue({ sprint: 'Sprint 5', fixVersions: ['2.1'], labels: ['crash'] }));
const ghIssue = issueIt(
  issue({
    key: '#42',
    title: 'Crash in app',
    tracker: {
      kind: 'github',
      integration: { kind: 'github', host: 'github.com', accountId: '1' },
      scope: 'acme/app',
    },
  }),
);
const work = wipIt(wip());

describe('search', () => {
  const cases: Array<[string, LaunchpadItem, boolean]> = [
    ['#42', loginPr, true],
    ['#43', loginPr, false],
    ['#42', ghIssue, true],
    ['#42', jira, false],
    ['ABC-12', jira, true],
    ['abc-12', jira, true],
    ['ABC-1', jira, false],
    ['ABC-7', loginPr, true],
    ['login', loginPr, true],
    ['lgn', loginPr, true],
    ['acme/app', loginPr, true],
    ['alice', loginPr, true],
    ['feature/abc', loginPr, true],
    ['add alice', loginPr, true],
    ['xyz', loginPr, false],
    ['zz', loginPr, false],
    ['', loginPr, true],
    ['crash', jira, true],
    ['app', work, true],
    ['#1', work, false],
  ];
  it.each(cases)('%j matches %#', (q, item, expected) => {
    expect(matchesSearch(item, q)).toBe(expected);
  });

  it('parses query kinds', () => {
    expect(parseSearch(' #12 ')).toEqual({ kind: 'number', n: 12 });
    expect(parseSearch('proj-9')).toEqual({ kind: 'key', key: 'PROJ-9' });
    expect(parseSearch('foo  bar')).toEqual({ kind: 'text', tokens: ['foo', 'bar'] });
    expect(parseSearch('  ')).toEqual({ kind: 'empty' });
  });

  it('fuzzy needs a word start', () => {
    expect(fuzzyIncludes('Refactor graph renderer', 'grr')).toBe(true);
    expect(fuzzyIncludes('Refactor graph renderer', 'aph')).toBe(true); // substring
    expect(fuzzyIncludes('Refactor graph renderer', 'xgr')).toBe(false);
  });
});

describe('filters', () => {
  const f = (p: Partial<LaunchpadFilters>) => p;
  const cases: Array<[string, Partial<LaunchpadFilters>, LaunchpadItem, boolean]> = [
    ['provider kind', f({ providers: ['github'] }), loginPr, true],
    ['provider kind mismatch', f({ providers: ['gitlab'] }), loginPr, false],
    ['provider by integration key', f({ providers: ['github:github.com:1'] }), loginPr, true],
    ['jira provider', f({ providers: ['jira-cloud'] }), jira, true],
    ['repo', f({ repos: ['ACME/app'] }), loginPr, true],
    ['repo mismatch', f({ repos: ['acme/web'] }), loginPr, false],
    ['label (pr)', f({ labels: ['feature'] }), loginPr, true],
    ['label (issue)', f({ labels: ['crash'] }), jira, true],
    ['label excludes wips', f({ labels: ['crash'] }), work, false],
    ['author', f({ authors: ['alice'] }), loginPr, true],
    ['author mismatch', f({ authors: ['bob'] }), loginPr, false],
    ['milestone', f({ milestones: ['v1.0'] }), loginPr, true],
    ['sprint', f({ sprints: ['sprint 5'] }), jira, true],
    ['sprint mismatch', f({ sprints: ['sprint 6'] }), jira, false],
    ['fix version', f({ fixVersions: ['2.1'] }), jira, true],
    ['updated within 7d', f({ updatedWithin: '7d' }), loginPr, true],
    ['updated within 24h', f({ updatedWithin: '24h' }), loginPr, false],
    ['updated any', f({ updatedWithin: 'any' }), loginPr, true],
    ['text', f({ text: '#42' }), loginPr, true],
  ];
  it.each(cases)('%s', (_n, filters, item, expected) => {
    expect(matchesFilters(item, filters, NOW)).toBe(expected);
  });
});

const C = (item: LaunchpadItem, states: Record<string, unknown> = {}): ClassifiedItem =>
  classify(item, ctx({ itemStates: states as never }));

describe('tabs, grouping, summary', () => {
  const review = C(
    prIt(pr({ number: 2, viewer: { reviewRequested: true }, updatedAt: '2026-10-09T09:00:00Z' })),
  );
  const review2 = C(
    prIt(pr({ number: 3, viewer: { reviewRequested: true }, updatedAt: '2026-10-09T10:00:00Z' })),
  );
  const blocked = C(prIt(mine({ number: 4, mergeable: 'conflicting' })));
  const ready = C(prIt(mine({ number: 5, mergeable: 'mergeable', checksRollup: 'success' })));
  const lonely = C(prIt(mine({ number: 6 })));
  const waiting = C(prIt(mine({ number: 7, reviewers: [{ user: BOB, state: 'pending' }] })));
  const snoozedUid = prUid(pr({ number: 8, viewer: { reviewRequested: true } }));
  const snoozed = C(prIt(pr({ number: 8, viewer: { reviewRequested: true } })), {
    [snoozedUid]: { uid: snoozedUid, snooze: { indefinite: true, snoozedAt: '2026-10-01T00:00:00Z' } },
  });
  const pinUid = prUid(pr({ number: 9 }));
  const pinned = C(prIt(pr({ number: 9 })), { [pinUid]: { uid: pinUid, pinnedAt: '2026-10-05T00:00:00Z' } });
  const iss = C(jira);
  const w = C(work);
  const all = [review, review2, blocked, ready, lonely, waiting, snoozed, pinned, iss, w];

  it('counts tabs (snoozed separate)', () => {
    expect(tabCounts(all)).toEqual({ prs: 7, issues: 1, wips: 1, all: 9, snoozed: 1 });
  });

  it.each([
    ['prs', 7],
    ['issues', 1],
    ['wips', 1],
    ['all', 9],
    ['snoozed', 1],
  ] as const)('filters tab %s', (tab, n) => {
    expect(filterItems(all, {}, tab, NOW)).toHaveLength(n);
  });

  it('groups by status in display order and sorts by recency', () => {
    const groups = groupItems(filterItems(all, {}, 'all', NOW));
    expect(groups.map((g) => g.group)).toEqual([
      'pinned',
      'needs-review',
      'blocked',
      'ready-to-merge',
      'waiting-for-review',
      'todo',
      'wip',
    ]);
    expect(groups[1]!.items.map((i) => (i.type === 'pr' ? i.pr.number : 0))).toEqual([3, 2]);
  });

  it('groups by repo and provider, keeping pinned on top', () => {
    const byRepo = groupItems(filterItems(all, {}, 'all', NOW), 'repo');
    expect(byRepo[0]!.group).toBe('pinned');
    expect(byRepo.map((g) => g.label)).toContain('acme/app');
    const byProvider = groupItems(filterItems(all, {}, 'all', NOW), 'provider');
    expect(byProvider.map((g) => g.label)).toEqual(['Pinned', 'GitHub', 'Jira', 'Local']);
    expect(groupItems(filterItems(all, {}, 'all', NOW), 'none').map((g) => g.group)).toEqual([
      'pinned',
      'all',
    ]);
  });

  it('summarizes counts from status groups (pinned still counted, snoozed not)', () => {
    expect(summarize(all)).toEqual({
      needsReview: 2,
      readyToMerge: 1,
      blocked: 1,
      noReviewers: 1,
      conflicts: 1,
    });
    expect(summarize([], true).partial).toBe(true);
  });

  it('sorts all items by group priority', () => {
    expect(sortItems(all)[0]).toBe(pinned);
    expect(sortItems(all).at(-1)).toBe(snoozed);
  });

  it('top items and compact groups', () => {
    expect(topItems(all, 2).map((i) => i.uid)).toEqual([review2.uid, review.uid]);
    const compact = compactGroups(all, undefined, 1);
    expect(compact.map((g) => [g.group, g.items.length, g.total])).toEqual([
      ['needs-review', 1, 2],
      ['ready-to-merge', 1, 1],
      ['blocked', 1, 1],
    ]);
  });

  it('collects facets', () => {
    const fx = facets([loginPr, jira]);
    expect(fx.providers).toEqual(['github', 'jira-cloud']);
    expect(fx.labels).toEqual(['crash', 'feature']);
    expect(fx.milestones).toEqual(['Sprint 5', 'v1.0']);
  });
});

describe('ids & dedupe', () => {
  it('merges involvement for duplicate uids, newest payload wins', () => {
    const a = prIt(pr({ updatedAt: '2026-10-01T00:00:00Z' }), ['author']);
    const b = prIt(pr({ updatedAt: '2026-10-02T00:00:00Z', title: 'new' }), ['mentioned', 'author']);
    const out = dedupeItems([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('new');
    expect(out[0]!.involvement).toEqual(['author', 'mentioned']);
  });

  it.each([
    ['C:\\Code\\App\\', 'c:/code/app'],
    ['/home/me/app/', '/home/me/app'],
    ['/Users/Me/App', '/Users/Me/App'],
  ])('normalizes path %s', (p, expected) => {
    expect(normalizePath(p)).toBe(expected);
  });

  it('builds stable uids', () => {
    expect(prUid(pr())).toBe('pr:github:github.com:1:acme/app:1');
    expect(jira.uid).toBe('issue:jira-cloud:acme.atlassian.net:J1:ABC:ABC-12');
    expect(wipUid('C:\\code\\app')).toBe('wip:c:/code/app');
  });
});
