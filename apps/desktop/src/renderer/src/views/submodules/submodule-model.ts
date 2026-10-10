import type { SubmoduleInfo } from '@githappens/git/types';

/** Pure submodule helpers (spec 09 §4.1 SUBMODULES, §6.9). */

/** Default path for a new submodule: the repo name of its URL (`…/owner/lib.git` → `lib`). */
export function submodulePathFromUrl(url: string): string {
  const last =
    url
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/** Relative path inside the repo: no absolute paths, no `..`, no `.git`. */
export function validateSubmodulePath(p: string): string | null {
  const v = p.trim();
  if (!v) return 'Enter a path.';
  if (/[\0\r\n]/.test(v)) return 'Invalid path.';
  if (/^(?:[A-Za-z]:)?[\\/]/.test(v)) return 'Use a path relative to the repository root.';
  const segs = v.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) return 'The path must stay inside the repository.';
  if (segs.some((s) => s.toLowerCase() === '.git')) return 'The path must not contain .git.';
  return null;
}

/** State icon / text for a row (spec 09 §4.1 "● in sync, ↻ out of sync, ○ not initialized, ⚠ conflict"). */
export function submoduleStateLabel(state: SubmoduleInfo['state']): { icon: string; text: string } {
  switch (state) {
    case 'in-sync':
      return { icon: '●', text: 'in sync' };
    case 'out-of-sync':
      return { icon: '↻', text: 'out of sync' };
    case 'uninitialized':
      return { icon: '○', text: 'not initialized' };
    case 'conflict':
      return { icon: '⚠', text: 'conflict' };
  }
}

/** Banner text when the submodule HEAD moved away from the parent's gitlink. */
export function pointerChangeText(o: { path: string; from: string | null; to: string | null }): string {
  const s = (x: string | null): string => (x ? x.slice(0, 7) : 'none');
  return `Submodule ${o.path} pointer changed (${s(o.from)} → ${s(o.to)}).`;
}
