import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GitError } from '../src/errors/classify';
import {
  attributesUseLfs,
  buildCloneArgs,
  cloneRepo,
  initRepo,
  normalizeSparsePaths,
  parseCustomCloneFlags,
  publishToRemote,
  sparseUsesCone,
  stripUrlCredentials,
  tokenizeFlags,
} from '../src/repo-create';
import { describeGit, useHarness } from './ops-harness';

describe('clone option helpers', () => {
  it('tokenizes shell words', () => {
    expect(tokenizeFlags(`--depth 3 --shallow-exclude="a b" --origin 'up stream'`)).toEqual([
      '--depth',
      '3',
      '--shallow-exclude=a b',
      '--origin',
      'up stream',
    ]);
    expect(() => tokenizeFlags('--origin "x')).toThrow(/quote/);
  });

  it('accepts only allowlisted custom flags', () => {
    expect(parseCustomCloneFlags('--depth 5 --no-tags --filter=blob:none --jobs=4')).toEqual([
      '--depth=5',
      '--no-tags',
      '--filter=blob:none',
      '--jobs=4',
    ]);
    expect(parseCustomCloneFlags('  ')).toEqual([]);
    expect(() => parseCustomCloneFlags('--upload-pack=touch /tmp/x')).toThrow(/not allowed/);
    expect(() => parseCustomCloneFlags('-u evil')).toThrow(/not allowed/);
    expect(() => parseCustomCloneFlags('--config core.sshCommand=evil')).toThrow(/not allowed/);
    expect(() => parseCustomCloneFlags('-c core.sshCommand=evil')).toThrow(/not allowed/);
    expect(() => parseCustomCloneFlags('--depth abc')).toThrow(/number/);
    expect(() => parseCustomCloneFlags('--origin')).toThrow(/value/);
    expect(() => parseCustomCloneFlags('--no-tags=1')).toThrow(/does not take/);
  });

  it('strips credentials embedded in URLs', () => {
    expect(stripUrlCredentials('https://user:tok3n@github.com/o/r.git')).toEqual({
      url: 'https://github.com/o/r.git',
      hadCredentials: true,
    });
    expect(stripUrlCredentials('https://ghp_abc@github.com/o/r.git').hadCredentials).toBe(true);
    expect(stripUrlCredentials('ssh://git@host/o/r.git')).toEqual({
      url: 'ssh://git@host/o/r.git',
      hadCredentials: false,
    });
    expect(stripUrlCredentials('git@github.com:o/r.git').hadCredentials).toBe(false);
    expect(stripUrlCredentials('https://github.com/o/r.git').hadCredentials).toBe(false);
  });

  it('classifies and normalizes sparse paths', () => {
    expect(sparseUsesCone(['src', 'docs/api'])).toBe(true);
    expect(sparseUsesCone(['*.md'])).toBe(false);
    expect(sparseUsesCone(['/build'])).toBe(false);
    expect(normalizeSparsePaths([' src/ ', '', '# comment', 'docs\\api', 'src'])).toEqual([
      'src',
      'docs/api',
    ]);
    expect(() => normalizeSparsePaths(['../x'])).toThrow(/inside/);
    expect(() => normalizeSparsePaths(['--evil'])).toThrow(/Invalid/);
  });

  it('detects LFS attributes', () => {
    expect(attributesUseLfs('*.psd filter=lfs diff=lfs merge=lfs -text\n')).toBe(true);
    expect(attributesUseLfs('# *.psd filter=lfs\n*.txt text\n')).toBe(false);
  });

  it('builds clone argv for shallow / sparse / blobless / custom requests', () => {
    const t = '/tmp/x';
    expect(
      buildCloneArgs(
        {
          url: 'https://h/r.git',
          parentDir: '/tmp',
          folderName: 'x',
          depth: 2,
          shallowSince: '2024-01-01',
          branch: 'dev',
          recurseSubmodules: false,
          sparse: { paths: ['src'], blobless: true },
          customFlags: '--no-tags',
          longPaths: true,
        },
        t,
      ),
    ).toEqual([
      '-c',
      'core.longpaths=true',
      'clone',
      '--progress',
      '--depth=2',
      '--shallow-since=2024-01-01',
      '--branch',
      'dev',
      '--single-branch',
      '--filter=blob:none',
      '--sparse',
      '--no-tags',
      '--',
      'https://h/r.git',
      t,
    ]);
    expect(() =>
      buildCloneArgs({ url: 'x', parentDir: '/', folderName: 'x', customFlags: '--upload-pack=x' }, t),
    ).toThrow(GitError);
    expect(() => buildCloneArgs({ url: '-x', parentDir: '/', folderName: 'x' }, t)).toThrow(GitError);
  });
});

