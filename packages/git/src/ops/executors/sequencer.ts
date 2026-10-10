import { topoSort } from '../../service/phase3/history';
import { sequencerTodo } from '../../service/phase3/state';
import type { GitErrorCode, Sha } from '../../types';
import type { OpContext } from '../queue';
import type { OpResult } from '../types';
import { opPaths, overwriteMessage, requireIdle, requireResolved } from './history-util';
import { assertSafeName, define, fail, git, plural, withConflictFiles } from './util';

export interface SequencerOutcome {
  head: Sha | null;
  /** Commits applied, in the order they were applied. */
  applied: Sha[];
}

type Kind = 'cherry-pick' | 'revert';
const CONFLICT: Record<Kind, GitErrorCode> = {
  'cherry-pick': 'CherryPickConflict',
  revert: 'RevertConflict',
};

async function resolveShas(ctx: OpContext, shas: Sha[]): Promise<Sha[]> {
  if (!shas.length) throw fail('Unknown', 'No commits selected.');
  const out: Sha[] = [];
  for (const s of shas) {
    assertSafeName(s, 'commit');
    const full = await ctx.service.revParse(s);
    if (!full) throw fail('Unknown', `Unknown commit "${s}".`);
    out.push(full);
  }
  return out;
}

/**
 * Cherry-pick (oldest → newest, topologically sorted) or revert (newest → oldest) (spec 05 §6.9). Conflicts
 * stop the sequencer and surface as CherryPickConflict / RevertConflict with `details.files`.
 */
async function apply(
  ctx: OpContext,
  kind: Kind,
  op: { shas: Sha[]; noCommit?: boolean; mainline?: number },
): Promise<Omit<OpResult<SequencerOutcome>, 'opId'>> {
  const svc = ctx.service;
  await requireIdle(ctx, kind === 'cherry-pick' ? 'cherry-pick' : 'revert');
  const sorted = await topoSort(svc, await resolveShas(ctx, op.shas));
  const order = kind === 'cherry-pick' ? sorted : [...sorted].reverse();
  const args: string[] = [kind];
  if (kind === 'revert') args.push('--no-edit');
  if (op.noCommit) args.push('--no-commit');
  if (op.mainline !== undefined) {
    if (!Number.isInteger(op.mainline) || op.mainline < 1)
      throw fail('Unknown', 'Invalid mainline parent number.');
    args.push('-m', String(op.mainline));
  }
  args.push(...order);
  try {
    await git(ctx, args);
  } catch (e) {
    await svc.refreshRepoInfo();
    return withConflictFiles(svc, e, CONFLICT[kind]);
  }
  const head = await svc.revParse('HEAD');
  await svc.refreshRepoInfo();
  const what = kind === 'cherry-pick' ? 'Cherry-picked' : 'Reverted';
  return {
    summary: `${what} ${order.length === 1 ? order[0]!.slice(0, 7) : plural(order.length, 'commit')}${op.noCommit ? ' (staged)' : ''}`,
    data: { head, applied: order },
  };
}

/** Which sequencer operation is in progress (CHERRY_PICK_HEAD / REVERT_HEAD / sequencer/todo). */
async function current(ctx: OpContext): Promise<Kind> {
  const info = await ctx.service.refreshRepoInfo();
  if (info.state === 'cherry-picking') return 'cherry-pick';
  if (info.state === 'reverting') return 'revert';
  const seq = sequencerTodo(await opPaths(ctx.service));
  if (seq.verb) return seq.verb;
  throw fail('Unknown', 'There is no cherry-pick or revert in progress.');
}

async function seqContinue(
  ctx: OpContext,
  message?: string,
): Promise<Omit<OpResult<SequencerOutcome>, 'opId'>> {
  const svc = ctx.service;
  const kind = await current(ctx);
  await requireResolved(svc, CONFLICT[kind]);
  if (message?.trim()) overwriteMessage(message, [(await opPaths(svc)).MERGE_MSG]);
  try {
    await git(ctx, [kind, '--continue']);
  } catch (e) {
    await svc.refreshRepoInfo();
    return withConflictFiles(svc, e, CONFLICT[kind]);
  }
  const head = await svc.revParse('HEAD');
  await svc.refreshRepoInfo();
  return {
    summary: `${kind === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} complete`,
    data: { head, applied: [] },
  };
}

async function seqSkip(ctx: OpContext): Promise<Omit<OpResult<SequencerOutcome>, 'opId'>> {
  const svc = ctx.service;
  const kind = await current(ctx);
  try {
    await git(ctx, [kind, '--skip']);
  } catch (e) {
    await svc.refreshRepoInfo();
    return withConflictFiles(svc, e, CONFLICT[kind]);
  }
  const head = await svc.revParse('HEAD');
  await svc.refreshRepoInfo();
  return { summary: 'Skipped commit', data: { head, applied: [] } };
}

async function seqAbort(ctx: OpContext): Promise<Omit<OpResult, 'opId'>> {
  const kind = await current(ctx);
  await git(ctx, [kind, '--abort']);
  await ctx.service.refreshRepoInfo();
  return { summary: `${kind === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} aborted` };
}

const TOUCHES: ('status' | 'refs' | 'graph' | 'repoState' | 'conflicts')[] = [
  'status',
  'refs',
  'graph',
  'repoState',
  'conflicts',
];

const n = (shas: Sha[]): string => (shas.length === 1 ? shas[0]!.slice(0, 7) : plural(shas.length, 'commit'));

export const sequencerOps = {
  'cherryPick.run': define(
    'cherryPick.run',
    { label: (op) => `Cherry-pick ${n(op.shas)}`, touches: TOUCHES, undoable: true, cancellable: false },
    (ctx, op) => apply(ctx, 'cherry-pick', op),
  ),
  'revert.run': define(
    'revert.run',
    { label: (op) => `Revert ${n(op.shas)}`, touches: TOUCHES, undoable: true, cancellable: false },
    (ctx, op) => apply(ctx, 'revert', op),
  ),
  'sequencer.continue': define(
    'sequencer.continue',
    { label: () => 'Continue', touches: TOUCHES, cancellable: false },
    (ctx, op) => seqContinue(ctx, op.message),
  ),
  'sequencer.skip': define(
    'sequencer.skip',
    { label: () => 'Skip commit', touches: TOUCHES, cancellable: false },
    (ctx) => seqSkip(ctx),
  ),
  'sequencer.abort': define(
    'sequencer.abort',
    { label: () => 'Abort', touches: TOUCHES, cancellable: false },
    (ctx) => seqAbort(ctx),
  ),
};
