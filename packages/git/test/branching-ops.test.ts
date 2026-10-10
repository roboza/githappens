import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { detachedOrphans, refRelation, squashMessage } from '../src/ops/executors';
import type { GitOperation } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describeGit('branching & operations (spec 05, Phase 8)', () => {
  const h = useHarness('branching');

  async function repo(): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<{ data?: unknown }>;
  }> {
    const r = await tinyRepo(h);
    const journal = new UndoJournal({ service: r.svc });
    return { r, journal, run: (op) => h.run(r.svc, op, { journal }) };
  }

  const subjects = (r: TinyRepo, rev = 'HEAD'): string[] =>
    r.g('log', '--format=%s', rev).trim().split(/\r?\n/);

  // ---- merge modes (spec 05 §6.5) ----

  it('merges in every mode: default (ff), no-ff, ff-only refusal, squash with SQUASH_MSG', async () => {
    const { r, run } = await repo();
    r.g('switch', '-q', '-c', 'feat');
    const f1 = r.commit('F1', { 'f.txt': '1\n' });
    r.g('switch', '-q', 'main');
    await run({ type: 'merge.run', source: 'feat', mode: 'default' });
    expect(r.rev('HEAD')).toBe(f1); // fast-forward

    r.g('reset', '-q', '--hard', 'HEAD~1');
    await run({ type: 'merge.run', source: 'feat', mode: 'no-ff' });
    expect(r.g('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);

    r.g('reset', '-q', '--hard', 'HEAD~1');
    r.commit('M1', { 'm.txt': 'm\n' });
    const err = await h.fail(r.svc, { type: 'merge.run', source: 'feat', mode: 'ff-only' });
    expect(err.code).not.toBe('MergeConflict');

    const head = r.rev('HEAD');
    await run({ type: 'merge.run', source: 'feat', mode: 'squash' });
    expect(r.rev('HEAD')).toBe(head);
    expect(r.g('status', '--porcelain').trim()).toBe('A  f.txt');
    expect(await squashMessage(r.svc)).toMatch(/F1/);
  });

  // ---- range / pivot rebase (spec 05 §6.7) ----

  it('rebases a range of commits onto another branch (rebase --onto, pivot)', async () => {
    const { r, journal, run } = await repo();
    r.g('branch', 'target');
    r.commit('A', { 'a.txt': 'a\n' });
    const b = r.commit('B', { 'b.txt': 'b\n' });
    r.commit('C', { 'c.txt': 'c\n' });
    r.g('switch', '-q', 'target');
    r.commit('T', { 't.txt': 't\n' });
    r.g('switch', '-q', 'main');
    const before = r.rev('main');
    // "Rebase 2 commits (B..C) onto target": upstream = B^
    await run({ type: 'rebase.run', onto: 'target', upstream: `${b}^`, branch: 'main' });
    expect(subjects(r)).toEqual(['C', 'B', 'T', 'Base']);
    expect(journal.peek().undo?.kind).toBe('rebase');
    await journal.undo();
    expect(r.rev('main')).toBe(before);
  });

  // ---- cherry-pick / revert order, mainline (spec 05 §6.9) ----

  it('cherry-picks several commits in topological order and reverts newest first', async () => {
    const { r, journal, run } = await repo();
    r.g('switch', '-q', '-c', 'src');
    const x = r.commit('X', { 'x.txt': '1\n' });
    const y = r.commit('Y', { 'x.txt': '2\n' });
    const z = r.commit('Z', { 'x.txt': '3\n' });
    r.g('switch', '-q', 'main');
    await run({ type: 'cherryPick.run', shas: [z, x, y] });
    expect(subjects(r).slice(0, 3)).toEqual(['Z', 'Y', 'X']);
    expect(r.file('x.txt')).toBe('3\n');
    expect(journal.peek().undo).toMatchObject({ kind: 'cherry-pick', label: 'Cherry-pick 3 commits' });

    const picked = r.g('log', '--format=%H', '-3').trim().split(/\r?\n/); // newest first
    await run({ type: 'revert.run', shas: [picked[2]!, picked[0]!, picked[1]!] });
    expect(subjects(r).slice(0, 3)).toEqual(['Revert "X"', 'Revert "Y"', 'Revert "Z"']);
    expect(r.file('x.txt')).toBeNull();
  });

  it('cherry-picks a merge commit with a mainline parent', async () => {
    const { r, run } = await repo();
    r.g('switch', '-q', '-c', 'side');
    r.commit('S', { 's.txt': 's\n' });
    r.g('switch', '-q', '-c', 'integ', 'main');
    r.commit('I', { 'i.txt': 'i\n' });
    r.g('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const merge = r.rev('HEAD');
    r.g('switch', '-q', 'main');
    const noMain = await h.fail(r.svc, { type: 'cherryPick.run', shas: [merge] });
    expect(noMain.message).toBeTruthy();
    expect(r.svc.repo.state).toBe('clean');
    await run({ type: 'cherryPick.run', shas: [merge], mainline: 1 });
    expect(r.file('s.txt')).toBe('s\n');
    expect(r.file('i.txt')).toBeNull();
  });

  // ---- non-HEAD branch reset (spec 05 §6.9) ----

  it('resets a branch that is not checked out with update-ref; undo moves it back', async () => {
    const { r, journal, run } = await repo();
    const base = r.rev('HEAD');
    r.commit('A', { 'a.txt': 'a\n' });
    r.g('branch', 'other');
    const head = r.rev('HEAD');
    await run({ type: 'reset.branch', branch: 'other', target: base, mode: 'soft' });
    expect(r.rev('other')).toBe(base);
    expect(r.rev('HEAD')).toBe(head);
    expect(journal.peek().undo).toMatchObject({ kind: 'reset', label: `Reset other to ${base.slice(0, 7)}` });
    await journal.undo();
    expect(r.rev('other')).toBe(head);
    const cur = await h.fail(r.svc, { type: 'reset.branch', branch: 'main', target: base, mode: 'mixed' });
    expect(cur.message).toMatch(/checked out/);
    const hard = await h.fail(r.svc, {
      type: 'reset.branch',
      branch: 'other',
      target: base,
      mode: 'hard' as 'soft',
    });
    expect(hard.message).toMatch(/soft or mixed/);
  });

  // ---- remote branches: checkout conflict choices + rename against a bare remote ----

  async function withRemote(): Promise<{
    r: TinyRepo;
    bare: string;
    run: (op: GitOperation) => Promise<unknown>;
    journal: UndoJournal;
  }> {
    const { r, journal, run } = await repo();
    const bare = path.join(path.dirname(r.dir), `bare-${path.basename(r.dir)}`);
    h.git(path.dirname(r.dir), 'init', '-q', '--bare', bare);
    r.g('remote', 'add', 'origin', bare);
    r.g('push', '-q', '-u', 'origin', 'main');
    r.g('switch', '-q', '-c', 'feat');
    r.commit('F1', { 'f.txt': '1\n' });
    r.g('push', '-q', '-u', 'origin', 'feat');
    r.g('switch', '-q', 'main');
    return { r, bare, run, journal };
  }

  it('checkout of a remote branch whose local exists: ff when behind, reset to remote, new name', async () => {
    const { r, run, journal } = await withRemote();
    // local feat behind origin/feat
    r.g('switch', '-q', 'feat');
    const old = r.rev('feat');
    r.commit('F2', { 'f.txt': '2\n' });
    r.g('push', '-q', 'origin', 'feat');
    r.g('reset', '-q', '--hard', old);
    r.g('switch', '-q', 'main');
    const res = (await run({
      type: 'checkout.run',
      target: { kind: 'remoteBranch', remote: 'origin', name: 'feat', onExisting: 'ff' },
      dirtyStrategy: 'carry',
    })) as { data: { fastForwarded?: boolean } };
    expect(res.data.fastForwarded).toBe(true);
    expect(r.rev('feat')).toBe(r.rev('origin/feat'));
    await journal.undo();
    expect(r.g('branch', '--show-current').trim()).toBe('main');
    expect(r.rev('feat')).toBe(old);

    // diverged: reset local to remote
    r.g('switch', '-q', 'feat');
    r.commit('Local only', { 'l.txt': 'l\n' });
    const diverged = r.rev('feat');
    r.g('switch', '-q', 'main');
    await run({
      type: 'checkout.run',
      target: { kind: 'remoteBranch', remote: 'origin', name: 'feat', onExisting: 'reset' },
      dirtyStrategy: 'carry',
    });
    expect(r.g('branch', '--show-current').trim()).toBe('feat');
    expect(r.rev('feat')).toBe(r.rev('origin/feat'));
    expect(r.file('l.txt')).toBeNull();
    await journal.undo();
    expect(r.rev('feat')).toBe(diverged);
    expect(r.g('branch', '--show-current').trim()).toBe('main');

    // create a new local name tracking the remote branch
    await run({
      type: 'checkout.run',
      target: { kind: 'remoteBranch', remote: 'origin', name: 'feat', localName: 'feat-1' },
      dirtyStrategy: 'carry',
    });
    expect(r.g('branch', '--show-current').trim()).toBe('feat-1');
    expect(r.g('rev-parse', '--abbrev-ref', 'feat-1@{upstream}').trim()).toBe('origin/feat');
    expect(r.rev('feat')).toBe(diverged);
  });

  it('renames a branch on the remote and relinks the local upstream', async () => {
    const { r, bare } = await withRemote();
    const sha = r.rev('origin/feat');
    await h.run(r.svc, {
      type: 'branch.renameRemote',
      remote: 'origin',
      from: 'feat',
      to: 'feature/renamed',
    });
    expect(h.git(bare, 'rev-parse', 'refs/heads/feature/renamed').trim()).toBe(sha);
    expect(h.git(bare, 'for-each-ref', 'refs/heads/feat').trim()).toBe('');
    expect(r.g('rev-parse', '--abbrev-ref', 'feat@{upstream}').trim()).toBe('origin/feature/renamed');
    const err = await h.fail(r.svc, { type: 'branch.renameRemote', remote: 'origin', from: 'nope', to: 'x' });
    expect(err.message).toMatch(/does not exist/);
  });

  // ---- read helpers ----

  it('reports merge-base / shallow relation and detached orphan commits', async () => {
    const { r } = await repo();
    r.g('switch', '-q', '--orphan', 'island');
    r.commit('Island', { 'i.txt': 'i\n' });
    r.g('switch', '-q', 'main');
    expect(await refRelation(r.svc, 'main', 'island')).toEqual({ mergeBase: false, shallow: false });
    r.g('branch', 'twin');
    expect((await refRelation(r.svc, 'main', 'twin')).mergeBase).toBe(true);

    expect((await detachedOrphans(r.svc)).count).toBe(0);
    r.g('switch', '-q', '--detach', 'HEAD');
    r.commit('Lost 1', { 'x.txt': '1\n' });
    r.commit('Lost 2', { 'x.txt': '2\n' });
    expect((await detachedOrphans(r.svc)).count).toBe(2);
    expect(fs.existsSync(path.join(r.dir, '.git', 'index.lock'))).toBe(false);
  });
});
