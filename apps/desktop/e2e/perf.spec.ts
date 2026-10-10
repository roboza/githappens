import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type CDPSession, type Page } from '@playwright/test';

import {
  appDir,
  benchCache,
  cachedFixture,
  closeApp,
  commandTimeline,
  GRID,
  launchApp,
  percentile,
  setSetting,
  writeResults,
  type Session,
} from './perf-utils';

/**
 * Graph / renderer performance (spec 15 §7 "Perf", spec 04 §9, spec 02 §9). Opt-in: GH_PERF=1.
 * Thresholds are asserted only with GH_PERF_STRICT=1 (nightly CI); otherwise they are logged.
 *
 * - first graph paint on the `huge` fixture (200k commits, commit-graph) and, when built, on `huge-1m`
 * - fling-scroll through every loaded row: main-thread work per frame from a Chromium trace
 *   (p95 < 16 ms, spec 15; spec 04 targets 8 ms), rAF intervals, blank-row check
 * - renderer JS heap < 400 MB (spec 04 §7 step 26)
 * - external file change → WIP row latency, p95 < 500 ms (spec 02 §9)
 */

const enabled = process.env.GH_PERF === '1';
const strict = process.env.GH_PERF_STRICT === '1';

test.skip(!enabled, 'perf suite: set GH_PERF=1');
test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);

const report: string[] = [];
function check(name: string, value: number, limit: number, unit = 'ms', source = ''): void {
  const ok = value <= limit;
  report.push(
    `${ok ? 'ok' : '!!'} ${name.padEnd(44)} ${value.toFixed(1).padStart(9)} ${unit} (≤ ${limit}) ${source}`,
  );
  if (strict) expect.soft(value, `${name} (${source})`).toBeLessThanOrEqual(limit);
}
function info(name: string, value: number, unit = 'ms', note = ''): void {
  report.push(`   ${name.padEnd(44)} ${value.toFixed(1).padStart(9)} ${unit} ${note}`);
}
test.afterAll(() => {
  console.log(`\nPerf e2e (${process.platform}${strict ? ', strict' : ''}):\n  ${report.join('\n  ')}`);
});

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string };
}

async function startTrace(cdp: CDPSession): Promise<() => Promise<TraceEvent[]>> {
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (e) => {
    events.push(...(e.value as unknown as TraceEvent[]));
  });
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: ['toplevel', 'blink.user_timing', 'devtools.timeline', '__metadata'],
    },
  });
  return async () => {
    const done = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end');
    await done;
    return events;
  };
}

/** Top-level task event (renamed across Chromium versions). */
const TASK_EVENTS = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);

/**
 * Main-thread busy time per frame: frames are delimited by our own `kl-frame` user-timing marks (one per
 * rAF), busy time is the overlap of top-level `RunTask`s on that thread with each frame interval.
 */
function busyPerFrame(events: TraceEvent[]): number[] {
  const marks = events.filter((e) => e.name === 'kl-frame');
  if (marks.length < 3) return [];
  const { pid, tid } = marks[0]!;
  const ts = marks.map((m) => m.ts).sort((a, b) => a - b);
  const tasks = events
    .filter((e) => e.ph === 'X' && TASK_EVENTS.has(e.name) && e.pid === pid && e.tid === tid && e.dur)
    .map((e) => [e.ts, e.ts + e.dur!] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  // union of (possibly nested) task intervals
  const merged: [number, number][] = [];
  for (const t of tasks) {
    const top = merged[merged.length - 1];
    if (top && t[0] <= top[1]) top[1] = Math.max(top[1], t[1]);
    else merged.push([...t]);
  }
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i + 1 < ts.length; i++) {
    const [a, b] = [ts[i]!, ts[i + 1]!];
    while (k < merged.length && merged[k]![1] <= a) k++;
    let busy = 0;
    for (let j = k; j < merged.length && merged[j]![0] < b; j++) {
      busy += Math.max(0, Math.min(b, merged[j]![1]) - Math.max(a, merged[j]![0]));
    }
    out.push(busy / 1000);
  }
  return out;
}

interface ScrollStats {
  frames: number;
  rafDeltas: number[];
  blankFrames: number;
  maxGapPx: number;
  /** Frames whose painted rows lag the scroll position by 2+ frames (1 frame is React's normal lag). */
  staleFrames: number;
  /** Histogram: painted rows lag the scroll position by N frames (index N; last bucket = more). */
  lagHistogram: number[];
  rowsVisited: number;
}

