import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock-file policy shared by the OperationQueue (spec 02 §6.2 post-cancel recovery, §6.13 rule 3):
 * per-commonDir mutexes so linked worktrees of one repository serialize ref-mutating ops, lock-file
 * enumeration / cleanup, and the "stale lock" heuristic shown in the lock dialog.
 */

/** Minimal async mutex (FIFO). `lock()` resolves with a release function. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;

  /** Waits for the lock; rejects with `signal.reason` when aborted while waiting. */
  lock(signal?: AbortSignal): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => mine);
    this.holders++;
    let released = false;
    const done = (): void => {
      if (released) return;
      released = true;
      this.holders--;
      release();
    };
    if (!signal) return prev.then(() => done);
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        done(); // keep the chain moving: whoever is behind us must not wait for us
        reject(signal.reason ?? new Error('aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      void prev.then(() => {
        signal.removeEventListener('abort', onAbort);
        if (released) return; // aborted meanwhile
        resolve(done);
      });
    });
  }

  /** Held or waited for (diagnostics / tests). */
  get busy(): boolean {
    return this.holders > 0;
  }
}

const caseFold = (p: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;

/** Canonical key for a git dir: realpath, case-folded where the filesystem is case-insensitive. */
export function gitDirKey(dir: string): string {
  let p = path.resolve(dir);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    /* keep the resolved path */
  }
  return caseFold(p);
}

/**
 * One mutex per repository `commonDir` (spec 02 §6.13: "Per-repo, keyed by commonDir"). Every open
 * worktree's queue takes its repository's lane before a ref-mutating op, so ops in two linked
 * worktrees never race on `packed-refs.lock`, `refs/**.lock` or `config.lock`.
 */
export class RepoLanes {
  private readonly lanes = new Map<string, { mutex: AsyncMutex; refs: number }>();

  acquire(commonDir: string): AsyncMutex {
    const k = gitDirKey(commonDir);
    let lane = this.lanes.get(k);
    if (!lane) this.lanes.set(k, (lane = { mutex: new AsyncMutex(), refs: 0 }));
    lane.refs++;
    return lane.mutex;
  }

  release(commonDir: string): void {
    const k = gitDirKey(commonDir);
    const lane = this.lanes.get(k);
    if (lane && --lane.refs <= 0) this.lanes.delete(k);
  }

  get size(): number {
    return this.lanes.size;
  }
}

// ---- lock files ----

const GITDIR_LOCKS = ['index.lock', 'HEAD.lock', 'ORIG_HEAD.lock', 'config.worktree.lock', 'MERGE_HEAD.lock'];
const COMMONDIR_LOCKS = ['config.lock', 'packed-refs.lock', 'shallow.lock', 'HEAD.lock'];
const MAX_REF_SCAN = 20_000;

export interface LockScanOptions {
  gitDir: string;
  commonDir: string;
  /** Skip `index.lock` (another op of ours may legitimately hold it). */
  skipIndex?: boolean;
}

/** Existing `*.lock` files git may leave behind in this worktree's git dir and the shared common dir. */
export function findLockFiles(o: LockScanOptions): string[] {
  const out = new Set<string>();
  const add = (p: string): void => {
    if (fs.existsSync(p)) out.add(p);
  };
  for (const f of GITDIR_LOCKS) if (!(o.skipIndex && f === 'index.lock')) add(path.join(o.gitDir, f));
  for (const f of COMMONDIR_LOCKS) add(path.join(o.commonDir, f));
  const roots = new Set([path.join(o.commonDir, 'refs'), path.join(o.gitDir, 'refs')]);
  let seen = 0;
  for (const root of roots) {
    const stack = [root];
    while (stack.length && seen < MAX_REF_SCAN) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        seen++;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith('.lock')) out.add(p);
      }
    }
  }
  return [...out];
}

export interface RecoverOptions extends LockScanOptions {
  /** Op start time (ms). Locks modified at or after it were created by the op's processes. */
  since: number;
}

/**
 * Post-cancel / post-crash recovery (spec 02 §6.2 step 4): delete lock files whose mtime ≥ the op's
 * start (rounded down to the second for coarse filesystem timestamps). Older locks belong to someone
 * else and are left alone. Returns the deleted paths.
 */
export async function recoverLocks(o: RecoverOptions): Promise<string[]> {
  const since = Math.floor(o.since / 1000) * 1000;
  const removed: string[] = [];
  for (const p of findLockFiles(o)) {
    try {
      const st = await fs.promises.stat(p);
      if (st.mtimeMs < since) continue;
      await fs.promises.rm(p, { force: true });
      removed.push(p);
    } catch {
      /* vanished meanwhile */
    }
  }
  return removed;
}

// ---- stale heuristic ----

/** A lock older than this with no git process of ours or the OS in the repo is "stale" (§6.13 rule 3). */
export const STALE_LOCK_MS = 60_000;

/**
 * Best-effort scan for a running git process working in one of `dirs` (worktree root, git dir, common
 * dir; spec 02 §6.13 rule 3). Linux
 * reads `/proc/<pid>/cwd`; elsewhere any running git process counts (cwd is not cheaply available), which
 * errs on the side of "not stale". Skipped (→ false) when the scan takes longer than `timeoutMs`.
 */
export async function gitProcessRunningIn(
  dirs: string[],
  o: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<boolean> {
  const platform = o.platform ?? process.platform;
  const timeoutMs = o.timeoutMs ?? 1500;
  const keys = dirs.map((d) => gitDirKey(d));
  if (platform === 'linux') {
    try {
      for (const pid of await fs.promises.readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        const comm = await fs.promises.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
        if (!/^git/.test(comm.trim())) continue;
        const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => '');
        if (cwd && keys.some((k) => caseFold(cwd).startsWith(k))) return true;
      }
    } catch {
      return false;
    }
    return false;
  }
  const [cmd, args] =
    platform === 'win32'
      ? ['tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH']]
      : ['ps', ['-axo', 'comm=']];
  return new Promise<boolean>((resolve) => {
    const child = execFile(
      cmd,
      args as string[],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(
          platform === 'win32'
            ? /"git\.exe"/i.test(stdout)
            : stdout.split('\n').some((l) => /(^|\/)git$/.test(l.trim())),
        );
      },
    );
    child.on('error', () => resolve(false));
  });
}
