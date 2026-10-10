import type { FileChangeSummary } from '../types';
import { parseRawZ, type RawEntry } from './raw';

/**
 * Parsers for `--numstat -z` (spec 02 §6.9): `A\tD\tpath\0`, or for renames/copies
 * `A\tD\t\0old\0new\0`. `-\t-` means binary.
 */

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export function parseNumstatTokens(text: string, start = 0): NumstatEntry[] {
  const tokens = text.slice(start).split('\0');
  const out: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    const e: NumstatEntry = {
      path: m[3]!,
      additions: binary ? null : Number(m[1]),
      deletions: binary ? null : Number(m[2]),
      binary,
    };
    if (m[3] === '') {
      e.oldPath = tokens[++i] ?? '';
      e.path = tokens[++i] ?? '';
    }
    out.push(e);
  }
  return out;
}

/** `git diff --numstat -z` without a raw block. Status is inferred (R when a rename pair is present). */
export function parseNumstat(text: string): FileChangeSummary[] {
  return parseNumstatTokens(text).map((n) => {
    const s: FileChangeSummary = {
      path: n.path,
      status: n.oldPath !== undefined ? 'R' : 'M',
      additions: n.additions,
      deletions: n.deletions,
      binary: n.binary,
    };
    if (n.oldPath !== undefined) s.oldPath = n.oldPath;
    return s;
  });
}

/**
 * `--raw --numstat -z` combined output: the raw block (authoritative paths/status) followed by the
 * numstat block (counts). Entries are paired by order when the counts line up, by path otherwise.
 * Conflicted paths (raw `U`, plus git's extra stage-2 record for the same path) collapse into one entry.
 */
export function parseRawNumstat(text: string): FileChangeSummary[] {
  const { entries, end } = parseRawZ(text);
  const stats = parseNumstatTokens(text, end);
  const byPath = new Map<string, NumstatEntry>();
  for (const s of stats) if (!byPath.has(s.path)) byPath.set(s.path, s);
  const aligned = stats.length === entries.length;

  const out: FileChangeSummary[] = [];
  const unmerged = new Set<string>();
  entries.forEach((e: RawEntry, i) => {
    const path = e.newPath ?? e.oldPath ?? '';
    if (unmerged.has(path)) return;
    if (e.status === 'U') unmerged.add(path);
    const st = aligned ? stats[i] : byPath.get(path);
    const s: FileChangeSummary = {
      path,
      status: e.status,
      additions: st ? st.additions : null,
      deletions: st ? st.deletions : null,
      binary: st?.binary ?? false,
    };
    if ((e.status === 'R' || e.status === 'C') && e.oldPath !== null) s.oldPath = e.oldPath;
    out.push(s);
  });
  return out;
}
