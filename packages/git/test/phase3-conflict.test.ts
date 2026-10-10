import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  conflictState,
  isAncestor,
  loadConflictFile,
  openExternalMergeTool,
  openExternalMergeToolArgv,
  predictConflicts,
  splitCommandTemplate,
  substituteVars,
} from '../src/service/phase3';
import { describeGit, gitAtLeast, tinyRepo, useHarness } from './ops-harness';

describe('external merge tool template', () => {
  it('splits like a shell without expanding anything', () => {
    expect(splitCommandTemplate('bcomp "$LOCAL" "$REMOTE" "$BASE" -mergeoutput="$MERGED"', 'linux')).toEqual([
      'bcomp',
      '$LOCAL',
      '$REMOTE',
      '$BASE',
      '-mergeoutput=$MERGED',
    ]);
    expect(splitCommandTemplate(`"C:\\Program Files\\T\\t.exe" '$BASE' x\\ y`, 'win32')).toEqual([
      'C:\\Program Files\\T\\t.exe',
      '$BASE',
      'x\\',
      'y',
    ]);
    expect(splitCommandTemplate('a\\ b "q\\"x"', 'linux')).toEqual(['a b', 'q"x']);
    expect(() => splitCommandTemplate('a "b')).toThrow(/quote/);
  });
  it('substitutes $VARS and ${VARS} inside words', () => {
    const vars = { BASE: '/b', LOCAL: '/l', REMOTE: '/r', MERGED: '/m; rm -rf /' };
    expect(substituteVars('-o=$MERGED', vars)).toBe('-o=/m; rm -rf /');
    expect(substituteVars('${LOCAL}x', vars)).toBe('/lx');
    expect(substituteVars('$BASEX', vars)).toBe('$BASEX');
  });
});

