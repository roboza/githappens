import type { ConflictFileInfo, RepoOperationState } from '@githappens/git/types';
import { describe, expect, it, vi } from 'vitest';

import { allMarkersGone, bannerModel, describeOperation } from '../src/renderer/src/views/merge/banner-model';
import {
  alignLines,
  chunkRanges,
  parseMerged,
  resetToBase,
  sameIgnoringWhitespace,
  syncLine,
  workingDivergence,
} from '../src/renderer/src/views/merge/merge-model';
import {
  conflictHint,
  conflictHintTitle,
  PredictionCache,
  withHint,
} from '../src/renderer/src/views/merge/prediction-cache';

const block = (a: string[], base: string[], b: string[]): string[] => [
  '<<<<<<< A',
  ...a,
  '||||||| base',
  ...base,
  '=======',
  ...b,
  '>>>>>>> B',
];

describe('full-file side panes: chunk ranges and line alignment (spec 08 §4.3)', () => {
  // B auto-merged a change near the top ("two" → "TWO"), so the A projection differs from the A file
  const merged = [
    'one',
    'TWO',
    'three',
    ...block(['a1', 'a2'], ['x'], ['b1']),
    'four',
    ...block([], ['y'], ['b2']),
    'five',
    '',
  ].join('\n');
  const doc = parseMerged(merged);
  const aFile = ['one', 'two', 'three', 'a1', 'a2', 'four', 'five'];
  const bFile = ['one', 'TWO', 'three', 'b1', 'four', 'b2', 'five'];

  it('aligns lines across small differences', () => {
    const map = alignLines(['one', 'TWO', 'three', 'a1'], ['one', 'two', 'three', 'a1']);
    expect([...map]).toEqual([0, -1, 2, 3]);
  });

  it('maps every chunk into the full stage files', () => {
    expect(chunkRanges(doc, 'a', aFile)).toEqual([
      { start: 3, length: 2 },
      { start: 6, length: 0 }, // A deleted "y": insertion point after "four"
    ]);
    expect(chunkRanges(doc, 'b', bFile)).toEqual([
      { start: 3, length: 1 },
      { start: 5, length: 1 },
    ]);
  });

  it('keeps chunk positions sane when the file is shorter than expected', () => {
    const r = chunkRanges(doc, 'a', ['one']);
    for (const x of r) {
      expect(x.start).toBeGreaterThanOrEqual(0);
      expect(x.start + x.length).toBeLessThanOrEqual(1);
    }
  });

  it('scroll sync maps lines relative to the closest chunk', () => {
    const a = [4, 7];
    const out = [10, 20];
    expect(syncLine(a, out, 1)).toBe(7); // before the first chunk: same distance from it
    expect(syncLine(a, out, 5)).toBe(11);
    expect(syncLine(a, out, 9)).toBe(22);
    expect(syncLine([], [], 42)).toBe(42);
    expect(syncLine([5], [1], 1)).toBe(1);
  });

  it('reset to base resolves every chunk with its base lines', () => {
    const st = resetToBase(doc);
    expect(st[0]).toEqual({ selected: [], edited: ['x'] });
    expect(st[1]).toEqual({ selected: [], edited: ['y'] });
    const noBase = parseMerged(['<<<<<<< A', 'a', '=======', 'b', '>>>>>>> B', ''].join('\n'));
    expect(resetToBase(noBase)[0]).toEqual({ selected: [], resolvedEmpty: true });
  });

  it('display-only whitespace comparison', () => {
    expect(sameIgnoringWhitespace('  foo(a, b)', 'foo(a,b)\t')).toBe(true);
    expect(sameIgnoringWhitespace('foo', 'bar')).toBe(false);
    expect(sameIgnoringWhitespace(undefined, 'x')).toBe(false);
  });
});

describe('working file vs the tool (spec 08 §6.4, §8)', () => {
  const merged = ['top', ...block(['same', 'a'], ['o'], ['same', 'b']), 'end', ''].join('\n');
  it('treats a different conflict style (zealous merge, other labels) as unchanged', () => {
    // git's default `merge` style moves the common "same" line out of the block and has no base
    const working = ['top', 'same', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> feature', 'end', ''].join(
      '\n',
    );
    expect(workingDivergence(merged, working)).toBe('none');
    expect(workingDivergence(merged, working.replace(/\n/g, '\r\n'))).toBe('none');
  });
  it('detects edits and outside resolution', () => {
    expect(workingDivergence(merged, merged.replace('top', 'TOP'))).toBe('edited');
    expect(workingDivergence(merged, 'top\nsame\nresolved\nend\n')).toBe('resolved');
    expect(workingDivergence(merged, null)).toBe('none');
  });
});

