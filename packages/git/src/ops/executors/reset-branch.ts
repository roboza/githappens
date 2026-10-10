import fs from 'node:fs';

import type { GitService } from '../../service/git-service';
import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { opPaths, requireIdle } from './history-util';
import { assertSafeName, define, fail, git, read } from './util';

/**
 * Non-HEAD branch reset (spec 05 §6.9) and the reflog fallback of Undo (spec 05 §4.7), plus the read helpers
 * the branching UI needs (drop-matrix relation, detached-HEAD orphans, SQUASH_MSG).
 */

async function resetBranch(
  ctx: OpContext,
  op: OpOf<'reset.branch'>,
): Promise<Omit<OpResult<{ branch: string; from: Sha; to: Sha }>, 'opId'>> {
  assertSafeName(op.branch, 'branch');
  assertSafeName(op.target, 'reset target');
  if (op.mode !== 'soft' && op.mode !== 'mixed') {
    throw fail('Unknown', 'Only a soft or mixed reset is possible for a branch that is not checked out.');
  }
  const svc = ctx.service;
  const name = op.branch.replace(/^refs\/heads\//, '');
  const ref = `refs/heads/${name}`;
  const old = await svc.revParse(ref);
  if (!old) throw fail('Unknown', `Branch ${name} does not exist.`, { branch: name });
  const info = await svc.refreshRepoInfo();
  if (info.head.kind === 'branch' && info.head.name === name) {
    throw fail('Unknown', `${name} is checked out; reset it with "Reset ${name} to this commit".`);
  }
  const wt = await read(svc, ['worktree', 'list', '--porcelain']);
  if (wt.stdout.split(/\r?\n/).includes(`branch ${ref}`)) {
    throw fail('BranchCheckedOutInWorktree', undefined, { branch: name });
  }
  const target = await svc.revParse(`${op.target}^{commit}`);
  if (!target) throw fail('Unknown', `Unknown revision "${op.target}".`);
  if (target !== old) {
    // compare-and-swap on the old value
    await git(ctx, ['update-ref', '-m', `reset: moving to ${op.target}`, ref, target, old]);
  }
  return {
    summary: `Reset ${name} to ${target.slice(0, 7)}`,
    data: { branch: name, from: old, to: target },
  };
}

async function reflogRestore(
  ctx: OpContext,
  op: OpOf<'reflog.restore'>,
): Promise<Omit<OpResult<{ head: Sha }>, 'opId'>> {
  assertSafeName(op.target, 'commit');
  const svc = ctx.service;
  const info = await requireIdle(ctx, 'restore from the reflog');
  const target = await svc.revParse(`${op.target}^{commit}`);
  if (!target) throw fail('Unknown', `Unknown commit "${op.target}".`);
  // --keep: refuses instead of clobbering local changes in files that differ
  await git(ctx, ['reset', '--keep', '-q', target]);
  await svc.refreshRepoInfo();
  const name = info.head.kind === 'branch' ? info.head.name : 'HEAD';
  return { summary: `Restored ${name} to ${op.selector} (${target.slice(0, 7)})`, data: { head: target } };
}

export const resetBranchOps = {
  'reset.branch': define(
    'reset.branch',
    {
      label: (op) => `Reset ${op.branch.replace(/^refs\/heads\//, '')} to ${op.target.slice(0, 7)}`,
      touches: ['refs', 'graph'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => resetBranch(ctx, op),
  ),
  'reflog.restore': define(
    'reflog.restore',
    {
      label: (op) => `Restore ${op.selector}`,
      touches: ['status', 'refs', 'graph', 'repoState'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => reflogRestore(ctx, op),
  ),
};

// ---- read helpers ----

export interface ReflogFallback {
  /** `main@{1}` (HEAD's branch) or `HEAD@{1}` (detached). */
  selector: string;
  sha: Sha;
  /** Reflog subject of the entry that moved away from it ("commit: Fix bug", "reset: moving to …"). */
  subject: string;
  /** Current tip (the entry restoring would undo). */
  current: Sha;
}

/**
 * The previous position of HEAD's branch (spec 05 §4.7 "Show in reflog" / "Restore HEAD@{1}?"), offered by Undo
 * when the journal has nothing. Null when there is no earlier position.
 */
export async function reflogFallback(service: GitService): Promise<ReflogFallback | null> {
  const info = await service.refreshRepoInfo();
  if (!info.head.sha) return null;
  const ref = info.head.kind === 'branch' ? `refs/heads/${info.head.name}` : 'HEAD';
  const r = await read(service, ['reflog', 'show', '-n', '2', '--format=%H%x1f%gs', ref, '--'], {
    expectedExitCodes: [0, 128],
  });
  if (r.exitCode !== 0) return null;
  const rows = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'));
  if (rows.length < 2) return null;
  const [cur, prev] = rows as [string[], string[]];
  if (!prev[0] || prev[0] === cur[0]) return null;
  if (!(await service.revParse(`${prev[0]}^{commit}`))) return null;
  const selector = info.head.kind === 'branch' ? `${info.head.name}@{1}` : 'HEAD@{1}';
  return { selector, sha: prev[0], subject: cur[1] ?? '', current: cur[0]! };
}

export interface RefRelation {
  /** The two revisions share history (`git merge-base` succeeds). */
  mergeBase: boolean;
  /** The repository is a shallow clone (merge-base may be missing because of it). */
  shallow: boolean;
}

/** Drag-and-drop matrix inputs (spec 05 §4.4 rules: "No common ancestor", §8 "History is shallow"). */
export async function refRelation(service: GitService, a: string, b: string): Promise<RefRelation> {
  assertSafeName(a, 'revision');
  assertSafeName(b, 'revision');
  const [mb, sh] = await Promise.all([
    read(service, ['merge-base', a, b, '--'], { expectedExitCodes: [0, 1, 128] }).catch(() => null),
    read(service, ['rev-parse', '--is-shallow-repository']).catch(() => null),
  ]);
  return {
    mergeBase: !!mb && mb.exitCode === 0 && !!mb.stdout.trim(),
    shallow: sh?.stdout.trim() === 'true',
  };
}

/**
 * Commits reachable from a detached HEAD but from no branch, tag or remote-tracking ref (spec 05 §8: "N commits
 * will become unreachable"). 0 when HEAD is on a branch.
 */
export async function detachedOrphans(service: GitService): Promise<{ count: number; sha: Sha | null }> {
  const info = await service.refreshRepoInfo();
  if (info.head.kind === 'branch' || !info.head.sha) return { count: 0, sha: null };
  const r = await read(service, [
    'rev-list',
    '--count',
    'HEAD',
    '--not',
    '--branches',
    '--tags',
    '--remotes',
  ]);
  return { count: Number(r.stdout.trim()) || 0, sha: info.head.sha };
}

/** `.git/SQUASH_MSG` after a `merge --squash` (spec 05 §6.5: the commit composer pre-fills it); null when absent. */
export async function squashMessage(service: GitService): Promise<string | null> {
  try {
    const text = await fs.promises.readFile((await opPaths(service)).SQUASH_MSG, 'utf8');
    // git's SQUASH_MSG lists every squashed commit; comment lines are not part of the message
    const lines = text.split(/\r?\n/).filter((l) => !l.startsWith('#'));
    return lines.join('\n').trim() || null;
  } catch {
    return null;
  }
}
