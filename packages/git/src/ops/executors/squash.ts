import { rebaseTodoFor, topoSort } from '../../service/phase3/history';
import type { Sha, TodoItem } from '../../types';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { requireIdle } from './history-util';
import { rebaseOps } from './rebase';
import { assertSafeName, define, fail, git, plural, read } from './util';

export interface SquashOutcome {
  /** The new (squashed) commit. */
  sha: Sha | null;
  head: Sha | null;
  /** `fast` = reset --soft + commit; `rebase` = interactive rebase (commits above the range were replayed). */
  path: 'fast' | 'rebase';
}

export interface SquashPlan {
  /** Selected commits, oldest first. */
  order: Sha[];
  /** Parent of the oldest commit (the rebase upstream). */
  base: Sha;
  /** The newest selected commit is HEAD. */
  atHead: boolean;
}

/**
 * Validate a squash selection (spec 05 §4.2 "Squash N commits (contiguous, on H's first-parent line)"): at least two
 * commits, no merges, not the root commit, forming one contiguous block of HEAD's first-parent history.
 */
export async function planSquash(ctx: OpContext, shas: Sha[]): Promise<SquashPlan> {
  const svc = ctx.service;
  if (shas.length < 2) throw fail('Unknown', 'Select at least two commits to squash.');
  const full: Sha[] = [];
  for (const s of shas) {
    assertSafeName(s, 'commit');
    const sha = await svc.revParse(`${s}^{commit}`);
    if (!sha) throw fail('Unknown', `Unknown commit "${s}".`);
    full.push(sha);
  }
  const order = await topoSort(svc, full);
  const oldest = order[0]!;
  const parents = (await read(svc, ['rev-list', '--parents', '-n', '1', oldest, '--'])).stdout
    .trim()
    .split(/\s+/);
  if (parents.length < 2) throw fail('Unknown', 'The root commit cannot be squashed.');
  if (parents.length > 2) throw fail('Unknown', 'Merge commits cannot be squashed.');
  const base = parents[1]!;
  // HEAD's first-parent line from the base, newest first
  const line = (await read(svc, ['rev-list', '--first-parent', '--parents', `${base}..HEAD`, '--'])).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/));
  const chain = line.map((p) => p[0]!);
  const selected = new Set(order);
  const idx = chain.map((s, i) => (selected.has(s) ? i : -1)).filter((i) => i >= 0);
  if (idx.length !== selected.size) {
    throw fail('Unknown', 'Only commits on the current branch (its first-parent line) can be squashed.');
  }
  // the block must end at the base: the last entries of `chain`, consecutive
  const first = idx[0]!;
  if (idx.some((v, k) => v !== first + k) || idx.at(-1) !== chain.length - 1) {
    throw fail('Unknown', 'The selected commits must be contiguous.');
  }
  for (const p of line.slice(first)) {
    if (p.length > 2) throw fail('Unknown', 'Merge commits cannot be squashed.');
  }
  return { order, base, atHead: first === 0 };
}

async function squash(
  ctx: OpContext,
  op: OpOf<'squash.run'>,
): Promise<Omit<OpResult<SquashOutcome>, 'opId'>> {
  const svc = ctx.service;
  if (!op.message.trim()) throw fail('EmptyCommitMessage', 'The commit message is empty.');
  const info = await requireIdle(ctx, 'squash commits');
  const plan = await planSquash(ctx, op.shas);
  const n = plan.order.length;
  const name = info.head.kind === 'branch' ? info.head.name : 'HEAD';
  const staged = (await read(svc, ['diff', '--cached', '--quiet'], { expectedExitCodes: [0, 1] })).exitCode;

  if (plan.atHead && staged === 0) {
    // fast path (spec 05 §6.9): reset --soft to the base, re-commit with the oldest commit's author/date
    const head = info.head.sha!;
    const oldest = plan.order[0]!;
    await git(ctx, ['reset', '--soft', '-q', plan.base]);
    try {
      await git(ctx, ['commit', '-q', '--no-verify', '--allow-empty', '-C', oldest]);
      await git(
        ctx,
        ['commit', '-q', '--amend', '--no-verify', '--allow-empty', '-F', '-', '--cleanup=strip'],
        {
          stdin: Buffer.from(op.message.endsWith('\n') ? op.message : `${op.message}\n`, 'utf8'),
        },
      );
    } catch (e) {
      // put the branch back where it was (index still holds the squashed tree = HEAD's tree)
      await git(ctx, ['reset', '--soft', '-q', head]).catch(() => undefined);
      throw e;
    }
    const sha = await svc.revParse('HEAD');
    await svc.refreshRepoInfo();
    return { summary: `Squashed ${plural(n, 'commit')} on ${name}`, data: { sha, head: sha, path: 'fast' } };
  }

  // general path: interactive rebase of base..HEAD with the selection squashed into the oldest commit
  const range = await rebaseTodoFor(svc, plan.base, 'HEAD');
  const selected = new Set(plan.order);
  const oldest = plan.order[0]!;
  const todo: TodoItem[] = range.map((t) => ({
    ...t,
    action: t.sha === oldest ? 'pick' : selected.has(t.sha) ? 'squash' : 'pick',
  }));
  await rebaseOps['rebase.interactive'].execute(ctx, {
    type: 'rebase.interactive',
    onto: plan.base,
    upstream: plan.base,
    todo,
    squashMessages: { [oldest]: op.message },
  });
  const head = await svc.revParse('HEAD');
  // the squashed commit sits where the oldest one was: base + 1 on the first-parent line
  const above = range.length - range.findIndex((t) => t.sha === oldest) - n;
  const sha = await svc.revParse(above > 0 ? `HEAD~${above}` : 'HEAD');
  await svc.refreshRepoInfo();
  return { summary: `Squashed ${plural(n, 'commit')} on ${name}`, data: { sha, head, path: 'rebase' } };
}

export const squashOps = {
  'squash.run': define(
    'squash.run',
    {
      label: (op) => `Squash ${plural(op.shas.length, 'commit')}`,
      touches: ['status', 'refs', 'graph', 'repoState', 'conflicts', 'stash'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => squash(ctx, op),
  ),
};
