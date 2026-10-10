import { normalizeSparsePaths, sparseUsesCone } from '../../repo-create/options';
import type { GitService } from '../../service/git-service';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { define, fail, git, plural, read } from './util';

/**
 * Sparse checkout management for existing repos (spec 03 §2 / §7 step 17): `git sparse-checkout
 * set|add|disable|reapply`. Not journaled: these only toggle skip-worktree bits (no refs, commits or
 * index content change), so the undo stack stays valid across them. They are `network` ops because a
 * blobless (promisor) clone fetches missing blobs when the cone grows.
 */

export interface SparseState {
  enabled: boolean;
  cone: boolean;
  /** `git sparse-checkout list` (cone: directories; non-cone: raw patterns). */
  patterns: string[];
  /** Partial clone filter of the origin promisor remote (e.g. `blob:none`). */
  filter?: string;
}

async function configBool(service: GitService, key: string): Promise<boolean | null> {
  const r = await read(service, ['config', '--type=bool', '--get', key], { expectedExitCodes: [0, 1] });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() === 'true';
}

/** Current sparse-checkout state of a worktree (read-only). */
export async function sparseState(service: GitService): Promise<SparseState> {
  if (service.repo.isBare) return { enabled: false, cone: false, patterns: [] };
  const enabled = (await configBool(service, 'core.sparseCheckout')) === true;
  const coneSetting = await configBool(service, 'core.sparseCheckoutCone');
  const filterRes = await read(service, ['config', '--get-regexp', '^remote\\..*\\.partialclonefilter$'], {
    expectedExitCodes: [0, 1],
  });
  const filter = filterRes.stdout.trim().split(/\r?\n/)[0]?.split(/\s+/)[1];
  if (!enabled)
    return { enabled: false, cone: coneSetting !== false, patterns: [], ...(filter ? { filter } : {}) };
  const list = await read(service, ['sparse-checkout', 'list'], { expectedExitCodes: [0, 128] });
  const patterns = list.exitCode === 0 ? list.stdout.split(/\r?\n/).filter((l) => l.length > 0) : [];
  // git ≥ 2.37 defaults to cone mode when core.sparseCheckoutCone is unset
  return { enabled, cone: coneSetting !== false, patterns, ...(filter ? { filter } : {}) };
}

type Result = Promise<Omit<OpResult, 'opId'>>;

function patternsOf(op: { patterns: string[] }): string[] {
  let patterns: string[];
  try {
    patterns = normalizeSparsePaths(op.patterns);
  } catch (e) {
    throw fail('Unknown', (e as Error).message);
  }
  if (!patterns.length) throw fail('Unknown', 'Add at least one path to keep in the sparse checkout.');
  return patterns;
}

async function setPatterns(ctx: OpContext, op: OpOf<'sparse.set'>): Result {
  const patterns = patternsOf(op);
  const cone = op.cone ?? sparseUsesCone(patterns);
  if (cone && !sparseUsesCone(patterns))
    throw fail('Unknown', 'Cone mode only accepts directory paths (no wildcards or leading "/").');
  await git(ctx, ['sparse-checkout', 'set', cone ? '--cone' : '--no-cone', '--', ...patterns], {
    network: 'checkout',
  });
  return {
    summary: `Sparse checkout: ${plural(patterns.length, 'path')}`,
    data: { patterns, cone },
  };
}

async function addPatterns(ctx: OpContext, op: OpOf<'sparse.add'>): Result {
  const patterns = patternsOf(op);
  const state = await sparseState(ctx.service);
  if (!state.enabled) throw fail('Unknown', 'Sparse checkout is not enabled for this repository.');
  if (state.cone && !sparseUsesCone(patterns))
    throw fail('Unknown', 'Cone mode only accepts directory paths (no wildcards or leading "/").');
  await git(ctx, ['sparse-checkout', 'add', '--', ...patterns], { network: 'checkout' });
  return { summary: `Added ${plural(patterns.length, 'path')} to the sparse checkout`, data: { patterns } };
}

async function disable(ctx: OpContext): Result {
  await git(ctx, ['sparse-checkout', 'disable'], { network: 'checkout' });
  return { summary: 'Sparse checkout disabled — all files are checked out' };
}

async function reapply(ctx: OpContext): Result {
  const state = await sparseState(ctx.service);
  if (!state.enabled) throw fail('Unknown', 'Sparse checkout is not enabled for this repository.');
  await git(ctx, ['sparse-checkout', 'reapply'], { network: 'checkout' });
  return { summary: 'Sparse checkout patterns reapplied' };
}

export const sparseOps = {
  'sparse.set': define(
    'sparse.set',
    {
      label: (op) => `Sparse checkout: set ${plural(op.patterns.length, 'path')}`,
      touches: ['status', 'config', 'repoState'],
      network: true,
    },
    (ctx, op) => setPatterns(ctx, op),
  ),
  'sparse.add': define(
    'sparse.add',
    {
      label: (op) => `Sparse checkout: add ${plural(op.patterns.length, 'path')}`,
      touches: ['status', 'config', 'repoState'],
      network: true,
    },
    (ctx, op) => addPatterns(ctx, op),
  ),
  'sparse.disable': define(
    'sparse.disable',
    { label: () => 'Disable sparse checkout', touches: ['status', 'config', 'repoState'], network: true },
    (ctx) => disable(ctx),
  ),
  'sparse.reapply': define(
    'sparse.reapply',
    { label: () => 'Reapply sparse checkout', touches: ['status', 'config', 'repoState'], network: true },
    (ctx) => reapply(ctx),
  ),
};
