import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { shallowFetchArgs } from '../src/ops/executors/remote';
import { listSubmodules } from '../src/service/extras';
import { failExtra, runExtra } from './extras-harness';
import { describeGit, gitAtLeast, gitPath, tinyRepo, useHarness } from './ops-harness';

describe('shallowFetchArgs (remote.add on shallow repos)', () => {
  it('maps depth / since / allowed flags', () => {
    expect(shallowFetchArgs(undefined)).toEqual([]);
    expect(
      shallowFetchArgs({ depth: 5, since: '2024-01-01', extraArgs: ['--no-tags', '--filter=blob:none'] }),
    ).toEqual(['--depth=5', '--shallow-since=2024-01-01', '--no-tags', '--filter=blob:none']);
  });

  it('rejects unsafe input', () => {
    expect(() => shallowFetchArgs({ depth: 0 })).toThrow();
    expect(() => shallowFetchArgs({ depth: 1.5 })).toThrow();
    expect(() => shallowFetchArgs({ since: '2024;rm -rf' })).toThrow();
    expect(() => shallowFetchArgs({ extraArgs: ['--upload-pack=evil'] })).toThrow();
  });
});

describeGit('submodule.setUrl (real git)', () => {
  const h = useHarness('submodule-seturl');

  beforeAll(() => {
    fs.appendFileSync(path.join(h.root, '.gitconfig-empty'), '[protocol "file"]\n\tallow = always\n');
  });

  it.runIf(gitAtLeast(2, 25))(
    'rewrites .gitmodules, syncs the module config and stages .gitmodules',
    async () => {
      const fx = h.fixture('submodules');
      const svc = await h.open(fx.path);
      const before = (await listSubmodules(svc)).find((s) => s.path === 'lib')!;
      expect(before).toBeDefined();

      // a second clone of the same source acts as the "moved" URL
      const moved = path.join(h.root, 'moved-lib');
      h.git(h.root, 'clone', '-q', before.url, moved);
      const url = pathToFileURL(moved).href;

      const r = await runExtra(svc, { type: 'submodule.setUrl', path: 'lib', url });
      expect(r.summary).toBe('Changed the URL of lib');
      expect(h.git(fx.path, 'config', '-f', '.gitmodules', 'submodule.lib.url').trim()).toBe(url);
      // sync: the parent's config and the module's origin follow
      expect(h.git(fx.path, 'config', 'submodule.lib.url').trim()).toBe(url);
      expect(h.git(path.join(fx.path, 'lib'), 'remote', 'get-url', 'origin').trim()).toBe(url);
      expect(h.git(fx.path, 'diff', '--cached', '--name-only')).toMatch(/\.gitmodules/);
      const after = (await listSubmodules(svc)).find((s) => s.path === 'lib')!;
      expect(after.url).toBe(url);
    },
  );

  it('fails for an unknown submodule path and an invalid URL', async () => {
    const fx = h.fixture('submodules');
    const svc = await h.open(fx.path);
    expect(
      (await failExtra(svc, { type: 'submodule.setUrl', path: 'nope', url: 'https://x/y.git' })).code,
    ).toBe('SubmoduleError');
    await expect(runExtra(svc, { type: 'submodule.setUrl', path: 'lib', url: 'a\nb' })).rejects.toThrow();
  });
});

const lfsAvailable = ((): boolean => {
  if (!gitPath) return false;
  try {
    return /git-lfs\//.test(execFileSync(gitPath, ['lfs', 'version'], { encoding: 'utf8', stdio: 'pipe' }));
  } catch {
    return false;
  }
})();

describeGit('lfs.convert (real git + git-lfs)', () => {
  const h = useHarness('lfs-convert');

  it.runIf(lfsAvailable)('tracks the pattern and re-adds existing files as LFS pointers', async () => {
    const repo = await tinyRepo(h, { 'README.md': 'x\n', 'art/a.psd': 'binary-ish A\n', 'b.psd': 'B\n' });
    repo.g('lfs', 'install', '--local');
    const r = await runExtra(repo.svc, { type: 'lfs.convert', patterns: ['*.psd'] });
    expect(r.summary).toBe('Converted 2 files to Git LFS');
    expect((r.data as { files: string[] }).files.sort()).toEqual(['art/a.psd', 'b.psd']);
    const staged = repo.g('diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
    expect(staged).toEqual(['.gitattributes', 'art/a.psd', 'b.psd']);
    // the staged blob is now a pointer
    expect(repo.g('cat-file', '-p', ':b.psd')).toMatch(/^version https:\/\/git-lfs\.github\.com\/spec\/v1/);
    expect(repo.file('.gitattributes')).toMatch(/\*\.psd filter=lfs/);
  });
});
