import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { GitError } from '../src/errors/classify';
import { cloneRepo, initRepo } from '../src/repo-create';
import type { ProgressEvent } from '../src/types';
import { describeGit, useHarness } from './ops-harness';

describeGit('clone / init', () => {
  const h = useHarness('create');

  it('clones a file:// remote with progress events', async () => {
    const src = h.fixture('linear', { count: 30 }).path;
    const url = pathToFileURL(src).href;
    const parentDir = path.join(h.root, 'clones');
    const events: ProgressEvent[] = [];
    const r = await cloneRepo(
      h.runner,
      { url, parentDir, folderName: 'copy' },
      { progress: (p) => events.push(p) },
    );
    expect(r.path).toBe(path.join(parentDir, 'copy'));
    expect(h.git(r.path, 'rev-parse', 'HEAD').trim()).toBe(h.git(src, 'rev-parse', 'HEAD').trim());
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.overall !== null)).toBe(true);

    const shallow = await cloneRepo(h.runner, {
      url,
      parentDir,
      folderName: 'shallow',
      depth: 1,
      bare: true,
    });
    expect(h.git(shallow.path, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(h.git(shallow.path, 'rev-list', '--count', 'HEAD').trim()).toBe('1');

    // non-empty target is refused before running git
    await expect(cloneRepo(h.runner, { url, parentDir, folderName: 'copy' })).rejects.toBeInstanceOf(
      GitError,
    );
    expect(fs.existsSync(path.join(r.path, '.git'))).toBe(true);
  });

  it('removes the target it created when the clone fails or is cancelled', async () => {
    const parentDir = path.join(h.root, 'cancel');
    // a "remote" that never answers: ssh is replaced by a sleeping node process
    const node = process.execPath.replace(/\\/g, '/');
    // `--` ends node's own options so ssh flags git appends (e.g. `-o SendEnv=…` on macOS) aren't parsed
    // by node; the `simple` variant stops git adding ssh-specific flags at all.
    const env = {
      GIT_SSH_COMMAND: `"${node}" -e "setTimeout(() => {}, 30000)" --`,
      GIT_SSH_VARIANT: 'simple',
    };
    const ac = new AbortController();
    const target = path.join(parentDir, 'never');
    const done = cloneRepo(
      h.runner,
      { url: 'ssh://git@example.invalid/x.git', parentDir, folderName: 'never' },
      { signal: ac.signal, env },
    );
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(target) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(target)).toBe(true);
    ac.abort();
    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('Cancelled');
    expect(fs.existsSync(target)).toBe(false);

    // a pre-existing (empty) folder is left alone
    fs.mkdirSync(path.join(parentDir, 'mine'));
    await expect(
      cloneRepo(h.runner, {
        url: pathToFileURL(path.join(h.root, 'missing.git')).href,
        parentDir,
        folderName: 'mine',
      }),
    ).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(path.join(parentDir, 'mine'))).toBe(true);
  });

  it('initializes a repo with default branch, .gitignore, README and initial commit', async () => {
    const r = await initRepo(h.runner, {
      parentDir: path.join(h.root, 'init'),
      name: 'fresh',
      defaultBranch: 'trunk',
      gitignore: 'node_modules/\n*.log',
      readme: true,
      initialCommit: true,
      author: { name: 'Init Tester', email: 'init@example.com' },
    });
    expect(h.git(r.path, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('trunk');
    expect(h.read(path.join(r.path, '.gitignore'))).toBe('node_modules/\n*.log\n');
    expect(h.read(path.join(r.path, 'README.md'))).toBe('# fresh\n');
    expect(h.git(r.path, 'log', '--format=%s|%an', '-1').trim()).toBe('Initial commit|Init Tester');
    expect(h.git(r.path, 'ls-files').split(/\r?\n/).filter(Boolean).sort()).toEqual([
      '.gitignore',
      'README.md',
    ]);

    const bare = await initRepo(h.runner, {
      parentDir: path.join(h.root, 'init'),
      name: 'plain',
      defaultBranch: 'main',
    });
    expect(h.git(bare.path, 'status', '--porcelain', '--branch').trim()).toBe('## No commits yet on main');
    await expect(
      initRepo(h.runner, { parentDir: path.join(h.root, 'init'), name: 'bad', defaultBranch: 'no..dots' }),
    ).rejects.toBeInstanceOf(GitError);
  });
});
