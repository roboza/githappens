import type { RepoId } from '@githappens/git/types';

import { on } from '../../lib/api';
import { shellInvoke } from '../../shell/shell2-api';
import { FINDER_LIMIT, rankFiles, WORKER_THRESHOLD } from './finder-score';

/**
 * Renderer side of the file finder: the repo's file list (from `files:list`, cached until the watcher
 * reports worktree changes) and scoring — on this thread for small lists, in a Web Worker above
 * `WORKER_THRESHOLD` files (spec 12 §6.8).
 */

interface CachedList {
  version: number;
  files?: string[];
  pending?: Promise<string[]>;
}

const lists = new Map<RepoId, CachedList>();
let versionSeq = 0;

on('git:repo:changed', ({ repoId, scopes }) => {
  if (scopes.some((s) => s === 'status' || s === 'refs' || s === 'submodules' || s === 'repoState')) {
    lists.delete(repoId);
  }
});

async function getList(repoId: RepoId): Promise<{ files: string[]; version: number }> {
  const cur = lists.get(repoId);
  if (cur?.files) return { files: cur.files, version: cur.version };
  if (cur?.pending) return { files: await cur.pending, version: cur.version };
  const version = ++versionSeq;
  const pending = shellInvoke('files:list', { repoId });
  lists.set(repoId, { version, pending });
  try {
    const files = await pending;
    if (lists.get(repoId)?.version === version) lists.set(repoId, { version, files });
    return { files, version };
  } catch (e) {
    if (lists.get(repoId)?.version === version) lists.delete(repoId);
    throw e;
  }
}

// ---- worker --------------------------------------------------------------------------------------------

let worker: Worker | null = null;
let workerKey: string | null = null;
let querySeq = 0;
const waiting = new Map<number, (r: { paths?: string[]; stale?: boolean }) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./finder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; paths?: string[]; stale?: boolean }>) => {
      const cb = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      cb?.(e.data);
    };
    worker.onerror = (e) => {
      console.warn('[finder] worker failed; scoring on the main thread', e.message);
      worker?.terminate();
      worker = null;
      workerKey = null;
      for (const cb of waiting.values()) cb({ stale: true });
      waiting.clear();
    };
  } catch (e) {
    console.warn('[finder] no worker; scoring on the main thread', e);
    worker = null;
  }
  return worker;
}

function scoreInWorker(
  w: Worker,
  key: string,
  files: string[],
  query: string,
  mru: string[],
): Promise<string[] | null> {
  if (workerKey !== key) {
    w.postMessage({ type: 'load', key, files });
    workerKey = key;
  }
  const id = ++querySeq;
  return new Promise((resolve) => {
    waiting.set(id, (r) => resolve(r.stale || !r.paths ? null : r.paths));
    w.postMessage({ type: 'query', id, key, query, mru, limit: FINDER_LIMIT });
  });
}

/** Ranked repo-relative paths for `query` (MRU first when the query is empty). */
export async function searchFiles(repoId: RepoId, query: string, mru: string[]): Promise<string[]> {
  const { files, version } = await getList(repoId);
  if (files.length > WORKER_THRESHOLD) {
    const w = getWorker();
    if (w) {
      const r = await scoreInWorker(w, `${repoId}:${version}`, files, query, mru);
      if (r) return r;
    }
  }
  return rankFiles(files, query, mru).map((m) => m.path);
}

/** Drop the cached list (e.g. after creating / deleting a file through the palette). */
export function invalidateFileList(repoId: RepoId): void {
  lists.delete(repoId);
}
