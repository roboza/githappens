import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findOnPath, GitProcessRunner } from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pickReadme, parseCountObjects, repoDetails } from '../src/main/repos/details';
import {
  byRecency,
  createOpenFileQueue,
  createOsRecents,
  droppedPathFromUrl,
  jumpListTasks,
} from '../src/main/repos/os-integration';
import {
  addSafeDirectory,
  assertSafeDirectoryValue,
  safeDirectoryFor,
} from '../src/main/repos/safe-directory';
import { inspectTarget, validateRepoPath } from '../src/main/repos/validate';
import { hasEmbeddedCredentials, parseTransfer } from '../src/shared/ipc/repos2-contract';
import type { RepoRecord } from '../src/shared/ipc/shell-contract';

const gitPath = findOnPath('git');
const describeGit = gitPath ? describe : describe.skip;

let root: string;
let env: NodeJS.ProcessEnv;
let runner: GitProcessRunner;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(gitPath!, args, { cwd, env, encoding: 'utf8', windowsHide: true });

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-repos-main-')));
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '[user]\n\tname = T\n\temail = t@e\n');
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  if (gitPath) runner = new GitProcessRunner({ context: () => ({ gitPath, baseEnv: env, bundled: false }) });
});
afterAll(() => {
  runner?.killAll();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('pure helpers', () => {
  it('parses transfer progress and detects URL credentials', () => {
    expect(parseTransfer('Receiving objects:  42% (420/1000), 12.34 MiB | 3.21 MiB/s')).toEqual({
      transferred: '12.34 MiB',
      speed: '3.21 MiB/s',
    });
    expect(parseTransfer('Resolving deltas: 100% (5/5), done.')).toEqual({});
    expect(hasEmbeddedCredentials('https://u:t@github.com/o/r')).toBe(true);
    expect(hasEmbeddedCredentials('ssh://git@host/o/r')).toBe(false);
    expect(hasEmbeddedCredentials('git@host:o/r.git')).toBe(false);
  });

  it('safe.directory: uses git hint, refuses wildcards', () => {
    const stderr =
      "fatal: detected dubious ownership in repository at 'D:/x'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/x\n";
    expect(safeDirectoryFor('D:\\x', stderr)).toEqual({
      path: 'D:/x',
      command: 'git config --global --add safe.directory D:/x',
    });
    expect(safeDirectoryFor('/srv/my repo', '').command).toBe(
      `git config --global --add safe.directory '${path.resolve('/srv/my repo').replace(/\\/g, '/')}'`,
    );
    expect(() => assertSafeDirectoryValue('*')).toThrow();
    expect(() => assertSafeDirectoryValue('relative/dir')).toThrow();
    expect(() => assertSafeDirectoryValue('--evil')).toThrow();
    expect(() => assertSafeDirectoryValue('C:/repos/x')).not.toThrow();
  });

  it('details helpers', () => {
    expect(pickReadme(['a.txt', 'readme', 'README.txt', 'README.md'])).toBe('README.md');
    expect(pickReadme(['Readme.markdown', 'readme'])).toBe('Readme.markdown');
    expect(parseCountObjects('count: 1\nsize: 4\nin-pack: 3\npacks: 1\nsize-pack: 6\n')).toBe(10 * 1024);
  });

  it('OS recents: JumpList tasks forward -p, macOS recent documents most recent last', () => {
    const repos: RepoRecord[] = [
      { path: 'C:\\a', name: 'a', isBare: false, favorite: false, groupIds: [], lastOpenedAt: 1 },
      {
        path: 'C:\\b',
        name: 'b',
        alias: 'Bee',
        isBare: false,
        favorite: true,
        groupIds: [],
        lastOpenedAt: 2,
      },
      { path: 'C:\\gone', name: 'gone', isBare: false, favorite: false, groupIds: [], missing: true },
    ];
    const tasks = jumpListTasks(byRecency(repos), 'C:\\K.exe');
    expect(tasks.map((t) => [t.title, t.args])).toEqual([
      ['Bee', '-p "C:\\b"'],
      ['a', '-p "C:\\a"'],
    ]);
    const calls: unknown[] = [];
    const win = createOsRecents(
      { setJumpList: (c) => calls.push(c) },
      { platform: 'win32', exe: 'C:\\K.exe' },
    );
    win(repos);
    win(repos); // unchanged → no second call
    expect(calls).toHaveLength(1);
    const docs: string[] = [];
    createOsRecents(
      { addRecentDocument: (p) => docs.push(p), clearRecentDocuments: () => undefined },
      { platform: 'darwin', exe: 'x' },
    )(repos);
    expect(docs).toEqual(['C:\\a', 'C:\\b']);
  });

  it('drop / open-file helpers', () => {
    expect(droppedPathFromUrl(pathToFileURL(root).href)).toBe(root);
    expect(droppedPathFromUrl('https://example.com/')).toBeNull();
    const q = createOpenFileQueue();
    const got: string[] = [];
    q.push('/one');
    q.ready((p) => got.push(p));
    q.push('/two');
    expect(got).toEqual(['/one', '/two']);
  });
});

describeGit('validate / details / safe.directory (real git)', () => {
  it('validates repos, subfolders, files and non-repos without touching recents', async () => {
    const repo = path.join(root, 'r1');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    git(repo, 'init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Hello\n\nworld\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', 'https://user:secret@example.com/o/r1.git');

    const ok = await validateRepoPath(runner, path.join(repo, 'sub'));
    expect(ok.ok && ok.repo.path.replace(/\\/g, '/').toLowerCase()).toBe(
      repo.replace(/\\/g, '/').toLowerCase(),
    );
    const viaFile = await validateRepoPath(runner, path.join(repo, 'README.md'));
    expect(viaFile.ok).toBe(true);

    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await validateRepoPath(runner, plain)).toMatchObject({ ok: false, reason: 'notARepo' });
    expect(await validateRepoPath(runner, path.join(root, 'nope'))).toMatchObject({
      ok: false,
      reason: 'notFound',
    });

    const d = await repoDetails(runner, repo);
    expect(d).toMatchObject({ isBare: false, branch: 'main' });
    expect(d.remotes).toEqual([{ name: 'origin', url: 'https://example.com/o/r1.git' }]);
    expect(d.lastCommit?.subject).toBe('first');
    expect(d.readme).toMatchObject({ name: 'README.md', truncated: false });
    expect(d.readme?.markdown).toContain('# Hello');
    expect(d.sizeBytes).toBeGreaterThanOrEqual(0);

    const bare = path.join(root, 'r1.git');
    git(root, 'clone', '-q', '--bare', repo, bare);
    const bd = await repoDetails(runner, bare);
    expect(bd.isBare).toBe(true);
    expect(bd.readme?.markdown).toContain('world');

    expect(inspectTarget(root, 'r1')).toMatchObject({ exists: true, empty: false });
    expect(inspectTarget(root, 'fresh')).toMatchObject({ exists: false });
    expect(inspectTarget(path.join(repo, 'sub'), 'nested').insideRepo?.toLowerCase()).toBe(
      repo.toLowerCase(),
    );
    expect(() => inspectTarget(root, '../x')).toThrow();
  });

  it('adds one safe.directory entry to the (isolated) global config, once', async () => {
    const value = path.join(root, 'shared-repo').replace(/\\/g, '/');
    await addSafeDirectory(runner, value);
    await addSafeDirectory(runner, value);
    const list = git(root, 'config', '--global', '--get-all', 'safe.directory').trim().split(/\r?\n/);
    expect(list).toEqual([value]);
    await expect(addSafeDirectory(runner, '*')).rejects.toThrow();
  });
});
