import { EMPTY_TREE_SHA1, type GitService } from '../../service/git-service';
import { batchPathspec } from '../../service/pathspec';
import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { CheckoutPreflight, CheckoutTarget, DirtyStrategy, OpResult } from '../types';
import { assertSafeName, define, fail, git, read } from './util';

export interface CheckoutOutcome {
  /** HEAD after the checkout: branch name, or null when detached. */
  branch: string | null;
  sha: Sha | null;
  /** Autostash created by the 'stash' strategy (spec 05 §4.5: the UI offers "Pop stash now?"). */
  stashSha?: Sha;
  /** Local branch fast-forwarded to its remote counterpart. */
  fastForwarded?: boolean;
}

export function targetLabel(t: CheckoutTarget): string {
  switch (t.kind) {
    case 'branch':
      return t.name;
    case 'remoteBranch':
      return `${t.remote}/${t.name}`;
    case 'commit':
      return t.sha.slice(0, 7);
    case 'tag':
      return t.name;
  }
}

function targetRev(t: CheckoutTarget): string {
  switch (t.kind) {
    case 'branch':
      return `refs/heads/${t.name}`;
    case 'remoteBranch':
      return `refs/remotes/${t.remote}/${t.name}`;
    case 'commit':
      return t.sha;
    case 'tag':
      return `refs/tags/${t.name}`;
  }
}

function validateTarget(t: CheckoutTarget): void {
  if (t.kind === 'commit') assertSafeName(t.sha, 'commit');
  else assertSafeName(t.name, t.kind === 'tag' ? 'tag' : 'branch name');
  if (t.kind === 'remoteBranch') {
    assertSafeName(t.remote, 'remote');
    if (t.localName !== undefined) assertSafeName(t.localName, 'branch name');
  }
}

async function relation(
  service: GitService,
  local: Sha,
  remote: Sha,
): Promise<'same' | 'behind' | 'ahead' | 'diverged' | 'unrelated'> {
  if (local === remote) return 'same';
  const isAnc = async (a: Sha, b: Sha): Promise<boolean> =>
    (await read(service, ['merge-base', '--is-ancestor', a, b], { expectedExitCodes: [0, 1] })).exitCode ===
    0;
  if (await isAnc(local, remote)) return 'behind';
  if (await isAnc(remote, local)) return 'ahead';
  const mb = await read(service, ['merge-base', local, remote], { expectedExitCodes: [0, 1] });
  return mb.exitCode === 0 && mb.stdout.trim() ? 'diverged' : 'unrelated';
}

