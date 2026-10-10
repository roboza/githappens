import { describe, expect, it } from 'vitest';

import {
  ageIntensity,
  applyBlameLines,
  authorColor,
  isUncommitted,
  timeRange,
  toBlocks,
} from '../src/renderer/src/views/file/blame-model';

describe('blame gutter model (spec 07 §4.10)', () => {
  it('groups consecutive lines of a commit into blocks, with unknown (still streaming) lines', () => {
    const table: (string | undefined)[] = [];
    applyBlameLines(table, [
      { sha: 'a', origLine: 1, finalLine: 1, content: '' },
      { sha: 'a', origLine: 2, finalLine: 2, content: '' },
      { sha: 'b', origLine: 1, finalLine: 4, content: '' },
    ]);
    expect(toBlocks(table, 5)).toEqual([
      { sha: 'a', start: 1, count: 2 },
      { sha: '', start: 3, count: 1 },
      { sha: 'b', start: 4, count: 1 },
      { sha: '', start: 5, count: 1 },
    ]);
    expect(toBlocks([], 0)).toEqual([]);
  });

  it('derives stable author colours and an age heatmap', () => {
    expect(authorColor('A@x.com')).toBe(authorColor('a@x.com'));
    expect(authorColor('a@x.com')).toMatch(/^hsl\(\d+ 60% 55%\)$/);
    expect(ageIntensity(200, 100, 200)).toBe(1);
    expect(ageIntensity(100, 100, 200)).toBeCloseTo(0.15);
    expect(ageIntensity(5, 5, 5)).toBe(1);
    const commit = (t: number) => ({
      sha: String(t),
      author: '',
      authorMail: '',
      authorTime: t,
      authorTz: '',
      committer: '',
      committerTime: 0,
      summary: '',
      filename: '',
      boundary: false,
    });
    expect(timeRange({ a: commit(30), b: commit(10), z: commit(0) })).toEqual({ min: 10, max: 30 });
    expect(isUncommitted('0'.repeat(40))).toBe(true);
    expect(isUncommitted('a'.repeat(40))).toBe(false);
  });
});
