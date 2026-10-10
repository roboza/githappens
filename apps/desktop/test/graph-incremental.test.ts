import { GraphModel, visibleTips, type VisibleTips } from '@githappens/graph';
import type { CommitSummary, RepoInfo } from '@githappens/git/types';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { refreshScopes } from '../src/renderer/src/repo/queries';
import { useRepoUiStore } from '../src/renderer/src/stores/repo-ui';
import {
  columnWidths,
  DEFAULT_LAYOUT,
  moveColumn,
  resizeColumn,
  resolveColumns,
  toggleColumn,
} from '../src/renderer/src/views/graph/graph-columns';
import { conflictLabel, navTarget, rowAriaLabel } from '../src/renderer/src/views/graph/graph-nav';

import {
  GraphModelCache,
  HistoryKeyTracker,
  layoutOptions,
} from '../src/renderer/src/views/graph/useGraphModel';

const commit = (sha: string, parents: string[], i: number): CommitSummary =>
  ({
    sha,
    parents,
    authorName: 'Ann',
    authorEmail: 'ann@x.io',
    authorTime: 1_700_000_000 - i,
    committerName: 'Ann',
    committerEmail: 'ann@x.io',
    commitTime: 1_700_000_000 - i,
    subject: `subject ${sha}`,
  }) as CommitSummary;

/** Linear history c0 ← c1 ← … (c0 newest). */
const linear = (n: number, prefix = 'c'): CommitSummary[] =>
  Array.from({ length: n }, (_, i) => commit(`${prefix}${i}`, i + 1 < n ? [`${prefix}${i + 1}`] : [], i));

const info = (head: string): RepoInfo =>
  ({ head: { kind: 'branch', name: 'main', sha: head }, state: 'clean' }) as unknown as RepoInfo;

