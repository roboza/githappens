import type { FileDiff } from '../types';

/**
 * Parser for the `--raw -z` block emitted by `git diff`/`diff-tree` (spec 02 §6.9):
 * `:<oldmode> <newmode> <oldsha> <newsha> <status>[score]\0<path>\0[<path2>\0]`.
 * Combined (merge/conflict) records start with `::` and carry one mode/sha per parent.
 */

export interface RawEntry {
  status: FileDiff['status'];
  /** Raw status letter(s) as printed by git, e.g. `R087`, `MM` for combined records. */
  rawStatus: string;
  score?: number;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  oldPath: string | null;
  newPath: string | null;
  /** `::` record from a combined diff (conflicted path in the worktree). */
  combined: boolean;
}

const ZERO = /^0+$/;
const STATUSES = new Set(['A', 'D', 'M', 'R', 'C', 'T', 'U']);

export function isZeroSha(s: string | undefined): boolean {
  return !s || ZERO.test(s);
}

/**
 * Parse raw records starting at `start`. Returns the entries and the offset just past the raw block
 * (callers continue with numstat tokens or patch text from there).
 */
export function parseRawZ(text: string, start = 0): { entries: RawEntry[]; end: number } {
  const entries: RawEntry[] = [];
  let pos = start;
  const next = (): string | null => {
    const i = text.indexOf('\0', pos);
    if (i < 0) return null;
    const tok = text.slice(pos, i);
    pos = i + 1;
    return tok;
  };
  while (pos < text.length && text[pos] === ':') {
    const header = next();
    if (header === null) break;
    let colons = 0;
    while (header[colons] === ':') colons++;
    const parts = header.slice(colons).split(' ');
    const n = colons; // number of parents
    const modes = parts.slice(0, n + 1);
    const shas = parts.slice(n + 1, 2 * n + 2);
    const rawStatus = parts[2 * n + 2] ?? '';
    const combined = n > 1;
    const letter = combined ? 'U' : (rawStatus[0] ?? 'M');
    const status = (STATUSES.has(letter) ? letter : 'M') as FileDiff['status'];
    const p1 = next() ?? '';
    let oldPath: string | null = p1;
    let newPath: string | null = p1;
    if (!combined && (letter === 'R' || letter === 'C')) newPath = next() ?? '';
    if (status === 'A') oldPath = null;
    if (status === 'D') newPath = null;
    const e: RawEntry = {
      status,
      rawStatus,
      oldMode: modes[0] ?? '',
      newMode: modes[modes.length - 1] ?? '',
      oldSha: shas[0] ?? '',
      newSha: shas[shas.length - 1] ?? '',
      oldPath,
      newPath,
      combined,
    };
    if (!combined && rawStatus.length > 1 && /^\d+$/.test(rawStatus.slice(1))) {
      e.score = Number(rawStatus.slice(1));
    }
    entries.push(e);
  }
  return { entries, end: pos };
}
