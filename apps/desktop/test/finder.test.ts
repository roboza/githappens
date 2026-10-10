import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FilesFinder, LS_FILES_ARGS, parseLsFilesZ } from '../src/main/finder/files-finder';
import {
  fileEnterAction,
  FINDER_LIMIT,
  rankFiles,
  scoreFile,
  WORKER_THRESHOLD,
} from '../src/renderer/src/views/finder/finder-score';
import {
  FILE_MRU_MAX,
  finderRepoKey,
  getFileMru,
  recordFileMru,
} from '../src/renderer/src/views/finder/finder-mru';

describe('ls-files -z parsing (spec 12 §6.8)', () => {
  it('keeps unicode, spaces, quotes and newlines verbatim and drops duplicates', () => {
    const out = [
      'src/a.ts',
      'docs/naïve résumé.md',
      'emoji/🐙.txt',
      'odd/"quoted" name',
      'nl/line\nbreak.txt',
      'src/a.ts',
      '',
    ].join('\0');
    expect(parseLsFilesZ(out)).toEqual([
      'src/a.ts',
      'docs/naïve résumé.md',
      'emoji/🐙.txt',
      'odd/"quoted" name',
      'nl/line\nbreak.txt',
    ]);
    expect(parseLsFilesZ('')).toEqual([]);
  });

  it('caches per repo, shares in-flight reads and drops the cache on worktree changes', async () => {
    let n = 0;
    const read = vi.fn(async () => `f${++n}.txt\0`);
    const finder = new FilesFinder({ read });
    const [a, b] = await Promise.all([finder.list('r1'), finder.list('r1')]);
    expect(a).toEqual(['f1.txt']);
    expect(b).toBe(a);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('r1', [...LS_FILES_ARGS]);
    expect(await finder.list('r1')).toEqual(['f1.txt']);
    finder.onRepoChanged('r1', ['remotes']);
    expect(await finder.list('r1')).toEqual(['f1.txt']);
    finder.onRepoChanged('r1', ['status']);
    expect(await finder.list('r1')).toEqual(['f2.txt']);
    expect(await finder.list('r1', true)).toEqual(['f3.txt']);
    expect(await finder.list('r2')).toEqual(['f4.txt']);
  });

  it('does not cache a list invalidated while git was running, nor a failure', async () => {
    let release!: (s: string) => void;
    const read = vi
      .fn<(id: string, args: string[]) => Promise<string>>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('new.txt\0');
    const finder = new FilesFinder({ read });
    const first = finder.list('r');
    finder.invalidate('r');
    release('old.txt\0');
    expect(await first).toEqual(['old.txt']);
    await expect(finder.list('r')).rejects.toThrow('boom');
    expect(await finder.list('r')).toEqual(['new.txt']);
  });

  it('lists tracked + untracked, not ignored, files of a real repository', () => {
    let git: string;
    try {
      git = execFileSync('git', ['--version'], { encoding: 'utf8' }) && 'git';
    } catch {
      return; // no git on PATH
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-finder-'));
    try {
      const run = (...args: string[]): string =>
        execFileSync(git, ['-C', dir, ...args], {
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
        });
      run('init', '-q');
      fs.mkdirSync(path.join(dir, 'sub dir'));
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'a');
      fs.writeFileSync(path.join(dir, 'sub dir', 'naïve 🐙.md'), 'b');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
      fs.writeFileSync(path.join(dir, 'ignored.log'), 'x');
      if (process.platform !== 'win32') fs.writeFileSync(path.join(dir, 'line\nbreak.txt'), 'c');
      run('add', 'tracked.txt');
      const files = parseLsFilesZ(run(...LS_FILES_ARGS)).sort();
      const expected = ['.gitignore', 'sub dir/naïve 🐙.md', 'tracked.txt'];
      if (process.platform !== 'win32') expected.push('line\nbreak.txt');
      expect(files).toEqual(expected.sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('finder scoring + MRU (spec 12 §4.8)', () => {
  const files = [
    'src/renderer/src/App.tsx',
    'src/renderer/src/shell/TitleBar.tsx',
    'src/main/index.ts',
    'docs/app-shell.md',
    'test/app.test.ts',
    'README.md',
  ];

  it('prefers file-name matches and shorter paths', () => {
    const r = rankFiles(files, 'app').map((m) => m.path);
    // Name matches first (equal scores: the shorter path wins), then path-only matches.
    expect(r.slice(0, 3)).toEqual(['test/app.test.ts', 'docs/app-shell.md', 'src/renderer/src/App.tsx']);
    expect(r).not.toContain('src/main/index.ts');
    expect(rankFiles(files, 'titlebar')[0]!.path).toBe('src/renderer/src/shell/TitleBar.tsx');
    expect(rankFiles(files, 'srmi')[0]!.path).toBe('src/main/index.ts');
    expect(rankFiles(files, 'zzz')).toEqual([]);
  });

  it('boosts recently opened files and lists them first for an empty query', () => {
    const mru = ['test/app.test.ts'];
    expect(rankFiles(files, 'app', mru)[0]!.path).toBe('test/app.test.ts');
    expect(rankFiles(files, '', ['README.md', 'gone.txt']).map((m) => m.path)).toEqual([
      'README.md',
      ...files.filter((f) => f !== 'README.md'),
    ]);
    expect(scoreFile('app', 'test/app.test.ts', mru)!).toBeGreaterThan(scoreFile('app', 'test/app.test.ts')!);
  });

  it('caps results and keeps large lists fast', () => {
    const big = Array.from({ length: WORKER_THRESHOLD }, (_, i) => `pkg${i % 50}/src/module${i}/file${i}.ts`);
    const t0 = performance.now();
    const r = rankFiles(big, 'file123');
    const ms = performance.now() - t0;
    expect(r).toHaveLength(FINDER_LIMIT);
    expect(r[0]!.path).toBe('pkg23/src/module123/file123.ts');
    expect(ms).toBeLessThan(5_000);
  });

  it('maps Enter modifiers to actions', () => {
    const k = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(fileEnterAction(k)).toBe('file.open');
    expect(fileEnterAction({ ...k, ctrlKey: true })).toBe('history.file');
    expect(fileEnterAction({ ...k, metaKey: true })).toBe('history.file');
    expect(fileEnterAction({ ...k, altKey: true })).toBe('history.blame');
    expect(fileEnterAction({ ...k, shiftKey: true })).toBe('file.edit');
  });

  it('keeps an MRU per repository (in memory without localStorage)', () => {
    const a = finderRepoKey('C:\\Repos\\App\\');
    expect(a).toBe(finderRepoKey('c:/repos/app'));
    const b = finderRepoKey('/other');
    recordFileMru(a, 'one.ts');
    recordFileMru(a, 'two.ts');
    recordFileMru(a, 'one.ts');
    recordFileMru(b, 'x.ts');
    expect(getFileMru(a)).toEqual(['one.ts', 'two.ts']);
    expect(getFileMru(b)).toEqual(['x.ts']);
    for (let i = 0; i < FILE_MRU_MAX + 5; i++) recordFileMru(b, `f${i}`);
    expect(getFileMru(b)).toHaveLength(FILE_MRU_MAX);
  });
});
