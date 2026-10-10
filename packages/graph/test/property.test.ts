import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { GraphModel, NodeKind, WIP_SHA } from '../src';
import { build, checkInvariants, randomHistory, snapshot } from './helpers';

const historyArb = fc.record({ seed: fc.integer(), n: fc.integer({ min: 0, max: 90 }) });

describe('lane layout — properties on random DAGs', () => {
  it('structural invariants hold (no overlaps, no sideways shifts, every loaded link drawn)', () => {
    fc.assert(
      fc.property(historyArb, ({ seed, n }) => {
        const { commits, options } = randomHistory(seed, n);
        const m = build(commits, options);
        const errs = checkInvariants(m);
        if (errs.length) throw new Error(`seed=${seed} n=${n}\n${errs.slice(0, 5).join('\n')}`);
      }),
      { numRuns: 10_000 },
    );
  });

  it('HEAD first-parent chain is a straight line in lane 0; stashes sit above their base', () => {
    fc.assert(
      fc.property(historyArb, ({ seed, n }) => {
        const { commits, options } = randomHistory(seed, n);
        const m = build(commits, options);
        if (options.wip && m.nodeKindAt(0) !== NodeKind.Conflict && options.headSha) {
          expect(m.shaAt(0)).toBe(WIP_SHA);
          expect(m.columnAt(0)).toBe(0);
        }
        let r = options.headSha ? m.rowOf(options.headSha) : -1;
        while (r >= 0) {
          expect(m.columnAt(r)).toBe(0);
          r = m.firstParentRow(r);
        }
        for (const s of options.stashes ?? []) {
          const base = m.rowOf(s.parents[0]!);
          expect(m.rowOf(s.sha)).toBeGreaterThanOrEqual(0);
          if (base >= 0) expect(m.rowOf(s.sha)).toBeLessThan(base);
          expect(m.rowOf(s.parents[1]!)).toBe(-1);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(historyArb, ({ seed, n }) => {
        const { commits, options } = randomHistory(seed, n);
        expect(snapshot(build(commits, options))).toEqual(snapshot(build(commits, options)));
      }),
      { numRuns: 500 },
    );
  });

  it('appending in pages equals one-shot layout', () => {
    fc.assert(
      fc.property(
        historyArb,
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 6 }),
        ({ seed, n }, pages) => {
          const { commits, options } = randomHistory(seed, n);
          expect(snapshot(build(commits, options, pages))).toEqual(snapshot(build(commits, options)));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('convergence reuse (§6.10) gives the same result as a full relayout', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 20, max: 300 }),
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 100 }),
        (seed, n, extra, oldDone, cutPct) => {
          const { commits, options } = randomHistory(seed, n);
          const opts = {
            ...options,
            colorMode: 'column' as const,
            checkpointInterval: 8,
            convergenceVerify: 4,
          };
          const cut = Math.floor((commits.length * cutPct) / 100);
          const old = build(commits.slice(0, oldDone ? commits.length : cut), opts, [], oldDone);
          // new commits on top of the first commit, plus (sometimes) a WIP toggle
          const top = Array.from({ length: extra }, (_, i) => ({
            sha: `new${i}`,
            parents: [i + 1 < extra ? `new${i + 1}` : (commits[0]?.sha ?? 'none')],
            commitTime: 1e9 - i,
          }));
          const newOpts = { ...opts, wip: extra % 2 === 0 ? opts.wip : !opts.wip };
          const stream = [...top, ...commits];
          const full = build(stream, newOpts);
          const reused = new GraphModel(newOpts, old);
          reused.append(stream.slice(0, 60));
          reused.append(stream.slice(60), true);
          expect(snapshot(reused)).toEqual(snapshot(full));
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('convergence reuse', () => {
  it('adopts the old tail after a new commit on top', () => {
    const { commits, options } = randomHistory(42, 3000, false);
    const opts = { ...options, headSha: 'c0', checkpointInterval: 64, convergenceVerify: 16 };
    const old = build(commits, opts);
    const stream = [{ sha: 'n', parents: ['c0'], commitTime: 1e9 }, ...commits];
    const reused = new GraphModel({ ...opts, headSha: 'n' }, old);
    reused.append(stream, true);
    expect(reused.converged).toBe(true);
    expect(snapshot(reused)).toEqual(snapshot(build(stream, { ...opts, headSha: 'n' })));
    // appending after adoption keeps working
    const more = new GraphModel({ ...opts, headSha: 'n' }, build(commits.slice(0, 2000), opts, [], false));
    more.append(stream.slice(0, 1500));
    more.append(stream.slice(1500), true);
    expect(more.converged).toBe(true);
    expect(snapshot(more)).toEqual(snapshot(build(stream, { ...opts, headSha: 'n' })));
  });

  it('GraphModel.rebuild toggles the WIP row reusing the old layout', () => {
    const { commits } = randomHistory(7, 2000, false);
    const opts = { headSha: 'c0', checkpointInterval: 32, convergenceVerify: 8 };
    const old = build(commits, opts);
    const withWip = GraphModel.rebuild(old, { ...opts, wip: true });
    expect(withWip.shaAt(0)).toBe(WIP_SHA);
    expect(withWip.converged).toBe(true);
    expect(snapshot(withWip)).toEqual(snapshot(build(commits, { ...opts, wip: true })));
  });
});
