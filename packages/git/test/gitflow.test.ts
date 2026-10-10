import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { GitOperation } from '../src/ops/types';
import {
  finishStatePath,
  GITFLOW_DEFAULTS,
  gitflowConfig,
  gitflowStatus,
  groupFlowBranches,
  parseGitflowConfig,
} from '../src/service/gitflow';
import { UndoJournal } from '../src/undo';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

const INIT: GitOperation = { type: 'gitflow.init', ...GITFLOW_DEFAULTS };

describeGit('Git Flow (spec 05 §6.12, spec 12 §6.9)', () => {
  const h = useHarness('gitflow');

  async function setup(initialized = true): Promise<{
    r: TinyRepo;
    journal: UndoJournal;
    run: (op: GitOperation) => Promise<unknown>;
    failOp: (op: GitOperation) => ReturnType<typeof h.fail>;
  }> {
    const r = await tinyRepo(h, { 'README.md': 'base\n', 'f.txt': 'base\n' });
    const journal = new UndoJournal({ service: r.svc });
    const run = (op: GitOperation) => h.run(r.svc, op, { journal });
    if (initialized) await run(INIT);
    return { r, journal, run, failOp: (op) => h.fail(r.svc, op, { journal }) };
  }

  const head = (r: TinyRepo): string => r.g('symbolic-ref', '--short', 'HEAD').trim();
  const exists = (r: TinyRepo, ref: string): boolean => {
    try {
      r.g('rev-parse', '-q', '--verify', ref);
      return true;
    } catch {
      return false;
    }
  };
  const parents = (r: TinyRepo, rev: string): string[] =>
    r.g('rev-list', '--parents', '-n', '1', rev).trim().split(/\s+/).slice(1);

  it('init writes the gitflow.* keys and creates develop from main', async () => {
    const { r } = await setup(false);
    expect(await gitflowConfig(r.svc)).toBeNull();
    await h.run(r.svc, { ...INIT, versionTag: 'v' } as GitOperation);
    expect(r.g('config', '--local', 'gitflow.branch.master').trim()).toBe('main');
    expect(r.g('config', '--local', 'gitflow.prefix.feature').trim()).toBe('feature/');
    expect(r.rev('develop')).toBe(r.rev('main'));
    const cfg = await gitflowConfig(r.svc);
    expect(cfg).toMatchObject({ production: 'main', develop: 'develop', versionTag: 'v', initialized: true });
    // re-init keeps an existing develop
    r.g('switch', '-q', 'develop');
    r.commit('D1', { 'd.txt': 'd\n' });
    await h.run(r.svc, INIT);
    expect(r.rev('develop')).not.toBe(r.rev('main'));
  });

  it('starts feature / release from develop and hotfix from main', async () => {
    const { r, run } = await setup();
    r.g('switch', '-q', 'develop');
    r.commit('D1', { 'd.txt': 'd\n' });
    r.g('switch', '-q', 'main');
    await run({ type: 'gitflow.start', kind: 'feature', name: 'login' });
    expect(head(r)).toBe('feature/login');
    expect(r.rev('feature/login')).toBe(r.rev('develop'));
    await run({ type: 'gitflow.start', kind: 'release', name: '1.0' });
    expect(r.rev('release/1.0')).toBe(r.rev('develop'));
    await run({ type: 'gitflow.start', kind: 'hotfix', name: '1.0.1' });
    expect(head(r)).toBe('hotfix/1.0.1');
    expect(r.rev('hotfix/1.0.1')).toBe(r.rev('main'));
    const st = await gitflowStatus(r.svc);
    expect(st.branches).toEqual({
      feature: ['feature/login'],
      bugfix: [],
      release: ['release/1.0'],
      hotfix: ['hotfix/1.0.1'],
      support: [],
    });
    expect(st.pendingFinish).toBeNull();
  });

  it('finishes a feature: merge --no-ff into develop and delete the branch', async () => {
    const { r, run } = await setup();
    await run({ type: 'gitflow.start', kind: 'feature', name: 'x' });
    const tip = r.commit('F1', { 'x.txt': 'x\n' });
    const dev = r.rev('develop');
    await run({ type: 'gitflow.finish', kind: 'feature', name: 'x', deleteBranch: true });
    expect(head(r)).toBe('develop');
    expect(parents(r, 'develop')).toEqual([dev, tip]);
    expect(exists(r, 'refs/heads/feature/x')).toBe(false);
    expect(r.file('x.txt')).toBe('x\n');
  });

  it('finishes a feature with rebase onto develop first', async () => {
    const { r, run } = await setup();
    await run({ type: 'gitflow.start', kind: 'feature', name: 'y' });
    const old = r.commit('F1', { 'y.txt': 'y\n' });
    r.g('switch', '-q', 'develop');
    const dev = r.commit('D1', { 'd.txt': 'd\n' });
    r.g('switch', '-q', 'feature/y');
    await run({ type: 'gitflow.finish', kind: 'feature', name: 'y', rebase: true, deleteBranch: false });
    const [p1, p2] = parents(r, 'develop');
    expect(p1).toBe(dev);
    expect(p2).not.toBe(old);
    expect(parents(r, p2!)).toEqual([dev]); // the feature commit was replayed on develop
    expect(r.rev('feature/y')).toBe(p2);
    expect(head(r)).toBe('develop');
  });

  it('finishes a release: merges into main and develop, annotated tag, one undo restores everything', async () => {
    const { r, run, journal } = await setup();
    await run({ type: 'gitflow.start', kind: 'release', name: '1.0' });
    const rel = r.commit('Bump', { VERSION: '1.0\n' });
    const before = { main: r.rev('main'), develop: r.rev('develop') };
    await run({
      type: 'gitflow.finish',
      kind: 'release',
      name: '1.0',
      deleteBranch: true,
      tag: { name: 'v1.0', message: 'Release 1.0\n\nNotes' },
    });
    expect(parents(r, 'main')).toEqual([before.main, rel]);
    expect(parents(r, 'develop')).toEqual([before.develop, rel]);
    expect(r.g('cat-file', '-t', 'v1.0').trim()).toBe('tag');
    expect(r.rev('v1.0^{commit}')).toBe(r.rev('main'));
    expect(r.g('tag', '-l', '--format=%(contents)', 'v1.0')).toContain('Notes');
    expect(exists(r, 'refs/heads/release/1.0')).toBe(false);
    expect(head(r)).toBe('develop');
    expect(journal.peek().undo).toMatchObject({ kind: 'gitflow-finish', label: 'Finish release 1.0' });

    await journal.undo();
    expect(r.rev('main')).toBe(before.main);
    expect(r.rev('develop')).toBe(before.develop);
    expect(r.rev('release/1.0')).toBe(rel);
    expect(exists(r, 'refs/tags/v1.0')).toBe(false);
    expect(head(r)).toBe('release/1.0');
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('finishes a hotfix into main and develop', async () => {
    const { r, run } = await setup();
    r.g('switch', '-q', 'develop');
    r.commit('D1', { 'd.txt': 'd\n' });
    await run({ type: 'gitflow.start', kind: 'hotfix', name: '1.0.1' });
    const fix = r.commit('Fix', { 'README.md': 'fixed\n' });
    await run({
      type: 'gitflow.finish',
      kind: 'hotfix',
      name: '1.0.1',
      deleteBranch: true,
      tag: { name: '1.0.1', message: 'Hotfix' },
    });
    expect(parents(r, 'main')[1]).toBe(fix);
    expect(parents(r, 'develop')[1]).toBe(fix);
    expect(r.file('d.txt')).toBe('d\n');
    expect(r.file('README.md')).toBe('fixed\n');
    expect(r.rev('1.0.1^{commit}')).toBe(r.rev('main'));
  });

  async function conflictedRelease() {
    const s = await setup();
    const { r, run } = s;
    await run({ type: 'gitflow.start', kind: 'release', name: '2.0' });
    const rel = r.commit('Release change', { 'f.txt': 'release\n' });
    r.g('switch', '-q', 'develop');
    r.commit('Develop change', { 'f.txt': 'develop\n' });
    r.g('switch', '-q', 'release/2.0');
    const before = { main: r.rev('main'), develop: r.rev('develop'), rel };
    const err = await s.failOp({
      type: 'gitflow.finish',
      kind: 'release',
      name: '2.0',
      deleteBranch: true,
      tag: { name: 'v2.0', message: 'Two' },
    });
    return { ...s, before, err };
  }

  it('pauses on a conflict mid-finish and continue completes the remaining steps; one undo restores all', async () => {
    const { r, run, journal, before, err } = await conflictedRelease();
    expect(err.code).toBe('MergeConflict');
    expect(err.message).toMatch(/Git Flow finish paused/);
    expect(err.details?.files).toEqual(['f.txt']);
    // main merge + tag are done; develop merge is in progress
    expect(parents(r, 'main')).toEqual([before.main, before.rel]);
    expect(exists(r, 'refs/tags/v2.0')).toBe(true);
    expect(fs.existsSync(finishStatePath(r.svc))).toBe(true);
    const st = await gitflowStatus(r.svc);
    expect(st.pendingFinish).toMatchObject({
      kind: 'release',
      branch: 'release/2.0',
      step: 'merge release/2.0 into develop',
      waitingOn: 'merge',
      remaining: ['delete release/2.0'],
    });
    // a second finish is refused while paused
    const again = await h.fail(r.svc, {
      type: 'gitflow.finish',
      kind: 'feature',
      name: 'z',
      deleteBranch: true,
    });
    expect(again.message).toMatch(/Finish or abort the merge|paused/);
    // continue with unresolved files is refused
    expect((await h.fail(r.svc, { type: 'gitflow.continue' }, { journal })).code).toBe('MergeConflict');

    h.write(path.join(r.dir, 'f.txt'), 'resolved\n');
    r.g('add', 'f.txt');
    await run({ type: 'gitflow.continue' });
    expect(fs.existsSync(finishStatePath(r.svc))).toBe(false);
    expect(head(r)).toBe('develop');
    expect(parents(r, 'develop')).toEqual([before.develop, before.rel]);
    expect(r.file('f.txt')).toBe('resolved\n');
    expect(exists(r, 'refs/heads/release/2.0')).toBe(false);
    expect(r.g('for-each-ref', 'refs/githappens/gitflow/').trim()).toBe('');
    expect(journal.peek().undo).toMatchObject({ kind: 'gitflow-finish', label: 'Finish release 2.0' });

    await journal.undo();
    expect(r.rev('main')).toBe(before.main);
    expect(r.rev('develop')).toBe(before.develop);
    expect(r.rev('release/2.0')).toBe(before.rel);
    expect(exists(r, 'refs/tags/v2.0')).toBe(false);
    expect(head(r)).toBe('release/2.0');
    expect(r.file('f.txt')).toBe('release\n');
    expect(r.g('status', '--porcelain').trim()).toBe('');
  });

  it('continue also works when the user committed the merge already', async () => {
    const { r, run, before } = await conflictedRelease();
    h.write(path.join(r.dir, 'f.txt'), 'resolved\n');
    r.g('add', 'f.txt');
    r.g('commit', '-q', '--no-edit');
    await run({ type: 'gitflow.continue' });
    expect(parents(r, 'develop')).toEqual([before.develop, before.rel]);
    expect(exists(r, 'refs/heads/release/2.0')).toBe(false);
  });

  it('pauses on a rebase conflict during a feature finish and continues it', async () => {
    const { r, run, failOp } = await setup();
    await run({ type: 'gitflow.start', kind: 'feature', name: 'r' });
    r.commit('F', { 'f.txt': 'feature\n' });
    r.g('switch', '-q', 'develop');
    const dev = r.commit('D', { 'f.txt': 'develop\n' });
    r.g('switch', '-q', 'feature/r');
    const err = await failOp({
      type: 'gitflow.finish',
      kind: 'feature',
      name: 'r',
      rebase: true,
      deleteBranch: true,
    });
    expect(err.code).toBe('RebaseConflict');
    expect((await gitflowStatus(r.svc)).pendingFinish).toMatchObject({ waitingOn: 'rebase' });
    h.write(path.join(r.dir, 'f.txt'), 'both\n');
    r.g('add', 'f.txt');
    await run({ type: 'gitflow.continue' });
    expect(parents(r, 'develop')[0]).toBe(dev);
    expect(r.file('f.txt')).toBe('both\n');
    expect(exists(r, 'refs/heads/feature/r')).toBe(false);
    expect(fs.existsSync(finishStatePath(r.svc))).toBe(false);
  });

  it('abort rolls back the steps already done and clears the state', async () => {
    const { r, run, before } = await conflictedRelease();
    await run({ type: 'gitflow.abort' });
    expect(fs.existsSync(finishStatePath(r.svc))).toBe(false);
    expect(r.rev('main')).toBe(before.main);
    expect(r.rev('develop')).toBe(before.develop);
    expect(exists(r, 'refs/tags/v2.0')).toBe(false);
    expect(head(r)).toBe('release/2.0');
    expect(r.g('status', '--porcelain').trim()).toBe('');
    expect((await gitflowStatus(r.svc)).pendingFinish).toBeNull();
    expect((await h.fail(r.svc, { type: 'gitflow.continue' })).message).toMatch(/no paused Git Flow finish/);
  });

  it('refuses bad input and missing branches with hints', async () => {
    const { r, run } = await setup(false);
    const notInit = await h.fail(r.svc, { type: 'gitflow.start', kind: 'feature', name: 'a' });
    expect(notInit.details?.hint).toBe('gitflow.init');

    await run(INIT);
    expect((await h.fail(r.svc, { type: 'gitflow.start', kind: 'feature', name: '-x' })).code).toBe(
      'InvalidRefName',
    );
    expect((await h.fail(r.svc, { type: 'gitflow.start', kind: 'feature', name: 'a..b' })).code).toBe(
      'InvalidRefName',
    );
    await run({ type: 'gitflow.start', kind: 'feature', name: 'a' });
    expect((await h.fail(r.svc, { type: 'gitflow.start', kind: 'feature', name: 'a' })).code).toBe(
      'BranchAlreadyExists',
    );

    // release without tag message
    await run({ type: 'gitflow.start', kind: 'release', name: '3.0' });
    const noMsg = await h.fail(r.svc, {
      type: 'gitflow.finish',
      kind: 'release',
      name: '3.0',
      deleteBranch: true,
      tag: { name: 'v3.0', message: '  ' },
    });
    expect(noMsg.message).toMatch(/tag message is required/);
    // tag exists
    r.g('tag', 'v3.0', 'main');
    const tagExists = await h.fail(r.svc, {
      type: 'gitflow.finish',
      kind: 'release',
      name: '3.0',
      deleteBranch: true,
      tag: { name: 'v3.0', message: 'x' },
    });
    expect(tagExists.code).toBe('TagAlreadyExists');
    // dirty worktree
    h.write(path.join(r.dir, 'README.md'), 'dirty\n');
    const dirty = await h.fail(r.svc, {
      type: 'gitflow.finish',
      kind: 'feature',
      name: 'a',
      deleteBranch: true,
    });
    expect(dirty.code).toBe('DirtyWorktree');
    r.g('checkout', '--', 'README.md');
    // missing develop
    r.g('switch', '-q', 'feature/a');
    r.g('branch', '-D', 'develop');
    const noDev = await h.fail(r.svc, {
      type: 'gitflow.finish',
      kind: 'feature',
      name: 'a',
      deleteBranch: true,
    });
    expect(noDev.details?.hint).toBe('gitflow.createDevelop');
    // unknown branch
    await run(INIT); // recreates develop
    const missing = await h.fail(r.svc, {
      type: 'gitflow.finish',
      kind: 'feature',
      name: 'nope',
      deleteBranch: true,
    });
    expect(missing.message).toMatch(/does not exist/);
  });
});

it('parses gitflow config and groups flow branches', () => {
  expect(parseGitflowConfig('')).toBeNull();
  const cfg = parseGitflowConfig(
    'gitflow.branch.master\nmaster\0gitflow.branch.develop\ndev\0gitflow.prefix.feature\nf/\0gitflow.prefix.versiontag\nv\0',
  );
  expect(cfg).toMatchObject({
    production: 'master',
    develop: 'dev',
    feature: 'f/',
    release: 'release/',
    versionTag: 'v',
    initialized: true,
  });
  expect(
    groupFlowBranches(['f/b', 'f/a', 'release/1', 'hotfix/2', 'bugfix/3', 'support/1.x', 'main', 'f/'], cfg!),
  ).toEqual({
    feature: ['f/a', 'f/b'],
    bugfix: ['bugfix/3'],
    release: ['release/1'],
    hotfix: ['hotfix/2'],
    support: ['support/1.x'],
  });
});
