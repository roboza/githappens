/**
 * Pure 3-way merge model (spec 08 §5 / §6.5). DOM-free so it can be unit-tested in node.
 *
 * Input is `git merge-file -p --diff3` output: stable (auto-merged) lines interleaved with
 * conflict blocks `<<<<<<< A` / `||||||| base` / `=======` / `>>>>>>> B`. The model keeps
 * per-chunk selections (click order), manual edits and "resolved as empty", and composes the
 * output text from them.
 */

export type Side = 'a' | 'b';
export type Eol = '\n' | '\r\n';

export interface StableSegment {
  type: 'stable';
  lines: string[];
}
export interface ConflictSegment {
  type: 'conflict';
  /** 0-based conflict index (also `Segment.id` in spec 08). */
  id: number;
  base: string[];
  a: string[];
  b: string[];
  /** Whether the block had a `|||||||` base section. */
  hasBase: boolean;
  /** Marker labels as written by merge-file. */
  aLabel: string;
  bLabel: string;
  baseLabel: string;
  /** Conflict marker width (7 by default; larger with `conflict-marker-size`). */
  markerSize: number;
  /** 0-based line index of the chunk within the reconstructed A / B side views. */
  aStartLine: number;
  bStartLine: number;
}
export type Segment = StableSegment | ConflictSegment;

export interface MergeDocument {
  eol: Eol;
  /** Whether the input ended with a newline. */
  finalNewline: boolean;
  segments: Segment[];
  /** Conflict segments in order (same objects as in `segments`). */
  chunks: ConflictSegment[];
}

export interface Pick {
  side: Side;
  line: number;
}
export interface ChunkState {
  /** Picked lines; order = output order (click order). */
  selected: Pick[];
  /** Manual override from typing in the output. */
  edited?: string[];
  /** User confirmed "resolve as empty". */
  resolvedEmpty?: boolean;
  /** Set by auto-resolve. */
  auto?: 'trivial';
}

export const emptyState = (): ChunkState => ({ selected: [] });

const MARKER_RE = /^([<|=>])\1{6,}(?: (.*))?$/;

interface Marker {
  kind: '<' | '|' | '=' | '>';
  size: number;
  label: string;
}

function marker(line: string): Marker | null {
  const m = MARKER_RE.exec(line);
  if (!m) return null;
  const kind = m[1] as Marker['kind'];
  const size = line.length - (m[2] !== undefined ? m[2].length + 1 : 0);
  // `=======` never carries a label.
  if (kind === '=' && m[2] !== undefined) return null;
  return { kind, size, label: m[2] ?? '' };
}

/** True if `line` looks like a conflict marker (spec 08 §4.5 marker check). */
export function isMarkerLine(line: string): boolean {
  return /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(line);
}

/** True when the text still contains conflict-marker lines. */
export function hasMarkers(text: string): boolean {
  return text.split(/\r?\n/).some(isMarkerLine);
}

export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Split into lines without the trailing empty element produced by a final newline. */
export function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text;
  return { lines: body.split(/\r?\n/), finalNewline };
}

/** Parse `merge-file --diff3` text into stable and conflict segments. Malformed blocks stay stable. */
export function parseMerged(text: string, eol: Eol = detectEol(text)): MergeDocument {
  const { lines, finalNewline } = splitLines(text);
  const segments: Segment[] = [];
  const chunks: ConflictSegment[] = [];
  let stable: string[] = [];
  let aLine = 0;
  let bLine = 0;

  const flushStable = (): void => {
    if (!stable.length) return;
    segments.push({ type: 'stable', lines: stable });
    aLine += stable.length;
    bLine += stable.length;
    stable = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const start = marker(line);
    if (!start || start.kind !== '<') {
      stable.push(line);
      i++;
      continue;
    }
    // Try to read a full block; fall back to stable on malformed input.
    const size = start.size;
    const is = (l: string, kind: Marker['kind']): Marker | null => {
      const m = marker(l);
      return m && m.kind === kind && m.size === size ? m : null;
    };
    const a: string[] = [];
    const base: string[] = [];
    const b: string[] = [];
    let baseLabel = '';
    let hasBase = false;
    let section: 'a' | 'base' | 'b' = 'a';
    let end: Marker | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (section === 'a') {
        const m = is(l, '|');
        if (m) {
          section = 'base';
          hasBase = true;
          baseLabel = m.label;
          continue;
        }
        if (is(l, '=')) {
          section = 'b';
          continue;
        }
        a.push(l);
      } else if (section === 'base') {
        if (is(l, '=')) {
          section = 'b';
          continue;
        }
        base.push(l);
      } else {
        end = is(l, '>');
        if (end) break;
        b.push(l);
      }
    }
    if (!end) {
      stable.push(line);
      i++;
      continue;
    }
    flushStable();
    const seg: ConflictSegment = {
      type: 'conflict',
      id: chunks.length,
      base,
      a,
      b,
      hasBase,
      aLabel: start.label,
      bLabel: end.label,
      baseLabel,
      markerSize: size,
      aStartLine: aLine,
      bStartLine: bLine,
    };
    segments.push(seg);
    chunks.push(seg);
    aLine += a.length;
    bLine += b.length;
    i = j + 1;
  }
  flushStable();
  return { eol, finalNewline, segments, chunks };
}

