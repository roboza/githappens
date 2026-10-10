import { describe, expect, it } from 'vitest';

import {
  activeSolo,
  createScrollMapping,
  effectiveHidden,
  EMPTY_VISIBILITY,
  graphRevQuery,
  groupRefPills,
  hiddenStashShas,
  MAX_SCROLL_HEIGHT,
  pinnedTipShas,
  pruneVisibility,
  refVisibilityMark,
  setHidden,
  setPinned,
  setSolo,
  showAll,
  virtualTopForRow,
  visibleTipKey,
  type RefInput,
  type RefVisibilityState,
} from '../src';

const ref = (fullName: string, sha: string, extra: Partial<RefInput> = {}): RefInput => {
  const type = fullName.startsWith('refs/heads/')
    ? 'local'
    : fullName.startsWith('refs/remotes/')
      ? 'remote'
      : fullName.startsWith('refs/tags/')
        ? 'tag'
        : 'other';
  const shortName = fullName.replace(/^refs\/(heads|remotes|tags)\//, '');
  return { fullName, shortName, type, sha, ...extra };
};

const REFS: RefInput[] = [
  ref('refs/heads/main', 'm1', { isHead: true, upstream: { fullName: 'refs/remotes/origin/main' } }),
  ref('refs/heads/feature', 'f1'),
  ref('refs/heads/old', 'o1'),
  ref('refs/remotes/origin/main', 'm1'),
  ref('refs/remotes/origin/HEAD', 'm1', { symrefTarget: 'refs/remotes/origin/main' }),
  ref('refs/remotes/origin/feature', 'f0'),
  ref('refs/remotes/upstream/main', 'u1'),
  ref('refs/tags/v1', 'm0'),
  ref('refs/githappens/undo/1', 'k1'),
];

const vis = (v: Partial<RefVisibilityState>): RefVisibilityState => ({ ...EMPTY_VISIBILITY, ...v });

describe('hide / solo rev sets (spec 04 §6.2, spec 01 §8)', () => {
  it('nothing hidden → revs all', () => {
    expect(graphRevQuery(REFS, EMPTY_VISIBILITY, { headSha: 'm1' })).toEqual({ revs: 'all' });
  });

  it('hide → --exclude list incl. symbolic remote HEADs', () => {
    const q = graphRevQuery(REFS, vis({ hidden: ['refs/heads/old', 'refs/remotes/upstream/*'] }), {
      headSha: 'm1',
    });
    expect(q).toEqual({
      revs: 'all',
      hiddenRefs: ['refs/heads/old', 'refs/remotes/upstream/*', 'refs/remotes/origin/HEAD'],
    });
  });

  it('stash-only hides do not change the ref rev set', () => {
    expect(graphRevQuery(REFS, vis({ hidden: ['stash:s1'] }), { headSha: 'm1' })).toEqual({ revs: 'all' });
  });

  it('solo → explicit soloed refs + HEAD + visible stash tips', () => {
    const q = graphRevQuery(REFS, vis({ solo: ['refs/heads/feature'], hidden: ['stash:s2'] }), {
      headSha: 'm1',
      stashes: [{ sha: 's1' }, { sha: 's2' }],
    });
    expect(q).toEqual({ revs: ['refs/heads/feature', 'HEAD', 's1'] });
  });

  it('solo of a whole remote expands the glob; stale solo names are ignored', () => {
    expect(graphRevQuery(REFS, vis({ solo: ['refs/remotes/origin/*'] }), { headSha: null })).toEqual({
      revs: ['refs/remotes/origin/main', 'refs/remotes/origin/feature'],
    });
    expect(graphRevQuery(REFS, vis({ solo: ['refs/heads/gone'] }), { headSha: 'm1' })).toEqual({
      revs: 'all',
    });
    expect(activeSolo(REFS, vis({ solo: ['refs/heads/gone'] }))).toEqual([]);
  });

  it('effective hidden: explicit + non-soloed refs, never the checked-out branch', () => {
    const h = effectiveHidden(REFS, vis({ solo: ['refs/heads/feature'] }));
    expect([...h].sort()).toEqual(
      [
        'refs/heads/old',
        'refs/remotes/origin/feature',
        'refs/remotes/origin/main',
        'refs/remotes/upstream/main',
        'refs/tags/v1',
      ].sort(),
    );
    expect(h.has('refs/heads/main')).toBe(false);
    const pills = groupRefPills(REFS, { hidden: h });
    expect([...pills.values()].flat().map((p) => p.fullName)).toEqual([
      'refs/heads/main',
      'refs/heads/feature',
    ]);
  });

  it('marks refs for the left panel', () => {
    const v = vis({ solo: ['refs/heads/feature'], hidden: ['refs/tags/v1'] });
    expect(refVisibilityMark('refs/heads/feature', REFS, v)).toBe('solo');
    expect(refVisibilityMark('refs/tags/v1', REFS, v)).toBe('hidden');
    expect(refVisibilityMark('refs/heads/old', REFS, v)).toBe('hiddenBySolo');
    expect(refVisibilityMark('refs/heads/main', REFS, v)).toBe('visible');
  });
});

describe('visible tip key (§6.10 decision tree)', () => {
  const key = (refs: RefInput[], v = EMPTY_VISIBILITY, stashes: { sha: string }[] = []) =>
    visibleTipKey(refs, v, 'm1', stashes);

  it('is unchanged by a tag / branch created at an existing commit, renames and upstream changes', () => {
    const base = key(REFS);
    expect(key([...REFS, ref('refs/tags/v2', 'f1')])).toBe(base);
    expect(key([...REFS, ref('refs/heads/copy', 'o1')])).toBe(base);
    expect(
      key(REFS.map((r) => (r.fullName === 'refs/heads/old' ? ref('refs/heads/renamed', 'o1') : r))),
    ).toBe(base);
    expect(
      key(REFS.map((r) => (r.fullName === 'refs/heads/feature' ? { ...r, upstream: undefined } : r))),
    ).toBe(base);
    // undo keep-alive refs never count
    expect(key([...REFS, ref('refs/githappens/undo/2', 'zz')])).toBe(base);
  });

  it('changes when a tip moves, a ref with a unique tip is created/deleted, or a stash is added', () => {
    const base = key(REFS);
    expect(key(REFS.map((r) => (r.fullName === 'refs/heads/feature' ? { ...r, sha: 'f2' } : r)))).not.toBe(
      base,
    );
    expect(key([...REFS, ref('refs/tags/new', 'n1')])).not.toBe(base);
    expect(key(REFS.filter((r) => r.fullName !== 'refs/heads/old'))).not.toBe(base);
    expect(key(REFS, EMPTY_VISIBILITY, [{ sha: 's1' }])).not.toBe(base);
  });

  it('hiding a ref whose tip is also reachable as another visible tip keeps the key', () => {
    expect(key(REFS, vis({ hidden: ['refs/remotes/origin/main'] }))).toBe(key(REFS));
    expect(key(REFS, vis({ hidden: ['refs/heads/old'] }))).not.toBe(key(REFS));
  });
});

describe('pins, stashes, pruning and toggles', () => {
  it('pinned tip shas follow pin order, skip hidden / missing refs and dedupe', () => {
    const v = vis({
      pinned: ['refs/heads/feature', 'refs/heads/missing', 'refs/heads/old', 'refs/remotes/origin/main'],
      hidden: ['refs/heads/old'],
    });
    expect(pinnedTipShas(REFS, v)).toEqual(['f1', 'm1']);
  });

  it('hidden stashes omit the stash and its helper commits', () => {
    const stashes = [
      { sha: 's1', parents: ['b', 'i1', 'u1'] },
      { sha: 's2', parents: ['b', 'i2'] },
    ];
    expect(hiddenStashShas(stashes, vis({ hidden: ['stash:s1'] }))).toEqual(['s1', 'i1', 'u1']);
  });

  it('prunes stale names and keeps live globs', () => {
    const v = vis({
      hidden: ['refs/heads/gone', 'refs/remotes/upstream/*', 'stash:s9'],
      solo: ['refs/remotes/nope/*'],
      pinned: ['refs/heads/feature'],
    });
    expect(pruneVisibility(v, REFS, [{ sha: 's1' }])).toEqual({
      hidden: ['refs/remotes/upstream/*'],
      solo: [],
      pinned: ['refs/heads/feature'],
    });
    expect(pruneVisibility(vis({ hidden: ['refs/heads/old'] }), REFS)).toBeNull();
  });

  it('hide un-solos, solo un-hides, show all keeps pins', () => {
    let v = setSolo(EMPTY_VISIBILITY, 'refs/heads/feature');
    v = setHidden(v, 'refs/heads/feature');
    expect(v).toEqual({ hidden: ['refs/heads/feature'], solo: [], pinned: [] });
    v = setSolo(v, 'refs/heads/feature');
    expect(v).toEqual({ hidden: [], solo: ['refs/heads/feature'], pinned: [] });
    v = setPinned(setHidden(v, 'refs/heads/old'), 'refs/heads/main');
    expect(showAll(v)).toEqual({ hidden: [], solo: [], pinned: ['refs/heads/main'] });
    expect(setHidden(v, 'refs/heads/old', true).hidden).toEqual(['refs/heads/old']);
  });
});

describe('scaled scroll mapping (§4.13)', () => {
  it('is the identity below the limit', () => {
    const m = createScrollMapping(1000, 28, 600);
    expect(m.scaled).toBe(false);
    expect(m.spacerHeight).toBe(28_000);
    expect(m.toVirtual(1234)).toBe(1234);
    expect(m.toScroll(1234)).toBe(1234);
    expect(m.toVirtual(1e9)).toBe(28_000 - 600);
  });

  it('scales above 15M px and round-trips; both ends map exactly', () => {
    const rows = 1_000_000;
    const m = createScrollMapping(rows, 28, 800);
    expect(m.scaled).toBe(true);
    expect(m.spacerHeight).toBe(MAX_SCROLL_HEIGHT);
    expect(m.toVirtual(0)).toBe(0);
    expect(m.toVirtual(MAX_SCROLL_HEIGHT - 800)).toBeCloseTo(rows * 28 - 800, 3);
    for (const v of [0, 28, 1234.5, 13_999_999, rows * 28 - 800]) {
      expect(m.toVirtual(m.toScroll(v))).toBeCloseTo(v, 3);
    }
    // the last row is reachable and keyboard navigation can address any row
    const top = virtualTopForRow(rows - 1, 28, 800, 0, 'nearest');
    expect(top).toBe(rows * 28 - 800);
    expect(m.toVirtual(m.toScroll(top))).toBeCloseTo(top, 3);
  });

  it('virtualTopForRow keeps a margin and centres on request', () => {
    expect(virtualTopForRow(5, 20, 200, 0)).toBe(0);
    expect(virtualTopForRow(10, 20, 200, 0)).toBe(20);
    expect(virtualTopForRow(10, 20, 200, 0, 'nearest', 3)).toBe(80);
    expect(virtualTopForRow(2, 20, 200, 100, 'nearest', 3)).toBe(0);
    expect(virtualTopForRow(50, 20, 200, 0, 'center')).toBe(910);
  });
});
