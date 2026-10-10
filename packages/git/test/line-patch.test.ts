import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  allChangesSelected,
  buildHunks,
  buildLinePatch,
  buildNewFilePatch,
  discardInContent,
  lineKey,
  patchHeader,
  quotePatchPath,
  selectHunk,
  selectLines,
  type PatchMode,
} from '../src/ops/executors/patch';
import type { FileDiff } from '../src/types';
import { applyPatch, expectedResult, gitDiffTexts, refsFor } from './line-patch-helpers';
import { describeGit } from './ops-harness';

/** Lines joined with `\n`, each terminated. */
const L = (...xs: string[]): string => xs.map((x) => `${x}\n`).join('');
const seq = (n: number, p = 'l'): string[] => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const NL = '\\ No newline at end of file\n';
const MOD = (p = 'f.txt'): string => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n`;
const NEW = (p = 'f.txt', m = '100644'): string =>
  `diff --git a/${p} b/${p}\nnew file mode ${m}\n--- /dev/null\n+++ b/${p}\n`;
const DEL = (p = 'f.txt', m = '100644'): string =>
  `diff --git a/${p} b/${p}\ndeleted file mode ${m}\n--- a/${p}\n+++ /dev/null\n`;

/** seq(30) with X1,X2 inserted after l3, l15 deleted and l27 replaced by Y: three hunks. */
const MULTI_OLD = L(...seq(30));
const MULTI_NEW = L(
  ...seq(30).flatMap((l) => (l === 'l3' ? [l, 'X1', 'X2'] : l === 'l15' ? [] : l === 'l27' ? ['Y'] : [l])),
);
const H0 = ' l1\n l2\n l3\n+X1\n+X2\n l4\n l5\n l6\n';
const H1 = ' l12\n l13\n l14\n-l15\n l16\n l17\n l18\n';
const H2 = ' l24\n l25\n l26\n-l27\n+Y\n l28\n l29\n l30\n';

interface Case {
  name: string;
  mode: PatchMode;
  /** stage: index; unstage: HEAD. null = no such file. */
  old: string | null;
  /** stage: worktree; unstage: index. */
  new: string | null;
  sel: string[];
  /** Exact patch text (header + hunks). */
  patch?: string;
  /** Expected index content after applying (null = entry removed); otherwise only the model is used. */
  result?: string | null;
  reverse?: boolean;
  path?: string;
  opts?: { fileMode?: string };
  unified?: number;
  /** Expect buildLinePatch to return null. */
  none?: boolean;
}

const cases: Case[] = [
  // ---- stage: single-hunk shapes ----
  {
    name: 'stage middle replace (both lines)',
    mode: 'stage',
    old: L(...seq(10)),
    new: L(...seq(10).map((l) => (l === 'l5' ? 'X' : l))),
    sel: ['-l5', '+X'],
    patch: `${MOD()}@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-l5\n+X\n l6\n l7\n l8\n`,
    result: L(...seq(10).map((l) => (l === 'l5' ? 'X' : l))),
  },
  {
    name: 'stage middle replace, only the - line',
    mode: 'stage',
    old: L(...seq(10)),
    new: L(...seq(10).map((l) => (l === 'l5' ? 'X' : l))),
    sel: ['-l5'],
    patch: `${MOD()}@@ -2,7 +2,6 @@\n l2\n l3\n l4\n-l5\n l6\n l7\n l8\n`,
    result: L(...seq(10).filter((l) => l !== 'l5')),
  },
  {
    name: 'stage middle replace, only the + line',
    mode: 'stage',
    old: L(...seq(10)),
    new: L(...seq(10).map((l) => (l === 'l5' ? 'X' : l))),
    sel: ['+X'],
    patch: `${MOD()}@@ -2,7 +2,8 @@\n l2\n l3\n l4\n l5\n+X\n l6\n l7\n l8\n`,
    result: L(...seq(5), 'X', ...seq(10).slice(5)),
  },
  {
    name: 'stage first line replaced, only the + line',
    mode: 'stage',
    old: L(...seq(6)),
    new: L('X', ...seq(6).slice(1)),
    sel: ['+X'],
    patch: `${MOD()}@@ -1,4 +1,5 @@\n l1\n+X\n l2\n l3\n l4\n`,
    result: L('l1', 'X', ...seq(6).slice(1)),
  },
  {
    name: 'stage first line deleted',
    mode: 'stage',
    old: L(...seq(6)),
    new: L(...seq(6).slice(1)),
    sel: ['-l1'],
    patch: `${MOD()}@@ -1,4 +1,3 @@\n-l1\n l2\n l3\n l4\n`,
    result: L(...seq(6).slice(1)),
  },
  {
    name: 'stage insertion at top of file',
    mode: 'stage',
    old: L(...seq(6)),
    new: L('X', ...seq(6)),
    sel: ['+X'],
    patch: `${MOD()}@@ -1,3 +1,4 @@\n+X\n l1\n l2\n l3\n`,
  },
  {
    name: 'stage last line replaced, only the - line',
    mode: 'stage',
    old: L(...seq(6)),
    new: L(...seq(5), 'Y'),
    sel: ['-l6'],
    patch: `${MOD()}@@ -3,4 +3,3 @@\n l3\n l4\n l5\n-l6\n`,
    result: L(...seq(5)),
  },
  {
    name: 'stage append at end of file',
    mode: 'stage',
    old: L(...seq(6)),
    new: L(...seq(6), 'Z', 'W'),
    sel: ['+Z'],
    patch: `${MOD()}@@ -4,3 +4,4 @@\n l4\n l5\n l6\n+Z\n`,
    result: L(...seq(6), 'Z'),
  },
  {
    name: 'stage deletion of the last line',
    mode: 'stage',
    old: L(...seq(6)),
    new: L(...seq(5)),
    sel: ['-l6'],
    patch: `${MOD()}@@ -3,4 +3,3 @@\n l3\n l4\n l5\n-l6\n`,
  },
  {
    name: 'stage all-adds into an empty file (oldLines 0)',
    mode: 'stage',
    old: '',
    new: L('a', 'b', 'c'),
    sel: ['*'],
    patch: `${MOD()}@@ -0,0 +1,3 @@\n+a\n+b\n+c\n`,
    result: L('a', 'b', 'c'),
  },
  {
    name: 'stage one of all-adds (count 1 omitted in header)',
    mode: 'stage',
    old: '',
    new: L('a', 'b', 'c'),
    sel: ['+b'],
    patch: `${MOD()}@@ -0,0 +1 @@\n+b\n`,
    result: L('b'),
  },
  {
    name: 'stage one of all-deletes',
    mode: 'stage',
    old: L('a', 'b', 'c'),
    new: '',
    sel: ['-b'],
    patch: `${MOD()}@@ -1,3 +1,2 @@\n a\n-b\n c\n`,
    result: L('a', 'c'),
  },
  {
    name: 'stage all-deletes leaving an empty file (newLines 0)',
    mode: 'stage',
    old: L('a', 'b', 'c'),
    new: '',
    sel: ['*'],
    patch: `${MOD()}@@ -1,3 +0,0 @@\n-a\n-b\n-c\n`,
    result: '',
  },
  {
    name: 'stage part of a mixed replace block',
    mode: 'stage',
    old: L(...seq(8)),
    new: L('l1', 'l2', 'A', 'B', 'l6', 'l7', 'l8'),
    sel: ['-l4', '+B'],
    patch: `${MOD()}@@ -1,8 +1,8 @@\n l1\n l2\n l3\n-l4\n l5\n+B\n l6\n l7\n l8\n`,
    result: L('l1', 'l2', 'l3', 'l5', 'B', 'l6', 'l7', 'l8'),
  },
  {
    name: 'spec 06 §6.5 worked example (stage only +B2)',
    mode: 'stage',
    old: L('a', 'b', 'c', 'd'),
    new: L('a', 'B1', 'B2', 'c', 'd'),
    sel: ['+B2'],
    patch: `${MOD()}@@ -1,4 +1,5 @@\n a\n b\n+B2\n c\n d\n`,
    result: L('a', 'b', 'B2', 'c', 'd'),
  },
  {
    name: 'spec 06 §6.5 worked example at line 10 (-U1)',
    mode: 'stage',
    old: L(...seq(9, 'p'), 'a', 'b', 'c', 'd', 'e'),
    new: L(...seq(9, 'p'), 'a', 'B1', 'B2', 'c', 'd', 'e'),
    sel: ['+B2'],
    unified: 1,
    patch: `${MOD()}@@ -10,3 +10,4 @@\n a\n b\n+B2\n c\n`,
    result: L(...seq(9, 'p'), 'a', 'b', 'B2', 'c', 'd', 'e'),
  },
  {
    name: 'stage a single + line (only change)',
    mode: 'stage',
    old: L(...seq(10)),
    new: L(...seq(5), 'X', ...seq(10).slice(5)),
    sel: ['+X'],
    patch: `${MOD()}@@ -3,6 +3,7 @@\n l3\n l4\n l5\n+X\n l6\n l7\n l8\n`,
  },
  {
    name: 'stage a single - line (only change)',
    mode: 'stage',
    old: L(...seq(10)),
    new: L(...seq(10).filter((l) => l !== 'l5')),
    sel: ['-l5'],
    patch: `${MOD()}@@ -2,7 +2,6 @@\n l2\n l3\n l4\n-l5\n l6\n l7\n l8\n`,
  },
  // ---- stage: multiple hunks and cumulative offsets ----
  {
    name: 'stage all three hunks',
    mode: 'stage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['*'],
    patch: `${MOD()}@@ -1,6 +1,8 @@\n${H0}@@ -12,7 +14,6 @@\n${H1}@@ -24,7 +25,7 @@\n${H2}`,
    result: MULTI_NEW,
  },
  {
    name: 'stage hunks 0 and 2 (hunk 1 dropped, offset +2)',
    mode: 'stage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['@0', '@2'],
    patch: `${MOD()}@@ -1,6 +1,8 @@\n${H0}@@ -24,7 +26,7 @@\n${H2}`,
  },
  {
    name: 'stage +X2 and -l27 (partial hunks, offset +1)',
    mode: 'stage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['+X2', '-l27'],
    patch:
      `${MOD()}@@ -1,6 +1,7 @@\n l1\n l2\n l3\n+X2\n l4\n l5\n l6\n` +
      `@@ -24,7 +25,6 @@\n l24\n l25\n l26\n-l27\n l28\n l29\n l30\n`,
  },
  {
    name: 'stage only the middle hunk (no offset)',
    mode: 'stage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['@1'],
    patch: `${MOD()}@@ -12,7 +12,6 @@\n${H1}`,
  },
  {
    name: 'stage -l15 and +Y (offset -1 into hunk 2)',
    mode: 'stage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['-l15', '+Y'],
    patch:
      `${MOD()}@@ -12,7 +12,6 @@\n${H1}` +
      `@@ -24,7 +23,8 @@\n l24\n l25\n l26\n l27\n+Y\n l28\n l29\n l30\n`,
  },
  // ---- unstage (diff HEAD→index, applied -R) ----
  {
    name: 'unstage all three hunks',
    mode: 'unstage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['*'],
    patch: `${MOD()}@@ -1,6 +1,8 @@\n${H0}@@ -12,7 +14,6 @@\n${H1}@@ -24,7 +25,7 @@\n${H2}`,
    reverse: true,
    result: MULTI_OLD,
  },
  {
    name: 'unstage +X1 and +Y (unselected + become context)',
    mode: 'unstage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['+X1', '+Y'],
    patch:
      `${MOD()}@@ -1,7 +1,8 @@\n l1\n l2\n l3\n+X1\n X2\n l4\n l5\n l6\n` +
      `@@ -24,6 +25,7 @@\n l24\n l25\n l26\n+Y\n l28\n l29\n l30\n`,
    reverse: true,
  },
  {
    name: 'unstage only -l15',
    mode: 'unstage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['-l15'],
    patch: `${MOD()}@@ -14,7 +14,6 @@\n${H1}`,
    reverse: true,
  },
  {
    name: 'unstage -l15 and -l27 (offset +1 back to HEAD)',
    mode: 'unstage',
    old: MULTI_OLD,
    new: MULTI_NEW,
    sel: ['-l15', '-l27'],
    patch:
      `${MOD()}@@ -14,7 +14,6 @@\n${H1}` +
      `@@ -26,8 +25,7 @@\n l24\n l25\n l26\n-l27\n Y\n l28\n l29\n l30\n`,
    reverse: true,
  },
  {
    name: 'unstage the - side of a replace',
    mode: 'unstage',
    old: L(...seq(10)),
    new: L(...seq(10).map((l) => (l === 'l5' ? 'X' : l))),
    sel: ['-l5'],
    patch: `${MOD()}@@ -2,8 +2,7 @@\n l2\n l3\n l4\n-l5\n X\n l6\n l7\n l8\n`,
    result: L(...seq(5), 'X', ...seq(10).slice(5)),
  },
  {
    name: 'unstage a single + line',
    mode: 'unstage',
    old: L(...seq(10)),
    new: L(...seq(5), 'X', ...seq(10).slice(5)),
    sel: ['+X'],
    patch: `${MOD()}@@ -3,6 +3,7 @@\n l3\n l4\n l5\n+X\n l6\n l7\n l8\n`,
    result: L(...seq(10)),
  },
  {
    name: 'unstage one of all-adds from an empty HEAD file',
    mode: 'unstage',
    old: '',
    new: L('a', 'b'),
    sel: ['+a'],
    patch: `${MOD()}@@ -1 +1,2 @@\n+a\n b\n`,
    result: L('b'),
  },
  {
    name: 'unstage one of all-deletes into an empty index file (newLines 0)',
    mode: 'unstage',
    old: L('a', 'b'),
    new: '',
    sel: ['-b'],
    patch: `${MOD()}@@ -1 +0,0 @@\n-b\n`,
    result: L('b'),
  },
  // ---- "\ No newline at end of file" ----
  {
    name: 'stage adding the final EOL (+ selects its EOF pair)',
    mode: 'stage',
    old: 'a\nb\nc',
    new: L('a', 'b', 'c'),
    sel: ['+c'],
    patch: `${MOD()}@@ -1,3 +1,3 @@\n a\n b\n-c\n${NL}+c\n`,
    result: L('a', 'b', 'c'),
  },
  {
    name: 'stage removing the final EOL (- selects its EOF pair)',
    mode: 'stage',
    old: L('a', 'b', 'c'),
    new: 'a\nb\nc',
    sel: ['-c'],
    patch: `${MOD()}@@ -1,3 +1,3 @@\n a\n b\n-c\n+c\n${NL}`,
    result: 'a\nb\nc',
  },
  {
    name: 'stage last line change, both sides without EOL',
    mode: 'stage',
    old: 'a\nb\nc',
    new: 'a\nb\nX',
    sel: ['+X'],
    patch: `${MOD()}@@ -1,3 +1,3 @@\n a\n b\n-c\n${NL}+X\n${NL}`,
    result: 'a\nb\nX',
  },
  {
    name: 'stage omits the marker of an omitted + line',
    mode: 'stage',
    old: L('a', 'b', 'c'),
    new: 'a\nX\nc\nd',
    sel: ['-b', '+X'],
    patch: `${MOD()}@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n`,
    result: L('a', 'X', 'c'),
  },
  {
    name: 'stage keeps the marker on trailing context',
    mode: 'stage',
    old: 'a\nb\nc',
    new: 'a\nB\nc',
    sel: ['+B'],
    patch: `${MOD()}@@ -1,3 +1,4 @@\n a\n b\n+B\n c\n${NL}`,
    result: 'a\nb\nB\nc',
  },
  {
    name: 'unstage the EOF pair (- selects its + pair)',
    mode: 'unstage',
    old: 'a\nb',
    new: 'a\nB',
    sel: ['-b'],
    patch: `${MOD()}@@ -1,2 +1,2 @@\n a\n-b\n${NL}+B\n${NL}`,
    reverse: true,
    result: 'a\nb',
  },
  {
    name: 'unstage omits the marker of an omitted - line',
    mode: 'unstage',
    old: 'a\nb\nc\nd',
    new: L('a', 'X', 'c'),
    sel: ['-b', '+X'],
    patch: `${MOD()}@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n`,
    result: L('a', 'b', 'c'),
  },
  {
    name: 'unstage keeps the marker of an unselected + turned context',
    mode: 'unstage',
    old: L('a', 'b'),
    new: 'a\nX\nc',
    sel: ['+X'],
    patch: `${MOD()}@@ -1,2 +1,3 @@\n a\n+X\n c\n${NL}`,
    result: 'a\nc',
  },
  // ---- new (untracked / added) files ----
  {
    name: 'stage one line of a new file',
    mode: 'stage',
    old: null,
    new: L('a', 'b', 'c'),
    sel: ['+b'],
    path: 'n.txt',
    patch: `${NEW('n.txt')}@@ -0,0 +1 @@\n+b\n`,
    result: L('b'),
  },
  {
    name: 'stage the no-EOL last line of a new file',
    mode: 'stage',
    old: null,
    new: 'a\nb',
    sel: ['+b'],
    patch: `${NEW()}@@ -0,0 +1 @@\n+b\n${NL}`,
    result: 'b',
  },
  {
    name: 'stage a new file without its no-EOL last line (marker dropped)',
    mode: 'stage',
    old: null,
    new: 'a\nb',
    sel: ['+a'],
    patch: `${NEW()}@@ -0,0 +1 @@\n+a\n`,
    result: L('a'),
  },
  {
    name: 'stage non-adjacent lines of a new file',
    mode: 'stage',
    old: null,
    new: L('a', 'b', 'c'),
    sel: ['+a', '+c'],
    patch: `${NEW()}@@ -0,0 +1,2 @@\n+a\n+c\n`,
    result: L('a', 'c'),
  },
  {
    name: 'stage a whole new file',
    mode: 'stage',
    old: null,
    new: L('a', 'b', 'c'),
    sel: ['*'],
    patch: `${NEW()}@@ -0,0 +1,3 @@\n+a\n+b\n+c\n`,
    result: L('a', 'b', 'c'),
  },
  {
    name: 'stage a whole new executable file (fileMode option)',
    mode: 'stage',
    old: null,
    new: L('#!/bin/sh'),
    sel: ['*'],
    opts: { fileMode: '100755' },
    patch: `${NEW('f.txt', '100755')}@@ -0,0 +1 @@\n+#!/bin/sh\n`,
  },
  {
    name: 'unstage a whole added file (reverse new-file patch)',
    mode: 'unstage',
    old: null,
    new: L('a', 'b'),
    sel: ['*'],
    patch: `${NEW()}@@ -0,0 +1,2 @@\n+a\n+b\n`,
    reverse: true,
    result: null,
  },
  {
    name: 'unstage one line of an added file',
    mode: 'unstage',
    old: null,
    new: L('a', 'b', 'c'),
    sel: ['+b'],
    patch: `${MOD()}@@ -1,2 +1,3 @@\n a\n+b\n c\n`,
    reverse: true,
    result: L('a', 'c'),
  },
  // ---- deleted files ----
  {
    name: 'stage a whole deletion',
    mode: 'stage',
    old: L('a', 'b', 'c'),
    new: null,
    sel: ['*'],
    patch: `${DEL()}@@ -1,3 +0,0 @@\n-a\n-b\n-c\n`,
    result: null,
  },
  {
    name: 'stage part of a deletion (file gets shorter)',
    mode: 'stage',
    old: L('a', 'b', 'c'),
    new: null,
    sel: ['-b'],
    patch: `${MOD()}@@ -1,3 +1,2 @@\n a\n-b\n c\n`,
    result: L('a', 'c'),
  },
  {
    name: 'unstage a whole staged deletion',
    mode: 'unstage',
    old: L('a', 'b', 'c'),
    new: null,
    sel: ['*'],
    patch: `${DEL()}@@ -1,3 +0,0 @@\n-a\n-b\n-c\n`,
    reverse: true,
    result: L('a', 'b', 'c'),
  },
  {
    name: 'unstage part of a staged deletion (re-adds selected lines)',
    mode: 'unstage',
    old: L('a', 'b', 'c'),
    new: null,
    sel: ['-b'],
    patch: `${NEW()}@@ -0,0 +1 @@\n+b\n`,
    reverse: false,
    result: L('b'),
  },
  {
    name: 'unstage the no-EOL last line of a staged deletion',
    mode: 'unstage',
    old: 'a\nb',
    new: null,
    sel: ['-a', '-b'],
    patch: `${DEL()}@@ -1,2 +0,0 @@\n-a\n-b\n${NL}`,
    reverse: true,
    result: 'a\nb',
  },
  {
    name: 'unstage part of a deletion ending without EOL',
    mode: 'unstage',
    old: 'a\nb\nc',
    new: null,
    sel: ['-c'],
    patch: `${NEW()}@@ -0,0 +1 @@\n+c\n${NL}`,
    reverse: false,
    result: 'c',
  },
  // ---- CRLF / unicode / paths ----
  {
    name: 'stage CRLF content (\\r kept in patch lines)',
    mode: 'stage',
    old: 'a\r\nb\r\nc\r\n',
    new: 'a\r\nX\r\nc\r\n',
    sel: ['+X'],
    patch: `${MOD()}@@ -1,3 +1,4 @@\n a\r\n b\r\n+X\r\n c\r\n`,
    result: 'a\r\nb\r\nX\r\nc\r\n',
  },
  {
    name: 'stage a CRLF→LF line ending change',
    mode: 'stage',
    old: 'a\r\nb\r\nc\r\n',
    new: 'a\r\nb\nc\r\n',
    sel: ['-b', '+b'],
    patch: `${MOD()}@@ -1,3 +1,3 @@\n a\r\n-b\r\n+b\n c\r\n`,
    result: 'a\r\nb\nc\r\n',
  },
  {
    name: 'unstage a CRLF deletion',
    mode: 'unstage',
    old: 'a\r\nb\r\nc\r\nd\r\n',
    new: 'a\r\nd\r\n',
    sel: ['-c'],
    patch: `${MOD()}@@ -1,3 +1,2 @@\n a\r\n-c\r\n d\r\n`,
    result: 'a\r\nc\r\nd\r\n',
  },
  {
    name: 'stage CRLF file without final EOL',
    mode: 'stage',
    old: 'a\r\nb\r\nc',
    new: 'a\r\nB\r\nc\r\nd',
    sel: ['-b'],
    patch: `${MOD()}@@ -1,3 +1,2 @@\n a\r\n-b\r\n c\n${NL}`,
    result: 'a\r\nc',
  },
  {
    name: 'stage unicode content',
    mode: 'stage',
    old: L('héllo wörld', '日本語のテキスト', 'end'),
    new: L('héllo wörld', '🎉 emoji ünïcödé', 'end'),
    sel: ['+🎉 emoji ünïcödé'],
    patch: `${MOD()}@@ -1,3 +1,4 @@\n héllo wörld\n 日本語のテキスト\n+🎉 emoji ünïcödé\n end\n`,
  },
  {
    name: 'stage with a quoted path (tab, quote, backslash)',
    mode: 'stage',
    old: L('a', 'b'),
    new: L('a', 'B'),
    sel: ['*'],
    path: 'dir/t\tq"b\\s.txt',
    patch:
      'diff --git "a/dir/t\\tq\\"b\\\\s.txt" "b/dir/t\\tq\\"b\\\\s.txt"\n' +
      '--- "a/dir/t\\tq\\"b\\\\s.txt"\n+++ "b/dir/t\\tq\\"b\\\\s.txt"\n' +
      '@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
  },
  {
    name: 'stage a new file with a newline in its path',
    mode: 'stage',
    old: null,
    new: L('a', 'b'),
    sel: ['+a'],
    path: 'x\ny.txt',
    patch:
      'diff --git "a/x\\ny.txt" "b/x\\ny.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/x\\ny.txt"\n' +
      '@@ -0,0 +1 @@\n+a\n',
  },
  {
    name: 'stage with spaces and non-ASCII in the path (not quoted)',
    mode: 'stage',
    old: L('a'),
    new: L('a', 'b'),
    sel: ['+b'],
    path: 'my dir/ü fïle.txt',
    patch: `${MOD('my dir/ü fïle.txt')}@@ -1 +1,2 @@\n a\n+b\n`,
  },
  // ---- nothing to do ----
  { name: 'empty selection', mode: 'stage', old: L('a'), new: L('b'), sel: [], none: true },
  {
    name: 'context-only selection',
    mode: 'stage',
    old: L('a', 'b'),
    new: L('a', 'B'),
    sel: [' a'],
    none: true,
  },
  {
    name: 'unstage, context-only selection',
    mode: 'unstage',
    old: L('a', 'b'),
    new: L('a', 'B'),
    sel: [' a'],
    none: true,
  },
  { name: 'empty new file (no hunks)', mode: 'stage', old: null, new: '', sel: [], none: true },
];

