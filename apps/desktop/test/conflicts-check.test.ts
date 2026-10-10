import fs from 'node:fs';
import path from 'node:path';

import type { GitService } from '@githappens/git';
import { describe, expect, it, vi } from 'vitest';

import { ConflictService } from '../src/main/conflicts/conflict-service';
import { parseConflictMarkers } from '../src/main/conflicts/merge-check';
import type { ConflictReport } from '../src/shared/ipc/conflicts-contract';
import { gitPath, useTestRepos, type TestRepo } from './ai-test-repo';

const d = gitPath ? describe : describe.skip;

const LINES = (n: number, tag = ''): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join('\n') + '\n';

function setup(repo: TestRepo, settings: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'conflicts.detectTarget': true,
    'conflicts.includeWip': false,
    'team.footprints': false,
    ...settings,
  };
  const events: ConflictReport[] = [];
  const svc = new ConflictService({
    repos: { get: () => repo.svc, list: () => [repo.svc] },
    settings: { get: ((k: string) => values[k]) as never },
    emit: (_e, p) => events.push(p.report),
    debounceMs: 20,
  });
  return { svc, events, values, id: repo.svc.repo.id };
}

/** main has a.txt (10 lines); `feature` changes line 5 one way, main another. */
async function conflicting(make: () => Promise<TestRepo>): Promise<TestRepo> {
  const r = await make();
  r.write('a.txt', LINES(10));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'base');
  r.git('checkout', '-q', '-b', 'feature');
  r.write('a.txt', LINES(10).replace('line 5\n', 'line 5 feature\n'));
  r.git('commit', '-q', '-am', 'feature edit');
  r.git('checkout', '-q', 'main');
  r.write('a.txt', LINES(10).replace('line 5\n', 'line 5 main\n'));
  r.git('commit', '-q', '-am', 'main edit');
  r.git('checkout', '-q', 'feature');
  await r.svc.refreshRepoInfo();
  return r;
}

