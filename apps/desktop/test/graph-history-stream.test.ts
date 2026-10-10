import { describe, expect, it } from 'vitest';

import { streamPages } from '../src/renderer/src/views/graph/history-stream';

/** A fake `git:log:next` cursor over `total` commits that records requests and in-flight overlap. */
function fakeCursor(total: number) {
  let delivered = 0;
  let inFlight = 0;
  const sizes: number[] = [];
  let maxInFlight = 0;
  const next = async (pageSize: number) => {
    sizes.push(pageSize);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const n = Math.min(pageSize, total - delivered);
    const commits = Array.from({ length: n }, (_, i) => ({ sha: String(delivered + i) }));
    delivered += n;
    const done = delivered >= total;
    return { commits: commits as never[], cursor: done ? null : 'c1', done };
  };
  return {
    next,
    sizes,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

describe('streamPages (useHistory pipelined paging)', () => {
  it('streams everything in order with growing pages', async () => {
    const src = fakeCursor(50_000);
    const got: string[] = [];
    await streamPages({
      next: src.next,
      isCurrent: () => true,
      onPage: (p) => got.push(...p.commits.map((c: { sha: string }) => c.sha)),
      want: () => Number.MAX_SAFE_INTEGER,
      firstSize: 2000,
      maxSize: 20_000,
    });
    expect(got).toHaveLength(50_000);
    expect(got.every((s, i) => s === String(i))).toBe(true);
    expect(src.sizes.slice(0, 5)).toEqual([2000, 4000, 8000, 16000, 20000]);
    expect(src.maxInFlight).toBe(1); // serialized per cursor, next request sent as soon as a page lands
  });

  it('stops when nothing more is wanted and never drops a requested page', async () => {
    const src = fakeCursor(100_000);
    let count = 0;
    await streamPages({
      next: src.next,
      isCurrent: () => true,
      onPage: (p) => (count += p.commits.length),
      want: () => Math.max(0, 5000 - count),
      firstSize: 2000,
      maxSize: 20_000,
    });
    expect(count).toBe(5000);
    expect(src.sizes).toEqual([2000, 3000]);
  });

  it('a single page (Load more)', async () => {
    const src = fakeCursor(10_000);
    let count = 0;
    await streamPages({
      next: src.next,
      isCurrent: () => true,
      onPage: (p) => (count += p.commits.length),
      want: () => 0,
      firstSize: 2000,
    });
    expect(count).toBe(2000);
    expect(src.sizes).toEqual([2000]);
  });

  it('drops pages once the stream was restarted', async () => {
    const src = fakeCursor(10_000);
    let current = true;
    let pages = 0;
    await streamPages({
      next: src.next,
      isCurrent: () => current,
      onPage: () => {
        pages++;
        current = false;
      },
      want: () => Number.MAX_SAFE_INTEGER,
      firstSize: 1000,
    });
    expect(pages).toBe(1);
  });
});