/** spec 05 §6.3 `checkout:preflight`. */
export async function checkoutPreflight(
  service: GitService,
  target: CheckoutTarget,
): Promise<CheckoutPreflight> {
  validateTarget(target);
  const targetSha = await service.revParse(targetRev(target));
  if (!targetSha) throw fail('Unknown', `"${targetLabel(target)}" does not exist.`);
  const status = await service.status({ untracked: 'all' });
  const entries = status.entries.filter((e) => e.kind !== 'ignored');
  const result: CheckoutPreflight = { dirty: entries.length > 0, blockingPaths: [] };

  if (entries.length) {
    const headSha = await service.revParse('HEAD');
    const diff = await read(service, [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      headSha ?? EMPTY_TREE_SHA1,
      targetSha,
      '--',
    ]);
    const changed = new Set(diff.stdout.split('\0').filter(Boolean));
    const blocking = new Set<string>();
    const untracked: string[] = [];
    for (const e of entries) {
      if (e.kind === 'untracked') untracked.push(e.path);
      else {
        if (changed.has(e.path)) blocking.add(e.path);
        if (e.kind === 'renamed' && changed.has(e.origPath)) blocking.add(e.origPath);
      }
    }
    for (const b of batchPathspec(['ls-tree', '-r', '--name-only', '-z', targetSha], untracked)) {
      const r = await read(service, b.args, { env: b.env });
      for (const p of r.stdout.split('\0').filter(Boolean)) blocking.add(p);
    }
    result.blockingPaths = [...blocking].sort();
  }

  if (target.kind === 'remoteBranch') {
    const local = target.localName ?? target.name;
    const localSha = await service.revParse(`refs/heads/${local}`);
    if (localSha) {
      const up = (
        await read(service, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${local}`])
      ).stdout.trim();
      result.localExists = {
        name: local,
        ...(up ? { upstream: up } : {}),
        relation: await relation(service, localSha, targetSha),
      };
    }
  }
  return result;
}

async function switchTo(
  ctx: OpContext,
  t: CheckoutTarget,
  discard: boolean,
): Promise<{ fastForwarded: boolean }> {
  const force = discard ? ['--discard-changes'] : [];
  switch (t.kind) {
    case 'branch':
      await git(ctx, ['switch', ...force, '--', t.name]);
      return { fastForwarded: false };
    case 'commit':
      await git(ctx, ['switch', ...force, '--detach', t.sha]);
      return { fastForwarded: false };
    case 'tag':
      await git(ctx, ['switch', ...force, '--detach', `refs/tags/${t.name}^{commit}`]);
      return { fastForwarded: false };
    case 'remoteBranch': {
      const local = t.localName ?? t.name;
      const remoteRef = `refs/remotes/${t.remote}/${t.name}`;
      const localSha = await ctx.service.revParse(`refs/heads/${local}`);
      if (!localSha) {
        await git(ctx, ['switch', ...force, '-c', local, '--track', `${t.remote}/${t.name}`]);
        return { fastForwarded: false };
      }
      await git(ctx, ['switch', ...force, '--', local]);
      const remoteSha = await ctx.service.revParse(remoteRef);
      if (t.onExisting === 'reset' && remoteSha && remoteSha !== localSha) {
        // RemoteCheckoutConflictDialog "Reset local to remote" (spec 05 §4.5); --keep never clobbers local changes
        await git(ctx, ['reset', '--keep', '-q', remoteSha]);
        return { fastForwarded: false };
      }
      if (remoteSha && (await relation(ctx.service, localSha, remoteSha)) === 'behind') {
        await git(ctx, ['merge', '--ff-only', '-q', remoteRef]);
        return { fastForwarded: true };
      }
      return { fastForwarded: false };
    }
  }
}

async function runCheckout(
  ctx: OpContext,
  target: CheckoutTarget,
  strategy: DirtyStrategy,
): Promise<Omit<OpResult<CheckoutOutcome>, 'opId'>> {
  validateTarget(target);
  const svc = ctx.service;
  const label = targetLabel(target);
  let stashSha: Sha | undefined;
  let ff: { fastForwarded: boolean };

  if (strategy === 'stash') {
    const status = await svc.status({ untracked: 'all' });
    if (status.entries.some((e) => e.kind !== 'ignored')) {
      const before = await svc.revParse('refs/stash');
      await git(ctx, ['stash', 'push', '--include-untracked', '-m', `autostash: before checkout ${label}`]);
      const after = await svc.revParse('refs/stash');
      if (after && after !== before) stashSha = after;
    }
    try {
      ff = await switchTo(ctx, target, false);
    } catch (e) {
      // put the changes back where they were
      if (stashSha) await git(ctx, ['stash', 'pop', '--index', '-q']).catch(() => undefined);
      throw e;
    }
  } else if (strategy === 'discard') {
    const pre = await checkoutPreflight(svc, target);
    const status = await svc.status({ untracked: 'all' });
    const untracked = new Set(status.entries.filter((e) => e.kind === 'untracked').map((e) => e.path));
    const blockingUntracked = pre.blockingPaths.filter((p) => untracked.has(p));
    for (const b of batchPathspec(['clean', '-f', '-q'], blockingUntracked))
      await git(ctx, b.args, { env: b.env });
    ff = await switchTo(ctx, target, true);
  } else {
    ff = await switchTo(ctx, target, false);
  }

  const info = await svc.refreshRepoInfo();
  const data: CheckoutOutcome = {
    branch: info.head.kind === 'branch' ? info.head.name : null,
    sha: info.head.sha,
    ...(stashSha ? { stashSha } : {}),
    ...(ff.fastForwarded ? { fastForwarded: true } : {}),
  };
  return { summary: `Checked out ${label}`, data };
}

export const checkoutOps = {
  'checkout.run': define(
    'checkout.run',
    {
      label: (op) => `Checkout ${targetLabel(op.target)}`,
      touches: ['status', 'refs', 'graph', 'stash', 'repoState'],
      undoable: true,
    },
    (ctx, op) => runCheckout(ctx, op.target, op.dirtyStrategy),
  ),
};
