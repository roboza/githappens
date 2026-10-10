import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { listSubmodules, parseGitmodulesConfig, parseSubmoduleStatus } from '../src/service/extras';
import { failExtra, runExtra } from './extras-harness';
import { describeGit, useHarness } from './ops-harness';

const S1 = '1'.repeat(40);
const S2 = '2'.repeat(40);

describe('submodule parsers', () => {
  it('parses .gitmodules config records (names with dots)', () => {
    const out = [
      'submodule.lib.path\nlib',
      'submodule.lib.url\nhttps://example.com/lib.git',
      'submodule.my.mod.path\nvendor/my mod',
      'submodule.my.mod.url\n../my.mod.git',
      'submodule.my.mod.branch\nstable',
      '',
    ].join('\0');
    expect(parseGitmodulesConfig(out)).toEqual([
      { name: 'lib', path: 'lib', url: 'https://example.com/lib.git' },
      { name: 'my.mod', path: 'vendor/my mod', url: '../my.mod.git', branch: 'stable' },
    ]);
  });

  it('parses submodule status flags, paths with spaces and describe', () => {
    const out = [
      ` ${S1} lib (heads/main)`,
      `+${S2} vendor/my mod (v1.0-2-g${S2.slice(0, 7)})`,
      `-${S1} uninit`,
      `U${'0'.repeat(40)} conflicted`,
      ` ${S1} odd (name)`,
      '',
    ].join('\n');
    const parsed = parseSubmoduleStatus(out, new Set(['odd (name)']));
    expect(parsed).toEqual([
      { flag: ' ', sha: S1, path: 'lib', describe: 'heads/main' },
      { flag: '+', sha: S2, path: 'vendor/my mod', describe: `v1.0-2-g${S2.slice(0, 7)}` },
      { flag: '-', sha: S1, path: 'uninit' },
      { flag: 'U', sha: '0'.repeat(40), path: 'conflicted' },
      { flag: ' ', sha: S1, path: 'odd (name)' },
    ]);
  });
});

describeGit('submodules (fixtures)', () => {
  const h = useHarness('submodule');

  beforeAll(() => {
    // file:// submodule URLs need protocol.file.allow=always (git >= 2.38.1); the harness' isolated global config
    fs.appendFileSync(path.join(h.root, '.gitconfig-empty'), '[protocol "file"]\n\tallow = always\n');
  });

  it('lists nested submodules with state, url and recorded/checked-out shas', async () => {
    const fx = h.fixture('submodules');
    const svc = await h.open(fx.path);
    const list = await listSubmodules(svc);
    expect(list.map((s) => s.path)).toEqual(['lib', 'lib/vendor/leaf']);
    const lib = list[0]!;
    expect(lib).toMatchObject({ name: 'lib', state: 'out-of-sync' });
    expect(lib.url).toMatch(/^file:\/\/.*lib-src$/);
    expect(lib.recordedSha).toBe(h.git(fx.path, 'rev-parse', 'HEAD:lib').trim());
    expect(lib.checkedOutSha).toBe(h.git(path.join(fx.path, 'lib'), 'rev-parse', 'HEAD').trim());
    expect(lib.recordedSha).not.toBe(lib.checkedOutSha);
    const leaf = list[1]!;
    expect(leaf).toMatchObject({ name: 'vendor/leaf', state: 'in-sync' });
    expect(leaf.url).toMatch(/leaf-src$/);
    expect(leaf.recordedSha).toBe(leaf.checkedOutSha);

    // a repo without submodules
    const plain = await h.open(h.fixture('linear', { count: 2 }).path);
    expect(await listSubmodules(plain)).toEqual([]);
  });

  it('update --init re-initializes a deinitialized submodule recursively', async () => {
    const fx = h.fixture('submodules');
    const svc = await h.open(fx.path);
    h.git(fx.path, 'submodule', 'deinit', '-f', '-q', '--', 'lib');
    let list = await listSubmodules(svc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: 'lib', state: 'uninitialized', checkedOutSha: null });
    expect(list[0]!.recordedSha).toMatch(/^[0-9a-f]{40}$/);

    const progress: string[] = [];
    await runExtra(
      svc,
      { type: 'submodule.update', init: true, recursive: true, paths: ['lib'] },
      { onProgress: (_id, p) => progress.push(p.phase) },
    );
    list = await listSubmodules(svc);
    expect(list.map((s) => [s.path, s.state])).toEqual([
      ['lib', 'in-sync'],
      ['lib/vendor/leaf', 'in-sync'],
    ]);
  });

  it('adds a submodule at a path with spaces, then removes it', async () => {
    const fx = h.fixture('submodules');
    const svc = await h.open(fx.path);
    const src = path.join(h.root, 'new-src');
    fs.mkdirSync(src, { recursive: true });
    h.git(src, 'init', '-q', '-b', 'main');
    h.write(path.join(src, 'n.txt'), 'n\n');
    h.git(src, 'add', '.');
    h.git(src, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'n');

    const url = pathToFileURL(src).href;
    await runExtra(svc, { type: 'submodule.add', url, path: 'vendor/new thing', branch: 'main' });
    let list = await listSubmodules(svc);
    const added = list.find((s) => s.path === 'vendor/new thing')!;
    expect(added).toMatchObject({ name: 'vendor/new thing', url, branch: 'main', state: 'in-sync' });
    expect(fs.existsSync(path.join(fx.path, 'vendor', 'new thing', 'n.txt'))).toBe(true);
    expect(h.git(fx.path, 'diff', '--cached', '--name-only')).toMatch(/vendor\/new thing/);

    await runExtra(svc, { type: 'submodule.remove', path: 'vendor/new thing' });
    list = await listSubmodules(svc);
    expect(list.find((s) => s.path === 'vendor/new thing')).toBeUndefined();
    expect(fs.existsSync(path.join(svc.repo.commonDir, 'modules', 'vendor', 'new thing'))).toBe(false);
    expect(fs.existsSync(path.join(fx.path, 'vendor', 'new thing'))).toBe(false);

    const bad = await failExtra(svc, { type: 'submodule.add', url: 'file:///does/not/exist', path: 'nope' });
    expect(bad.code).toBe('RepositoryNotFound');
  }, 180_000); // submodule add + remove runs many git processes: slow under full-monorepo load
});
