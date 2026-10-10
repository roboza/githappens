import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { GitError } from '../src/errors/classify';
import { createOpRegistry, reflogFallback } from '../src/ops/executors';
import { OperationQueue } from '../src/ops/queue';
import type { GitOperation } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describeGit('undo journal extras (spec 05 §4.7, §6.11, §11)', () => {
  const h = useHarness('undox');

  async function repo(): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
  }> {
    const r = await tinyRepo(h, { 'f.txt': 'base\n' });
    const journal = new UndoJournal({ service: r.svc });
    return { r, journal, run: (op) => h.run(r.svc, op, { journal }) };
  }

  const lockFile = (r: TinyRepo): string => path.join(r.dir, '.git', 'index.lock');

  it('lists entries newest first', async () => {
    const { r, journal, run } = await repo();
    await run({ type: 'branch.create', name: 'a', startPoint: 'HEAD', checkout: false });
    await run({ type: 'tag.create', name: 't1', target: r.rev('HEAD') });
    expect(journal.list(20).map((e) => e.kind)).toEqual(['tag-create', 'branch-create']);
    expect(journal.list(1)).toHaveLength(1);
  });

  it('offers the reflog when the journal is empty and restores it with reflog.restore (undoable)', async () => {
    const { r, journal, run } = await repo();
    const first = r.rev('HEAD');
    r.commit('Outside the app', { 'g.txt': 'g\n' });
    const second = r.rev('HEAD');
    expect(journal.peek().undo).toBeUndefined();
    const fb = await reflogFallback(r.svc);
    expect(fb).toMatchObject({ selector: 'main@{1}', sha: first, current: second });
    expect(fb!.subject).toMatch(/commit: Outside the app/);
    h.write(path.join(r.dir, 'f.txt'), 'local\n'); // unrelated local change is kept (reset --keep)
    await run({ type: 'reflog.restore', target: fb!.sha, selector: fb!.selector });
    expect(r.rev('HEAD')).toBe(first);
    expect(r.file('f.txt')).toBe('local\n');
    expect(journal.peek().undo).toMatchObject({ kind: 'reset', label: 'Restore main@{1}' });
    await journal.undo();
    expect(r.rev('HEAD')).toBe(second);
  });

  it('has no reflog fallback for a fresh single-commit repo', async () => {
    const { r } = await repo();
    r.g('reflog', 'expire', '--expire=now', '--all');
    expect(await reflogFallback(r.svc)).toBeNull();
  });

  it('undoes and redoes a remote removal, including its tracking refs and branch upstreams', async () => {
    const { r, journal, run } = await repo();
    const bare = path.join(path.dirname(r.dir), `bare-${path.basename(r.dir)}`);
    h.git(path.dirname(r.dir), 'init', '-q', '--bare', bare);
    r.g('remote', 'add', 'origin', bare);
    r.g('config', 'remote.origin.pushurl', bare);
    r.g('push', '-q', '-u', 'origin', 'main');
    const tracking = r.rev('origin/main');
    await run({ type: 'remote.remove', name: 'origin' });
    expect(r.g('remote').trim()).toBe('');
    expect(journal.peek().undo).toMatchObject({ kind: 'remote-remove', label: 'Remove remote origin' });

    await journal.undo();
    expect(r.g('remote').trim()).toBe('origin');
    expect(r.g('config', 'remote.origin.pushurl').trim()).toBe(bare);
    expect(r.rev('refs/remotes/origin/main')).toBe(tracking);
    expect(r.g('rev-parse', '--abbrev-ref', 'main@{upstream}').trim()).toBe('origin/main');

    await journal.redo();
    expect(r.g('remote').trim()).toBe('');
    expect(r.g('for-each-ref', 'refs/remotes/origin').trim()).toBe('');
    expect(r.g('config', '--local', '--list')).not.toMatch(/branch[.]main[.]remote/);
  });

  it('undoes mark-resolved by re-creating the conflict stages; becomes a barrier once the merge is done', async () => {
    const { r, journal, run } = await repo();
    r.g('switch', '-q', '-c', 'side');
    r.commit('Side', { 'f.txt': 'side\n' });
    r.g('switch', '-q', 'main');
    r.commit('Main', { 'f.txt': 'main\n' });
    expect(() => r.g('merge', '-q', 'side')).toThrow();
    h.write(path.join(r.dir, 'f.txt'), 'resolved\n');
    await run({ type: 'conflict.markResolved', paths: ['f.txt'] });
    expect(r.g('ls-files', '-u').trim()).toBe('');
    expect(journal.peek().undo).toMatchObject({ kind: 'mark-resolved', label: 'Mark f.txt resolved' });

    await journal.undo();
    expect(r.g('ls-files', '-u').trim().split(/\r?\n/)).toHaveLength(3);
    expect(r.file('f.txt')).toBe('resolved\n'); // worktree untouched
    await journal.redo();
    expect(r.g('ls-files', '-u').trim()).toBe('');

    await run({ type: 'merge.continue' });
    await expect(journal.undo()).rejects.toThrow(/has finished/);
  });

  it('never leaves index.lock behind after cancelled or failed ops', async () => {
    const { r, journal } = await repo();
    const c = [r.commit('A', { 'f.txt': 'a\n' }), r.commit('B', { 'f.txt': 'b\n' })];
    const q = new OperationQueue(r.svc, createOpRegistry(), { journal });
    // a slow-ish op first, then two queued ops cancelled before they start
    const first = q.enqueue({ type: 'stash.push', message: 'nothing to stash' });
    const second = q.enqueue({ type: 'squash.run', shas: c, message: 'AB' });
    const third = q.enqueue({ type: 'reset.branch', branch: 'nope', target: 'HEAD', mode: 'soft' });
    const settled = Promise.allSettled([second.done, third.done]);
    q.cancel(second.opId);
    q.cancel(third.opId);
    await first.done.catch(() => undefined);
    const outcomes = await settled;
    for (const o of outcomes) {
      expect(o.status).toBe('rejected');
      expect((o as PromiseRejectedResult).reason).toBeInstanceOf(GitError);
    }
    expect(r.g('log', '--format=%s', '-2').trim().split(/\r?\n/)).toEqual(['B', 'A']);
    expect(fs.existsSync(lockFile(r))).toBe(false);

    // a squash through the rebase path, then an op git refuses half-way (reset --keep over local changes)
    r.g('switch', '-q', '-c', 'x', 'HEAD~2');
    const x1 = r.commit('X1', { 'f.txt': 'x1\n' });
    const x2 = r.commit('X2', { 'g.txt': 'x2\n' });
    r.commit('X3', { 'f.txt': 'x3\n' });
    await h.run(r.svc, { type: 'squash.run', shas: [x1, x2], message: 'X12' }, { journal });
    expect(fs.existsSync(lockFile(r))).toBe(false);
    h.write(path.join(r.dir, 'f.txt'), 'dirty\n');
    const err = await h.fail(
      r.svc,
      { type: 'reflog.restore', target: 'HEAD~1', selector: 'x@{1}' },
      { journal },
    );
    expect(err.code).toBeTruthy();
    expect(r.file('f.txt')).toBe('dirty\n');
    expect(fs.existsSync(lockFile(r))).toBe(false);
    expect(journal.list().every((e) => e.status !== 'pending')).toBe(true);
  });
});
