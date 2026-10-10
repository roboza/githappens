import type { DiffHunk } from '@githappens/git/types';

/**
 * Line selection model for hunk/line staging (spec 06 §4.4). Pure: keys are `"<hunk>:<line>"`, only
 * `add`/`del` lines are selectable, and the end-of-file `-`/`+` pair (around a "\ No newline" marker)
 * is always selected together, mirroring the executor's `selectLines` rule (spec 06 §6.5).
 */

export const selKey = (h: number, l: number): string => `${h}:${l}`;
export const isChange = (t: string): boolean => t === 'add' || t === 'del';

/**
 * The end-of-file pair of a hunk (spec 06 §6.5): a "\ No newline" change at the end of the file is
 * linked with its counterpart line so selecting either selects both. Lines are paired by position in
 * the final change run (`dels[k]` ↔ `adds[k]`): when both sides lack the final newline the last `-`
 * and last `+` pair; when only the old side does, the marked last `-` pairs with the `+` at the same
 * position (e.g. adding the final newline: `-b⏎\ No newline` ↔ `+b`); mirrored for the new side.
 * Lines added or removed beyond the pair stay independent (`buildHunks` keeps any selection valid).
 */
export function eofPair(h: Pick<DiffHunk, 'lines'>): [number, number] | null {
  const lines = h.lines;
  const marked = (i: number): boolean => lines[i + 1]?.type === 'nonewline';
  // the final change run: everything after the last context line
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.type !== 'context') start--;
  const dels: number[] = [];
  const adds: number[] = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.type === 'del') dels.push(i);
    else if (lines[i]!.type === 'add') adds.push(i);
  }
  if (!dels.length || !adds.length) return null;
  const lastDel = dels[dels.length - 1]!;
  const lastAdd = adds[adds.length - 1]!;
  if (marked(lastDel) && marked(lastAdd)) return [lastDel, lastAdd];
  if (marked(lastDel)) {
    const a = adds[dels.length - 1];
    return a === undefined ? null : [lastDel, a];
  }
  if (marked(lastAdd)) {
    const d = dels[adds.length - 1];
    return d === undefined ? null : [d, lastAdd];
  }
  return null;
}

/** The keys a click on (h, l) affects: the line, plus its EOF partner. */
export function linkedKeys(hunks: Pick<DiffHunk, 'lines'>[], h: number, l: number): string[] {
  const line = hunks[h]?.lines[l];
  if (!line || !isChange(line.type)) return [];
  const pair = eofPair(hunks[h]!);
  if (pair && (pair[0] === l || pair[1] === l)) return [selKey(h, pair[0]), selKey(h, pair[1])];
  return [selKey(h, l)];
}

/** Toggle one line (and its EOF partner). */
export function toggleLine(
  sel: ReadonlySet<string>,
  hunks: Pick<DiffHunk, 'lines'>[],
  h: number,
  l: number,
): Set<string> {
  const keys = linkedKeys(hunks, h, l);
  const next = new Set(sel);
  const on = !keys.every((k) => next.has(k));
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  return next;
}

/** Set one line (and its partner) to a paint state (drag-paint keeps adding or removing). */
export function paintLine(
  sel: ReadonlySet<string>,
  hunks: Pick<DiffHunk, 'lines'>[],
  h: number,
  l: number,
  on: boolean,
): Set<string> {
  const keys = linkedKeys(hunks, h, l);
  if (keys.every((k) => sel.has(k) === on)) return sel as Set<string>;
  const next = new Set(sel);
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  return next;
}

/**
 * Shift+click: select every changed line between the anchor and (h, l) in diff order (across hunks),
 * optionally restricted to one line type (split view: left = `del`, right = `add`).
 */
export function rangeSelect(
  sel: ReadonlySet<string>,
  hunks: Pick<DiffHunk, 'lines'>[],
  anchor: { h: number; l: number },
  to: { h: number; l: number },
  only?: 'add' | 'del',
): Set<string> {
  const before = (a: { h: number; l: number }, b: { h: number; l: number }): boolean =>
    a.h < b.h || (a.h === b.h && a.l <= b.l);
  const [from, end] = before(anchor, to) ? [anchor, to] : [to, anchor];
  const next = new Set(sel);
  for (let h = from.h; h <= end.h; h++) {
    const lines = hunks[h]?.lines ?? [];
    const lo = h === from.h ? from.l : 0;
    const hi = h === end.h ? end.l : lines.length - 1;
    for (let l = lo; l <= hi; l++) {
      const t = lines[l]?.type;
      if (!t || !isChange(t) || (only && t !== only)) continue;
      for (const k of linkedKeys(hunks, h, l)) next.add(k);
    }
  }
  return next;
}

/** Selected keys → `LineRef`s for the `wip.*Lines` ops. */
export function toLineRefs(sel: ReadonlySet<string>): { hunkIndex: number; lineIndex: number }[] {
  return [...sel]
    .map((k) => {
      const [h, l] = k.split(':').map(Number);
      return { hunkIndex: h!, lineIndex: l! };
    })
    .sort((a, b) => a.hunkIndex - b.hunkIndex || a.lineIndex - b.lineIndex);
}

/** Drop keys that no longer point at a changed line (after the diff refreshed). */
export function pruneLineSelection(sel: ReadonlySet<string>, hunks: Pick<DiffHunk, 'lines'>[]): Set<string> {
  const next = new Set<string>();
  for (const k of sel) {
    const [h, l] = k.split(':').map(Number);
    const t = hunks[h!]?.lines[l!]?.type;
    if (t && isChange(t)) next.add(k);
  }
  return next;
}

/** One row of a side-by-side hunk: line indexes into `hunk.lines` for each side (absent = filler). */
export interface SplitRow {
  left?: number;
  right?: number;
  /** "\ No newline at end of file" marker after the line on that side. */
  leftNoEol?: boolean;
  rightNoEol?: boolean;
}

/**
 * Side-by-side rows for a hunk (spec 06 §4.4 split view): context lines on both sides; a run of `-`
 * lines followed by `+` lines is paired row by row, extra lines get a blank cell on the other side.
 */
export function splitRows(h: Pick<DiffHunk, 'lines'>): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = h.lines;
  let i = 0;
  const markAfter = (row: SplitRow, side: 'left' | 'right', idx: number): void => {
    if (lines[idx + 1]?.type === 'nonewline') {
      if (side === 'left') row.leftNoEol = true;
      else row.rightNoEol = true;
    }
  };
  while (i < lines.length) {
    const t = lines[i]!.type;
    if (t === 'nonewline') {
      i++;
      continue;
    }
    if (t === 'context') {
      const row: SplitRow = { left: i, right: i };
      if (lines[i + 1]?.type === 'nonewline') {
        row.leftNoEol = true;
        row.rightNoEol = true;
      }
      rows.push(row);
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && (lines[i]!.type === 'del' || lines[i]!.type === 'nonewline')) {
      if (lines[i]!.type === 'del') dels.push(i);
      i++;
    }
    while (i < lines.length && (lines[i]!.type === 'add' || lines[i]!.type === 'nonewline')) {
      if (lines[i]!.type === 'add') adds.push(i);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const row: SplitRow = {};
      if (dels[k] !== undefined) {
        row.left = dels[k];
        markAfter(row, 'left', dels[k]!);
      }
      if (adds[k] !== undefined) {
        row.right = adds[k];
        markAfter(row, 'right', adds[k]!);
      }
      rows.push(row);
    }
  }
  return rows;
}
