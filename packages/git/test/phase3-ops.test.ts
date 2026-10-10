import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildTodo, createOpRegistry } from '../src/ops/executors';
import type { TodoItem } from '../src/types';
import { conflictState, rebaseTodoFor } from '../src/service/phase3';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

const subjects = (r: TinyRepo, range: string): string[] =>
  r.g('log', '--format=%s', '--reverse', range).trim().split('\n').filter(Boolean);
const parents = (r: TinyRepo, rev: string): number =>
  r.g('rev-list', '--parents', '-n', '1', rev).trim().split(' ').length - 1;

describe('buildTodo', () => {
  const item = (
    sha: string,
    action: TodoItem['action'],
    extra: Partial<TodoItem> = {},
  ): TodoItem & { sha: string } => ({
    sha,
    action,
    summary: `subject ${sha}`,
    ...extra,
  });
  it('turns reword/squash/fixup into pick/fixup + exec amend lines', () => {
    const files: string[] = [];
    const todo = buildTodo(
      [
        item('a', 'pick'),
        item('b', 'squash'),
        item('c', 'fixup'),
        item('d', 'drop'),
        item('e', 'reword', { newMessage: 'E2' }),
        item('f', 'pick'),
        item('g', 'fixup'),
      ],
      new Map([
        ['a', 'A msg\n'],
        ['b', 'B msg\n'],
      ]),
      new Map(),
      (t) => {
        files.push(t);
        return `/tmp/m${files.length}`;
      },
    );
    expect(todo.split('\n').filter(Boolean)).toEqual([
      'pick a subject a',
      'fixup b subject b',
      'fixup c subject c',
      'drop d subject d',
      "exec git commit --amend --allow-empty --no-verify -F '/tmp/m1'",
      'pick e subject e',
      "exec git commit --amend --allow-empty --no-verify -F '/tmp/m2'",
      'pick f subject f',
      'fixup g subject g',
    ]);
    expect(files).toEqual(['A msg\n\nB msg', 'E2']);
  });
  it('rejects a squash without a predecessor', () => {
    expect(() =>
      buildTodo([item('a', 'drop'), item('b', 'squash')], new Map(), new Map(), () => 'x'),
    ).toThrow(/no earlier commit/);
  });
});

describe('Phase 3 registry metadata', () => {
  const reg = createOpRegistry() as Record<
    string,
    { meta: { undoable: boolean; cancellable: boolean; network: boolean; touches: string[] } }
  >;
  const PHASE3 = [
    'merge.run',
    'merge.continue',
    'merge.abort',
    'rebase.run',
    'rebase.interactive',
    'rebase.continue',
    'rebase.skip',
    'rebase.abort',
    'cherryPick.run',
    'revert.run',
    'sequencer.continue',
    'sequencer.skip',
    'sequencer.abort',
    'reset.run',
    'ff.run',
    'conflict.saveFile',
    'conflict.take',
    'conflict.resolveSpecial',
    'conflict.markResolved',
    'conflict.markUnresolved',
    'file.write',
  ];
  const UNDOABLE = [
    'merge.run',
    'rebase.run',
    'rebase.interactive',
    'cherryPick.run',
    'revert.run',
    'reset.run',
    'ff.run',
    // Phase 8: journaled as 'mark-resolved' (spec 05 §11)
    'conflict.markResolved',
  ];
  it('registers every Phase 3 variant with undo/cancel/network metadata', () => {
    for (const t of PHASE3) {
      const m = reg[t]?.meta;
      expect(m, t).toBeDefined();
      expect(m!.undoable, t).toBe(UNDOABLE.includes(t));
      expect(m!.cancellable, t).toBe(false);
      expect(m!.network, t).toBe(false);
      expect(m!.touches, t).toContain('status');
    }
    for (const t of PHASE3.filter(
      (x) => x.startsWith('merge') || x.startsWith('rebase') || x.startsWith('sequencer'),
    )) {
      expect(reg[t]!.meta.touches, t).toEqual(
        expect.arrayContaining(['repoState', 'conflicts', 'refs', 'graph']),
      );
    }
  });
});

