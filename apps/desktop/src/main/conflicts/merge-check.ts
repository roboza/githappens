import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GitService } from '@githappens/git';

import type { ConflictHunk } from '../../shared/ipc/conflicts-contract';

/** Time box for one merge-tree run (spec 14 §8 "very large repos"). */
export const CHECK_TIMEOUT_MS = 20_000;

export interface MergeCheckResult {
  supported: boolean;
  /** Result tree of the (possibly conflicted) merge; used to read conflict markers on demand. */
  tree: string | null;
  conflicts: string[];
}

const UNSUPPORTED = /usage|unknown option|write-tree/i;

/**
 * `git merge-tree --write-tree --name-only --no-messages -z <ours> <theirs>` (git ≥ 2.38): touches
 * neither index nor worktree. Exit 0 = clean, 1 = conflicts (paths after the tree oid).
 */
export async function mergeTreeCheck(
  svc: GitService,
  ours: string,
  theirs: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<MergeCheckResult> {
  const r = await svc.runRead(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs],
    {
      expectedExitCodes: [0, 1, 128, 129],
      priority: 'background',
      timeoutMs,
    },
  );
  const out = String(r.stdout);
  if (r.exitCode === 0 || r.exitCode === 1) {
    const parts = out.split('\0');
    const tree = parts[0]?.trim() || null;
    const conflicts: string[] = [];
    if (r.exitCode === 1) {
      for (const p of parts.slice(1)) {
        if (!p) break;
        if (!conflicts.includes(p)) conflicts.push(p);
      }
    }
    return { supported: true, tree, conflicts };
  }
  if (UNSUPPORTED.test(r.stderr)) return { supported: false, tree: null, conflicts: [] };
  throw new Error(r.stderr.trim() || 'git merge-tree failed');
}

const WIP_IDENTITY = {
  GIT_AUTHOR_NAME: 'GitHappens',
  GIT_AUTHOR_EMAIL: 'conflicts@githappens.invalid',
  GIT_COMMITTER_NAME: 'GitHappens',
  GIT_COMMITTER_EMAIL: 'conflicts@githappens.invalid',
};

/**
 * Snapshot the working directory as a dangling commit on top of HEAD (spec 14 §6.5 WIP mode) using a
 * temporary index (`GIT_INDEX_FILE`), so the user's index is never read-modified-written. The temp
 * index starts as a copy of the real one only to reuse its stat cache.
 */
export async function wipSnapshot(
  svc: GitService,
  headSha: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<{ tree: string; commit: string }> {
  const info = svc.repo;
  if (!info.worktreeRoot) throw new Error('No working tree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wip-'));
  const tmpIndex = path.join(dir, 'index');
  try {
    const realIndex = path.join(info.gitDir, 'index');
    if (fs.existsSync(realIndex)) {
      // keep the original mtime: git's racy-clean check compares entries against the index file's mtime
      const st = fs.statSync(realIndex);
      fs.copyFileSync(realIndex, tmpIndex);
      fs.utimesSync(tmpIndex, st.atime, st.mtime);
    }
    const env = { GIT_INDEX_FILE: tmpIndex, ...WIP_IDENTITY };
    const opts = { env, priority: 'background' as const, timeoutMs };
    if (!fs.existsSync(tmpIndex)) await svc.runRead(['read-tree', headSha], opts);
    await svc.runRead(['add', '-A', '--', '.'], opts);
    const tree = String((await svc.runRead(['write-tree'], opts)).stdout).trim();
    const commit = String(
      (await svc.runRead(['commit-tree', tree, '-p', headSha, '-m', 'githappens wip snapshot'], opts)).stdout,
    ).trim();
    return { tree, commit };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse conflict markers of one merged file into line ranges in each side's coordinates. Lines outside
 * conflict blocks count for both sides (approximate when the other side merged cleanly above).
 */
export function parseConflictMarkers(text: string): ConflictHunk[] {
  const lines = text.split(/\r?\n/);
  const hunks: ConflictHunk[] = [];
  let ours = 0;
  let theirs = 0;
  let mode: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  let oursStart = 0;
  let theirsStart = 0;
  for (const line of lines) {
    if (mode === 'none') {
      if (line.startsWith('<<<<<<<')) {
        mode = 'ours';
        oursStart = ours + 1;
      } else {
        ours++;
        theirs++;
      }
    } else if (line.startsWith('|||||||') && mode === 'ours') {
      mode = 'base';
    } else if (line.startsWith('=======') && (mode === 'ours' || mode === 'base')) {
      mode = 'theirs';
      theirsStart = theirs + 1;
    } else if (line.startsWith('>>>>>>>') && mode === 'theirs') {
      hunks.push({
        ours: [oursStart, Math.max(oursStart, ours)],
        theirs: [theirsStart, Math.max(theirsStart, theirs)],
      });
      mode = 'none';
    } else if (mode === 'ours') ours++;
    else if (mode === 'theirs') theirs++;
  }
  return hunks;
}

/** Conflict hunks of `filePath` in a merge-tree result tree; [] for binary / delete / rename conflicts. */
export async function hunksFromTree(
  svc: GitService,
  tree: string,
  filePath: string,
): Promise<ConflictHunk[]> {
  const r = await svc.runRead(['cat-file', '-p', `${tree}:${filePath}`], {
    expectedExitCodes: [0, 128],
    priority: 'background',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.exitCode !== 0) return [];
  const text = String(r.stdout);
  if (text.includes('\0')) return [];
  return parseConflictMarkers(text);
}
