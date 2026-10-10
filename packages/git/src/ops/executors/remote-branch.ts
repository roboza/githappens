import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { validateBranchName } from './branch';
import { parsePorcelainPush, pushOrThrow } from './sync';
import { assertSafeName, define, fail, git, read } from './util';

/**
 * Rename a branch on a remote (spec 05 §6.1, opt-in remote rename):
 * `git push <r> refs/remotes/<r>/<from>:refs/heads/<to>` → `git push <r> --delete <from>` →
 * `git branch --set-upstream-to=<r>/<to>` for every local branch that tracked `<r>/<from>`.
 */
async function renameRemote(
  ctx: OpContext,
  op: OpOf<'branch.renameRemote'>,
): Promise<Omit<OpResult<{ relinked: string[] }>, 'opId'>> {
  assertSafeName(op.remote, 'remote');
  assertSafeName(op.from, 'branch name');
  const v = await validateBranchName(ctx.service, op.to);
  if (!v.valid) throw fail('InvalidRefName', v.reason);
  if (op.from === op.to) throw fail('Unknown', 'Choose a different name.');
  if (op.localBranch) assertSafeName(op.localBranch, 'branch name');
  const svc = ctx.service;
  const trackingRef = `refs/remotes/${op.remote}/${op.from}`;
  const fromSha = await svc.revParse(trackingRef);
  if (!fromSha) {
    throw fail('Unknown', `${op.remote}/${op.from} does not exist; fetch and try again.`);
  }
  if (await svc.revParse(`refs/remotes/${op.remote}/${op.to}`)) {
    throw fail('Unknown', `${op.remote}/${op.to} already exists.`);
  }
  // local branches tracking the old name
  const fer = await read(svc, ['for-each-ref', '--format=%(refname:short)%00%(upstream)', 'refs/heads']);
  const tracking = fer.stdout
    .split('\n')
    .map((l) => l.split('\0'))
    .filter(([, up]) => up === trackingRef)
    .map(([name]) => name!)
    .filter(Boolean);
  if (op.localBranch && !tracking.includes(op.localBranch)) tracking.push(op.localBranch);

  const pushArgs = [
    'push',
    '--porcelain',
    '--progress',
    '--',
    op.remote,
    `${trackingRef}:refs/heads/${op.to}`,
  ];
  const r1 = await git(ctx, pushArgs, { network: 'push', expectedExitCodes: [0, 1] });
  pushOrThrow(pushArgs, r1, parsePorcelainPush(r1.stdout), ctx.opId);

  const delArgs = ['push', '--porcelain', '--progress', '--delete', '--', op.remote, `refs/heads/${op.from}`];
  const r2 = await git(ctx, delArgs, { network: 'push', expectedExitCodes: [0, 1] });
  pushOrThrow(delArgs, r2, parsePorcelainPush(r2.stdout), ctx.opId);

  const newTracking = `refs/remotes/${op.remote}/${op.to}`;
  if (!(await svc.revParse(newTracking))) {
    // no fetch refspec mapping the remote (push didn't update a tracking ref): create it from the pushed sha
    await git(ctx, ['update-ref', newTracking, fromSha]);
  }
  const relinked: string[] = [];
  for (const b of tracking) {
    await git(ctx, ['config', `branch.${b}.remote`, op.remote]);
    await git(ctx, ['config', `branch.${b}.merge`, `refs/heads/${op.to}`]);
    relinked.push(b);
  }
  return {
    summary: `Renamed ${op.remote}/${op.from} to ${op.remote}/${op.to}`,
    data: { relinked },
  };
}

export const remoteBranchOps = {
  'branch.renameRemote': define(
    'branch.renameRemote',
    {
      label: (op) => `Rename ${op.remote}/${op.from} to ${op.to}`,
      touches: ['refs', 'graph', 'config', 'remotes'],
      network: true,
    },
    (ctx, op) => renameRemote(ctx, op),
  ),
};
