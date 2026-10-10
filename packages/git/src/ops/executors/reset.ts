import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { assertSafeName, define, fail, git } from './util';

/** `git reset --soft|--mixed|--hard <target>` on HEAD (spec 05 §6.9). */
async function reset(ctx: OpContext, op: OpOf<'reset.run'>): Promise<Omit<OpResult<{ head: Sha }>, 'opId'>> {
  assertSafeName(op.target, 'reset target');
  if (!['soft', 'mixed', 'hard'].includes(op.mode)) throw fail('Unknown', `Invalid reset mode "${op.mode}".`);
  const svc = ctx.service;
  const info = await svc.refreshRepoInfo();
  if (!info.head.sha) throw fail('UnbornBranch');
  if (svc.repo.isBare && op.mode !== 'soft')
    throw fail('Unknown', 'A bare repository only supports a soft reset.');
  const sha = await svc.revParse(op.target);
  if (!sha) throw fail('Unknown', `Unknown revision "${op.target}".`);
  await git(ctx, ['reset', `--${op.mode}`, '-q', sha]);
  await svc.refreshRepoInfo();
  const name = info.head.kind === 'branch' ? info.head.name : 'HEAD';
  return { summary: `Reset ${name} to ${sha.slice(0, 7)} (${op.mode})`, data: { head: sha } };
}

export const resetOps = {
  'reset.run': define(
    'reset.run',
    {
      label: (op) => `Reset to ${op.target.slice(0, 7)} (${op.mode})`,
      touches: ['status', 'refs', 'graph', 'repoState', 'conflicts'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => reset(ctx, op),
  ),
};
