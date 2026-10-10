import { classify, groupItems, prItem, type ClassifiedItem } from '@githappens/launchpad';
import type { PullRequest } from '@githappens/providers/types';
import { describe, expect, it } from 'vitest';

import {
  activeFilterCount,
  ago,
  canMergeFromLaunchpad,
  filtersKey,
  firstItem,
  flattenGroups,
  moveSelection,
  prGlyphs,
  serverFilters,
  showStatusIndicator,
  visibleRange,
  wipLabel,
} from '../src/renderer/src/launchpad/helpers';

const repo = {
  integration: { kind: 'github' as const, host: 'github.com', accountId: '1' },
  owner: 'a',
  name: 'b',
};
const pr = (n: number, o: Partial<PullRequest> = {}): PullRequest => ({
  repo,
  number: n,
  id: `PR_${n}`,
  title: `PR ${n}`,
  body: '',
  state: 'open',
  author: { id: '1', login: 'me' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: `2026-10-0${n}T00:00:00Z`,
  head: { repo, branch: `f${n}`, sha: 'x' },
  base: { repo, branch: 'main' },
  reviewers: [],
  assignees: [],
  labels: [],
  reviewDecision: null,
  mergeable: 'mergeable',
  checksRollup: 'success',
  rollup: 'success',
  commentsCount: 0,
  webUrl: '',
  isCrossRepository: false,
  viewer: { canMerge: true, canEdit: true, canApprove: false, isAuthor: true, reviewRequested: false },
  allowedMergeMethods: ['squash'],
  ...o,
});
const C = (p: PullRequest): ClassifiedItem =>
  classify(prItem(p), { now: Date.parse('2026-10-09T00:00:00Z') });

describe('launchpad renderer helpers', () => {
  const ready = C(pr(1));
  const blocked = C(pr(2, { mergeable: 'conflicting' }));
  const blocked2 = C(pr(3, { checksRollup: 'failure' }));
  const groups = groupItems([ready, blocked, blocked2]);

  it('flattens groups into header + item rows, honoring collapse', () => {
    const rows = flattenGroups(groups, new Set());
    expect(
      rows.map((r) => (r.kind === 'header' ? `H:${r.group}:${r.count}` : r.item.uid.split(':').pop())),
    ).toEqual(['H:blocked:2', '3', '2', 'H:ready-to-merge:1', '1']);
    expect(flattenGroups(groups, new Set(['blocked'])).map((r) => r.kind)).toEqual([
      'header',
      'header',
      'item',
    ]);
  });

  it('moves selection across items, skipping headers', () => {
    const rows = flattenGroups(groups, new Set());
    expect(firstItem(rows)).toBe(1);
    expect(moveSelection(rows, 1, 1)).toBe(2);
    expect(moveSelection(rows, 2, 1)).toBe(4);
    expect(moveSelection(rows, 4, 1)).toBe(4);
    expect(moveSelection(rows, 1, -1)).toBe(1);
  });

  it('computes the virtualized window', () => {
    expect(visibleRange(0, 340, 34, 1000, 2)).toEqual({ start: 0, end: 12 });
    expect(visibleRange(3400, 340, 34, 1000, 2)).toEqual({ start: 98, end: 112 });
    expect(visibleRange(0, 340, 34, 5)).toEqual({ start: 0, end: 5 });
  });

  it('builds PR status glyphs', () => {
    expect(prGlyphs(blocked).map((g) => g.kind)).toEqual(['no-reviewers', 'ci', 'conflict']);
    expect(
      prGlyphs(C(pr(4, { reviewDecision: 'approved', checksRollup: 'pending' }))).map((g) => g.label),
    ).toEqual(['Approved', 'Checks running']);
  });

  it('offers merge only from ready-to-merge with permission', () => {
    expect(canMergeFromLaunchpad(ready)).toBe(true);
    expect(canMergeFromLaunchpad(blocked)).toBe(false);
    expect(
      canMergeFromLaunchpad(
        C(
          pr(5, {
            viewer: {
              canMerge: false,
              canEdit: true,
              canApprove: false,
              isAuthor: true,
              reviewRequested: false,
            },
          }),
        ),
      ),
    ).toBe(false);
  });

  it('keys and counts filters (text is client-side)', () => {
    const f = { scope: { kind: 'all' as const }, mode: 'personal' as const, labels: ['b', 'a'], text: 'x' };
    expect(filtersKey(f)).toBe(filtersKey({ ...f, labels: ['a', 'b'], text: 'other' }));
    expect(filtersKey(f)).not.toBe(filtersKey({ ...f, mode: 'team' }));
    expect(serverFilters(f).text).toBeUndefined();
    expect(activeFilterCount({ ...f, updatedWithin: '7d', repos: [] })).toBe(2);
  });

  it('formats labels', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago('2026-10-09T09:00:00Z', now)).toBe('3h ago');
    expect(ago(null, now)).toBe('never');
    expect(wipLabel({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0 })).toBe('1 file changed');
    expect(wipLabel({ staged: 1, unstaged: 2, untracked: 0, conflicted: 1 })).toBe(
      '4 files changed · 1 conflicted',
    );
  });

  it.each([
    ['never', { needsReview: 3, readyToMerge: 0, blocked: 0, hasIntegrations: true }, false],
    ['auto', { needsReview: 0, readyToMerge: 0, blocked: 0, hasIntegrations: true }, false],
    ['auto', { needsReview: 0, readyToMerge: 1, blocked: 0, hasIntegrations: true }, true],
    ['always', { needsReview: 0, readyToMerge: 0, blocked: 0, hasIntegrations: true }, true],
    ['always', { needsReview: 2, readyToMerge: 0, blocked: 0, hasIntegrations: false }, false],
  ] as const)('status indicator %s %#', (mode, s, expected) => {
    expect(showStatusIndicator(mode, s)).toBe(expected);
  });
});
