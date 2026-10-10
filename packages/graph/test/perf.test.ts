import { describe, expect, it } from 'vitest';

import {
  GraphModel,
  NORMAL_METRICS,
  drawGraph,
  groupRefPills,
  type GraphCanvasContext,
  type GraphCommitInput,
  type RefInput,
} from '../src';
import { mulberry32 } from './helpers';

/**
 * Synthetic monorepo-like history in date order: interleaved first-parent chains (steps of 1–3 rows)
 * with ~15% merge commits whose second parent is up to 40 rows older, and a few branch tips that
 * never merge. Average active lanes ≈ 10–25.
 */
function synthetic(n: number): GraphCommitInput[] {
  const rnd = mulberry32(1234);
  const out: GraphCommitInput[] = [];
  for (let i = 0; i < n; i++) {
    const p: string[] = [];
    const step = 1 + Math.floor(rnd() * 3);
    if (i + step < n) p.push(`c${i + step}`);
    const j = i + 4 + Math.floor(rnd() * 40);
    if (rnd() < 0.15 && j < n) p.push(`c${j}`);
    out.push({ sha: `c${i}`, parents: p, commitTime: n - i });
  }
  return out;
}

describe('performance', () => {
  it('lays out 100k commits in < 1500 ms (streamed in 5,000-commit pages)', () => {
    const commits = synthetic(100_000);
    const t0 = performance.now();
    const m = new GraphModel({ headSha: 'c0', wip: true });
    for (let i = 0; i < commits.length; i += 5000) m.append(commits.slice(i, i + 5000));
    m.finish();
    const layoutMs = performance.now() - t0;

    const t1 = performance.now();
    const reach = m.reachable(1);
    const reachMs = performance.now() - t1;

    const noop = () => undefined;
    const ctx = new Proxy(
      {},
      {
        get: (_t, p) => (p === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop),
        set: () => true,
      },
    );
    const t2 = performance.now();
    const frames = 200;
    for (let f = 0; f < frames; f++) {
      drawGraph(ctx as unknown as GraphCanvasContext, m, {
        scrollTop: f * 9973,
        width: 300,
        height: 1200,
        metrics: NORMAL_METRICS,
        colors: ['#f00', '#0f0'],
        highlight: reach,
      });
    }
    const frameMs = (performance.now() - t2) / frames;

    console.log(
      `layout ${m.rowCount} rows: ${layoutMs.toFixed(0)} ms, maxColumn ${m.maxColumn}; reach ${reachMs.toFixed(1)} ms; draw ${frameMs.toFixed(3)} ms/frame`,
    );
    expect(m.rowCount).toBe(100_001);
    expect(layoutMs).toBeLessThan(1500);
    expect(reachMs).toBeLessThan(100);
    expect(frameMs).toBeLessThan(8);
  });
});

/**
 * Benchmarks (spec 04 §7 step 26, §9). Thresholds are generous CI ceilings (≈3–5× the numbers measured on a
 * 2024 laptop); the measured numbers are printed and recorded in API.md "Performance".
 *
 * - 200k synthetic commits, streamed in 5,000-row pages: full layout < 3 s (spec §9: "finishes layout of
 *   all loaded rows in under 3 s"), first page < 100 ms (first paint budget is 500 ms incl. IPC).
 * - 1M synthetic commits: first page < 100 ms, full layout < 15 s. Skipped when `CI` is set unless
 *   `GRAPH_BENCH=1` (it allocates ~1 GB transiently).
 * - Convergence reuse: one new commit on top of a 100k layout re-lays out < 300 ms (spec §9).
 * - Ref-only change: regrouping 10k refs into pills < 150 ms (no relayout, §6.10 case 2).
 */
function layoutPaged(commits: GraphCommitInput[], page = 5000) {
  const m = new GraphModel({ headSha: 'c0', wip: true });
  const t0 = performance.now();
  m.append(commits.slice(0, page));
  const firstPageMs = performance.now() - t0;
  for (let i = page; i < commits.length; i += page) m.append(commits.slice(i, i + page));
  m.finish();
  return { m, firstPageMs, totalMs: performance.now() - t0 };
}

// Strict ceilings only in dedicated benchmark runs (GRAPH_BENCH=1); in the normal test run other
// packages compete for the CPU, so timings get 5x slack and the 1M case (≈1 GB) is skipped.
const heavy = process.env.GRAPH_BENCH === '1';
const slack = heavy ? 1 : 5;

describe('benchmarks', () => {
  it('200k commits: first page and full layout', () => {
    const commits = synthetic(200_000);
    const { m, firstPageMs, totalMs } = layoutPaged(commits);
    console.log(
      `[bench] 200k: first page ${firstPageMs.toFixed(1)} ms, full ${totalMs.toFixed(0)} ms, maxColumn ${m.maxColumn}`,
    );
    expect(m.rowCount).toBe(200_001);
    expect(firstPageMs).toBeLessThan(100 * slack);
    expect(totalMs).toBeLessThan(3000 * slack);
  });

  it.skipIf(!heavy)(
    '1M commits: first page and full layout',
    () => {
      const commits = synthetic(1_000_000);
      const heap0 = process.memoryUsage().heapUsed;
      const { m, firstPageMs, totalMs } = layoutPaged(commits);
      const heapMb = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;
      console.log(
        `[bench] 1M: first page ${firstPageMs.toFixed(1)} ms, full ${totalMs.toFixed(0)} ms, model heap ≈${heapMb.toFixed(0)} MB`,
      );
      expect(m.rowCount).toBe(1_000_001);
      expect(firstPageMs).toBeLessThan(100 * slack);
      expect(totalMs).toBeLessThan(15_000 * slack);
    },
    120_000,
  );

  it('convergence reuse: new commit on top of a 100k layout', () => {
    const commits = synthetic(100_000);
    const opts = { headSha: 'c0' };
    const old = new GraphModel(opts);
    old.append(commits, true);
    const stream = [{ sha: 'new', parents: ['c0'], commitTime: 1e12 }, ...commits];
    const t0 = performance.now();
    const next = new GraphModel({ headSha: 'new' }, old);
    // the git stream is cancelled once converged; feed pages until then
    for (let i = 0; i < stream.length && !next.converged; i += 2000) next.append(stream.slice(i, i + 2000));
    const ms = performance.now() - t0;
    console.log(`[bench] reuse after new commit (100k): ${ms.toFixed(1)} ms, converged=${next.converged}`);
    expect(next.converged).toBe(true);
    expect(next.rowCount).toBe(old.rowCount + 1);
    expect(ms).toBeLessThan(300 * slack);
  });

  it('ref-only change: regroup 10k refs into pills', () => {
    const refs: RefInput[] = [];
    for (let i = 0; i < 10_000; i++) {
      refs.push({ fullName: `refs/tags/t${i}`, shortName: `t${i}`, type: 'tag', sha: `c${i * 7}` });
    }
    const t0 = performance.now();
    const pills = groupRefPills(refs);
    const ms = performance.now() - t0;
    console.log(`[bench] groupRefPills 10k refs: ${ms.toFixed(1)} ms`);
    expect(pills.size).toBe(10_000);
    expect(ms).toBeLessThan(150 * slack);
  });
});