let tmpRoot = '';
let seqNo = 0;
const diffOf = (c: Pick<Case, 'old' | 'new' | 'path' | 'unified'>): FileDiff => {
  const f = gitDiffTexts(
    path.join(tmpRoot, String(++seqNo)),
    c.old,
    c.new,
    c.path ?? 'f.txt',
    c.unified ?? 3,
  );
  if (!f) throw new Error('texts do not differ');
  return f;
};

describeGit('buildLinePatch (table, real git diffs)', () => {
  beforeAll(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-linepatch-')));
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it('has 40+ cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const file = diffOf(c);
    const sel = selectLines(file, refsFor(file, c.sel));
    expect(sel).not.toBeNull();
    const lp = buildLinePatch(file, sel!, c.mode, { path: c.path ?? 'f.txt', ...c.opts });
    if (c.none) {
      expect(lp).toBeNull();
      return;
    }
    expect(lp).not.toBeNull();
    if (c.patch !== undefined) expect(lp!.patch).toBe(c.patch);
    expect(lp!.reverse).toBe(c.reverse ?? c.mode === 'unstage');

    // the model of the selection and the in-memory application of the patch must agree
    const model = expectedResult(c.old, c.new, file, sel!, c.mode);
    expect(model.valid).toBe(true);
    if (c.result !== undefined) expect(model.text).toBe(c.result);
    const indexBefore = c.mode === 'stage' ? c.old : c.new;
    expect(applyPatch(indexBefore, lp!.patch, lp!.reverse)).toBe(model.text);

    // discard of the same selection in the worktree reverts exactly those lines (stage-side diffs only)
    if (c.mode === 'stage' && c.old !== null && c.new !== null) {
      const discarded = discardInContent(Buffer.from(c.new, 'utf8'), file, sel!);
      expect(discarded.toString('utf8')).toBe(expectedResult(c.old, c.new, file, sel!, 'unstage').text);
    }
  });

  // Known limitation of the EOF-pair rule (spec 06 §6.5): the pair is "last - and last +" of the hunk,
  // which is not the matching line when the new side has more lines after the old no-EOL line.
  it('regression (EOF pair): stage "+b" when old "a\\nb" (no EOL) becomes "a\\nb\\nc\\n" emits content after a no-EOL line', () => {
    const c = { old: 'a\nb', new: L('a', 'b', 'c') };
    const file = diffOf(c);
    const sel = selectLines(file, refsFor(file, ['+b']))!;
    const lp = buildLinePatch(file, sel, 'stage')!;
    // stage only the newline-terminated b: index should become "a\nb\n"
    expect(applyPatch(c.old, lp.patch, false)).toBe(L('a', 'b'));
  });
  it('regression (EOF pair): stage "+c" in the same diff links "-b" and drops b from the index', () => {
    const c = { old: 'a\nb', new: L('a', 'b', 'c') };
    const file = diffOf(c);
    const sel = selectLines(file, refsFor(file, ['+c']))!;
    const lp = buildLinePatch(file, sel, 'stage')!;
    const r = applyPatch(c.old, lp.patch, false);
    expect(r).toContain('b');
  });
  it('regression (EOF pair): unstage "+c" when HEAD "a\\nb" (no EOL) and index "a\\nb\\nc\\n" builds a corrupt patch', () => {
    const c = { old: 'a\nb', new: L('a', 'b', 'c') };
    const file = diffOf(c);
    const sel = selectLines(file, refsFor(file, ['+c']))!;
    const lp = buildLinePatch(file, sel, 'unstage')!;
    expect(applyPatch(c.new, lp.patch, true)).toBe(L('a', 'b'));
  });
});

