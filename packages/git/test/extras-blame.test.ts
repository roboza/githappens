import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { blameFile, isUncommittedSha, parseBlamePorcelain, unquoteCPath } from '../src/service/extras';
import { describeGit, useHarness } from './ops-harness';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

const GOLDEN = [
  `${A} 1 1 2`,
  'author Alice Example',
  'author-mail <alice@example.com>',
  'author-time 1704067200',
  'author-tz +0000',
  'committer Alice Example',
  'committer-mail <alice@example.com>',
  'committer-time 1704067260',
  'committer-tz +0000',
  'summary Initial commit',
  'boundary',
  'filename dir with space/a b.txt',
  '\tfirst line',
  `${A} 2 2`,
  '\t\tindented second',
  `${B} 2 3 1`,
  'author Bob',
  'author-mail <bob@example.com>',
  'author-time 1704070000',
  'author-tz -0500',
  'committer Bob',
  'committer-mail <bob@example.com>',
  'committer-time 1704070000',
  'committer-tz -0500',
  'summary Change "quoted"',
  `previous ${A} "old \\"name\\" \\303\\274.txt"`,
  'filename "dir with space/a b.txt"',
  '\tthird line\r',
  `${Z} 4 4 1`,
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1704080000',
  'author-tz +0000',
  'committer Not Committed Yet',
  'committer-mail <not.committed.yet>',
  'committer-time 1704080000',
  'committer-tz +0000',
  'summary Version of dir with space/a b.txt from dir with space/a b.txt',
  `previous ${B} dir with space/a b.txt`,
  'filename dir with space/a b.txt',
  '\t',
  '',
].join('\n');

describe('parseBlamePorcelain', () => {
  const r = parseBlamePorcelain(GOLDEN);

  it('parses lines in order with content (tabs kept, CR stripped, empty line kept)', () => {
    expect(r.lines.map((l) => [l.sha[0], l.origLine, l.finalLine, l.content])).toEqual([
      ['a', 1, 1, 'first line'],
      ['a', 2, 2, '\tindented second'],
      ['b', 2, 3, 'third line'],
      ['0', 4, 4, ''],
    ]);
  });

  it('parses commit headers once, boundary and previous', () => {
    expect(Object.keys(r.commits).sort()).toEqual([Z, A, B].sort());
    expect(r.commits[A]).toEqual({
      sha: A,
      author: 'Alice Example',
      authorMail: 'alice@example.com',
      authorTime: 1704067200,
      authorTz: '+0000',
      committer: 'Alice Example',
      committerTime: 1704067260,
      summary: 'Initial commit',
      filename: 'dir with space/a b.txt',
      boundary: true,
    });
    const b = r.commits[B]!;
    expect(b.boundary).toBe(false);
    expect(b.summary).toBe('Change "quoted"');
    expect(b.filename).toBe('dir with space/a b.txt');
    expect(b.previous).toEqual({ sha: A, path: 'old "name" ü.txt' });
    expect(r.commits[Z]!.author).toBe('Not Committed Yet');
    expect(r.commits[Z]!.previous).toEqual({ sha: B, path: 'dir with space/a b.txt' });
    expect(isUncommittedSha(Z)).toBe(true);
    expect(isUncommittedSha(A)).toBe(false);
  });

  it('handles empty output', () => {
    expect(parseBlamePorcelain('')).toEqual({ commits: {}, lines: [] });
  });
});

describe('unquoteCPath', () => {
  it('unquotes C-style paths with octal UTF-8 bytes', () => {
    expect(unquoteCPath('plain name.txt')).toBe('plain name.txt');
    expect(unquoteCPath('"a\\tb\\nc\\\\d\\"e"')).toBe('a\tb\nc\\d"e');
    expect(unquoteCPath('"\\346\\227\\245\\346\\234\\254.txt"')).toBe('日本.txt');
    expect(unquoteCPath('"emoji-😀 \\"x\\""')).toBe('emoji-😀 "x"');
  });
});

describeGit('blameFile (fixtures)', () => {
  const h = useHarness('blame');

  it('blames a committed file at HEAD, a revision and the working tree', async () => {
    const fx = h.fixture('linear', { count: 5 });
    const svc = await h.open(fx.path);
    const r = await blameFile(svc, 'README.md');
    expect(r.lines.map((l) => l.content)).toEqual(['# Linear', '', 'revision 5']);
    const first = r.commits[r.lines[0]!.sha]!;
    expect(first.summary).toBe('Commit 1');
    expect(first.boundary).toBe(true);
    expect(first.filename).toBe('README.md');
    const last = r.commits[r.lines[2]!.sha]!;
    expect(last.summary).toBe('Commit 5');
    expect(last.previous?.path).toBe('README.md');
    expect(last.authorTime).toBeGreaterThan(0);

    const old = await blameFile(svc, 'README.md', 'HEAD~2');
    expect(old.lines[2]!.content).toBe('revision 3');
    expect(old.commits[old.lines[2]!.sha]!.summary).toBe('Commit 3');

    h.write(path.join(fx.path, 'README.md'), '# Linear\n\nrevision 5\nlocal edit\n');
    const wt = await blameFile(svc, 'README.md');
    expect(wt.lines).toHaveLength(4);
    expect(isUncommittedSha(wt.lines[3]!.sha)).toBe(true);
    expect(wt.lines[3]!.content).toBe('local edit');
  });

  it('works for paths with spaces, unicode and emoji', async () => {
    const fx = h.fixture('unicode-paths');
    const svc = await h.open(fx.path);
    for (const p of ['with space/a b.txt', '日本語/ファイル.md', 'emoji-😀.txt', '-leading-dash.txt']) {
      const r = await blameFile(svc, p, 'HEAD');
      expect(r.lines.length).toBeGreaterThan(0);
      expect(r.commits[r.lines[0]!.sha]!.filename).toBe(p);
    }
    // modified in the working tree → uncommitted line
    const u = await blameFile(svc, 'ünï cødé.txt');
    expect(u.lines.map((l) => l.content)).toEqual(['unicode changed']);
    expect(isUncommittedSha(u.lines[0]!.sha)).toBe(true);
    // CRLF content is returned without the CR
    const crlf = await blameFile(svc, 'crlf.txt', 'HEAD');
    expect(crlf.lines.map((l) => l.content)).toEqual(['one', 'two']);
  });

  it('supports -w and line ranges, and rejects option-looking revs', async () => {
    const fx = h.fixture('linear', { count: 3 });
    const svc = await h.open(fx.path);
    const r = await blameFile(svc, 'README.md', undefined, {
      ignoreWhitespace: true,
      range: { start: 3, end: 3 },
    });
    expect(r.lines.map((l) => l.finalLine)).toEqual([3]);
    await expect(blameFile(svc, 'README.md', '--output=x')).rejects.toThrow();
  });
});