describe('incremental graph updates (spec 04 §6.10)', () => {
  it('ref / stash refresh scopes no longer restart history; a bare graph scope still does', () => {
    const qc = new QueryClient();
    const v = () => useRepoUiStore.getState().get('r1').graphVersion;
    const v0 = v();
    refreshScopes(qc, 'r1', ['refs', 'graph']); // watcher: tag / branch file changed, tag.create op
    refreshScopes(qc, 'r1', ['stash', 'graph']);
    refreshScopes(qc, 'r1', ['refs']);
    expect(v()).toBe(v0);
    refreshScopes(qc, 'r1', ['graph']);
    expect(v()).toBe(v0 + 1);
  });

  it('a ref-only change keeps the very same model: no relayout', () => {
    const cache = new GraphModelCache();
    const commits = linear(50);
    const history = { commits, generation: 1, done: true };
    const { opts, key } = layoutOptions({
      info: info('c0'),
      status: undefined,
      stashes: [],
      mergeHead: null,
    });
    const m1 = cache.get(history, opts, key);
    const v1 = m1.version;
    // same history generation and layout key (pills recomputed elsewhere)
    const m2 = cache.get(history, opts, key);
    expect(m2).toBe(m1);
    expect(m2.version).toBe(v1);
    expect(cache.builds).toBe(1);
  });

  it('a new history generation reuses the previous layout (convergence) and can be turned off', () => {
    const old = linear(3000);
    const next = [commit('n0', ['c0'], -1), ...old];
    const base = layoutOptions({ info: info('c0'), status: undefined, stashes: [], mergeHead: null });
    const moved = layoutOptions({ info: info('n0'), status: undefined, stashes: [], mergeHead: null });

    const cache = new GraphModelCache();
    cache.get({ commits: old, generation: 1, done: true }, base.opts, base.key);
    const reused = cache.get({ commits: next, generation: 2, done: true }, moved.opts, moved.key);
    expect(reused.converged).toBe(true);
    expect(reused.rowCount).toBe(3001);

    const plain = new GraphModelCache();
    plain.get({ commits: old, generation: 1, done: true }, base.opts, base.key, false);
    const fresh = plain.get({ commits: next, generation: 2, done: true }, moved.opts, moved.key, false);
    expect(fresh.converged).toBe(false);
    for (let r = 0; r < fresh.rowCount; r++) expect(reused.columnAt(r)).toBe(fresh.columnAt(r));
  });

  it('pins and hidden stashes are part of the layout key', () => {
    const a = layoutOptions({ info: info('c0'), status: undefined, stashes: [], mergeHead: null });
    const b = layoutOptions({
      info: info('c0'),
      status: undefined,
      stashes: [],
      mergeHead: null,
      pinnedTips: ['c3'],
    });
    const c = layoutOptions({
      info: info('c0'),
      status: undefined,
      stashes: [],
      mergeHead: null,
      omit: ['s'],
    });
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
    expect(b.opts.pinnedTips).toEqual(['c3']);
  });

  it('HistoryKeyTracker keeps the key for new tips at laid-out commits, changes it otherwise', () => {
    const t = new HistoryKeyTracker();
    const tips = (shas: string[], head = 'c0'): VisibleTips => ({
      tips: [...shas].sort(),
      head,
      stashes: [],
    });
    const k0 = t.resolve('k0', tips(['c0', 'f0']));
    expect(k0).toBe('k0');
    const m = new GraphModel<CommitSummary>({ headSha: 'c0' });
    m.append(linear(10), true);
    t.observe(m);
    // tag at c5 (already a row) → same history key
    expect(t.resolve('k1', tips(['c0', 'f0', 'c5']))).toBe('k0');
    // StrictMode double render is idempotent
    expect(t.resolve('k1', tips(['c0', 'f0', 'c5']))).toBe('k0');
    // unknown new tip (fetch) → reload
    expect(t.resolve('k2', tips(['c0', 'f0', 'c5', 'zz']))).toBe('k2');
    // tip removed (branch deleted) → reload
    expect(t.resolve('k3', tips(['c0', 'c5']))).toBe('k3');
    // HEAD moved → reload
    expect(t.resolve('k4', tips(['c1', 'c5'], 'c1'))).toBe('k4');
    expect(visibleTips([], { hidden: [], solo: [], pinned: [] }, null).tips).toEqual([]);
  });

  it('HistoryKeyTracker adopts a load started before the refs were known (spec 04 §9 first rows)', () => {
    const t = new HistoryKeyTracker();
    const tips = (shas: string[]): VisibleTips => ({ tips: [...shas].sort(), head: 'c0', stashes: [] });
    expect(t.pending()).toBe(HistoryKeyTracker.PENDING);
    expect(t.pending()).toBe(HistoryKeyTracker.PENDING); // StrictMode double render
    // refs arrive: same load, no restart
    expect(t.resolve('k0', tips(['c0']))).toBe(HistoryKeyTracker.PENDING);
    expect(t.resolve('k0', tips(['c0']))).toBe(HistoryKeyTracker.PENDING);
    // a real tip change later still restarts
    expect(t.resolve('k1', tips(['c0', 'zz']))).toBe('k1');
    // without an early load, keys are returned as is
    const u = new HistoryKeyTracker();
    expect(u.resolve('k0', tips(['c0']))).toBe('k0');
    expect(u.pending()).toBe(HistoryKeyTracker.PENDING);
    expect(u.resolve('k0', tips(['c0']))).toBe('k0');
  });
});