describeGit('clone variants / init templates (real git)', () => {
  const h = useHarness('create-ext');

  /** A source repo with directories + one more commit dated later, served over file://. */
  const source = (): { dir: string; url: string } => {
    const dir = h.fixture('empty').path;
    h.write(path.join(dir, 'README.md'), 'root\n');
    h.write(path.join(dir, 'src', 'a.txt'), 'a\n');
    h.write(path.join(dir, 'docs', 'b.txt'), 'b\n');
    h.write(path.join(dir, 'big', 'c.bin'), 'c\n');
    h.git(dir, 'add', '-A');
    h.git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'one');
    h.write(path.join(dir, 'src', 'a2.txt'), 'a2\n');
    h.git(dir, 'add', '-A');
    h.git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'two');
    h.git(dir, 'config', 'uploadpack.allowFilter', 'true');
    h.git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    return { dir, url: pathToFileURL(dir).href };
  };

  it('shallow clone by depth + single branch, and with custom flags', async () => {
    const { url } = source();
    const parentDir = path.join(h.root, 'shallow');
    const r = await cloneRepo(h.runner, {
      url,
      parentDir,
      folderName: 'd1',
      depth: 1,
      customFlags: '--no-tags',
    });
    expect(h.git(r.path, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(h.git(r.path, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    await expect(
      cloneRepo(h.runner, { url, parentDir, folderName: 'bad', customFlags: '--upload-pack=x' }),
    ).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(path.join(parentDir, 'bad'))).toBe(false);
  });

  it('sparse + blobless clone keeps only the cone', async () => {
    const { url } = source();
    const r = await cloneRepo(h.runner, {
      url,
      parentDir: path.join(h.root, 'sparse'),
      folderName: 's',
      sparse: { paths: ['src'], blobless: true },
    });
    expect(r.sparse).toBe(true);
    expect(h.git(r.path, 'sparse-checkout', 'list').trim()).toBe('src');
    expect(fs.existsSync(path.join(r.path, 'src', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(r.path, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.path, 'docs'))).toBe(false);
    expect(h.git(r.path, 'config', '--get', 'remote.origin.partialclonefilter').trim()).toBe('blob:none');
  });

  it('runs or skips `git lfs pull` depending on .gitattributes', async () => {
    const { dir, url } = source();
    // no LFS: nothing reported
    const plain = await cloneRepo(h.runner, {
      url,
      parentDir: path.join(h.root, 'lfs'),
      folderName: 'plain',
    });
    expect(plain.lfs).toBeUndefined();
    // LFS attributes: either pulled (git-lfs installed) or reported unavailable — never fails the clone
    h.write(path.join(dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    h.git(dir, 'add', '.gitattributes');
    h.git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'lfs');
    const lfs = await cloneRepo(h.runner, {
      url,
      parentDir: path.join(h.root, 'lfs'),
      folderName: 'withlfs',
    });
    expect(['pulled', 'unavailable', 'failed']).toContain(lfs.lfs);
    expect(fs.existsSync(path.join(lfs.path, '.git'))).toBe(true);
    const skipped = await cloneRepo(h.runner, {
      url,
      parentDir: path.join(h.root, 'lfs'),
      folderName: 'skip',
      lfsPull: false,
    });
    expect(skipped.lfs).toBeUndefined();
  });

  it('bare init, license file, and publish to a remote', async () => {
    const parentDir = path.join(h.root, 'init');
    const bare = await initRepo(h.runner, {
      parentDir,
      name: 'remote.git',
      defaultBranch: 'main',
      bare: true,
    });
    expect(h.git(bare.path, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(fs.existsSync(path.join(bare.path, 'README.md'))).toBe(false);

    const r = await initRepo(h.runner, {
      parentDir,
      name: 'proj',
      defaultBranch: 'main',
      gitignore: '### Node ###\nnode_modules/\n\n### macOS ###\n.DS_Store\n',
      license: 'MIT License\n\nCopyright (c) 2026 Ada',
      readme: true,
      initialCommit: true,
      author: { name: 'A', email: 'a@e' },
    });
    expect(h.git(r.path, 'ls-files').split(/\r?\n/).filter(Boolean).sort()).toEqual([
      '.gitignore',
      'LICENSE',
      'README.md',
    ]);
    expect(h.read(path.join(r.path, 'LICENSE'))).toBe('MIT License\n\nCopyright (c) 2026 Ada\n');

    await publishToRemote(h.runner, r.path, { url: pathToFileURL(bare.path).href, branch: 'main' });
    expect(h.git(bare.path, 'rev-parse', 'main').trim()).toBe(h.git(r.path, 'rev-parse', 'HEAD').trim());
    expect(h.git(r.path, 'rev-parse', '--abbrev-ref', 'main@{upstream}').trim()).toBe('origin/main');
  });
});
