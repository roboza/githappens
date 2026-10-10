import fs from 'node:fs';
import path from 'node:path';

import type { GitFeatureFlags, PerfAdvice } from '../types';
import type { GitService } from './git-service';

/** Huge-repo tuning (spec 02 §6.15). */

/** Tracked-file count above which fsmonitor + untracked cache are offered (§6.15.2). */
export const FSMONITOR_FILE_THRESHOLD = 50_000;
/** Commit count above which the commit-graph is written / `--topo-order` is avoided (§6.15.1, §6.15.4). */
export const COMMIT_GRAPH_THRESHOLD = 10_000;

/** True when `objects/info/commit-graph` or a split chain exists (§6.15.1). */
export function hasCommitGraphFile(commonDir: string): boolean {
  const info = path.join(commonDir, 'objects', 'info');
  return (
    fs.existsSync(path.join(info, 'commit-graph')) ||
    fs.existsSync(path.join(info, 'commit-graphs', 'commit-graph-chain'))
  );
}

/**
 * Count commits reachable from branches, remotes and tags, stopping at `cap` (a bounded date-order
 * walk is cheap even without a commit-graph). Returns `cap` when there are at least that many.
 */
export async function countCommitsUpTo(svc: GitService, cap: number): Promise<number> {
  const r = await svc.runRead(
    [
      'rev-list',
      '--count',
      `--max-count=${Math.max(1, Math.floor(cap))}`,
      '--branches',
      '--remotes',
      '--tags',
      '--',
    ],
    { expectedExitCodes: [0, 128] },
  );
  return r.exitCode === 0 ? Number(String(r.stdout).trim()) || 0 : 0;
}

/** Number of tracked files (`git ls-files -z`, streamed and counted, never buffered). */
export async function countTrackedFiles(svc: GitService, signal?: AbortSignal): Promise<number> {
  if (svc.repo.isBare) return 0;
  const s = svc.streamRead(['ls-files', '-z'], { signal, priority: 'background' });
  let n = 0;
  for await (const chunk of s.stdout) {
    const b = chunk as Buffer;
    for (let i = b.indexOf(0); i >= 0; i = b.indexOf(0, i + 1)) n++;
  }
  await s.done;
  return n;
}

async function configValue(svc: GitService, key: string): Promise<string | null> {
  const r = await svc.runRead(['config', '--get', key], { expectedExitCodes: [0, 1] });
  return r.exitCode === 0 ? String(r.stdout).trim() : null;
}

const TRUE = /^(true|yes|on|1)$/i;
const FALSE = /^(false|no|off|0|)$/i;

/**
 * §6.15.2: offer `core.fsmonitor=true` (builtin daemon: git ≥ 2.37, Windows/macOS) and
 * `core.untrackedCache=true` when the worktree has more than 50k tracked files. A user's custom
 * fsmonitor hook is reported as `hook` and never replaced.
 */
export async function perfAdvice(
  svc: GitService,
  o: { features?: GitFeatureFlags; platform?: NodeJS.Platform; threshold?: number } = {},
): Promise<PerfAdvice> {
  const platform = o.platform ?? process.platform;
  const [trackedFiles, fsm, uc] = await Promise.all([
    countTrackedFiles(svc),
    configValue(svc, 'core.fsmonitor'),
    configValue(svc, 'core.untrackedCache'),
  ]);
  const mode: PerfAdvice['fsmonitor']['mode'] =
    fsm === null || FALSE.test(fsm) ? 'off' : TRUE.test(fsm) ? 'builtin' : 'hook';
  const supported = !!o.features?.builtinFsmonitor && (platform === 'win32' || platform === 'darwin');
  const untrackedCache = uc !== null && TRUE.test(uc);
  const large = trackedFiles > (o.threshold ?? FSMONITOR_FILE_THRESHOLD);
  return {
    trackedFiles,
    large,
    fsmonitor: { supported, mode },
    untrackedCache,
    offer: {
      fsmonitor: large && supported && mode === 'off',
      untrackedCache: large && !untrackedCache,
    },
  };
}
