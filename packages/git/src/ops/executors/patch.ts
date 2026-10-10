import type { DiffHunk, DiffLine, FileDiff } from '../../types';
import type { LineRef } from '../types';

/**
 * Partial-patch construction for hunk/line staging (spec 06 §6.4–6.6). Pure functions.
 *
 * - `stage`  (diff index→worktree, applied `--cached` forward): unselected `+` omitted, unselected `-` → context.
 * - `unstage` (diff HEAD→index, applied `--cached -R`) and `discard`: unselected `+` → context, unselected `-` omitted.
 */
export type PatchMode = 'stage' | 'unstage';

export const lineKey = (hunkIndex: number, lineIndex: number): string => `${hunkIndex}:${lineIndex}`;

/** Selected keys for whole hunks. */
export function selectHunk(file: FileDiff, hunkIndex: number): Set<string> {
  const h = file.hunks[hunkIndex];
  const s = new Set<string>();
  h?.lines.forEach((l, i) => {
    if (l.type === 'add' || l.type === 'del') s.add(lineKey(hunkIndex, i));
  });
  return s;
}

/**
 * Validate a line selection against the diff and apply the EOF-pair rule (spec 06 §6.5): when a hunk ends
 * with a `-`/`+` pair at end of file carrying a "\ No newline" marker, selecting either selects both.
 * Returns null when a reference does not exist (stale selection).
 */
export function selectLines(file: FileDiff, lines: LineRef[]): Set<string> | null {
  const s = new Set<string>();
  for (const { hunkIndex, lineIndex } of lines) {
    const l = file.hunks[hunkIndex]?.lines[lineIndex];
    if (!l) return null;
    if (l.type === 'add' || l.type === 'del') s.add(lineKey(hunkIndex, lineIndex));
  }
  file.hunks.forEach((h, hi) => {
    const pair = eofPair(h);
    if (!pair) return;
    const [d, a] = pair;
    if (s.has(lineKey(hi, d)) || s.has(lineKey(hi, a))) {
      s.add(lineKey(hi, d));
      s.add(lineKey(hi, a));
    }
  });
  return s;
}

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

export function allChangesSelected(file: FileDiff, sel: Set<string>): boolean {
  return file.hunks.every((h, hi) =>
    h.lines.every((l, li) => (l.type !== 'add' && l.type !== 'del') || sel.has(lineKey(hi, li))),
  );
}

