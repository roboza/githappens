import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { sparseState } from '../src/ops/executors/sparse';
import { describeGit, tinyRepo, useHarness } from './ops-harness';

describeGit('sparse checkout ops', () => {
  const h = useHarness('sparse');

  it('set / add / reapply / disable through the queue', async () => {
    const r = await tinyRepo(h, { 'README.md': 'r\n' });
    r.commit('tree', { 'src/a.txt': 'a\n', 'docs/b.txt': 'b\n', 'lib/c.txt': 'c\n' });
    r.svc = await h.open(r.dir);

    expect(await sparseState(r.svc)).toMatchObject({ enabled: false, patterns: [] });

    await h.run(r.svc, { type: 'sparse.set', patterns: ['src'] });
    let s = await sparseState(r.svc);
    expect(s).toMatchObject({ enabled: true, cone: true, patterns: ['src'] });
    expect(fs.existsSync(path.join(r.dir, 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(r.dir, 'src', 'a.txt'))).toBe(true);

    await h.run(r.svc, { type: 'sparse.add', patterns: ['docs/'] });
    s = await sparseState(r.svc);
    expect(s.patterns.sort()).toEqual(['docs', 'src']);
    expect(fs.existsSync(path.join(r.dir, 'docs', 'b.txt'))).toBe(true);

    // a cone repo refuses globs
    const err = await h.fail(r.svc, { type: 'sparse.add', patterns: ['*.txt'] });
    expect(err.message).toMatch(/Cone mode/);

    await h.run(r.svc, { type: 'sparse.reapply' });
    await h.run(r.svc, { type: 'sparse.disable' });
    s = await sparseState(r.svc);
    expect(s.enabled).toBe(false);
    expect(fs.existsSync(path.join(r.dir, 'lib', 'c.txt'))).toBe(true);

    // non-cone patterns when globbed
    await h.run(r.svc, { type: 'sparse.set', patterns: ['/*', '!/*/', '/lib/'] });
    s = await sparseState(r.svc);
    expect(s.cone).toBe(false);
    expect(fs.existsSync(path.join(r.dir, 'lib', 'c.txt'))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, 'src'))).toBe(false);

    // nothing is journaled: the undo stack ignores sparse changes
    const peek = await h.run(r.svc, { type: 'sparse.disable' });
    expect(peek.summary).toMatch(/disabled/);
  });

  it('rejects empty and escaping paths', async () => {
    const r = await tinyRepo(h);
    r.svc = await h.open(r.dir);
    expect((await h.fail(r.svc, { type: 'sparse.set', patterns: [' '] })).message).toMatch(/at least one/);
    expect((await h.fail(r.svc, { type: 'sparse.set', patterns: ['../x'] })).message).toMatch(/inside/);
    expect((await h.fail(r.svc, { type: 'sparse.reapply' })).message).toMatch(/not enabled/);
  });
});
