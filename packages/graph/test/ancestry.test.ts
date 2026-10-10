import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type GhostCandidate } from '../src';
import { build, c, randomHistory } from './helpers';

function bruteReach(commits: { sha: string; parents: readonly string[] }[], tip: string): Set<string> {
  const bySha = new Map(commits.map((x) => [x.sha, x]));
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const s = stack.pop()!;
    if (out.has(s) || !bySha.has(s)) continue;
    out.add(s);
    stack.push(...bySha.get(s)!.parents);
  }
  return out;
}

describe('ancestry highlight (§6.6)', () => {
  it('matches brute-force reachability on random DAGs', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 120 }), fc.nat(), (seed, n, pick) => {
        const { commits } = randomHistory(seed, n, false);
        const m = build(commits);
        const tip = commits[pick % commits.length]!.sha;
        const mark = m.reachable(tip);
        const expected = bruteReach(commits, tip);
        for (let r = 0; r < m.rowCount; r++) expect(mark[r] === 1).toBe(expected.has(m.shaAt(r)!));
        // edges are highlighted iff their owner row is reachable: owner reachable ⇒ both endpoints reachable
        for (const e of m.edgesInRange(0, m.rowCount)) {
          if (mark[e.owner] && e.gap + 1 < m.rowCount && e.to === m.columnAt(e.gap + 1)) {
            expect(mark[e.gap + 1]).toBe(1);
          }
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it('is cached per tip sha and invalidated by appends', () => {
    const m = build([c('a', ['b']), c('b', ['c'])], {}, [], false);
    const r1 = m.reachable('a');
    expect(m.reachable(0)).toBe(r1);
    expect([...r1]).toEqual([1, 1]);
    m.append([c('c')], true);
    const r2 = m.reachable('a');
    expect(r2).not.toBe(r1);
    expect([...r2]).toEqual([1, 1, 1]);
    expect([...m.reachable('missing')]).toEqual([0, 0, 0]);
  });

  it('stash rows reach their base; WIP reaches HEAD history', () => {
    const m = build([c('h', ['b'], 30), c('b', [], 10)], {
      headSha: 'h',
      wip: true,
      stashes: [{ sha: 'S', parents: ['b', 'i'], time: 20 }],
    });
    expect([...m.reachable('WIP')]).toEqual([1, 1, 0, 1]);
    expect([...m.reachable('S')]).toEqual([0, 0, 1, 1]);
  });
});

describe('ghost branch (§6.7)', () => {
  //   t1 (feature)   main
  //    |              m
  //    x              |
  //     \____ base ___/
  const commits = [c('m', ['base']), c('t1', ['x']), c('x', ['base']), c('base', ['root']), c('root')];
  const refs: Record<string, GhostCandidate[]> = {
    m: [{ name: 'main', head: true }],
    t1: [{ name: 'feature' }, { name: 'origin/feature', remote: true }],
  };

  it('finds the nearest descendant branch tip by child hops', () => {
    const m = build(commits);
    const at = (r: number) => refs[m.shaAt(r)!];
    expect(m.nearestBranch(m.rowOf('x'), at)).toMatchObject({ ref: { name: 'feature' }, distance: 1 });
    // base: both tips at distance 1 vs 2 → main (1 hop) wins
    expect(m.nearestBranch(m.rowOf('base'), at)).toMatchObject({ ref: { name: 'main' }, distance: 1 });
    expect(m.nearestBranch(m.rowOf('m'), at)).toMatchObject({ distance: 0 });
  });

  it('breaks ties: local before remote, then HEAD branch, then alphabetical', () => {
    const m = build([c('a', ['p']), c('b', ['p']), c('p')]);
    const tie: Record<string, GhostCandidate[]> = {
      a: [{ name: 'zeta' }, { name: 'origin/alpha', remote: true }],
      b: [{ name: 'beta' }],
    };
    expect(m.nearestBranch(2, (r) => tie[m.shaAt(r)!])).toMatchObject({ ref: { name: 'beta' } });
    tie.a!.push({ name: 'zz-head', head: true });
    expect(m.nearestBranch(2, (r) => tie[m.shaAt(r)!])).toMatchObject({ ref: { name: 'zz-head' } });
  });

  it('caps the walk and reports it; returns null when no branch is found', () => {
    const chain = Array.from({ length: 50 }, (_, i) => c(`c${i}`, i < 49 ? [`c${i + 1}`] : []));
    const m = build(chain);
    expect(m.nearestBranch(49, () => null)).toBeNull();
    expect(m.nearestBranch(49, (r) => (r === 0 ? [{ name: 'main' }] : null), 10)).toEqual({ capped: true });
    expect(m.nearestBranch(49, (r) => (r === 0 ? [{ name: 'main' }] : null))).toMatchObject({
      row: 0,
      distance: 49,
    });
  });
});
