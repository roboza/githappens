import { describe, expect, it } from 'vitest';

import { classifyAll } from '../src/classify';
import {
  describePrEvent,
  diffPrEvents,
  parsePrNotifyState,
  planPrNotifications,
  prFacts,
  PR_NOTIFY_KEEP_MS,
  type PrNotifyState,
} from '../src/notify';
import type { ClassifiedItem, ItemUserState, LaunchpadItem } from '../src/types';
import { GH_KEY, issue, issueIt, mine, ME, NOW, pr, prIt } from './fixtures';

const ctx = (states: Record<string, ItemUserState> = {}) => ({
  now: NOW,
  itemStates: states,
  viewers: { [GH_KEY]: ME },
});
const cls = (items: LaunchpadItem[], states?: Record<string, ItemUserState>): ClassifiedItem[] =>
  classifyAll(items, ctx(states));

const reviewReq = (n: number, sha = 'aaa') =>
  prIt(
    pr({
      number: n,
      id: `PR_${n}`,
      head: { repo: null, branch: `b${n}`, sha },
      viewer: { reviewRequested: true },
    }),
  );
const minePr = (n: number, p: Parameters<typeof mine>[0] = {}) =>
  prIt(mine({ number: n, id: `PR_${n}`, head: { repo: null, branch: `m${n}`, sha: 'aaa' }, ...p }));

const OK = [GH_KEY];

/** Run a diff from `prev` with defaults. */
function run(
  prev: PrNotifyState | null,
  items: ClassifiedItem[],
  extra: { ok?: string[]; silent?: boolean; now?: number } = {},
) {
  return diffPrEvents(prev, {
    items,
    okAccounts: extra.ok ?? OK,
    now: extra.now ?? NOW,
    silent: extra.silent,
  });
}

/** Baseline with `items`, then diff `next`. */
function after(items: ClassifiedItem[], next: ClassifiedItem[]) {
  const base = run(null, items);
  expect(base.events).toEqual([]);
  return run(base.state, next);
}

describe('prFacts', () => {
  it('review requested on others’ PRs; approved / checks failed on mine', () => {
    const [rr, ap, cf, plain] = cls([
      reviewReq(1),
      minePr(2, { reviewDecision: 'approved' }),
      minePr(3, { checksRollup: 'failure' }),
      minePr(4),
    ]);
    expect(prFacts(rr!)).toMatchObject({ rr: true, acct: GH_KEY, sha: 'aaa' });
    expect(prFacts(ap!)).toMatchObject({ ap: true });
    expect(prFacts(cf!)).toMatchObject({ cf: true });
    expect(prFacts(plain!)).toEqual({ acct: GH_KEY, sha: 'aaa' });
  });

  it('approval by a reviewer counts when the provider has no review decision', () => {
    const [it] = cls([minePr(1, { reviewers: [{ user: { id: '9', login: 'z' }, state: 'approved' }] })]);
    expect(prFacts(it!)?.ap).toBe(true);
  });

  it('closed / merged PRs and issues have no facts', () => {
    const [closed, iss] = cls([minePr(1, { state: 'merged', checksRollup: 'failure' }), issueIt(issue())]);
    expect(prFacts(closed!)).toEqual({ acct: GH_KEY, sha: 'aaa' });
    expect(prFacts(iss!)).toBeNull();
  });

  it('checks failing on someone else’s PR is not my event', () => {
    const [it] = cls([prIt(pr({ checksRollup: 'failure' }))]);
    expect(prFacts(it!)?.cf).toBeUndefined();
  });
});

