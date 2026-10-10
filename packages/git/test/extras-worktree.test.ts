import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePruneOutput } from '../src/ops/executors/extras';
import { listWorktrees, parseWorktreeList } from '../src/service/extras';
import { failExtra, runExtra } from './extras-harness';
import { describeGit, useHarness } from './ops-harness';

const S1 = '1'.repeat(40);
const S2 = '2'.repeat(40);

describe('parseWorktreeList', () => {
  it('parses -z records (main first, branch, detached, bare, locked, prunable)', () => {
    const z = [
      'worktree /repo/main',
      `HEAD ${S1}`,
      'branch refs/heads/main',
      '',
      'worktree /repo/wt feature',
      `HEAD ${S2}`,
      'branch refs/heads/feature',
      'locked',
      '',
      'worktree /repo/wt-detached',
      `HEAD ${S1}`,
      'detached',
      'locked moved to\nusb',
      'prunable gitdir file points to non-existent location',
      '',
      '',
    ].join('\0');
    const list = parseWorktreeList(z.split('\0'));
    expect(list).toEqual([
      {
        path: '/repo/main',
        head: S1,
        branch: 'refs/heads/main',
        detached: false,
        bare: false,
        isMain: true,
        isCurrent: false,
      },
      {
        path: '/repo/wt feature',
        head: S2,
        branch: 'refs/heads/feature',
        detached: false,
        bare: false,
        locked: true,
        isMain: false,
        isCurrent: false,
      },
      {
        path: '/repo/wt-detached',
        head: S1,
        detached: true,
        bare: false,
        locked: 'moved to\nusb',
        prunable: 'gitdir file points to non-existent location',
        isMain: false,
        isCurrent: false,
      },
    ]);
  });

  it('parses the newline format and bare main', () => {
    const list = parseWorktreeList([
      'worktree /srv/repo.git',
      'bare',
      '',
      'worktree /w',
      `HEAD ${S1}`,
      'detached',
      '',
    ]);
    expect(list[0]).toMatchObject({ bare: true, head: null, isMain: true });
    expect(list[1]).toMatchObject({ detached: true, isMain: false });
  });

  it('parses prune -v output', () => {
    expect(
      parsePruneOutput('Removing worktrees/wt-a: gitdir file points to non-existent location\nother\n'),
    ).toEqual(['worktrees/wt-a']);
  });
});

describeGit('worktree reads and ops (fixtures)', () => {
  const h = useHarness('worktree');

  it('lists worktrees with isMain/isCurrent from main and from a linked worktree', async () => {
    const fx = h.fixture('worktrees');
    const [wtFeature, wtDetached] = fx.facts.worktrees as string[];
    const svc = await h.open(fx.path);
    const list = await listWorktrees(svc);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ path: fs.realpathSync.native(fx.path), isMain: true, isCurrent: true });
    expect(list[0]!.branch).toBe('refs/heads/main');
    const feat = list.find((w) => w.branch === 'refs/heads/feature')!;
    expect(feat.path.toLowerCase()).toBe(fs.realpathSync.native(wtFeature!).toLowerCase());
    expect(feat).toMatchObject({ isMain: false, isCurrent: false, detached: false });
    const det = list.find((w) => w.detached)!;
    expect(det.path.toLowerCase()).toBe(fs.realpathSync.native(wtDetached!).toLowerCase());
    expect(det.head).toMatch(/^[0-9a-f]{40}$/);

    const linked = await h.open(wtFeature!);
    const fromLinked = await listWorktrees(linked);
    expect(fromLinked.filter((w) => w.isCurrent).map((w) => w.branch)).toEqual(['refs/heads/feature']);
    // case-insensitive match on win32/darwin
    if (process.platform === 'win32') {
      expect(fromLinked.find((w) => w.isMain)!.isCurrent).toBe(false);
    }
  });

  it('adds worktrees (new branch, existing branch, detached) and validates the target', async () => {
    const fx = h.fixture('worktrees');
    const svc = await h.open(fx.path);
    const base = path.dirname(fx.path);

    const p1 = path.join(base, 'wt new branch');
    const r1 = await runExtra(svc, {
      type: 'worktree.add',
      path: p1,
      newBranch: 'topic',
      startPoint: 'HEAD~1',
    });
    expect(r1.data).toEqual({ path: p1 });
    expect(h.git(p1, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('topic');

    h.git(fx.path, 'branch', 'spare', 'HEAD');
    const p2 = path.join(base, 'wt-spare');
    await runExtra(svc, { type: 'worktree.add', path: p2, branch: 'spare' });
    expect(h.git(p2, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('spare');

    const p3 = path.join(base, 'wt-det');
    await runExtra(svc, { type: 'worktree.add', path: p3, detach: true, startPoint: 'HEAD' });
    expect(h.git(p3, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD');

    const list = await listWorktrees(svc);
    expect(list).toHaveLength(6);

    // branch checked out elsewhere
    const busy = await failExtra(svc, {
      type: 'worktree.add',
      path: path.join(base, 'wt-busy'),
      branch: 'feature',
    });
    expect(busy.code).toBe('BranchCheckedOutInWorktree');
    // non-empty target folder
    const full = path.join(base, 'occupied');
    h.write(path.join(full, 'x.txt'), 'x');
    const occ = await failExtra(svc, { type: 'worktree.add', path: full, branch: 'spare' });
    expect(occ.message).toMatch(/not empty/);
  });

  it('locks, unlocks, removes and prunes', async () => {
    const fx = h.fixture('worktrees');
    const [wtFeature, wtDetached] = fx.facts.worktrees as string[];
    const svc = await h.open(fx.path);
    const find = async (p: string) =>
      (await listWorktrees(svc)).find(
        (w) => w.path.toLowerCase() === fs.realpathSync.native(p).toLowerCase(),
      );

    await runExtra(svc, { type: 'worktree.lock', path: wtDetached!, reason: 'on usb drive' });
    expect((await find(wtDetached!))!.locked).toBe('on usb drive');
    await runExtra(svc, { type: 'worktree.unlock', path: wtDetached! });
    expect((await find(wtDetached!))!.locked).toBeUndefined();
    await runExtra(svc, { type: 'worktree.lock', path: wtDetached! });
    expect((await find(wtDetached!))!.locked).toBe(true);

    // locked: plain remove fails, forced remove (double --force) works
    await failExtra(svc, { type: 'worktree.remove', path: wtDetached! });
    await runExtra(svc, { type: 'worktree.remove', path: wtDetached!, force: true });
    expect(fs.existsSync(wtDetached!)).toBe(false);

    // dirty worktree: needs force
    const dirty = await failExtra(svc, { type: 'worktree.remove', path: wtFeature! });
    expect(dirty.stderr + dirty.message).toMatch(/modified or untracked|contains/i);
    expect(fs.existsSync(wtFeature!)).toBe(true);

    // main worktree cannot be removed
    const main = await failExtra(svc, { type: 'worktree.remove', path: fx.path, force: true });
    expect(main.message).toMatch(/main worktree/);

    // deleted manually → prunable → pruned
    fs.rmSync(wtFeature!, { recursive: true, force: true });
    const stale = (await listWorktrees(svc)).find((w) => w.branch === 'refs/heads/feature')!;
    expect(stale.prunable).toBeTruthy();
    const r = await runExtra(svc, { type: 'worktree.prune' });
    expect((r.data as { pruned: string[] }).pruned).toHaveLength(1);
    expect(await listWorktrees(svc)).toHaveLength(1);
  });
});