/** Scroll the graph `pxPerFrame` every animation frame for `frames` frames (bouncing at the ends). */
async function fling(page: Page, frames: number, pxPerFrame: number): Promise<ScrollStats> {
  return page.evaluate(
    async ({ sel, frames, pxPerFrame }) => {
      const el = document.querySelector(sel) as HTMLElement;
      const rowH = (el.querySelector('[role="row"]') as HTMLElement).getBoundingClientRect().height;
      const max = el.scrollHeight - el.clientHeight;
      const s = {
        frames: 0,
        rafDeltas: [] as number[],
        blankFrames: 0,
        maxGapPx: 0,
        staleFrames: 0,
        lagHistogram: [0, 0, 0, 0],
        rowsVisited: 0,
      };
      const hist: number[] = [];
      let dir = 1;
      let last = 0;
      const seen = new Set<number>();
      await new Promise<void>((resolve) => {
        const step = (ts: number): void => {
          performance.mark('kl-frame');
          if (last) s.rafDeltas.push(ts - last);
          last = ts;
          // what is on screen now (painted for the previous scroll position)
          const r = el.getBoundingClientRect();
          let y = r.top;
          let gap = 0;
          let firstIdx = Infinity;
          const boxes = [...el.querySelectorAll<HTMLElement>('[role="row"]')]
            .map((n) => ({ b: n.getBoundingClientRect(), i: Number(n.getAttribute('aria-rowindex')) - 1 }))
            .filter(({ b }) => b.bottom > r.top + 0.5 && b.top < r.bottom - 0.5)
            .sort((a, b) => a.b.top - b.b.top);
          for (const { b, i } of boxes) {
            if (b.top > y + 1) gap = Math.max(gap, b.top - y);
            y = Math.max(y, b.bottom);
            firstIdx = Math.min(firstIdx, i);
            seen.add(i);
          }
          const atEnd = el.scrollTop >= max - rowH;
          if (!atEnd && y < r.bottom - 1) gap = Math.max(gap, r.bottom - y);
          if (gap > 1) s.blankFrames++;
          s.maxGapPx = Math.max(s.maxGapPx, gap);
          if (hist.length) {
            let lag = 0;
            while (lag < hist.length && Math.abs(hist[hist.length - 1 - lag]! - firstIdx) > 1) lag++;
            const bucket = Math.min(lag, s.lagHistogram.length - 1);
            s.lagHistogram[bucket]!++;
            if (lag >= 2) s.staleFrames++;
          }
          if (s.frames++ >= frames) {
            s.rowsVisited = seen.size;
            resolve();
            return;
          }
          let next = el.scrollTop + dir * pxPerFrame;
          if (next >= max || next <= 0) {
            dir = -dir;
            next = Math.max(0, Math.min(max, next));
          }
          el.scrollTop = next;
          hist.push(Math.floor(el.scrollTop / rowH));
          if (hist.length > 8) hist.shift();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      return s;
    },
    { sel: GRID, frames, pxPerFrame },
  );
}

/** Renderer boot milestones (ms since navigation start). */
async function rendererMilestones(s: Session): Promise<{ domContentLoaded: number; fcp: number }> {
  return s.page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { domContentLoaded: nav?.domContentLoadedEventEnd ?? NaN, fcp: fcp?.startTime ?? NaN };
  });
}

async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  return usedSize / 2 ** 20;
}

async function rendererWorkingSetMb(s: Session): Promise<number> {
  const metrics = await s.app.evaluate(({ app }) => app.getAppMetrics());
  const tabs = metrics.filter((m) => m.type === 'Tab');
  return Math.max(0, ...tabs.map((m) => m.memory.workingSetSize / 1024));
}

// ---------------------------------------------------------------------------

