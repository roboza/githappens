import fs from 'node:fs';
import path from 'node:path';

/**
 * One canonical form for repository / workspace paths entering the main process (CLI args, folder
 * pickers, scans, open requests, stored records). `fs.realpathSync.native` resolves symlinks / junctions
 * and, on Windows, expands 8.3 short names (`C:\Users\RUNNER~1` → `C:\Users\runneradmin`) and fixes the
 * case of each segment, so two spellings of one folder compare equal. The JS `fs.realpathSync` does not
 * expand short names, hence the native variant everywhere.
 */
export type RealpathFn = (p: string) => string;

const nativeRealpath: RealpathFn = (p) => fs.realpathSync.native(p);

/** Absolute, realpath'd (native) path; a missing path keeps its tail on the realpath of its nearest existing ancestor. */
export function canonicalPath(p: string, realpath: RealpathFn = nativeRealpath): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpath(cur);
      return stripTrailingSep(tail.length ? path.join(real, ...tail.reverse()) : real);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return stripTrailingSep(abs);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Comparison key: canonical path, case-folded on case-insensitive platforms (Windows / macOS). */
export function canonicalKey(
  p: string,
  platform: NodeJS.Platform = process.platform,
  realpath: RealpathFn = nativeRealpath,
): string {
  const c = canonicalPath(p, realpath);
  return platform === 'win32' || platform === 'darwin' ? c.toLowerCase() : c;
}

function stripTrailingSep(p: string): string {
  // Keep filesystem roots (`/`, `C:\`) intact.
  return p.length > path.parse(p).root.length ? p.replace(/[\\/]+$/, '') : p;
}