describe('graph columns (spec 04 §4.2)', () => {
  it('reorders, resizes, toggles and lays out with message as the flex column', () => {
    let l = moveColumn(null, 'graph', 'refs');
    expect(resolveColumns(l).map((c) => c.id)).toEqual(['graph', 'refs', 'message', 'author', 'date', 'sha']);
    l = moveColumn(l, 'refs', null);
    expect(
      resolveColumns(l)
        .map((c) => c.id)
        .at(-1),
    ).toBe('refs');
    l = resizeColumn(l, 'author', 10);
    expect(resolveColumns(l).find((c) => c.id === 'author')!.width).toBe(80); // min width
    l = toggleColumn(toggleColumn(l, 'sha'), 'message');
    expect(resolveColumns(l).find((c) => c.id === 'sha')!.visible).toBe(true);
    expect(resolveColumns(l).find((c) => c.id === 'message')!.visible).toBe(true);
    const placed = columnWidths(resolveColumns(l), 1000, 60);
    const graph = placed.find((c) => c.id === 'graph')!;
    expect(graph).toEqual({ id: 'graph', width: 60, left: 0 });
    expect(placed.reduce((s, c) => s + c.width, 0)).toBe(1000);
    // the graph column keeps a stored width; null resets it to auto
    expect(columnWidths(resolveColumns(resizeColumn(l, 'graph', 200)), 1000, 60)[0]!.width).toBe(200);
    expect(
      columnWidths(resolveColumns(resizeColumn(resizeColumn(l, 'graph', 200), 'graph', null)), 1000, 60)[0]!
        .width,
    ).toBe(60);
  });

  it('fits columns to a narrow container: shrink to minimums, then drop optional columns', () => {
    const cols = resolveColumns(DEFAULT_LAYOUT);
    const total = (p: Array<{ width: number }>): number => p.reduce((s, c) => s + c.width, 0);
    // Wide: defaults kept.
    const wide = columnWidths(cols, 1200, 100);
    expect(wide.find((c) => c.id === 'author')!.width).toBe(140);
    expect(total(wide)).toBe(1200);
    // Somewhat narrow: fixed columns shrink, nothing is dropped, everything fits.
    const mid = columnWidths(cols, 560, 100);
    expect(mid.map((c) => c.id)).toEqual(['refs', 'graph', 'message', 'author', 'date']);
    expect(mid.find((c) => c.id === 'graph')!.width).toBe(100);
    expect(mid.find((c) => c.id === 'message')!.width).toBeGreaterThanOrEqual(120);
    expect(total(mid)).toBe(560);
    // Very narrow: Date then Author are left out; columns never extend past the container.
    const narrow = columnWidths(cols, 420, 100);
    expect(narrow.map((c) => c.id)).toEqual(['refs', 'graph', 'message', 'author']);
    expect(total(narrow)).toBe(420);
    const narrowest = columnWidths(cols, 340, 100);
    expect(narrowest.map((c) => c.id)).toEqual(['refs', 'graph', 'message']);
    expect(total(narrowest)).toBe(340);
    // Not measured yet (0): full layout rather than dropping columns.
    expect(columnWidths(cols, 0, 100).map((c) => c.id)).toContain('date');
  });
});

describe('graph keyboard + a11y (spec 04 §2.5, §6.13, §6.14)', () => {
  // main: m0 ← m1(merge m2, f0) ← m2 ; feature f0 ← m2
  const commits = [
    commit('m0', ['m1'], 0),
    commit('m1', ['m2', 'f0'], 1),
    commit('f0', ['m2'], 2),
    commit('m2', [], 3),
  ];
  const m = new GraphModel<CommitSummary>({ headSha: 'm0' });
  m.append(commits, true);

  it('moves, jumps, pages and follows first parents', () => {
    expect(navTarget(m, 0, { key: 'j' }, 10)).toEqual({ kind: 'move', row: 1 });
    expect(navTarget(m, 1, { key: 'ArrowUp' }, 10)).toEqual({ kind: 'move', row: 0 });
    expect(navTarget(m, 1, { key: 'End', ctrlKey: true }, 10)).toEqual({ kind: 'move', row: 3 });
    expect(navTarget(m, 3, { key: 'Home', ctrlKey: true }, 10)).toEqual({ kind: 'move', row: 0 });
    expect(navTarget(m, 0, { key: 'PageDown' }, 10)).toEqual({ kind: 'move', row: 3 });
    // Shift+J from the merge m1 skips f0 and lands on its first parent m2; Shift+K goes back up
    expect(navTarget(m, 1, { key: 'J', shiftKey: true }, 10)).toEqual({ kind: 'move', row: 3 });
    expect(navTarget(m, 3, { key: 'K', shiftKey: true }, 10)).toEqual({ kind: 'move', row: 2 });
    expect(navTarget(m, 0, { key: 'K', shiftKey: true }, 10)).toBeNull();
    expect(navTarget(m, 1, { key: 'ArrowDown', shiftKey: true, altKey: true }, 10)).toEqual({
      kind: 'extend',
      row: 2,
    });
    expect(navTarget(m, 1, { key: 'x' }, 10)).toBeNull();
  });

  it('describes rows for screen readers and labels the conflict row by operation', () => {
    expect(rowAriaLabel(m, 1, undefined, '3 hours ago')).toBe('Merge commit subject m1, by Ann, 3 hours ago');
    expect(rowAriaLabel(m, 0, undefined, '')).toContain('HEAD');
    expect(conflictLabel('rebasing-interactive')).toBe('Rebase conflict');
    expect(conflictLabel('merging')).toBe('Merge conflict');
    expect(conflictLabel('cherry-picking')).toBe('Cherry-pick conflict');
  });
});