/** The marker block re-emitted for an unresolved chunk. */
export function markerBlock(seg: ConflictSegment): string[] {
  const m = (c: string): string => c.repeat(seg.markerSize);
  const label = (s: string): string => (s ? ` ${s}` : '');
  return [
    m('<') + label(seg.aLabel),
    ...seg.a,
    ...(seg.hasBase ? [m('|') + label(seg.baseLabel), ...seg.base] : []),
    m('='),
    ...seg.b,
    m('>') + label(seg.bLabel),
  ];
}

const lineOf = (seg: ConflictSegment, p: Pick): string =>
  (p.side === 'a' ? seg.a[p.line] : seg.b[p.line]) ?? '';

/** Lines the chunk contributes to the output. */
export function chunkLines(seg: ConflictSegment, st: ChunkState): string[] {
  if (st.edited) return st.edited;
  if (st.selected.length) return st.selected.map((p) => lineOf(seg, p));
  if (st.resolvedEmpty) return [];
  return markerBlock(seg);
}

/** Lines the checkbox picks produce, ignoring manual edits. */
export function pickedLines(seg: ConflictSegment, st: ChunkState): string[] {
  return chunkLines(seg, { ...st, edited: undefined });
}

export function isResolved(st: ChunkState): boolean {
  if (st.edited) return !st.edited.some(isMarkerLine);
  return st.selected.length > 0 || !!st.resolvedEmpty;
}

export function unresolvedCount(states: ChunkState[]): number {
  return states.filter((s) => !isResolved(s)).length;
}

export type ChunkSource = 'unresolved' | 'a' | 'b' | 'mixed' | 'edited' | 'empty';
export function chunkSource(st: ChunkState): ChunkSource {
  if (st.edited) return 'edited';
  if (!st.selected.length) return st.resolvedEmpty ? 'empty' : 'unresolved';
  const sides = new Set(st.selected.map((p) => p.side));
  return sides.size > 1 ? 'mixed' : st.selected[0]!.side;
}

// ---- checkbox operations (all return new state objects) ----

const same = (p: Pick, side: Side, line: number): boolean => p.side === side && p.line === line;

/** Toggle one line: append at the end (click order) or remove. Clears edits. */
export function toggleLine(st: ChunkState, side: Side, line: number): ChunkState {
  const has = st.selected.some((p) => same(p, side, line));
  return {
    selected: has ? st.selected.filter((p) => !same(p, side, line)) : [...st.selected, { side, line }],
  };
}

export type CheckState = 'all' | 'some' | 'none';
export function sideCheck(seg: ConflictSegment, st: ChunkState, side: Side): CheckState {
  const total = (side === 'a' ? seg.a : seg.b).length;
  const n = st.selected.filter((p) => p.side === side).length;
  if (n === 0) return 'none';
  return n >= total ? 'all' : 'some';
}

/** Chunk checkbox: all lines of the side selected → remove them; else append the missing ones in order. */
export function toggleSide(seg: ConflictSegment, st: ChunkState, side: Side): ChunkState {
  const lines = side === 'a' ? seg.a : seg.b;
  if (sideCheck(seg, st, side) === 'all') return { selected: st.selected.filter((p) => p.side !== side) };
  const missing = lines
    .map((_, line) => ({ side, line }))
    .filter((p) => !st.selected.some((q) => same(q, p.side, p.line)));
  // A side with no lines (pure deletion): picking it resolves the chunk as empty for that side.
  if (!lines.length) return { selected: st.selected, resolvedEmpty: true };
  return { selected: [...st.selected, ...missing] };
}

/** Take a whole side for one chunk. */
export function takeSide(seg: ConflictSegment, side: Side): ChunkState {
  const lines = side === 'a' ? seg.a : seg.b;
  if (!lines.length) return { selected: [], resolvedEmpty: true };
  return { selected: lines.map((_, line) => ({ side, line })) };
}

/** Both sides, `first` side first. */
export function takeBoth(seg: ConflictSegment, first: Side): ChunkState {
  const second: Side = first === 'a' ? 'b' : 'a';
  const sel = [...takeSide(seg, first).selected, ...takeSide(seg, second).selected];
  return sel.length ? { selected: sel } : { selected: [], resolvedEmpty: true };
}