describe('conflict prediction cache (spec 08 §6.9)', () => {
  const p = (n: number) => ({ supported: true, conflicts: Array.from({ length: n }, (_, i) => `f${i}.txt`) });

  it('dedupes in-flight requests and caches results', async () => {
    const c = new PredictionCache();
    const load = vi.fn(() => Promise.resolve(p(2)));
    const k = PredictionCache.key('r', 'a', 'b');
    const [x, y] = await Promise.all([c.get(k, load), c.get(k, load)]);
    expect(x).toEqual(p(2));
    expect(y).toBe(x);
    expect(await c.get(k, load)).toEqual(p(2));
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.peek(k)).toEqual(p(2));
  });

  it('does not cache failures', async () => {
    const c = new PredictionCache();
    const k = PredictionCache.key('r', 'a', 'b');
    expect(await c.get(k, () => Promise.reject(new Error('git')))).toBeNull();
    expect(c.peek(k)).toBeUndefined();
    expect(await c.get(k, () => Promise.resolve(p(0)))).toEqual(p(0));
  });

  it('evicts least recently used entries', () => {
    const c = new PredictionCache(2);
    c.set('1', p(1));
    c.set('2', p(2));
    c.peek('1'); // 1 is now most recent
    c.set('3', p(3));
    expect(c.size).toBe(2);
    expect(c.peek('2')).toBeUndefined();
    expect(c.peek('1')).toBeDefined();
  });

  it('wording: "Will conflict in N files" with a hover list', () => {
    expect(conflictHint(p(3))).toBe('Will conflict in 3 files');
    expect(conflictHint(p(1))).toBe('Will conflict in 1 file');
    expect(conflictHint(p(0))).toBeNull();
    expect(conflictHint({ supported: false, conflicts: ['x'] })).toBeNull();
    expect(withHint('Merge x into main', p(2))).toBe('Merge x into main — ⚠ will conflict in 2 files');
    expect(withHint('Merge x into main', null)).toBe('Merge x into main');
    expect(conflictHintTitle(p(2))).toBe('Conflicting files:\nf0.txt\nf1.txt');
    expect(conflictHintTitle(p(20), 15)).toMatch(/…and 5 more$/);
  });
});

describe('operation banner model (spec 08 §4.2, §6.7)', () => {
  const file = (over: Partial<ConflictFileInfo>): ConflictFileInfo => ({
    path: 'x.txt',
    stages: {},
    code: 'UU',
    kind: 'text',
    unresolvedChunks: 1,
    ...over,
  });
  const state = (over: Partial<RepoOperationState>): RepoOperationState => ({
    op: 'merge',
    current: { label: 'main', sha: 'a'.repeat(40) },
    incoming: { label: 'feature', sha: 'b'.repeat(40) },
    conflicts: [],
    ...over,
  });

  it('stash apply: reset instead of abort, no skip/continue, stash named', () => {
    const s = state({
      op: 'stash-apply',
      conflicts: [file({})],
      stash: { index: 0, sha: 'c'.repeat(40), message: 'wip' },
    });
    expect(bannerModel(s)).toMatchObject({ abort: 'reset', skip: false, continueLabel: null });
    expect(describeOperation(s)).toBe('Applying stash@{0} — conflicts');
  });

  it('am: abort, skip and continue', () => {
    const s = state({ op: 'am', conflicts: [] });
    expect(bannerModel(s)).toMatchObject({
      abort: 'abort',
      skip: true,
      continueLabel: 'Continue',
      canContinue: true,
    });
    expect(describeOperation(s)).toBe('Applying patches (git am)');
  });

  it('merge: continue disabled with conflicts, status counts resolved files', () => {
    const s = state({ conflicts: [file({}), file({ path: 'y' })], resolvedPending: ['z'] });
    const m = bannerModel(s);
    expect(m.canContinue).toBe(false);
    expect(m.status).toBe('2 conflicted files, 1 resolved');
    expect(m.markAll).toBe(false);
  });

  it('"Mark all resolved" only when no text file has markers left and nothing is binary', () => {
    expect(allMarkersGone(state({ conflicts: [file({ unresolvedChunks: 0 })] }))).toBe(true);
    expect(
      allMarkersGone(
        state({ conflicts: [file({ unresolvedChunks: 0 }), file({ kind: 'binary', path: 'b' })] }),
      ),
    ).toBe(false);
    expect(allMarkersGone(state({ conflicts: [file({ unresolvedChunks: undefined })] }))).toBe(false);
    expect(allMarkersGone(state({ conflicts: [] }))).toBe(false);
  });
});