describe('diffPrEvents', () => {
  it('first snapshot is a silent baseline', () => {
    const r = run(null, cls([reviewReq(1), minePr(2, { checksRollup: 'failure' })]));
    expect(r.events).toEqual([]);
    expect(r.changed).toBe(true);
    expect(r.state.accounts).toEqual([GH_KEY]);
    expect(Object.keys(r.state.prs)).toHaveLength(2);
  });

  it('a newly requested review fires once', () => {
    const r = after(cls([minePr(2)]), cls([minePr(2), reviewReq(1)]));
    expect(r.events.map((e) => [e.kind, e.item.uid])).toEqual([['review-requested', reviewReq(1).uid]]);
    // the next refresh with the same data is quiet
    const again = run(r.state, cls([minePr(2), reviewReq(1)]));
    expect(again.events).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it('a request on an existing PR (false → true) fires', () => {
    const before = prIt(pr({ number: 1, head: { repo: null, branch: 'b', sha: 'aaa' } }));
    const r = after(cls([before]), cls([reviewReq(1)]));
    expect(r.events.map((e) => e.kind)).toEqual(['review-requested']);
  });

  it('my PR became approved / checks newly failed', () => {
    const r = after(
      cls([minePr(1), minePr(2, { checksRollup: 'pending' })]),
      cls([minePr(1, { reviewDecision: 'approved' }), minePr(2, { checksRollup: 'failure' })]),
    );
    expect(r.events.map((e) => e.kind)).toEqual(['approved', 'checks-failed']);
  });

  it('a state that was already true does not fire again', () => {
    const items = cls([
      reviewReq(1),
      minePr(2, { reviewDecision: 'approved' }),
      minePr(3, { checksRollup: 'failure' }),
    ]);
    expect(after(items, items).events).toEqual([]);
  });

  it('dedupes per PR + event + head sha (flip off and on again)', () => {
    const a = after(cls([minePr(1)]), cls([minePr(1, { checksRollup: 'failure' })]));
    expect(a.events).toHaveLength(1);
    const b = run(a.state, cls([minePr(1, { checksRollup: 'pending' })]));
    expect(b.events).toEqual([]);
    const c = run(b.state, cls([minePr(1, { checksRollup: 'failure' })]));
    expect(c.events).toEqual([]); // same sha → already notified
  });

  it('checks failing again on a new head commit is a new event', () => {
    const a = after(cls([minePr(1)]), cls([minePr(1, { checksRollup: 'failure' })]));
    const pushed = minePr(1, { checksRollup: 'failure', head: { repo: null, branch: 'm1', sha: 'bbb' } });
    const b = run(a.state, cls([pushed]));
    expect(b.events.map((e) => e.key)).toEqual([`${pushed.uid}|checks-failed|bbb`]);
  });

  it('review re-requested after a new push fires again', () => {
    const a = after(cls([]), cls([reviewReq(1)]));
    expect(a.events).toHaveLength(1);
    const reviewed = prIt(pr({ number: 1, id: 'PR_1', head: { repo: null, branch: 'b1', sha: 'aaa' } }));
    const b = run(a.state, cls([reviewed]));
    const c = run(b.state, cls([reviewReq(1, 'ccc')]));
    expect(c.events.map((e) => e.kind)).toEqual(['review-requested']);
  });

  it('snoozed items never notify, and un-snoozing does not replay', () => {
    const item = reviewReq(1);
    const snoozed = {
      [item.uid]: { uid: item.uid, snooze: { indefinite: true, snoozedAt: '2026-10-01T00:00:00Z' } },
    };
    const a = after(cls([]), cls([item], snoozed));
    expect(a.events).toEqual([]);
    expect(a.state.prs[item.uid]?.rr).toBe(true);
    expect(run(a.state, cls([item])).events).toEqual([]);
  });

  it('silent (setting off / offline) records facts without events or backlog', () => {
    const a = run(run(null, []).state, cls([reviewReq(1)]), { silent: true });
    expect(a.events).toEqual([]);
    expect(run(a.state, cls([reviewReq(1)])).events).toEqual([]);
  });

  it('a newly connected account is baselined silently', () => {
    const base = run(null, [], { ok: ['other:x:1'] });
    expect(base.state.accounts).toEqual(['other:x:1']);
    const r = run(base.state, cls([reviewReq(1)]));
    expect(r.events).toEqual([]);
    expect(r.state.accounts).toContain(GH_KEY);
    // …but an account with zero PRs at its baseline still notifies later
    const base2 = run(null, [], { ok: OK });
    expect(run(base2.state, cls([reviewReq(1)])).events).toHaveLength(1);
  });

  it('failed sources keep previous facts and emit nothing', () => {
    const a = run(null, cls([prIt(pr({ number: 1, head: { repo: null, branch: 'b', sha: 'aaa' } }))]));
    // the source failed: cached items (even changed ones) don't produce events
    const b = run(a.state, cls([reviewReq(1)]), { ok: [] });
    expect(b.events).toEqual([]);
    expect(b.state.prs[reviewReq(1).uid]?.rr).toBeUndefined();
    // when it comes back, the transition is still detected
    expect(run(b.state, cls([reviewReq(1)])).events).toHaveLength(1);
    // missing items of a failed source are kept too
    const c = run(a.state, [], { ok: [] });
    expect(Object.keys(c.state.prs)).toEqual(Object.keys(a.state.prs));
  });

  it('prunes old dedupe keys of PRs that are gone', () => {
    const a = after(cls([]), cls([reviewReq(1)]));
    expect(Object.keys(a.state.notified)).toHaveLength(1);
    const gone = run(a.state, [], { now: NOW + 1000 });
    expect(Object.keys(gone.state.notified)).toHaveLength(1); // recent → kept
    const later = run(gone.state, [], { now: NOW + PR_NOTIFY_KEEP_MS + 1 });
    expect(later.state.notified).toEqual({});
  });

  it('ignores duplicate uids and non-PR items', () => {
    const r = after(cls([]), cls([reviewReq(1), reviewReq(1), issueIt(issue())]));
    expect(r.events).toHaveLength(1);
  });
});

describe('planPrNotifications', () => {
  const events = (n: number) =>
    after(cls([]), cls(Array.from({ length: n }, (_, i) => reviewReq(i + 1)))).events;

  it('no events → nothing', () => {
    expect(planPrNotifications([])).toEqual([]);
  });

  it('up to the limit: one notification each with the PR to open', () => {
    const out = planPrNotifications(events(3));
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      kind: 'review-requested',
      count: 1,
      title: 'Review requested: acme/app#1',
    });
    expect(out[0]!.item?.type).toBe('pr');
    expect(out[0]!.body).toContain('by alice');
  });

  it('more than the limit: one batched notification', () => {
    const mixed = [
      ...events(3),
      ...after(cls([minePr(9)]), cls([minePr(9, { reviewDecision: 'approved', checksRollup: 'failure' })]))
        .events,
    ];
    const out = planPrNotifications(mixed);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'batch',
      count: 5,
      title: '4 pull requests need attention',
      body: '3 review requests, 1 approval, 1 failing check run',
    });
    expect(out[0]!.item).toBeUndefined();
  });

  it('custom limit', () => {
    expect(planPrNotifications(events(2), 1)).toHaveLength(1);
  });

  it('describes each kind', () => {
    const [ap, cf] = after(
      cls([minePr(1), minePr(2)]),
      cls([minePr(1, { reviewDecision: 'approved' }), minePr(2, { checksRollup: 'failure' })]),
    ).events;
    expect(describePrEvent(ap!).title).toBe('Pull request approved: acme/app#1');
    expect(describePrEvent(cf!).title).toBe('Checks failed: acme/app#2');
  });
});

describe('parsePrNotifyState', () => {
  it('round-trips and rejects junk', () => {
    const s = after(cls([]), cls([reviewReq(1)])).state;
    expect(parsePrNotifyState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parsePrNotifyState(null)).toBeNull();
    expect(parsePrNotifyState({ version: 2 })).toBeNull();
    expect(parsePrNotifyState({ version: 1, accounts: [], prs: {} })).toBeNull();
  });
});