/** Append the other side after the current picks (keyboard Shift+A / Shift+B). */
export function appendSide(seg: ConflictSegment, st: ChunkState, side: Side): ChunkState {
  const base = st.edited ? emptyState() : st;
  const rest = takeSide(seg, side).selected.filter(
    (p) => !base.selected.some((q) => same(q, p.side, p.line)),
  );
  return { selected: [...base.selected, ...rest], resolvedEmpty: base.resolvedEmpty };
}

/** Swap which side's lines come first, keeping the order within each side. */
export function flipOrder(st: ChunkState): ChunkState {
  if (!st.selected.length) return st;
  const first = st.selected[0]!.side;
  return {
    ...st,
    edited: undefined,
    selected: [
      ...st.selected.filter((p) => p.side !== first),
      ...st.selected.filter((p) => p.side === first),
    ],
  };
}

export const resolveEmpty = (): ChunkState => ({ selected: [], resolvedEmpty: true });

export function takeAll(doc: MergeDocument, side: Side): ChunkState[] {
  return doc.chunks.map((c) => takeSide(c, side));
}

const norm = (lines: string[]): string => lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');

/**
 * Auto-resolve trivial chunks (spec 08 §4.7): identical modulo whitespace → A; A only changed
 * whitespace vs base → B; B only changed whitespace → A. Unresolved, unedited chunks only.
 */
export function autoResolveTrivial(doc: MergeDocument, states: ChunkState[]): ChunkState[] {
  return doc.chunks.map((c, i) => {
    const st = states[i] ?? emptyState();
    if (isResolved(st) || st.edited) return st;
    const a = norm(c.a);
    const b = norm(c.b);
    let side: Side | null = null;
    if (a === b) side = 'a';
    else if (c.hasBase && a === norm(c.base)) side = 'b';
    else if (c.hasBase && b === norm(c.base)) side = 'a';
    return side ? { ...takeSide(c, side), auto: 'trivial' } : st;
  });
}

// ---- composition ----

/** Output lines for the whole document. */
export function composeLines(doc: MergeDocument, states: ChunkState[]): string[] {
  const out: string[] = [];
  for (const seg of doc.segments) {
    if (seg.type === 'stable') out.push(...seg.lines);
    else out.push(...chunkLines(seg, states[seg.id] ?? emptyState()));
  }
  return out;
}

/** Serialize lines with the document's EOL and final-newline convention. */
export function joinLines(lines: string[], eol: Eol, finalNewline: boolean): string {
  if (!lines.length) return '';
  return lines.join(eol) + (finalNewline ? eol : '');
}

export function compose(doc: MergeDocument, states: ChunkState[]): string {
  return joinLines(composeLines(doc, states), doc.eol, doc.finalNewline);
}

/**
 * Editor layout: LF text where every piece ends with `\n`, plus each chunk's region as
 * `[start, end)` offsets (end excludes the region's trailing newline; empty chunks are collapsed).
 */
export interface EditorLayout {
  text: string;
  regions: { start: number; end: number }[];
}
export function editorLayout(doc: MergeDocument, states: ChunkState[]): EditorLayout {
  let text = '';
  const regions: { start: number; end: number }[] = [];
  for (const seg of doc.segments) {
    if (seg.type === 'stable') {
      for (const l of seg.lines) text += l + '\n';
      continue;
    }
    const lines = chunkLines(seg, states[seg.id] ?? emptyState());
    const start = text.length;
    if (!lines.length) {
      regions[seg.id] = { start, end: start };
      continue;
    }
    const body = lines.join('\n');
    text += body + '\n';
    regions[seg.id] = { start, end: start + body.length };
  }
  return { text, regions };
}

/** Lines of an editor region's text (`''` = no lines). */
export const regionLines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** Text a chunk occupies in the editor (no trailing newline). */
export const regionText = (lines: string[]): string => lines.join('\n');

/** Convert editor text (LF, with the layout's trailing newline) back to file text. */
export function serializeEditorText(text: string, eol: Eol, finalNewline: boolean): string {
  let t = text.replace(/\r\n/g, '\n');
  if (!finalNewline && t.endsWith('\n')) t = t.slice(0, -1);
  return eol === '\n' ? t : t.replace(/\n/g, '\r\n');
}

/** Reconstructed view of one side: stable lines plus that side of every chunk. */
export function sideLines(doc: MergeDocument, side: Side): string[] {
  const out: string[] = [];
  for (const seg of doc.segments) out.push(...(seg.type === 'stable' ? seg.lines : seg[side]));
  return out;
}

/** Index of the next/previous chunk matching `pred`, wrapping around; -1 if none. */
export function findChunk(
  states: ChunkState[],
  from: number,
  dir: 1 | -1,
  pred: (s: ChunkState) => boolean = () => true,
): number {
  const n = states.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (pred(states[i]!)) return i;
  }
  return -1;
}

// ---- full-file side panes (spec 08 §4.3) ----

