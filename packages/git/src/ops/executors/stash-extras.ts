import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { validateBranchName } from './branch';
import { assertSafeName, classified, define, fail, git, read, withConflictFiles } from './util';

/** Stash extras (spec 05 §4.9, §6.10): rename, apply a single file, create a branch from a stash. */

type Result = Promise<Omit<OpResult, 'opId'>>;

interface ListEntry {
  sha: Sha;
  /** Reflog subject ("On main: msg"), re-used by `git stash store -m`. */
  subject: string;
}

async function stashEntries(ctx: OpContext): Promise<ListEntry[]> {
  const r = await read(ctx.service, ['stash', 'list', '--format=%H%x1f%gs']);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('\x1f');
      return { sha: l.slice(0, i), subject: l.slice(i + 1) };
    });
}

/** Current index of the stash `sha`, preferring `index` when it still matches (spec 05 §6.10 drift guard). */
async function locate(ctx: OpContext, index: number, sha: Sha): Promise<{ list: ListEntry[]; n: number }> {
  assertSafeName(sha, 'stash');
  const list = await stashEntries(ctx);
  const n = list[index]?.sha === sha ? index : list.findIndex((e) => e.sha === sha);
  if (n < 0) throw fail('Unknown', 'That stash no longer exists; refresh and try again.');
  return { list, n };
}

/** "On main: old" + "new" → "On main: new" (keeps git's branch prefix). */
export function renamedStashSubject(subject: string, message: string): string {
  const m = /^(?:WIP on|On) ([^:]+): /.exec(subject);
  const msg = message.replace(/[\r\n]+/g, ' ').trim();
  return m ? `On ${m[1]}: ${msg}` : msg;
}

async function rename(ctx: OpContext, op: OpOf<'stash.rename'>): Result {
  if (!op.message.trim()) throw fail('Unknown', 'The stash message is empty.');
  const { list, n } = await locate(ctx, op.index, op.sha);
  // no native rename: drop entries 0..n and store them back newest-last, so the order is preserved
  const rebuilt = list
    .slice(0, n + 1)
    .map((e, i) => (i === n ? { ...e, subject: renamedStashSubject(e.subject, op.message) } : e));
  for (let i = 0; i <= n; i++) await git(ctx, ['stash', 'drop', '-q', 'stash@{0}']);
  const failed: ListEntry[] = [];
  for (let i = rebuilt.length - 1; i >= 0; i--) {
    const e = rebuilt[i]!;
    try {
      await git(ctx, ['stash', 'store', '-q', '-m', e.subject, e.sha]);
    } catch {
      failed.push(e);
    }
  }
  if (failed.length) {
    throw fail(
      'Unknown',
      `Could not restore ${failed.length} stash entr${failed.length === 1 ? 'y' : 'ies'}.`,
      {
        shas: failed.map((f) => f.sha).join(' '),
      },
    );
  }
  return { summary: `Renamed stash@{${n}}` };
}

async function applyFile(ctx: OpContext, op: OpOf<'stash.applyFile'>): Result {
  const { n } = await locate(ctx, op.index, op.sha);
  const p = op.path.replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.split('/').includes('..') || /[\0\r\n]/.test(p)) {
    throw fail('Unknown', `Invalid path "${op.path}".`);
  }
  const has = async (rev: string): Promise<boolean> => {
    const r = await read(ctx.service, ['ls-tree', '--name-only', '-z', rev, '--', p], {
      expectedExitCodes: [0, 128],
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
    return r.exitCode === 0 && r.stdout.split('\0').includes(p);
  };
  // tracked changes live in the stash commit's tree; untracked files in its third parent (stash -u)
  let source: string | null = null;
  if (await has(op.sha)) source = op.sha;
  else if ((await ctx.service.revParse(`${op.sha}^3`)) && (await has(`${op.sha}^3`))) source = `${op.sha}^3`;
  if (!source) throw fail('Unknown', `${p} is not part of stash@{${n}}.`);
  await git(ctx, ['restore', `--source=${source}`, '--worktree', '--', p], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  return { summary: `Applied ${p} from stash@{${n}}` };
}

async function branch(ctx: OpContext, op: OpOf<'stash.branch'>): Result {
  const v = await validateBranchName(ctx.service, op.name);
  if (!v.valid) throw fail('InvalidRefName', v.reason);
  if (await ctx.service.revParse(`refs/heads/${op.name}`)) {
    throw fail('Unknown', `A branch named ${op.name} already exists.`);
  }
  const { n } = await locate(ctx, op.index, op.sha);
  const args = ['stash', 'branch', op.name, `stash@{${n}}`];
  const r = await git(ctx, args, { expectedExitCodes: [0, 1] });
  if (r.exitCode !== 0) {
    await ctx.service.refreshRepoInfo();
    await withConflictFiles(ctx.service, classified(args, r, ctx.opId), 'StashConflict');
  }
  await ctx.service.refreshRepoInfo();
  return { summary: `Created branch ${op.name} from stash@{${n}}` };
}

const TOUCHES: ('stash' | 'status' | 'refs' | 'graph' | 'conflicts' | 'repoState')[] = [
  'stash',
  'status',
  'refs',
  'graph',
  'conflicts',
];

export const stashExtrasOps = {
  'stash.rename': define(
    'stash.rename',
    { label: (op) => `Rename stash@{${op.index}}`, touches: TOUCHES, undoable: true, cancellable: false },
    (ctx, op) => rename(ctx, op),
  ),
  'stash.applyFile': define(
    'stash.applyFile',
    {
      label: (op) => `Apply ${op.path} from stash@{${op.index}}`,
      touches: TOUCHES,
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => applyFile(ctx, op),
  ),
  'stash.branch': define(
    'stash.branch',
    {
      label: (op) => `Create branch ${op.name} from stash@{${op.index}}`,
      touches: [...TOUCHES, 'repoState'],
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => branch(ctx, op),
  ),
};
