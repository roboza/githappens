import { describe, expect, it } from 'vitest';

import {
  actionPaths,
  clickSelect,
  decodeDrag,
  DEFAULT_VIEW,
  emptySelection,
  encodeDrag,
  filesUnder,
  flattenRows,
  parseViewPrefs,
  pruneSelection,
  sortRows,
  visibleRange,
  type WipRow,
} from '../src/renderer/src/views/composer/staging-helpers';
import {
  eofPair,
  paintLine,
  pruneLineSelection,
  rangeSelect,
  splitRows,
  toggleLine,
  toLineRefs,
} from '../src/renderer/src/views/diff/line-selection';

const row = (path: string, status: WipRow['status'] = 'M'): WipRow => ({
  path,
  status,
  untracked: status === '?',
});
const rows = [
  row('src/b.ts'),
  row('src/a.css', 'A'),
  row('README.md', 'D'),
  row('src/lib/z.ts', '?'),
  row('src/lib/deep/x.json', 'R'),
];
const paths = (r: { row?: WipRow; kind: string; name?: string }[]): string[] =>
  r.map((x) => (x.kind === 'file' ? x.row!.path : `[${x.name}]`));

describe('file list sorting (spec 06 §4.3)', () => {
  it('sorts by path, name, status and extension, both directions', () => {
    expect(sortRows(rows, 'path', 'asc').map((r) => r.path)).toEqual([
      'README.md',
      'src/a.css',
      'src/b.ts',
      'src/lib/deep/x.json',
      'src/lib/z.ts',
    ]);
    expect(sortRows(rows, 'path', 'desc')[0]!.path).toBe('src/lib/z.ts');
    expect(sortRows(rows, 'name', 'asc').map((r) => r.path)).toEqual([
      'src/a.css',
      'src/b.ts',
      'README.md',
      'src/lib/deep/x.json',
      'src/lib/z.ts',
    ]);
    expect(sortRows(rows, 'status', 'asc').map((r) => r.status)).toEqual(['A', '?', 'M', 'R', 'D']);
    expect(sortRows(rows, 'extension', 'asc').map((r) => r.path)).toEqual([
      'src/a.css',
      'src/lib/deep/x.json',
      'README.md',
      'src/b.ts',
      'src/lib/z.ts',
    ]);
  });
});

describe('path / tree flattening', () => {
  it('path view lists files in sort order', () => {
    expect(paths(flattenRows(rows, DEFAULT_VIEW, new Set()))).toHaveLength(5);
  });

  it('tree view: folders first, counts, compacted chains, collapse toggles', () => {
    const tree = { ...DEFAULT_VIEW, mode: 'tree' as const };
    const flat = flattenRows(rows, tree, new Set());
    expect(paths(flat)).toEqual([
      '[src]',
      '[lib]',
      '[deep]',
      'src/lib/deep/x.json',
      'src/lib/z.ts',
      'src/a.css',
      'src/b.ts',
      'README.md',
    ]);
    const src = flat[0]!;
    expect(src.kind === 'folder' && src.count).toBe(4);
    const collapsed = flattenRows(rows, tree, new Set(['src/lib']));
    expect(paths(collapsed)).toEqual(['[src]', '[lib]', 'src/a.css', 'src/b.ts', 'README.md']);
    // large change sets start collapsed; toggling expands
    expect(paths(flattenRows(rows, tree, new Set(), true))).toEqual(['[src]', 'README.md']);
    expect(paths(flattenRows(rows, tree, new Set(['src']), true))).toEqual([
      '[src]',
      '[lib]',
      'src/a.css',
      'src/b.ts',
      'README.md',
    ]);
  });

  it('compacts single-child folder chains', () => {
    const flat = flattenRows([row('a/b/c/file.txt')], { ...DEFAULT_VIEW, mode: 'tree' }, new Set());
    expect(paths(flat)).toEqual(['[a/b/c]', 'a/b/c/file.txt']);
  });

  it('folder actions cover every file below the folder', () => {
    expect(filesUnder(rows, 'src/lib').map((r) => r.path)).toEqual(['src/lib/z.ts', 'src/lib/deep/x.json']);
    expect(filesUnder(rows, 'sr')).toEqual([]);
  });
});

describe('multi-selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('click / ctrl-click / shift-click / ctrl+shift-click', () => {
    let s = clickSelect(emptySelection(), order, 'b', { ctrl: false, shift: false });
    expect([...s.paths]).toEqual(['b']);
    s = clickSelect(s, order, 'd', { ctrl: false, shift: true });
    expect([...s.paths]).toEqual(['b', 'c', 'd']);
    s = clickSelect(s, order, 'c', { ctrl: true, shift: false });
    expect([...s.paths].sort()).toEqual(['b', 'd']);
    expect(s.anchor).toBe('c');
    s = clickSelect(s, order, 'a', { ctrl: true, shift: true });
    expect([...s.paths].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('prunes vanished files and picks action targets', () => {
    const s = { paths: new Set(['a', 'c', 'x']), anchor: 'x' };
    const p = pruneSelection(s, new Set(order));
    expect([...p.paths]).toEqual(['a', 'c']);
    expect(p.anchor).toBeNull();
    const same = { paths: new Set(['a']), anchor: 'a' };
    expect(pruneSelection(same, new Set(order))).toBe(same);
    expect(actionPaths(p, 'c', order)).toEqual(['a', 'c']);
    expect(actionPaths(p, 'e', order)).toEqual(['e']);
  });
});