/**
 * Greedy line alignment of `a` onto `b`: `map[i]` = index in `b` of line `a[i]`, or -1. Equal runs are
 * matched directly; on a mismatch the nearest resync point (smallest skip on either side) wins. Blank /
 * whitespace-only lines only resync when the following line matches too, so they don't anchor wrongly.
 * Good for the small differences between a side's projection of the merge and the stage file.
 */
export function alignLines(a: string[], b: string[], maxLook = 2000): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  let i = 0;
  let j = 0;
  const ok = (x: number, y: number): boolean =>
    a[x] === b[y] && (a[x]!.trim() !== '' || x + 1 >= a.length || y + 1 >= b.length || a[x + 1] === b[y + 1]);
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i++] = j++;
      continue;
    }
    let found = false;
    for (let d = 1; d <= maxLook && !found; d++) {
      for (let x = 0; x <= d; x++) {
        const y = d - x;
        if (i + x >= a.length || j + y >= b.length) continue;
        if (ok(i + x, j + y)) {
          i += x;
          j += y;
          found = true;
          break;
        }
      }
    }
    if (!found) break;
  }
  return map;
}

export type PaneSide = Side | 'base';

/** Lines a chunk shows in a pane (`base` = the common ancestor section). */
export const chunkSideLines = (seg: ConflictSegment, side: PaneSide): string[] => seg[side];

/**
 * Where each chunk sits in the full stage file shown in a side pane: 0-based `start` and line count
 * (`length` 0 = the side deleted the lines; `start` is then the insertion point).
 */
export function chunkRanges(
  doc: MergeDocument,
  side: PaneSide,
  full: string[],
): { start: number; length: number }[] {
  const projection: string[] = [];
  const starts: number[] = [];
  for (const seg of doc.segments) {
    if (seg.type === 'stable') projection.push(...seg.lines);
    else {
      starts[seg.id] = projection.length;
      projection.push(...chunkSideLines(seg, side));
    }
  }
  const map = alignLines(projection, full);
  return doc.chunks.map((seg) => {
    const p = starts[seg.id]!;
    const len = chunkSideLines(seg, side).length;
    let start = -1;
    for (let k = 0; k < len && start < 0; k++) if (map[p + k]! >= 0) start = map[p + k]! - k;
    if (start < 0) {
      // nothing of the chunk matched (or the side is empty): just after the closest mapped line above
      let q = p - 1;
      while (q >= 0 && map[q]! < 0) q--;
      start = q >= 0 ? map[q]! + 1 + (p - 1 - q) : p;
    }
    start = Math.max(0, Math.min(start, full.length));
    return { start, length: Math.min(len, full.length - start) };
  });
}

/**
 * Scroll sync between panes aligned by conflict chunk (spec 08 §4.3): `line` in the source pane maps to
 * the same offset from the closest chunk start at or above it in the destination pane. `src` / `dst` are
 * the chunk start lines (same order, 1-based).
 */
export function syncLine(src: number[], dst: number[], line: number): number {
  const n = Math.min(src.length, dst.length);
  if (!n) return line;
  let k = -1;
  for (let i = 0; i < n; i++) if (src[i]! <= line) k = i;
  const target = k < 0 ? dst[0]! - (src[0]! - line) : dst[k]! + (line - src[k]!);
  return Math.max(1, target);
}

/** "Reset to base": every chunk resolved with its base section (edited), keeping the doc's markers off. */
export function resetToBase(doc: MergeDocument): ChunkState[] {
  return doc.chunks.map((c) => (c.base.length ? { selected: [], edited: [...c.base] } : resolveEmpty()));
}

/**
 * How the working file relates to a fresh merge (spec 08 §6.4 "Load current file contents" vs "Start
 * fresh"): `none` = same conflicts (marker style / labels may differ), `resolved` = no markers left (resolved
 * or edited outside the app), `edited` = changed otherwise. Compares each side's projection, which is stable
 * across `merge` / `diff3` / `zdiff3` conflict styles.
 */
export function workingDivergence(merged: string, working: string | null): 'none' | 'edited' | 'resolved' {
  if (working === null) return 'none';
  const w = parseMerged(working);
  const m = parseMerged(merged);
  if (!w.chunks.length) return m.chunks.length ? 'resolved' : 'none';
  if (w.chunks.length !== m.chunks.length) return 'edited';
  const same = (side: Side): boolean => sideLines(w, side).join('\n') === sideLines(m, side).join('\n');
  return same('a') && same('b') ? 'none' : 'edited';
}

/** Whitespace-insensitive line equality (display-only "ignore whitespace" toggle). */
export const sameIgnoringWhitespace = (x: string | undefined, y: string | undefined): boolean =>
  x !== undefined && y !== undefined && x.replace(/\s+/g, '') === y.replace(/\s+/g, '');
