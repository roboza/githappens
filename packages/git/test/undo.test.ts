import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedEnv } from '@githappens/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOnPath, GitProcessRunner, GitService, type GitOperation, type OpContext } from '../src';
import { createUndoOps, PIN_NAMESPACE, UndoJournal, type UndoJournalOptions } from '../src/undo';

// Integration tests: the undo journal against tiny real repos, using the git on PATH. Ops are simulated with
// plain git commands bracketed by journal.begin/commit (the real executors live elsewhere).
const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

type Op = GitOperation;
const commitOp = (summary: string, amend = false): Op => ({
  type: 'commit.create',
  summary,
  description: '',
  coAuthors: [],
  amend,
  skipHooks: false,
  allowEmpty: false,
  sign: 'off',
  cleanup: 'strip',
});

d('UndoJournal', () => {
  let root: string;
  let runner: GitProcessRunner;
  const services: GitService[] = [];
  let seq = 0;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-undo-')));
    runner = new GitProcessRunner({
      context: () => ({ gitPath: gitPath!, baseEnv: isolatedEnv(root), bundled: false }),
    });
  });
  afterAll(() => {
    for (const s of services) s.dispose();
    runner.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may still hold handles briefly */
    }
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(gitPath!, args, { cwd, env: isolatedEnv(root), windowsHide: true, stdio: 'pipe' }).toString(
      'utf8',
    );
  const tryGit = (cwd: string, ...args: string[]): string | null => {
    try {
      return git(cwd, ...args).trim();
    } catch {
      return null;
    }
  };
  const write = (dir: string, file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };

  interface Ctx {
    dir: string;
    svc: GitService;
    journal: UndoJournal;
    g: (...args: string[]) => string;
  }

  async function makeRepo(o: { empty?: boolean; journal?: Partial<UndoJournalOptions> } = {}): Promise<Ctx> {
    const dir = path.join(root, `r${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const g = (...args: string[]) => git(dir, ...args);
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.com');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.autocrlf', 'false');
    if (!o.empty) {
      write(dir, 'a.txt', 'a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n');
      write(dir, 'b.txt', 'b\n');
      g('add', '-A');
      g('commit', '-q', '-m', 'init');
    }
    const svc = await GitService.open(runner, dir);
    services.push(svc);
    const journal = new UndoJournal({ service: svc, ...o.journal });
    return { dir, svc, journal, g };
  }

  function listFiles(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) listFiles(p, base, out);
      else out[path.relative(base, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
    return out;
  }

  /** Everything a user can observe: HEAD, refs, stash, index, status, files, branch config. */
  function fullState(c: Ctx) {
    return state(c);
  }
  function state(c: Ctx) {
    const sym = tryGit(c.dir, 'symbolic-ref', '-q', 'HEAD');
    return {
      head: sym ?? `detached ${tryGit(c.dir, 'rev-parse', 'HEAD')}`,
      headSha: tryGit(c.dir, 'rev-parse', '-q', '--verify', 'HEAD'),
      refs: c.g(
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/heads',
        'refs/tags',
        'refs/remotes',
      ),
      stash: c.g('stash', 'list', '--format=%H %gs'),
      index: c.g('write-tree').trim(),
      status: c.g('status', '--porcelain=v1', '-uall'),
      files: listFiles(c.dir),
      config: tryGit(c.dir, 'config', '--local', '--get-regexp', '^branch\\.') ?? '',
    };
  }

  async function journaled(c: Ctx, op: Op, fn: () => void): Promise<string> {
    const id = await c.journal.begin(op, 'op');
    expect(id).toBeTruthy();
    fn();
    await c.journal.commit(id!, op, {});
    return id!;
  }

  /** Perform op, undo → state equals before, redo → state equals after. */
  async function roundTrip(c: Ctx, op: Op, fn: () => void): Promise<void> {
    const s0 = state(c);
    await journaled(c, op, fn);
    const s1 = state(c);
    expect(s1).not.toEqual(s0);
    expect(c.journal.peek().undo?.kind).toBeTruthy();
    await c.journal.undo();
    expect(state(c)).toEqual(s0);
    expect(c.journal.peek().redo).toBeTruthy();
    await c.journal.redo();
    expect(state(c)).toEqual(s1);
    // and once more back, proving redo left a consistent entry
    await c.journal.undo();
    expect(state(c)).toEqual(s0);
  }

  /** Repo with a `feature` branch one commit ahead (touches c.txt only). */
  async function withFeature(): Promise<Ctx> {
    const c = await makeRepo();
    c.g('switch', '-q', '-c', 'feature');
    write(c.dir, 'c.txt', 'feature\n');
    c.g('add', 'c.txt');
    c.g('commit', '-q', '-m', 'feature');
    c.g('switch', '-q', 'main');
    return c;
  }

  /** Staged change in b.txt, unstaged change in a.txt, untracked u.txt + nested/n.txt. */
  function dirty(c: Ctx): void {
    write(c.dir, 'b.txt', 'b staged\n');
    c.g('add', 'b.txt');
    write(c.dir, 'b.txt', 'b staged\nb unstaged\n');
    write(c.dir, 'a.txt', 'a1 changed\na2\na3\na4\na5\na6\na7\na8\na9\na10\n');
    write(c.dir, 'u.txt', 'untracked\n');
    write(c.dir, 'nested/n.txt', 'nested untracked\n');
  }

  // ---------------------------------------------------------------------------

  describe('commit kinds', () => {
    it('commit: undo soft-resets keeping changes staged; redo re-applies', async () => {
      const c = await makeRepo();
      write(c.dir, 'a.txt', 'changed\n');
      c.g('add', 'a.txt');
      await roundTrip(c, commitOp('second'), () => c.g('commit', '-q', '-m', 'second'));
      expect(c.g('diff', '--cached', '--name-only').trim()).toBe('a.txt');
    });

    it('amend: undo restores the pre-amend commit', async () => {
      const c = await makeRepo();
      write(c.dir, 'b.txt', 'amended\n');
      c.g('add', 'b.txt');
      await roundTrip(c, commitOp('init amended', true), () =>
        c.g('commit', '-q', '--amend', '-m', 'init amended'),
      );
      expect(c.journal.list()[0]!.kind).toBe('amend');
    });

    it('reword HEAD is an amend', async () => {
      const c = await makeRepo();
      const op: Op = { type: 'commit.rewordHead', summary: 'reworded', description: '' };
      await roundTrip(c, op, () => c.g('commit', '-q', '--amend', '-m', 'reworded'));
    });

    it('first commit on an unborn branch: undo deletes the branch ref and keeps the index', async () => {
      const c = await makeRepo({ empty: true });
      write(c.dir, 'x.txt', 'x\n');
      c.g('add', 'x.txt');
      await roundTrip(c, commitOp('first'), () => c.g('commit', '-q', '-m', 'first'));
      expect(tryGit(c.dir, 'rev-parse', '-q', '--verify', 'HEAD')).toBeNull();
    });

    it('commit on a detached HEAD', async () => {
      const c = await makeRepo();
      c.g('switch', '-q', '--detach', 'HEAD');
      write(c.dir, 'a.txt', 'detached work\n');
      c.g('add', 'a.txt');
      await roundTrip(c, commitOp('detached'), () => c.g('commit', '-q', '-m', 'detached'));
    });

    it('a stack of commits undoes and redoes in order', async () => {
      const c = await makeRepo();
      // commit undo is a soft reset (changes stay staged), so compare HEAD + refs only
      const state = (x: Ctx) => {
        const { headSha, refs } = fullState(x);
        return { headSha, refs };
      };
      const states = [state(c)];
      for (const n of [1, 2, 3]) {
        write(c.dir, 'a.txt', `v${n}\n`);
        c.g('add', 'a.txt');
        await journaled(c, commitOp(`c${n}`), () => c.g('commit', '-q', '-m', `c${n}`));
        states.push(state(c));
      }
      expect(c.journal.peek().undo?.label).toBe("Commit 'c3'");
      for (let i = 2; i >= 0; i--) {
        await c.journal.undo();
        expect(state(c)).toEqual(states[i]);
      }
      expect(c.g('diff', '--cached', '--name-only').trim()).toBe('a.txt'); // last content still staged
      await expect(c.journal.undo()).rejects.toThrow(/Nothing to undo/);
      expect(c.journal.peek().redo?.label).toBe("Commit 'c1'");
      for (let i = 1; i <= 3; i++) {
        await c.journal.redo();
        expect(state(c)).toEqual(states[i]);
      }
      expect(c.journal.peek().redo).toBeUndefined();
    });
  });

  describe('checkout', () => {
    it('carry: switches back carrying local changes', async () => {
      const c = await withFeature();
      write(c.dir, 'a.txt', 'carried\n');
      write(c.dir, 'u.txt', 'u\n');
      const op: Op = {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'carry',
      };
      await roundTrip(c, op, () => c.g('switch', '-q', 'feature'));
    });

    it('carry: to a detached commit and back', async () => {
      const c = await withFeature();
      const sha = c.g('rev-parse', 'feature').trim();
      const op: Op = { type: 'checkout.run', target: { kind: 'commit', sha }, dirtyStrategy: 'carry' };
      await roundTrip(c, op, () => c.g('switch', '-q', '--detach', sha));
    });

    it('discard: restores the discarded changes incl. untracked files', async () => {
      const c = await withFeature();
      dirty(c);
      const op: Op = {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'discard',
      };
      await roundTrip(c, op, () => {
        c.g('reset', '-q', '--hard');
        c.g('clean', '-q', '-fd');
        c.g('switch', '-q', 'feature');
      });
    });

    it('stash: removes the auto-stash and restores the changes', async () => {
      const c = await withFeature();
      dirty(c);
      const op: Op = {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'feature' },
        dirtyStrategy: 'stash',
      };
      await roundTrip(c, op, () => {
        c.g('stash', 'push', '-q', '-u', '-m', 'auto');
        c.g('switch', '-q', 'feature');
      });
    });

    it('remote branch: undo deletes the created tracking branch and its config', async () => {
      const c = await withFeature();
      c.g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
      c.g('update-ref', 'refs/remotes/origin/topic', 'feature');
      const op: Op = {
        type: 'checkout.run',
        target: { kind: 'remoteBranch', remote: 'origin', name: 'topic' },
        dirtyStrategy: 'carry',
      };
      await roundTrip(c, op, () => c.g('switch', '-q', '-c', 'topic', '--track', 'origin/topic'));
      expect(c.g('branch', '--list', 'topic').trim()).toBe('');
    });

    it('checking out the current branch records nothing', async () => {
      const c = await makeRepo();
      const op: Op = {
        type: 'checkout.run',
        target: { kind: 'branch', name: 'main' },
        dirtyStrategy: 'carry',
      };
      await journaled(c, op, () => undefined);
      expect(c.journal.peek().undo).toBeUndefined();
      expect(c.journal.list()).toHaveLength(0);
    });
  });

  describe('discard', () => {
    it('wip.discard of one file (staged + unstaged) and an untracked file; other changes untouched', async () => {
      const c = await makeRepo();
      dirty(c);
      write(c.dir, 'a.txt', 'a staged\n');
      c.g('add', 'a.txt');
      write(c.dir, 'a.txt', 'a staged\na unstaged\n');
      const op: Op = { type: 'wip.discard', paths: ['a.txt', 'u.txt'], includeUntracked: true };
      await roundTrip(c, op, () => {
        c.g('checkout', '-q', 'HEAD', '--', 'a.txt');
        fs.rmSync(path.join(c.dir, 'u.txt'));
      });
    });

    it('wip.discardAll', async () => {
      const c = await makeRepo();
      dirty(c);
      fs.rmSync(path.join(c.dir, 'a.txt')); // a tracked deletion too
      const op: Op = { type: 'wip.discardAll', includeUntracked: true };
      await roundTrip(c, op, () => {
        c.g('reset', '-q', '--hard');
        c.g('clean', '-q', '-fd');
      });
    });

    it('wip.discardHunk and wip.discardLines', async () => {
      const c = await makeRepo();
      const twoHunks = 'a1 X\na2\na3\na4\na5\na6\na7\na8\na9\na10 Y\n';
      write(c.dir, 'a.txt', twoHunks);
      const hunk: Op = { type: 'wip.discardHunk', path: 'a.txt', hunkIndex: 0, diffHash: 'x' };
      await roundTrip(c, hunk, () => write(c.dir, 'a.txt', 'a1\na2\na3\na4\na5\na6\na7\na8\na9\na10 Y\n'));
      const lines: Op = {
        type: 'wip.discardLines',
        path: 'a.txt',
        lines: [{ hunkIndex: 0, lineIndex: 0 }],
        diffHash: 'x',
      };
      await roundTrip(c, lines, () => write(c.dir, 'a.txt', 'a1 X\na2\na3\na4\na5\na6\na7\na8\na9\na10\n'));
    });
  });

  describe('branches & tags', () => {
    it('branch.create without checkout', async () => {
      const c = await makeRepo();
      const op: Op = { type: 'branch.create', name: 'topic', startPoint: 'HEAD', checkout: false };
      await roundTrip(c, op, () => c.g('branch', '--no-track', 'topic', 'HEAD'));
    });

    it('branch.create with checkout and upstream', async () => {
      const c = await withFeature();
      c.g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
      c.g('update-ref', 'refs/remotes/origin/feature', 'feature');
      write(c.dir, 'u.txt', 'carried\n');
      const op: Op = {
        type: 'branch.create',
        name: 'topic',
        startPoint: 'origin/feature',
        checkout: true,
        track: 'refs/remotes/origin/feature',
      };
      await roundTrip(c, op, () => {
        c.g('branch', '--track', 'topic', 'refs/remotes/origin/feature');
        c.g('switch', '-q', 'topic');
      });
    });

    it('branch.delete restores the branch and its upstream config', async () => {
      const c = await withFeature();
      c.g('config', 'branch.feature.remote', 'origin');
      c.g('config', 'branch.feature.merge', 'refs/heads/feature');
      c.g('branch', '-q', 'other');
      const op: Op = {
        type: 'branch.delete',
        branches: [{ name: 'feature' }, { name: 'other' }],
        force: true,
      };
      await roundTrip(c, op, () => c.g('branch', '-q', '-D', 'feature', 'other'));
    });

    it('branch.rename of the current branch', async () => {
      const c = await makeRepo();
      c.g('config', 'branch.main.remote', 'origin');
      const op: Op = { type: 'branch.rename', from: 'main', to: 'trunk' };
      await roundTrip(c, op, () => c.g('branch', '-m', 'main', 'trunk'));
    });

    it('tag.create (annotated) and tag.delete', async () => {
      const c = await makeRepo();
      const sha = c.g('rev-parse', 'HEAD').trim();
      const create: Op = { type: 'tag.create', name: 'v1', target: sha, annotated: { message: 'release' } };
      await roundTrip(c, create, () => c.g('tag', '-a', 'v1', '-m', 'release', sha));
      await c.journal.redo();
      const del: Op = { type: 'tag.delete', name: 'v1', local: true, remotes: [] };
      await roundTrip(c, del, () => c.g('tag', '-d', 'v1'));
    });
  });

  describe('stash', () => {
    it('stash.push incl. untracked', async () => {
      const c = await makeRepo();
      dirty(c);
      const op: Op = { type: 'stash.push', message: 's1', includeUntracked: true };
      await roundTrip(c, op, () => c.g('stash', 'push', '-q', '-u', '-m', 's1'));
    });

    async function twoStashes(): Promise<Ctx> {
      const c = await makeRepo();
      write(c.dir, 'a.txt', 'first stash\n');
      c.g('stash', 'push', '-q', '-m', 'first');
      write(c.dir, 'b.txt', 'second stash\n');
      write(c.dir, 'u.txt', 'untracked in stash\n');
      c.g('stash', 'push', '-q', '-u', '-m', 'second');
      return c;
    }

    it('stash.pop of a non-top entry restores the entry at its index', async () => {
      const c = await twoStashes();
      const sha = c.g('rev-parse', 'stash@{1}').trim();
      write(c.dir, 'b.txt', 'unrelated dirty\n');
      const op: Op = { type: 'stash.pop', index: 1, sha };
      await roundTrip(c, op, () => c.g('stash', 'pop', '-q', 'stash@{1}'));
    });

    it('stash.pop of an entry with untracked files', async () => {
      const c = await twoStashes();
      const sha = c.g('rev-parse', 'stash@{0}').trim();
      const op: Op = { type: 'stash.pop', index: 0, sha };
      await roundTrip(c, op, () => c.g('stash', 'pop', '-q'));
    });

    it('stash.drop', async () => {
      const c = await twoStashes();
      const sha = c.g('rev-parse', 'stash@{1}').trim();
      const op: Op = { type: 'stash.drop', index: 1, sha };
      await roundTrip(c, op, () => c.g('stash', 'drop', '-q', 'stash@{1}'));
    });
  });

  describe('stack behaviour', () => {
    it('a new op clears the redo stack', async () => {
      const c = await makeRepo();
      await journaled(c, { type: 'branch.create', name: 'x', startPoint: 'HEAD', checkout: false }, () =>
        c.g('branch', 'x'),
      );
      await c.journal.undo();
      expect(c.journal.peek().redo?.label).toBe('Create branch x');
      const undoneId = c.journal.list()[0]!.id;
      await journaled(c, { type: 'tag.create', name: 't', target: 'HEAD' }, () => c.g('tag', 't'));
      expect(c.journal.peek().redo).toBeUndefined();
      expect(c.journal.list().map((e) => e.id)).not.toContain(undoneId);
      expect(c.g('for-each-ref', `${PIN_NAMESPACE}${undoneId}/`).trim()).toBe('');
      await expect(c.journal.redo()).rejects.toThrow(/Nothing to redo/);
    });

    it('a network barrier blocks undo past it and clears redo', async () => {
      const c = await makeRepo();
      await journaled(c, { type: 'tag.create', name: 't1', target: 'HEAD' }, () => c.g('tag', 't1'));
      await journaled(c, { type: 'tag.create', name: 't2', target: 'HEAD' }, () => c.g('tag', 't2'));
      await c.journal.undo();
      c.journal.barrier({
        type: 'push',
        localRef: 'refs/heads/main',
        remote: 'origin',
        remoteBranch: 'main',
      });
      expect(c.journal.peek()).toEqual({ blockedBy: 'Cannot undo past Push refs/heads/main' });
      await expect(c.journal.undo()).rejects.toThrow(/Cannot undo past Push/);
      // consecutive barriers collapse
      c.journal.barrier({ type: 'fetch', remote: 'origin' });
      expect(c.journal.list().filter((e) => !e.undoable)).toHaveLength(1);
      expect(c.journal.peek().blockedBy).toBe('Cannot undo past Fetch origin');
      // a later op is undoable again, but undo stops at the barrier
      await journaled(c, { type: 'tag.create', name: 't3', target: 'HEAD' }, () => c.g('tag', 't3'));
      await c.journal.undo();
      expect(c.journal.peek().blockedBy).toMatch(/Fetch/);
      expect(c.g('tag', '--list').trim().split(/\s+/)).toEqual(['t1']);
      await c.journal.settle();
    });

    it('unsupported ops are not journaled', async () => {
      const c = await makeRepo();
      expect(await c.journal.begin({ type: 'wip.stage', paths: ['a.txt'] }, 'op')).toBeNull();
      expect(
        await c.journal.begin({ type: 'tag.delete', name: 'x', local: false, remotes: ['origin'] }, 'op'),
      ).toBeNull();
    });
  });

  describe('drift', () => {
    it('refuses to undo a commit after the branch moved', async () => {
      const c = await makeRepo();
      write(c.dir, 'a.txt', 'x\n');
      c.g('add', 'a.txt');
      await journaled(c, commitOp('x'), () => c.g('commit', '-q', '-m', 'x'));
      c.g('commit', '-q', '--allow-empty', '-m', 'external');
      const before = state(c);
      await expect(c.journal.undo()).rejects.toMatchObject({
        code: 'Unknown',
        message: expect.stringMatching(/Can't undo Commit 'x': branch main has moved since/),
      });
      expect(state(c)).toEqual(before);
    });

    it('refuses to undo a commit after switching branches', async () => {
      const c = await makeRepo();
      write(c.dir, 'a.txt', 'x\n');
      c.g('add', 'a.txt');
      await journaled(c, commitOp('x'), () => c.g('commit', '-q', '-m', 'x'));
      c.g('switch', '-q', '-c', 'elsewhere');
      await expect(c.journal.undo()).rejects.toThrow(/HEAD is now elsewhere/);
    });

    it('refuses to undo a discard when the discarded file changed since', async () => {
      const c = await makeRepo();
      dirty(c);
      await journaled(c, { type: 'wip.discard', paths: ['a.txt'], includeUntracked: false }, () =>
        c.g('checkout', '-q', 'HEAD', '--', 'a.txt'),
      );
      write(c.dir, 'a.txt', 'edited after discard\n');
      await expect(c.journal.undo()).rejects.toThrow(/1 file\(s\) changed since: a\.txt/);
      expect(fs.readFileSync(path.join(c.dir, 'a.txt'), 'utf8')).toBe('edited after discard\n');
    });

    it('a discard undo ignores unrelated changes made since', async () => {
      const c = await makeRepo();
      dirty(c);
      await journaled(c, { type: 'wip.discard', paths: ['a.txt'], includeUntracked: false }, () =>
        c.g('checkout', '-q', 'HEAD', '--', 'a.txt'),
      );
      write(c.dir, 'b.txt', 'edited after discard\n');
      await c.journal.undo();
      expect(fs.readFileSync(path.join(c.dir, 'a.txt'), 'utf8')).toMatch(/^a1 changed/);
      expect(fs.readFileSync(path.join(c.dir, 'b.txt'), 'utf8')).toBe('edited after discard\n');
    });

    it('refuses to undo a branch delete when the name was reused', async () => {
      const c = await withFeature();
      await journaled(c, { type: 'branch.delete', branches: [{ name: 'feature' }], force: true }, () =>
        c.g('branch', '-q', '-D', 'feature'),
      );
      c.g('branch', 'feature');
      await expect(c.journal.undo()).rejects.toThrow(/branch feature exists again/);
    });

    it('refuses to undo a stash push when the stash list changed', async () => {
      const c = await makeRepo();
      dirty(c);
      await journaled(c, { type: 'stash.push', includeUntracked: true }, () =>
        c.g('stash', 'push', '-q', '-u'),
      );
      write(c.dir, 'a.txt', 'another\n');
      c.g('stash', 'push', '-q');
      await expect(c.journal.undo()).rejects.toThrow(/stash list has changed/);
    });
  });

  describe('keep-alive refs & persistence', () => {
    it('pins objects under refs/githappens/undo and hides them from branch/tag/remote listings', async () => {
      const c = await makeRepo();
      write(c.dir, 'a.txt', 'x\n');
      c.g('add', 'a.txt');
      const id = await journaled(c, commitOp('x', true), () => c.g('commit', '-q', '--amend', '-m', 'x'));
      const pins = c.g('for-each-ref', '--format=%(refname)', `${PIN_NAMESPACE}${id}/`).trim().split('\n');
      expect(pins.length).toBeGreaterThanOrEqual(2);
      expect(pins.every((p) => p.startsWith(`refs/githappens/undo/${id}/`))).toBe(true);
      // the pre-amend commit is kept alive
      const old = c.journal.list()[0]!.before.headSha!;
      expect(c.g('for-each-ref', '--format=%(objectname)', 'refs/githappens/').split('\n')).toContain(old);
      expect(c.g('for-each-ref', 'refs/heads', 'refs/remotes', 'refs/tags')).not.toMatch(/githappens/);
      expect((await c.svc.refs()).some((r) => r.fullName.includes('githappens'))).toBe(false);
    });

    it('trimming beyond maxEntries deletes the oldest entries and their pins', async () => {
      const c = await makeRepo({ journal: { maxEntries: 2 } });
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push(
          await journaled(c, { type: 'tag.create', name: `t${n}`, target: 'HEAD' }, () =>
            c.g('tag', `t${n}`),
          ),
        );
      }
      expect(c.journal.list().map((e) => e.id)).toEqual([ids[2], ids[1]]);
      expect(c.g('for-each-ref', `${PIN_NAMESPACE}${ids[0]}/`).trim()).toBe('');
      expect(c.g('for-each-ref', `${PIN_NAMESPACE}${ids[2]}/`).trim()).not.toBe('');
    });

    it('fail() marks the entry failed and removes its pins', async () => {
      const c = await makeRepo();
      const op: Op = { type: 'tag.create', name: 'nope', target: 'HEAD' };
      const id = (await c.journal.begin(op, 'op'))!;
      expect(c.g('for-each-ref', `${PIN_NAMESPACE}${id}/`).trim()).not.toBe('');
      await c.journal.fail(id, op, { code: 'Unknown', message: 'x', exitCode: 1, stderr: '', command: '' });
      expect(c.g('for-each-ref', `${PIN_NAMESPACE}${id}/`).trim()).toBe('');
      expect(c.journal.list()[0]!.status).toBe('failed');
      expect(c.journal.peek()).toEqual({});
    });

    it('persists to a JSON file and reloads it', async () => {
      const file = path.join(root, `journal-${seq + 1}.json`);
      const c = await makeRepo({ journal: { persistFile: file } });
      write(c.dir, 'a.txt', 'x\n');
      c.g('add', 'a.txt');
      const s0 = state(c);
      const id = await journaled(c, commitOp('x'), () => c.g('commit', '-q', '-m', 'x'));
      expect(fs.existsSync(file)).toBe(true);

      const reloaded = new UndoJournal({ service: c.svc, persistFile: file });
      expect(reloaded.peek().undo?.id).toBe(id);
      await reloaded.undo();
      expect(state(c)).toEqual(s0);
      const again = new UndoJournal({ service: c.svc, persistFile: file });
      expect(again.peek().redo?.id).toBe(id);
      expect(again.peek().undo).toBeUndefined();
    });

    it('tolerates a corrupt journal file and sweeps orphaned pins', async () => {
      const file = path.join(root, `journal-${seq + 1}.json`);
      const c = await makeRepo({ journal: { persistFile: file } });
      const id = await journaled(c, { type: 'tag.create', name: 't', target: 'HEAD' }, () => c.g('tag', 't'));
      fs.writeFileSync(file, '{ not json');
      const j = new UndoJournal({ service: c.svc, persistFile: file });
      expect(j.peek()).toEqual({});
      expect(j.list()).toEqual([]);
      await j.settle();
      expect(c.g('for-each-ref', `${PIN_NAMESPACE}${id}/`).trim()).toBe('');
    });
  });

  describe('createUndoOps', () => {
    it('runs undo/redo as non-journaled ops', async () => {
      const c = await makeRepo();
      const ops = createUndoOps(c.journal);
      for (const def of Object.values(ops)) {
        expect(def.meta.undoable).toBe(false);
        expect(def.meta.mutating).toBe(true);
        expect(def.meta.touches).toEqual(expect.arrayContaining(['refs', 'graph', 'status', 'stash']));
      }
      await journaled(c, { type: 'tag.create', name: 't', target: 'HEAD' }, () => c.g('tag', 't'));
      expect(ops['undo.run'].meta.label({ type: 'undo.run' })).toBe('Undo Create tag t');
      const ctx = {
        opId: 'u',
        service: c.svc,
        signal: new AbortController().signal,
        progress: () => undefined,
        background: false,
      } as OpContext;
      const r = await ops['undo.run'].execute(ctx, { type: 'undo.run' });
      expect(r.summary).toBe('Undid Create tag t');
      expect(c.g('tag', '--list').trim()).toBe('');
      expect(ops['redo.run'].meta.label({ type: 'redo.run' })).toBe('Redo Create tag t');
      await ops['redo.run'].execute(ctx, { type: 'redo.run' });
      expect(c.g('tag', '--list').trim()).toBe('t');
      await expect(ops['redo.run'].execute(ctx, { type: 'redo.run' })).rejects.toThrow(/Nothing to redo/);
    });
  });
});
