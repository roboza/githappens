import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { GitError } from '../src/errors/classify';
import { createOpRegistry } from '../src/ops/executors';
import { findLockFiles, RepoLanes } from '../src/ops/locks';
import { OperationQueue, type OpRegistry } from '../src/ops/queue';
import type { GitOperation } from '../src/ops/types';
import { describeGit, useHarness } from './ops-harness';

/**
 * Real-git queue tests (spec 02 §6.13, §6.16): linked worktrees of one repository serialize ref-mutating
 * ops through their shared commonDir lane, and cancelling a fetch against a slow file:// remote leaves no
 * lock files behind while the queue keeps going.
 */

describeGit('OperationQueue with real linked worktrees', () => {
  const h = useHarness('qwt');

  it('serializes ref-mutating ops across worktrees; index-only ops run in parallel', async () => {
    const f = h.fixture('worktrees');
    const wt = (f.facts as { worktrees: string[] }).worktrees[0]!;
    const main = await h.open(f.path);
    const linked = await h.open(wt);
    expect(linked.repo.isLinkedWorktree).toBe(true);
    expect(linked.repo.commonDir).toBe(main.repo.commonDir);

    for (let i = 0; i < 8; i++) h.git(f.path, 'branch', `b${i}`);
    h.git(f.path, 'pack-refs', '--all'); // deletes now rewrite packed-refs (shared packed-refs.lock)

    // instrument the real executors to measure overlap
    const real = createOpRegistry();
    let active = 0;
    let maxRefOps = 0;
    let maxIndexOps = 0;
    const wrap = <T extends keyof OpRegistry>(type: T, index: boolean): OpRegistry[T] => {
      const def = real[type]!;
      return {
        meta: def.meta,
        execute: async (ctx: never, op: never) => {
          active++;
          if (index) maxIndexOps = Math.max(maxIndexOps, active);
          else maxRefOps = Math.max(maxRefOps, active);
          try {
            return await (def.execute as (c: never, o: never) => Promise<object>)(ctx, op);
          } finally {
            active--;
          }
        },
      } as OpRegistry[T];
    };
    const registry: OpRegistry = {
      ...real,
      'branch.delete': wrap('branch.delete', false),
      'branch.create': wrap('branch.create', false),
      'wip.stageAll': wrap('wip.stageAll', true),
    };
    const lanes = new RepoLanes();
    const qa = new OperationQueue(main, registry, { repoLane: lanes.acquire(main.repo.commonDir) });
    const qb = new OperationQueue(linked, registry, { repoLane: lanes.acquire(linked.repo.commonDir) });
    expect(lanes.size).toBe(1);

    const del = (name: string): GitOperation => ({
      type: 'branch.delete',
      branches: [{ name }],
      force: true,
    });
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      runs.push(qa.enqueue(del(`b${i}`)).done, qb.enqueue(del(`b${i + 4}`)).done);
      runs.push(
        qa.enqueue({ type: 'branch.create', name: `n${i}`, startPoint: 'HEAD', checkout: false }).done,
      );
    }
    await Promise.all(runs);
    expect(maxRefOps).toBe(1);
    const branches = h.git(f.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/);
    for (let i = 0; i < 8; i++) expect(branches).not.toContain(`b${i}`);
    for (let i = 0; i < 4; i++) expect(branches).toContain(`n${i}`);

    // stage in both worktrees at once: separate indexes, no shared lane
    h.write(path.join(f.path, 'main-new.txt'), 'm\n');
    h.write(path.join(wt, 'wt-new.txt'), 'w\n');
    active = 0;
    await Promise.all([qa.enqueue({ type: 'wip.stageAll' }).done, qb.enqueue({ type: 'wip.stageAll' }).done]);
    expect(h.git(f.path, 'diff', '--cached', '--name-only').trim()).toBe('main-new.txt');
    const wtStaged = h.git(wt, 'diff', '--cached', '--name-only').split(/\r?\n/);
    expect(wtStaged).toContain('wt-new.txt');
    expect(wtStaged).not.toContain('main-new.txt');
    expect(maxIndexOps).toBeGreaterThanOrEqual(1);
    expect(findLockFiles({ gitDir: linked.repo.gitDir, commonDir: linked.repo.commonDir })).toEqual([]);
  });

  it('cancelling a fetch from a slow file:// remote kills it, removes our locks and the queue continues', async () => {
    const f = h.fixture('remote-pair');
    const svc = await h.open(f.path);
    const lockPath = path.join(svc.repo.gitDir, 'refs', 'remotes', 'origin', 'main.lock');
    const keep = path.join(svc.repo.gitDir, 'refs', 'heads', 'stale.lock');
    fs.writeFileSync(keep, '');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(keep, old, old);

    // throttling upload-pack: leaves a ref lock in the fetching repo (as a killed fetch would), then stalls
    const script = path.join(h.root, 'slow-upload-pack.sh');
    const posix = (p: string): string => p.replace(/\\/g, '/');
    fs.writeFileSync(script, `#!/bin/sh\n: > '${posix(lockPath)}'\nsleep 30\nexec git-upload-pack "$@"\n`, {
      mode: 0o755,
    });
    h.git(f.path, 'config', 'remote.origin.uploadpack', `sh '${posix(script)}'`);

    const states: string[] = [];
    const q = new OperationQueue(svc, createOpRegistry(), {
      onState: (e) => states.push(`${e.type}:${e.state}`),
    });
    const fetch = q.enqueue({ type: 'fetch', remote: 'origin' });
    const next = q.enqueue({
      type: 'branch.create',
      name: 'after-cancel',
      startPoint: 'HEAD',
      checkout: false,
    }).done;

    const until = Date.now() + 20_000;
    while (!fs.existsSync(lockPath)) {
      if (Date.now() > until) throw new Error('slow upload-pack never started');
      await new Promise((r) => setTimeout(r, 25));
    }
    const t0 = Date.now();
    expect(q.cancel(fetch.opId)).toBe(true);
    const err = await fetch.done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('Cancelled');
    // the whole tree (git → sh → sleep) died: close fired long before the 30 s sleep
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(h.runner.activeCount).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false); // created during the op → removed
    expect(fs.existsSync(keep)).toBe(true); // pre-existing → kept
    fs.rmSync(keep);

    await next; // the queue continues
    expect(h.git(f.path, 'branch', '--list', 'after-cancel').trim()).toContain('after-cancel');
    expect(states).toContain('fetch:cancelled');
    expect(findLockFiles({ gitDir: svc.repo.gitDir, commonDir: svc.repo.commonDir })).toEqual([]);
  }, 60_000);
});
