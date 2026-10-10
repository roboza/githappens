import path from 'node:path';

import { canonicalPath, type RealpathFn } from './canonical-path';

/**
 * Repo paths to open from the command line (spec 03): `githappens -p <path>`,
 * `--path <path>`, `--path=<path>`, or (packaged builds only) a bare positional
 * path such as `githappens .`. In development argv contains electron's own args
 * (e.g. `.` for the app dir), so positionals are ignored there.
 */
export function parseOpenPathArgs(
  argv: string[],
  isPackaged: boolean,
  cwd: string,
  realpath?: RealpathFn,
): string[] {
  // Canonical form (Windows 8.3 short names expanded) so a short and a long spelling of one folder
  // open / dedupe as the same repository.
  const resolve = (v: string): string => canonicalPath(path.resolve(cwd, v), realpath);
  // Packaged: argv = [exe, ...args]. Dev: argv = [electron, appDir, ...args].
  const args = argv.slice(isPackaged ? 1 : 2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-p' || a === '--path') {
      const v = args[++i];
      if (v) out.push(resolve(v));
    } else if (a.startsWith('--path=')) {
      out.push(resolve(a.slice('--path='.length)));
    } else if (isPackaged && !a.startsWith('-')) {
      out.push(resolve(a));
    }
  }
  return [...new Set(out)];
}
