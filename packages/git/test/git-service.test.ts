import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isolatedEnv,
  makeFixture,
  SkipFixture,
  type FixtureName,
  type FixtureResult,
} from '@githappens/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findOnPath,
  GitError,
  GitProcessRunner,
  GitService,
  repoIdFor,
  type CommitSummary,
  type LogQuery,
  type StreamingLogCursor,
} from '../src';

// Integration tests: GitService against generated fixture repos, using the git on PATH.
const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

d('GitService (fixtures)', () => {
  let root: string;
  let runner: GitProcessRunner;
  const services: GitService[] = [];

  let seq = 0;
  // each fixture gets its own root: live helper processes keep their cwd open on Windows
  const fixture = (name: FixtureName, options?: Record<string, string | number | boolean>) =>
    makeFixture(name, { root: path.join(root, String(++seq)), force: true, options });
  // read-only tests share one generated copy
  const shared = new Map<string, FixtureResult>();
  const sharedFixture = (name: FixtureName): FixtureResult => {
    if (!shared.has(name)) shared.set(name, fixture(name));
    return shared.get(name)!;
  };
  const open = async (p: string, opts?: Parameters<typeof GitService.open>[2]) => {
    const s = await GitService.open(runner, p, opts);
    services.push(s);
    return s;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(gitPath!, args, { cwd, env: isolatedEnv(root), windowsHide: true }).toString('utf8');
  const allPages = async (svc: GitService, q: LogQuery, pageSize = 50): Promise<CommitSummary[]> => {
    const c = svc.log(q);
    const out: CommitSummary[] = [];
    for (;;) {
      const p = await c.next(pageSize);
      out.push(...p.commits);
      if (p.done) return out;
    }
  };
  const ALL: LogQuery = { revs: 'all', order: 'topo' };

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-')));
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

  describe('open / repo info', () => {
    it('discovers the repo from a subdirectory', async () => {
      const f = fixture('linear', { count: 12 });
      const svc = await open(path.join(f.path, 'src'));
      const real = fs.realpathSync.native(f.path);
      expect(svc.repo.worktreeRoot).toBe(real);
      expect(svc.repo.id).toBe(repoIdFor(real));
      expect(svc.repo.isBare).toBe(false);
      expect(svc.repo.isLinkedWorktree).toBe(false);
      expect(svc.repo.objectFormat).toBe('sha1');
      expect(svc.repo.gitDir).toBe(path.join(real, '.git'));
      expect(svc.repo.head).toEqual({ kind: 'branch', name: 'main', sha: f.facts.head });
      expect(svc.repo.state).toBe('clean');
    });

    it('case-folds RepoId on win32/darwin only', () => {
      expect(repoIdFor('C:\\Repo', 'win32')).toBe(repoIdFor('c:\\repo', 'win32'));
      expect(repoIdFor('/Repo', 'linux')).not.toBe(repoIdFor('/repo', 'linux'));
      expect(repoIdFor('/x')).toMatch(/^[0-9a-f]{40}$/);
    });

    it('throws NotARepository', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-norepo-'));
      try {
        await expect(GitService.open(runner, dir)).rejects.toMatchObject({ code: 'NotARepository' });
        await expect(GitService.open(runner, path.join(dir, 'missing'))).rejects.toBeInstanceOf(GitError);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('opens a bare repo (no status, log + refs work)', async () => {
      const f = fixture('bare');
      const svc = await open(f.path);
      expect(svc.repo.isBare).toBe(true);
      expect(svc.repo.worktreeRoot).toBeNull();
      expect(svc.repo.id).toBe(repoIdFor(svc.repo.gitDir));
      await expect(svc.status()).rejects.toBeInstanceOf(GitError);
      expect(await allPages(svc, ALL)).toHaveLength(2);
      expect((await svc.refs()).map((r) => r.fullName)).toContain('refs/heads/main');
      expect(await svc.stashList()).toEqual([]);
    });

    it('opens linked worktrees and reports worktreePath for branches checked out elsewhere', async () => {
      const f = fixture('worktrees');
      const [wtFeature, wtDetached] = f.facts.worktrees as string[];
      const wt = await open(wtFeature!);
      expect(wt.repo.isLinkedWorktree).toBe(true);
      expect(wt.repo.gitDir).not.toBe(wt.repo.commonDir);
      expect(wt.repo.head).toMatchObject({ kind: 'branch', name: 'feature' });
      const st = await wt.status();
      expect(st.entries).toContainEqual(
        expect.objectContaining({ kind: 'ordinary', path: 'f.txt', worktree: 'M' }),
      );

      const main = await open(f.path);
      expect(main.repo.id).not.toBe(wt.repo.id);
      const refs = await main.refs();
      const feature = refs.find((r) => r.fullName === 'refs/heads/feature')!;
      const mainRef = refs.find((r) => r.fullName === 'refs/heads/main')!;
      expect(feature.worktreePath?.toLowerCase()).toBe(fs.realpathSync.native(wtFeature!).toLowerCase());
      expect(mainRef.isHead).toBe(true);
      expect(mainRef.worktreePath).toBeUndefined();

      const det = await open(wtDetached!);
      expect(det.repo.head.kind).toBe('detached');
    });

    it('reports merging state and stays read-only', async () => {
      const f = fixture('conflict-in-progress');
      const svc = await open(f.path);
      expect(svc.repo.state).toBe('merging');
      expect(fs.existsSync(path.join(f.path, '.git', 'index.lock'))).toBe(false);
    });
  });

  describe('empty repo', () => {
    it('handles the unborn branch', async () => {
      const f = fixture('empty');
      const svc = await open(f.path);
      expect(svc.repo.head).toEqual({ kind: 'branch', name: 'main', sha: null });
      const page = await svc.log(ALL).next(500);
      expect(page).toEqual({ commits: [], cursor: null, done: true });
      const explicit = await svc.log({ revs: ['HEAD'], order: 'date' }).next(10);
      expect(explicit.done).toBe(true);
      expect(explicit.commits).toEqual([]);
      const st = await svc.status();
      expect(st.branch).toMatchObject({ oid: null, head: 'main' });
      expect(await svc.refs()).toEqual([]);
      expect(await svc.search({ kind: 'message', text: 'x' })).toEqual([]);

      fs.writeFileSync(path.join(f.path, 'new.txt'), 'hello\n');
      git(f.path, 'add', 'new.txt');
      const staged = await svc.diff({ kind: 'staged' });
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({ status: 'A', newPath: 'new.txt', oldPath: null, additions: 1 });
      expect(await svc.numstat({ kind: 'staged' })).toEqual([
        { path: 'new.txt', status: 'A', additions: 1, deletions: 0, binary: false },
      ]);
      expect((await svc.showFile(':0', 'new.txt')).content).toBe('hello\n');
    });
  });

  describe('status', () => {
    it('parses unicode paths and untracked files', async () => {
      const f = sharedFixture('unicode-paths');
      const svc = await open(f.path);
      const st = await svc.status();
      expect(st.branch.head).toBe('main');
      expect(st.entries).toContainEqual(
        expect.objectContaining({ kind: 'ordinary', path: 'ünï cødé.txt', index: '.', worktree: 'M' }),
      );
      expect(st.entries).toContainEqual({ kind: 'untracked', path: 'new 新しい.txt' });
      expect((await svc.status({ untracked: 'no' })).entries.some((e) => e.kind === 'untracked')).toBe(false);
    });

    it('collapses an untracked explosion to directories', async () => {
      const f = fixture('linear', { count: 2 });
      const dir = path.join(f.path, 'lots');
      fs.mkdirSync(dir);
      for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
      const svc = await open(f.path, { untrackedLimit: 20 });
      const st = await svc.status();
      expect(st.truncatedUntracked).toBe(true);
      expect(st.entries).toContainEqual({ kind: 'untracked', path: 'lots/' });
      const normal = await svc.status({ untracked: 'all' });
      expect(normal.truncatedUntracked).toBe(true);
      const big = await open(f.path);
      expect((await big.status()).entries.filter((e) => e.kind === 'untracked')).toHaveLength(30);
    });

    it('reports conflicts with stages', async () => {
      const f = fixture('conflict-in-progress');
      const svc = await open(f.path);
      const st = await svc.status();
      const unmerged = st.entries.filter((e) => e.kind === 'unmerged');
      const byPath = Object.fromEntries(unmerged.map((e) => [e.path, e]));
      expect(Object.keys(byPath).sort()).toEqual(f.facts.conflictedFiles);
      expect(byPath['content.txt']).toMatchObject({ conflict: 'UU' });
      expect(byPath['add-add.txt']).toMatchObject({ conflict: 'AA' });
      expect(byPath['delete-modify.txt']).toMatchObject({ conflict: 'DU' });
      expect(
        byPath['add-add.txt']!.kind === 'unmerged' && byPath['add-add.txt']!.stages.base,
      ).toBeUndefined();

      const ours = await svc.showFile(':2', 'content.txt');
      const theirs = await svc.showFile(':3', 'content.txt');
      expect(ours.content).toContain('changed on main');
      expect(theirs.content).toContain('changed on feature');

      const wd = await svc.diff({ kind: 'workdir' });
      expect(wd.find((x) => x.newPath === 'content.txt')?.status).toBe('U');
      const ns = await svc.numstat({ kind: 'workdir' });
      expect(ns.filter((x) => x.path === 'content.txt')).toHaveLength(1);
      expect(ns.find((x) => x.path === 'content.txt')?.status).toBe('U');
    });

    it('reports submodule flags', async () => {
      const f = fixture('submodules');
      const svc = await open(f.path);
      const st = await svc.status();
      const lib = st.entries.find((e) => e.path === 'lib');
      expect(lib).toMatchObject({ kind: 'ordinary', submodule: { commitChanged: true } });
      const detail = await svc.commitDetail((await svc.revParse('HEAD'))!);
      expect(detail.subject).toBe('Add lib submodule');
      const d = await svc.diff({ kind: 'commit', sha: (await svc.revParse('HEAD'))! });
      const sub = d.find((x) => x.newPath === 'lib');
      expect(sub?.submodule?.newSha).toMatch(/^[0-9a-f]{40}$/);
      expect(sub?.newMode).toBe('160000');
    });
  });

  describe('refs', () => {
    it('distinguishes annotated and lightweight tags, stash, HEAD', async () => {
      const f = sharedFixture('branchy');
      const svc = await open(f.path);
      const refs = await svc.refs();
      const names = refs.map((r) => r.shortName);
      for (const b of f.facts.branches as string[]) expect(names).toContain(b);
      const v1 = refs.find((r) => r.fullName === 'refs/tags/v1.0')!;
      const lw = refs.find((r) => r.fullName === 'refs/tags/lightweight-tag')!;
      expect(v1.type).toBe('tag');
      expect(v1.tagObjectSha).toMatch(/^[0-9a-f]{40}$/);
      expect(v1.sha).not.toBe(v1.tagObjectSha);
      expect(v1.sha).toBe(await svc.revParse('v1.0'));
      expect(v1.subject).toBe('Release 1.0');
      expect(lw.tagObjectSha).toBeUndefined();
      expect(lw.sha).toBe(await svc.revParse('feature-b'));
      const stash = refs.find((r) => r.type === 'stash')!;
      expect(stash).toMatchObject({ fullName: 'refs/stash', shortName: 'stash' });
      expect(refs.filter((r) => r.isHead).map((r) => r.shortName)).toEqual(['main']);
      expect(refs.find((r) => r.shortName === 'main')!.creatorDate).toBeGreaterThan(1_700_000_000);
    });

    it('computes upstream ahead/behind and origin/HEAD', async () => {
      const f = fixture('remote-pair');
      const svc = await open(f.path);
      const refs = await svc.refs();
      const main = refs.find((r) => r.fullName === 'refs/heads/main')!;
      expect(main.upstream).toEqual({
        fullName: 'refs/remotes/origin/main',
        ahead: 1,
        behind: 1,
        gone: false,
      });
      const originHead = refs.find((r) => r.fullName === 'refs/remotes/origin/HEAD')!;
      expect(originHead).toMatchObject({ type: 'remote', symrefTarget: 'refs/remotes/origin/main' });
      expect(refs.find((r) => r.fullName === 'refs/remotes/origin/main')!.upstream).toBeUndefined();

      const remotes = await svc.remotes();
      expect(remotes).toHaveLength(1);
      expect(remotes[0]).toMatchObject({
        name: 'origin',
        fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
      });
      expect(remotes[0]!.pushUrl).toBe(remotes[0]!.fetchUrl);

      git(f.path, 'update-ref', '-d', 'refs/remotes/origin/main');
      const gone = (await svc.refs()).find((r) => r.fullName === 'refs/heads/main')!;
      expect(gone.upstream?.gone).toBe(true);
      expect((await svc.status()).branch.upstream).toBe('origin/main');
    });

    it('never returns refs/githappens/* and keeps them out of the log', async () => {
      const f = fixture('linear', { count: 5 });
      const svc = await open(f.path);
      const tree = git(f.path, 'rev-parse', 'HEAD^{tree}').trim();
      const hidden = git(f.path, 'commit-tree', tree, '-p', 'HEAD', '-m', 'undo keep-alive').trim();
      git(f.path, 'update-ref', 'refs/githappens/undo/1', hidden);
      expect((await svc.refs()).some((r) => r.fullName.startsWith('refs/githappens/'))).toBe(false);
      const shas = (await allPages(svc, ALL)).map((c) => c.sha);
      expect(shas).toHaveLength(5);
      expect(shas).not.toContain(hidden);
      expect(await svc.search({ kind: 'message', text: 'keep-alive' })).toEqual([]);
      expect(await svc.search({ kind: 'sha', text: hidden.slice(0, 10) })).toEqual([]);
    });
  });

  describe('log', () => {
    it('pages the whole graph including stash tips, with hidden refs excluded', async () => {
      const f = sharedFixture('branchy');
      const svc = await open(f.path);
      const all = await allPages(svc, ALL, 3);
      const shas = new Set(all.map((c) => c.sha));
      expect(shas.size).toBe(all.length);
      const stash = (await svc.stashList())[0]!;
      expect(shas.has(stash.sha)).toBe(true);
      const octopus = all.find((c) => c.subject === 'Octopus merge topics')!;
      expect(octopus.parents).toHaveLength(4);
      expect(all.find((c) => c.subject === 'Initial commit')!.parents).toEqual([]);
      expect(all[0]!.authorEmail).toMatch(/@example\.com$/);

      const hidden = await allPages(svc, {
        ...ALL,
        hiddenRefs: ['refs/heads/feature-b', 'refs/tags/lightweight-tag'],
      });
      expect(hidden.some((c) => c.subject === 'feature-b: WIP')).toBe(false);
      expect(hidden.length).toBe(all.length - 1);
      const hiddenGlob = await allPages(svc, { ...ALL, hiddenRefs: ['refs/heads/cross-*'] });
      expect(hiddenGlob.some((c) => c.subject === 'cross-x: 2')).toBe(false);

      // topo order: children before parents
      const index = new Map(all.map((c, i) => [c.sha, i]));
      for (const c of all)
        for (const p of c.parents) expect(index.get(p)!).toBeGreaterThan(index.get(c.sha)!);
    });

    it('filters by author, grep, paths, follow, first-parent, dates', async () => {
      const f = fixture('linear', { count: 30 });
      const svc = await open(f.path);
      const head: LogQuery = { revs: ['HEAD'], order: 'date' };
      const bob = await allPages(svc, { ...head, author: 'bob@example.com' });
      expect(bob).toHaveLength(10);
      expect(bob.every((c) => c.authorName === 'Bob Example')).toBe(true);
      const two = await allPages(svc, { ...head, author: ['bob@', 'carol@'] });
      expect(two).toHaveLength(20);
      expect(await allPages(svc, { ...head, grep: 'commit 1' })).toHaveLength(11); // 1, 10..19
      expect(await allPages(svc, { ...head, paths: ['src/file3.txt'] })).toHaveLength(3);
      expect(await allPages(svc, { ...head, paths: ['src/file3.txt'], follow: true })).toHaveLength(3);
      expect(await allPages(svc, { ...head, firstParent: true })).toHaveLength(30);
      const commits = await allPages(svc, head);
      const mid = commits[15]!.commitTime;
      const since = await allPages(svc, { ...head, since: mid });
      expect(since).toHaveLength(16);
      expect(await allPages(svc, { ...head, until: mid })).toHaveLength(15);
      expect(await allPages(svc, { ...head, order: 'author-date' })).toHaveLength(30);
    });

    it('dispose kills the process; idle timeout falls back to --skip', async () => {
      const f = fixture('linear', { count: 25 });
      const svc = await open(f.path, { logIdleMs: 50 });
      const c = svc.log({ revs: ['HEAD'], order: 'topo' }) as StreamingLogCursor;
      const p1 = await c.next(10);
      expect(p1.cursor).toBe(c.id);
      expect(svc.getLogCursor(c.id)).toBe(c);
      await new Promise((r) => setTimeout(r, 200));
      const p2 = await c.next(10);
      expect(c.spawnCount).toBe(2);
      const p3 = await c.next(100);
      expect(p3.done).toBe(true);
      expect(p3.cursor).toBeNull();
      const all = [...p1.commits, ...p2.commits, ...p3.commits].map((x) => x.sha);
      expect(new Set(all).size).toBe(25);
      expect(p1.commits[0]!.subject).toBe('Commit 25');
      expect(p2.commits[0]!.subject).toBe('Commit 15');
      expect(svc.getLogCursor(c.id)).toBeUndefined();

      const c2 = svc.log({ revs: 'all', order: 'date' });
      await c2.next(5);
      c2.dispose();
      expect(await c2.next(5)).toEqual({ commits: [], cursor: null, done: true });
    });

    it('rejects revs that look like options', () => {
      const svc = services[0]!;
      const c = svc.log({ revs: ['--output=x'], order: 'date' });
      return expect(c.next(1)).rejects.toMatchObject({ code: 'InvalidRefName' });
    });
  });

  describe('commit detail / diff', () => {
    it('returns body and numstat for normal, root and merge commits', async () => {
      const f = sharedFixture('branchy');
      const svc = await open(f.path);
      const all = await allPages(svc, ALL);
      const merge = all.find((c) => c.subject === "Merge branch 'feature-a'")!;
      const d = await svc.commitDetail(merge.sha);
      expect(d.parents).toHaveLength(2);
      expect(d.files).toEqual([{ path: 'a.txt', status: 'A', additions: 2, deletions: 0, binary: false }]);
      expect(d.body).toBe('');
      const initial = all.find((c) => c.subject === 'Initial commit')!;
      const rd = await svc.commitDetail(initial.sha);
      expect(rd.files.map((x) => x.path).sort()).toEqual(['README.md', 'app.txt']);
      expect(rd.files.find((x) => x.path === 'app.txt')).toMatchObject({ status: 'A', additions: 10 });

      // merge vs second parent
      const vs2 = await svc.diff({ kind: 'commit', sha: merge.sha, parentIndex: 2 });
      expect(vs2.map((x) => x.newPath)).toEqual(['main.txt']);
    });

    it('parses unicode, CRLF, no-EOL, renames, mode changes, binary', async () => {
      const f = fixture('unicode-paths');
      const svc = await open(f.path);
      const head = (await svc.revParse('HEAD'))!;
      const d = await svc.diff({ kind: 'commit', sha: head });
      const by = (p: string) => d.find((x) => x.newPath === p)!;
      expect(d.map((x) => x.newPath).sort()).toEqual([...(f.facts.files as string[])].sort());
      expect(by('crlf.txt').hunks[0]!.lines.map((l) => l.content)).toEqual(['one\r', 'two\r']);
      expect(by('no-eol.txt').noNewlineAtEof).toEqual({ old: false, new: true });
      expect(by('日本語/ファイル.md')).toMatchObject({ status: 'A', additions: 1, oldPath: null });
      expect(by('-leading-dash.txt').status).toBe('A');

      const wd = await svc.diff({ kind: 'workdir', paths: ['ünï cødé.txt'] });
      expect(wd).toHaveLength(1);
      expect(wd[0]!.hunks[0]!.lines).toEqual([
        { type: 'del', content: 'unicode', oldLineNo: 1, patchOffset: 0 },
        { type: 'add', content: 'unicode changed', newLineNo: 1, patchOffset: 1 },
      ]);
      const ut = await svc.diff({ kind: 'untracked', path: 'new 新しい.txt' });
      expect(ut).toHaveLength(1);
      expect(ut[0]).toMatchObject({ status: 'A', newPath: 'new 新しい.txt', additions: 1 });
      expect(await svc.numstat({ kind: 'untracked', path: 'new 新しい.txt' })).toEqual([
        { path: 'new 新しい.txt', status: 'A', additions: 1, deletions: 0, binary: false },
      ]);

      // rename + mode change + binary
      git(f.path, 'mv', 'with space/a b.txt', 'with space/renamed b.txt');
      git(f.path, 'update-index', '--chmod=+x', 'crlf.txt');
      fs.writeFileSync(path.join(f.path, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
      git(f.path, 'add', 'bin.dat');
      const staged = await svc.diff({ kind: 'staged' });
      const ren = staged.find((x) => x.status === 'R')!;
      expect(ren).toMatchObject({
        oldPath: 'with space/a b.txt',
        newPath: 'with space/renamed b.txt',
        similarity: 100,
      });
      expect(staged.find((x) => x.newPath === 'crlf.txt')).toMatchObject({
        oldMode: '100644',
        newMode: '100755',
      });
      expect(staged.find((x) => x.newPath === 'bin.dat')).toMatchObject({ binary: true, hunks: [] });
      const ns = await svc.numstat({ kind: 'staged' });
      expect(ns.find((x) => x.status === 'R')).toMatchObject({ oldPath: 'with space/a b.txt', additions: 0 });
      expect(ns.find((x) => x.path === 'bin.dat')).toMatchObject({ binary: true, additions: null });

      // options: context lines, whitespace, size limit
      const big = await svc.diff({ kind: 'commit', sha: head }, { maxBytesPerFile: 5 });
      expect(big.every((x) => x.tooLarge && x.hunks.length === 0)).toBe(true);
      expect(big.find((x) => x.newPath === 'crlf.txt')!.additions).toBe(2);
      const ctx = await svc.diff(
        { kind: 'range', from: 'HEAD', to: 'HEAD', paths: ['crlf.txt'] },
        { contextLines: 0 },
      );
      expect(ctx).toEqual([]);
    });

    it('shows files via the blob reader and restarts it after a crash', async () => {
      const f = sharedFixture('unicode-paths');
      const svc = await open(f.path);
      const md = await svc.showFile('HEAD', '日本語/ファイル.md');
      expect(md).toEqual({
        content: '# こんにちは\n',
        binary: false,
        size: Buffer.byteLength('# こんにちは\n'),
        encoding: 'utf8',
      });
      expect((await svc.showFile('HEAD', 'with space/a b.txt')).content).toBe('spaces\n');
      expect((await svc.showFile('HEAD', 'crlf.txt')).content).toBe('one\r\ntwo\r\n');
      expect(await svc.showFile('HEAD', 'nope.txt')).toMatchObject({ content: null, missing: true });
      expect(await svc.showFile('HEAD', 'crlf.txt', 3)).toMatchObject({
        content: null,
        tooLarge: true,
        size: 10,
      });

      // concurrent requests are answered in order
      const many = await Promise.all(
        (f.facts.files as string[]).map((p) => svc.showFile('HEAD', p).then((r) => r.content)),
      );
      expect(many).toContain('dash\n');

      // simulate a crash of the cat-file process
      const reader = svc.blobs() as unknown as { proc: { stream: { cancel(): void } } | null };
      reader.proc!.stream.cancel();
      await new Promise((r) => setTimeout(r, 100));
      expect((await svc.showFile('HEAD', 'emoji-😀.txt')).content).toBe('emoji\n');

      const c = fixture('conflict');
      const csvc = await open(c.path);
      const bin = await csvc.showFile('HEAD', 'binary.dat');
      expect(bin).toEqual({
        content: Buffer.from([0, 1, 2, 3, 4, 5, 0xaa]).toString('base64'),
        binary: true,
        size: 7,
        encoding: 'base64',
      });
    });

    it('detects LFS pointers', async (ctx) => {
      let f;
      try {
        f = fixture('lfs');
      } catch (e) {
        if (e instanceof SkipFixture || String(e).includes('lfs')) return ctx.skip();
        throw e;
      }
      const svc = await open(f.path);
      const d = await svc.diff({ kind: 'commit', sha: (await svc.revParse('HEAD'))! });
      const asset = d.find((x) => x.newPath === 'asset.bin')!;
      expect(asset.lfsPointer).toMatchObject({ size: 2048 });
      expect(asset.lfsPointer!.oid).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('search', () => {
    it('searches message, author, sha, file, content and regex', async () => {
      const f = sharedFixture('branchy');
      const svc = await open(f.path);
      const all = await allPages(svc, ALL);
      const octo = all.find((c) => c.subject === 'Octopus merge topics')!;
      // stash commits ("WIP on main: <sha> Octopus merge topics") are part of the rev set too
      const stashShas = new Set(all.filter((c) => /\bon main: /i.test(c.subject)).map((c) => c.sha));
      expect(stashShas.size).toBe(3);
      const octoHits = await svc.search({ kind: 'message', text: 'OCTOPUS' });
      expect(octoHits.filter((s) => !stashShas.has(s))).toEqual([octo.sha]);
      expect(await svc.search({ kind: 'message', text: 'OCTOPUS', caseSensitive: true })).toEqual([]);
      expect(await svc.search({ kind: 'message', text: 'cross-[xy]' })).toEqual([]); // fixed strings
      const bob = await svc.search({ kind: 'author', text: 'Bob Example' });
      expect(bob.length).toBe(all.filter((c) => c.authorName === 'Bob Example').length);
      expect(await svc.search({ kind: 'sha', text: octo.sha.slice(0, 8) })).toEqual([octo.sha]);
      expect(await svc.search({ kind: 'sha', text: 'zz' })).toEqual([]);
      const topic = await svc.search({ kind: 'file', text: 'TOPIC-2' });
      expect(topic).toContain(all.find((c) => c.subject === 'topic-2: work')!.sha);
      const content = await svc.search({ kind: 'content', text: 'a2' });
      expect(content).toEqual([all.find((c) => c.subject === 'feature-a: part 2')!.sha]);
      const regex = await svc.search({ kind: 'regex', text: '^y[12]$' });
      expect(regex.length).toBeGreaterThanOrEqual(2);
      // newest first, limited
      const limited = await svc.search({ kind: 'author', text: 'example.com', limit: 3 });
      expect(limited).toHaveLength(3);
      const times = limited.map((s) => all.find((c) => c.sha === s)!.commitTime);
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('can be aborted', async () => {
      const svc = services[services.length - 1]!;
      const ac = new AbortController();
      ac.abort();
      await expect(svc.search({ kind: 'content', text: 'x' }, ac.signal)).rejects.toMatchObject({
        code: 'Cancelled',
      });
    });
  });

  describe('perf: huge fixture', () => {
    it('first page of 500 is fast and paging yields every commit once', async () => {
      const f = fixture('huge', { count: 20_000 });
      const svc = await open(f.path);
      const t0 = performance.now();
      const c = svc.log({ revs: 'all', order: 'date' });
      const first = await c.next(500);
      const elapsed = performance.now() - t0;
      expect(first.commits).toHaveLength(500);
      // Hosted CI runners are slower and noisier than a dev machine.
      expect(elapsed).toBeLessThan(process.env.CI ? 6000 : 3000);
      const shas = new Set(first.commits.map((x) => x.sha));
      let merges = 0;
      for (;;) {
        const p = await c.next(2000);
        for (const x of p.commits) {
          shas.add(x.sha);
          if (x.parents.length === 2) merges++;
        }
        if (p.done) break;
      }
      expect(shas.size).toBe(20_000);
      expect(merges).toBeGreaterThan(0);
    }, 120_000);
  });
});
