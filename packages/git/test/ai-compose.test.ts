import path from 'node:path';

import { expect, it } from 'vitest';

import { composeUnits, readComposeDiff } from '../src/ops/executors/compose';
import type { GitOperation } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

const lines = (n: number, tag = ''): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}${tag && i % 10 === 4 ? ` ${tag}` : ''}`).join('\n') +
  '\n';

describeGit('ai.compose (spec 12 §6.6)', () => {
  const h = useHarness('aicompose');

  async function setup(): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
  }> {
    const r = await tinyRepo(h, { 'a.txt': lines(30), 'b.txt': 'b\n', 'gone.txt': 'bye\n' });
    const journal = new UndoJournal({ service: r.svc });
    return { r, journal, run: (op) => h.run(r.svc, op, { journal }) };
  }

  /** Stage: 3 separate hunks in a.txt, one edit in b.txt, a new file and a deletion. */
  function stageChanges(r: TinyRepo): void {
    h.write(path.join(r.dir, 'a.txt'), lines(30, 'CHANGED'));
    h.write(path.join(r.dir, 'b.txt'), 'b2\n');
    h.write(path.join(r.dir, 'new.txt'), 'new\n');
    r.g('rm', '-q', 'gone.txt');
    r.g('add', '-A');
  }

  it('splits the staged diff into stable hunk / file units', async () => {
    const { r } = await setup();
    stageChanges(r);
    const d = await readComposeDiff(r.svc, { kind: 'staged' });
    expect(d.units.map((u) => [u.hunkId, u.kind, u.status])).toEqual([
      ['a.txt#0', 'hunk', 'M'],
      ['a.txt#1', 'hunk', 'M'],
      ['a.txt#2', 'hunk', 'M'],
      ['b.txt#0', 'hunk', 'M'],
      ['gone.txt#0', 'file', 'D'],
      ['new.txt#0', 'file', 'A'],
    ]);
    expect(composeUnits(d.text)).toEqual(d.units);
  });

  it('creates N commits whose combined tree equals the staged tree; one undo restores HEAD and index', async () => {
    const { r, journal, run } = await setup();
    stageChanges(r);
    const head0 = r.rev('HEAD');
    const tree0 = r.g('write-tree').trim();
    const d = await readComposeDiff(r.svc, { kind: 'staged' });
    const hk = (...ids: string[]) => ids.map((hunkId) => ({ path: hunkId.split('#')[0]!, hunkId }));
    await run({
      type: 'ai.compose',
      source: { kind: 'staged' },
      diffHash: d.hash,
      commits: [
        // later hunks of a.txt first: patches must apply against the progressively built index
        { message: 'Second half of a\n\nBody', hunks: hk('a.txt#2', 'a.txt#1') },
        { message: 'Files', hunks: hk('new.txt#0', 'gone.txt#0', 'b.txt#0') },
        { message: 'First hunk of a', hunks: hk('a.txt#0') },
      ],
    });
    expect(r.g('log', '--format=%s', `${head0}..HEAD`).trim().split('\n')).toEqual([
      'First hunk of a',
      'Files',
      'Second half of a',
    ]);
    expect(r.rev('HEAD^{tree}')).toBe(tree0);
    expect(r.g('diff', '--cached', '--name-only').trim()).toBe('');
    expect(journal.peek().undo).toMatchObject({ kind: 'ai-compose' });

    await journal.undo();
    expect(r.rev('HEAD')).toBe(head0);
    expect(r.g('write-tree').trim()).toBe(tree0);
    expect(r.g('status', '--porcelain').trim().split('\n').sort()).toEqual([
      'A  new.txt',
      'D  gone.txt',
      'M  a.txt',
      'M  b.txt',
    ]);
  });

  it('keeps unassigned hunks staged', async () => {
    const { r, run } = await setup();
    stageChanges(r);
    const tree0 = r.g('write-tree').trim();
    const d = await readComposeDiff(r.svc, { kind: 'staged' });
    await run({
      type: 'ai.compose',
      source: { kind: 'staged' },
      diffHash: d.hash,
      commits: [{ message: 'Only b', hunks: [{ path: 'b.txt', hunkId: 'b.txt#0' }] }],
    });
    expect(r.g('show', '--name-only', '--format=', 'HEAD').trim()).toBe('b.txt');
    expect(r.g('write-tree').trim()).toBe(tree0);
  });

  it('rolls back completely when a commit fails, and refuses stale proposals', async () => {
    const { r, run } = await setup();
    stageChanges(r);
    const head0 = r.rev('HEAD');
    const tree0 = r.g('write-tree').trim();
    const d = await readComposeDiff(r.svc, { kind: 'staged' });
    // a commit-msg cleanup that leaves an empty message fails the 2nd commit
    const err = await h.fail(r.svc, {
      type: 'ai.compose',
      source: { kind: 'staged' },
      diffHash: d.hash,
      commits: [
        { message: 'One', hunks: [{ path: 'b.txt', hunkId: 'b.txt#0' }] },
        { message: '# only a comment', hunks: [{ path: 'a.txt', hunkId: 'a.txt#0' }] },
      ],
    });
    expect(err.message).toBeTruthy();
    expect(r.rev('HEAD')).toBe(head0);
    expect(r.g('write-tree').trim()).toBe(tree0);

    const stale = await h.fail(r.svc, {
      type: 'ai.compose',
      source: { kind: 'staged' },
      diffHash: 'deadbeef',
      commits: [{ message: 'x', hunks: [{ path: 'b.txt', hunkId: 'b.txt#0' }] }],
    });
    expect(stale.message).toMatch(/changed since/);
    void run;
  });

  it('recomposes a range ending at HEAD; undo restores the original commits', async () => {
    const { r, journal, run } = await setup();
    const c1 = r.commit('Mixed 1', { 'a.txt': lines(30, 'X'), 'b.txt': 'b3\n' });
    const c2 = r.commit('Mixed 2', { 'new.txt': 'n\n' });
    const d = await readComposeDiff(r.svc, { kind: 'range', from: c1, to: 'HEAD' });
    const ids = d.units.map((u) => ({ path: u.path, hunkId: u.hunkId }));
    await run({
      type: 'ai.compose',
      source: { kind: 'range', from: c1, to: c2 },
      diffHash: d.hash,
      commits: [
        { message: 'Edit a', hunks: ids.filter((u) => u.path === 'a.txt') },
        { message: 'Other files', hunks: ids.filter((u) => u.path !== 'a.txt') },
      ],
    });
    expect(r.rev('HEAD^{tree}')).toBe(r.rev(`${c2}^{tree}`));
    expect(r.g('log', '--format=%s', '-2').trim().split('\n')).toEqual(['Other files', 'Edit a']);
    expect(r.rev('HEAD~2')).toBe(r.rev(`${c1}^`));
    await journal.undo();
    expect(r.rev('HEAD')).toBe(c2);
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('refuses to recompose with local changes', async () => {
    const { r } = await setup();
    const c1 = r.commit('C1', { 'b.txt': 'b4\n' });
    h.write(path.join(r.dir, 'b.txt'), 'dirty\n');
    const d = await readComposeDiff(r.svc, { kind: 'range', from: c1, to: 'HEAD' });
    const err = await h.fail(r.svc, {
      type: 'ai.compose',
      source: { kind: 'range', from: c1, to: 'HEAD' },
      diffHash: d.hash,
      commits: [{ message: 'x', hunks: [{ path: 'b.txt', hunkId: 'b.txt#0' }] }],
    });
    expect(err.message).toMatch(/Commit or stash/);
  });
});
