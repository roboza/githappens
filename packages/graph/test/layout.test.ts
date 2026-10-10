import { describe, expect, it } from 'vitest';

import { GraphModel, NodeKind, RowFlag, WIP_SHA } from '../src';
import { build, c, checkInvariants, cols, gapEdges } from './helpers';

describe('lane layout — hand-built topologies', () => {
  it('linear history is one straight lane', () => {
    const m = build([c('d', ['c']), c('c', ['b']), c('b', ['a']), c('a')], { headSha: 'd' });
    expect(cols(m)).toEqual({ d: 0, c: 0, b: 0, a: 0 });
    expect(gapEdges(m, 0)).toEqual(['Pass(0→0)']);
    expect(m.flagsAt(0) & RowFlag.Head).toBeTruthy();
    expect(m.flagsAt(3) & RowFlag.Root).toBeTruthy();
    expect(gapEdges(m, 3)).toEqual([]); // root: the line ends
    expect(m.maxColumn).toBe(0);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('reproduces the spec worked example (§6.3.9)', () => {
    const m = build([c('E', ['D']), c('F', ['C']), c('D', ['C', 'B']), c('B', ['C']), c('C', ['Z'])], {
      headSha: 'E',
      wip: true,
    });
    expect(m.shaAt(0)).toBe(WIP_SHA);
    expect(m.nodeKindAt(0)).toBe(NodeKind.Wip);
    expect(cols(m)).toEqual({ WIP: 0, E: 0, F: 1, D: 0, B: 2, C: 0 });
    expect(gapEdges(m, 0)).toEqual(['Pass(0→0)d']);
    expect(gapEdges(m, 1)).toEqual(['Pass(0→0)']);
    expect(gapEdges(m, 2)).toEqual(['Pass(0→0)', 'Pass(1→1)']);
    expect(gapEdges(m, 3)).toEqual(['Pass(0→0)', 'Pass(1→1)', 'MergeOut(0→2)']);
    expect(gapEdges(m, 4)).toEqual(['Pass(0→0)', 'BranchIn(1→0)', 'BranchIn(2→0)']);
    expect(m.nodeKindAt(3)).toBe(NodeKind.Merge);
    // C's parent Z never loaded: the line fades out below the last row
    expect(gapEdges(m, 5)).toEqual(['Pass(0→0)f']);
    expect(m.parentRows(5)).toEqual([-1]);
    expect(m.parentRows(3)).toEqual([5, 4]);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('octopus merge fans out one lane per parent to the right', () => {
    const m = build([
      c('M', ['a', 'b', 'c', 'd']),
      c('d', ['r']),
      c('c', ['r']),
      c('b', ['r']),
      c('a', ['r']),
      c('r'),
    ]);
    expect(m.nodeKindAt(0)).toBe(NodeKind.Merge);
    expect(gapEdges(m, 0)).toEqual(['Pass(0→0)', 'MergeOut(0→1)', 'MergeOut(0→2)', 'MergeOut(0→3)']);
    expect(cols(m)).toMatchObject({ M: 0, d: 3, c: 2, b: 1, a: 0, r: 0 });
    expect(checkInvariants(m)).toEqual([]);
  });

  it('criss-cross merges need no special case', () => {
    const m = build([
      c('m1', ['a1', 'b1']),
      c('m2', ['b1', 'a1']),
      c('a1', ['base']),
      c('b1', ['base']),
      c('base'),
    ]);
    expect(checkInvariants(m)).toEqual([]);
    // m2's second parent a1 is already expected by m1's lane: join it instead of a new lane
    expect(gapEdges(m, 1)).toContain('MergeOut(2→0)');
    expect(m.maxColumn).toBeLessThanOrEqual(2);
  });

  it('a merge parent that is already expected joins the existing line', () => {
    const m = build([c('x', ['p']), c('y', ['q', 'p']), c('q', ['p']), c('p')]);
    expect(gapEdges(m, 1)).toEqual(['Pass(0→0)', 'Pass(1→1)', 'MergeOut(1→0)']);
    expect(m.maxColumn).toBe(1);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('parents never loaded keep their line to the bottom and fade when complete', () => {
    const partial = build([c('a', ['b', 'x']), c('b', ['gone'])], {}, [], false);
    expect(gapEdges(partial, 1)).toEqual(['Pass(0→0)', 'Pass(1→1)']);
    expect(partial.complete).toBe(false);
    partial.finish();
    expect(gapEdges(partial, 1)).toEqual(['Pass(0→0)f', 'Pass(1→1)f']);
    expect(partial.parentRows(0)).toEqual([1, -1]);
    expect(checkInvariants(partial)).toEqual([]);
  });

  it('HEAD keeps lane 0 even when newer branches arrive first, and when a branch is ahead of HEAD', () => {
    const m = build([c('f2', ['f1']), c('f1', ['h']), c('o', ['h']), c('h', ['g']), c('g', ['r']), c('r')], {
      headSha: 'h',
    });
    expect(cols(m)).toMatchObject({ f2: 1, f1: 1, h: 0, g: 0, r: 0 });
    expect(m.columnAt(m.rowOf('o'))).toBe(2);
    expect(m.flagsAt(m.rowOf('h')) & RowFlag.Pinned).toBeTruthy();
    expect(checkInvariants(m)).toEqual([]);
  });

  it('pinned branch tips reserve lanes 1..k after HEAD', () => {
    const m = build([c('t', ['b']), c('p', ['b']), c('h', ['b']), c('b')], {
      headSha: 'h',
      pinnedTips: ['p'],
    });
    expect(cols(m)).toMatchObject({ t: 2, p: 1, h: 0, b: 0 });
    expect(checkInvariants(m)).toEqual([]);
  });

  it('a pinned tip inside HEAD history does not pull HEAD out of lane 0', () => {
    const m = build([c('h', ['p']), c('p', ['r']), c('r')], { headSha: 'h', pinnedTips: ['p'] });
    expect(cols(m)).toEqual({ h: 0, p: 0, r: 0 });
    expect(checkInvariants(m)).toEqual([]);
  });

  it('first-parent continuity: a merged branch never takes the mainline column', () => {
    // main: m → a ; topic t merged by m as 2nd parent; t's parent is a
    const m = build([c('m', ['a', 't']), c('t', ['a']), c('a', ['r']), c('r')]);
    expect(cols(m)).toEqual({ m: 0, t: 1, a: 0, r: 0 });
    expect(checkInvariants(m)).toEqual([]);
  });

  it('cooldown: a freed lane is not reused on the next row', () => {
    const commits = [c('a', ['r']), c('b', ['r']), c('r'), c('x', ['y']), c('y')];
    const m = build(commits, { laneReuseCooldown: 1 });
    // b's lane 1 ends at r (row 2); x is a new tip at row 3 → may not reuse lane 1, gets lane 0 (freed at r)?
    // lane 0 ended at root r (row 2) too, so x must go to lane 2.
    expect(m.columnAt(3)).toBe(2);
    const m0 = build(commits, { laneReuseCooldown: 0 });
    expect(m0.columnAt(3)).toBe(0);
    expect(checkInvariants(m)).toEqual([]);
    expect(checkInvariants(m0)).toEqual([]);
  });

  it('leftmost merge placement option', () => {
    const commits = [c('t', ['r']), c('h', ['m']), c('m', ['a', 'b']), c('b', ['r']), c('a', ['r']), c('r')];
    const rf = build(commits);
    const lm = build(commits, { mergeLanePlacement: 'leftmost' });
    expect(checkInvariants(rf)).toEqual([]);
    expect(checkInvariants(lm)).toEqual([]);
    expect(rf.columnAt(rf.rowOf('b'))).toBeGreaterThan(rf.columnAt(rf.rowOf('m')));
  });

  it('multiple roots / orphan histories are separate lane systems', () => {
    const m = build([c('a', ['a0']), c('x', ['x0']), c('a0'), c('x0')]);
    expect(cols(m)).toEqual({ a: 0, x: 1, a0: 0, x0: 1 });
    expect(checkInvariants(m)).toEqual([]);
  });

  it('stash rows: above their base, dashed edge to the base only; helper commits never become rows', () => {
    const stash = { sha: 'S', parents: ['b', 'Sidx', 'Sunt'], time: 150, index: 0, message: 'wip' };
    const m = build([c('h', ['b'], 300), c('Sidx', ['b'], 151), c('b', ['a'], 100), c('a', [], 50)], {
      headSha: 'h',
      stashes: [stash],
    });
    expect(m.rowOf('Sidx')).toBe(-1);
    expect(m.rowOf('S')).toBe(1);
    expect(m.rowOf('b')).toBe(2);
    expect(m.nodeKindAt(1)).toBe(NodeKind.Stash);
    expect(m.parentRows(1)).toEqual([2]);
    expect(m.itemAt(1)).toBe(stash);
    const stashEdges = m.edgesInRange(1, 1).filter((e) => e.owner === 1);
    expect(stashEdges.length).toBe(1);
    expect(stashEdges[0]!.dashed).toBe(true);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('stash placed by time when older than following commits, but never after its base', () => {
    const s1 = { sha: 'S1', parents: ['a'], time: 250 }; // newer than b → before b
    const s2 = { sha: 'S2', parents: ['b'], time: 10 }; // older than everything → still above b
    const m = build([c('h', ['b'], 300), c('b', ['a'], 200), c('a', [], 100)], { stashes: [s1, s2] });
    expect([...Array(m.rowCount).keys()].map((r) => m.shaAt(r))).toEqual(['h', 'S1', 'S2', 'b', 'a']);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('stash whose base is never loaded is flushed at the end with a fading edge', () => {
    const m = build([c('h', ['b'], 300), c('b', [], 200)], {
      stashes: [{ sha: 'S', parents: ['zz'], time: 1 }],
    });
    expect(m.shaAt(2)).toBe('S');
    expect(gapEdges(m, 2)).toEqual(['Pass(0→0)df'.replace('0→0', `${m.columnAt(2)}→${m.columnAt(2)}`)]);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('WIP row in an empty repo (unborn HEAD) has no parents', () => {
    const m = new GraphModel({ wip: true });
    m.finish();
    expect(m.rowCount).toBe(1);
    expect(m.shaAt(0)).toBe(WIP_SHA);
    expect(m.parentRows(0)).toEqual([]);
    expect(m.hasWipRow).toBe(true);
    expect(m.commitAt(0)).toBeUndefined();
  });

  it('conflict row has dashed edges to HEAD and the incoming commit', () => {
    const m = build([c('h', ['b']), c('o', ['b']), c('b')], {
      headSha: 'h',
      wip: { kind: 'conflict', parents: ['h', 'o'] },
    });
    expect(m.nodeKindAt(0)).toBe(NodeKind.Conflict);
    expect(gapEdges(m, 0)).toEqual(['Pass(0→0)d', 'MergeOut(0→1)d']);
    expect(m.columnAt(m.rowOf('o'))).toBe(1);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('very wide graph: 500 branch tips on one base', () => {
    const commits = [];
    for (let i = 0; i < 500; i++) commits.push(c(`t${i}`, ['base']));
    commits.push(c('base'));
    const m = build(commits);
    expect(m.maxColumn).toBe(499);
    expect(m.columnAt(500)).toBe(0);
    expect(m.edgesInRange(499, 499).length).toBe(500);
    expect(m.maxColumnInRange(0, 0)).toBe(0);
    expect(m.maxColumnInRange(250, 260)).toBe(260);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('ignores duplicate commits and tolerates parents that appear before children', () => {
    const m = build([c('a', ['b']), c('b', ['r']), c('a', ['b']), c('r'), c('late', ['a'])]);
    expect(m.rowCount).toBe(4);
    expect(m.parentRows(3)).toEqual([0]);
    expect(gapEdges(m, 3)).toEqual([]);
  });

  it('branch color mode assigns a color per lane creation and inherits along first parent', () => {
    const m = build([c('a', ['m']), c('b', ['m']), c('m', ['r']), c('r')], {
      colorMode: 'branch',
      paletteSize: 4,
    });
    expect(m.colorAt(0)).toBe(m.colorAt(2));
    expect(m.colorAt(1)).not.toBe(m.colorAt(0));
    expect(checkInvariants(m)).toEqual([]);
  });

  it('per-row accessors and views', () => {
    const m = build([c('a', ['b']), c('b')]);
    expect(m.views().column).toEqual(new Uint16Array([0, 0]));
    expect(m.firstParentRow(0)).toBe(1);
    expect(m.firstParentRow(1)).toBe(-1);
    expect(m.childRows(1)).toEqual([0]);
    expect(m.commitAt(0)).toEqual(c('a', ['b']));
    expect(m.commits().map((x) => x.sha)).toEqual(['a', 'b']);
    expect(m.rowOf('nope')).toBe(-1);
  });
});
