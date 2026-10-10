import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { conflictState, countMarkerBlocks, loadConflictFile } from '../src/service/phase3';
import { describeGit, tinyRepo, useHarness, type TinyRepo } from './ops-harness';

describe('countMarkerBlocks', () => {
  it('counts opening conflict markers (LF / CRLF, wider markers)', () => {
    expect(countMarkerBlocks('a\n<<<<<<< A\nx\n=======\ny\n>>>>>>> B\n')).toBe(1);
    expect(countMarkerBlocks('<<<<<<< A\r\nx\r\n=======\r\n>>>>>>> B\r\n<<<<<<<<< A\r\n')).toBe(2);
    expect(countMarkerBlocks('<<<<<< not a marker\n<<<<<<<x\n')).toBe(0);
  });
});

/** Spec 08 §4.6 / §6.6 / §6.7 resolutions against real git. */
describeGit('special conflicts and in-progress operations', () => {
  const h = useHarness('special');

  /** Merge `feature` into `main` (expected to conflict). */
  const mergeFeature = (r: TinyRepo): void => {
    try {
      r.g('merge', '--no-edit', 'feature');
    } catch {
      /* conflict */
    }
  };
  const lsStage = (r: TinyRepo, p: string): string[] =>
    r
      .g('ls-files', '-s', '--', p)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.replace(/\t.*$/, ''));
  const hashText = (r: TinyRepo, text: string): string => {
    const f = path.join(r.dir, '.git', 'tmp-blob');
    fs.writeFileSync(f, text);
    const sha = r.g('hash-object', '-w', f).trim();
    fs.rmSync(f);
    return sha;
  };
  const stageCommit = (r: TinyRepo, entry: string, message: string): void => {
    r.g('update-index', '--add', '--cacheinfo', entry);
    r.g('commit', '-q', '-m', message);
  };

  it('submodule: Take A / B sha and "Choose commit…" (update-index --cacheinfo 160000)', async () => {
    const r = await tinyRepo(h);
    const s1 = '1'.repeat(40);
    const s2 = '2'.repeat(40);
    const s3 = '3'.repeat(40);
    const s4 = '4'.repeat(40);
    stageCommit(r, `160000,${s1},sub`, 'add sub');
    r.g('switch', '-q', '-c', 'feature');
    stageCommit(r, `160000,${s3},sub`, 'sub to s3');
    r.g('switch', '-q', 'main');
    stageCommit(r, `160000,${s2},sub`, 'sub to s2');
    mergeFeature(r);
    let st = await conflictState(r.svc);
    expect(st.conflicts).toHaveLength(1);
    expect(st.conflicts[0]).toMatchObject({ path: 'sub', kind: 'submodule', code: 'UU' });

    const err = await h.fail(r.svc, {
      type: 'conflict.resolveSpecial',
      path: 'sub',
      action: { submoduleSha: 'abc' },
    });
    expect(err.message).toMatch(/not a full commit id/);
    await h.run(r.svc, { type: 'conflict.resolveSpecial', path: 'sub', action: { submoduleSha: s4 } });
    expect(lsStage(r, 'sub')).toEqual([`160000 ${s4} 0`]);
    st = await conflictState(r.svc);
    expect(st.conflicts).toEqual([]);
    expect(st.resolvedPending).toEqual(['sub']);

    // whole-side take of a gitlink stages that side's sha
    await h.run(r.svc, { type: 'conflict.markUnresolved', paths: ['sub'] });
    expect((await conflictState(r.svc)).conflicts.map((c) => c.path)).toEqual(['sub']);
    await h.run(r.svc, { type: 'conflict.take', paths: ['sub'], side: 'theirs' });
    expect(lsStage(r, 'sub')).toEqual([`160000 ${s3} 0`]);
  });

  it('symlink: Edit target writes a 120000 entry (plain file when symlinks are off)', async () => {
    const r = await tinyRepo(h);
    stageCommit(r, `120000,${hashText(r, 'base-target')},link`, 'link');
    r.g('switch', '-q', '-c', 'feature');
    stageCommit(r, `120000,${hashText(r, 'theirs-target')},link`, 'link theirs');
    r.g('switch', '-q', 'main');
    stageCommit(r, `120000,${hashText(r, 'ours-target')},link`, 'link ours');
    mergeFeature(r);
    const st = await conflictState(r.svc);
    expect(st.conflicts[0]).toMatchObject({ path: 'link', kind: 'symlink' });
    const c = await loadConflictFile(r.svc, 'link');
    expect([c.ours, c.theirs]).toEqual(['ours-target', 'theirs-target']);

    await h.run(r.svc, {
      type: 'conflict.resolveSpecial',
      path: 'link',
      action: { symlinkTarget: 'edited-target' },
    });
    const [entry] = lsStage(r, 'link');
    expect(entry).toMatch(/^120000 [0-9a-f]+ 0$/);
    expect(r.g('cat-file', '-p', entry!.split(' ')[1]!)).toBe('edited-target');
    const abs = path.join(r.dir, 'link');
    const onDisk = fs.lstatSync(abs).isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs, 'utf8');
    expect(onDisk).toBe('edited-target');
  });

  it('mode conflict: save & mark resolved with the chosen executable bit', async () => {
    const r = await tinyRepo(h, { 'run.sh': 'echo base\n' });
    r.g('switch', '-q', '-c', 'feature');
    r.commit('theirs', { 'run.sh': 'echo theirs\n' });
    r.g('switch', '-q', 'main');
    h.write(path.join(r.dir, 'run.sh'), 'echo ours\n');
    r.g('update-index', '--chmod=+x', 'run.sh');
    r.g('add', 'run.sh');
    r.g('update-index', '--chmod=+x', 'run.sh');
    r.g('commit', '-q', '-m', 'ours +x');
    // Match the committed +x on disk: with core.filemode (Linux/macOS) a mode-only difference counts as
    // a local change, and older git (2.36) then refuses the merge instead of producing the conflict.
    fs.chmodSync(path.join(r.dir, 'run.sh'), 0o755);
    mergeFeature(r);
    const st = await conflictState(r.svc);
    const info = st.conflicts[0]!;
    expect(info.stages.ours?.mode).toBe('100755');
    expect(info.stages.theirs?.mode).toBe('100644');
    expect(info.unresolvedChunks).toBe(1);

    await h.run(r.svc, {
      type: 'conflict.saveFile',
      path: 'run.sh',
      text: 'echo merged\n',
      markResolved: true,
      executable: false,
    });
    expect(lsStage(r, 'run.sh')[0]).toMatch(/^100644 /);
    await h.run(r.svc, { type: 'conflict.markUnresolved', paths: ['run.sh'] });
    await h.run(r.svc, { type: 'conflict.resolveSpecial', path: 'run.sh', action: { executable: true } });
    expect(lsStage(r, 'run.sh')[0]).toMatch(/^100755 /);
  });

  it('take base, chunk counts, resolved-outside detection and resolvedPending', async () => {
    const r = await tinyRepo(h, { 'x.txt': 'base\n', 'y.txt': 'base y\n' });
    r.g('switch', '-q', '-c', 'feature');
    r.commit('theirs', { 'x.txt': 'theirs\n', 'y.txt': 'theirs y\n' });
    r.g('switch', '-q', 'main');
    r.commit('ours', { 'x.txt': 'ours\n', 'y.txt': 'ours y\n' });
    mergeFeature(r);
    let st = await conflictState(r.svc);
    expect(st.conflicts.map((c) => [c.path, c.unresolvedChunks])).toEqual([
      ['x.txt', 1],
      ['y.txt', 1],
    ]);
    // edited outside the app until no markers remain: still unmerged, 0 chunks ("Resolved outside the app")
    h.write(path.join(r.dir, 'y.txt'), 'hand merged\n');
    st = await conflictState(r.svc);
    expect(st.conflicts.find((c) => c.path === 'y.txt')?.unresolvedChunks).toBe(0);

    await h.run(r.svc, { type: 'conflict.take', paths: ['x.txt'], side: 'base' });
    expect(r.file('x.txt')).toBe('base\n');
    expect(r.g('show', ':x.txt')).toBe('base\n');
    st = await conflictState(r.svc);
    expect(st.conflicts.map((c) => c.path)).toEqual(['y.txt']);
    expect(st.resolvedPending).toEqual(['x.txt']);
  });

  it('rename/rename: keep one target, remove the others', async () => {
    const r = await tinyRepo(h, { 'a.txt': 'shared content\nline 2\nline 3\n' });
    r.g('switch', '-q', '-c', 'feature');
    r.g('mv', 'a.txt', 'c.txt');
    r.g('commit', '-q', '-m', 'a -> c');
    r.g('switch', '-q', 'main');
    r.g('mv', 'a.txt', 'b.txt');
    r.g('commit', '-q', '-m', 'a -> b');
    mergeFeature(r);
    const st = await conflictState(r.svc);
    const paths = st.conflicts.map((c) => `${c.code} ${c.path}`).sort();
    expect(paths).toEqual(['AU b.txt', 'DD a.txt', 'UA c.txt']);
    await h.run(r.svc, {
      type: 'conflict.resolveSpecial',
      path: 'a.txt',
      action: { rename: { keep: ['b.txt'], remove: ['a.txt', 'c.txt'] } },
    });
    expect((await conflictState(r.svc)).conflicts).toEqual([]);
    expect(r.g('ls-files').split(/\r?\n/).filter(Boolean).sort()).toEqual(['b.txt']);
    expect(fs.existsSync(path.join(r.dir, 'c.txt'))).toBe(false);
  });

  it('stash pop conflict: stash info, Reset conflicted changes keeps the stash', async () => {
    const r = await tinyRepo(h, { 'x.txt': '1\n' });
    h.write(path.join(r.dir, 'x.txt'), 'stashed\n');
    r.g('stash', 'push', '-q', '-m', 'wip');
    r.commit('C', { 'x.txt': 'committed\n' });
    try {
      r.g('stash', 'pop');
    } catch {
      /* conflict */
    }
    const st = await conflictState(r.svc);
    expect(st.op).toBe('stash-apply');
    expect(st.stash).toMatchObject({ index: 0 });
    expect(st.stash?.message).toMatch(/wip/);
    expect(st.incoming.label).toBe('Stashed changes (stash@{0})');
    await h.run(r.svc, { type: 'conflict.resetMerge' });
    const after = await conflictState(r.svc);
    expect(after.op).toBeNull();
    expect(r.file('x.txt')).toBe('committed\n');
    expect(r.g('stash', 'list')).toMatch(/wip/);
  });

  it('git am: banner state and Skip / Abort', async () => {
    const r = await tinyRepo(h, { 'x.txt': 'base\n' });
    r.g('switch', '-q', '-c', 'patches');
    r.commit('patch 1', { 'x.txt': 'patched\n' });
    r.commit('patch 2', { 'other.txt': 'second\n' });
    const dir = path.join(r.dir, '..', `patches-${Date.now()}`);
    r.g('format-patch', '-q', '-o', dir, 'main..patches');
    r.g('switch', '-q', 'main');
    r.commit('diverge', { 'x.txt': 'main change\n' });
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
    try {
      r.g('am', ...files);
    } catch {
      /* patch 1 does not apply */
    }
    let st = await conflictState(r.svc);
    expect(st.op).toBe('am');
    const skipped = await h.run(r.svc, { type: 'am.skip' });
    expect(skipped.summary).toBe('All patches applied');
    st = await conflictState(r.svc);
    expect(st.op).toBeNull();
    expect(r.file('other.txt')).toBe('second\n');

    r.g('reset', '-q', '--hard', 'HEAD~1');
    try {
      r.g('am', ...files);
    } catch {
      /* conflict again */
    }
    expect((await conflictState(r.svc)).op).toBe('am');
    await h.run(r.svc, { type: 'am.abort' });
    expect((await conflictState(r.svc)).op).toBeNull();
  });

  it('custom merge driver is reported (text tool disabled)', async () => {
    const r = await tinyRepo(h, { 'd.txt': 'base\n', '.gitattributes': 'd.txt merge=custom\n' });
    r.g('config', 'merge.custom.driver', 'false');
    r.g('switch', '-q', '-c', 'feature');
    r.commit('theirs', { 'd.txt': 'theirs\n' });
    r.g('switch', '-q', 'main');
    r.commit('ours', { 'd.txt': 'ours\n' });
    mergeFeature(r);
    const st = await conflictState(r.svc);
    expect(st.conflicts[0]).toMatchObject({ path: 'd.txt', mergeDriver: 'custom' });
    const c = await loadConflictFile(r.svc, 'd.txt');
    expect(c.mergeDriver).toBe('custom');
  });

  it('picks up a merge started outside the app (terminal)', async () => {
    const r = await tinyRepo(h, { 'x.txt': 'base\n' });
    r.g('switch', '-q', '-c', 'feature');
    r.commit('theirs', { 'x.txt': 'theirs\n' });
    r.g('switch', '-q', 'main');
    r.commit('ours', { 'x.txt': 'ours\n' });
    expect((await conflictState(r.svc)).op).toBeNull();
    mergeFeature(r); // e.g. `git merge feature` in the integrated terminal
    const st = await conflictState(r.svc);
    expect(st.op).toBe('merge');
    expect(st.incoming.label).toBe('feature');
    expect(st.conflicts.map((c) => c.path)).toEqual(['x.txt']);
    r.g('merge', '--abort');
    expect((await conflictState(r.svc)).op).toBeNull();
  });
});
