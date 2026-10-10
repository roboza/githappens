import { GitError } from '../../errors/classify';
import { withPathspec } from '../../service/pathspec';
import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { OpResult } from '../types';
import { classified, define, fail, git, withConflictFiles } from './util';

type Result = Promise<Omit<OpResult, 'opId'>>;

/** Resolve a StashRef to its current `stash@{n}`, guarding against index drift (spec 05 §6.10). */
async function resolveStash(ctx: OpContext, index: number, sha: Sha): Promise<string> {
  const list = await ctx.service.stashList();
  const exact = list.find((s) => s.index === index && s.sha === sha);
  const bySha = exact ?? list.find((s) => s.sha === sha);
  if (!bySha) throw fail('Unknown', 'That stash no longer exists; refresh and try again.');
  return `stash@{${bySha.index}}`;
}

async function push(
  ctx: OpContext,
  op: {
    message?: string;
    includeUntracked?: boolean;
    keepIndex?: boolean;
    stagedOnly?: boolean;
    paths?: string[];
  },
): Result {
  const svc = ctx.service;
  if (!(await svc.revParse('HEAD'))) throw fail('UnbornBranch', 'Cannot stash before the first commit.');
  const base = ['stash', 'push'];
  if (op.message?.trim()) base.push('-m', op.message.trim());
  // `--staged` (git >= 2.35) cannot be combined with -u / --keep-index
  if (op.stagedOnly) base.push('--staged');
  else {
    if (op.includeUntracked) base.push('--include-untracked');
    if (op.keepIndex) base.push('--keep-index');
  }
  const paths = op.paths ?? [];
  const ps = withPathspec(base, paths);
  const before = await svc.revParse('refs/stash');
  // stash runs `git clean -- :/` internally: literal pathspecs would break -u without paths
  try {
    await git(ctx, ps.args, { stdin: ps.stdin, ...(paths.length ? { env: ps.env } : {}) });
  } catch (e) {
    if (
      op.stagedOnly &&
      e instanceof GitError &&
      /unknown (switch|option)|usage: git stash/i.test(e.serialized.stderr)
    ) {
      throw fail('GitTooOld', 'Stashing only staged changes needs Git 2.35 or newer.');
    }
    throw e;
  }
  const after = await svc.revParse('refs/stash');
  if (!after || after === before)
    return { summary: 'No local changes to stash', warnings: ['No local changes to save.'] };
  return { summary: 'Stashed changes', data: { sha: after } };
}

async function applyOrPop(ctx: OpContext, cmd: 'apply' | 'pop', index: number, sha: Sha): Result {
  const ref = await resolveStash(ctx, index, sha);
  const args = ['stash', cmd, ref];
  const r = await git(ctx, args, { expectedExitCodes: [0, 1] });
  if (r.exitCode !== 0) {
    // conflict text goes to stdout; classify with both streams, then attach unmerged files
    await withConflictFiles(ctx.service, classified(args, r, ctx.opId), 'StashConflict');
  }
  return { summary: cmd === 'pop' ? 'Popped stash' : 'Applied stash' };
}

async function drop(ctx: OpContext, index: number, sha: Sha): Result {
  const ref = await resolveStash(ctx, index, sha);
  await git(ctx, ['stash', 'drop', '-q', ref]);
  return { summary: 'Dropped stash' };
}

const TOUCHES: ['stash', 'status', 'refs', 'graph', 'conflicts'] = [
  'stash',
  'status',
  'refs',
  'graph',
  'conflicts',
];

export const stashOps = {
  'stash.push': define(
    'stash.push',
    {
      label: (op) => (op.message ? `Stash: ${op.message}` : 'Stash changes'),
      touches: TOUCHES,
      undoable: true,
    },
    (ctx, op) => push(ctx, op),
  ),
  'stash.apply': define(
    'stash.apply',
    { label: (op) => `Apply stash@{${op.index}}`, touches: TOUCHES },
    (ctx, op) => applyOrPop(ctx, 'apply', op.index, op.sha),
  ),
  'stash.pop': define(
    'stash.pop',
    { label: (op) => `Pop stash@{${op.index}}`, touches: TOUCHES, undoable: true },
    (ctx, op) => applyOrPop(ctx, 'pop', op.index, op.sha),
  ),
  'stash.drop': define(
    'stash.drop',
    { label: (op) => `Delete stash@{${op.index}}`, touches: TOUCHES, undoable: true },
    (ctx, op) => drop(ctx, op.index, op.sha),
  ),
};
