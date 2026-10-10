import type { DiffHunk } from '@githappens/git/types';
import { describe, expect, it } from 'vitest';

import {
  diffTokens,
  hunkWordDiff,
  segments,
  tokenize,
  wordDiff,
  WORD_DIFF_MAX_LINE,
} from '../src/renderer/src/views/diff/word-diff';

const hunk = (lines: [DiffHunk['lines'][number]['type'], string][]): DiffHunk => ({
  header: '@@ -1 +1 @@',
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: lines.map(([type, content], i) => ({ type, content, patchOffset: i })),
});

describe('word diff tokenizer (spec 07 §6.5)', () => {
  it('splits into words, whitespace runs and single punctuation, unicode-aware', () => {
    expect(tokenize('foo(bar, 42);  // ok')).toEqual([
      'foo',
      '(',
      'bar',
      ',',
      ' ',
      '42',
      ')',
      ';',
      '  ',
      '/',
      '/',
      ' ',
      'ok',
    ]);
    expect(tokenize('naïve café')).toEqual(['na', 'ï', 've', ' ', 'caf', 'é']);
    expect(tokenize('')).toEqual([]);
  });

  it('Myers marks exactly the tokens outside the LCS', () => {
    const d = diffTokens(['a', ' ', 'b', ' ', 'c'], ['a', ' ', 'x', ' ', 'c']);
    expect(d.a).toEqual([false, false, true, false, false]);
    expect(d.b).toEqual([false, false, true, false, false]);
    const ins = diffTokens(['a'], ['a', 'b']);
    expect(ins.a).toEqual([false]);
    expect(ins.b).toEqual([false, true]);
    expect(diffTokens([], ['x'])).toEqual({ a: [], b: [true] });
  });

  it('returns changed character ranges for a line pair', () => {
    expect(wordDiff('const total = a + b;', 'const total = a - b;')).toEqual({
      old: [{ start: 16, end: 17 }],
      new: [{ start: 16, end: 17 }],
    });
    expect(wordDiff('same', 'same')).toEqual({ old: [], new: [] });
    // complete rewrites get no inner highlight
    expect(wordDiff('alpha', 'omega')).toEqual({ old: [], new: [] });
    const long = 'x'.repeat(WORD_DIFF_MAX_LINE + 1);
    expect(wordDiff(long, `${long}y`)).toEqual({ old: [], new: [] });
  });

  it('pairs consecutive -/+ runs of a hunk and ignores CR', () => {
    const h = hunk([
      ['context', 'keep'],
      ['del', 'let a = 1;\r'],
      ['del', 'let b = 2;\r'],
      ['add', 'let a = 10;\r'],
      ['context', 'mid'],
      ['add', 'only added'],
    ]);
    const m = hunkWordDiff(h);
    expect([...m.keys()].sort()).toEqual([1, 3]);
    expect(m.get(1)).toEqual([{ start: 8, end: 9 }]);
    expect(m.get(3)).toEqual([{ start: 8, end: 10 }]);
  });

  it('segments text by ranges', () => {
    expect(segments('abcdef', [{ start: 1, end: 3 }])).toEqual([
      { text: 'a', hl: false },
      { text: 'bc', hl: true },
      { text: 'def', hl: false },
    ]);
    expect(segments('abc', undefined)).toEqual([{ text: 'abc', hl: false }]);
  });
});
