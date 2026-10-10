import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitError, makeError } from '../src/errors/classify';
import { createOpRegistry } from '../src/ops/executors';
import { maintenanceOps, removeCommitGraphLeftovers } from '../src/ops/executors/maintenance';
import { OperationQueue, type OpRegistry } from '../src/ops/queue';
import type { OperationMeta } from '../src/ops/types';
import type { GitService } from '../src/service/git-service';
import { hasCommitGraphFile } from '../src/service/huge-repo';
import { describeGit, useHarness } from './ops-harness';

/**
 * Phase 11 (spec 02 §6.15.1): the background commit-graph write is a cancellable `maintenance` op that
 * runs alongside user ops, is never started twice at once, and leaves no lock / temp files when cancelled.
 */

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-maint-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('maintenance op class (queue)', () => {
  const service = (): GitService => ({ repo: { gitDir: tmp, commonDir: tmp } }) as unknown as GitService;

  it('runs alongside user ops, one maintenance op at a time, without muting or refreshing', async () => {
    const gates = { m1: deferred(), m2: deferred() };
    const order: string[] = [];
    let n = 0;
    const registry: OpRegistry = {
      'maintenance.commitGraph': {
        meta: meta({ touches: ['graph'] }),
        execute: async () => {
          const id = `m${++n}` as 'm1' | 'm2';
          order.push(`${id}:start`);
          await gates[id].promise;
          order.push(`${id}:end`);
          return {};
        },
      },
      'commit.create': {
        meta: meta(),
        execute: async () => {
          order.push('commit');
          return {};
        },
      },
      'wip.stage': {
        meta: meta({ touches: ['status'] }),
        execute: async () => {
          order.push('stage');
          return {};
        },
      },
    };
    const mute = vi.fn();
    const refresh = vi.fn();
    const q = new OperationQueue(service(), registry, { muteWatcher: mute, onRefresh: refresh });
    const m1 = q.enqueue({ type: 'maintenance.commitGraph' }, { background: true });
    const m2 = q.enqueue({ type: 'maintenance.commitGraph' }, { background: true });
    await vi.waitFor(() => expect(order).toEqual(['m1:start']));
    expect(q.busy).toBe(false); // auto-fetch / index refresh don't wait for maintenance

    // user ops are not blocked by the running maintenance op
    await q.enqueue({ type: 'commit.create', message: 'x' } as never).done;
    await q.enqueue({ type: 'wip.stage', paths: ['a'] }).done;
    expect(order).toEqual(['m1:start', 'commit', 'stage']);
    expect(mute).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);

    // never two maintenance ops at once
    gates.m1.resolve();
    await m1.done;
    await vi.waitFor(() => expect(order.at(-1)).toBe('m2:start'));
    gates.m2.resolve();
    await m2.done;
    expect(order).toEqual(['m1:start', 'commit', 'stage', 'm1:end', 'm2:start', 'm2:end']);
    expect(mute).toHaveBeenCalledTimes(2); // maintenance never mutes the watcher …
    expect(refresh).toHaveBeenCalledTimes(2); // … nor triggers a refresh
  });

  it('a running maintenance op is cancellable', async () => {
    const registry: OpRegistry = {
      'maintenance.commitGraph': {
        meta: meta(),
        execute: (ctx) =>
          new Promise((_, reject) =>
            ctx.signal.addEventListener('abort', () =>
              reject(new GitError(makeError('Cancelled', { argv: [], opId: ctx.opId }))),
            ),
          ),
      },
    };
    const states: string[] = [];
    const q = new OperationQueue(service(), registry, { onState: (e) => states.push(e.state) });
    const job = q.enqueue({ type: 'maintenance.commitGraph' }, { background: true });
    await vi.waitFor(() => expect(states).toContain('running'));
    expect(q.cancel(job.opId)).toBe(true);
    await expect(job.done).rejects.toMatchObject({ code: 'Cancelled' });
    expect(states).toEqual(['queued', 'running', 'cancelled']);
  });
});