describeGit('Phase 3 executors: merge / rebase / cherry-pick / revert / reset / ff', () => {
  const h = useHarness('p3ops');

  /** main: Base → M1 (main.txt); side (from Base): S1 (side.txt). */
  async function diverged(): Promise<TinyRepo> {
    const r = await tinyRepo(h);
    r.g('branch', 'side');
    r.commit('M1', { 'main.txt': 'm\n' });
    r.g('switch', '-q', 'side');
    r.commit('S1', { 'side.txt': 's\n' });
    r.g('switch', '-q', 'main');
    return r;
  }

  describe('merge.run', () => {
    it('default mode fast-forwards when possible', async () => {
      const r = await tinyRepo(h);
      r.g('switch', '-q', '-c', 'ahead');
      const tip = r.commit('A1', { 'a.txt': 'a\n' });
      r.g('switch', '-q', 'main');
      const res = await h.run(r.svc, { type: 'merge.run', source: 'ahead', mode: 'default' });
      expect(res.data).toMatchObject({ result: 'fast-forward', head: tip });
      expect(r.rev('main')).toBe(tip);
    });

    it('no-ff creates a merge commit with the given message', async () => {
      const r = await diverged();
      const res = await h.run(r.svc, {
        type: 'merge.run',
        source: 'side',
        mode: 'no-ff',
        message: 'Merge side in',
      });
      expect(res.data).toMatchObject({ result: 'merge' });
      expect(parents(r, 'HEAD')).toBe(2);
      expect(r.g('log', '-1', '--format=%s').trim()).toBe('Merge side in');
      expect(r.file('side.txt')).toBe('s\n');
    });

    it('ff-only fails with NotFastForwardable when diverged', async () => {
      const r = await diverged();
      const before = r.rev('HEAD');
      const err = await h.fail(r.svc, { type: 'merge.run', source: 'side', mode: 'ff-only' });
      expect(err.code).toBe('NotFastForwardable');
      expect(r.rev('HEAD')).toBe(before);
    });

    it('squash stages the result with SQUASH_MSG; merge.continue commits it', async () => {
      const r = await diverged();
      const before = r.rev('HEAD');
      const res = await h.run(r.svc, { type: 'merge.run', source: 'side', mode: 'squash' });
      expect(res.data).toMatchObject({ result: 'squash' });
      expect(r.rev('HEAD')).toBe(before);
      expect(r.g('diff', '--cached', '--name-only').trim()).toBe('side.txt');
      expect(fs.existsSync(path.join(r.dir, '.git', 'SQUASH_MSG'))).toBe(true);
      const st = await conflictState(r.svc);
      expect(st.op).toBe('merge');
      expect(st.incoming.label).toBe('Squashed changes');
      await h.run(r.svc, { type: 'merge.continue', message: 'Squashed side' });
      expect(parents(r, 'HEAD')).toBe(1);
      expect(r.g('log', '-1', '--format=%s').trim()).toBe('Squashed side');
      expect((await conflictState(r.svc)).op).toBeNull();
    });

    it('stops on conflicts with MergeConflict + details.files; resolve and continue', async () => {
      const fx = h.fixture('conflict');
      const svc = await h.open(fx.path);
      const err = await h.fail(svc, { type: 'merge.run', source: 'feature', mode: 'default' });
      expect(err.code).toBe('MergeConflict');
      expect(err.details?.files).toEqual(fx.facts.conflictedFiles);

      await h.run(svc, { type: 'conflict.take', paths: ['content.txt', 'binary.dat'], side: 'theirs' });
      await h.run(svc, { type: 'conflict.resolveSpecial', path: 'delete-modify.txt', action: 'delete' });
      await h.run(svc, {
        type: 'conflict.saveFile',
        path: 'add-add.txt',
        text: 'both\n',
        markResolved: true,
      });
      const res = await h.run(svc, { type: 'merge.continue' });
      expect(res.data).toMatchObject({ result: 'merge' });
      const g = (...a: string[]) => h.git(fx.path, ...a);
      expect(g('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
      const msg = g('log', '-1', '--format=%B');
      expect(msg).toMatch(/^Merge branch 'feature'/);
      expect(msg).not.toMatch(/#/);
      expect(h.read(path.join(fx.path, 'content.txt'))).toContain('changed on feature');
      expect(fs.existsSync(path.join(fx.path, 'delete-modify.txt'))).toBe(false);
      expect(g('status', '--porcelain').trim()).toBe('');
    });

    it('merge.continue refuses while files are still conflicted', async () => {
      const fx = h.fixture('conflict-in-progress');
      const svc = await h.open(fx.path);
      const err = await h.fail(svc, { type: 'merge.continue' });
      expect(err.code).toBe('MergeConflict');
      expect(err.details?.files).toEqual(fx.facts.conflictedFiles);
    });

    it('merge.abort restores the pre-merge state', async () => {
      const fx = h.fixture('conflict-in-progress');
      const svc = await h.open(fx.path);
      const head = h.git(fx.path, 'rev-parse', 'HEAD').trim();
      await h.run(svc, { type: 'merge.abort' });
      expect(svc.repo.state).toBe('clean');
      expect(h.git(fx.path, 'rev-parse', 'HEAD').trim()).toBe(head);
      expect(h.git(fx.path, 'status', '--porcelain').trim()).toBe('');
      expect((await h.fail(svc, { type: 'merge.abort' })).message).toMatch(/no merge in progress/);
    });

    it('refuses to start while another operation is in progress', async () => {
      const fx = h.fixture('conflict-in-progress');
      const svc = await h.open(fx.path);
      const err = await h.fail(svc, { type: 'merge.run', source: 'feature', mode: 'default' });
      expect(err.message).toMatch(/merge in progress/);
    });
  });

  describe('rebase.run', () => {
    it('rebases the current branch onto another', async () => {
      const r = await diverged();
      r.g('switch', '-q', 'side');
      const res = await h.run(r.svc, { type: 'rebase.run', onto: 'main' });
      expect(res.data).toMatchObject({ stopped: false });
      expect(r.rev('side~1')).toBe(r.rev('main'));
      expect(subjects(r, 'main..side')).toEqual(['S1']);
    });

    it('rebases a non-checked-out branch (and autostashes local changes)', async () => {
      const r = await diverged();
      h.write(path.join(r.dir, 'README.md'), 'dirty\n');
      await h.run(r.svc, { type: 'rebase.run', onto: 'main', branch: 'side' });
      expect(r.rev('side~1')).toBe(r.rev('main'));
      expect(r.svc.repo.head).toMatchObject({ kind: 'branch', name: 'side' });
      expect(r.file('README.md')).toBe('dirty\n');
    });

    it('range rebase with upstream (--onto)', async () => {
      const r = await diverged();
      r.g('switch', '-q', 'side');
      r.commit('S2', { 'side2.txt': 's2\n' });
      await h.run(r.svc, { type: 'rebase.run', onto: 'main', upstream: 'side~1' });
      expect(subjects(r, 'main..side')).toEqual(['S2']);
    });

    async function conflicted(): Promise<{
      dir: string;
      svc: Awaited<ReturnType<typeof h.open>>;
      files: string[];
    }> {
      const fx = h.fixture('conflict');
      h.git(fx.path, 'switch', '-q', 'feature');
      const svc = await h.open(fx.path);
      const err = await h.fail(svc, { type: 'rebase.run', onto: 'main' });
      expect(err.code).toBe('RebaseConflict');
      expect(err.details?.files).toEqual(fx.facts.conflictedFiles);
      return { dir: fx.path, svc, files: fx.facts.conflictedFiles as string[] };
    }

    it('stops with RebaseConflict; conflictState shows the swapped labels; continue finishes', async () => {
      const { dir, svc } = await conflicted();
      const st = await conflictState(svc);
      expect(st.op).toBe('rebase');
      expect(st.current.label).toBe('main');
      expect(st.incoming.sha).toBe(h.git(dir, 'rev-parse', 'feature').trim());
      expect(st.incoming.label).toMatch(/Feature changes$/);
      expect(st.rebase).toMatchObject({ step: 1, total: 1, ontoLabel: 'main' });
      expect(st.rebase?.currentCommit?.subject).toBe('Feature changes');

      await h.fail(svc, { type: 'rebase.continue' }).then((e) => expect(e.code).toBe('RebaseConflict'));
      await h.run(svc, {
        type: 'conflict.take',
        paths: ['content.txt', 'add-add.txt', 'binary.dat'],
        side: 'theirs',
      });
      await h.run(svc, { type: 'conflict.markResolved', paths: ['delete-modify.txt'] });
      const res = await h.run(svc, { type: 'rebase.continue', message: 'Feature, rebased' });
      expect(res.data).toMatchObject({ stopped: false });
      expect(svc.repo.state).toBe('clean');
      expect(svc.repo.head).toMatchObject({ kind: 'branch', name: 'feature' });
      expect(h.git(dir, 'log', '-1', '--format=%s').trim()).toBe('Feature, rebased');
      expect(h.git(dir, 'rev-parse', 'feature~1').trim()).toBe(h.git(dir, 'rev-parse', 'main').trim());
    });

    it('skip drops the conflicting commit', async () => {
      const { dir, svc } = await conflicted();
      await h.run(svc, { type: 'rebase.skip' });
      expect(svc.repo.state).toBe('clean');
      expect(h.git(dir, 'rev-parse', 'feature').trim()).toBe(h.git(dir, 'rev-parse', 'main').trim());
    });

    it('abort restores the branch', async () => {
      const fx = h.fixture('conflict');
      const before = h.git(fx.path, 'rev-parse', 'feature').trim();
      h.git(fx.path, 'switch', '-q', 'feature');
      const svc = await h.open(fx.path);
      await h.fail(svc, { type: 'rebase.run', onto: 'main' });
      await h.run(svc, { type: 'rebase.abort' });
      expect(svc.repo.state).toBe('clean');
      expect(h.git(fx.path, 'rev-parse', 'HEAD').trim()).toBe(before);
      expect(svc.repo.head).toMatchObject({ kind: 'branch', name: 'feature' });
    });
  });

  describe('rebase.interactive', () => {
    /** Base + C1..C4, each adding its own file. */
    async function series(): Promise<{ r: TinyRepo; base: string; c: string[] }> {
      const r = await tinyRepo(h);
      const base = r.rev('HEAD');
      const c = [1, 2, 3, 4].map((i) => r.commit(`C${i}`, { [`f${i}.txt`]: `${i}\n` }));
      return { r, base, c };
    }
    const todoOf = (
      c: string[],
      actions: TodoItem['action'][],
      extra: Record<number, Partial<TodoItem>> = {},
    ) => actions.map((action, i) => ({ sha: c[i]!, action, summary: `C${i + 1}`, ...extra[i] }));

    it('lists the todo oldest first and refuses ranges with merges', async () => {
      const { r, base, c } = await series();
      const todo = await rebaseTodoFor(r.svc, base);
      expect(todo.map((t) => t.sha)).toEqual(c);
      expect(todo.map((t) => t.summary)).toEqual(['C1', 'C2', 'C3', 'C4']);
      expect(todo.every((t) => t.action === 'pick')).toBe(true);

      const fx = h.fixture('branchy');
      const svc = await h.open(fx.path);
      const root = h.git(fx.path, 'rev-list', '--max-parents=0', 'HEAD').trim();
      await expect(rebaseTodoFor(svc, root)).rejects.toMatchObject({ code: 'Unknown' });
      const err = await h.fail(svc, {
        type: 'rebase.interactive',
        onto: root,
        upstream: root,
        todo: [],
      });
      expect(err.message).toMatch(/merge commits/);
    });

    it('reorders and drops', async () => {
      const { r, base, c } = await series();
      const todo = todoOf(c, ['pick', 'pick', 'drop', 'pick']);
      const reordered = [todo[1]!, todo[0]!, todo[2]!, todo[3]!];
      await h.run(r.svc, { type: 'rebase.interactive', onto: base, upstream: base, todo: reordered });
      expect(subjects(r, `${base}..HEAD`)).toEqual(['C2', 'C1', 'C4']);
      expect(r.file('f3.txt')).toBeNull();
      expect(r.svc.repo.state).toBe('clean');
      expect(fs.existsSync(path.join(r.dir, '.git', 'githappens', 'rebase-i'))).toBe(false);
    });

    it('rewords without an editor', async () => {
      const { r, base, c } = await series();
      const todo = todoOf(c, ['pick', 'reword', 'pick', 'pick'], {
        1: { newMessage: 'Second\n\nWith a body' },
      });
      await h.run(r.svc, { type: 'rebase.interactive', onto: base, upstream: base, todo });
      expect(subjects(r, `${base}..HEAD`)).toEqual(['C1', 'Second', 'C3', 'C4']);
      expect(r.g('log', '-1', '--format=%B', 'HEAD~2').trim()).toBe('Second\n\nWith a body');
      // author is kept
      expect(r.g('log', '-1', '--format=%an', 'HEAD~2').trim()).toBe(
        r.g('log', '-1', '--format=%an', c[1]!).trim(),
      );
    });

    it('squashes with the prepared message, with the combined default, and fixups keep the target message', async () => {
      {
        const { r, base, c } = await series();
        const todo = todoOf(c, ['pick', 'squash', 'pick', 'fixup']);
        await h.run(r.svc, {
          type: 'rebase.interactive',
          onto: base,
          upstream: base,
          todo,
          squashMessages: { [c[0]!]: 'One and two' },
        });
        expect(subjects(r, `${base}..HEAD`)).toEqual(['One and two', 'C3']);
        expect(r.g('show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort()).toEqual([
          'f1.txt',
          'f2.txt',
        ]);
        expect(r.g('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
          'f3.txt',
          'f4.txt',
        ]);
      }
      {
        const { r, base, c } = await series();
        await h.run(r.svc, {
          type: 'rebase.interactive',
          onto: base,
          upstream: base,
          todo: todoOf(c, ['pick', 'squash', 'squash', 'pick']),
        });
        expect(r.g('log', '-1', '--format=%B', 'HEAD~1').trim()).toBe('C1\n\nC2\n\nC3');
      }
    });

    it('rejects a stale todo list', async () => {
      const { r, base, c } = await series();
      const err = await h.fail(r.svc, {
        type: 'rebase.interactive',
        onto: base,
        upstream: base,
        todo: todoOf(c, ['pick', 'pick', 'pick']),
      });
      expect(err.message).toMatch(/out of date/);
    });

    it('stops at an edit step and continues', async () => {
      const { r, base, c } = await series();
      const res = await h.run(r.svc, {
        type: 'rebase.interactive',
        onto: base,
        upstream: base,
        todo: todoOf(c, ['pick', 'edit', 'pick', 'pick']),
      });
      expect(res.data).toMatchObject({ stopped: true });
      expect((await conflictState(r.svc)).op).toBe('rebase');
      await h.run(r.svc, { type: 'rebase.continue' });
      expect(r.svc.repo.state).toBe('clean');
      expect(subjects(r, `${base}..HEAD`)).toEqual(['C1', 'C2', 'C3', 'C4']);
    });
  });

  describe('cherry-pick / revert', () => {
    /** side: S1 (s1.txt), S2 (s2.txt), S3 (s3.txt); main: M1. */
    async function picks(): Promise<{ r: TinyRepo; s: string[] }> {
      const r = await diverged();
      r.g('switch', '-q', 'side');
      const s = [r.rev('HEAD'), r.commit('S2', { 's2.txt': '2\n' }), r.commit('S3', { 's3.txt': '3\n' })];
      r.g('switch', '-q', 'main');
      return { r, s };
    }

    it('cherry-picks a single commit', async () => {
      const { r, s } = await picks();
      const res = await h.run(r.svc, { type: 'cherryPick.run', shas: [s[1]!] });
      expect(res.data).toMatchObject({ applied: [s[1]] });
      expect(subjects(r, 'HEAD~1..HEAD')).toEqual(['S2']);
    });

    it('cherry-picks several commits in topological order whatever the selection order', async () => {
      const { r, s } = await picks();
      const res = await h.run(r.svc, { type: 'cherryPick.run', shas: [s[2]!, s[0]!, s[1]!] });
      expect(res.data).toMatchObject({ applied: s });
      expect(subjects(r, 'HEAD~3..HEAD')).toEqual(['S1', 'S2', 'S3']);
    });

    it('stops on a conflict; sequencer.continue applies the rest; sequencer.abort restores', async () => {
      const r = await tinyRepo(h, { 'x.txt': 'base\n' });
      r.g('switch', '-q', '-c', 'side');
      const p1 = r.commit('P1', { 'x.txt': 'side\n' });
      const p2 = r.commit('P2', { 'y.txt': 'y\n' });
      r.g('switch', '-q', 'main');
      const mainHead = r.commit('M', { 'x.txt': 'main\n' });

      const err = await h.fail(r.svc, { type: 'cherryPick.run', shas: [p2, p1] });
      expect(err.code).toBe('CherryPickConflict');
      expect(err.details?.files).toEqual(['x.txt']);
      const st = await conflictState(r.svc);
      expect(st.op).toBe('cherry-pick');
      expect(st.incoming).toMatchObject({ sha: p1, label: `${p1.slice(0, 7)} P1` });
      expect(st.current.label).toBe('main');
      expect(st.sequencer?.remaining).toEqual([p2]);
      expect(st.message).toMatch(/^P1/);

      await h.run(r.svc, { type: 'sequencer.abort' });
      expect(r.rev('HEAD')).toBe(mainHead);
      expect(r.svc.repo.state).toBe('clean');

      await h.fail(r.svc, { type: 'cherryPick.run', shas: [p1, p2] });
      await h.run(r.svc, { type: 'conflict.saveFile', path: 'x.txt', text: 'merged\n', markResolved: true });
      await h.run(r.svc, { type: 'sequencer.continue', message: 'P1 (merged)' });
      expect(subjects(r, `${mainHead}..HEAD`)).toEqual(['P1 (merged)', 'P2']);
      expect((await conflictState(r.svc)).op).toBeNull();
    });

    it('sequencer.skip skips the conflicting commit', async () => {
      const r = await tinyRepo(h, { 'x.txt': 'base\n' });
      r.g('switch', '-q', '-c', 'side');
      const p1 = r.commit('P1', { 'x.txt': 'side\n' });
      const p2 = r.commit('P2', { 'y.txt': 'y\n' });
      r.g('switch', '-q', 'main');
      const mainHead = r.commit('M', { 'x.txt': 'main\n' });
      await h.fail(r.svc, { type: 'cherryPick.run', shas: [p1, p2] });
      await h.run(r.svc, { type: 'sequencer.skip' });
      expect(subjects(r, `${mainHead}..HEAD`)).toEqual(['P2']);
    });

    it('reverts commits newest first, and merge commits with a mainline', async () => {
      const { r, s } = await picks();
      r.g('merge', '--no-ff', '-q', '-m', 'Merge side', 'side');
      const merge = r.rev('HEAD');
      const noMainline = await h.fail(r.svc, { type: 'revert.run', shas: [merge] });
      expect(noMainline.code).toBeDefined();
      await h.run(r.svc, { type: 'revert.run', shas: [merge], mainline: 1 });
      expect(r.file('s1.txt')).toBeNull();
      expect(r.file('s3.txt')).toBeNull();
      r.g('reset', '-q', '--hard', merge);
      const res = await h.run(r.svc, { type: 'revert.run', shas: [s[0]!, s[2]!] });
      expect(res.data).toMatchObject({ applied: [s[2], s[0]] });
      expect(subjects(r, 'HEAD~2..HEAD')).toEqual([`Revert "S3"`, `Revert "S1"`]);
    });

    it('a conflicting revert reports RevertConflict and conflictState op revert', async () => {
      const r = await tinyRepo(h, { 'x.txt': '1\n' });
      const a = r.commit('A', { 'x.txt': '2\n' });
      r.commit('B', { 'x.txt': '3\n' });
      const err = await h.fail(r.svc, { type: 'revert.run', shas: [a] });
      expect(err.code).toBe('RevertConflict');
      const st = await conflictState(r.svc);
      expect(st.op).toBe('revert');
      expect(st.incoming.label).toBe(`Revert of ${a.slice(0, 7)} A`);
      await h.run(r.svc, { type: 'sequencer.abort' });
      expect(r.svc.repo.state).toBe('clean');
    });
  });

  describe('reset.run', () => {
    async function three(): Promise<{ r: TinyRepo; c1: string }> {
      const r = await tinyRepo(h);
      const c1 = r.commit('C1', { 'a.txt': '1\n' });
      r.commit('C2', { 'a.txt': '2\n' });
      return { r, c1 };
    }
    it('soft keeps the changes staged', async () => {
      const { r, c1 } = await three();
      await h.run(r.svc, { type: 'reset.run', target: c1, mode: 'soft' });
      expect(r.rev('HEAD')).toBe(c1);
      expect(r.g('status', '--porcelain').trim()).toBe('M  a.txt');
    });
    it('mixed keeps the changes unstaged', async () => {
      const { r, c1 } = await three();
      await h.run(r.svc, { type: 'reset.run', target: c1, mode: 'mixed' });
      expect(r.g('status', '--porcelain').trim()).toBe('M a.txt');
    });
    it('hard discards them', async () => {
      const { r, c1 } = await three();
      await h.run(r.svc, { type: 'reset.run', target: c1, mode: 'hard' });
      expect(r.g('status', '--porcelain').trim()).toBe('');
      expect(r.file('a.txt')).toBe('1\n');
    });
  });

  describe('ff.run', () => {
    it('fast-forwards the current branch', async () => {
      const r = await tinyRepo(h);
      r.g('switch', '-q', '-c', 'ahead');
      const tip = r.commit('A', { 'a.txt': 'a\n' });
      r.g('switch', '-q', 'main');
      await h.run(r.svc, { type: 'ff.run', branch: 'main', to: 'ahead' });
      expect(r.rev('main')).toBe(tip);
      expect(r.file('a.txt')).toBe('a\n');
    });
    it('fast-forwards a branch that is not checked out without touching HEAD', async () => {
      const r = await tinyRepo(h);
      r.g('branch', 'lag');
      const tip = r.commit('A', { 'a.txt': 'a\n' });
      r.g('switch', '-q', '-c', 'other');
      await h.run(r.svc, { type: 'ff.run', branch: 'lag', to: 'main' });
      expect(r.rev('lag')).toBe(tip);
      expect(r.svc.repo.head).toMatchObject({ kind: 'branch', name: 'other' });
      expect(r.g('reflog', '-1', '--format=%gs', 'lag').trim()).toMatch(/fast-forward/);
    });
    it('refuses when it is not a fast-forward', async () => {
      const r = await diverged();
      const err = await h.fail(r.svc, { type: 'ff.run', branch: 'side', to: 'main' });
      expect(err.code).toBe('NotFastForwardable');
    });
  });

  describe('file.write', () => {
    it('writes inside the worktree only', async () => {
      const r = await tinyRepo(h);
      await h.run(r.svc, { type: 'file.write', path: 'dir/new.txt', content: 'hello\n' });
      expect(r.file('dir/new.txt')).toBe('hello\n');
      for (const bad of ['../escape.txt', '.git/config', path.join(r.dir, 'abs.txt')]) {
        const err = await h.fail(r.svc, { type: 'file.write', path: bad, content: 'x' });
        expect(err.code, bad).toBe('Unknown');
      }
      expect(fs.existsSync(path.join(r.dir, '..', 'escape.txt'))).toBe(false);
    });
  });
});
