import path from 'node:path';

import { SkipFixture, type FixtureResult } from '@githappens/fixtures';
import { describe, expect, it } from 'vitest';

import { parseLfsProgressLine } from '../src/ops/executors/extras';
import {
  lfsAvailable,
  lfsStatus,
  parseGitattributesLfs,
  parseLfsLocksJson,
  parseLfsTrackOutput,
} from '../src/service/extras';
import { runExtra } from './extras-harness';
import { describeGit, useHarness } from './ops-harness';

describe('LFS parsers', () => {
  it('parses .gitattributes (lockable, quoted, unset, nested dir)', () => {
    const text = [
      '# comment',
      '*.bin filter=lfs diff=lfs merge=lfs -text',
      '*.psd filter=lfs diff=lfs merge=lfs -text lockable',
      '"a b/*.x" filter=lfs diff=lfs merge=lfs -text',
      '*.txt text eol=lf',
      '*.old filter=lfs diff=lfs merge=lfs -text',
      '*.old -filter',
      '',
    ].join('\r\n');
    expect(parseGitattributesLfs(text)).toEqual([
      { pattern: '*.bin', lockable: false },
      { pattern: '*.psd', lockable: true },
      { pattern: 'a b/*.x', lockable: false },
    ]);
    expect(parseGitattributesLfs('*.zip filter=lfs\n', 'assets')).toEqual([
      { pattern: 'assets/*.zip', lockable: false },
    ]);
  });

  it('parses `git lfs track` output', () => {
    const out = [
      'Listing tracked patterns',
      '    *.bin (.gitattributes)',
      '    *.psd [lockable] (.gitattributes)',
      '    a[[:space:]]b\\*.x (sub/.gitattributes)',
      'Listing excluded patterns',
      '    *.txt (.gitattributes)',
      '',
    ].join('\n');
    expect(parseLfsTrackOutput(out)).toEqual([
      { pattern: '*.bin', lockable: false },
      { pattern: '*.psd', lockable: true },
      { pattern: 'a[[:space:]]b\\*.x', lockable: false },
    ]);
  });

  it('parses `git lfs locks --json` and tolerates garbage', () => {
    const json = JSON.stringify([
      { id: '7', path: 'art/a.psd', owner: { name: 'Alice' }, locked_at: '2024-01-01T00:00:00Z' },
      { id: 8, path: 'b.psd', locked_at: '2024-01-02T00:00:00Z' },
    ]);
    expect(parseLfsLocksJson(json)).toEqual([
      { id: '7', path: 'art/a.psd', owner: 'Alice', lockedAt: '2024-01-01T00:00:00Z' },
      { id: '8', path: 'b.psd', owner: '', lockedAt: '2024-01-02T00:00:00Z' },
    ]);
    expect(parseLfsLocksJson('')).toEqual([]);
    expect(parseLfsLocksJson('not json')).toEqual([]);
    expect(parseLfsLocksJson('{"a":1}')).toEqual([]);
  });

  it('parses GIT_LFS_PROGRESS lines', () => {
    expect(parseLfsProgressLine('download 2/5 1024/4096 assets/big file.bin')).toEqual({
      direction: 'download',
      current: 2,
      total: 5,
      bytes: 1024,
      bytesTotal: 4096,
      name: 'assets/big file.bin',
    });
    expect(parseLfsProgressLine('garbage')).toBeNull();
  });
});

describeGit('LFS (fixtures)', () => {
  const h = useHarness('lfs');

  function lfsFixture(skip: (note: string) => void): FixtureResult | null {
    try {
      return h.fixture('lfs');
    } catch (e) {
      if (e instanceof SkipFixture) {
        skip(e.message);
        return null;
      }
      throw e;
    }
  }

  it('reports status of an LFS repo and tracks / untracks patterns', async (ctx) => {
    const fx = lfsFixture((m) => ctx.skip(m));
    if (!fx) return;
    const svc = await h.open(fx.path);
    let st = await lfsStatus(svc);
    expect(st).toEqual({
      available: true,
      initialized: true,
      tracked: [{ pattern: '*.bin', lockable: false }],
      locks: [], // no remote: locks are not queried
    });

    await runExtra(svc, { type: 'lfs.track', patterns: ['*.psd', 'my dir/*.zip'] });
    st = await lfsStatus(svc);
    // git-lfs versions differ in the order they append patterns to .gitattributes.
    expect(st.tracked.map((t) => t.pattern).sort()).toEqual(['*.bin', '*.psd', 'my[[:space:]]dir/*.zip']);
    expect(h.git(fx.path, 'status', '--porcelain')).toMatch(/\.gitattributes/);

    await runExtra(svc, { type: 'lfs.untrack', patterns: ['*.bin'] });
    st = await lfsStatus(svc);
    expect(st.tracked.map((t) => t.pattern).sort()).toEqual(['*.psd', 'my[[:space:]]dir/*.zip']);
  });

  it('installs LFS into a plain repo', async (ctx) => {
    const svc = await h.open(h.fixture('linear', { count: 2 }).path);
    if (!(await lfsAvailable(svc))) return ctx.skip('git-lfs is not installed');
    let st = await lfsStatus(svc);
    expect(st).toMatchObject({ available: true, initialized: false, tracked: [], locks: [] });
    await runExtra(svc, { type: 'lfs.install' });
    st = await lfsStatus(svc);
    expect(st.initialized).toBe(true);
    expect(h.git(svc.cwd, 'config', '--local', '--get', 'filter.lfs.process').trim()).toMatch(/git-lfs/);
  });

  it('prunes local LFS objects', async (ctx) => {
    const fx = lfsFixture((m) => ctx.skip(m));
    if (!fx) return;
    const svc = await h.open(fx.path);
    const r = await runExtra(svc, { type: 'lfs.prune' });
    expect(r.summary).toMatch(/Pruned/);
    // the checked-out object is still referenced by HEAD and stays
    expect(h.read(path.join(fx.path, 'asset.bin')).length).toBe(2048);
  });
});
