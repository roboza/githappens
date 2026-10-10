import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { GitOperation, PatchApplyOutcome } from '../src/ops/types';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

const BIN = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0, 42]);

describeGit('patch.apply (spec 14 §6.3)', () => {
  const h = useHarness('patchapply');
  let seq = 0;

  async function setup(): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    base: string;
    run: (op: GitOperation) => Promise<PatchApplyOutcome>;
  }> {
    const r = await tinyRepo(h, { 'a.txt': 'one\ntwo\nthree\n' });
    const base = r.rev('HEAD');
    const journal = new UndoJournal({ service: r.svc });
    return {
      r,
      journal,
      base,
      run: async (op) => (await h.run(r.svc, op, { journal })).data as PatchApplyOutcome,
    };
  }

  /** Make changes, capture them as a patch file, then restore the clean state. */
  function makePatch(r: TinyRepo, files: Record<string, string | Buffer | null>): string {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(r.dir, rel);
      if (content === null) fs.rmSync(p, { force: true });
      else h.write(p, content);
    }
    r.g('add', '-A');
    const text = h.gitBuf(r.dir, 'diff', '--cached', '--binary', '--full-index', '--no-color');
    r.g('reset', '-q', '--hard', 'HEAD');
    const file = path.join(h.root, `p${++seq}.patch`);
    fs.writeFileSync(file, text);
    return file;
  }

  it('applies to the working tree (incl. a binary file) and one undo reverts it', async () => {
    const { r, journal, run } = await setup();
    const patchFile = makePatch(r, { 'a.txt': 'one\nTWO\nthree\n', 'img.bin': BIN, 'new.txt': 'n\n' });
    const out = await run({ type: 'patch.apply', patchFile, mode: 'apply', target: { kind: 'worktree' } });
    expect(out).toMatchObject({ applied: true, conflicts: [], rejects: [] });
    expect(r.file('a.txt')).toBe('one\nTWO\nthree\n');
    expect(fs.readFileSync(path.join(r.dir, 'img.bin')).equals(BIN)).toBe(true);
    expect(r.file('new.txt')).toBe('n\n');
    expect(journal.peek().undo).toMatchObject({ kind: 'patch-apply', label: 'Apply patch' });

    await journal.undo();
    expect(r.file('a.txt')).toBe('one\ntwo\nthree\n');
    expect(r.file('new.txt')).toBeNull();
    expect(fs.existsSync(path.join(r.dir, 'img.bin'))).toBe(false);
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('applies on a new branch at the base and commits with the title; undo restores the branch', async () => {
    const { r, journal, run, base } = await setup();
    const patchFile = makePatch(r, { 'a.txt': 'one\ntwo\nthree\nfour\n' });
    r.commit('moved on', { 'other.txt': 'x\n' });
    const head = r.rev('HEAD');
    const out = await run({
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'new-branch', name: 'patch/four', base },
      commitMessage: 'Add four',
      title: 'Add four',
    });
    expect(out.branch).toBe('patch/four');
    expect(out.commit).toBe(r.rev('HEAD'));
    expect(r.g('symbolic-ref', '--short', 'HEAD').trim()).toBe('patch/four');
    expect(r.rev('HEAD^')).toBe(base);
    expect(r.g('log', '-1', '--format=%s').trim()).toBe('Add four');
    expect(r.file('other.txt')).toBeNull();

    await journal.undo();
    expect(r.g('symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(r.rev('HEAD')).toBe(head);
    expect(r.g('branch', '--list', 'patch/four').trim()).toBe('');
    expect(r.file('other.txt')).toBe('x\n');
  });

  it('refuses a dirty working tree for branch targets unless autostash is set', async () => {
    const { r, run } = await setup();
    const patchFile = makePatch(r, { 'b.txt': 'b\n' });
    r.g('branch', 'feature');
    h.write(path.join(r.dir, 'a.txt'), 'local\n');
    const err = await h.fail(r.svc, {
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'existing-branch', name: 'feature' },
    });
    expect(err.message).toMatch(/Commit or stash/);

    const out = await run({
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'existing-branch', name: 'feature', autostash: true },
    });
    expect(out.autostash).toBeTruthy();
    expect(r.g('symbolic-ref', '--short', 'HEAD').trim()).toBe('feature');
    expect(r.file('b.txt')).toBe('b\n');
    expect(r.file('a.txt')).toBe('one\ntwo\nthree\n');
    expect(r.g('stash', 'list').trim()).toMatch(/autostash/);
  });

  it('commits a format-patch with `am`, preserving authorship', async () => {
    const { r, run, base } = await setup();
    h.write(path.join(r.dir, 'a.txt'), 'one\ntwo\nthree\nam\n');
    r.g('add', '-A');
    r.g('commit', '-q', '-m', 'Shared commit', '--author', 'Alice Example <alice@example.com>');
    const text = h.gitBuf(r.dir, 'format-patch', '-1', '--stdout', '--binary', 'HEAD');
    const patchFile = path.join(h.root, `am${++seq}.patch`);
    fs.writeFileSync(patchFile, text);
    r.g('reset', '-q', '--hard', base);

    const out = await run({
      type: 'patch.apply',
      patchFile,
      mode: 'am',
      target: { kind: 'new-branch', name: 'from-alice', base },
    });
    expect(out.commit).toBe(r.rev('HEAD'));
    expect(r.g('log', '-1', '--format=%an <%ae>|%s').trim()).toBe(
      'Alice Example <alice@example.com>|Shared commit',
    );
    expect(r.file('a.txt')).toBe('one\ntwo\nthree\nam\n');
  });

  it('reports conflicts from a 3-way apply instead of failing', async () => {
    const { r, run } = await setup();
    const patchFile = makePatch(r, { 'a.txt': 'one\nPATCH\nthree\n' });
    r.commit('diverge', { 'a.txt': 'one\nMINE\nthree\n' });
    const out = await run({ type: 'patch.apply', patchFile, mode: 'apply', target: { kind: 'worktree' } });
    expect(out.applied).toBe(true);
    expect(out.conflicts).toEqual(['a.txt']);
    expect(r.file('a.txt')).toMatch(/<<<<<<<[\s\S]*MINE[\s\S]*PATCH/);
  });

  it('fails with a retry hint when nothing applies, and applies partially with reject', async () => {
    const { r, run } = await setup();
    const patchFile = makePatch(r, { 'a.txt': 'one\nPATCH\nthree\n', 'c.txt': 'c\n' });
    r.commit('diverge', { 'a.txt': 'one\nMINE\nthree\n' });
    const err = await h.fail(r.svc, {
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'worktree' },
      threeWay: false,
    });
    expect(err.details?.patchApply).toBe('does-not-apply');
    expect(r.g('status', '--porcelain').trim()).toBe('');

    const out = await run({
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'worktree' },
      threeWay: false,
      reject: true,
    });
    expect(out.rejects).toEqual(['a.txt.rej']);
    expect(r.file('c.txt')).toBe('c\n');
  });

  it('retries with --ignore-whitespace for CRLF differences', async () => {
    const { r, run } = await setup();
    const patchFile = makePatch(r, { 'a.txt': 'one\ntwo\nthree\nfour\n' });
    r.commit('crlf', { 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
    const err = await h.fail(r.svc, {
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'worktree' },
      threeWay: false,
    });
    expect(err.details?.patchApply).toBe('does-not-apply');
    const out = await run({
      type: 'patch.apply',
      patchFile,
      mode: 'apply',
      target: { kind: 'worktree' },
      threeWay: false,
      ignoreWhitespace: true,
    });
    expect(out.applied).toBe(true);
    expect(r.file('a.txt')).toContain('four');
  });
});