test.describe('huge fixture (200k commits)', () => {
  let s: Session | undefined;
  let repo = '';
  test.beforeAll(() => {
    repo = cachedFixture('huge');
  });
  test.afterAll(async () => {
    await closeApp(s);
    fs.rmSync(path.join(repo, 'kl-perf-probe.txt'), { force: true });
  });

  test('first graph paint', async () => {
    s = await launchApp(repo);
    check('huge: first rows (renderer, since navigation)', s.rendererFirstRowsMs, 2000, 'ms', 'spec 15 §7');
    info(
      'huge: first rows target (spec 04 §9)',
      500,
      'ms',
      `measured ${s.rendererFirstRowsMs.toFixed(0)} ms`,
    );
    info('huge: launch → first rows (incl. Electron boot)', s.launchToRowsMs);
    await expect(s.page.locator(GRID).getByRole('row').first()).toBeVisible();
    const timeline = await commandTimeline(s, repo, s.launchToRowsMs);
    console.log(['git commands before the first rows (huge):', ...timeline].join('\n  '));
    const boot = await rendererMilestones(s);
    info('renderer: DOMContentLoaded', boot.domContentLoaded);
    info('renderer: first contentful paint', boot.fcp);
    const firstGit = Number(/^\+\s*(\d+)/.exec(timeline.find((l) => l.includes('[repo]')) ?? '')?.[1] ?? NaN);
    info('launch → first git command for the repo', firstGit);
    info('first git command → first rows', s.launchToRowsMs - firstGit, 'ms', 'repo pipeline only');
    writeResults('huge.firstPaint', {
      boot,
      firstGitCommandMs: firstGit,
      timeline,
      rendererFirstRowsMs: s.rendererFirstRowsMs,
      launchToRowsMs: s.launchToRowsMs,
    });
  });

  test('load all rows, then fling-scroll with no blank rows', async () => {
    const { page } = s!;
    const grid = page.locator(GRID);
    // "Show all commits" (spec 13) streams every page; aria-rowcount is set once history is done.
    const t0 = Date.now();
    await setSetting(page, 'general.showAllCommits', true);
    await expect(grid).not.toHaveAttribute('aria-rowcount', '-1', { timeout: 5 * 60_000 });
    const loadAllMs = Date.now() - t0;
    const rowCount = Number(await grid.getAttribute('aria-rowcount'));
    expect(rowCount).toBeGreaterThanOrEqual(200_000);
    info('huge: load + lay out all rows (limit=all)', loadAllMs, 'ms', 'spec 04 §9 layout target 3000 ms');

    const cdp = await page.context().newCDPSession(page);
    const heapLoaded = await heapMb(cdp);
    const displayFrame = percentile((await fling(page, 60, 0)).rafDeltas, 50);

    // spec 04 §9 "maximum fling speed": ~140 rows per frame; plus a wheel-speed pass (~4 rows per frame)
    const phases = { fling: 4000, wheel: 120 } as const;
    const measured: Record<string, { stats: ScrollStats; busy: number[] }> = {};
    for (const [name, px] of Object.entries(phases)) {
      const stop = await startTrace(cdp);
      const stats = await fling(page, name === 'fling' ? 600 : 300, px);
      const events = await stop();
      if (process.env.GH_PERF_TRACE === '1') {
        // ~80 MB; open in https://ui.perfetto.dev or chrome://tracing
        fs.mkdirSync(path.join(appDir, 'test-results'), { recursive: true });
        fs.writeFileSync(
          path.join(appDir, 'test-results', `perf-${name}-trace.json`),
          JSON.stringify({ traceEvents: events }),
        );
      }
      measured[name] = { stats, busy: busyPerFrame(events) };
    }
    info('display frame interval (idle rAF)', displayFrame);
    for (const [name, { stats, busy }] of Object.entries(measured)) {
      if (busy.length) {
        const p95 = percentile(busy, 95);
        if (name === 'fling') check(`${name}: main-thread work per frame p95`, p95, 16, 'ms', 'spec 15 §7');
        else info(`${name}: main-thread work per frame p95`, p95, 'ms', '(spec 15: < 16 ms)');
        info(
          `${name}: work per frame p95 vs 8 ms target`,
          p95,
          'ms',
          p95 <= 8 ? 'meets spec 04 §9' : 'over spec 04 §9 (8 ms)',
        );
        info(
          `${name}: work per frame p50 / max`,
          percentile(busy, 50),
          'ms',
          `max ${Math.max(...busy).toFixed(1)} ms`,
        );
      } else if (name === 'fling') {
        // tracing unavailable: fall back to rAF intervals (vsync-quantized)
        const p95 = percentile(stats.rafDeltas, 95);
        check(
          `${name}: rAF interval p95 (no trace)`,
          p95,
          Math.max(16, displayFrame * 1.2),
          'ms',
          'spec 15 §7',
        );
      }
      info(`${name}: rAF interval p95`, percentile(stats.rafDeltas, 95));
      info(
        `${name}: frames with rows ≥ 2 frames behind`,
        (100 * stats.staleFrames) / stats.frames,
        '%',
        `lag histogram [0,1,2,3+] = ${JSON.stringify(stats.lagHistogram)}`,
      );
      info(`${name}: distinct rows painted`, stats.rowsVisited, 'rows');
      check(`${name}: frames with blank rows`, stats.blankFrames, 0, 'frames', 'spec 04 §9');
    }

    const heapAfter = await heapMb(cdp);
    const ws = await rendererWorkingSetMb(s!);
    check('renderer JS heap after scroll (200k loaded)', heapAfter, 400, 'MB', 'spec 04 §7 step 26');
    info('renderer JS heap after load-all', heapLoaded, 'MB');
    info('renderer process working set', ws, 'MB');
    const summary = (busy: number[]) =>
      busy.length
        ? {
            p50: percentile(busy, 50),
            p95: percentile(busy, 95),
            max: Math.max(...busy),
            frames: busy.length,
          }
        : null;
    writeResults('huge.scroll', {
      rowCount,
      loadAllMs,
      displayFrameMs: displayFrame,
      phases: Object.fromEntries(
        Object.entries(measured).map(([name, { stats, busy }]) => [
          name,
          {
            pxPerFrame: phases[name as keyof typeof phases],
            workPerFrameMs: summary(busy),
            rafIntervalMs: { p50: percentile(stats.rafDeltas, 50), p95: percentile(stats.rafDeltas, 95) },
            blankFrames: stats.blankFrames,
            maxGapPx: stats.maxGapPx,
            lagHistogram: stats.lagHistogram,
            rowsVisited: stats.rowsVisited,
          },
        ]),
      ),
      heapMb: { loaded: heapLoaded, afterScroll: heapAfter },
      rendererWorkingSetMb: ws,
    });
    // Blank rows are a correctness bug, not a timing: always enforced.
    for (const [name, { stats }] of Object.entries(measured)) {
      expect(stats.blankFrames, `${name}: blank frames (max gap ${stats.maxGapPx}px)`).toBe(0);
    }
    await cdp.detach();
  });

  test('external file change reaches the WIP row', async () => {
    const { page } = s!;
    await page.locator(GRID).evaluate((el) => (el.scrollTop = 0));
    const wip = page.locator(`${GRID} [role="row"][aria-label="Work in progress"]`);
    const probe = path.join(repo, 'kl-perf-probe.txt');
    const show: number[] = [];
    const hide: number[] = [];
    for (let i = 0; i < 10; i++) {
      let t0 = Date.now();
      fs.writeFileSync(probe, `probe ${i}\n`);
      await expect(wip).toBeVisible({ timeout: 10_000 });
      show.push(Date.now() - t0);
      t0 = Date.now();
      fs.rmSync(probe, { force: true });
      await expect(wip).toHaveCount(0, { timeout: 10_000 });
      hide.push(Date.now() - t0);
      await page.waitForTimeout(400);
    }
    check('WIP row appears after external save (p95)', percentile(show, 95), 500, 'ms', 'spec 02 §9');
    info('WIP row appears (p50)', percentile(show, 50));
    info('WIP row disappears after delete (p95)', percentile(hide, 95));
    writeResults('huge.wip', { showMs: show, hideMs: hide, p95: percentile(show, 95) });
  });
});

