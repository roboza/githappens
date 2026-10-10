import fs from 'node:fs';

import { isAncestor } from '../../service/phase3/history';
import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { MergeMode, OpOf, OpResult } from '../types';
import { opPaths, overwriteMessage, requireIdle, requireResolved } from './history-util';
import { assertSafeName, define, fail, git, read, unmergedPaths, withConflictFiles } from './util';

export interface MergeOutcome {
  result: 'up-to-date' | 'fast-forward' | 'merge' | 'squash';
  head: Sha | null;
}

async function parentCount(ctx: OpContext, sha: Sha): Promise<number> {
  const r = await read(ctx.service, ['rev-list', '--parents', '-n', '1', sha, '--']);
  return r.stdout.trim().split(/\s+/).length - 1;
}

// ---- merge (spec 05 §6.5) ----

async function mergeRun(
  ctx: OpContext,
  op: OpOf<'merge.run'>,
): Promise<Omit<OpResult<MergeOutcome>, 'opId'>> {
  assertSafeName(op.source, 'merge source');
  const svc = ctx.service;
  const info = await requireIdle(ctx, 'merge');
  if (!(await svc.revParse(op.source))) throw fail('Unknown', `Unknown revision "${op.source}".`);
  const before = info.head.sha;
  const flags: Record<MergeMode, string[]> = {
    default: ['--ff', '--no-edit'],
    'no-ff': ['--no-ff', '--no-edit'],
    'ff-only': ['--ff-only'],
    squash: ['--squash'],
  };
  const args = ['merge', ...flags[op.mode]];
  if (op.message?.trim() && (op.mode === 'default' || op.mode === 'no-ff')) args.push('-m', op.message);
  args.push(op.source);
  try {
    await git(ctx, args);
  } catch (e) {
    await svc.refreshRepoInfo();
    return withConflictFiles(svc, e, 'MergeConflict');
  }
  const after = await svc.revParse('HEAD');
  await svc.refreshRepoInfo();
  const into = info.head.kind === 'branch' ? info.head.name : 'HEAD';
  if (op.mode === 'squash') {
    if (op.message?.trim()) overwriteMessage(op.message, [(await opPaths(svc)).SQUASH_MSG]);
    return {
      summary: `Squashed ${op.source} into ${into} (staged, not committed)`,
      data: { result: 'squash', head: after },
    };
  }
  if (after === before) return { summary: 'Already up to date', data: { result: 'up-to-date', head: after } };
  const result = after && (await parentCount(ctx, after)) > 1 ? 'merge' : 'fast-forward';
  return {
    summary:
      result === 'merge' ? `Merged ${op.source} into ${into}` : `Fast-forwarded ${into} to ${op.source}`,
    data: { result, head: after },
  };
}

/** Continue a stopped merge (or a `--squash` merge): commit with MERGE_MSG or the given message (spec 08 §6.7). */
async function mergeContinue(
  ctx: OpContext,
  message?: string,
): Promise<Omit<OpResult<MergeOutcome>, 'opId'>> {
  const svc = ctx.service;
  const info = await svc.refreshRepoInfo();
  const p = await opPaths(svc);
  const squash = info.state === 'clean' && fs.existsSync(p.SQUASH_MSG);
  if (info.state !== 'merging' && !squash) throw fail('Unknown', 'There is no merge in progress.');
  await requireResolved(svc, 'MergeConflict');
  if (message?.trim()) {
    await git(ctx, ['commit', '-q', '-F', '-', '--cleanup=whitespace'], {
      stdin: Buffer.from(message, 'utf8'),
    });
  } else {
    // MERGE_MSG / SQUASH_MSG; strip drops git's commented "# Conflicts:" list
    await git(ctx, ['commit', '-q', '--no-edit', '--cleanup=strip']);
  }
  const head = await svc.revParse('HEAD');
  await svc.refreshRepoInfo();
  return {
    summary: `Committed merge ${head?.slice(0, 7) ?? ''}`.trim(),
    data: { result: squash ? 'squash' : 'merge', head },
  };
}