/** C-style quoting for patch header paths, as git does for unusual names. */
export function quotePatchPath(prefix: string, p: string): string {
  const full = prefix + p;
  if (!/["\\\t\n\r\x00-\x1f\x7f]/.test(full)) return full;
  const esc = full.replace(/[\\"\t\n\r\x00-\x1f\x7f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\t':
        return '\\t';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      default:
        return `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`;
    }
  });
  return `"${esc}"`;
}

export type PatchHeaderKind = 'modify' | { newFile: string } | { deletedFile: string };

export function patchHeader(p: string, kind: PatchHeaderKind): string {
  const a = quotePatchPath('a/', p);
  const b = quotePatchPath('b/', p);
  const out = [`diff --git ${a} ${b}`];
  if (kind === 'modify') out.push(`--- ${a}`, `+++ ${b}`);
  else if ('newFile' in kind) out.push(`new file mode ${kind.newFile}`, '--- /dev/null', `+++ ${b}`);
  else out.push(`deleted file mode ${kind.deletedFile}`, `--- ${a}`, '+++ /dev/null');
  return out.join('\n') + '\n';
}

interface Emitted {
  prefix: ' ' | '+' | '-';
  line: DiffLine;
}

/** First line position (1-based) of a hunk side, independent of the "count 0 means line before" rule. */
const firstPos = (start: number, count: number): number => (count === 0 ? start + 1 : start);
const fmtStart = (pos: number, count: number): number => (count === 0 ? pos - 1 : pos);
const fmtRange = (pos: number, count: number): string =>
  count === 1 ? `${fmtStart(pos, count)}` : `${fmtStart(pos, count)},${count}`;

/**
 * A "\ No newline" marker is only valid after the last line of its side. When a partial selection puts
 * more lines after a no-EOL line on one side (e.g. staging a line added after an old last line without
 * newline), that line must end with a newline on that side:
 * - `-` / `+` line → drop the marker (the line gets its newline);
 * - context line → split it into `-X` + marker (side that still ends there) and `+X` with newline,
 *   or the mirror image.
 */
function fixMarkers(emitted: (Emitted | 'marker')[]): void {
  for (let i = emitted.length - 1; i > 0; i--) {
    if (emitted[i] !== 'marker') continue;
    const e = emitted[i - 1];
    if (!e || e === 'marker') continue;
    const rest = emitted.slice(i + 1).filter((x): x is Emitted => x !== 'marker');
    const laterOld = rest.some((x) => x.prefix !== '+');
    const laterNew = rest.some((x) => x.prefix !== '-');
    if (e.prefix === '-' ? laterOld : e.prefix === '+' ? laterNew : laterOld && laterNew) {
      emitted.splice(i, 1);
    } else if (e.prefix === ' ' && laterNew) {
      emitted.splice(i - 1, 2, { prefix: '-', line: e.line }, 'marker', { prefix: '+', line: e.line });
    } else if (e.prefix === ' ' && laterOld) {
      emitted.splice(i - 1, 2, { prefix: '-', line: e.line }, { prefix: '+', line: e.line }, 'marker');
    }
  }
}

/** Hunk bodies of the partial patch (no file header). Empty string when nothing is selected. */
export function buildHunks(file: FileDiff, sel: Set<string>, mode: PatchMode): string {
  let out = '';
  let delta = 0;
  file.hunks.forEach((h, hi) => {
    const selected = h.lines.some((_, li) => sel.has(lineKey(hi, li)));
    if (!selected) return;
    const emitted: (Emitted | 'marker')[] = [];
    let lastEmitted = false;
    for (let li = 0; li < h.lines.length; li++) {
      const l = h.lines[li]!;
      const isSel = sel.has(lineKey(hi, li));
      if (l.type === 'nonewline') {
        if (lastEmitted) emitted.push('marker');
        continue;
      }
      let prefix: Emitted['prefix'] | null;
      if (l.type === 'context') prefix = ' ';
      else if (l.type === 'add') prefix = isSel ? '+' : mode === 'stage' ? null : ' ';
      else prefix = isSel ? '-' : mode === 'stage' ? ' ' : null;
      lastEmitted = prefix !== null;
      if (prefix) emitted.push({ prefix, line: l });
    }
    fixMarkers(emitted);
    const lines = emitted.filter((e): e is Emitted => e !== 'marker');
    const oldCount = lines.filter((e) => e.prefix !== '+').length;
    const newCount = lines.filter((e) => e.prefix !== '-').length;
    let oldPos: number;
    let newPos: number;
    if (mode === 'stage') {
      oldPos = firstPos(h.oldStart, h.oldLines);
      newPos = oldPos + delta;
    } else {
      newPos = firstPos(h.newStart, h.newLines);
      oldPos = newPos - delta;
    }
    delta += newCount - oldCount;
    out += `@@ -${fmtRange(oldPos, oldCount)} +${fmtRange(newPos, newCount)} @@\n`;
    for (const e of emitted) {
      out += e === 'marker' ? '\\ No newline at end of file\n' : `${e.prefix}${e.line.content}\n`;
    }
  });
  return out;
}

/**
 * A "new file" patch holding only the selected lines of one side (`+` lines of an untracked file, or the
 * selected `-` lines of a staged deletion turned into additions).
 */
export function buildNewFilePatch(
  p: string,
  mode: string,
  file: FileDiff,
  sel: Set<string>,
  take: 'add' | 'del',
): string {
  const body: string[] = [];
  let count = 0;
  file.hunks.forEach((h, hi) => {
    let last = false;
    h.lines.forEach((l, li) => {
      if (l.type === 'nonewline') {
        if (last) body.push('\\ No newline at end of file');
        return;
      }
      last = l.type === take && sel.has(lineKey(hi, li));
      if (last) {
        body.push(`+${l.content}`);
        count++;
      }
    });
  });
  if (!count) return '';
  return `${patchHeader(p, { newFile: mode })}@@ -0,0 +${fmtRange(1, count)} @@\n${body.join('\n')}\n`;
}

/** A complete patch for `git apply --cached [-R]` (spec 06 §6.5). */
export interface LinePatch {
  patch: string;
  /** Apply with `-R` (unstage patches describe HEAD→index and are reverse-applied). */
  reverse: boolean;
}

/**
 * Full line/hunk patch (file header + hunks) for staging (`index→worktree` diff, applied forward) or
 * unstaging (`HEAD→index` diff, applied in reverse). Handles new files (`stage` of an untracked/added
 * file → a "new file" patch of the selected `+` lines), full additions/deletions (`new file` /
 * `deleted file` headers) and partial unstaging of a staged deletion (re-adds a file holding the
 * selected `-` lines). Returns null when nothing is selected. Pure.
 */
export function buildLinePatch(
  file: FileDiff,
  sel: Set<string>,
  mode: PatchMode,
  o: { path?: string; fileMode?: string } = {},
): LinePatch | null {
  if (![...sel].some((k) => isChangeKey(file, k))) return null;
  const name = o.path ?? file.newPath ?? file.oldPath ?? '';
  const all = allChangesSelected(file, sel);
  if (mode === 'stage') {
    if (file.status === 'A') {
      const patch = all
        ? patchHeader(name, { newFile: o.fileMode ?? file.newMode ?? '100644' }) +
          buildHunks(file, sel, 'stage')
        : buildNewFilePatch(name, o.fileMode ?? file.newMode ?? '100644', file, sel, 'add');
      return patch ? { patch, reverse: false } : null;
    }
    if (file.status === 'D' && all) {
      return {
        patch:
          patchHeader(file.oldPath ?? name, { deletedFile: file.oldMode ?? '100644' }) +
          buildHunks(file, sel, 'stage'),
        reverse: false,
      };
    }
    return { patch: patchHeader(name, 'modify') + buildHunks(file, sel, 'stage'), reverse: false };
  }
  if (file.status === 'A' && all) {
    return {
      patch: patchHeader(name, { newFile: file.newMode ?? '100644' }) + buildHunks(file, sel, 'unstage'),
      reverse: true,
    };
  }
  if (file.status === 'D') {
    const p = file.oldPath ?? name;
    if (all) {
      return {
        patch: patchHeader(p, { deletedFile: file.oldMode ?? '100644' }) + buildHunks(file, sel, 'unstage'),
        reverse: true,
      };
    }
    // the index has no entry: re-add a file holding only the selected (deleted) lines
    const patch = buildNewFilePatch(p, file.oldMode ?? '100644', file, sel, 'del');
    return patch ? { patch, reverse: false } : null;
  }
  return { patch: patchHeader(name, 'modify') + buildHunks(file, sel, 'unstage'), reverse: true };
}

function isChangeKey(file: FileDiff, key: string): boolean {
  const [h, l] = key.split(':').map(Number);
  const t = file.hunks[h!]?.lines[l!]?.type;
  return t === 'add' || t === 'del';
}

// ---- in-memory discard (spec 06 §6.6) ----

/** Split a buffer into lines keeping their EOL bytes. */
export function splitLinesKeepEol(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

export function dominantEol(lines: Buffer[]): '\r\n' | '\n' {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (l.length && l[l.length - 1] === 0x0a) {
      if (l.length > 1 && l[l.length - 2] === 0x0d) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

const hasEol = (b: Buffer): boolean => b.length > 0 && b[b.length - 1] === 0x0a;

/**
 * Revert the selected lines of an index→worktree diff in the worktree content. Diff `newLineNo`s map 1:1
 * to worktree lines (EOL conversion preserves line count), so worktree bytes of kept lines are copied
 * verbatim and removed `-` lines are re-inserted with the file's dominant EOL.
 */
export function discardInContent(worktree: Buffer, file: FileDiff, sel: Set<string>): Buffer {
  const src = splitLinesKeepEol(worktree);
  const eol = dominantEol(src);
  const out: { buf: Buffer; noEol?: boolean }[] = [];
  let cursor = 1; // next worktree line (1-based) to copy
  const copyUntil = (lineNo: number): void => {
    while (cursor < lineNo && cursor <= src.length) out.push({ buf: src[cursor++ - 1]! });
    cursor = Math.max(cursor, lineNo);
  };
  const takeLine = (lineNo: number | undefined): Buffer | undefined => {
    if (lineNo === undefined) return undefined;
    copyUntil(lineNo);
    const b = src[lineNo - 1];
    cursor = lineNo + 1;
    return b;
  };
  file.hunks.forEach((h, hi) => {
    copyUntil(firstPos(h.newStart, h.newLines));
    let lastDelInserted: { buf: Buffer; noEol?: boolean } | null = null;
    h.lines.forEach((l, li) => {
      const isSel = sel.has(lineKey(hi, li));
      switch (l.type) {
        case 'context': {
          const b = takeLine(l.newLineNo);
          if (b) out.push({ buf: b });
          lastDelInserted = null;
          break;
        }
        case 'add': {
          const b = takeLine(l.newLineNo);
          if (b && !isSel) out.push({ buf: b });
          lastDelInserted = null;
          break;
        }
        case 'del': {
          if (isSel) {
            const text = l.content.endsWith('\r') ? `${l.content}\n` : `${l.content}${eol}`;
            lastDelInserted = { buf: Buffer.from(text, 'utf8') };
            out.push(lastDelInserted);
          } else lastDelInserted = null;
          break;
        }
        case 'nonewline':
          if (lastDelInserted) lastDelInserted.noEol = true;
          break;
      }
    });
  });
  copyUntil(src.length + 1);
  // every line but the last needs an EOL; the last keeps its own (or the old side's "no newline")
  const parts: Buffer[] = out.map((e, i) => {
    const isLast = i === out.length - 1;
    if (e.noEol && isLast) return stripEol(e.buf);
    if (!isLast && !hasEol(e.buf)) return Buffer.concat([e.buf, Buffer.from(eol)]);
    return e.buf;
  });
  return Buffer.concat(parts);
}

function stripEol(b: Buffer): Buffer {
  let end = b.length;
  if (end && b[end - 1] === 0x0a) end--;
  if (end && b[end - 1] === 0x0d) end--;
  return b.subarray(0, end);
}