describeGit('Phase 3 conflict reads and resolution executors', () => {
  const h = useHarness('p3conf');

  async function inProgress() {
    const fx = h.fixture('conflict-in-progress');
    const svc = await h.open(fx.path);
    return { dir: fx.path, svc, files: fx.facts.conflictedFiles as string[] };
  }

  describe('conflictState', () => {
    it('reports a merge with labels, base, message and per-file codes/kinds', async () => {
      const { dir, svc } = await inProgress();
      const st = await conflictState(svc);
      const rev = (r: string) => h.git(dir, 'rev-parse', r).trim();
      expect(st.op).toBe('merge');
      expect(st.current).toEqual({ label: 'main', sha: rev('HEAD') });
      expect(st.incoming).toEqual({ label: 'feature', sha: rev('feature') });
      expect(st.base?.sha).toBe(h.git(dir, 'merge-base', 'main', 'feature').trim());
      expect(st.message).toMatch(/^Merge branch 'feature'/);
      const byPath = Object.fromEntries(st.conflicts.map((c) => [c.path, c]));
      expect(Object.keys(byPath)).toEqual(['add-add.txt', 'binary.dat', 'content.txt', 'delete-modify.txt']);
      expect(byPath['content.txt']).toMatchObject({ code: 'UU', kind: 'text' });
      expect(byPath['add-add.txt']).toMatchObject({ code: 'AA', kind: 'text' });
      expect(byPath['add-add.txt']!.stages.base).toBeUndefined();
      expect(byPath['binary.dat']).toMatchObject({ code: 'UU', kind: 'binary' });
      expect(byPath['delete-modify.txt']).toMatchObject({ code: 'DU', kind: 'text' });
      expect(byPath['delete-modify.txt']!.stages.ours).toBeUndefined();
      expect(byPath['content.txt']!.stages.ours).toMatchObject({ mode: '100644' });
    });

    it('is empty when nothing is in progress', async () => {
      const r = await tinyRepo(h);
      const st = await conflictState(r.svc);
      expect(st).toMatchObject({ op: null, conflicts: [], current: { label: 'main' } });
    });

    it('detects a conflicted stash pop as stash-apply', async () => {
      const r = await tinyRepo(h, { 'x.txt': '1\n' });
      h.write(path.join(r.dir, 'x.txt'), 'stashed\n');
      r.g('stash', 'push', '-q');
      r.commit('C', { 'x.txt': 'committed\n' });
      try {
        r.g('stash', 'pop');
      } catch {
        /* conflict */
      }
      const st = await conflictState(r.svc);
      expect(st.op).toBe('stash-apply');
      expect(st.incoming.label).toMatch(/^Stashed changes/);
      expect(st.conflicts.map((c) => c.path)).toEqual(['x.txt']);
      // "reset conflicted changes" = merge.abort (reset --merge) keeps the stash
      await h.run(r.svc, { type: 'merge.abort' });
      expect((await conflictState(r.svc)).op).toBeNull();
      expect(r.g('stash', 'list').trim()).not.toBe('');
    });
  });

  describe('loadConflictFile', () => {
    it('loads a text conflict with a diff3 merge', async () => {
      const { dir, svc } = await inProgress();
      const f = await loadConflictFile(svc, 'content.txt');
      expect(f.binary).toBe(false);
      expect(f.eol).toBe('\n');
      expect(f.base).toContain('line 3\n');
      expect(f.ours).toContain('line 3 changed on main');
      expect(f.theirs).toContain('line 3 changed on feature');
      expect(f.working).toBe(h.read(path.join(dir, 'content.txt')));
      expect(f.mergedDiff3).toMatch(/^<{7} A\n[\s\S]*^\|{7} base\n[\s\S]*^={7}\n[\s\S]*^>{7} B$/m);
    });

    it('add/add has no base; delete/modify has no ours and no merge', async () => {
      const { svc } = await inProgress();
      const aa = await loadConflictFile(svc, 'add-add.txt');
      expect(aa.base).toBeNull();
      expect(aa.mergedDiff3).toContain('main version');
      expect(aa.mergedDiff3).toContain('feature version');
      const dm = await loadConflictFile(svc, 'delete-modify.txt');
      expect(dm).toMatchObject({
        base: 'original\n',
        ours: null,
        theirs: 'modified on feature\n',
        mergedDiff3: null,
      });
    });

    it('flags binary conflicts', async () => {
      const { svc } = await inProgress();
      const b = await loadConflictFile(svc, 'binary.dat');
      expect(b).toMatchObject({ binary: true, mergedDiff3: null, ours: '', theirs: '', base: '' });
    });

    it('keeps CRLF and widens markers when the file contains marker-like lines', async () => {
      const r = await tinyRepo(h, { 'w.txt': 'a\r\n=======\r\nb\r\n' });
      r.g('switch', '-q', '-c', 'side');
      r.commit('S', { 'w.txt': 'a\r\n=======\r\nside\r\n' });
      r.g('switch', '-q', 'main');
      r.commit('M', { 'w.txt': 'a\r\n=======\r\nmain\r\n' });
      await h.fail(r.svc, { type: 'merge.run', source: 'side', mode: 'default' });
      const f = await loadConflictFile(r.svc, 'w.txt');
      expect(f.eol).toBe('\r\n');
      expect(f.mergedDiff3).toMatch(/^<{8} A\r?$/m);
      // saveFile keeps CRLF even if the editor hands back LF
      await h.run(r.svc, {
        type: 'conflict.saveFile',
        path: 'w.txt',
        text: 'a\n=======\nboth\n',
        markResolved: true,
      });
      expect(fs.readFileSync(path.join(r.dir, 'w.txt'), 'utf8')).toBe('a\r\n=======\r\nboth\r\n');
    });

    it('rejects paths outside the worktree', async () => {
      const { svc } = await inProgress();
      await expect(loadConflictFile(svc, '../x')).rejects.toThrow(/outside/);
    });
  });

  describe('resolution executors', () => {
    it('take ours/theirs, mark resolved/unresolved, save with marker check', async () => {
      const { dir, svc } = await inProgress();
      const conflicted = async () => (await conflictState(svc)).conflicts.map((c) => c.path);

      await h.run(svc, { type: 'conflict.take', paths: ['content.txt'], side: 'ours' });
      expect(h.read(path.join(dir, 'content.txt'))).toContain('changed on main');
      expect(await conflicted()).not.toContain('content.txt');

      await h.run(svc, { type: 'conflict.markUnresolved', paths: ['content.txt'] });
      expect(await conflicted()).toContain('content.txt');
      expect(h.read(path.join(dir, 'content.txt'))).toMatch(/^<{7}/m);

      const saved = await h.run(svc, {
        type: 'conflict.saveFile',
        path: 'content.txt',
        text: h.read(path.join(dir, 'content.txt')),
        markResolved: false,
      });
      expect(saved.data).toEqual({ hasMarkers: true });
      expect(saved.warnings?.[0]).toMatch(/markers/);
      expect(await conflicted()).toContain('content.txt');

      // delete/modify: taking "ours" (the deletion) removes the file
      await h.run(svc, { type: 'conflict.take', paths: ['delete-modify.txt'], side: 'ours' });
      expect(fs.existsSync(path.join(dir, 'delete-modify.txt'))).toBe(false);
      expect(await conflicted()).not.toContain('delete-modify.txt');

      h.write(path.join(dir, 'add-add.txt'), 'combined\n');
      await h.run(svc, { type: 'conflict.markResolved', paths: ['add-add.txt'] });
      expect(h.git(dir, 'show', ':add-add.txt')).toBe('combined\n');

      await h.run(svc, { type: 'conflict.resolveSpecial', path: 'binary.dat', action: 'keep' });
      expect(await conflicted()).toEqual(['content.txt']);
    });

    it('keep on delete/modify stages the modified file', async () => {
      const { dir, svc } = await inProgress();
      await h.run(svc, { type: 'conflict.resolveSpecial', path: 'delete-modify.txt', action: 'keep' });
      expect(h.git(dir, 'show', ':delete-modify.txt')).toBe('modified on feature\n');
    });
  });

  describe('predictConflicts / isAncestor', () => {
    it('predicts the conflicting paths without touching the worktree', async () => {
      const fx = h.fixture('conflict');
      const svc = await h.open(fx.path);
      const p = await predictConflicts(svc, 'main', 'feature');
      // `merge-tree --write-tree` needs git ≥ 2.38; older system git reports "unsupported" instead.
      if (!gitAtLeast(2, 38)) return expect(p).toEqual({ supported: false, conflicts: [] });
      expect(p.supported).toBe(true);
      expect([...p.conflicts].sort()).toEqual(fx.facts.conflictedFiles);
      expect(svc.repo.state).toBe('clean');
      expect(h.git(fx.path, 'status', '--porcelain').trim()).toBe('');
      // cached result is a copy
      p.conflicts.length = 0;
      expect((await predictConflicts(svc, 'main', 'feature')).conflicts).toHaveLength(4);
    });

    it('reports a clean merge', async () => {
      const fx = h.fixture('branchy');
      const svc = await h.open(fx.path);
      expect(await predictConflicts(svc, 'main', 'feature-b')).toEqual({
        supported: gitAtLeast(2, 38),
        conflicts: [],
      });
      expect(await isAncestor(svc, 'feature-a', 'main')).toBe(true);
      expect(await isAncestor(svc, 'feature-b', 'main')).toBe(false);
    });
  });

  describe('openExternalMergeTool', () => {
    it('writes BASE/LOCAL/REMOTE, substitutes the variables and reports the result', async () => {
      const { dir, svc } = await inProgress();
      const script = path.join(h.root, 'fake-tool.cjs');
      fs.writeFileSync(
        script,
        `const fs = require('fs');
const [base, local, remote, merged] = process.argv.slice(2);
fs.writeFileSync(merged, ['BASE:' + fs.readFileSync(base, 'utf8'), 'LOCAL:' + fs.readFileSync(local, 'utf8'), 'REMOTE:' + fs.readFileSync(remote, 'utf8')].join(''));
process.exit(0);`,
      );
      const tpl = `"${process.execPath}" "${script}" "$BASE" "$LOCAL" "$REMOTE" "$MERGED"`;
      const res = await openExternalMergeTool(svc, 'add-add.txt', tpl);
      expect(res).toEqual({ exitCode: 0, changed: true, hasMarkers: false });
      expect(h.read(path.join(dir, 'add-add.txt'))).toBe('BASE:LOCAL:main version\nREMOTE:feature version\n');

      const noop = path.join(h.root, 'noop.cjs');
      fs.writeFileSync(noop, 'process.exit(3);');
      const r2 = await openExternalMergeTool(svc, 'content.txt', `"${process.execPath}" "${noop}" "$MERGED"`);
      expect(r2).toEqual({ exitCode: 3, changed: false, hasMarkers: true });
    });

    it('builds argv through the caller, uses the injected launcher and keeps a .orig backup on request', async () => {
      const { dir, svc } = await inProgress();
      const before = h.read(path.join(dir, 'content.txt'));
      const seen: string[][] = [];
      const res = await openExternalMergeToolArgv(
        svc,
        'content.txt',
        (v) => ['tool', '--out', v.MERGED, v.LOCAL, v.REMOTE, v.BASE],
        {
          keepBackup: true,
          launch: async (argv) => {
            seen.push(argv);
            fs.writeFileSync(argv[2]!, 'resolved\n');
            return 0;
          },
        },
      );
      expect(seen[0]![0]).toBe('tool');
      expect(seen[0]![2]).toBe(path.join(dir, 'content.txt'));
      expect(res).toMatchObject({ exitCode: 0, changed: true, hasMarkers: false });
      expect(res.backupPath).toBe(path.join(dir, 'content.txt.orig'));
      expect(h.read(res.backupPath!)).toBe(before);

      const r2 = await openExternalMergeToolArgv(svc, 'add-add.txt', () => ['tool'], {
        launch: async () => 1,
      });
      expect(r2.backupPath).toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'add-add.txt.orig'))).toBe(false);
    });
  });

  describe('conflict.mergetool (strategy A)', () => {
    const fakeTool = (svcDir: string, exit: number): void => {
      const script = path.join(h.root, `git-tool-${exit}.cjs`);
      fs.writeFileSync(
        script,
        `require('fs').writeFileSync(process.argv[2], 'from tool\\n'); process.exit(${exit});`,
      );
      const q = (p: string): string => `"${p.replace(/\\/g, '/')}"`;
      h.git(svcDir, 'config', 'mergetool.fake.cmd', `${q(process.execPath)} ${q(script)} "$MERGED"`);
    };

    it('runs git mergetool non-interactively and stages the result when the tool succeeds', async () => {
      const { dir, svc } = await inProgress();
      fakeTool(dir, 0);
      const r = await h.run(svc, {
        type: 'conflict.mergetool',
        path: 'content.txt',
        tool: 'fake',
        trustExitCode: true,
        keepBackup: false,
      });
      expect(r.data).toMatchObject({ resolved: true });
      expect(h.read(path.join(dir, 'content.txt'))).toBe('from tool\n');
      expect(h.git(dir, 'diff', '--name-only', '--diff-filter=U')).not.toMatch(/content\.txt/);
      expect(fs.existsSync(path.join(dir, 'content.txt.orig'))).toBe(false);
    });

    it('leaves the file unmerged when a trusted tool fails, and keeps a backup on request', async () => {
      const { dir, svc } = await inProgress();
      fakeTool(dir, 1);
      const r = await h.run(svc, {
        type: 'conflict.mergetool',
        path: 'content.txt',
        tool: 'fake',
        trustExitCode: true,
        keepBackup: true,
      });
      expect(r.data).toMatchObject({ resolved: false });
      expect(h.git(dir, 'diff', '--name-only', '--diff-filter=U')).toMatch(/content\.txt/);
    });

    it('rejects option-like tool names', async () => {
      const { svc } = await inProgress();
      const e = await h.fail(svc, { type: 'conflict.mergetool', path: 'content.txt', tool: '-c x=y' });
      expect(e.message).toMatch(/Invalid merge tool/);
    });
  });
});
