import { describe, expect, it } from 'vitest';

import { atLeast, compareVersions, featureFlags, parseGitVersion, parseLfsVersion } from '../src';

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.47.1.windows.1', '2.47.1'],
    ['git version 2.39.3 (Apple Git-145)', '2.39.3'],
    ['git version 2.40.1\n', '2.40.1'],
    ['git version 2.36', '2.36.0'],
  ])('%s → %s', (input, expected) => {
    expect(parseGitVersion(input)?.version).toBe(expected);
  });

  it('returns null for garbage', () => {
    expect(parseGitVersion('hello')).toBeNull();
  });
});

describe('parseLfsVersion', () => {
  it('parses git-lfs banner', () => {
    expect(parseLfsVersion('git-lfs/3.6.0 (GitHub; windows amd64; go 1.23.1)')).toBe('3.6.0');
    expect(parseLfsVersion("git: 'lfs' is not a git command")).toBeUndefined();
  });
});

describe('version comparison & features', () => {
  it('compares tuples', () => {
    expect(compareVersions([2, 38, 0], [2, 36, 9])).toBeGreaterThan(0);
    expect(atLeast([2, 36, 0], [2, 36, 0])).toBe(true);
    expect(atLeast([2, 35, 9], [2, 36, 0])).toBe(false);
  });

  it('gates features by version and platform', () => {
    const old = featureFlags([2, 36, 0], 'win32');
    expect(old.worktreeListZ).toBe(true);
    expect(old.mergeTreeWriteTree).toBe(false);
    expect(old.builtinFsmonitor).toBe(false);
    const modern = featureFlags([2, 45, 0], 'linux');
    expect(modern.mergeTreeWriteTree).toBe(true);
    expect(modern.builtinFsmonitor).toBe(false); // no builtin fsmonitor on linux
  });
});
