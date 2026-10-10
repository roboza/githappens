import path from 'node:path';

import { listWorktrees, parseLfsLocksJson, type GitService } from '@githappens/git';

import type {
  LfsLockInfo,
  LfsLocksResult,
  SubmoduleParentInfo,
  WorktreeStatusInfo,
} from '../../shared/ipc/remotes-contract';

/**
 * Read helpers behind `git:lfs:locks`, `git:worktree:status` and `git:submodule:parent`
 * (spec 09 §6.8–6.10). All argv-only, read-only, never prompting.
 */

/** Locks need the server: keep it short and never block the UI on it. */
export const LFS_LOCKS_TIMEOUT_MS = 8_000;

const NO_PROMPT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

/**
 * `git lfs locks --verify --json` → `{"ours":[…],"theirs":[…]}`. Returns null on anything else so the
 * caller can fall back to the unverified listing.
 */
export function parseLfsVerifyJson(stdout: string): LfsLockInfo[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as { ours?: unknown; theirs?: unknown };
  if (!Array.isArray(o.ours) && !Array.isArray(o.theirs)) return null;
  const side = (v: unknown, ours: boolean): LfsLockInfo[] =>
    parseLfsLocksJson(JSON.stringify(Array.isArray(v) ? v : [])).map((l) => ({ ...l, ours }));
  return [...side(o.ours, true), ...side(o.theirs, false)].sort((a, b) => a.path.localeCompare(b.path));
}

/** Map a failed `git lfs locks` run to a short reason; 404/501 mean "server has no locking API". */
export function lfsLocksFailure(stderr: string): { supported: boolean; error: string } {
  const text = stderr.trim();
  if (/not a git command|git-lfs.*not found|is not a git command/i.test(text))
    return { supported: false, error: 'git-lfs is not installed.' };
  if (/\b(404|501)\b|not (?:supported|implemented)|locking API/i.test(text))
    return { supported: false, error: 'The LFS server does not support file locking.' };
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? 'Could not list LFS locks.';
  return { supported: true, error: line.replace(/^(?:error|fatal):\s*/i, '').slice(0, 300) };
}

export async function listLfsLocks(svc: GitService): Promise<LfsLocksResult> {
  const opts = {
    timeoutMs: LFS_LOCKS_TIMEOUT_MS,
    env: NO_PROMPT_ENV,
    expectedExitCodes: [0, 1, 2, 128],
    priority: 'background' as const,
  };
  let verifyErr: string;
  try {
    const v = await svc.runRead(['lfs', 'locks', '--verify', '--json'], opts);
    if (v.exitCode === 0) {
      const parsed = parseLfsVerifyJson(v.stdout);
      if (parsed) return { supported: true, locks: parsed };
    }
    verifyErr = v.stderr;
  } catch (e) {
    verifyErr = e instanceof Error ? e.message : String(e);
  }
  try {
    const r = await svc.runRead(['lfs', 'locks', '--json'], opts);
    if (r.exitCode === 0) {
      return { supported: true, locks: parseLfsLocksJson(r.stdout).map((l) => ({ ...l, ours: null })) };
    }
    return { locks: [], ...lfsLocksFailure(r.stderr || verifyErr) };
  } catch (e) {
    return { locks: [], ...lfsLocksFailure(e instanceof Error ? e.message : String(e)) };
  }
}

/** Number of entries in `git status --porcelain=v2 -z` output (rename records carry an extra path). */
export function countPorcelainV2(stdout: string): number {
  const toks = stdout.split('\0');
  let n = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('2 ')) i++; // original path follows
    if (/^[12u?] /.test(t)) n++;
  }
  return n;
}

const norm = (p: string): string => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? r : r.toLowerCase();
};

export async function worktreeStatus(svc: GitService, wtPath: string): Promise<WorktreeStatusInfo> {
  const list = await listWorktrees(svc);
  const wt = list.find((w) => norm(w.path) === norm(wtPath));
  if (!wt || wt.bare) throw new Error(`Not a worktree of this repository: ${wtPath}`);
  const r = await svc.runRead(['-C', wt.path, 'status', '--porcelain=v2', '-z', '--untracked-files=normal'], {
    expectedExitCodes: [0, 128],
  });
  return {
    path: wt.path,
    // a worktree whose folder is gone (prunable) has nothing to lose
    changed: r.exitCode === 0 ? countPorcelainV2(r.stdout) : 0,
    branch: wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : null,
    locked: !!wt.locked,
  };
}

const SHA = /^[0-9a-f]{40,64}$/;

/** `<mode> <sha> <stage>\t<path>` from `ls-files -s` / `<mode> commit <sha>\t<path>` from `ls-tree`. */
export function gitlinkSha(line: string): string | null {
  const m = /^160000 (?:commit )?([0-9a-f]{40,64})\b/.exec(line.trim());
  return m ? m[1]! : null;
}

export async function submoduleParent(svc: GitService): Promise<SubmoduleParentInfo | null> {
  const root = svc.repo.worktreeRoot;
  if (!root) return null;
  const sp = await svc.runRead(['rev-parse', '--show-superproject-working-tree'], {
    expectedExitCodes: [0, 128],
  });
  const parent = sp.exitCode === 0 ? sp.stdout.trim() : '';
  if (!parent) return null;
  const parentPath = path.resolve(parent);
  const rel = path.relative(parentPath, root).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return null;
  const inParent = (args: string[]) =>
    svc.runRead(['-C', parentPath, ...args], { expectedExitCodes: [0, 1, 128] }).catch(() => null);
  const [tree, index, head] = await Promise.all([
    inParent(['ls-tree', 'HEAD', '--', rel]),
    inParent(['ls-files', '-s', '--', rel]),
    svc.runRead(['rev-parse', '--verify', '-q', 'HEAD'], { expectedExitCodes: [0, 1, 128] }),
  ]);
  const recordedSha = tree?.exitCode === 0 ? gitlinkSha(tree.stdout) : null;
  const indexSha = index?.exitCode === 0 ? gitlinkSha(index.stdout) : null;
  const h = head.exitCode === 0 ? head.stdout.trim() : '';
  const headSha = SHA.test(h) ? h : null;
  return {
    parentPath,
    path: rel,
    recordedSha,
    indexSha,
    headSha,
    pointerChanged: !!headSha && headSha !== (indexSha ?? recordedSha),
  };
}
