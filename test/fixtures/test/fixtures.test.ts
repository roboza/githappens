import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { makeFixture, SkipFixture, type FixtureName } from '../src';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fixtures-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' }).trimEnd();

const EOL = '\n';
const make = (name: FixtureName, options = {}) => makeFixture(name, { root, force: true, options });

describe('fixtures', () => {
  it('linear: N commits with a tag', () => {
    const r = make('linear', { count: 60 });
    expect(git(r.path, 'rev-list', '--count', 'HEAD')).toBe('60');
    expect(git(r.path, 'rev-list', '-n1', 'v1.0')).toBe(git(r.path, 'rev-parse', `HEAD~${r.facts.tagBack}`));
  });

  it('is deterministic (same SHAs on every run)', () => {
    const a = make('linear', { count: 5 }).facts.head;
    const b = make('linear', { count: 5 }).facts.head;
    expect(a).toBe(b);
  });

  it('branchy: merges, octopus, criss-cross, tags, stash', () => {
    const r = make('branchy');
    const merges = git(r.path, 'rev-list', '--all', '--min-parents=2', '--format=%P', '--no-commit-header')
      .split('\n')
      .map((l) => l.split(' ').length);
    expect(merges).toContain(4); // octopus: 1 + 3 topics
    expect(merges.filter((n) => n === 2).length).toBeGreaterThanOrEqual(3); // feature-a + criss-cross pair
    const branches = git(r.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
    expect(branches.sort()).toEqual([...(r.facts.branches as string[])].sort());
    expect(git(r.path, 'tag').split('\n').sort()).toEqual(['lightweight-tag', 'v1.0']);
    expect(git(r.path, 'cat-file', '-t', 'v1.0')).toBe('tag');
    expect(git(r.path, 'stash', 'list')).toMatch(/WIP on app/);
    // criss-cross: two merge bases
    expect(git(r.path, 'merge-base', '--all', 'cross-x', 'cross-y').split('\n')).toHaveLength(2);
  });

  it('conflict: merge stops with every conflict type', () => {
    const r = make('conflict-in-progress');
    expect(fs.existsSync(path.join(r.path, '.git', 'MERGE_HEAD'))).toBe(true);
    const unmerged = git(r.path, 'diff', '--name-only', '--diff-filter=U').split('\n').sort();
    expect(unmerged).toEqual(r.facts.conflictedFiles);
  });

  it('conflict: branches left unmerged when not in progress', () => {
    const r = make('conflict');
    expect(fs.existsSync(path.join(r.path, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(r.path, 'status', '--porcelain')).toBe('');
  });

  it('empty: unborn branch', () => {
    const r = make('empty');
    expect(git(r.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(() => git(r.path, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow();
  });

  it('bare: is bare with history', () => {
    const r = make('bare');
    expect(git(r.path, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(r.path, 'rev-list', '--count', 'main')).toBe('2');
  });

  it('remote-pair: local is 1 ahead and 1 behind', () => {
    const r = make('remote-pair');
    expect(git(r.path, 'rev-list', '--left-right', '--count', 'main...origin/main')).toBe('1\t1');
  });

  it('unicode-paths: tracked, modified and untracked tricky names', () => {
    const r = make('unicode-paths');
    const tracked = git(r.path, 'ls-files', '-z').split('\0').filter(Boolean);
    for (const f of r.facts.files as string[]) expect(tracked).toContain(f);
    const status = git(r.path, 'status', '--porcelain=v1', '-z').split('\0');
    expect(status).toContain(' M ünï cødé.txt');
    expect(status).toContain('?? new 新しい.txt');
    expect(fs.readFileSync(path.join(r.path, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
  });

  it('submodules: nested, with the top-level one out of sync', () => {
    const r = make('submodules');
    const status = git(r.path, 'submodule', 'status', '--recursive');
    expect(status).toMatch(/^\+\w+ lib/m); // + = checked-out commit differs from recorded
    expect(status).toMatch(/lib\/vendor\/leaf/);
  });

  it('worktrees: two linked worktrees', () => {
    const r = make('worktrees');
    const list = git(r.path, 'worktree', 'list', '--porcelain');
    expect(list.match(/^worktree /gm)).toHaveLength(3);
    expect(list).toMatch(/branch refs\/heads\/feature/);
    expect(list).toMatch(/^detached$/m);
  });

  it('huge: fast-import produces the requested count with periodic merges', () => {
    const r = make('huge', { count: 1000 });
    expect(git(r.path, 'rev-list', '--count', 'main')).toBe('1000');
    expect(git(r.path, 'rev-list', '--count', '--all')).toBe('1000'); // every commit reachable from main
    expect(Number(git(r.path, 'rev-list', '--count', '--merges', 'main'))).toBeGreaterThan(5);
    expect(git(r.path, 'status', '--porcelain')).toBe('');
    expect(git(r.path, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
    expect(fs.existsSync(path.join(r.path, '.git', 'objects', 'info', 'commit-graph'))).toBe(true);
  });

  it('huge: branchy (concurrent lanes) and deterministic', () => {
    const a = make('huge', { count: 600, lanes: 6, commitGraph: false });
    expect(fs.existsSync(path.join(a.path, '.git', 'objects', 'info', 'commit-graph'))).toBe(false);
    // a good share of history lives on topic branches (off main's first-parent line)
    const firstParentLine = new Set(git(a.path, 'rev-list', '--first-parent', 'main').split(EOL));
    const offMain = Number(git(a.path, 'rev-list', '--count', 'main')) - firstParentLine.size;
    expect(offMain).toBeGreaterThan(100);
    const b = make('huge', { count: 600, lanes: 6, commitGraph: false });
    expect(b.facts.head).toBe(a.facts.head);
  });

  it('files-100k: N tracked files, clean worktree (small variant)', () => {
    const r = make('files-100k', { files: 1234 });
    expect(Number(git(r.path, 'ls-files', '--', '.').split(EOL).length)).toBe(1235);
    expect(git(r.path, 'rev-list', '--count', 'HEAD')).toBe('2');
    for (const f of r.facts.sample as string[]) expect(fs.existsSync(path.join(r.path, f))).toBe(true);
    expect(git(r.path, 'status', '--porcelain')).toBe('');
  });

  it('branches-5k: local branches with upstream tracking + remote-tracking refs (small variant)', () => {
    const r = make('branches-5k', { branches: 50, commits: 40, tags: 5 });
    const count = (pattern: string) =>
      git(r.path, 'for-each-ref', '--format=%(refname)', pattern).split(EOL).filter(Boolean).length;
    expect(count('refs/heads')).toBe(51); // + main
    expect(count('refs/remotes')).toBe(51); // + origin/main
    expect(count('refs/tags')).toBe(5);
    const track = git(
      r.path,
      'for-each-ref',
      '--format=%(upstream:short) %(upstream:track)',
      'refs/heads/feature',
    )
      .split(EOL)
      .filter(Boolean);
    expect(track).toHaveLength(50);
    expect(track.every((l) => l.startsWith('origin/feature/'))).toBe(true);
    expect(track.some((l) => /ahead \d/.test(l))).toBe(true);
    expect(track.some((l) => /behind \d/.test(l))).toBe(true);
    expect(git(r.path, 'status', '--porcelain')).toBe('');
  });

  it('lfs: tracks binaries when git-lfs is present', () => {
    try {
      const r = make('lfs');
      expect(git(r.path, 'lfs', 'ls-files', '--name-only')).toBe('asset.bin');
    } catch (e) {
      if (!(e instanceof SkipFixture)) throw e;
    }
  });
});
