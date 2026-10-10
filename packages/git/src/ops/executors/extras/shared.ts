import { GitError } from '../../../errors/classify';
import type { GitErrorCode } from '../../../types';
import { fail } from '../util';

/** Reject empty / control-char paths and patterns before they reach argv (always passed after `--`). */
export function assertSafePath(value: string, what = 'path'): string {
  if (!value || !value.trim() || /[\0\r\n]/.test(value))
    throw fail('Unknown', `Invalid ${what}: "${value}".`);
  return value;
}

/** Repo-relative path in git's `/` form. */
export const toGitPath = (p: string): string => assertSafePath(p).replace(/\\/g, '/').replace(/\/+$/, '');

/** Re-code an unclassified (`Unknown`) git failure as a domain error code, keeping message and stderr. */
export function recode(e: unknown, code: GitErrorCode): never {
  if (e instanceof GitError && e.code === 'Unknown') throw new GitError({ ...e.serialized, code });
  throw e;
}

/** Wrap an async step so unclassified failures surface as `code`. */
export async function as<T>(code: GitErrorCode, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return recode(e, code);
  }
}
