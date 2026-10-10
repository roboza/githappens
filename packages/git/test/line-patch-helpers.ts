import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedEnv } from '@githappens/fixtures';

import { allChangesSelected, lineKey, type PatchMode } from '../src/ops/executors/patch';
import type { LineRef } from '../src/ops/types';
import { parseDiff } from '../src/parsers/diff';
import type { FileDiff } from '../src/types';
import { gitPath } from './ops-harness';

/**
 * Shared helpers for the partial-patch tests (spec 06 §6.5): an in-memory model of what a line
 * selection should produce, and a strict in-memory unified-diff applier (no fuzz, no recount) that
 * also checks every hunk header against the lines actually emitted.
 */

/** Split text into lines keeping their `\n` (a trailing line without EOL keeps none). */
export function rawLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** True when no line except the last lacks its EOL (no content after a "no newline" line). */
const wellFormed = (lines: string[]): boolean =>
  lines.every((l, i) => i === lines.length - 1 || l.endsWith('\n'));

const firstPos = (start: number, count: number): number => (count === 0 ? start + 1 : start);

export interface Expected {
  /** Resulting index content; null when the index entry is removed. */
  text: string | null;
  /** False when the selection cannot be represented (content would follow a no-EOL line). */
  valid: boolean;
}

/**
 * What the index should hold after applying `sel`:
 * - `stage`: `oldText` is the index, `newText` the worktree → index with only the selected changes applied.
 * - `unstage`: `oldText` is HEAD, `newText` the index → index with only the selected changes reverted.
 * Built from the raw texts (so EOL bytes and "no newline" are exact), driven by the diff's line numbers.
 */