d('conflict check (merge-tree against the target)', () => {
  const repos = useTestRepos('conflicts');

  it('reports no conflicts for a clean branch', async () => {
    const r = await repos.make({ 'a.txt': LINES(10) });
    r.git('checkout', '-q', '-b', 'feature');
    r.write('b.txt', 'new\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'b');
    await r.svc.refreshRepoInfo();
    const { svc, events } = setup(r);
    const rep = await svc.check(r.svc.repo.id);
    expect(rep).toMatchObject({ state: 'ok', branch: 'feature', target: 'main', targetSource: 'heuristic' });
    expect(rep.targetConflicts).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('lists conflicted files and parses hunks on demand', async () => {
    const r = await conflicting(() => repos.make());
    const { svc, id } = setup(r);
    const rep = await svc.check(id);
    expect(rep.state).toBe('conflicts');
    expect(rep.targetConflicts).toEqual([{ path: 'a.txt' }]);
    const hunks = await svc.hunks(id, 'a.txt');
    expect(hunks).toEqual([{ ours: [5, 5], theirs: [5, 5] }]);
    expect(await svc.hunks(id, 'not-conflicted.txt')).toEqual([]);
  });

  it('detects rename/delete conflicts', async () => {
    const r = await repos.make({ 'x.txt': LINES(20) });
    r.git('checkout', '-q', '-b', 'feature');
    r.git('rm', '-q', 'x.txt');
    r.git('commit', '-q', '-m', 'delete x');
    r.git('checkout', '-q', 'main');
    r.git('mv', 'x.txt', 'y.txt');
    r.git('commit', '-q', '-m', 'rename x');
    r.git('checkout', '-q', 'feature');
    await r.svc.refreshRepoInfo();
    const { svc, id } = setup(r);
    const rep = await svc.check(id);
    expect(rep.state).toBe('conflicts');
    expect(rep.targetConflicts.map((c) => c.path)).toEqual(['y.txt']);
    // No conflict markers for a rename/delete conflict.
    for (const c of rep.targetConflicts) expect(await svc.hunks(id, c.path)).toEqual([]);
  });

  it('detects binary conflicts (no hunks)', async () => {
    const r = await repos.make();
    fs.writeFileSync(path.join(r.dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 9]));
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'bin');
    r.git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(r.dir, 'img.bin'), Buffer.from([0, 7, 7, 7, 0, 9]));
    r.git('commit', '-q', '-am', 'bin feature');
    r.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'img.bin'), Buffer.from([0, 8, 8, 8, 0, 9]));
    r.git('commit', '-q', '-am', 'bin main');
    r.git('checkout', '-q', 'feature');
    await r.svc.refreshRepoInfo();
    const { svc, id } = setup(r);
    const rep = await svc.check(id);
    expect(rep.targetConflicts).toEqual([{ path: 'img.bin' }]);
    expect(await svc.hunks(id, 'img.bin')).toEqual([]);
  });

  it('WIP mode checks uncommitted changes without touching the index', async () => {
    const r = await repos.make({ 'a.txt': LINES(10) });
    r.git('checkout', '-q', '-b', 'feature');
    r.git('checkout', '-q', 'main');
    r.write('a.txt', LINES(10).replace('line 3\n', 'line 3 main\n'));
    r.git('commit', '-q', '-am', 'main edit');
    r.git('checkout', '-q', 'feature');
    // Staged change elsewhere + unstaged conflicting edit + untracked file.
    r.write('staged.txt', 'staged\n');
    r.git('add', 'staged.txt');
    r.write('a.txt', LINES(10).replace('line 3\n', 'line 3 wip\n'));
    r.write('untracked.txt', 'u\n');
    await r.svc.refreshRepoInfo();
    const indexPath = path.join(r.svc.repo.gitDir, 'index');
    const indexBefore = fs.readFileSync(indexPath);
    const statusBefore = r.git('status', '--porcelain');

    const off = setup(r);
    expect((await off.svc.check(off.id)).state).toBe('ok');

    const on = setup(r, { 'conflicts.includeWip': true });
    const rep = await on.svc.check(on.id);
    expect(rep).toMatchObject({ state: 'conflicts', wip: true, targetConflicts: [{ path: 'a.txt' }] });
    expect(fs.readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(r.git('status', '--porcelain')).toBe(statusBefore);
  });

  it('caches by (head, target) and re-runs merge-tree only when forced or moved', async () => {
    const r = await conflicting(() => repos.make());
    const { svc, id } = setup(r);
    const spy = vi.spyOn(r.svc as GitService, 'runRead');
    const mergeTreeCalls = () => spy.mock.calls.filter((c) => c[0][0] === 'merge-tree').length;
    await svc.check(id);
    await svc.check(id);
    expect(mergeTreeCalls()).toBe(1);
    await svc.check(id, { force: true });
    expect(mergeTreeCalls()).toBe(2);
    r.write('c.txt', 'c\n');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'c');
    await svc.check(id);
    expect(mergeTreeCalls()).toBe(3);
    spy.mockRestore();
  });

  it('honors ignore rules (file, target, expiry)', async () => {
    const r = await conflicting(() => repos.make());
    const { svc, id } = setup(r);
    await svc.ignore(id, { scope: 'file', value: 'a.txt' });
    let rep = await svc.check(id);
    expect(rep).toMatchObject({ state: 'ok', ignoredCount: 1, targetConflicts: [] });
    await svc.ignore(id, { scope: 'file', value: 'a.txt' }, true);
    await svc.ignore(id, { scope: 'target', value: 'main' });
    rep = await svc.check(id);
    expect(rep.state).toBe('ignored');
    // Persisted in the git dir and survives a new service instance.
    const again = setup(r);
    expect(again.svc.listIgnores(id)).toEqual([{ scope: 'target', value: 'main' }]);
    await again.svc.ignore(id, { scope: 'target', value: 'main' }, true);
    await again.svc.ignore(id, { scope: 'file', value: 'a.txt', until: '2000-01-01T00:00:00Z' });
    expect(again.svc.listIgnores(id)).toEqual([]);
    expect((await again.svc.check(id)).state).toBe('conflicts');
  });

  it('is hidden for detached HEAD and reports a missing target', async () => {
    const r = await conflicting(() => repos.make());
    const { svc, id } = setup(r);
    await svc.setTarget(id, undefined, 'origin/nope');
    let rep = await svc.check(id);
    expect(rep).toMatchObject({ state: 'target-missing', target: 'origin/nope', targetSource: 'config' });
    r.git('checkout', '-q', '--detach', 'HEAD');
    rep = await svc.check(id);
    expect(rep.state).toBe('hidden');
  });

  it('disabled setting skips merge-tree', async () => {
    const r = await conflicting(() => repos.make());
    const { svc, id } = setup(r, { 'conflicts.detectTarget': false });
    const spy = vi.spyOn(r.svc as GitService, 'runRead');
    expect((await svc.check(id)).state).toBe('disabled');
    expect(spy.mock.calls.some((c) => c[0][0] === 'merge-tree')).toBe(false);
    spy.mockRestore();
  });

  it('merges teammate overlaps into the report and applies file/branch ignores', async () => {
    const r = await conflicting(() => repos.make());
    const overlap = (path: string, branchHash: string) => ({
      user: { id: 'u2', name: 'Ana' },
      branchHash,
      path,
      pathHash: `h-${path}`,
      myRanges: [[5, 5]] as [number, number][],
      theirRanges: [[6, 8]] as [number, number][],
      updatedAt: '2026-10-01T00:00:00Z',
    });
    const team = {
      isActive: () => true,
      ensurePolled: vi.fn(),
      overlaps: vi.fn(async () => [overlap('a.txt', 'b1'), overlap('b.txt', 'b2'), overlap('c.txt', 'b3')]),
    };
    const events: ConflictReport[] = [];
    const svc = new ConflictService({
      repos: { get: () => r.svc, list: () => [r.svc] },
      settings: { get: ((k: string) => k === 'conflicts.detectTarget') as never },
      emit: (_e, p) => events.push(p.report),
      team,
    });
    const id = r.svc.repo.id;
    await svc.ignore(id, { scope: 'file', value: 'b.txt' });
    await svc.ignore(id, { scope: 'branch', value: 'b3' });
    const rep = await svc.check(id);
    expect(rep.teammateOverlaps.map((o) => o.path)).toEqual(['a.txt']);
    expect(rep.ignoredCount).toBe(2);
    expect(team.ensurePolled).toHaveBeenCalledWith(id);
    team.overlaps.mockResolvedValueOnce([]);
    await svc.refreshOverlaps(id);
    expect(events.at(-1)).toMatchObject({ teammateOverlaps: [], ignoredCount: 0, state: 'conflicts' });
  });

  it('re-checks in the background after repo changes', async () => {
    const r = await conflicting(() => repos.make());
    const { svc, id, events } = setup(r);
    await svc.check(id);
    events.length = 0;
    r.git('checkout', '-q', 'main');
    svc.onRepoChanged(id, ['refs', 'repoState'], 'watcher');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(events.at(-1)).toMatchObject({ branch: 'main', state: 'no-target' });
    svc.dispose();
  });
});

describe('parseConflictMarkers', () => {
  it('maps marker blocks to per-side line ranges (incl. diff3 base sections)', () => {
    const text = [
      'a',
      '<<<<<<< ours',
      'o1',
      'o2',
      '||||||| base',
      'b1',
      '=======',
      't1',
      '>>>>>>> theirs',
      'c',
      '<<<<<<< ours',
      '=======',
      't2',
      't3',
      '>>>>>>> theirs',
    ].join('\n');
    expect(parseConflictMarkers(text)).toEqual([
      { ours: [2, 3], theirs: [2, 2] },
      { ours: [5, 5], theirs: [4, 5] },
    ]);
  });
});
