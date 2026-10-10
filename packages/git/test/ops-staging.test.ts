import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, expect, it } from 'vitest';

import { diffHash, STAGING_DIFF_OPTIONS } from '../src/ops/diff-hash';
import type { GitService } from '../src/service/git-service';
import type { FileDiff } from '../src/types';
import { describeGit, useHarness } from './ops-harness';

const nums = (n: number, p = 'l'): string[] => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const text = (lines: string[], eol = '\n', finalEol = true): string =>
  lines.join(eol) + (finalEol ? eol : '');

describeGit('staging executors', () => {
  const h = useHarness('staging');
  let dir: string;
  let svc: GitService;
  const abs = (p: string) => path.join(dir, p);
  const show = (spec: string) => h.gitBuf(dir, 'show', spec).toString('utf8');
  const statusLine = () => h.git(dir, 'status', '--porcelain=v1', '--untracked-files=all');

  /** Reset the repo to a single committed state between tests. */
  const reset = (files: Record<string, string | Buffer>) => {
    h.git(dir, 'reset', '-q', '--hard');
    h.git(dir, 'clean', '-fdq');
    for (const f of h.git(dir, 'ls-files', '-z').split('\0').filter(Boolean)) {
      if (!(f in files)) h.git(dir, 'rm', '-q', '--', f);
    }
    for (const [f, c] of Object.entries(files)) h.write(abs(f), c);
    h.git(dir, 'add', '-A');
    h.git(dir, 'commit', '-q', '--allow-empty', '-m', 'state');
  };
  const fileDiff = async (p: string, kind: 'workdir' | 'staged' | 'untracked'): Promise<FileDiff> => {
    const list =
      kind === 'untracked'
        ? await svc.diff({ kind, path: p }, STAGING_DIFF_OPTIONS)
        : await svc.diff({ kind, paths: [p] }, STAGING_DIFF_OPTIONS);
    const f = list.find((d) => d.newPath === p || d.oldPath === p) ?? list[0];
    if (!f) throw new Error(`no diff for ${p}`);
    return f;
  };
  /** Line refs for diff lines matching a predicate. */
  const refs = (f: FileDiff, pred: (type: string, content: string) => boolean) =>
    f.hunks.flatMap((hk, hunkIndex) =>
      hk.lines.flatMap((l, lineIndex) => (pred(l.type, l.content) ? [{ hunkIndex, lineIndex }] : [])),
    );

  beforeAll(async () => {
    dir = h.fixture('linear', { count: 1 }).path;
    svc = await h.open(dir);
  });

  it('stages and unstages files, and everything', async () => {
    reset({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    h.write(abs('a.txt'), 'a2\n');
    fs.rmSync(abs('b.txt'));
    h.write(abs('new dir/n ü.txt'), 'n\n');
    await h.run(svc, { type: 'wip.stage', paths: ['a.txt', 'b.txt', 'new dir/n ü.txt'] });
    expect(statusLine()).toMatch(/^M {2}a\.txt$/m);
    expect(statusLine()).toMatch(/^D {2}b\.txt$/m);
    expect(statusLine()).toMatch(/^A {2}"?new dir\/n/m);
    await h.run(svc, { type: 'wip.unstage', paths: ['a.txt', 'new dir/n ü.txt'] });
    expect(statusLine()).toMatch(/^ M a\.txt$/m);
    expect(statusLine()).toMatch(/^\?\? "?new dir/m);
    await h.run(svc, { type: 'wip.stageAll' });
    expect(statusLine()).not.toMatch(/^.[MD?]/m);
    await h.run(svc, { type: 'wip.unstageAll' });
    expect(statusLine()).not.toMatch(/^[MAD]/m);
  });

  it('stages, unstages and discards whole hunks', async () => {
    const base = nums(20);
    reset({ 'h.txt': text(base) });
    const changed = [...base];
    changed[1] = 'L2';
    changed[14] = 'L15';
    h.write(abs('h.txt'), text(changed));

    let f = await fileDiff('h.txt', 'workdir');
    expect(f.hunks).toHaveLength(2);
    await h.run(svc, { type: 'wip.stageHunk', path: 'h.txt', hunkIndex: 1, diffHash: diffHash(f) });
    const staged = [...base];
    staged[14] = 'L15';
    expect(show(':h.txt')).toBe(text(staged));

    f = await fileDiff('h.txt', 'staged');
    await h.run(svc, { type: 'wip.unstageHunk', path: 'h.txt', hunkIndex: 0, diffHash: diffHash(f) });
    expect(show(':h.txt')).toBe(text(base));

    f = await fileDiff('h.txt', 'workdir');
    await h.run(svc, { type: 'wip.discardHunk', path: 'h.txt', hunkIndex: 0, diffHash: diffHash(f) });
    const left = [...base];
    left[14] = 'L15';
    expect(h.read(abs('h.txt'))).toBe(text(left));
  });

  it('stages only the selected line (spec 06 §6.5 worked example)', async () => {
    reset({ 'w.txt': text(['x', 'a', 'b', 'c', 'd', 'y']) });
    h.write(abs('w.txt'), text(['x', 'a', 'B1', 'B2', 'c', 'd', 'y']));
    const f = await fileDiff('w.txt', 'workdir');
    const lines = refs(f, (t, c) => t === 'add' && c === 'B2');
    await h.run(svc, { type: 'wip.stageLines', path: 'w.txt', lines, diffHash: diffHash(f) });
    expect(show(':w.txt')).toBe(text(['x', 'a', 'b', 'B2', 'c', 'd', 'y']));
    // what is left unstaged is -b +B1 relative to the index
    const rest = await fileDiff('w.txt', 'workdir');
    const changes = rest.hunks.flatMap((hk) =>
      hk.lines.filter((l) => l.type !== 'context').map((l) => `${l.type}:${l.content}`),
    );
    expect(changes).toEqual(['del:b', 'add:B1']);
  });

  it('stages selected lines across hunks, unstages and discards lines', async () => {
    const base = nums(30);
    reset({ 'm.txt': text(base) });
    const changed = [...base];
    changed[2] = 'L3';
    changed.splice(20, 0, 'ins-a', 'ins-b');
    h.write(abs('m.txt'), text(changed));
    let f = await fileDiff('m.txt', 'workdir');
    expect(f.hunks).toHaveLength(2);
    // stage "-l3" (only the deletion) and "+ins-b"
    const sel = refs(f, (t, c) => (t === 'del' && c === 'l3') || (t === 'add' && c === 'ins-b'));
    await h.run(svc, { type: 'wip.stageLines', path: 'm.txt', lines: sel, diffHash: diffHash(f) });
    const idx = [...base];
    idx.splice(2, 1);
    idx.splice(19, 0, 'ins-b');
    expect(show(':m.txt')).toBe(text(idx));

    // unstage the "+ins-b" line again
    f = await fileDiff('m.txt', 'staged');
    await h.run(svc, {
      type: 'wip.unstageLines',
      path: 'm.txt',
      lines: refs(f, (t, c) => t === 'add' && c === 'ins-b'),
      diffHash: diffHash(f),
    });
    const idx2 = [...base];
    idx2.splice(2, 1);
    expect(show(':m.txt')).toBe(text(idx2));

    // discard "+ins-a" from the worktree; everything else stays
    f = await fileDiff('m.txt', 'workdir');
    await h.run(svc, {
      type: 'wip.discardLines',
      path: 'm.txt',
      lines: refs(f, (t, c) => t === 'add' && c === 'ins-a'),
      diffHash: diffHash(f),
    });
    const wt = [...changed];
    wt.splice(20, 1);
    expect(h.read(abs('m.txt'))).toBe(text(wt));
  });

  it('keeps CRLF bytes when staging and discarding lines', async () => {
    const base = nums(8);
    reset({ 'crlf.txt': text(base, '\r\n') });
    const changed = [...base];
    changed[1] = 'two';
    changed[6] = 'seven';
    h.write(abs('crlf.txt'), text(changed, '\r\n'));
    let f = await fileDiff('crlf.txt', 'workdir');
    const twoLines = refs(f, (t, c) => (t === 'add' && c === 'two\r') || (t === 'del' && c === 'l2\r'));
    expect(twoLines).toHaveLength(2);
    await h.run(svc, { type: 'wip.stageLines', path: 'crlf.txt', lines: twoLines, diffHash: diffHash(f) });
    const idx = [...base];
    idx[1] = 'two';
    expect(show(':crlf.txt')).toBe(text(idx, '\r\n'));

    f = await fileDiff('crlf.txt', 'workdir');
    const seven = refs(f, (t, c) => (t === 'add' && c === 'seven\r') || (t === 'del' && c === 'l7\r'));
    await h.run(svc, { type: 'wip.discardLines', path: 'crlf.txt', lines: seven, diffHash: diffHash(f) });
    expect(fs.readFileSync(abs('crlf.txt')).toString('utf8')).toBe(text(idx, '\r\n'));
  });

  it('discards lines in memory with core.autocrlf=true (LF index, CRLF worktree)', async () => {
    reset({});
    h.git(dir, 'config', 'core.autocrlf', 'true');
    try {
      const base = nums(6);
      h.write(abs('auto.txt'), text(base, '\r\n'));
      h.git(dir, 'add', 'auto.txt');
      h.git(dir, 'commit', '-q', '-m', 'auto');
      expect(show(':auto.txt')).toBe(text(base)); // index is LF
      const changed = [...base];
      changed[2] = 'THREE';
      h.write(abs('auto.txt'), text(changed, '\r\n'));
      const f = await fileDiff('auto.txt', 'workdir');
      await h.run(svc, { type: 'wip.discardHunk', path: 'auto.txt', hunkIndex: 0, diffHash: diffHash(f) });
      expect(fs.readFileSync(abs('auto.txt')).toString('utf8')).toBe(text(base, '\r\n'));
    } finally {
      h.git(dir, 'config', 'core.autocrlf', 'false');
    }
  });

  it('stages part of a new (untracked) file, and all of it via git add', async () => {
    reset({});
    h.write(abs('fresh.txt'), text(['x1', 'x2', 'x3']));
    let f = await fileDiff('fresh.txt', 'untracked');
    await h.run(svc, {
      type: 'wip.stageLines',
      path: 'fresh.txt',
      lines: refs(f, (t, c) => t === 'add' && c !== 'x2'),
      diffHash: diffHash(f),
    });
    expect(show(':fresh.txt')).toBe(text(['x1', 'x3']));

    h.write(abs('fresh2.txt'), text(['y1', 'y2']));
    f = await fileDiff('fresh2.txt', 'untracked');
    await h.run(svc, { type: 'wip.stageHunk', path: 'fresh2.txt', hunkIndex: 0, diffHash: diffHash(f) });
    expect(show(':fresh2.txt')).toBe(text(['y1', 'y2']));
  });

  it('handles files without a final newline (linked EOF pair)', async () => {
    reset({ 'noeol.txt': 'a\nb\nc' });
    h.write(abs('noeol.txt'), 'a\nb\nC');
    let f = await fileDiff('noeol.txt', 'workdir');
    expect(f.noNewlineAtEof).toEqual({ old: true, new: true });
    // selecting only "+C" also selects its "-c" partner
    await h.run(svc, {
      type: 'wip.stageLines',
      path: 'noeol.txt',
      lines: refs(f, (t) => t === 'add'),
      diffHash: diffHash(f),
    });
    expect(show(':noeol.txt')).toBe('a\nb\nC');
    f = await fileDiff('noeol.txt', 'staged');
    await h.run(svc, { type: 'wip.unstageHunk', path: 'noeol.txt', hunkIndex: 0, diffHash: diffHash(f) });
    expect(show(':noeol.txt')).toBe('a\nb\nc');
    f = await fileDiff('noeol.txt', 'workdir');
    await h.run(svc, {
      type: 'wip.discardLines',
      path: 'noeol.txt',
      lines: refs(f, (t) => t === 'del'),
      diffHash: diffHash(f),
    });
    expect(fs.readFileSync(abs('noeol.txt'), 'utf8')).toBe('a\nb\nc');
    expect(statusLine()).toBe('');
  });

  it('refuses when the diff changed since it was shown', async () => {
    reset({ 's.txt': 'one\n' });
    h.write(abs('s.txt'), 'two\n');
    const err = await h.fail(svc, {
      type: 'wip.stageHunk',
      path: 's.txt',
      hunkIndex: 0,
      diffHash: 'deadbeef',
    });
    expect(err.code).toBe('Unknown');
    expect(err.message).toBe('The file changed; refresh and try again.');
    const f = await fileDiff('s.txt', 'workdir');
    const stale = await h.fail(svc, {
      type: 'wip.stageLines',
      path: 's.txt',
      lines: [{ hunkIndex: 3, lineIndex: 0 }],
      diffHash: diffHash(f),
    });
    expect(stale.message).toBe('The file changed; refresh and try again.');
  });

  it('discards files (tracked + untracked) and everything', async () => {
    reset({ 'k.txt': 'k\n', 'keep.txt': 'keep\n' });
    h.write(abs('k.txt'), 'changed\n');
    h.git(dir, 'add', 'k.txt');
    h.write(abs('k.txt'), 'changed again\n');
    h.write(abs('u/new.txt'), 'u\n');
    h.write(abs('keep.txt'), 'keep changed\n');
    await h.run(svc, { type: 'wip.discard', paths: ['k.txt', 'u'], includeUntracked: false });
    expect(h.read(abs('k.txt'))).toBe('k\n');
    expect(fs.existsSync(abs('u/new.txt'))).toBe(true);
    await h.run(svc, { type: 'wip.discard', paths: ['u/new.txt'], includeUntracked: true });
    expect(fs.existsSync(abs('u/new.txt'))).toBe(false);
    expect(h.read(abs('keep.txt'))).toBe('keep changed\n');

    h.write(abs('other.txt'), 'o\n');
    await h.run(svc, { type: 'wip.discardAll', includeUntracked: true });
    expect(h.read(abs('keep.txt'))).toBe('keep\n');
    expect(fs.existsSync(abs('other.txt'))).toBe(false);
    expect(statusLine()).toBe('');
  });

  it('ignores a pattern and stops tracking', async () => {
    reset({ 'app.log': 'log\n', '.gitignore': 'node_modules/' });
    const r = await h.run(svc, { type: 'wip.ignore', pattern: '*.log', stopTracking: ['app.log'] });
    expect(r.summary).toContain('*.log');
    expect(h.read(abs('.gitignore'))).toBe('node_modules/\n*.log\n');
    expect(fs.existsSync(abs('app.log'))).toBe(true);
    expect(statusLine()).toMatch(/^D {2}app\.log$/m);
    const again = await h.run(svc, { type: 'wip.ignore', pattern: '*.log' });
    expect(again.warnings?.[0]).toContain('already');
  });

  it('unstages on an unborn branch', async () => {
    const empty = await h.open(h.fixture('empty').path);
    const d = empty.repo.worktreeRoot!;
    h.write(path.join(d, 'f.txt'), 'f\n');
    await h.run(empty, { type: 'wip.stageAll' });
    expect(h.git(d, 'status', '--porcelain')).toMatch(/^A {2}f\.txt/m);
    await h.run(empty, { type: 'wip.unstage', paths: ['f.txt'] });
    expect(h.git(d, 'status', '--porcelain')).toMatch(/^\?\? f\.txt/m);
    await h.run(empty, { type: 'wip.stage', paths: ['f.txt'] });
    await h.run(empty, { type: 'wip.unstageAll' });
    expect(h.git(d, 'status', '--porcelain')).toMatch(/^\?\? f\.txt/m);
  });
});