export function expectedResult(
  oldText: string | null,
  newText: string | null,
  file: FileDiff,
  sel: Set<string>,
  mode: PatchMode,
): Expected {
  const all = allChangesSelected(file, sel);
  if (mode === 'stage' && file.status === 'D' && all) return { text: null, valid: true };
  if (mode === 'unstage' && file.status === 'A' && all) return { text: null, valid: true };
  const O = rawLines(oldText ?? '');
  const N = rawLines(newText ?? '');
  const base = mode === 'stage' ? O : N;
  const out: string[] = [];
  let cursor = 0; // 0-based next base line to copy
  const consume = (lineNo: number | undefined): void => {
    if (lineNo !== undefined) cursor = Math.max(cursor, lineNo);
  };
  file.hunks.forEach((h, hi) => {
    const start = mode === 'stage' ? firstPos(h.oldStart, h.oldLines) : firstPos(h.newStart, h.newLines);
    while (cursor < start - 1) out.push(base[cursor++]!);
    h.lines.forEach((l, li) => {
      const s = sel.has(lineKey(hi, li));
      if (l.type === 'context') {
        out.push(mode === 'stage' ? O[l.oldLineNo! - 1]! : N[l.newLineNo! - 1]!);
        consume(mode === 'stage' ? l.oldLineNo : l.newLineNo);
      } else if (l.type === 'del') {
        if (mode === 'stage') {
          if (!s) out.push(O[l.oldLineNo! - 1]!);
          consume(l.oldLineNo);
        } else if (s) out.push(O[l.oldLineNo! - 1]!);
      } else if (l.type === 'add') {
        if (mode === 'stage') {
          if (s) out.push(N[l.newLineNo! - 1]!);
        } else {
          if (!s) out.push(N[l.newLineNo! - 1]!);
          consume(l.newLineNo);
        }
      }
    });
  });
  while (cursor < base.length) out.push(base[cursor++]!);
  // a line that is no longer last gains a newline (buildHunks emits it with one, spec 06 §6.5)
  const text = out.map((l, i) => (i < out.length - 1 && !l.endsWith('\n') ? `${l}\n` : l)).join('');
  return { text, valid: true };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Strictly apply a single-file unified diff to `source` (null = no such file). `reverse` swaps sides like
 * `git apply -R`. Throws on any context mismatch, wrong header count/position, or content after a no-EOL
 * line. Returns null when the patch deletes the file.
 */
export function applyPatch(source: string | null, patch: string, reverse = false): string | null {
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let i = 0;
  let created = false;
  let deleted = false;
  for (; i < lines.length && !lines[i]!.startsWith('@@'); i++) {
    if (lines[i]!.startsWith('new file mode')) created = true;
    if (lines[i]!.startsWith('deleted file mode')) deleted = true;
  }
  if (reverse) [created, deleted] = [deleted, created];
  if (created && source !== null) throw new Error('patch creates a file that already exists');
  if (!created && source === null) throw new Error('patch modifies a file that does not exist');
  const src = rawLines(source ?? '');
  const out: string[] = [];
  let cursor = 0;
  while (i < lines.length) {
    const m = HUNK_RE.exec(lines[i]!);
    if (!m) throw new Error(`expected hunk header, got ${JSON.stringify(lines[i])}`);
    i++;
    let [preStart, preCount, postStart, postCount] = [
      Number(m[1]),
      m[2] === undefined ? 1 : Number(m[2]),
      Number(m[3]),
      m[4] === undefined ? 1 : Number(m[4]),
    ];
    const pre: string[] = [];
    const post: string[] = [];
    let last: ' ' | '+' | '-' | null = null;
    for (; i < lines.length && !lines[i]!.startsWith('@@'); i++) {
      const l = lines[i]!;
      const c = l[0];
      if (c === '\\') {
        if (!last) throw new Error('no-newline marker without a preceding line');
        if (last !== '+') pre[pre.length - 1] = pre[pre.length - 1]!.replace(/\n$/, '');
        if (last !== '-') post[post.length - 1] = post[post.length - 1]!.replace(/\n$/, '');
        last = null;
        continue;
      }
      if (c !== ' ' && c !== '+' && c !== '-') throw new Error(`bad patch line ${JSON.stringify(l)}`);
      const text = `${l.slice(1)}\n`;
      if (c !== '+') pre.push(text);
      if (c !== '-') post.push(text);
      last = c;
    }
    if (pre.length !== preCount) throw new Error(`hunk ${m[0]}: old count ${pre.length} != ${preCount}`);
    if (post.length !== postCount) throw new Error(`hunk ${m[0]}: new count ${post.length} != ${postCount}`);
    let [from, to] = [pre, post];
    if (reverse) {
      [from, to] = [post, pre];
      [preStart, preCount, postStart, postCount] = [postStart, postCount, preStart, preCount];
    }
    const at = firstPos(preStart, preCount) - 1;
    if (at < cursor) throw new Error(`hunk ${m[0]}: overlaps the previous hunk`);
    while (cursor < at) {
      if (cursor >= src.length) throw new Error(`hunk ${m[0]}: starts past end of file`);
      out.push(src[cursor++]!);
    }
    if (firstPos(postStart, postCount) - 1 !== out.length) {
      throw new Error(`hunk ${m[0]}: result position ${out.length + 1} does not match header`);
    }
    for (const [k, want] of from.entries()) {
      if (src[at + k] !== want) {
        throw new Error(
          `hunk ${m[0]}: line ${at + k + 1} is ${JSON.stringify(src[at + k])}, expected ${JSON.stringify(want)}`,
        );
      }
    }
    if (!wellFormed(to)) throw new Error(`hunk ${m[0]}: content after a no-newline line`);
    out.push(...to);
    cursor = at + from.length;
  }
  while (cursor < src.length) out.push(src[cursor++]!);
  if (!wellFormed(out)) throw new Error('result has content after a no-newline line');
  const result = out.join('');
  if (deleted) {
    if (result !== '') throw new Error(`deletion patch leaves content ${JSON.stringify(result)}`);
    return null;
  }
  return result;
}

/**
 * Real git diff of two texts (null = /dev/null), parsed with the repo's own parser and renamed to
 * `name` (A: oldPath null, D: newPath null, like the raw parser). Returns null when the texts are equal.
 */
export function gitDiffTexts(
  tmp: string,
  oldText: string | null,
  newText: string | null,
  name = 'f.txt',
  unified = 3,
): FileDiff | null {
  fs.mkdirSync(tmp, { recursive: true });
  const o = path.join(tmp, 'old');
  const n = path.join(tmp, 'new');
  if (oldText !== null) fs.writeFileSync(o, oldText);
  if (newText !== null) fs.writeFileSync(n, newText);
  const r = spawnSync(
    gitPath ?? 'git',
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--patch-with-raw',
      '-z',
      '--full-index',
      '--no-abbrev',
      `--unified=${unified}`,
      '--',
      oldText === null ? '/dev/null' : 'old',
      newText === null ? '/dev/null' : 'new',
    ],
    { cwd: tmp, env: isolatedEnv(tmp), encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
  const f = parseDiff(r.stdout)[0];
  if (!f) return null;
  f.oldPath = f.status === 'A' ? null : name;
  f.newPath = f.status === 'D' ? null : name;
  return f;
}

/**
 * Resolve selection descriptors to line refs: `*` all changes, `@n` all changes of hunk n,
 * `h:l` an explicit ref, or a prefix (`+`/`-`/` `) plus content (trailing `\r` ignored) matching every
 * such line.
 */
export function refsFor(file: FileDiff, descs: string[]): LineRef[] {
  const out: LineRef[] = [];
  const push = (hunkIndex: number, lineIndex: number): void => {
    if (!out.some((r) => r.hunkIndex === hunkIndex && r.lineIndex === lineIndex))
      out.push({ hunkIndex, lineIndex });
  };
  for (const d of descs) {
    const explicit = /^(\d+):(\d+)$/.exec(d);
    if (explicit) {
      push(Number(explicit[1]), Number(explicit[2]));
      continue;
    }
    const wantType = { '+': 'add', '-': 'del', ' ': 'context' }[d[0]!];
    let hit = false;
    file.hunks.forEach((h, hi) =>
      h.lines.forEach((l, li) => {
        const change = l.type === 'add' || l.type === 'del';
        const ok =
          d === '*'
            ? change
            : d.startsWith('@')
              ? change && hi === Number(d.slice(1))
              : l.type === wantType && l.content.replace(/\r$/, '') === d.slice(1);
        if (ok) {
          push(hi, li);
          hit = true;
        }
      }),
    );
    if (!hit) throw new Error(`selection ${JSON.stringify(d)} matches no diff line`);
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
