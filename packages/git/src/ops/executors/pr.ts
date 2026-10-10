import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { assertSafeName, define, fail, git, read } from './util';

/**
 * Check out a pull request locally (spec 10 §6.3).
 * - Same-repo PR: fetch `<remote> <headBranch>` and create a tracking branch.
 * - Fork PR: fetch the provider's PR ref (`refs/pull/{n}/head` …) or, when the provider
 *   has none, the fork's clone URL, into `refs/heads/<localBranch>`.
 * An existing local branch is fast-forwarded when possible, never rewritten.
 * Modes: `branch` (default), `worktree` (branch checked out in a new worktree), `fetch` (refs only).
 */
async function checkoutPr(
  ctx: OpContext,
  op: OpOf<'pr.checkout'>,
): Promise<Omit<OpResult<{ branch: string; ref?: string; path?: string }>, 'opId'>> {
  const mode = op.mode ?? 'branch';
  assertSafeName(op.remote, 'remote');
  assertSafeName(op.localBranch, 'branch');
  assertSafeName(op.headBranch, 'branch');
  if (op.baseBranch) assertSafeName(op.baseBranch, 'branch');
  if (mode === 'fetch') return fetchPr(ctx, op);
  if (mode === 'worktree' && !op.worktreePath) throw fail('Unknown', 'A worktree path is required.');
  const exists = await read(ctx.service, ['rev-parse', '--verify', '-q', `refs/heads/${op.localBranch}`], {
    expectedExitCodes: [0, 1],
  });
  const localExists = exists.exitCode === 0;

  let sourceRef: string;
  if (op.sameRepo) {
    await git(
      ctx,
      [
        'fetch',
        '--progress',
        '--',
        op.remote,
        `+refs/heads/${op.headBranch}:refs/remotes/${op.remote}/${op.headBranch}`,
      ],
      {
        network: 'fetch',
      },
    );
    sourceRef = `refs/remotes/${op.remote}/${op.headBranch}`;
  } else {
    const prRef = op.refspec?.replace('{n}', String(op.number));
    const from = prRef ? op.remote : op.headCloneUrl;
    const what = prRef ?? `refs/heads/${op.headBranch}`;
    if (!from) throw fail('Unknown', 'This pull request comes from a fork that can no longer be fetched.');
    const tmp = `refs/githappens/pr/${op.number}`;
    await git(ctx, ['fetch', '--progress', '--', from, `+${what}:${tmp}`], { network: 'fetch' });
    sourceRef = tmp;
  }

  if (localExists) {
    if (mode === 'worktree') {
      const wt = await read(ctx.service, ['worktree', 'list', '--porcelain']);
      if (wt.stdout.split(/\r?\n/).includes(`branch refs/heads/${op.localBranch}`)) {
        throw fail('Unknown', `${op.localBranch} is already checked out in another worktree.`);
      }
    }
    // Only move an existing branch forward; never discard local commits.
    const ff = await read(
      ctx.service,
      ['merge-base', '--is-ancestor', `refs/heads/${op.localBranch}`, sourceRef],
      {
        expectedExitCodes: [0, 1],
      },
    );
    if (ff.exitCode !== 0) {
      throw fail(
        'NotFastForwardable',
        `Local branch ${op.localBranch} has diverged from the pull request; check it out and pull manually.`,
      );
    }
    const head = await read(ctx.service, ['symbolic-ref', '-q', '--short', 'HEAD'], {
      expectedExitCodes: [0, 1],
    });
    if (head.stdout.trim() === op.localBranch) await git(ctx, ['merge', '--ff-only', '--quiet', sourceRef]);
    else await git(ctx, ['update-ref', `refs/heads/${op.localBranch}`, sourceRef]);
  } else {
    await git(ctx, ['branch', '--no-track', '--', op.localBranch, sourceRef]);
  }
  if (op.sameRepo) {
    await git(ctx, ['branch', `--set-upstream-to=${op.remote}/${op.headBranch}`, '--', op.localBranch]);
  }
  if (mode === 'worktree') {
    await git(ctx, ['worktree', 'add', '--', op.worktreePath!, op.localBranch]);
    return {
      summary: `Checked out PR #${op.number} in a new worktree`,
      data: { branch: op.localBranch, path: op.worktreePath },
    };
  }
  if (op.checkout) await git(ctx, ['checkout', '--quiet', op.localBranch, '--']);
  return { summary: `Checked out PR #${op.number} as ${op.localBranch}`, data: { branch: op.localBranch } };
}

/** Fetch-only: PR head into `refs/githappens/pr/{n}` (plus the base branch) for local commits/diff views. */
async function fetchPr(
  ctx: OpContext,
  op: OpOf<'pr.checkout'>,
): Promise<Omit<OpResult<{ branch: string; ref: string }>, 'opId'>> {
  const tmp = `refs/githappens/pr/${op.number}`;
  const prRef = op.refspec?.replace('{n}', String(op.number));
  const what = op.sameRepo || !prRef ? `refs/heads/${op.headBranch}` : prRef;
  const from = op.sameRepo || prRef ? op.remote : op.headCloneUrl;
  if (!from) throw fail('Unknown', 'This pull request comes from a fork that can no longer be fetched.');
  const base = op.baseBranch
    ? [`+refs/heads/${op.baseBranch}:refs/remotes/${op.remote}/${op.baseBranch}`]
    : [];
  if (from === op.remote) {
    await git(ctx, ['fetch', '--progress', '--', op.remote, `+${what}:${tmp}`, ...base], {
      network: 'fetch',
    });
  } else {
    await git(ctx, ['fetch', '--progress', '--', from, `+${what}:${tmp}`], { network: 'fetch' });
    if (base.length) await git(ctx, ['fetch', '--progress', '--', op.remote, ...base], { network: 'fetch' });
  }
  return { summary: `Fetched PR #${op.number}`, data: { branch: op.localBranch, ref: tmp } };
}

export const prOps = {
  'pr.checkout': define(
    'pr.checkout',
    {
      label: (op) => `Check out pull request #${op.number}`,
      touches: ['refs', 'graph', 'status', 'repoState'],
      network: true,
    },
    (ctx, op) => checkoutPr(ctx, op),
  ),
};
