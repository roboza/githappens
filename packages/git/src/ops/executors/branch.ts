import type { GitService } from '../../service/git-service';
import type { OpContext } from '../queue';
import type { OpResult } from '../types';
import { assertSafeName, define, fail, git, plural, read, splitRemoteRef } from './util';
import { parsePorcelainPush, pushOrThrow } from './sync';

type Result = Promise<Omit<OpResult, 'opId'>>;

/** `git check-ref-format --branch` (spec 05 §6.1 `branch:validateName`). */
export async function validateBranchName(
  service: GitService,
  name: string,
): Promise<{ valid: boolean; reason?: string }> {
  if (!name.trim()) return { valid: false, reason: 'The name is empty.' };
  if (name.startsWith('-')) return { valid: false, reason: 'A branch name cannot start with "-".' };
  if (/[\0\r\n]/.test(name))
    return { valid: false, reason: 'A branch name cannot contain control characters.' };
  if (name === 'HEAD') return { valid: false, reason: '"HEAD" is not a valid branch name.' };
  const r = await read(service, ['check-ref-format', '--branch', name], { expectedExitCodes: [0, 1, 128] });
  if (r.exitCode !== 0) return { valid: false, reason: `"${name}" is not a valid branch name.` };
  if (r.stdout.trim() !== name) return { valid: false, reason: `"${name}" is not a valid branch name.` };
  return { valid: true };
}

async function createBranch(
  ctx: OpContext,
  op: { name: string; startPoint: string; checkout: boolean; track?: string },
): Result {
  assertSafeName(op.name, 'branch name');
  const start = op.track ?? op.startPoint;
  assertSafeName(start, 'start point');
  const trackArgs = op.track ? ['--track'] : ['--no-track'];
  if (op.checkout) await git(ctx, ['switch', ...trackArgs, '-c', op.name, start]);
  else await git(ctx, ['branch', ...trackArgs, '--', op.name, start]);
  if (op.checkout) await ctx.service.refreshRepoInfo();
  return { summary: `Created branch ${op.name}` };
}

async function renameBranch(ctx: OpContext, from: string, to: string): Result {
  assertSafeName(from, 'branch name');
  assertSafeName(to, 'branch name');
  await git(ctx, ['branch', '-m', '--', from, to]);
  await ctx.service.refreshRepoInfo();
  return { summary: `Renamed ${from} to ${to}` };
}

async function deleteBranches(
  ctx: OpContext,
  branches: { name: string; deleteRemote?: { remote: string; remoteBranch: string } }[],
  force: boolean,
): Result {
  if (!branches.length) return {};
  for (const b of branches) assertSafeName(b.name, 'branch name');
  // chunks keep Windows command lines short (spec 05 §8)
  const names = branches.map((b) => b.name);
  for (let i = 0; i < names.length; i += 200) {
    await git(ctx, ['branch', force ? '-D' : '-d', '--', ...names.slice(i, i + 200)]);
  }
  const byRemote = new Map<string, string[]>();
  for (const b of branches) {
    if (!b.deleteRemote) continue;
    assertSafeName(b.deleteRemote.remote, 'remote');
    const list = byRemote.get(b.deleteRemote.remote) ?? [];
    list.push(`refs/heads/${b.deleteRemote.remoteBranch.replace(/^refs\/heads\//, '')}`);
    byRemote.set(b.deleteRemote.remote, list);
  }
  for (const [remote, refs] of byRemote) {
    const args = ['push', '--porcelain', '--progress', '--delete', '--', remote, ...refs];
    const r = await git(ctx, args, { network: 'push', expectedExitCodes: [0, 1] });
    pushOrThrow(args, r, parsePorcelainPush(r.stdout), ctx.opId);
  }
  return { summary: `Deleted ${plural(names.length, 'branch', 'branches')}` };
}

async function setUpstream(ctx: OpContext, local: string, upstream: string | null): Result {
  assertSafeName(local, 'branch name');
  if (upstream === null) {
    await git(ctx, ['branch', '--unset-upstream', '--', local]);
    return { summary: `Removed upstream of ${local}` };
  }
  assertSafeName(upstream, 'upstream');
  const short = upstream.replace(/^refs\/remotes\//, '');
  const exists = await ctx.service.runRead(['rev-parse', '-q', '--verify', `refs/remotes/${short}`], {
    expectedExitCodes: [0, 1],
  });
  if (exists.exitCode === 0) {
    await git(ctx, ['branch', `--set-upstream-to=refs/remotes/${short}`, '--', local]);
  } else {
    // never pushed yet: write the config directly (spec 09 §6.3)
    const split = await splitRemoteRef(ctx.service, short);
    if (!split) throw fail('RemoteNotFound', `No remote matches "${upstream}".`);
    await git(ctx, ['config', `branch.${local}.remote`, split.remote]);
    await git(ctx, ['config', `branch.${local}.merge`, `refs/heads/${split.branch}`]);
  }
  return { summary: `Set upstream of ${local} to ${short}` };
}

export const branchOps = {
  'branch.create': define(
    'branch.create',
    {
      label: (op) => `Create branch ${op.name}`,
      touches: ['refs', 'graph', 'status', 'repoState'],
      undoable: true,
    },
    (ctx, op) => createBranch(ctx, op),
  ),
  'branch.rename': define(
    'branch.rename',
    {
      label: (op) => `Rename branch ${op.from} to ${op.to}`,
      touches: ['refs', 'graph', 'config'],
      undoable: true,
    },
    (ctx, op) => renameBranch(ctx, op.from, op.to),
  ),
  'branch.delete': define(
    'branch.delete',
    {
      label: (op) =>
        op.branches.length === 1
          ? `Delete branch ${op.branches[0]!.name}`
          : `Delete ${op.branches.length} branches`,
      touches: ['refs', 'graph', 'config'],
      undoable: true,
      network: true,
    },
    (ctx, op) => deleteBranches(ctx, op.branches, op.force),
  ),
  'branch.setUpstream': define(
    'branch.setUpstream',
    {
      label: (op) =>
        op.upstream
          ? `Set upstream of ${op.localBranch} to ${op.upstream}`
          : `Unset upstream of ${op.localBranch}`,
      touches: ['refs', 'config'],
    },
    (ctx, op) => setUpstream(ctx, op.localBranch, op.upstream),
  ),
};
