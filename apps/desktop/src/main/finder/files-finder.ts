import type { RefreshScope, RepoId } from '@githappens/git/types';

/**
 * File list for the fuzzy file finder (spec 12 §4.8 / §6.8): `git ls-files -co --exclude-standard -z`,
 * cached per repo and dropped when the watcher reports worktree changes. Concurrent requests share one
 * git process.
 */

export const LS_FILES_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] as const;

/**
 * Parse NUL-separated `ls-files -z` output: no quoting or escaping, so paths with spaces, newlines,
 * quotes or any unicode come through verbatim. Duplicates (unmerged index stages) are dropped.
 */
export function parseLsFilesZ(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of stdout.split('\0')) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export interface FilesFinderDeps {
  /** Run a read-only git command in the repo and return stdout. */
  read(repoId: RepoId, args: string[]): Promise<string>;
}

/** Scopes that can add / remove files in the worktree. */
const INVALIDATING: ReadonlySet<RefreshScope> = new Set(['status', 'refs', 'submodules', 'repoState']);

export class FilesFinder {
  private cache = new Map<RepoId, { files?: string[]; pending?: Promise<string[]>; gen: number }>();

  constructor(private readonly deps: FilesFinderDeps) {}

  async list(repoId: RepoId, refresh = false): Promise<string[]> {
    const cur = this.cache.get(repoId);
    if (!refresh && cur?.files) return cur.files;
    if (!refresh && cur?.pending) return cur.pending;
    const gen = (cur?.gen ?? 0) + 1;
    const pending = this.deps
      .read(repoId, [...LS_FILES_ARGS])
      .then(parseLsFilesZ)
      .then(
        (files) => {
          const now = this.cache.get(repoId);
          // Only cache if nothing invalidated the list while git was running.
          if (now?.gen === gen) this.cache.set(repoId, { files, gen });
          return files;
        },
        (e: unknown) => {
          const now = this.cache.get(repoId);
          if (now?.gen === gen) this.cache.delete(repoId);
          throw e;
        },
      );
    this.cache.set(repoId, { pending, gen });
    return pending;
  }

  /** Watcher hook (`RepoManager.onChanged`). */
  onRepoChanged(repoId: RepoId, scopes: readonly RefreshScope[]): void {
    if (scopes.some((s) => INVALIDATING.has(s))) this.invalidate(repoId);
  }

  invalidate(repoId: RepoId): void {
    const cur = this.cache.get(repoId);
    if (cur) this.cache.set(repoId, { gen: cur.gen + 1 });
  }

  forget(repoId: RepoId): void {
    this.cache.delete(repoId);
  }
}
