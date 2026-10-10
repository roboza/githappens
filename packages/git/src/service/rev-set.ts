import { GitError, makeError } from '../errors/classify';
import type { LogQuery, Sha } from '../types';

/**
 * Every rev-set the engine builds goes through here (spec 02 §11): graph log, search, file history.
 * It never passes a bare `--all`, and `refs/githappens/*` (undo keep-alive refs) is always excluded.
 *
 * `revs: 'all'` expands to branches, remotes and tags + HEAD + stash reflog tips (spec 02 §6.6). Each
 * category is emitted as `--glob=refs/<x>/*` so hidden refs can be given as full ref names or globs
 * (`refs/remotes/upstream/*`): `--exclude` only applies to the next pseudo-option and, unlike with
 * `--branches`, matches full ref names when followed by `--glob`.
 */

export const HIDDEN_NAMESPACE_EXCLUDE = '--exclude=refs/githappens/*';

export interface RevSetQuery {
  revs: LogQuery['revs'];
  hiddenRefs?: string[];
  /** Include HEAD (false when HEAD is unborn, or git would fail on it). Default true. */
  includeHead?: boolean;
  /** `refs/stash` reflog SHAs (spec 04 places stash rows from these). */
  stashTips?: Sha[];
}

/** Reject anything git could parse as an option. Exclusions (`^rev`) and ranges are allowed. */
export function assertSafeRev(rev: string): void {
  if (!rev || rev.startsWith('-') || /[\0\n\r]/.test(rev)) {
    throw new GitError(makeError('InvalidRefName', { argv: [] }, `Invalid revision: ${rev}`));
  }
}

export function buildRevSet(q: RevSetQuery): string[] {
  if (q.revs !== 'all') {
    for (const r of q.revs) assertSafeRev(r);
    return [...q.revs];
  }
  const excludes = [HIDDEN_NAMESPACE_EXCLUDE, ...(q.hiddenRefs ?? []).map((r) => `--exclude=${r}`)];
  const args: string[] = [];
  for (const ns of ['refs/heads/*', 'refs/remotes/*', 'refs/tags/*']) args.push(...excludes, `--glob=${ns}`);
  if (q.includeHead !== false) args.push('HEAD');
  for (const sha of q.stashTips ?? []) {
    assertSafeRev(sha);
    args.push(sha);
  }
  return args;
}
