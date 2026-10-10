import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitError, makeError } from '../src/errors/classify';
import { AsyncMutex, findLockFiles, recoverLocks, RepoLanes } from '../src/ops/locks';
import { OperationQueue, opClass, type OpRegistry } from '../src/ops/queue';
import type { GitOperation, OperationMeta } from '../src/ops/types';
import type { GitService } from '../src/service/git-service';

/**
 * spec 02 §6.13 / §6.16 "Queue/watcher tests: fake clock; lock wait/fail behavior; simulate an
 * index.lock with controlled mtime", queue classes, per-commonDir lanes and post-cancel recovery (§6.2).
 */

let root: string;
let gitDir: string;
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-qlock-')));
  gitDir = path.join(root, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

const service = (dir = gitDir, commonDir = dir): GitService =>
  ({ repo: { gitDir: dir, commonDir, worktreeRoot: path.dirname(dir) } }) as unknown as GitService;
const meta = (over: Partial<OperationMeta> = {}): OperationMeta => ({
  label: (op) => op.type,
  mutating: true,
  network: false,
  cancellable: true,
  touches: ['status'],
  undoable: false,
  exclusive: 'repo',
  ...over,
});
const ok = { meta: meta(), execute: async () => ({ summary: 'ran' }) };
const STAGE: GitOperation = { type: 'wip.stageAll' };
const CHECKOUT: GitOperation = { type: 'merge.abort' };
const FETCH: GitOperation = { type: 'fetch', remote: 'origin' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write a lock whose mtime is `ageMs` before the (possibly fake) clock's now. */
function lock(rel: string, ageMs: number): string {
  const p = path.join(gitDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: GitError }> {
  return p.then(
    (value) => ({ value }),
    (error: GitError) => ({ error }),
  );
}

describe('lock pre-check with a fake clock (spec 02 §6.13 rule 3)', () => {
  beforeEach(() =>
    vi.useFakeTimers({ now: new Date('2026-10-10T12:00:00Z'), toFake: ['setTimeout', 'Date'] }),
  );

  it('waits for a fresh index.lock and runs once it disappears', async () => {
    const p = lock('index.lock', 2_000);
    const q = new OperationQueue(service(), { 'wip.stageAll': ok });
    const done = settle(q.enqueue(STAGE).done);
    await vi.advanceTimersByTimeAsync(4_750); // polled every 250 ms, still within the 5 s window
    fs.rmSync(p);
    await vi.advanceTimersByTimeAsync(250);
    expect(await done).toEqual({ value: expect.objectContaining({ summary: 'ran' }) });
  });

  it('fails with IndexLocked after waiting 5 s for a fresh lock that stays', async () => {
    const p = lock('index.lock', 2_000);
    const isGitRunning = vi.fn(async () => false);
    const q = new OperationQueue(service(), { 'wip.stageAll': ok }, { isGitRunning });
    const done = settle(q.enqueue(STAGE).done);
    await vi.advanceTimersByTimeAsync(4_900);
    let finished = false;
    void done.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    const { error } = await done;
    expect(error?.code).toBe('IndexLocked');
    expect(error?.serialized.details).toEqual({ lockPath: p, ageSec: 7, stale: 0 });
    expect(isGitRunning).not.toHaveBeenCalled(); // younger than 60 s: never stale
  });

  it('fails fast on an old lock and flags it stale when no git process runs in the repo', async () => {
    const p = lock('index.lock', 120_000);
    const isGitRunning = vi.fn(async () => false);
    const q = new OperationQueue(service(), { 'wip.stageAll': ok }, { isGitRunning });
    const { error } = await settle(q.enqueue(STAGE).done);
    expect(error?.code).toBe('IndexLocked');
    expect(error?.serialized.details).toEqual({ lockPath: p, ageSec: 120, stale: 1 });
    expect(isGitRunning).toHaveBeenCalledWith(expect.arrayContaining([gitDir]));

    // same age but a git process is working in the repo: not stale
    const busy = new OperationQueue(service(), { 'wip.stageAll': ok }, { isGitRunning: async () => true });
    expect((await settle(busy.enqueue(STAGE).done)).error?.serialized.details?.stale).toBe(0);
  });

  it('an old-but-not-stale lock (30 s) fails immediately without waiting', async () => {
    lock('index.lock', 30_000);
    const q = new OperationQueue(service(), { 'wip.stageAll': ok }, { isGitRunning: async () => false });
    const { error } = await settle(q.enqueue(STAGE).done);
    expect(error?.serialized.details).toMatchObject({ ageSec: 30, stale: 0 });
  });

  it('checks HEAD.lock (RefLocked) for exclusive ops but not for index-only ops', async () => {
    const p = lock('HEAD.lock', 90_000);
    const registry: OpRegistry = { 'wip.stageAll': ok, 'merge.abort': ok };
    const q = new OperationQueue(service(), registry, { isGitRunning: async () => false });
    expect((await settle(q.enqueue(STAGE).done)).value?.summary).toBe('ran');
    const { error } = await settle(q.enqueue(CHECKOUT).done);
    expect(error?.code).toBe('RefLocked');
    expect(error?.serialized.details).toMatchObject({ lockPath: p, stale: 1 });
  });

  it('config.set checks config.lock; fetch ignores index.lock', async () => {
    const cfg = lock('config.lock', 90_000);
    lock('index.lock', 90_000);
    const registry: OpRegistry = {
      'config.set': ok,
      fetch: { meta: meta({ network: true }), execute: ok.execute },
    };
    const q = new OperationQueue(service(), registry, { isGitRunning: async () => false });
    expect((await settle(q.enqueue(FETCH).done)).value?.summary).toBe('ran');
    fs.rmSync(path.join(gitDir, 'index.lock'));
    const { error } = await settle(
      q.enqueue({ type: 'config.set', key: 'a.b', value: '1', scope: 'local' }).done,
    );
    expect(error?.code).toBe('RefLocked');
    expect(error?.serialized.details?.lockPath).toBe(cfg);
  });
});

describe('queue classes (spec 02 §6.13)', () => {
  it('classifies ops', () => {
    expect(opClass({ type: 'wip.stage', paths: [] })).toBe('index');
    expect(opClass({ type: 'wip.unstageLines', path: 'a', lines: [], diffHash: '' })).toBe('index');
    expect(opClass(FETCH)).toBe('fetch');
    expect(opClass({ type: 'commit.create' } as GitOperation)).toBe('exclusive');
    expect(opClass({ type: 'wip.discardAll', includeUntracked: false })).toBe('exclusive');
  });

  it('a fetch overlaps with index-only ops, exclusive ops wait for both; FIFO is kept', async () => {
    const log: string[] = [];
    const exec = (name: string, ms: number) => async () => {
      log.push(`+${name}`);
      await sleep(ms);
      log.push(`-${name}`);
      return {};
    };
    const registry: OpRegistry = {
      fetch: { meta: meta({ network: true }), execute: exec('fetch', 60) },
      'wip.stageAll': { meta: meta(), execute: exec('stage', 10) },
      'merge.abort': { meta: meta(), execute: exec('abort', 10) },
      'wip.unstageAll': { meta: meta(), execute: exec('unstage', 10) },
    };
    const q = new OperationQueue(service(), registry);
    const all = [
      q.enqueue(FETCH).done,
      q.enqueue(STAGE).done,
      q.enqueue(CHECKOUT).done,
      q.enqueue({ type: 'wip.unstageAll' }).done,
    ];
    await Promise.all(all);
    // stage ran inside the fetch; abort waited for the fetch; unstage did not overtake abort
    expect(log).toEqual(['+fetch', '+stage', '-stage', '-fetch', '+abort', '-abort', '+unstage', '-unstage']);
    expect(q.busy).toBe(false);
  });
});

describe('per-commonDir lanes (spec 02 §6.13 "keyed by commonDir")', () => {
  it('serializes exclusive ops of two worktree queues sharing a lane; index ops stay parallel', async () => {
    const lanes = new RepoLanes();
    const common = gitDir;
    const linked = path.join(gitDir, 'worktrees', 'wt');
    fs.mkdirSync(linked, { recursive: true });
    let active = 0;
    let maxExclusive = 0;
    let maxIndex = 0;
    const exec = (kind: 'x' | 'i') => async () => {
      active++;
      if (kind === 'x') maxExclusive = Math.max(maxExclusive, active);
      else maxIndex = Math.max(maxIndex, active);
      await sleep(25);
      active--;
      return {};
    };
    const registry: OpRegistry = {
      'merge.abort': { meta: meta(), execute: exec('x') },
      'wip.stageAll': { meta: meta(), execute: exec('i') },
    };
    const qa = new OperationQueue(service(common, common), registry, { repoLane: lanes.acquire(common) });
    const qb = new OperationQueue(service(linked, common), registry, { repoLane: lanes.acquire(common) });
    expect(lanes.size).toBe(1);
    await Promise.all([qa.enqueue(CHECKOUT).done, qb.enqueue(CHECKOUT).done, qa.enqueue(CHECKOUT).done]);
    expect(maxExclusive).toBe(1);
    await Promise.all([qa.enqueue(STAGE).done, qb.enqueue(STAGE).done]);
    expect(maxIndex).toBe(2);
    lanes.release(common);
    lanes.release(common);
    expect(lanes.size).toBe(0);
  });

  it('an op waiting for the lane can be cancelled (even when not cancellable)', async () => {
    const lanes = new RepoLanes();
    const lane = lanes.acquire(gitDir);
    const release = await lane.lock();
    const registry: OpRegistry = {
      'merge.abort': { meta: meta({ cancellable: false }), execute: ok.execute },
    };
    const states: string[] = [];
    const q = new OperationQueue(service(), registry, {
      repoLane: lane,
      onState: (e) => states.push(e.state),
    });
    const { opId, done } = q.enqueue(CHECKOUT);
    await sleep(10);
    expect(q.cancel(opId)).toBe(true);
    expect((await settle(done)).error?.code).toBe('Cancelled');
    expect(states).toEqual(['queued', 'cancelled']);
    release();
    // the lane is still usable afterwards
    expect((await settle(q.enqueue(CHECKOUT).done)).value).toBeDefined();
  });

  it('AsyncMutex is FIFO and survives aborted waiters', async () => {
    const m = new AsyncMutex();
    const order: number[] = [];
    const r1 = await m.lock();
    const ac = new AbortController();
    const p2 = m.lock(ac.signal).then((rel) => (order.push(2), rel));
    const p3 = m.lock().then((rel) => (order.push(3), rel));
    ac.abort();
    await expect(p2).rejects.toBeDefined();
    expect(order).toEqual([]);
    r1();
    (await p3)();
    expect(order).toEqual([3]);
    expect(m.busy).toBe(false);
  });
});

describe('post-cancel / post-crash lock recovery (spec 02 §6.2 step 4)', () => {
  it('deletes locks our op created (mtime ≥ start), keeps older ones, and the queue continues', async () => {
    const old = lock('refs/heads/keep.lock', 3_600_000);
    const removedLog = vi.fn();
    let created: string[] = [];
    const registry: OpRegistry = {
      'merge.abort': {
        meta: meta(),
        execute: async (ctx) => {
          created = [lock('index.lock', 0), lock('HEAD.lock', 0), lock('refs/heads/feature/x.lock', 0)];
          await new Promise((_r, reject) =>
            ctx.signal.addEventListener('abort', () =>
              reject(new GitError(makeError('Cancelled', { argv: ['merge'], opId: ctx.opId }))),
            ),
          );
          return {};
        },
      },
      'wip.stageAll': ok,
    };
    const q = new OperationQueue(service(), registry, { onLocksRemoved: removedLog });
    const { opId, done } = q.enqueue(CHECKOUT);
    const next = q.enqueue(STAGE).done;
    await sleep(30);
    q.cancel(opId);
    expect((await settle(done)).error?.code).toBe('Cancelled');
    for (const p of created) expect(fs.existsSync(p), p).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
    expect(removedLog).toHaveBeenCalledWith(opId, expect.arrayContaining(created));
    expect((await next).summary).toBe('ran'); // queue continues
  });

  it('recovers after a crashed git (abnormal exit code) but not after an ordinary failure', async () => {
    let exitCode = 3221225477; // 0xC0000005 access violation
    const registry: OpRegistry = {
      'merge.abort': {
        meta: meta(),
        execute: async () => {
          lock('index.lock', 0);
          throw new GitError(makeError('Unknown', { argv: ['merge'], exitCode }));
        },
      },
    };
    const q = new OperationQueue(service(), registry);
    await settle(q.enqueue(CHECKOUT).done);
    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(false);
    exitCode = 128;
    await settle(q.enqueue(CHECKOUT).done);
    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(true);
  });

  it('a cancelled fetch leaves index.lock alone while a stage op of ours holds it', async () => {
    let releaseStage!: () => void;
    const registry: OpRegistry = {
      fetch: {
        meta: meta({ network: true }),
        execute: async (ctx) => {
          lock('refs/remotes/origin/main.lock', 0);
          await new Promise((_r, reject) =>
            ctx.signal.addEventListener('abort', () =>
              reject(new GitError(makeError('Cancelled', { argv: [] }))),
            ),
          );
          return {};
        },
      },
      'wip.stageAll': {
        meta: meta(),
        execute: async () => {
          lock('index.lock', 0);
          await new Promise<void>((r) => (releaseStage = r));
          fs.rmSync(path.join(gitDir, 'index.lock'));
          return {};
        },
      },
    };
    const q = new OperationQueue(service(), registry);
    const fetch = q.enqueue(FETCH);
    const stage = q.enqueue(STAGE).done;
    await sleep(30);
    q.cancel(fetch.opId);
    await settle(fetch.done);
    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(true);
    expect(fs.existsSync(path.join(gitDir, 'refs/remotes/origin/main.lock'))).toBe(false);
    releaseStage();
    await stage;
  });

  it('findLockFiles / recoverLocks scan git dir, common dir and refs', async () => {
    const common = path.join(root, 'common');
    fs.mkdirSync(path.join(common, 'refs', 'tags'), { recursive: true });
    fs.writeFileSync(path.join(common, 'packed-refs.lock'), '');
    fs.writeFileSync(path.join(common, 'refs', 'tags', 'v1.lock'), '');
    lock('index.lock', 0);
    const found = findLockFiles({ gitDir, commonDir: common }).map((p) =>
      path.relative(root, p).replace(/\\/g, '/'),
    );
    expect(found.sort()).toEqual(['.git/index.lock', 'common/packed-refs.lock', 'common/refs/tags/v1.lock']);
    expect(findLockFiles({ gitDir, commonDir: common, skipIndex: true })).toHaveLength(2);
    const removed = await recoverLocks({ gitDir, commonDir: common, since: Date.now() + 60_000 });
    expect(removed).toEqual([]); // all older than "since"
  });
});
