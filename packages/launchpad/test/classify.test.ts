import { describe, expect, it } from 'vitest';

import { classify, CLASSIFIER_VERSION, GROUP_ORDER, groupPriority } from '../src/classify';
import type { ClassifyContext, LaunchpadGroup, LaunchpadItem } from '../src/types';
import { ALICE, BOB, ctx, GH, issue, issueIt, ME, mine, NOW, pr, prIt, REF, wip, wipIt } from './fixtures';

const otherRepo = { ...REF, name: 'other' };
const openTab = (branch: string, extra: Partial<{ localPath: string; repoKeys: string[] }> = {}) => ({
  currentBranches: [{ branch, ...extra }],
});

describe('classifier', () => {
  it('is versioned', () => {
    expect(CLASSIFIER_VERSION).toBeGreaterThanOrEqual(1);
  });

  const prCases: Array<[string, LaunchpadItem, Partial<ClassifyContext>, LaunchpadGroup]> = [
    ['someone else’s PR without involvement → other', prIt(pr()), {}, 'other'],
    ['my PR with conflicts → blocked', prIt(mine({ mergeable: 'conflicting' })), {}, 'blocked'],
    ['my PR with failing checks → blocked', prIt(mine({ checksRollup: 'failure' })), {}, 'blocked'],
    [
      'my PR with changes requested → blocked',
      prIt(mine({ reviewDecision: 'changes_requested', mergeable: 'mergeable', checksRollup: 'success' })),
      {},
      'blocked',
    ],
    [
      'my approved, green, mergeable PR → ready-to-merge',
      prIt(mine({ reviewDecision: 'approved', mergeable: 'mergeable', checksRollup: 'success' })),
      {},
      'ready-to-merge',
    ],
    [
      'no required reviews + no checks + mergeable → ready-to-merge',
      prIt(mine({ reviewDecision: null, mergeable: 'mergeable', checksRollup: 'none' })),
      {},
      'ready-to-merge',
    ],
    [
      'review required (no approvals yet) → waiting-for-review',
      prIt(mine({ reviewDecision: 'review_required', mergeable: 'mergeable', checksRollup: 'success' })),
      {},
      'waiting-for-review',
    ],
    [
      'approved but checks pending → other',
      prIt(
        mine({
          reviewDecision: 'approved',
          mergeable: 'mergeable',
          checksRollup: 'pending',
          reviewers: [{ user: BOB, state: 'approved' }],
        }),
      ),
      {},
      'other',
    ],
    [
      'approved but mergeability unknown → other',
      prIt(
        mine({
          reviewDecision: 'approved',
          mergeable: 'unknown',
          checksRollup: 'success',
          reviewers: [{ user: BOB, state: 'approved' }],
        }),
      ),
      {},
      'other',
    ],
    ['my draft → draft', prIt(mine({ state: 'draft', mergeable: 'mergeable' })), {}, 'draft'],
    [
      'my draft with conflicts → blocked',
      prIt(mine({ state: 'draft', mergeable: 'conflicting' })),
      {},
      'blocked',
    ],
    [
      'not author but can merge an approved PR → ready-to-merge',
      prIt(
        pr({
          reviewDecision: 'approved',
          mergeable: 'mergeable',
          checksRollup: 'success',
          viewer: { canMerge: true },
        }),
      ),
      {},
      'ready-to-merge',
    ],
    [
      'review explicitly requested (viewer flag) → needs-review',
      prIt(pr({ viewer: { reviewRequested: true } })),
      {},
      'needs-review',
    ],
    ['review requested via involvement → needs-review', prIt(pr(), ['review-requested']), {}, 'needs-review'],
    [
      'viewer listed as pending reviewer → needs-review',
      prIt(pr({ reviewers: [{ user: ME, state: 'pending' }] })),
      {},
      'needs-review',
    ],
    [
      'viewer matched by login → needs-review',
      prIt(pr({ reviewers: [{ user: { id: 'other-id', login: 'ME' }, state: 'pending' }] })),
      {},
      'needs-review',
    ],
    [
      'viewer already approved, not re-requested → other',
      prIt(pr({ reviewers: [{ user: ME, state: 'approved' }] }), ['reviewer']),
      {},
      'other',
    ],
    [
      'viewer requested changes on someone else’s PR → follow-up',
      prIt(pr({ reviewers: [{ user: ME, state: 'changes_requested' }] }), ['reviewer']),
      {},
      'follow-up',
    ],
    [
      'draft where review is explicitly requested → needs-review',
      prIt(pr({ state: 'draft', viewer: { reviewRequested: true } })),
      {},
      'needs-review',
    ],
    [
      'draft where viewer is only a listed reviewer → other',
      prIt(pr({ state: 'draft', reviewers: [{ user: ME, state: 'pending' }] })),
      {},
      'other',
    ],
    [
      'my PR with a comment-only review by someone else → follow-up',
      prIt(mine({ reviewDecision: 'review_required', reviewers: [{ user: ALICE, state: 'commented' }] })),
      {},
      'follow-up',
    ],
    [
      'my PR updated after my last activity with comments → follow-up',
      prIt(mine({ commentsCount: 2, updatedAt: '2026-10-08T00:00:00Z' }), [], {
        viewerLastActivityAt: '2026-10-07T00:00:00Z',
      }),
      {},
      'follow-up',
    ],
    [
      'my PR not updated since my last activity → waiting-for-review',
      prIt(mine({ commentsCount: 2, updatedAt: '2026-10-06T00:00:00Z' }), [], {
        viewerLastActivityAt: '2026-10-07T00:00:00Z',
      }),
      {},
      'waiting-for-review',
    ],
    [
      'my PR with pending reviewers → waiting-for-review',
      prIt(mine({ reviewers: [{ user: BOB, state: 'pending' }] })),
      {},
      'waiting-for-review',
    ],
    [
      'head branch checked out in the same local repo → current-branch',
      {
        ...prIt(mine({ mergeable: 'conflicting' })),
        repo: { fullName: 'acme/app', localPath: 'C:\\code\\app' },
      },
      openTab('feature/login', { localPath: 'c:/code/app/' }),
      'current-branch',
    ],
    [
      'head branch checked out in a repo matched by remote → current-branch',
      prIt(pr()),
      openTab('feature/login', { repoKeys: ['github:github.com:1|acme/app'] }),
      'current-branch',
    ],
    [
      'same branch name in a different repo → not current-branch',
      prIt(pr({ repo: otherRepo, head: { repo: otherRepo, branch: 'feature/login', sha: 'x' } })),
      openTab('feature/login', { repoKeys: ['github:github.com:1|acme/app'] }),
      'other',
    ],
    ['merged PR → other', prIt(mine({ state: 'merged', mergeable: 'conflicting' })), {}, 'other'],
    [
      'closed PR on the current branch → other',
      prIt(pr({ state: 'closed' })),
      openTab('feature/login', { repoKeys: ['github:github.com:1|acme/app'] }),
      'other',
    ],
    [
      'author known only from involvement → blocked',
      prIt(pr({ checksRollup: 'failure' }), ['author']),
      {},
      'blocked',
    ],
    [
      'author detected by account id (no viewer flags) → waiting-for-review',
      prIt(pr({ author: { id: GH.accountId, login: 'me' } })),
      {},
      'waiting-for-review',
    ],
  ];

  it.each(prCases)('%s', (_name, item, c, expected) => {
    const r = classify(item, ctx(c));
    expect(r.statusGroup).toBe(expected);
    expect(r.group).toBe(expected);
  });

  const issueCases: Array<[string, LaunchpadItem, Partial<ClassifyContext>, LaunchpadGroup]> = [
    ['assigned to-do issue → todo', issueIt(issue()), {}, 'todo'],
    [
      'assigned in-progress issue → in-progress',
      issueIt(issue({ stateCategory: 'in_progress' })),
      {},
      'in-progress',
    ],
    ['mentioned only → other', issueIt(issue({ assignees: [] }), ['mentioned']), {}, 'other'],
    ['done issue → other', issueIt(issue({ stateCategory: 'done' })), {}, 'other'],
    [
      'Jira key in checked-out branch → current-branch',
      issueIt(issue()),
      openTab('feature/ABC-12-fix-crash'),
      'current-branch',
    ],
    [
      'GitHub #12 with matching repo branch → current-branch',
      issueIt(
        issue({
          key: '#12',
          tracker: { kind: 'github', integration: GH, scope: 'acme/app' },
          assignees: [ME],
        }),
      ),
      openTab('12-fix-crash', { repoKeys: ['github:github.com:1|acme/app'] }),
      'current-branch',
    ],
    [
      'GitHub #12 branch in a different repo → todo',
      issueIt(
        issue({
          key: '#12',
          tracker: { kind: 'github', integration: GH, scope: 'acme/app' },
          assignees: [ME],
        }),
      ),
      openTab('12-fix-crash', { repoKeys: ['github:github.com:1|acme/other'] }),
      'todo',
    ],
    [
      'branch key prefix must end at a dash (ABC-123 ≠ ABC-12) → todo',
      issueIt(issue()),
      openTab('ABC-123-other'),
      'todo',
    ],
  ];

  it.each(issueCases)('%s', (_name, item, c, expected) => {
    expect(classify(item, ctx(c)).group).toBe(expected);
  });

  const until = (ms: number) => new Date(ms).toISOString();
  const uidOf = prIt(pr()).uid;
  const stateCases: Array<[string, LaunchpadItem, Partial<ClassifyContext>, LaunchpadGroup, LaunchpadGroup]> =
    [
      [
        'pinned item keeps its status group',
        prIt(pr({ viewer: { reviewRequested: true } })),
        { itemStates: { [uidOf]: { uid: uidOf, pinnedAt: until(NOW - 1000) } } },
        'pinned',
        'needs-review',
      ],
      [
        'active snooze → snoozed',
        prIt(pr({ viewer: { reviewRequested: true } })),
        {
          itemStates: {
            [uidOf]: { uid: uidOf, snooze: { until: until(NOW + 60_000), snoozedAt: until(NOW) } },
          },
        },
        'snoozed',
        'needs-review',
      ],
      [
        'expired snooze → back to its group',
        prIt(pr({ viewer: { reviewRequested: true } })),
        {
          itemStates: {
            [uidOf]: { uid: uidOf, snooze: { until: until(NOW - 1), snoozedAt: until(NOW - 9e6) } },
          },
        },
        'needs-review',
        'needs-review',
      ],
      [
        'until-updated snooze ends when the item changes',
        prIt(pr({ updatedAt: '2026-10-09T11:00:00Z' })),
        {
          itemStates: {
            [uidOf]: {
              uid: uidOf,
              snooze: { untilUpdatedAfter: '2026-10-08T00:00:00Z', snoozedAt: until(NOW) },
            },
          },
        },
        'other',
        'other',
      ],
      [
        'until-updated snooze holds while unchanged',
        prIt(pr({ updatedAt: '2026-10-08T00:00:00Z' })),
        {
          itemStates: {
            [uidOf]: {
              uid: uidOf,
              snooze: { untilUpdatedAfter: '2026-10-08T00:00:00Z', snoozedAt: until(NOW) },
            },
          },
        },
        'snoozed',
        'other',
      ],
      [
        'indefinite snooze → snoozed',
        prIt(pr()),
        { itemStates: { [uidOf]: { uid: uidOf, snooze: { indefinite: true, snoozedAt: until(NOW) } } } },
        'snoozed',
        'other',
      ],
      [
        'pinned wins over snoozed (rule 0 before 0′)',
        prIt(pr()),
        {
          itemStates: {
            [uidOf]: {
              uid: uidOf,
              pinnedAt: until(NOW),
              snooze: { indefinite: true, snoozedAt: until(NOW) },
            },
          },
        },
        'pinned',
        'other',
      ],
      ['WIP → wip', wipIt(wip()), {}, 'wip', 'wip'],
    ];

  it.each(stateCases)('%s', (_name, item, c, group, statusGroup) => {
    const r = classify(item, ctx(c));
    expect(r.group).toBe(group);
    expect(r.statusGroup).toBe(statusGroup);
  });

  it('flags PR sub-status', () => {
    const r = classify(prIt(mine({ mergeable: 'conflicting', checksRollup: 'failure' })), ctx());
    expect(r.flags).toMatchObject({ noReviewers: true, conflicts: true, failingChecks: true });
    const r2 = classify(prIt(mine({ reviewers: [{ user: BOB, state: 'pending' }] })), ctx());
    expect(r2.flags.noReviewers).toBeUndefined();
  });

  it('orders groups actionable first (§5.3)', () => {
    expect(GROUP_ORDER.slice(0, 9)).toEqual([
      'pinned',
      'current-branch',
      'needs-review',
      'blocked',
      'ready-to-merge',
      'follow-up',
      'waiting-for-review',
      'draft',
      'in-progress',
    ]);
    expect(groupPriority('pinned')).toBeLessThan(groupPriority('other'));
  });
});
