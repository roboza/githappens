import { fuzzyScore, mruBoost } from '../../commands/fuzzy';

/**
 * Fuzzy file finder scoring (spec 12 §4.8 / §6.8). DOM-free so it runs in node tests and in the
 * finder Web Worker. Paths are repo-relative with `/` separators.
 */

/** Lists larger than this are scored in a Web Worker (spec 12 §6.8). */
export const WORKER_THRESHOLD = 20_000;
export const FINDER_LIMIT = 200;
/** Extra score when the whole query matches inside the file name (users mostly type names). */
const BASENAME_BONUS = 24;

export interface FileMatch {
  path: string;
  score: number;
}

const baseStart = (p: string): number => p.lastIndexOf('/') + 1;

/** Score one path, or null when the query is not a subsequence of it. */
export function scoreFile(query: string, path: string, mru?: readonly string[]): number | null {
  const full = fuzzyScore(query, path);
  if (!full) return null;
  let score = full.score;
  const start = baseStart(path);
  if (start > 0 && query.trim()) {
    const base = fuzzyScore(query, path.slice(start));
    if (base) score = Math.max(score, base.score + BASENAME_BONUS);
  }
  return score + mruBoost(path, mru);
}

/**
 * Rank `files` for `query`: best score first, then shorter path, then alphabetical. An empty query
 * lists recently opened files (MRU order) first, then the rest in input order.
 */
export function rankFiles(
  files: readonly string[],
  query: string,
  mru: readonly string[] = [],
  limit = FINDER_LIMIT,
): FileMatch[] {
  if (!query.trim()) {
    const known = new Set(files);
    const recent = mru.filter((p) => known.has(p));
    const seen = new Set(recent);
    const out: FileMatch[] = recent.map((path) => ({ path, score: mruBoost(path, mru) }));
    for (const path of files) {
      if (out.length >= limit) break;
      if (!seen.has(path)) out.push({ path, score: 0 });
    }
    return out.slice(0, limit);
  }
  const out: FileMatch[] = [];
  for (const path of files) {
    const score = scoreFile(query, path, mru);
    if (score !== null) out.push({ path, score });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return out.slice(0, limit);
}

/** Which command Enter runs in the files picker (spec 12 §4.8). */
export type FileEnterAction = 'file.open' | 'history.file' | 'history.blame' | 'file.edit';

export function fileEnterAction(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): FileEnterAction {
  if (e.ctrlKey || e.metaKey) return 'history.file';
  if (e.altKey) return 'history.blame';
  if (e.shiftKey) return 'file.edit';
  return 'file.open';
}
