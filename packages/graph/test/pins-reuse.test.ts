import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { GraphModel, RowFlag } from '../src';
import { build, c, randomHistory, snapshot } from './helpers';

describe('pinned lanes (spec 04 §2.6 "Pin to left", §6.3.4)', () => {
  // main: m3 → m2 → m1 → r ; feature: f2 → f1 → m1 ; other: o1 → r
  const commits = [
    c('o1', ['r'], 9),
    c('m3', ['m2'], 8),
    c('f2', ['f1'], 7),
    c('m2', ['m1'], 6),
    c('f1', ['m1'], 5),
    c('m1', ['r'], 4),
    c('r', [], 1),
  ];

  it('a pinned branch takes lane 1 and keeps its first-parent chain straight there', () => {
    const m = build(commits, { headSha: 'm3', pinnedTips: ['f2'] });
    expect(m.columnAt(m.rowOf('m3'))).toBe(0);
    expect(m.columnAt(m.rowOf('m2'))).toBe(0);
    expect(m.columnAt(m.rowOf('f2'))).toBe(1);
    expect(m.columnAt(m.rowOf('f1'))).toBe(1);
    expect(m.flagsAt(m.rowOf('f1')) & RowFlag.Pinned).toBeTruthy();
    // the newer unpinned tip may not steal the reserved lanes
    expect(m.columnAt(m.rowOf('o1'))).toBeGreaterThan(1);
  });

  it('without the pin the newest tip takes the first free lane', () => {
    const m = build(commits, { headSha: 'm3' });
    expect(m.columnAt(m.rowOf('o1'))).toBe(1);
    expect(m.columnAt(m.rowOf('f2'))).toBe(2);
  });

  it('changing pins via rebuild equals a full layout (reuse is safe across pin changes)', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 20, max: 250 }),
        fc.integer({ min: 0, max: 3 }),
        (seed, n, k) => {
          const { commits: cs, options } = randomHistory(seed, n);
          const opts = {
            ...options,
            colorMode: 'column' as const,
            checkpointInterval: 8,
            convergenceVerify: 4,
          };
          const old = build(cs, opts);
          const tips = cs
            .filter((_, i) => i % 7 === 3)
            .map((x) => x.sha)
            .slice(0, k);
          const next = { ...opts, pinnedTips: tips };
          expect(snapshot(GraphModel.rebuild(old, next))).toEqual(snapshot(build(cs, next)));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('layout reuse stability (§6.10)', () => {
  it('a new commit on top keeps every existing commit in its lane and adopts the old tail', () => {
    const { commits } = randomHistory(99, 5000, false);
    const opts = { headSha: 'c0', checkpointInterval: 256, convergenceVerify: 32 };
    const old = build(commits, opts);
    const before = new Map(commits.map((x) => [x.sha, old.columnAt(old.rowOf(x.sha))]));
    const stream = [c('n1', ['c0'], 1e9), ...commits];
    const next = new GraphModel({ ...opts, headSha: 'n1' }, old);
    next.append(stream, true);
    expect(next.converged).toBe(true);
    let moved = 0;
    for (const x of commits) if (next.columnAt(next.rowOf(x.sha)) !== before.get(x.sha)) moved++;
    expect(moved).toBe(0);
    expect(snapshot(next)).toEqual(snapshot(build(stream, { ...opts, headSha: 'n1' })));
  });

  it('omitted commits never become rows; changing omit disables reuse instead of corrupting it', () => {
    const cs = [c('s', ['b', 'i']), c('i', ['b']), c('b', ['r']), c('r')];
    const m = build(cs, { omit: ['s', 'i'] });
    expect(m.rowOf('s')).toBe(-1);
    expect(m.rowOf('i')).toBe(-1);
    expect(m.rowCount).toBe(2);
    const reused = GraphModel.rebuild(build(cs, {}), { omit: ['s', 'i'] });
    expect(snapshot(reused)).toEqual(snapshot(m));
  });

  it('firstParentChild finds the Shift+K target', () => {
    const m = build([c('a', ['b']), c('x', ['b']), c('m', ['r', 'b']), c('b', ['r']), c('r')]);
    expect(m.firstParentChild(m.rowOf('b'))).toBe(m.rowOf('x'));
    expect(m.firstParentChild(m.rowOf('r'))).toBe(m.rowOf('b'));
    expect(m.firstParentChild(m.rowOf('a'))).toBe(-1);
  });
});
