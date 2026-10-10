/**
 * Client-side ref name checks run before `git check-ref-format` (spec 05 §4.3, §8 "Branch names"): readable
 * reasons for the common mistakes, existence, and names that differ only in case (they collide on the
 * case-insensitive file systems of Windows and macOS, where loose refs are files).
 */
export function refNameProblem(
  name: string,
  existing: readonly string[],
  o: { caseInsensitive: boolean; kind?: 'branch' | 'tag' } = { caseInsensitive: false },
): string | null {
  const what = o.kind === 'tag' ? 'tag' : 'branch';
  if (!name.trim()) return `Enter a ${what} name.`;
  if (name.startsWith('-')) return `A ${what} name cannot start with "-".`;
  if (name.includes('..')) return 'Name contains "..".';
  if (name.includes('@{')) return 'Name contains "@{".';
  if (/[~^:?*[\\\s]/.test(name))
    return 'Name contains a character git does not allow (~ ^ : ? * [ \\ or space).';
  if (name.endsWith('.lock')) return 'Name cannot end with ".lock".';
  if (name.endsWith('/') || name.startsWith('/') || name.includes('//'))
    return 'Name has an empty path segment.';
  if (name.endsWith('.')) return 'Name cannot end with ".".';
  if (name.split('/').some((seg) => seg.startsWith('.'))) return 'A path segment cannot start with ".".';
  if (existing.includes(name)) return `${what === 'tag' ? 'Tag' : 'Branch'} already exists.`;
  const lower = name.toLowerCase();
  const clash = existing.find((e) => e.toLowerCase() === lower);
  if (clash && o.caseInsensitive) {
    return `"${clash}" already exists and differs only in case; that collides on this file system.`;
  }
  // `feature` blocks `feature/x` and vice versa (refs are files and directories)
  const parent = existing.find((e) => name.startsWith(`${e}/`));
  if (parent)
    return `"${parent}" exists, so "${name}" cannot be created (rename or delete "${parent}" first).`;
  const child = existing.find((e) => e.startsWith(`${name}/`));
  if (child) return `"${child}" exists, so "${name}" cannot be created.`;
  return null;
}

/** Non-blocking warning for a case-only clash on case-sensitive systems (Linux). */
export function caseOnlyWarning(name: string, existing: readonly string[]): string | null {
  const lower = name.toLowerCase();
  const clash = existing.find((e) => e !== name && e.toLowerCase() === lower);
  return clash
    ? `"${clash}" differs only in case; the two branches will clash for anyone on Windows or macOS.`
    : null;
}

/** True when `commits` (newest first, graph order) form one parent chain: each one's first parent is the next. */
export function isChain(commits: readonly { sha: string; parents: readonly string[] }[]): boolean {
  for (let i = 0; i + 1 < commits.length; i++) {
    if (commits[i]!.parents[0] !== commits[i + 1]!.sha) return false;
  }
  return commits.length > 0;
}

/** Spaces become `-` while typing (spec 05 §4.3). */
export const normalizeRefInput = (v: string): string => v.replace(/\s/g, '-');
