import type { DiffHunk } from '@githappens/git/types';

/**
 * Word-level highlights for the hunk renderer (spec 07 §6.5): pair consecutive `-`/`+` runs, tokenize
 * each pair with `/\w+|\s+|[^\w\s]/gu`, run Myers on the token arrays and mark the changed tokens.
 * Pure — no DOM.
 */

/** Lines longer than this skip word diff (spec 07 §6.5). */
export const WORD_DIFF_MAX_LINE = 2000;

const TOKEN = /\w+|\s+|[^\w\s]/gu;

export function tokenize(line: string): string[] {
  return line.match(TOKEN) ?? [];
}

/** Half-open character range `[start, end)`. */
export interface Range {
  start: number;
  end: number;
}

/**
 * Myers O(ND) diff over two token arrays; returns, per side, which token indices are not part of the
 * LCS. Falls back to "everything changed" past `maxD` edits (pathological pairs).
 */
export function diffTokens(a: string[], b: string[], maxD = 400): { a: boolean[]; b: boolean[] } {
  const n = a.length;
  const m = b.length;
  const changedA = new Array<boolean>(n).fill(true);
  const changedB = new Array<boolean>(m).fill(true);
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return { a: changedA, b: changedB };
  // backtrack through the saved V arrays, marking diagonal (equal) moves
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (d === 0) prevK = 0;
    else prevK = k === -d || (k !== d && vd[off + k - 1]! < vd[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      changedA[x] = false;
      changedB[y] = false;
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return { a: changedA, b: changedB };
}

function toRanges(tokens: string[], changed: boolean[]): Range[] {
  const out: Range[] = [];
  let pos = 0;
  tokens.forEach((t, i) => {
    const end = pos + t.length;
    if (changed[i]) {
      const last = out[out.length - 1];
      if (last && last.end === pos) last.end = end;
      else out.push({ start: pos, end });
    }
    pos = end;
  });
  return out;
}

/** Changed character ranges of an old/new line pair (empty arrays when too long or identical). */
export function wordDiff(oldLine: string, newLine: string): { old: Range[]; new: Range[] } {
  if (oldLine.length > WORD_DIFF_MAX_LINE || newLine.length > WORD_DIFF_MAX_LINE || oldLine === newLine) {
    return { old: [], new: [] };
  }
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const d = diffTokens(a, b);
  const old = toRanges(a, d.a);
  const neu = toRanges(b, d.b);
  // a pair with nothing in common is a rewrite, not a word change: no inner highlight
  if (old.length === 1 && neu.length === 1 && old[0]!.start === 0 && neu[0]!.start === 0) {
    if (old[0]!.end === oldLine.length && neu[0]!.end === newLine.length) return { old: [], new: [] };
  }
  return { old, new: neu };
}

/**
 * Word ranges for every paired line of a hunk, keyed by line index. Each run of `-` lines directly followed
 * by a run of `+` lines pairs up position by position (the shorter run decides how many pairs).
 */
export function hunkWordDiff(hunk: DiffHunk): Map<number, Range[]> {
  const out = new Map<number, Range[]>();
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.type === 'del') i++;
    const delEnd = i;
    // a "\ No newline" marker may sit between the runs
    let addStart = i;
    while (addStart < lines.length && lines[addStart]!.type === 'nonewline') addStart++;
    let addEnd = addStart;
    while (addEnd < lines.length && lines[addEnd]!.type === 'add') addEnd++;
    const pairs = Math.min(delEnd - delStart, addEnd - addStart);
    for (let p = 0; p < pairs; p++) {
      const o = lines[delStart + p]!.content.replace(/\r$/, '');
      const nw = lines[addStart + p]!.content.replace(/\r$/, '');
      const r = wordDiff(o, nw);
      if (r.old.length) out.set(delStart + p, r.old);
      if (r.new.length) out.set(addStart + p, r.new);
    }
    i = Math.max(addEnd, delEnd);
  }
  return out;
}

/** Split `text` into plain/highlighted segments for rendering. */
export function segments(text: string, ranges: Range[] | undefined): { text: string; hl: boolean }[] {
  if (!ranges?.length) return [{ text, hl: false }];
  const out: { text: string; hl: boolean }[] = [];
  let pos = 0;
  for (const r of ranges) {
    const s = Math.max(pos, Math.min(r.start, text.length));
    const e = Math.min(r.end, text.length);
    if (s > pos) out.push({ text: text.slice(pos, s), hl: false });
    if (e > s) out.push({ text: text.slice(s, e), hl: true });
    pos = Math.max(pos, e);
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hl: false });
  return out;
}
