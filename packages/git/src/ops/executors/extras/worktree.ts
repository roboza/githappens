import fs from 'node:fs';
import nodePath from 'node:path';

import { listWorktrees, samePath } from '../../../service/extras/worktrees';
import type { OpContext } from '../../queue';
import type { OpOf, OpResult } from '../../types';
import { assertSafeName, define, fail, git } from '../util';
import { assertSafePath } from './shared';

type Result = Promise<Omit<OpResult, 'opId'>>;

/** Absolute native path for a worktree target (relative paths resolve against the current worktree). */
function resolvePath(ctx: OpContext, p: string): string {
  return nodePath.resolve(ctx.service.cwd, assertSafePath(p, 'worktree path'));
}

function isNonEmptyDir(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return !st.isDirectory() || fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

// ---- add (spec 09 §6.10) ----

async function add(ctx: OpContext, op: OpOf<'worktree.add'>): Result {
  const target = resolvePath(ctx, op.path);
  if (isNonEmptyDir(target)) {
    throw fail('Unknown', `The folder "${target}" already exists and is not empty.`, { path: target });
  }
  const args = ['worktree', 'add'];
  let ref: string | undefined;
  if (op.newBranch) {
    assertSafeName(op.newBranch, 'branch name');
    args.push('-b', op.newBranch);
    ref = op.startPoint ?? op.branch;
  } else if (op.detach) {
    args.push('--detach');
    ref = op.startPoint ?? op.branch ?? 'HEAD';
  } else {
    ref = op.branch ?? op.startPoint;
  }
  if (ref !== undefined) assertSafeName(ref, 'revision');
  args.push('--', target, ...(ref !== undefined ? [ref] : []));
  await git(ctx, args, { progress: ctx.progress, progressKind: 'checkout' });
  return { summary: `Created worktree ${nodePath.basename(target)}`, data: { path: target } };
}

// ---- remove ----

async function remove(ctx: OpContext, op: OpOf<'worktree.remove'>): Result {
  const target = resolvePath(ctx, op.path);
  const list = await listWorktrees(ctx.service);
  const wt = list.find((w) => samePath(w.path, target));
  if (wt?.isMain) throw fail('Unknown', 'The main worktree cannot be removed.', { path: target });
  const args = ['worktree', 'remove'];
  if (op.force) args.push('--force');
  if (op.force && wt?.locked) args.push('--force'); // twice: also overrides the lock
  args.push('--', wt?.path ?? target);
  await git(ctx, args);
  return { summary: `Removed worktree ${nodePath.basename(target)}`, data: { path: target } };
}

// ---- lock / unlock / prune ----

async function lock(ctx: OpContext, op: OpOf<'worktree.lock'>): Result {
  const target = resolvePath(ctx, op.path);
  const args = ['worktree', 'lock'];
  if (op.reason) {
    if (/[\0\r\n]/.test(op.reason)) throw fail('Unknown', 'The lock reason must be a single line.');
    args.push(`--reason=${op.reason}`);
  }
  args.push('--', target);
  await git(ctx, args);
  return { summary: `Locked worktree ${nodePath.basename(target)}` };
}

async function unlock(ctx: OpContext, op: OpOf<'worktree.unlock'>): Result {
  const target = resolvePath(ctx, op.path);
  await git(ctx, ['worktree', 'unlock', '--', target]);
  return { summary: `Unlocked worktree ${nodePath.basename(target)}` };
}

/** `Removing worktrees/<id>: <reason>` lines of `git worktree prune -v`. */
export function parsePruneOutput(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => /^Removing (.+?)(?::\s.*)?$/.exec(l.trim())?.[1])
    .filter((x): x is string => !!x);
}

async function prune(ctx: OpContext): Result {
  const r = await git(ctx, ['worktree', 'prune', '-v']);
  const pruned = parsePruneOutput(`${r.stdout}\n${r.stderr}`);
  return {
    summary: pruned.length
      ? `Pruned ${pruned.length} stale worktree${pruned.length === 1 ? '' : 's'}`
      : 'Nothing to prune',
    data: { pruned },
  };
}

const TOUCHES: ['worktrees', 'refs', 'graph'] = ['worktrees', 'refs', 'graph'];

export const worktreeOps = {
  'worktree.add': define(
    'worktree.add',
    { label: (op) => `Create worktree ${nodePath.basename(op.path)}`, touches: TOUCHES },
    add,
  ),
  'worktree.remove': define(
    'worktree.remove',
    { label: (op) => `Remove worktree ${nodePath.basename(op.path)}`, touches: TOUCHES },
    remove,
  ),
  'worktree.lock': define(
    'worktree.lock',
    { label: (op) => `Lock worktree ${nodePath.basename(op.path)}`, touches: ['worktrees'] },
    lock,
  ),
  'worktree.unlock': define(
    'worktree.unlock',
    { label: (op) => `Unlock worktree ${nodePath.basename(op.path)}`, touches: ['worktrees'] },
    unlock,
  ),
  'worktree.prune': define('worktree.prune', { label: () => 'Prune worktrees', touches: TOUCHES }, (ctx) =>
    prune(ctx),
  ),
};