const million = path.join(benchCache, 'huge-1m');
const haveMillion = fs.existsSync(path.join(million, '.git')) || process.env.GH_PERF_1M === '1';

test.describe('1M-commit repo', () => {
  test.skip(!haveMillion, 'build it with `pnpm bench --only=million` (or set GH_PERF_1M=1)');
  let s: Session | undefined;
  test.afterAll(async () => closeApp(s));

  test('first graph paint < 2 s', async () => {
    const repo = cachedFixture('huge-1m');
    s = await launchApp(repo);
    check(
      '1M: first rows (renderer, since navigation)',
      s.rendererFirstRowsMs,
      2000,
      'ms',
      'spec 15 §7 / spec 04 §9',
    );
    info('1M: launch → first rows (incl. Electron boot)', s.launchToRowsMs);
    const timeline = await commandTimeline(s, repo, s.launchToRowsMs);
    console.log(['git commands before the first rows (1M):', ...timeline].join('\n  '));
    const cdp = await s.page.context().newCDPSession(s.page);
    const heap = await heapMb(cdp);
    check('1M: renderer JS heap after first page', heap, 400, 'MB', 'spec 04 §7 step 26');
    await cdp.detach();
    writeResults('million.firstPaint', {
      rendererFirstRowsMs: s.rendererFirstRowsMs,
      launchToRowsMs: s.launchToRowsMs,
      heapMb: heap,
      timeline,
    });
  });
});
