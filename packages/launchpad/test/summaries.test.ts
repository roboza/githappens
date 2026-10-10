import { describe, expect, it } from 'vitest';

import { classify, classifyAll } from '../src/classify';
import { wipUid } from '../src/ids';
import { issueItem, issueScopeLabel } from '../src/items';
import { countOpenPrs, priorityRank, recentWips, topIssues, totalPrCounts } from '../src/summaries';
import type { ClassifiedItem, Involvement } from '../src/types';
import { ALICE, ctx, issue, issueIt, ME, mine, NOW, pr, prIt, wip, wipIt } from './fixtures';

const REPO_B = { ...pr().repo, name: 'api' };

describe('issueScopeLabel', () => {
  it('shows Trello board names, other scopes verbatim', () => {
    const trello = issue({
      tracker: {
        kind: 'trello',
        integration: { kind: 'trello', host: 'trello.com', accountId: 'm1' },
        scope: 'b1/Product board',
      },
      key: 'abC123',
    });
    expect(issueScopeLabel(trello)).toBe('Product board');
    expect(issueItem(trello).repo?.fullName).toBe('Product board');
    expect(issueScopeLabel({ ...trello, tracker: { ...trello.tracker, scope: 'b1' } })).toBe('b1');
    expect(issueScopeLabel(issue())).toBe('ABC');
  });
});

describe('countOpenPrs', () => {
  const items = classifyAll(
    [
      prIt(mine({ number: 1 })),
      prIt(pr({ number: 2, viewer: { reviewRequested: true } })),
      prIt(pr({ number: 3, author: ALICE })),
      prIt(pr({ number: 4, state: 'draft' }), ['author']),
      prIt(pr({ number: 5, state: 'merged' })),
      prIt(pr({ number: 6, repo: REPO_B, author: ME, viewer: { isAuthor: true } })),
      prIt(pr({ number: 7, repo: { ...REPO_B, name: 'unknown' } })),
      issueIt(issue()),
      wipIt(wip()),
    ],
    ctx(),
  );
  const keyOf = (i: ClassifiedItem & { type: 'pr' }) =>
    i.pr.repo.name === 'app' ? 'r1' : i.pr.repo.name === 'api' ? 'r2' : undefined;

  it('counts open + draft PRs per repo: mine / total / needs my review', () => {
    const c = countOpenPrs([...items, items[0]!], keyOf);
    expect(c).toEqual({
      r1: { total: 4, mine: 2, needsMyReview: 1 },
      r2: { total: 1, mine: 1, needsMyReview: 0 },
    });
    expect(totalPrCounts([c.r1, c.r2, undefined])).toEqual({ total: 5, mine: 3, needsMyReview: 1 });
  });
});

describe('priorityRank', () => {
  it.each([
    ['Highest', 0],
    ['Blocker', 0],
    ['High', 1],
    ['Medium', 2],
    ['Low', 3],
    ['Lowest', 4],
    ['1', 0],
    ['2', 1],
    ['4', 3],
    ['P1', 1],
    ['priority::high', 1],
    ['whatever', 5],
    [undefined, 5],
  ])('%s → %i', (p, r) => expect(priorityRank(p)).toBe(r));
});

describe('topIssues / recentWips (Home Focus)', () => {
  const mk = (key: string, p: Parameters<typeof issue>[0] = {}, inv: Involvement[] = ['assignee']) =>
    issueIt(issue({ key, id: key, ...p }), inv);
  const items = classifyAll(
    [
      mk('A-1', { priority: 'Low', updatedAt: '2026-10-09T00:00:00Z' }),
      mk('A-2', { priority: 'High', updatedAt: '2026-10-01T00:00:00Z' }),
      mk('A-3', { priority: 'High', updatedAt: '2026-10-05T00:00:00Z', stateCategory: 'in_progress' }),
      mk('A-4', { stateCategory: 'done' }),
      mk('A-5', { assignees: [] }, []),
      mk('A-6', { priority: 'Lowest' }),
      wipIt(wip({ path: 'C:\\a', name: 'a', lastModified: '2026-10-08T00:00:00Z' })),
      wipIt(wip({ path: 'C:\\b', name: 'b', lastModified: '2026-10-09T00:00:00Z' })),
      prIt(mine()),
    ],
    ctx({
      itemStates: {
        [issueIt(issue({ key: 'A-6', id: 'A-6' })).uid]: { uid: 'x', pinnedAt: '2026-10-09T00:00:00Z' },
      },
    }),
  );

  it('ranks my open issues: pinned, then priority, then recency; excludes done / not mine', () => {
    expect(topIssues(items, 5).map((i) => (i.type === 'issue' ? i.issue.key : ''))).toEqual([
      'A-6',
      'A-3',
      'A-2',
      'A-1',
    ]);
    expect(topIssues(items, 2)).toHaveLength(2);
  });

  it('lists WIP repos by last modification, skipping snoozed ones', () => {
    expect(recentWips(items).map((i) => i.title)).toEqual(['b', 'a']);
    const snoozed = classify(wipIt(wip({ path: 'C:\\b', name: 'b' })), {
      now: NOW,
      itemStates: {
        [wipUid('C:\\b')]: { uid: 'x', snooze: { indefinite: true, snoozedAt: '2026-10-01T00:00:00Z' } },
      },
    });
    expect(snoozed.group).toBe('snoozed');
    expect(recentWips([snoozed])).toEqual([]);
  });
});
