import path from 'node:path';

import { expect, it } from 'vitest';

import type { GitOperation } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describeGit('Phase 3 undo journal: merge / rebase / reset / cherry-pick / ff', () => {
  const h = useHarness('p3undo');

  async function setup(): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
  }> {
    const r = await tinyRepo(h, { 'README.md': 'base\n', 'notes.txt': 'n\n' });
    r.g('branch', 'side');
    r.commit('M1', { 'main.txt': 'm\n' });
    r.g('switch', '-q', 'side');
    r.commit('S1', { 'side.txt': 's\n' });
    r.g('switch', '-q', 'main');
    const journal = new UndoJournal({ service: r.svc });
    return { r, journal, run: (op) => h.run(r.svc, op, { journal }) };
  }

  it('undoes and redoes a merge, keeping unrelated local changes', async () => {
    const { r, journal, run } = await setup();
    const before = r.rev('HEAD');
    h.write(path.join(r.dir, 'notes.txt'), 'local edit\n');
    await run({ type: 'merge.run', source: 'side', mode: 'no-ff' });
    const merged = r.rev('HEAD');
    expect(journal.peek().undo).toMatchObject({ kind: 'merge', label: 'Merge side' });

    await journal.undo();
    expect(r.rev('HEAD')).toBe(before);
    expect(r.file('side.txt')).toBeNull();
    expect(r.file('notes.txt')).toBe('local edit\n');
    expect(r.g('status', '--porcelain').trim()).toBe('M notes.txt');

    await journal.redo();
    expect(r.rev('HEAD')).toBe(merged);
    expect(r.file('side.txt')).toBe('s\n');
    expect(r.file('notes.txt')).toBe('local edit\n');
  });

  it('refuses to undo after the branch moved (drift)', async () => {
    const { r, journal, run } = await setup();
    await run({ type: 'merge.run', source: 'side', mode: 'no-ff' });
    r.commit('Later', { 'later.txt': 'x\n' });
    await expect(journal.undo()).rejects.toThrow(/moved since|HEAD is now/);
  });

  it('undoes a rebase of the current branch', async () => {
    const { r, journal, run } = await setup();
    r.g('switch', '-q', 'side');
    const before = r.rev('side');
    await run({ type: 'rebase.run', onto: 'main' });
    expect(r.rev('side')).not.toBe(before);
    expect(journal.peek().undo?.kind).toBe('rebase');
    await journal.undo();
    expect(r.rev('side')).toBe(before);
    expect(r.file('main.txt')).toBeNull();
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('undoes a rebase of another branch: branch and HEAD go back', async () => {
    const { r, journal, run } = await setup();
    const side = r.rev('side');
    await run({ type: 'rebase.run', onto: 'main', branch: 'side' });
    expect(r.svc.repo.head).toMatchObject({ name: 'side' });
    await journal.undo();
    expect(r.rev('side')).toBe(side);
    expect(r.g('symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(r.file('side.txt')).toBeNull();
    expect(r.file('main.txt')).toBe('m\n');
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('undoes an interactive rebase', async () => {
    const { r, journal, run } = await setup();
    const base = r.rev('HEAD~1');
    const head = r.rev('HEAD');
    const c2 = r.commit('M2', { 'main2.txt': '2\n' });
    await run({
      type: 'rebase.interactive',
      onto: base,
      upstream: base,
      todo: [
        { sha: head, action: 'pick', summary: 'M1' },
        { sha: c2, action: 'squash', summary: 'M2' },
      ],
      squashMessages: { [head]: 'M1+M2' },
    });
    expect(r.g('log', '-1', '--format=%s').trim()).toBe('M1+M2');
    expect(journal.peek().undo?.kind).toBe('interactive-rebase');
    await journal.undo();
    expect(r.rev('HEAD')).toBe(c2);
  });

  it('undoes reset --hard including the discarded local changes', async () => {
    const { r, journal, run } = await setup();
    const head = r.rev('HEAD');
    h.write(path.join(r.dir, 'notes.txt'), 'precious\n');
    await run({ type: 'reset.run', target: 'HEAD~1', mode: 'hard' });
    expect(r.file('notes.txt')).toBe('n\n');
    expect(r.file('main.txt')).toBeNull();
    await journal.undo();
    expect(r.rev('HEAD')).toBe(head);
    expect(r.file('notes.txt')).toBe('precious\n');
    expect(r.file('main.txt')).toBe('m\n');
  });

  it('undoes reset --soft (ref only)', async () => {
    const { r, journal, run } = await setup();
    const head = r.rev('HEAD');
    await run({ type: 'reset.run', target: 'HEAD~1', mode: 'soft' });
    expect(journal.peek().undo?.kind).toBe('reset');
    await journal.undo();
    expect(r.rev('HEAD')).toBe(head);
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('undoes a cherry-pick', async () => {
    const { r, journal, run } = await setup();
    const head = r.rev('HEAD');
    await run({ type: 'cherryPick.run', shas: [r.rev('side')] });
    expect(r.file('side.txt')).toBe('s\n');
    await journal.undo();
    expect(r.rev('HEAD')).toBe(head);
    expect(r.file('side.txt')).toBeNull();
  });

  it('undoes a fast-forward of a branch that is not checked out', async () => {
    const { r, journal, run } = await setup();
    r.g('branch', 'lag', 'HEAD~1');
    const lag = r.rev('lag');
    await run({ type: 'ff.run', branch: 'lag', to: 'main' });
    expect(journal.peek().undo).toMatchObject({ kind: 'fast-forward', label: 'Fast-forward lag' });
    await journal.undo();
    expect(r.rev('lag')).toBe(lag);
  });

  it('does not journal a merge that stopped on conflicts', async () => {
    const fx = h.fixture('conflict');
    const svc = await h.open(fx.path);
    const journal = new UndoJournal({ service: svc });
    await h.fail(svc, { type: 'merge.run', source: 'feature', mode: 'default' }, { journal });
    expect(journal.peek().undo).toBeUndefined();
  });
});