async function mergeAbort(ctx: OpContext): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  const info = await svc.refreshRepoInfo();
  const p = await opPaths(svc);
  if (info.state === 'merging') await git(ctx, ['merge', '--abort']);
  else if (info.state === 'clean' && (fs.existsSync(p.SQUASH_MSG) || (await unmergedPaths(svc)).length)) {
    // squash merge / conflicted stash apply: no native abort → reset --merge (keeps unrelated local changes)
    await git(ctx, ['reset', '--merge', '-q']);
    fs.rmSync(p.SQUASH_MSG, { force: true });
  } else throw fail('Unknown', 'There is no merge in progress.');
  await svc.refreshRepoInfo();
  return { summary: 'Merge aborted' };
}

// ---- fast-forward any branch (spec 05 §6.6) ----

async function ffRun(ctx: OpContext, op: OpOf<'ff.run'>): Promise<Omit<OpResult<MergeOutcome>, 'opId'>> {
  assertSafeName(op.branch, 'branch');
  assertSafeName(op.to, 'target');
  const svc = ctx.service;
  const name = op.branch.replace(/^refs\/heads\//, '');
  const ref = `refs/heads/${name}`;
  const old = await svc.revParse(ref);
  if (!old) throw fail('Unknown', `Branch ${name} does not exist.`, { branch: name });
  const target = await svc.revParse(op.to);
  if (!target) throw fail('Unknown', `Unknown revision "${op.to}".`);
  if (old === target)
    return { summary: `${name} is already up to date`, data: { result: 'up-to-date', head: target } };
  if (!(await isAncestor(svc, old, target))) {
    throw fail(
      'NotFastForwardable',
      `${name} cannot be fast-forwarded to ${op.to}: the branches have diverged.`,
      {
        branch: name,
      },
    );
  }
  const info = await svc.refreshRepoInfo();
  if (info.head.kind === 'branch' && info.head.name === name) {
    if (info.state !== 'clean') throw fail('Unknown', 'Finish or abort the operation in progress first.');
    await git(ctx, ['merge', '--ff-only', '-q', target]);
  } else {
    const wt = await read(svc, ['worktree', 'list', '--porcelain']);
    if (wt.stdout.split(/\r?\n/).includes(`branch ${ref}`)) {
      throw fail('BranchCheckedOutInWorktree', undefined, { branch: name });
    }
    // compare-and-swap on the old value
    await git(ctx, ['update-ref', '-m', `fast-forward: ${name} to ${op.to}`, ref, target, old]);
  }
  await svc.refreshRepoInfo();
  return { summary: `Fast-forwarded ${name} to ${op.to}`, data: { result: 'fast-forward', head: target } };
}

const TOUCHES: ('status' | 'refs' | 'graph' | 'repoState' | 'conflicts')[] = [
  'status',
  'refs',
  'graph',
  'repoState',
  'conflicts',
];

export const mergeOps = {
  'merge.run': define(
    'merge.run',
    {
      label: (op) => (op.mode === 'squash' ? `Squash merge ${op.source}` : `Merge ${op.source}`),
      touches: TOUCHES,
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => mergeRun(ctx, op),
  ),
  'merge.continue': define(
    'merge.continue',
    { label: () => 'Commit merge', touches: TOUCHES, cancellable: false },
    (ctx, op) => mergeContinue(ctx, op.message),
  ),
  'merge.abort': define(
    'merge.abort',
    { label: () => 'Abort merge', touches: TOUCHES, cancellable: false },
    (ctx) => mergeAbort(ctx),
  ),
  'ff.run': define(
    'ff.run',
    {
      label: (op) => `Fast-forward ${op.branch.replace(/^refs\/heads\//, '')} to ${op.to}`,
      touches: ['status', 'refs', 'graph'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => ffRun(ctx, op),
  ),
};
