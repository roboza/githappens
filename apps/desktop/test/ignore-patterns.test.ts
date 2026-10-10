import fs from 'node:fs';
import path from 'node:path';

import {
  createOpRegistry,
  OperationQueue,
  parseEolWarnings,
  type GitOperation,
  type GitService,
} from '@githappens/git';
import {
  escapeIgnoreLiteral,
  extensionOf,
  ignorePatternFor,
  parseCheckIgnore,
  pathOfAnchoredPattern,
  unescapeIgnoreLiteral,
} from '@githappens/git/ops';
import { describe, expect, it, vi } from 'vitest';

import { gitPath, useTestRepos } from './ai-test-repo';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('gitignore escaping (spec 06 §6.7)', () => {
  it.each([
    ['plain.txt', 'plain.txt'],
    ['#notes', '\\#notes'],
    ['!important', '\\!important'],
    ['a*b', 'a\\*b'],
    ['what?', 'what\\?'],
    ['[draft].md', '\\[draft].md'],
    ['back\\slash', 'back\\\\slash'],
    ['trailing  ', 'trailing\\ \\ '],
    ['mid dle', 'mid dle'],
    ['a#b!c', 'a#b!c'],
  ])('%s → %s', (input, out) => {
    expect(escapeIgnoreLiteral(input)).toBe(out);
    expect(unescapeIgnoreLiteral(out)).toBe(input);
  });

  it('builds file / extension / folder patterns', () => {
    expect(ignorePatternFor('file', 'src/#gen/[x].ts')).toBe('/src/\\#gen/\\[x].ts');
    expect(ignorePatternFor('file', 'a\\b.txt')).toBe('/a/b.txt');
    expect(ignorePatternFor('extension', 'src/x.Log')).toBe('*.Log');
    expect(ignorePatternFor('extension', 'src/Makefile')).toBeNull();
    expect(ignorePatternFor('extension', '.env')).toBeNull();
    expect(ignorePatternFor('folder', 'build/out/a.o')).toBe('/build/out/');
    expect(ignorePatternFor('folder', 'top.txt')).toBeNull();
    expect(extensionOf('a/b.tar.gz')).toBe('gz');
  });

  it('maps anchored patterns back to paths and parses check-ignore -v', () => {
    expect(pathOfAnchoredPattern('/src/\\[x].ts')).toBe('src/[x].ts');
    expect(pathOfAnchoredPattern('/build/')).toBe('build/');
    expect(pathOfAnchoredPattern('*.log')).toBeNull();
    expect(pathOfAnchoredPattern('/src/*.ts')).toBeNull();
    expect(parseCheckIgnore('.gitignore:3:*.log\tdir/x.log')).toEqual({
      source: '.gitignore',
      line: 3,
      pattern: '*.log',
      path: 'dir/x.log',
    });
    expect(parseCheckIgnore('C:/Users/me/.config/git/ignore:1:/x\tx')?.source).toBe(
      'C:/Users/me/.config/git/ignore',
    );
    expect(parseCheckIgnore('garbage')).toBeNull();
  });

  it('parses EOL conversion warnings from git add', () => {
    expect(
      parseEolWarnings(
        "warning: in the working copy of 'a b.txt', LF will be replaced by CRLF the next time Git touches it\n" +
          'warning: CRLF will be replaced by LF in src/x.c.\nThe file will have its original line endings\n' +
          "warning: in the working copy of 'a b.txt', LF will be replaced by CRLF the next time Git touches it\n",
      ),
    ).toEqual([
      { path: 'a b.txt', kind: 'lf-to-crlf' },
      { path: 'src/x.c', kind: 'crlf-to-lf' },
    ]);
    expect(parseEolWarnings('')).toEqual([]);
  });
});

const describeGit = gitPath ? describe : describe.skip;

describeGit('wip.ignore against real git', () => {
  const repos = useTestRepos('ignore');
  const run = (svc: GitService, op: GitOperation) =>
    new OperationQueue(svc, createOpRegistry()).enqueue(op).done;
  const ignored = (r: { git(...a: string[]): string }, p: string): boolean => {
    try {
      r.git('check-ignore', '-q', '--no-index', '--', p);
      return true;
    } catch {
      return false;
    }
  };

  it('escaped file patterns ignore exactly that file', async () => {
    const r = await repos.make();
    const names = [
      '#notes.txt',
      '!bang.txt',
      '[draft].md',
      'what?.txt',
      'star*.txt',
      'sub/#x/a b.txt',
    ].filter((n) => process.platform !== 'win32' || !/[*?]/.test(n));
    for (const n of names) r.write(n, 'x\n');
    r.write('d.txt', 'x\n'); // would match an unescaped `[draft].md` / `what?.txt`-style glob
    r.write('whatX.txt', 'x\n');
    r.write('starZ.txt', 'x\n');
    for (const n of names) await run(r.svc, { type: 'wip.ignore', pattern: ignorePatternFor('file', n)! });
    for (const n of names) expect(ignored(r, n), n).toBe(true);
    for (const n of ['d.txt', 'whatX.txt', 'starZ.txt']) expect(ignored(r, n), n).toBe(false);
  });

  it('reports "already ignored by <file>:<line>" instead of duplicating, and stops tracking', async () => {
    const r = await repos.make({ 'README.md': 'x\n', '.gitignore': '# c\nbuild/\n', 'keep.txt': 'k\n' });
    fs.mkdirSync(path.join(r.dir, 'build'));
    r.write('build/out.o', 'o');
    const res = await run(r.svc, { type: 'wip.ignore', pattern: ignorePatternFor('file', 'build/out.o')! });
    expect(res.data).toEqual({ alreadyIgnored: { source: '.gitignore', line: 2, pattern: 'build/' } });
    expect(res.warnings?.[0]).toBe('Already ignored by .gitignore:2 (build/).');
    expect(fs.readFileSync(path.join(r.dir, '.gitignore'), 'utf8')).toBe('# c\nbuild/\n');

    // Ignore and stop tracking: appended (CRLF style kept) + removed from the index, file stays on disk
    fs.writeFileSync(path.join(r.dir, '.gitignore'), '# c\r\nbuild/');
    await run(r.svc, { type: 'wip.ignore', pattern: '/keep.txt', stopTracking: ['keep.txt'] });
    expect(fs.readFileSync(path.join(r.dir, '.gitignore'), 'utf8')).toBe('# c\r\nbuild/\r\n/keep.txt\r\n');
    expect(r.git('diff', '--cached', '--name-status')).toContain('D\tkeep.txt');
    expect(fs.existsSync(path.join(r.dir, 'keep.txt'))).toBe(true);
  });
});
