import type { GitFeatureFlags, VersionTuple } from '../types';

/** Minimum supported *system* git (spec 00 "Git version policy"). */
export const MIN_SYSTEM_GIT: VersionTuple = [2, 36, 0];
/** Minimum bundled git; we control it and need `merge-tree --write-tree`. */
export const MIN_BUNDLED_GIT: VersionTuple = [2, 38, 0];

/** Parses `git version 2.47.1.windows.1` / `git version 2.39.3 (Apple Git-145)`. */
export function parseGitVersion(output: string): { version: string; tuple: VersionTuple } | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return null;
  const tuple: VersionTuple = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  return { version: tuple.join('.'), tuple };
}

/** Parses `git-lfs/3.6.0 (GitHub; windows amd64; go 1.23.1)`. */
export function parseLfsVersion(output: string): string | undefined {
  const m = /git-lfs\/(\d+\.\d+\.\d+)/.exec(output);
  return m?.[1];
}

export function compareVersions(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const atLeast = (v: VersionTuple, min: VersionTuple): boolean => compareVersions(v, min) >= 0;

export function featureFlags(v: VersionTuple, platform: NodeJS.Platform): GitFeatureFlags {
  return {
    worktreeListZ: atLeast(v, [2, 36, 0]),
    statusShowStash: atLeast(v, [2, 35, 0]),
    pathspecFromFile: atLeast(v, [2, 26, 0]),
    forceIfIncludes: atLeast(v, [2, 30, 0]),
    mergeTreeWriteTree: atLeast(v, [2, 38, 0]),
    builtinFsmonitor: atLeast(v, [2, 37, 0]) && (platform === 'win32' || platform === 'darwin'),
    configShowScope: atLeast(v, [2, 26, 0]),
  };
}
