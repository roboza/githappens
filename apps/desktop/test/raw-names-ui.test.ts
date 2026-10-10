import { rawIgnorePatternFor, rawPathKey, shownPath } from '@githappens/git/ops';
import type { StatusEntry } from '@githappens/git/types';
import { describe, expect, it } from 'vitest';

import {
  opKeyMapper,
  opPathOf,
  wipDiffSpec,
  wipRows,
} from '../src/renderer/src/views/composer/staging-helpers';

/**
 * Phase 11 (spec 02 §8): the staging panel acts on names that are not valid UTF-8 by their raw bytes
 * (`rawPathKey(rawPath)`), while showing the lossy decoded name.
 */

// "laté.txt" in Latin-1 and its (lossy) decoded form
const RAW = Buffer.from([0x6c, 0x61, 0x74, 0xe9, 0x2e, 0x74, 0x78, 0x74]).toString('base64');
const SHOWN = 'lat�.txt';
const KEY = rawPathKey(RAW);

const ordinary = (path: string, index: string, worktree: string, rawPath?: string): StatusEntry =>
  ({
    kind: 'ordinary',
    path,
    ...(rawPath ? { rawPath } : {}),
    index,
    worktree,
    submodule: null,
    modeHead: '100644',
    modeIndex: '100644',
    modeWorktree: '100644',
    shaHead: '0'.repeat(40),
    shaIndex: '0'.repeat(40),
  }) as StatusEntry;

describe('non-UTF-8 names in the staging panel', () => {
  const entries: StatusEntry[] = [
    ordinary(SHOWN, 'M', 'M', RAW),
    ordinary('plain.txt', '.', 'M'),
    {
      kind: 'untracked',
      path: `new/${SHOWN}`,
      rawPath: Buffer.from(`new/${shownPath(KEY)}`).toString('base64'),
    },
    {
      kind: 'renamed',
      path: 'renamed.txt',
      origPath: SHOWN,
      origRawPath: RAW,
      op: 'R',
      score: 100,
      index: 'R',
      worktree: '.',
    } as unknown as StatusEntry,
  ];

  it('rows carry the raw key and show the decoded name', () => {
    const { unstaged, staged } = wipRows(entries);
    expect(unstaged.map((r) => [r.path, r.rawKey])).toEqual([
      [SHOWN, KEY],
      ['plain.txt', undefined],
      [`new/${SHOWN}`, expect.stringMatching(/^\0raw:/)],
    ]);
    expect(staged.map((r) => [r.path, r.rawKey, r.oldPath, r.oldRawKey])).toEqual([
      [SHOWN, KEY, undefined, undefined],
      ['renamed.txt', undefined, SHOWN, KEY],
    ]);
    expect(unstaged.map(opPathOf)).toEqual([KEY, 'plain.txt', unstaged[2]!.rawKey]);
  });

  it('stage / unstage / drag & drop map shown paths to raw keys', () => {
    const { unstaged, staged } = wipRows(entries);
    const keys = opKeyMapper([...unstaged, ...staged]);
    expect(keys([SHOWN, 'plain.txt'])).toEqual([KEY, 'plain.txt']);
    expect(opKeyMapper([{ path: 'a', status: 'M', untracked: false }])(['a'])).toEqual(['a']);
  });

  it('diffs (staging panel and external diff tool) address the file by its key', () => {
    const { unstaged, staged } = wipRows(entries);
    expect(wipDiffSpec(unstaged[0]!, 'unstaged')).toEqual({ kind: 'workdir', paths: [KEY] });
    expect(wipDiffSpec(unstaged[2]!, 'unstaged')).toEqual({ kind: 'untracked', path: unstaged[2]!.rawKey });
    expect(wipDiffSpec(staged[1]!, 'staged')).toEqual({ kind: 'staged', paths: [KEY, 'renamed.txt'] });
  });

  it('ignore patterns match the bytes', () => {
    expect(rawIgnorePatternFor('file', KEY)).toBe('/lat?.txt');
    expect(rawIgnorePatternFor('extension', KEY)).toBe('*.txt');
  });
});
