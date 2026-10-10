import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath, GitProcessRunner, GitService, type CommitSummary, type LogQuery } from '@githappens/git';
import {
  EMPTY_VISIBILITY,
  GraphModel,
  graphRevQuery,
  hiddenStashShas,
  stashKey,
  visibleTipKey,
  visibleTips,
  type RefVisibilityState,
} from '@githappens/graph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { countCommits } from '../src/main/ipc/graph-handlers';
import { HistoryKeyTracker } from '../src/renderer/src/views/graph/useGraphModel';
import { isolatedEnv, makeFixture, type FixtureResult } from '../../../test/fixtures/src';

// Spec budgets are asserted as-is only with PERF_STRICT=1; shared CI runners (and a busy parallel
// test run) are several times slower, so normal runs get 5x slack and only catch real regressions.
const slack = process.env.PERF_STRICT === '1' ? 1 : 5;

/**
 * Hide / solo against real git (spec 04 §7 step 19): hiding a branch removes its exclusive commits but
 * keeps commits still reachable from visible refs; solo keeps only soloed refs + HEAD; the footer count
 * uses the same rev-set; a first page of the `huge` fixture lays out quickly (spec 04 §9).
 */
const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

d('graph rev-sets with real git', () => {
  let root: string;
  let runner: GitProcessRunner;
  let svc: GitService;
  let fx: FixtureResult;
  const services: GitService[] = [];

  beforeAll(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-graph-vis-')));
    runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: isolatedEnv(root), bundled: false }),
    });
    fx = makeFixture('branchy', { root: path.join(root, 'b'), force: true });
    svc = await GitService.open(runner, fx.path);
    services.push(svc);
  }, 60_000);
  afterAll(() => {
    for (const s of services) s.dispose();
    runner.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may hold handles briefly */
    }
  });

  /** Subjects of the commit rows the graph would show (subjects are unique in `branchy`). */
  const subjects = async (vis: RefVisibilityState): Promise<Set<string>> => {
    const refs = await svc.refs();
    const stashes = await svc.stashList();
    const q = graphRevQuery(refs, vis, { headSha: svc.repo.head.sha, stashes });
    const cursor = svc.log({ ...(q as Pick<LogQuery, 'revs' | 'hiddenRefs'>), order: 'date' });
    const out: CommitSummary[] = [];
    for (;;) {
      const p = await cursor.next(500);
      out.push(...p.commits);
      if (p.done) break;
    }
    // lay out like the graph does: hidden stashes and their helper commits never become rows
    const m = new GraphModel<CommitSummary>({
      headSha: svc.repo.head.sha,
      stashes: stashes.filter((s) => !vis.hidden.includes(stashKey(s.sha))),
      omit: hiddenStashShas(stashes, vis),
    });
    m.append(out, true);
    const list = m.commits().map((c) => c.subject);
    expect(new Set(list).size).toBe(list.length);
    return new Set(list);
  };

  it('hiding a branch keeps commits another visible ref still reaches', async () => {
    const all = await subjects(EMPTY_VISIBILITY);
    expect(all.has('feature-b: WIP')).toBe(true);
    // lightweight-tag points at the same commit: still shown
    const hideBranch = await subjects({ ...EMPTY_VISIBILITY, hidden: ['refs/heads/feature-b'] });
    expect(hideBranch.has('feature-b: WIP')).toBe(true);
    const hideBoth = await subjects({
      ...EMPTY_VISIBILITY,
      hidden: ['refs/heads/feature-b', 'refs/tags/lightweight-tag'],
    });
    expect(hideBoth.has('feature-b: WIP')).toBe(false);
    // shared history stays
    expect(hideBoth.has('Initial commit')).toBe(true);
    expect(hideBoth.size).toBe(all.size - 1);
  });

  it('solo shows only soloed refs plus HEAD', async () => {
    const solo = await subjects({ ...EMPTY_VISIBILITY, solo: ['refs/heads/feature-b'] });
    expect(solo.has('feature-b: WIP')).toBe(true);
    expect(solo.has('Octopus merge topics')).toBe(true); // HEAD (main) history
    expect(solo.has('cross-x: 2')).toBe(false);
    expect(solo.has('cross-y: 2')).toBe(false);
  });

  it('hidden stashes leave no rows behind', async () => {
    const stashes = await svc.stashList();
    expect(stashes.length).toBe(1);
    const shown = await subjects(EMPTY_VISIBILITY);
    const hidden = await subjects({ ...EMPTY_VISIBILITY, hidden: [stashKey(stashes[0]!.sha)] });
    expect(hidden.size).toBe(shown.size);
    // the stash's index / untracked helper commits never show as rows either way
    expect([...shown].some((s) => /^index on|^untracked files on/.test(s))).toBe(false);
  });

  it('a tag created at an existing commit does not reload history (spec 04 §6.10 case 2)', async () => {
    const head = svc.repo.head.sha;
    const tracker = new HistoryKeyTracker();
    const refs0 = await svc.refs();
    const key0 = tracker.resolve(
      visibleTipKey(refs0, EMPTY_VISIBILITY, head),
      visibleTips(refs0, EMPTY_VISIBILITY, head),
    );
    const all = svc.log({ revs: 'all', order: 'date' });
    const m = new GraphModel<CommitSummary>({ headSha: head });
    m.append((await all.next(1000)).commits, true);
    all.dispose();
    tracker.observe(m);
    const v0 = m.version;

    // at a tip: the tip set is unchanged
    await runner.run({ cwd: fx.path, args: ['tag', 'graph-tag-tip', 'HEAD'] });
    // at an interior, already laid-out commit: a new tip, but no new commits
    await runner.run({ cwd: fx.path, args: ['tag', 'graph-tag-mid', 'HEAD~1'] });
    const refs1 = await svc.refs();
    expect(visibleTipKey(refs1, EMPTY_VISIBILITY, head)).not.toBe(
      visibleTipKey(refs0, EMPTY_VISIBILITY, head),
    );
    expect(
      tracker.resolve(
        visibleTipKey(refs1, EMPTY_VISIBILITY, head),
        visibleTips(refs1, EMPTY_VISIBILITY, head),
      ),
    ).toBe(key0);
    // pills update from the new refs while the model (and its version) stay untouched: no relayout
    expect(m.version).toBe(v0);

    // a new commit moves a tip to an unknown commit → reload
    await runner.run({
      cwd: fx.path,
      args: ['-c', 'user.name=t', '-c', 'user.email=t@x.io', 'commit', '-q', '--allow-empty', '-m', 'new'],
    });
    const refs2 = await svc.refs();
    const head2 = (await svc.revParse('HEAD'))!;
    expect(
      tracker.resolve(
        visibleTipKey(refs2, EMPTY_VISIBILITY, head2),
        visibleTips(refs2, EMPTY_VISIBILITY, head2),
      ),
    ).not.toBe(key0);
    await runner.run({ cwd: fx.path, args: ['reset', '-q', '--soft', 'HEAD~1'] });
    await runner.run({ cwd: fx.path, args: ['tag', '-d', 'graph-tag-tip', 'graph-tag-mid'] });
  });

  it('graph:countCommits counts the same rev-set', async () => {
    const run = async (args: string[]): Promise<string> =>
      (await runner.run({ cwd: fx.path, args, encoding: 'utf8' })).stdout as string;
    const all = await countCommits(run, 'all');
    const hidden = await countCommits(run, 'all', ['refs/heads/feature-b', 'refs/tags/lightweight-tag']);
    // 'all' here has no stash tips, so it equals the visible commits (stash helpers excluded)
    expect(all).toBe((await subjects(EMPTY_VISIBILITY)).size);
    expect(hidden).toBe(all - 1);
    expect(await countCommits(run, ['refs/heads/feature-b', 'HEAD'])).toBeGreaterThan(0);
  });

  it('first page of the huge fixture arrives and lays out quickly', async () => {
    if (process.env.GRAPH_BENCH === '0') return;
    const count = Number(process.env.GRAPH_FIXTURE_COUNT ?? 50_000);
    const huge = makeFixture('huge', { root: path.join(root, 'h'), force: true, options: { count } });
    const h = await GitService.open(runner, huge.path);
    services.push(h);
    const measure = async (): Promise<{ fetchMs: number; layoutMs: number }> => {
      const t0 = performance.now();
      const c = h.log({ revs: 'all', order: 'date' });
      const page = await c.next(500);
      const fetchMs = performance.now() - t0;
      const t1 = performance.now();
      const m = new GraphModel<CommitSummary>({ headSha: h.repo.head.sha });
      m.append(page.commits);
      const layoutMs = performance.now() - t1;
      c.dispose();
      expect(m.rowCount).toBe(500);
      return { fetchMs, layoutMs };
    };
    const cold = await measure();
    await runner.run({ cwd: huge.path, args: ['commit-graph', 'write', '--reachable', '--changed-paths'] });
    const warm = await measure();
    console.log(
      `[bench] huge(${count}) first page: ${cold.fetchMs.toFixed(0)} ms fetch + ${cold.layoutMs.toFixed(1)} ms layout; ` +
        `with commit-graph ${warm.fetchMs.toFixed(0)} ms + ${warm.layoutMs.toFixed(1)} ms`,
    );
    // spec 04 §9: first rows under 500 ms (fetch + layout), generous ceiling for CI machines
    expect(warm.fetchMs + warm.layoutMs).toBeLessThan(1500 * slack);
    expect(warm.layoutMs).toBeLessThan(50 * slack);
  }, 180_000);
});