describe('commit-graph leftovers', () => {
  const info = (): string => path.join(tmp, 'objects', 'info');

  it('removes only lock / temp files created since the op started', async () => {
    fs.mkdirSync(path.join(info(), 'commit-graphs'), { recursive: true });
    const old = Date.now() / 1000 - 3600;
    const files = {
      lock: path.join(info(), 'commit-graph.lock'),
      chainLock: path.join(info(), 'commit-graphs', 'commit-graph-chain.lock'),
      tmp: path.join(info(), 'commit-graphs', 'tmp_graph_abc123'),
      graph: path.join(info(), 'commit-graph'),
      oldTmp: path.join(info(), 'tmp_graph_old'),
    };
    for (const f of Object.values(files)) fs.writeFileSync(f, 'x');
    fs.utimesSync(files.oldTmp, old, old); // someone else's (older than the op): kept
    const since = Date.now() - 2000;
    const removed = await removeCommitGraphLeftovers(tmp, since);
    expect(removed.map((p) => path.basename(p)).sort()).toEqual([
      'commit-graph-chain.lock',
      'commit-graph.lock',
      'tmp_graph_abc123',
    ]);
    expect(fs.existsSync(files.graph)).toBe(true);
    expect(fs.existsSync(files.oldTmp)).toBe(true);
  });

  it('the executor cleans up after a killed write, but not after a plain git failure', async () => {
    fs.mkdirSync(info(), { recursive: true });
    const lock = path.join(info(), 'commit-graph.lock');
    let code: 'Cancelled' | 'Unknown' = 'Cancelled';
    const svc = {
      repo: { gitDir: tmp, commonDir: tmp },
      runWrite: async () => {
        fs.writeFileSync(lock, 'partial');
        throw new GitError(
          makeError(code, { argv: ['commit-graph'], exitCode: code === 'Cancelled' ? null : 1 }),
        );
      },
    } as unknown as GitService;
    const q = new OperationQueue(svc, maintenanceOps);
    await expect(q.enqueue({ type: 'maintenance.commitGraph' }).done).rejects.toMatchObject({
      code: 'Cancelled',
    });
    expect(fs.existsSync(lock)).toBe(false);
    code = 'Unknown';
    await expect(q.enqueue({ type: 'maintenance.commitGraph' }).done).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(lock)).toBe(true); // git cleans up its own lock on a normal failure
  });
});

describeGit('commit-graph write through the queue (real git)', () => {
  const h = useHarness('maint');

  it('start, cancel, no leftovers, and the next run writes the file', async () => {
    const f = h.fixture('huge', { count: 6000, lanes: 6, commitGraph: false });
    const svc = await h.open(f.path);
    const commonDir = svc.repo.commonDir ?? svc.repo.gitDir;
    const infoDir = path.join(commonDir, 'objects', 'info');
    const leftovers = (): string[] => {
      const out: string[] = [];
      for (const d of [infoDir, path.join(infoDir, 'commit-graphs')]) {
        try {
          out.push(...fs.readdirSync(d).filter((n) => n.endsWith('.lock') || n.startsWith('tmp_graph_')));
        } catch {
          /* missing */
        }
      }
      return out;
    };
    const states: string[] = [];
    const q = new OperationQueue(svc, createOpRegistry(), { onState: (e) => states.push(e.state) });
    expect(hasCommitGraphFile(commonDir)).toBe(false);

    const job = q.enqueue({ type: 'maintenance.commitGraph' }, { background: true });
    await vi.waitFor(() => expect(states).toContain('running'));
    // let git get going (spawned, walking), then cancel
    await new Promise((r) => setTimeout(r, 40));
    q.cancel(job.opId);
    const outcome = await job.done.then(
      () => 'succeeded',
      (e: GitError) => e.code,
    );
    expect(['Cancelled', 'succeeded']).toContain(outcome); // a very fast machine may finish first
    expect(leftovers()).toEqual([]);
    // a kill racing git's final rename may still leave a complete file: then it must be valid
    if (hasCommitGraphFile(commonDir)) h.git(f.path, 'commit-graph', 'verify');

    // the next run is not blocked by anything the cancelled one left
    await q.enqueue({ type: 'maintenance.commitGraph' }, { background: true }).done;
    expect(hasCommitGraphFile(commonDir)).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(h.git(f.path, 'commit-graph', 'verify').trim()).toBe('');
  }, 60_000);
});
