import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { GitOperation } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describeGit('squash N commits (spec 05 §6.9)', () => {
  const h = useHarness('squash');

  async function setup(): Promise<{
    r: TinyRepo;
    c: string[];
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
  }> {
    const r = await tinyRepo(h);
    const c = [
      r.commit('A', { 'a.txt': 'a\n' }),
      r.commit('B', { 'b.txt': 'b\n' }),
      r.commit('C', { 'c.txt': 'c\n' }),
      r.commit('D', { 'd.txt': 'd\n' }),
    ];
    const journal = new UndoJournal({ service: r.svc });
    return { r, c, journal, run: (op) => h.run(r.svc, op, { journal }) };
  }

  const log = (r: TinyRepo): string[] => r.g('log', '--format=%s', 'HEAD').trim().split(/\r?\n/);

  it('fast path: squashes a range ending at HEAD, keeps the oldest author date, undo + redo', async () => {
    const { r, c, journal, run } = await setup();
    const before = r.rev('HEAD');
    const oldDate = r.g('log', '-1', '--format=%ad', c[2]!).trim();
    h.write(path.join(r.dir, 'README.md'), 'local edit\n'); // unstaged local change survives
    const res = (await run({ type: 'squash.run', shas: [c[3]!, c[2]!], message: 'C+D squashed' })) as {
      data: { path: string; sha: string };
    };
    expect(res.data.path).toBe('fast');
    expect(log(r)).toEqual(['C+D squashed', 'B', 'A', 'Base']);
    expect(r.g('log', '-1', '--format=%ad').trim()).toBe(oldDate);
    expect(r.file('c.txt')).toBe('c\n');
    expect(r.file('d.txt')).toBe('d\n');
    expect(r.file('README.md')).toBe('local edit\n');
    expect(journal.peek().undo).toMatchObject({ kind: 'squash', label: 'Squash 2 commits' });

    const squashed = r.rev('HEAD');
    await journal.undo();
    expect(r.rev('HEAD')).toBe(before);
    expect(r.file('README.md')).toBe('local edit\n');
    await journal.redo();
    expect(r.rev('HEAD')).toBe(squashed);
  });

  it('general path: squashes commits below HEAD with an interactive rebase and replays the rest', async () => {
    const { r, c, journal, run } = await setup();
    const before = r.rev('HEAD');
    const res = (await run({ type: 'squash.run', shas: [c[0]!, c[1]!, c[2]!], message: 'A..C' })) as {
      data: { path: string; sha: string };
    };
    expect(res.data.path).toBe('rebase');
    expect(log(r)).toEqual(['D', 'A..C', 'Base']);
    expect(res.data.sha).toBe(r.rev('HEAD~1'));
    expect(r.g('status', '--porcelain').trim()).toBe('');
    expect(journal.peek().undo?.kind).toBe('squash');
    await journal.undo();
    expect(r.rev('HEAD')).toBe(before);
    expect(log(r)).toEqual(['D', 'C', 'B', 'A', 'Base']);
  });

  it('uses the rebase path when staged changes exist at HEAD', async () => {
    const { r, c, run } = await setup();
    h.write(path.join(r.dir, 'staged.txt'), 's\n');
    r.g('add', 'staged.txt');
    await run({ type: 'squash.run', shas: [c[2]!, c[3]!], message: 'CD' });
    expect(log(r)).toEqual(['CD', 'B', 'A', 'Base']);
    // the staged change was autostashed and restored, not folded into the squash commit
    expect(r.g('show', '--name-only', '--format=', 'HEAD').trim().split(/\r?\n/).sort()).toEqual([
      'c.txt',
      'd.txt',
    ]);
    expect(r.g('status', '--porcelain').trim()).toBe('A  staged.txt');
  });

  it('rejects non-contiguous selections, merges, the root commit and single commits', async () => {
    const { r, c } = await setup();
    const fail = (shas: string[]) => h.fail(r.svc, { type: 'squash.run', shas, message: 'x' });
    expect((await fail([c[0]!, c[2]!])).message).toMatch(/contiguous/);
    expect((await fail([c[3]!])).message).toMatch(/at least two/);
    expect((await fail([r.rev('HEAD~4'), c[0]!])).message).toMatch(/root commit/);
    expect((await h.fail(r.svc, { type: 'squash.run', shas: [c[2]!, c[3]!], message: ' ' })).code).toBe(
      'EmptyCommitMessage',
    );
    // a commit that is not on HEAD's line
    r.g('switch', '-q', '-c', 'side', c[1]!);
    const s1 = r.commit('S1', { 's.txt': '1\n' });
    const s2 = r.commit('S2', { 's.txt': '2\n' });
    r.g('switch', '-q', 'main');
    expect((await fail([s1, s2])).message).toMatch(/first-parent|current branch/);
    // merges in the range
    r.g('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const m = r.rev('HEAD');
    const after = r.commit('After', { 'e.txt': 'e\n' });
    expect((await fail([m, after])).message).toMatch(/Merge/);
    expect(fs.existsSync(path.join(r.dir, '.git', 'index.lock'))).toBe(false);
  });
});
