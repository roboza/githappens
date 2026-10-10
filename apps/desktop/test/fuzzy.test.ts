import { afterEach, describe, expect, it, vi } from 'vitest';

import { fuzzyScore, MRU_MAX_BOOST, mruBoost, rankItems } from '../src/renderer/src/commands/fuzzy';
import { clearMru, getMru, MRU_STORAGE_KEY, recordMru } from '../src/renderer/src/commands/mru';

const score = (q: string, t: string): number => fuzzyScore(q, t)?.score ?? -Infinity;
const rank = (q: string, items: string[], mru?: string[]): string[] =>
  rankItems(items, q, { getText: (s) => s, getKey: (s) => s, mru }).map((r) => r.item);

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'Fetch All')).toBeNull();
    expect(fuzzyScore('fetchh', 'Fetch')).toBeNull();
  });

  it('matches case-insensitively, ignores query whitespace and reports positions', () => {
    expect(fuzzyScore('FETCH', 'fetch all')?.positions).toEqual([0, 1, 2, 3, 4]);
    expect(fuzzyScore('fetch all', 'Fetch All')?.positions).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
  });

  it('an empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('a contiguous prefix beats a scattered match', () => {
    expect(score('fet', 'Fetch All')).toBeGreaterThan(score('fet', 'Force Edit Text'));
    expect(score('pull', 'Pull')).toBeGreaterThan(score('pull', 'Push Update Local Log'));
    expect(rank('sta', ['Discard Stash Action', 'Stage All'])).toEqual(['Stage All', 'Discard Stash Action']);
  });

  it('gives a word-start bonus over mid-word matches', () => {
    expect(score('ob', 'Open Branch')).toBeGreaterThan(score('ob', 'Mobile'));
    expect(score('tt', 'Toggle Terminal')).toBeGreaterThan(score('tt', 'Pretty'));
    // camelCase boundary
    expect(score('sc', 'showCommits')).toBeGreaterThan(score('sc', 'describe'));
  });

  it('prefers the word-start alignment for positions', () => {
    // "t" should land on the start of "Theme", not the "t" inside "Switch".
    expect(fuzzyScore('st', 'Switch Theme')?.positions).toEqual([0, 7]);
  });

  it('gives a path-segment bonus after / and \\', () => {
    expect(score('rc', 'src/renderer/components')).toBeGreaterThan(score('rc', 'source'));
    expect(fuzzyScore('app', 'src/main/app.ts')?.positions).toEqual([9, 10, 11]);
    expect(score('mi', 'src\\main\\index.ts')).toBeGreaterThan(score('mi', 'commit.ts'));
    expect(rank('cp', ['lib/scope.ts', 'components/CommandPalette.tsx'])[0]).toBe(
      'components/CommandPalette.tsx',
    );
  });

  it('penalizes larger gaps', () => {
    expect(score('ab', 'a-b')).toBeGreaterThan(score('ab', 'axxxxxxb'));
    expect(score('ab', 'axb')).toBeGreaterThan(score('ab', 'axxxxxxb'));
  });
});

describe('rankItems', () => {
  it('filters non-matches and breaks ties toward shorter text then input order', () => {
    expect(rank('pu', ['Push', 'Pull', 'Fetch'])).toEqual(['Push', 'Pull']);
    expect(rank('push', ['Push Tags', 'Push'])).toEqual(['Push', 'Push Tags']);
  });

  it('keeps everything for an empty query, recent first', () => {
    expect(rank('', ['a', 'b', 'c'], ['c'])).toEqual(['c', 'a', 'b']);
  });

  it('boosts recently used items', () => {
    expect(rank('p', ['Pull', 'Push'])).toEqual(['Pull', 'Push']);
    expect(rank('p', ['Pull', 'Push'], ['Push'])).toEqual(['Push', 'Pull']);
    // more recent wins
    expect(rank('p', ['Pull', 'Push'], ['Pull', 'Push'])).toEqual(['Pull', 'Push']);
  });

  it('mruBoost decays with position and is 0 outside the list', () => {
    expect(mruBoost('a', ['a', 'b'])).toBe(MRU_MAX_BOOST);
    expect(mruBoost('b', ['a', 'b'])).toBeLessThan(MRU_MAX_BOOST);
    expect(mruBoost('z', ['a'])).toBe(0);
    expect(mruBoost(undefined, ['a'])).toBe(0);
  });

  it('matches alternate text with a penalty and without highlight positions', () => {
    const res = rankItems([{ t: 'Fetch All', k: 'remote' }], 'remote', {
      getText: (x) => x.t,
      getAltText: (x) => x.k,
    });
    expect(res).toHaveLength(1);
    expect(res[0]!.positions).toEqual([]);
  });

  it('sorts demoted items last and honors limit', () => {
    const res = rankItems(['Pull', 'Push', 'Prune'], 'p', {
      getText: (s) => s,
      demote: (s) => s === 'Pull',
      limit: 2,
    });
    expect(res.map((r) => r.item)).toEqual(['Push', 'Prune']);
  });
});

describe('MRU persistence', () => {
  afterEach(() => {
    clearMru();
    vi.unstubAllGlobals();
  });

  it('works in memory without localStorage', () => {
    recordMru('a');
    recordMru('b');
    recordMru('a');
    expect(getMru()).toEqual(['a', 'b']);
  });

  it('persists to localStorage, capped at 20, tolerating corrupt data', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    for (let i = 0; i < 25; i++) recordMru(`cmd${i}`);
    const mru = getMru();
    expect(mru).toHaveLength(20);
    expect(mru[0]).toBe('cmd24');
    expect(JSON.parse(data.get(MRU_STORAGE_KEY)!)).toEqual(mru);

    data.set(MRU_STORAGE_KEY, '{not json');
    expect(() => getMru()).not.toThrow();
  });

  it('survives a throwing localStorage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => recordMru('x')).not.toThrow();
    expect(getMru()).toEqual(['x']);
  });
});
