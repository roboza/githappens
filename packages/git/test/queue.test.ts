import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitError } from '../src/errors/classify';
import { OperationQueue, type OpRegistry } from '../src/ops/queue';
import type { OperationMeta } from '../src/ops/types';
import type { GitService } from '../src/service/git-service';

let gitDir: string;
beforeEach(() => {
  gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-queue-'));
});
afterEach(() => fs.rmSync(gitDir, { recursive: true, force: true }));

const service = (): GitService => ({ repo: { gitDir } }) as unknown as GitService;
const meta = (over: Partial<OperationMeta> = {}): OperationMeta => ({
  label: (op) => op.type,
  mutating: true,
  network: false,
  cancellable: true,
  touches: ['refs'],
  undoable: false,
  exclusive: 'repo',
  ...over,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OperationQueue', () => {
  it('runs mutating ops one at a time in FIFO order', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const exec = async (_c: unknown, op: { type: string; paths?: string[] }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      order.push(op.paths?.[0] ?? op.type);
      active--;
      return {};
    };
    const registry: OpRegistry = { 'wip.stage': { meta: meta(), execute: exec as never } };
    const q = new OperationQueue(service(), registry);
    const a = q.enqueue({ type: 'wip.stage', paths: ['a'] });
    const b = q.enqueue({ type: 'wip.stage', paths: ['b'] });
    const c = q.enqueue({ type: 'wip.stage', paths: ['c'] });
    await Promise.all([a.done, b.done, c.done]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
  });

  it('emits queued → running → succeeded and a refresh with touches + status', async () => {
    const states: string[] = [];
    const onRefresh = vi.fn();
    const q = new OperationQueue(
      service(),
      {
        'wip.stageAll': {
          meta: meta({ touches: ['refs', 'graph'] }),
          execute: async () => ({ summary: 'ok' }),
        },
      },
      { onState: (e) => states.push(e.state), onRefresh },
    );
    const r = await q.enqueue({ type: 'wip.stageAll' }).done;
    expect(r.summary).toBe('ok');
    expect(states).toEqual(['queued', 'running', 'succeeded']);
    expect(onRefresh.mock.calls[0]![0].sort()).toEqual(['graph', 'refs', 'status']);
  });

  it('a user op aborts a running background index.refresh instead of waiting behind it', async () => {
    let refreshStarted!: () => void;
    const started = new Promise<void>((r) => (refreshStarted = r));
    const registry: OpRegistry = {
      'index.refresh': {
        meta: meta(),
        // a slow locking status: only ends when aborted
        execute: ((ctx: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            refreshStarted();
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })) as never,
      },
      'wip.stageAll': { meta: meta(), execute: async () => ({ summary: 'staged' }) },
    };
    const q = new OperationQueue(service(), registry);
    const refresh = q.enqueue({ type: 'index.refresh' }, { background: true });
    // observe the refresh rejection up front: it settles before the user op's promise does
    const refreshRejected = expect(refresh.done).rejects.toBeTruthy();
    await started;
    const user = await q.enqueue({ type: 'wip.stageAll' }).done;
    expect(user.summary).toBe('staged');
    await refreshRejected;
  });

  it('rejects unknown operations', async () => {
    const q = new OperationQueue(service(), {});
    await expect(q.enqueue({ type: 'wip.stageAll' }).done).rejects.toThrow(/not implemented/);
  });

  it('fails fast on an old index.lock with lock details', async () => {
    const lock = path.join(gitDir, 'index.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const q = new OperationQueue(service(), { 'wip.stageAll': { meta: meta(), execute: async () => ({}) } });
    const err = (await q.enqueue({ type: 'wip.stageAll' }).done.catch((e: unknown) => e)) as GitError;
    expect(err.code).toBe('IndexLocked');
    expect(err.serialized.details?.lockPath).toBe(lock);
  });

  it('waits for a fresh lock to disappear', async () => {
    const lock = path.join(gitDir, 'index.lock');
    fs.writeFileSync(lock, '');
    const q = new OperationQueue(
      service(),
      { 'wip.stageAll': { meta: meta(), execute: async () => ({ summary: 'ran' }) } },
      {},
      { fresh: 10_000, wait: 2000, poll: 20 },
    );
    setTimeout(() => fs.rmSync(lock), 100);
    await expect(q.enqueue({ type: 'wip.stageAll' }).done).resolves.toMatchObject({ summary: 'ran' });
  });

  it('coalesces a second fetch of the same remote', async () => {
    const exec = vi.fn(async () => {
      await sleep(30);
      return {};
    });
    const q = new OperationQueue(service(), {
      fetch: { meta: meta({ network: true }), execute: exec as never },
    });
    const a = q.enqueue({ type: 'fetch', remote: 'origin' });
    const b = q.enqueue({ type: 'fetch', remote: 'origin' });
    const c = q.enqueue({ type: 'fetch', remote: 'upstream' });
    expect(b.opId).toBe(a.opId);
    await Promise.all([a.done, b.done, c.done]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('user ops jump ahead of queued background ops', async () => {
    const order: string[] = [];
    const exec = async (_c: unknown, op: { type: string; remote?: string }) => {
      await sleep(10);
      order.push(op.remote ?? op.type);
      return {};
    };
    const q = new OperationQueue(service(), {
      fetch: { meta: meta(), execute: exec as never },
      'wip.stageAll': { meta: meta(), execute: exec as never },
    });
    const first = q.enqueue({ type: 'fetch', remote: 'r1' }, { background: true });
    const bg = q.enqueue({ type: 'fetch', remote: 'r2' }, { background: true });
    const user = q.enqueue({ type: 'wip.stageAll' });
    await Promise.all([first.done, bg.done, user.done]);
    expect(order).toEqual(['r1', 'wip.stageAll', 'r2']);
  });

  it('cancels queued ops and aborts running cancellable ones', async () => {
    const exec = (ctx: { signal: AbortSignal }) =>
      new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const q = new OperationQueue(service(), { 'wip.stageAll': { meta: meta(), execute: exec as never } });
    const a = q.enqueue({ type: 'wip.stageAll' });
    const b = q.enqueue({ type: 'wip.stageAll' });
    expect(q.cancel(b.opId)).toBe(true);
    await expect(b.done).rejects.toMatchObject({ code: 'Cancelled' });
    await sleep(10);
    expect(q.cancel(a.opId)).toBe(true);
    await expect(a.done).rejects.toBeInstanceOf(GitError);
  });

  it('wraps undoable ops in journal begin/commit and fail', async () => {
    const journal = {
      begin: vi.fn(async () => 'j1'),
      commit: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
    };
    const q = new OperationQueue(
      service(),
      {
        'wip.stageAll': { meta: meta({ undoable: true }), execute: async () => ({}) },
        'wip.unstageAll': {
          meta: meta({ undoable: true }),
          execute: async () => {
            throw new Error('boom');
          },
        },
      },
      { journal },
    );
    await q.enqueue({ type: 'wip.stageAll' }).done;
    expect(journal.begin).toHaveBeenCalledTimes(1);
    expect(journal.commit).toHaveBeenCalledWith('j1', { type: 'wip.stageAll' }, {});
    await q.enqueue({ type: 'wip.unstageAll' }).done.catch(() => undefined);
    expect(journal.fail).toHaveBeenCalledWith(
      'j1',
      { type: 'wip.unstageAll' },
      expect.objectContaining({ code: 'Unknown' }),
    );
  });

  it('mutes the watcher while an op runs', async () => {
    const calls: string[] = [];
    const q = new OperationQueue(
      service(),
      {
        'wip.stageAll': {
          meta: meta(),
          execute: async () => {
            calls.push('exec');
            return {};
          },
        },
      },
      { muteWatcher: () => calls.push('mute'), unmuteWatcher: () => calls.push('unmute') },
    );
    await q.enqueue({ type: 'wip.stageAll' }).done;
    expect(calls).toEqual(['mute', 'exec', 'unmute']);
  });
});
