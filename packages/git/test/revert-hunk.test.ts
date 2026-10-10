import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { diffHash } from '../src/ops/diff-hash';
import { buildRevertPatch } from '../src/ops/executors/revert-hunk';
import type { GitOperation } from '../src/ops/types';
import { WORKTREE_REV } from '../src/service/git-service';
import type { DiffSpec, FileDiff } from '../src/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness } from './ops-harness';

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const text = (lines: string[]): string => `${lines.join('\n')}\n`;

describe('buildRevertPatch', () => {
  const file = (status: FileDiff['status'], hunks: FileDiff['hunks']): FileDiff => ({
    oldPath: status === 'A' ? null : 'a.txt',
    newPath: status === 'D' ? null : 'a.txt',
    status,
    binary: false,
    hunks,
    additions: 0,
    deletions: 0,
    newMode: '100644',
    oldMode: '100644',
  });
  const hunk = (header: string, lines: [string, 'context' | 'add' | 'del' | 'nonewline'][]) => ({
    header,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: lines.map(([content, type], i) => ({ type, content, patchOffset: i })),
  });

  it('emits the selected hunks verbatim under a modify header', () => {
    const f = file('M', [
      hunk('@@ -1,2 +1,2 @@ fn', [
        ['a', 'del'],
        ['A', 'add'],
        ['b', 'context'],
      ]),
      hunk('@@ -9 +9 @@', [
        ['y', 'del'],
        ['Y', 'add'],
        ['', 'nonewline'],
      ]),
    ]);
    expect(buildRevertPatch(f, [1])).toBe(
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -9 +9 @@\n-y\n+Y\n\\ No newline at end of file\n',
    );
    expect(buildRevertPatch(f, [1, 0]).indexOf('@@ -1,2')).toBeLessThan(
      buildRevertPatch(f, [1, 0]).indexOf('@@ -9'),
    );
  });

  it('turns a whole added file into a new-file patch (reverse = delete) and refuses partial deletions', () => {
    const added = file('A', [hunk('@@ -0,0 +1 @@', [['x', 'add']])]);
    expect(buildRevertPatch(added, [0])).toContain('new file mode 100644\n--- /dev/null\n+++ b/a.txt');
    const deleted = file('D', [hunk('@@ -1 +0,0 @@', [['x', 'del']])]);
    expect(buildRevertPatch(deleted, [0])).toContain('deleted file mode 100644');
    const twoHunks = file('D', [
      hunk('@@ -1 +0,0 @@', [['x', 'del']]),
      hunk('@@ -5 +0,0 @@', [['y', 'del']]),
    ]);
    expect(() => buildRevertPatch(twoHunks, [0])).toThrow(/whole file/);
    expect(() => buildRevertPatch(added, [3])).toThrow();
  });
});

describeGit('diff.revertHunk + file.checkoutAt (real repos, undo journal)', () => {
  const h = useHarness('revert-hunk');

  async function setup() {
    const r = await tinyRepo(h, { 'a.txt': text(TEN) });
    const changed = [...TEN];
    changed[0] = 'line 1 changed';
    changed[9] = 'line 10 changed';
    const sha = r.commit('two hunks', { 'a.txt': text(changed) });
    r.svc = await h.open(r.dir);
    const journal = new UndoJournal({ service: r.svc });
    return { r, sha, changed, journal };
  }

  const op = (
    spec: Extract<GitOperation, { type: 'diff.revertHunk' }>['spec'],
    hash: string,
    hunkIndex: number | 'all',
  ) =>
    ({ type: 'diff.revertHunk', spec, path: 'a.txt', hunkIndex, diffHash: hash, contextLines: 3 }) as const;

  it('reverts one hunk of a commit into the working tree (unstaged) and undoes it', async () => {
    const { r, sha, changed, journal } = await setup();
    const spec: DiffSpec = { kind: 'commit', sha, paths: ['a.txt'] };
    const [file] = await r.svc.diff(spec, { contextLines: 3, ignoreWhitespace: 'none' });
    expect(file!.hunks).toHaveLength(2);
    await h.run(r.svc, op(spec, diffHash(file!), 1), { journal });
    const expected = [...changed];
    expected[9] = 'line 10';
    expect(r.file('a.txt')).toBe(text(expected));
    // unstaged: index still matches HEAD
    expect(r.g('diff', '--cached', '--name-only').trim()).toBe('');
    expect(r.g('diff', '--name-only').trim()).toBe('a.txt');
    expect(journal.peek().undo?.kind).toBe('revert-hunk');
    await journal.undo();
    expect(r.file('a.txt')).toBe(text(changed));
    await journal.redo();
    expect(r.file('a.txt')).toBe(text(expected));
  });

  it('reverts every hunk ("all") and refuses a stale diff hash', async () => {
    const { r, sha } = await setup();
    const spec = { kind: 'commit', sha } as const;
    const err = await h.fail(r.svc, op(spec, 'deadbeef', 0));
    expect(err.message).toMatch(/changed; refresh/);
    const [file] = await r.svc.diff(
      { ...spec, paths: ['a.txt'] },
      { contextLines: 3, ignoreWhitespace: 'none' },
    );
    await h.run(r.svc, op(spec, diffHash(file!), 'all'));
    expect(r.file('a.txt')).toBe(text(TEN));
  });

  it('works on commit-vs-working-tree comparisons and reports a diverged worktree', async () => {
    const { r, sha, changed } = await setup();
    const local = [...changed];
    local[4] = 'line 5 local';
    fs.writeFileSync(path.join(r.dir, 'a.txt'), text(local));
    const base = `${sha}~1`;
    const spec = { kind: 'range', from: base, to: WORKTREE_REV } as const;
    const [file] = await r.svc.diff(
      { ...spec, paths: ['a.txt'] },
      { contextLines: 0, ignoreWhitespace: 'none' },
    );
    expect(file!.hunks).toHaveLength(3);
    await h.run(r.svc, { ...op(spec, diffHash(file!), 1), contextLines: 0 });
    expect(r.file('a.txt')).toBe(text(changed));

    // the commit's second hunk no longer applies once the worktree line changed
    const cspec = { kind: 'commit', sha } as const;
    const [cfile] = await r.svc.diff(
      { ...cspec, paths: ['a.txt'] },
      { contextLines: 3, ignoreWhitespace: 'none' },
    );
    const diverged = [...changed];
    diverged[9] = 'line 10 rewritten locally';
    fs.writeFileSync(path.join(r.dir, 'a.txt'), text(diverged));
    const err = await h.fail(r.svc, op(cspec, diffHash(cfile!), 1));
    expect(err.message).toMatch(/no longer applies/);
  });

  it('refuses WIP specs (Discard is the WIP action)', async () => {
    const { r } = await setup();
    const err = await h.fail(r.svc, op({ kind: 'workdir' }, 'x', 0));
    expect(err.message).toMatch(/use Discard/);
  });

  it('file.checkoutAt restores a file from a commit and is undoable', async () => {
    const { r, sha, changed, journal } = await setup();
    await h.run(r.svc, { type: 'file.checkoutAt', rev: `${sha}~1`, path: 'a.txt' }, { journal });
    expect(r.file('a.txt')).toBe(text(TEN));
    expect(r.g('diff', '--cached', '--name-only').trim()).toBe('a.txt');
    await journal.undo();
    expect(r.file('a.txt')).toBe(text(changed));
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });
});