// ---- small pure helpers ----

const hand = (
  lines: [FileDiff['hunks'][number]['lines'][number]['type'], string][],
  o = 1,
  n = 1,
): FileDiff => ({
  oldPath: 'f',
  newPath: 'f',
  status: 'M',
  binary: false,
  additions: 0,
  deletions: 0,
  hunks: [
    {
      header: '',
      oldStart: o,
      oldLines: lines.filter(([t]) => t === 'context' || t === 'del').length,
      newStart: n,
      newLines: lines.filter(([t]) => t === 'context' || t === 'add').length,
      lines: lines.map(([type, content], patchOffset) => ({ type, content, patchOffset })),
    },
  ],
});

describe('patch helpers', () => {
  const f = hand([
    ['context', 'a'],
    ['del', 'b'],
    ['add', 'B'],
    ['context', 'c'],
  ]);

  it('lineKey / selectHunk / allChangesSelected', () => {
    expect(lineKey(2, 7)).toBe('2:7');
    expect([...selectHunk(f, 0)]).toEqual(['0:1', '0:2']);
    expect(selectHunk(f, 5).size).toBe(0);
    expect(allChangesSelected(f, selectHunk(f, 0))).toBe(true);
    expect(allChangesSelected(f, new Set(['0:1']))).toBe(false);
  });

  it('selectLines drops context, rejects stale refs and links the EOF pair', () => {
    expect([...selectLines(f, [{ hunkIndex: 0, lineIndex: 0 }])!]).toEqual([]);
    expect(selectLines(f, [{ hunkIndex: 0, lineIndex: 9 }])).toBeNull();
    expect(selectLines(f, [{ hunkIndex: 3, lineIndex: 0 }])).toBeNull();
    const eof = hand([
      ['context', 'a'],
      ['del', 'b'],
      ['nonewline', 'No newline at end of file'],
      ['add', 'B'],
      ['nonewline', 'No newline at end of file'],
    ]);
    expect([...selectLines(eof, [{ hunkIndex: 0, lineIndex: 3 }])!].sort()).toEqual(['0:1', '0:3']);
    // no pair when context follows the changes
    const notEof = hand([
      ['del', 'b'],
      ['add', 'B'],
      ['context', 'c'],
      ['nonewline', 'No newline at end of file'],
    ]);
    expect([...selectLines(notEof, [{ hunkIndex: 0, lineIndex: 1 }])!]).toEqual(['0:1']);
  });

  it('quotePatchPath quotes only when needed, C-style', () => {
    expect(quotePatchPath('a/', 'plain/ü file.txt')).toBe('a/plain/ü file.txt');
    expect(quotePatchPath('b/', 'x"y')).toBe('"b/x\\"y"');
    expect(quotePatchPath('a/', 'back\\slash')).toBe('"a/back\\\\slash"');
    expect(quotePatchPath('a/', 't\tn\nr\r')).toBe('"a/t\\tn\\nr\\r"');
    expect(quotePatchPath('a/', 'bell\x07del\x7f')).toBe('"a/bell\\007del\\177"');
  });

  it('patchHeader variants', () => {
    expect(patchHeader('p', 'modify')).toBe('diff --git a/p b/p\n--- a/p\n+++ b/p\n');
    expect(patchHeader('p', { newFile: '100755' })).toBe(
      'diff --git a/p b/p\nnew file mode 100755\n--- /dev/null\n+++ b/p\n',
    );
    expect(patchHeader('p', { deletedFile: '100644' })).toBe(
      'diff --git a/p b/p\ndeleted file mode 100644\n--- a/p\n+++ /dev/null\n',
    );
  });

  it('buildHunks returns "" for no selection; buildNewFilePatch returns "" when nothing of that side is selected', () => {
    expect(buildHunks(f, new Set(), 'stage')).toBe('');
    expect(buildNewFilePatch('p', '100644', f, new Set(['0:1']), 'add')).toBe('');
    expect(buildNewFilePatch('p', '100644', f, new Set(['0:1']), 'del')).toBe(
      'diff --git a/p b/p\nnew file mode 100644\n--- /dev/null\n+++ b/p\n@@ -0,0 +1 @@\n+b\n',
    );
  });

  it('buildLinePatch ignores unknown keys', () => {
    expect(buildLinePatch(f, new Set(['0:9', '4:0']), 'stage')).toBeNull();
  });

  it('discardInContent re-inserts removed lines with the dominant EOL', () => {
    const d = hand(
      [
        ['context', 'a'],
        ['del', 'b'],
        ['add', 'B'],
        ['context', 'c'],
      ],
      1,
      1,
    );
    d.hunks[0]!.lines[0]!.newLineNo = 1;
    d.hunks[0]!.lines[2]!.newLineNo = 2;
    d.hunks[0]!.lines[3]!.newLineNo = 3;
    const wt = Buffer.from('a\r\nB\r\nc\r\n');
    expect(discardInContent(wt, d, new Set(['0:1', '0:2'])).toString()).toBe('a\r\nb\r\nc\r\n');
    expect(discardInContent(wt, d, new Set(['0:2'])).toString()).toBe('a\r\nc\r\n');
    expect(discardInContent(wt, d, new Set(['0:1'])).toString()).toBe('a\r\nb\r\nB\r\nc\r\n');
  });
});
