import { GitError } from '../../errors/classify';
import type { OpContext } from '../queue';
import type { OpResult } from '../types';
import { assertSafeName, define, fail, git, read } from './util';

type Result = Promise<Omit<OpResult, 'opId'>>;

function assertUrl(url: string): void {
  if (!url.trim() || /[\0\r\n]/.test(url)) assertSafeName('', 'remote URL');
}

/** Allowed custom fetch flags for a shallow repo's new remote (spec 09 §6.1). */
const SHALLOW_FLAG = /^(?:--no-tags|--single-branch|--filter=[A-Za-z0-9:._+-]+)$/;

/** `git fetch` flags for the first fetch of a remote added to a shallow repo. Throws on unsafe input. */
export function shallowFetchArgs(
  s: { depth?: number; since?: string; extraArgs?: string[] } | undefined,
): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.depth !== undefined) {
    if (!Number.isInteger(s.depth) || s.depth < 1) throw fail('Unknown', 'Depth must be a positive integer.');
    out.push(`--depth=${s.depth}`);
  }
  if (s.since) {
    if (!/^[0-9A-Za-z :.+-]{1,40}$/.test(s.since)) throw fail('Unknown', `Invalid date: "${s.since}".`);
    out.push(`--shallow-since=${s.since}`);
  }
  for (const a of s.extraArgs ?? []) {
    if (!SHALLOW_FLAG.test(a)) throw fail('Unknown', `Fetch flag not allowed: "${a}".`);
    out.push(a);
  }
  return out;
}

async function addRemote(
  ctx: OpContext,
  op: {
    name: string;
    fetchUrl: string;
    pushUrl?: string;
    fetchAfter?: boolean;
    shallow?: { depth?: number; since?: string; extraArgs?: string[] };
  },
): Result {
  const shallowArgs = shallowFetchArgs(op.shallow);
  assertSafeName(op.name, 'remote name');
  assertUrl(op.fetchUrl);
  const ok = await read(ctx.service, ['check-ref-format', `refs/remotes/${op.name}/x`], {
    expectedExitCodes: [0, 1, 128],
  });
  if (ok.exitCode !== 0) assertSafeName('', 'remote name');
  await git(ctx, ['remote', 'add', '--', op.name, op.fetchUrl]);
  if (op.pushUrl) {
    assertUrl(op.pushUrl);
    await git(ctx, ['remote', 'set-url', '--push', '--', op.name, op.pushUrl]);
  }
  const warnings: string[] = [];
  if (op.fetchAfter !== false) {
    try {
      await git(ctx, ['fetch', '--progress', ...shallowArgs, '--', op.name], { network: 'fetch' });
    } catch (e) {
      if (e instanceof GitError && e.code === 'Cancelled') throw e;
      // the remote stays added; the fetch failure is reported, not fatal (spec 09 §6.1)
      warnings.push(
        `Added ${op.name}, but fetching it failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { summary: `Added remote ${op.name}`, ...(warnings.length ? { warnings } : {}) };
}

async function editRemote(
  ctx: OpContext,
  op: { name: string; newName?: string; fetchUrl?: string; pushUrl?: string | null },
): Result {
  assertSafeName(op.name, 'remote name');
  let name = op.name;
  if (op.newName && op.newName !== op.name) {
    assertSafeName(op.newName, 'remote name');
    // No `--` (old git's `remote rename` takes exactly two arguments); both names passed assertSafeName.
    await git(ctx, ['remote', 'rename', op.name, op.newName]);
    name = op.newName;
  }
  if (op.fetchUrl !== undefined) {
    assertUrl(op.fetchUrl);
    await git(ctx, ['remote', 'set-url', '--', name, op.fetchUrl]);
  }
  if (op.pushUrl === null) {
    await git(ctx, ['config', '--unset-all', `remote.${name}.pushurl`], { expectedExitCodes: [0, 5] });
  } else if (op.pushUrl !== undefined) {
    assertUrl(op.pushUrl);
    await git(ctx, ['config', '--unset-all', `remote.${name}.pushurl`], { expectedExitCodes: [0, 5] });
    await git(ctx, ['remote', 'set-url', '--push', '--', name, op.pushUrl]);
  }
  return { summary: `Updated remote ${name}` };
}

async function removeRemote(ctx: OpContext, name: string): Result {
  assertSafeName(name, 'remote name');
  // No `--`: before git 2.41 `remote remove` takes exactly one argument and prints usage for `-- <name>`.
  // assertSafeName already rules out a name that could be read as an option.
  await git(ctx, ['remote', 'remove', name]);
  return { summary: `Removed remote ${name}` };
}

const TOUCHES: ['remotes', 'refs', 'graph', 'config'] = ['remotes', 'refs', 'graph', 'config'];

export const remoteOps = {
  'remote.add': define(
    'remote.add',
    { label: (op) => `Add remote ${op.name}`, touches: TOUCHES, network: true },
    (ctx, op) => addRemote(ctx, op),
  ),
  'remote.edit': define(
    'remote.edit',
    { label: (op) => `Edit remote ${op.name}`, touches: TOUCHES },
    (ctx, op) => editRemote(ctx, op),
  ),
  'remote.remove': define(
    'remote.remove',
    { label: (op) => `Remove remote ${op.name}`, touches: TOUCHES, undoable: true },
    (ctx, op) => removeRemote(ctx, op.name),
  ),
};
