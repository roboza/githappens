import path from 'node:path';

import { expect, it } from 'vitest';

import { renamedStashSubject } from '../src/ops/executors';
import type { GitOperation } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, gitAtLeast, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describeGit('stash extras (spec 05 §4.9, §6.10)', () => {
  const h = useHarness('stashx');

  async function setup(): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
    list: () => { sha: string; subject: string }[];
  }> {
    const r = await tinyRepo(h, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const journal = new UndoJournal({ service: r.svc });
    const list = () =>
      r
        .g('stash', 'list', '--format=%H %gs')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => ({ sha: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1) }));
    return { r, journal, run: (op) => h.run(r.svc, op, { journal }), list };
  }

  const stash = (r: TinyRepo, file: string, content: string, msg: string): void => {
    h.write(path.join(r.dir, file), content);
    r.g('stash', 'push', '-q', '-m', msg);
  };

  it('keeps the branch prefix when renaming', () => {
    expect(renamedStashSubject('On main: old', 'new')).toBe('On main: new');
    expect(renamedStashSubject('WIP on feature/x: abc123 msg', 'n')).toBe('On feature/x: n');
    expect(renamedStashSubject('custom', 'n\nline')).toBe('n line');
  });

  it('renames a stash in place, preserving the order; undo restores the old message', async () => {
    const { r, journal, run, list } = await setup();
    stash(r, 'a.txt', 'a1\n', 'first');
    stash(r, 'a.txt', 'a2\n', 'second');
    stash(r, 'a.txt', 'a3\n', 'third');
    const before = list();
    await run({ type: 'stash.rename', index: 1, sha: before[1]!.sha, message: 'renamed' });
    const after = list();
    expect(after.map((e) => e.sha)).toEqual(before.map((e) => e.sha));
    expect(after.map((e) => e.subject)).toEqual(['On main: third', 'On main: renamed', 'On main: first']);
    expect(journal.peek().undo?.kind).toBe('stash-rename');
    await journal.undo();
    expect(list()).toEqual(before);
  });

  it('refuses a stale stash ref', async () => {
    const { r } = await setup();
    stash(r, 'a.txt', 'x\n', 'm');
    const err = await h.fail(r.svc, { type: 'stash.rename', index: 0, sha: 'f'.repeat(40), message: 'y' });
    expect(err.message).toMatch(/no longer exists/);
  });

  it('applies a single tracked file and a single untracked file from a stash', async () => {
    const { r, journal, run, list } = await setup();
    h.write(path.join(r.dir, 'a.txt'), 'stashed a\n');
    h.write(path.join(r.dir, 'b.txt'), 'stashed b\n');
    h.write(path.join(r.dir, 'new.txt'), 'untracked\n');
    r.g('stash', 'push', '-q', '-u', '-m', 'both');
    const s = list()[0]!;
    await run({ type: 'stash.applyFile', index: 0, sha: s.sha, path: 'a.txt' });
    expect(r.file('a.txt')).toBe('stashed a\n');
    expect(r.file('b.txt')).toBe('b\n');
    expect(r.g('status', '--porcelain').trim()).toBe('M a.txt');
    expect(journal.peek().undo?.kind).toBe('stash-apply');
    await run({ type: 'stash.applyFile', index: 0, sha: s.sha, path: 'new.txt' });
    expect(r.file('new.txt')).toBe('untracked\n');
    expect(list()).toHaveLength(1); // the stash is kept
    await journal.undo();
    expect(r.file('new.txt')).toBeNull();
    const err = await h.fail(r.svc, { type: 'stash.applyFile', index: 0, sha: s.sha, path: 'nope.txt' });
    expect(err.message).toMatch(/not part of/);
  });

  it('creates a branch from a stash (stash branch) and undo removes it again', async () => {
    const { r, journal, run, list } = await setup();
    stash(r, 'a.txt', 'branch me\n', 'wip');
    r.commit('Later', { 'a.txt': 'conflicting\n' });
    const s = list()[0]!;
    const head = r.rev('HEAD');
    await run({ type: 'stash.branch', index: 0, sha: s.sha, name: 'from-stash' });
    expect(r.g('branch', '--show-current').trim()).toBe('from-stash');
    expect(r.file('a.txt')).toBe('branch me\n');
    expect(list()).toHaveLength(0);
    expect(journal.peek().undo?.kind).toBe('branch-create');
    await journal.undo();
    expect(r.g('branch', '--show-current').trim()).toBe('main');
    expect(r.rev('HEAD')).toBe(head);
    expect(list().map((e) => e.sha)).toEqual([s.sha]);
    expect(r.g('branch', '--list', 'from-stash').trim()).toBe('');
    const bad = await h.fail(r.svc, { type: 'stash.branch', index: 0, sha: s.sha, name: 'bad..name' });
    expect(bad.code).toBe('InvalidRefName');
  });

  it.runIf(gitAtLeast(2, 35))('stashes only the staged changes (--staged)', async () => {
    const { r, run, list } = await setup();
    h.write(path.join(r.dir, 'a.txt'), 'staged\n');
    r.g('add', 'a.txt');
    h.write(path.join(r.dir, 'b.txt'), 'unstaged\n');
    await run({ type: 'stash.push', message: 'only staged', stagedOnly: true, includeUntracked: true });
    expect(list()[0]!.subject).toBe('On main: only staged');
    expect(r.file('a.txt')).toBe('a\n');
    expect(r.file('b.txt')).toBe('unstaged\n');
    expect(r.g('stash', 'show', '--name-only', 'stash@{0}').trim()).toBe('a.txt');
  });
});
