import type { GitService } from '@githappens/git';
import { describe, expect, it } from 'vitest';

import { lfsLocksFailure, listLfsLocks, parseLfsVerifyJson } from '../src/main/remotes/remote-reads';
import {
  attributePatternRegExp,
  lfsInUse,
  lfsMatcher,
  parsePatterns,
} from '../src/renderer/src/views/lfs/lfs-model';

const lock = (id: string, p: string, owner: string) => ({
  id,
  path: p,
  owner: { name: owner },
  locked_at: '2026-10-01T10:00:00Z',
});

describe('LFS locks parsing', () => {
  it('parses `git lfs locks --verify --json` into ours / theirs', () => {
    const out = JSON.stringify({ ours: [lock('2', 'b.psd', 'me')], theirs: [lock('1', 'a.psd', 'pat')] });
    expect(parseLfsVerifyJson(out)).toEqual([
      { id: '1', path: 'a.psd', owner: 'pat', lockedAt: '2026-10-01T10:00:00Z', ours: false },
      { id: '2', path: 'b.psd', owner: 'me', lockedAt: '2026-10-01T10:00:00Z', ours: true },
    ]);
    expect(parseLfsVerifyJson('{"ours":[]}')).toEqual([]);
    expect(parseLfsVerifyJson('[]')).toBeNull();
    expect(parseLfsVerifyJson('not json')).toBeNull();
    expect(parseLfsVerifyJson('{}')).toBeNull();
  });

  it('classifies failures', () => {
    expect(lfsLocksFailure("git: 'lfs' is not a git command. See 'git --help'.")).toEqual({
      supported: false,
      error: 'git-lfs is not installed.',
    });
    expect(
      lfsLocksFailure('Remote "origin" does not support the Git LFS locking API (HTTP 404)').supported,
    ).toBe(false);
    expect(lfsLocksFailure('error: authentication required\nmore')).toEqual({
      supported: true,
      error: 'authentication required',
    });
  });

  it('falls back to the unverified listing, then reports failures', async () => {
    const calls: string[][] = [];
    const fake = (results: Array<{ exitCode: number; stdout?: string; stderr?: string }>) =>
      ({
        runRead: async (args: string[]) => {
          calls.push(args);
          const r = results.shift()!;
          return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
      }) as unknown as GitService;

    const verified = await listLfsLocks(
      fake([{ exitCode: 0, stdout: JSON.stringify({ ours: [lock('1', 'x.bin', 'me')], theirs: [] }) }]),
    );
    expect(verified).toEqual({
      supported: true,
      locks: [{ id: '1', path: 'x.bin', owner: 'me', lockedAt: '2026-10-01T10:00:00Z', ours: true }],
    });
    expect(calls[0]).toEqual(['lfs', 'locks', '--verify', '--json']);

    const unverified = await listLfsLocks(
      fake([
        { exitCode: 2, stderr: 'verify not supported' },
        { exitCode: 0, stdout: JSON.stringify([lock('5', 'y.bin', 'pat')]) },
      ]),
    );
    expect(unverified.locks).toEqual([
      { id: '5', path: 'y.bin', owner: 'pat', lockedAt: '2026-10-01T10:00:00Z', ours: null },
    ]);

    const none = await listLfsLocks(
      fake([
        { exitCode: 2, stderr: 'x' },
        { exitCode: 2, stderr: 'Server returned 501 Not Implemented' },
      ]),
    );
    expect(none).toEqual({
      supported: false,
      locks: [],
      error: 'The LFS server does not support file locking.',
    });
  });
});

describe('LFS pattern matching (file badge)', () => {
  it('follows .gitattributes rules', () => {
    const is = lfsMatcher([
      { pattern: '*.psd' },
      { pattern: 'assets/**' },
      { pattern: '/root.bin' },
      { pattern: 'docs/*.pdf' },
    ]);
    expect(is('a.psd')).toBe(true);
    expect(is('art/deep/b.psd')).toBe(true);
    expect(is('art\\win\\c.psd')).toBe(true);
    expect(is('a.psd.txt')).toBe(false);
    expect(is('assets/x/y.png')).toBe(true);
    expect(is('src/assets/y.png')).toBe(false);
    expect(is('root.bin')).toBe(true);
    expect(is('sub/root.bin')).toBe(false);
    expect(is('docs/a.pdf')).toBe(true);
    expect(is('docs/sub/a.pdf')).toBe(false);
    expect(lfsMatcher([])('a.psd')).toBe(false);
    expect(attributePatternRegExp('**/*.zip').test('a/b/c.zip')).toBe(true);
    expect(attributePatternRegExp('**/*.zip').test('c.zip')).toBe(true);
    expect(attributePatternRegExp('file[0-9].bin').test('x/file7.bin')).toBe(true);
    expect(attributePatternRegExp('a?.dat').test('ab.dat')).toBe(true);
  });

  it('parses track / convert pattern input', () => {
    expect(parsePatterns('*.psd, *.zip\n*.psd')).toEqual({ patterns: ['*.psd', '*.zip'] });
    expect(parsePatterns(' ')).toHaveProperty('error');
    expect(parsePatterns('-x')).toHaveProperty('error');
  });

  it('shows the toolbar menu when LFS is in use (patterns or hooks)', () => {
    expect(lfsInUse(undefined)).toBe(false);
    expect(lfsInUse({ available: true, initialized: true, tracked: [] })).toBe(true);
    expect(
      lfsInUse({ available: true, initialized: false, tracked: [{ pattern: '*.a', lockable: false }] }),
    ).toBe(true);
    expect(lfsInUse({ available: true, initialized: false, tracked: [] })).toBe(false);
    expect(lfsInUse({ available: false, initialized: true, tracked: [] })).toBe(false);
  });
});
