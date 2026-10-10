import fs from 'node:fs';
import path from 'node:path';

import { GitError } from '../../errors/classify';
import type { OpRegistry } from '../queue';
import { define, git } from './util';

/** `git commit-graph write` arguments (spec 02 §6.15.1). */
export const commitGraphWriteArgs = (changedPaths = true): string[] => [
  'commit-graph',
  'write',
  '--reachable',
  ...(changedPaths ? ['--changed-paths'] : []),
];

/**
 * Lock / temp files a `git commit-graph write` leaves behind when it is killed (Windows has no signal
 * handlers to run git's tempfile cleanup): `objects/info/commit-graph.lock`, the split chain's
 * `commit-graphs/commit-graph-chain.lock` and `commit-graphs/tmp_graph_*`.
 */
export async function removeCommitGraphLeftovers(commonDir: string, since: number): Promise<string[]> {
  const info = path.join(commonDir, 'objects', 'info');
  const split = path.join(info, 'commit-graphs');
  const candidates = [path.join(info, 'commit-graph.lock'), path.join(split, 'commit-graph-chain.lock')];
  for (const dir of [info, split]) {
    try {
      for (const n of await fs.promises.readdir(dir)) {
        if (n.startsWith('tmp_graph_')) candidates.push(path.join(dir, n));
      }
    } catch {
      /* no such dir */
    }
  }
  // mtime resolution is 1 s on some file systems: anything from the second the op started is ours
  const floor = Math.floor(since / 1000) * 1000;
  const removed: string[] = [];
  for (const p of candidates) {
    try {
      const st = await fs.promises.stat(p);
      if (st.mtimeMs < floor) continue; // not ours (another git process, or an old crash)
      await removeWithRetry(p);
      removed.push(p);
    } catch {
      /* gone already */
    }
  }
  return removed;
}

/** Windows keeps a killed process' files open for a moment: retry EBUSY / EPERM briefly. */
async function removeWithRetry(p: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rm(p, { force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Background repository maintenance (spec 02 §6.15.1). */
export const maintenanceOps: OpRegistry = {
  'maintenance.commitGraph': define(
    'maintenance.commitGraph',
    {
      label: () => 'Write commit-graph',
      // nothing to refresh: no refs, index or worktree change (the queue skips the refresh for this class)
      touches: ['graph'],
      cancellable: true,
    },
    async (ctx, op) => {
      const startedAt = Date.now();
      const commonDir = ctx.service.repo.commonDir ?? ctx.service.repo.gitDir;
      try {
        await git(ctx, commitGraphWriteArgs(op.changedPaths !== false), {
          priority: 'background',
          timeoutMs: 30 * 60_000,
        });
      } catch (e) {
        // cancelled / timed out / crashed: git had no chance to clean up its lock and temp files (a plain
        // failure is cleaned up by git itself, and a lock we did not create is never touched)
        const killed =
          ctx.signal.aborted ||
          !(e instanceof GitError) ||
          e.code === 'Cancelled' ||
          e.code === 'Timeout' ||
          e.serialized.exitCode === null ||
          e.serialized.exitCode > 255 ||
          e.serialized.exitCode < 0;
        if (killed) await removeCommitGraphLeftovers(commonDir, startedAt).catch(() => []);
        throw e;
      }
      return { summary: 'Commit-graph written' };
    },
  ),
};
