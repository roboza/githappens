import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath, GitProcessRunner, GitService } from '@githappens/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitlinkSha, submoduleParent } from '../src/main/remotes/remote-reads';
import {
  pointerChangeText,
  submodulePathFromUrl,
  submoduleStateLabel,
  validateSubmodulePath,
} from '../src/renderer/src/views/submodules/submodule-model';

describe('submodule dialog model', () => {
  it('derives the default path from the URL', () => {
    expect(submodulePathFromUrl('https://github.com/acme/lib.git')).toBe('lib');
    expect(submodulePathFromUrl('git@github.com:acme/tools')).toBe('tools');
    expect(submodulePathFromUrl('C:\\repos\\vendor\\')).toBe('vendor');
  });

  it('keeps paths inside the repository', () => {
    expect(validateSubmodulePath('vendor/lib')).toBeNull();
    expect(validateSubmodulePath('')).toMatch(/Enter/);
    expect(validateSubmodulePath('/abs')).toMatch(/relative/);
    expect(validateSubmodulePath('C:\\abs')).toMatch(/relative/);
    expect(validateSubmodulePath('a/../../b')).toMatch(/inside/);
    expect(validateSubmodulePath('x/.git/y')).toMatch(/\.git/);
  });

  it('labels states and pointer changes', () => {
    expect(submoduleStateLabel('out-of-sync')).toEqual({ icon: '↻', text: 'out of sync' });
    expect(submoduleStateLabel('uninitialized').text).toBe('not initialized');
    expect(pointerChangeText({ path: 'lib', from: 'a'.repeat(40), to: 'b'.repeat(40) })).toBe(
      'Submodule lib pointer changed (aaaaaaa → bbbbbbb).',
    );
    expect(pointerChangeText({ path: 'lib', from: null, to: 'b'.repeat(40) })).toMatch(/none → bbbbbbb/);
  });

  it('parses gitlink lines from ls-files -s / ls-tree', () => {
    const sha = 'c'.repeat(40);
    expect(gitlinkSha(`160000 ${sha} 0\tlib`)).toBe(sha);
    expect(gitlinkSha(`160000 commit ${sha}\tlib`)).toBe(sha);
    expect(gitlinkSha(`100644 blob ${sha}\tfile`)).toBeNull();
    expect(gitlinkSha('')).toBeNull();
  });
});

const gitPath = findOnPath('git');
const d = gitPath ? describe : describe.skip;

d('git:submodule:parent (real git)', () => {
  let root = '';
  let env: NodeJS.ProcessEnv = {};
  let runner: GitProcessRunner;
  const services: GitService[] = [];
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(gitPath!, args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-submodule-ui-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[protocol "file"]\n\tallow = always\n');
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_TERMINAL_PROMPT: '0',
    };
    runner = new GitProcessRunner({ context: () => ({ gitPath: gitPath!, baseEnv: env, bundled: false }) });
  });
  afterAll(() => {
    for (const s of services) s.dispose();
    runner?.killAll();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may hold handles briefly */
    }
  });

  const init = (dir: string, file: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', file);
  };

  it('reports the parent and pointer changes of an opened submodule', async () => {
    const src = path.join(root, 'lib-src');
    const parent = path.join(root, 'parent');
    init(src, 'a.txt');
    init(parent, 'p.txt');
    git(parent, 'submodule', 'add', '-q', '--', src, 'vendor/lib');
    git(parent, 'commit', '-q', '-m', 'add lib');

    const subDir = path.join(parent, 'vendor', 'lib');
    const sub = await GitService.open(runner, subDir);
    services.push(sub);
    const recorded = git(parent, 'rev-parse', 'HEAD:vendor/lib').trim();
    let info = await submoduleParent(sub);
    expect(info).toMatchObject({
      path: 'vendor/lib',
      recordedSha: recorded,
      indexSha: recorded,
      headSha: recorded,
      pointerChanged: false,
    });
    expect(path.resolve(info!.parentPath).toLowerCase()).toBe(path.resolve(parent).toLowerCase());

    // move the submodule HEAD → pointer changed vs the parent's index
    fs.writeFileSync(path.join(subDir, 'b.txt'), 'b\n');
    git(subDir, 'add', '-A');
    git(subDir, 'commit', '-q', '-m', 'b');
    await sub.refreshRepoInfo();
    info = await submoduleParent(sub);
    const head = git(subDir, 'rev-parse', 'HEAD').trim();
    expect(info).toMatchObject({ headSha: head, recordedSha: recorded, pointerChanged: true });

    // staging the pointer in the parent clears it
    git(parent, 'add', '--', 'vendor/lib');
    info = await submoduleParent(sub);
    expect(info).toMatchObject({ indexSha: head, pointerChanged: false });

    // the parent itself is not a submodule
    const p = await GitService.open(runner, parent);
    services.push(p);
    expect(await submoduleParent(p)).toBeNull();
  }, 120_000);
});
