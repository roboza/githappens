import { execFileSync } from 'node:child_process';

import { isolatedEnv } from '@githappens/fixtures';
import { describe, expect, it } from 'vitest';

import { blameFile } from '../src/service/extras';
import {
  blameIncremental,
  blobInfo,
  combinedDiff,
  fileHistory,
  filePatch,
  lsTree,
  mergeBase,
  parseFileHistory,
  parseLfsPointer,
  submoduleLog,
  type BlameChunk,
} from '../src/service/file-views';
import { describeGit, gitPath, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describe('parseFileHistory', () => {
  it('parses -z records with renames, newline/tab/unicode paths and missing name-status', () => {
    const rec = (sha: string, subject: string, status: string): string =>
      `\x1e${sha}\x00p1 p2\x00Ann\x00ann@x\x00100\x00${subject}\x00\x00\n${status}`;
    const out = parseFileHistory(
      rec('c'.repeat(40), 'third', 'M\x00dir/new\nname\t日本.txt\x00') +
        rec('b'.repeat(40), 'second', 'R087\x00old.txt\x00dir/new\nname\t日本.txt\x00') +
        `\x1e${'a'.repeat(40)}\x00\x00Ann\x00ann@x\x00100\x00merge without entries\x00\x00` +
        rec('d'.repeat(40), 'first', 'A\x00old.txt\x00'),
      'dir/new\nname\t日本.txt',
    );
    expect(out.map((e) => [e.subject, e.status, e.path, e.oldPath, e.similarity])).toEqual([
      ['third', 'M', 'dir/new\nname\t日本.txt', undefined, undefined],
      ['second', 'R', 'dir/new\nname\t日本.txt', 'old.txt', 87],
      ['merge without entries', 'M', 'old.txt', undefined, undefined],
      ['first', 'A', 'old.txt', undefined, undefined],
    ]);
    expect(out[0]!.parents).toEqual(['p1', 'p2']);
    expect(out[2]!.parents).toEqual([]);
  });
});

describe('parseLfsPointer', () => {
  it('parses spec v1 pointers only', () => {
    const oid = 'a'.repeat(64);
    expect(
      parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 4242\n`),
    ).toEqual({
      oid,
      size: 4242,
    });
    expect(parseLfsPointer('hello')).toBeNull();
    expect(parseLfsPointer(null)).toBeNull();
  });
});

describeGit('spec 07 service reads (real repos)', () => {
  const h = useHarness('file-history');

  async function open(r: TinyRepo): Promise<TinyRepo> {
    r.svc = await h.open(r.dir);
    return r;
  }

  /** Commit a path git can store but Windows can't create (tabs/newlines) straight into the index. */
  function commitIndexOnly(r: TinyRepo, p: string, content: string, message: string): void {
    const sha = execFileSync(gitPath!, ['hash-object', '-w', '--stdin'], {
      cwd: r.dir,
      input: content,
      env: isolatedEnv(h.root),
      windowsHide: true,
    })
      .toString()
      .trim();
    // Git for Windows refuses control characters in paths unless core.protectNTFS is off
    r.g('-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${sha},${p}`);
    r.g('-c', 'core.protectNTFS=false', 'commit', '-q', '-m', message);
  }

  it('follows a file through two renames, paginates, and stops at renames without --follow', async () => {
    const r = await open(await tinyRepo(h, { 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' }));
    r.commit('edit a', { 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n' });
    r.g('mv', 'a.txt', 'b.txt');
    r.commit('rename to b', {});
    r.g('mv', 'b.txt', 'c.txt');
    r.commit('rename to c', { 'c.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n' });

    const page = await fileHistory(r.svc, { path: 'c.txt' });
    expect(page.hasMore).toBe(false);
    expect(page.entries.map((e) => [e.subject, e.status, e.path, e.oldPath])).toEqual([
      ['rename to c', 'R', 'c.txt', 'b.txt'],
      ['rename to b', 'R', 'b.txt', 'a.txt'],
      ['edit a', 'M', 'a.txt', undefined],
      ['Base', 'A', 'a.txt', undefined],
    ]);

    const first = await fileHistory(r.svc, { path: 'c.txt', limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await fileHistory(r.svc, { path: 'c.txt', limit: 2, skip: 2 });
    expect(second.entries.map((e) => e.subject)).toEqual(['edit a', 'Base']);

    const noFollow = await fileHistory(r.svc, { path: 'c.txt', follow: false });
    expect(noFollow.entries.map((e) => e.subject)).toEqual(['rename to c']);
  });

  it('handles unicode, tab and newline paths through history, diff and blame', async () => {
    const r = await open(await tinyRepo(h));
    const weird = 'dir/new\nline\tand 日本 😀.txt';
    commitIndexOnly(r, weird, 'alpha\nbeta\n', 'add weird');
    commitIndexOnly(r, weird, 'alpha\nBETA\ngamma\n', 'edit weird');

    const hist = await fileHistory(r.svc, { path: weird });
    expect(hist.entries.map((e) => [e.subject, e.path])).toEqual([
      ['edit weird', weird],
      ['add weird', weird],
    ]);

    const head = r.rev('HEAD');
    const [file] = await r.svc.diff({ kind: 'commit', sha: head, paths: [weird] });
    expect(file!.newPath).toBe(weird);
    expect(file!.hunks[0]!.lines.filter((l) => l.type === 'add').map((l) => l.content)).toEqual([
      'BETA',
      'gamma',
    ]);

    const blame = await blameFile(r.svc, weird, 'HEAD');
    expect(blame.lines.map((l) => l.content)).toEqual(['alpha', 'BETA', 'gamma']);
    expect(blame.commits[blame.lines[1]!.sha]!.filename).toBe(weird);

    const chunks: BlameChunk[] = [];
    await blameIncremental(r.svc, weird, 'HEAD', {}, (c) => chunks.push(c), 0);
    const lines = chunks.flatMap((c) => c.lines).sort((a, b) => a.finalLine - b.finalLine);
    expect(lines.map((l) => l.sha)).toEqual(blame.lines.map((l) => l.sha));
    const commits = Object.assign({}, ...chunks.map((c) => c.commits));
    expect(commits[lines[0]!.sha].summary).toBe('add weird');
    expect(commits[lines[0]!.sha].filename).toBe(weird);

    const patch = await filePatch(r.svc, head, [weird]);
    expect(patch).toContain('Subject: [PATCH] edit weird');
    expect(patch).toContain('+gamma');
    expect(await lsTree(r.svc, head)).toContain(weird);
  });

  it('streams incremental blame identical to porcelain blame, with -w/-M/-C and working-copy lines', async () => {
    const r = await open(await tinyRepo(h, { 'f.txt': 'a\nb\nc\n' }));
    r.commit('second', { 'f.txt': 'a\nB\nc\nd\n' });
    h.write(`${r.dir}/f.txt`, 'a\nB\nc\nd\nlocal\n');
    const porcelain = await blameFile(r.svc, 'f.txt');
    const chunks: BlameChunk[] = [];
    await blameIncremental(
      r.svc,
      'f.txt',
      undefined,
      { ignoreWhitespace: true, detectMoves: true, detectCopies: true },
      (c) => chunks.push(c),
      0,
    );
    const lines = chunks.flatMap((c) => c.lines).sort((a, b) => a.finalLine - b.finalLine);
    expect(lines.map((l) => [l.finalLine, l.sha])).toEqual(porcelain.lines.map((l) => [l.finalLine, l.sha]));
    expect(/^0+$/.test(lines[4]!.sha)).toBe(true);
  });

  it('combined (--cc) diff lists only conflict-resolved files of a merge', async () => {
    const r = await open(await tinyRepo(h, { 'x.txt': 'base\n', 'clean.txt': 'c\n' }));
    r.g('checkout', '-q', '-b', 'side');
    r.commit('side', { 'x.txt': 'side\n', 'side-only.txt': 's\n' });
    r.g('checkout', '-q', '-');
    r.commit('main', { 'x.txt': 'main\n' });
    try {
      r.g('merge', '-q', '--no-edit', 'side');
    } catch {
      /* conflict expected */
    }
    h.write(`${r.dir}/x.txt`, 'resolved\n');
    r.g('add', '-A');
    r.g('commit', '-q', '--no-edit');
    const merge = r.rev('HEAD');
    const files = await combinedDiff(r.svc, merge);
    expect(files.map((f) => f.path)).toEqual(['x.txt']);
    const lines = files[0]!.hunks.flatMap((hk) => hk.lines);
    expect(lines.some((l) => l.prefix === '++' && l.content === 'resolved')).toBe(true);
    expect(await combinedDiff(r.svc, merge, ['clean.txt'])).toEqual([]);

    // three-dot base and parent-2 diffs
    expect(await mergeBase(r.svc, 'HEAD~1', 'side')).toBe(r.rev('HEAD~1~1'));
    const vsSecond = await r.svc.numstat({ kind: 'commit', sha: merge, parentIndex: 2 });
    expect(vsSecond.map((f) => f.path).sort()).toEqual(['x.txt']);
  });

  it('blobInfo reports sizes, absence and LFS pointers; submoduleLog handles uninitialized paths', async () => {
    const oid = 'b'.repeat(64);
    const ptr = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`;
    const r = await open(await tinyRepo(h, { 'big.bin': ptr, 'plain.txt': 'hello\n' }));
    expect(await blobInfo(r.svc, 'HEAD', 'plain.txt')).toEqual({ exists: true, size: 6 });
    expect(await blobInfo(r.svc, 'HEAD', 'nope.txt')).toEqual({ exists: false, size: 0 });
    expect(await blobInfo(r.svc, '', 'plain.txt')).toEqual({ exists: false, size: 0 });
    const lfs = await blobInfo(r.svc, ':worktree', 'big.bin');
    expect(lfs.lfs).toEqual({ oid, size: 12345, available: false });
    await expect(blobInfo(r.svc, ':worktree', '../outside.txt')).rejects.toThrow(/Invalid path/);
    expect(await submoduleLog(r.svc, 'libs/none', 'a'.repeat(40), 'c'.repeat(40))).toEqual({
      initialized: false,
      ahead: 0,
      behind: 0,
      commits: [],
    });
  });
});
