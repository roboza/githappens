/** Recently opened files per repository for the file finder (spec 12 §4.8 "MRU per repo"). */

export const FILE_MRU_MAX = 50;
const PREFIX = 'finder:mru:';

const memory = new Map<string, string[]>();

/** Stable key for a repository path (case-insensitive, forward slashes). */
export const finderRepoKey = (repoPath: string): string =>
  repoPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function getFileMru(repoKey: string): string[] {
  const s = storage();
  if (s) {
    try {
      const parsed: unknown = JSON.parse(s.getItem(PREFIX + repoKey) ?? '[]');
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string').slice(0, FILE_MRU_MAX);
      }
    } catch {
      /* corrupt / blocked: fall back to memory */
    }
  }
  return [...(memory.get(repoKey) ?? [])];
}

export function recordFileMru(repoKey: string, path: string): void {
  const next = [path, ...getFileMru(repoKey).filter((p) => p !== path)].slice(0, FILE_MRU_MAX);
  memory.set(repoKey, next);
  try {
    storage()?.setItem(PREFIX + repoKey, JSON.stringify(next));
  } catch {
    /* quota / blocked storage: keep the in-memory copy */
  }
}