describe('view prefs, drag payload, virtualization', () => {
  it('parses persisted prefs defensively', () => {
    expect(parseViewPrefs(null)).toEqual(DEFAULT_VIEW);
    expect(parseViewPrefs('{bad')).toEqual(DEFAULT_VIEW);
    expect(parseViewPrefs('{"mode":"tree","sort":"status","dir":"desc"}')).toEqual({
      mode: 'tree',
      sort: 'status',
      dir: 'desc',
    });
    expect(parseViewPrefs('{"mode":"x","sort":"y"}')).toEqual(DEFAULT_VIEW);
  });

  it('round-trips the drag payload and rejects junk', () => {
    expect(decodeDrag(encodeDrag('unstaged', ['a', 'b']))).toEqual({ side: 'unstaged', paths: ['a', 'b'] });
    expect(decodeDrag('{"side":"other","paths":["a"]}')).toBeNull();
    expect(decodeDrag('{"side":"staged","paths":[1,""]}')).toBeNull();
    expect(decodeDrag('nope')).toBeNull();
  });

  it('computes the visible window with overscan', () => {
    expect(visibleRange(10_000, 24, 100, 0, 480, 10)).toEqual({ start: 0, end: 26 });
    expect(visibleRange(10_000, 24, 100, 24_100, 480, 10)).toEqual({ start: 990, end: 1030 });
    expect(visibleRange(50, 24, 0, 5000, 480, 10)).toEqual({ start: 50, end: 50 });
  });
});

// ---- line selection (diff view) ----

type L = { type: 'context' | 'add' | 'del' | 'nonewline' };
const hunk = (...t: L['type'][]): { lines: L[] } => ({ lines: t.map((type) => ({ type })) });

describe('line selection (spec 06 §4.4)', () => {
  const hunks = [hunk('context', 'del', 'add', 'add', 'context'), hunk('del', 'del', 'add')];

  it('toggles, paints and range-selects only changed lines (across hunks)', () => {
    let s = toggleLine(new Set(), hunks, 0, 1);
    expect([...s]).toEqual(['0:1']);
    s = toggleLine(s, hunks, 0, 1);
    expect(s.size).toBe(0);
    expect(toggleLine(new Set(), hunks, 0, 0).size).toBe(0); // context
    s = paintLine(new Set(), hunks, 0, 2, true);
    s = paintLine(s, hunks, 0, 3, true);
    expect([...s]).toEqual(['0:2', '0:3']);
    expect(paintLine(s, hunks, 0, 3, true)).toBe(s);
    s = rangeSelect(new Set(), hunks, { h: 1, l: 1 }, { h: 0, l: 2 });
    expect([...s].sort()).toEqual(['0:2', '0:3', '1:0', '1:1']);
    s = rangeSelect(new Set(), hunks, { h: 0, l: 0 }, { h: 1, l: 2 }, 'add');
    expect([...s].sort()).toEqual(['0:2', '0:3', '1:2']);
    expect(toLineRefs(new Set(['1:0', '0:3']))).toEqual([
      { hunkIndex: 0, lineIndex: 3 },
      { hunkIndex: 1, lineIndex: 0 },
    ]);
    expect([...pruneLineSelection(new Set(['0:0', '0:1', '9:9']), hunks)]).toEqual(['0:1']);
  });

  it('links end-of-file pairs (same rule as the patch builder)', () => {
    // both sides lack the final newline
    expect(eofPair(hunk('context', 'del', 'nonewline', 'add', 'nonewline'))).toEqual([1, 3]);
    // adding the final newline: -b⏎\ ↔ +b
    expect(eofPair(hunk('context', 'del', 'nonewline', 'add'))).toEqual([1, 3]);
    // old last line without newline, more lines added after: pair with the counterpart only
    expect(eofPair(hunk('context', 'del', 'nonewline', 'add', 'add'))).toEqual([1, 3]);
    // removing the final newline
    expect(eofPair(hunk('context', 'del', 'add', 'nonewline'))).toEqual([1, 2]);
    // extra additions without newline after a deletion run: no counterpart
    expect(eofPair(hunk('del', 'add', 'add', 'nonewline'))).toBeNull();
    expect(eofPair(hunk('context', 'del', 'add'))).toBeNull();
    const h = [hunk('context', 'del', 'nonewline', 'add', 'nonewline')];
    expect([...toggleLine(new Set(), h, 0, 3)].sort()).toEqual(['0:1', '0:3']);
    expect(toggleLine(new Set(['0:1', '0:3']), h, 0, 1).size).toBe(0);
  });

  it('pairs - and + runs side by side, with blanks and no-EOL flags', () => {
    expect(splitRows(hunk('context', 'del', 'del', 'add', 'context'))).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 3 },
      { left: 2 },
      { left: 4, right: 4 },
    ]);
    expect(splitRows(hunk('add', 'add'))).toEqual([{ right: 0 }, { right: 1 }]);
    expect(splitRows(hunk('del', 'nonewline', 'add', 'nonewline'))).toEqual([
      { left: 0, right: 2, leftNoEol: true, rightNoEol: true },
    ]);
    expect(splitRows(hunk('context', 'nonewline'))).toEqual([
      { left: 0, right: 0, leftNoEol: true, rightNoEol: true },
    ]);
  });
});
