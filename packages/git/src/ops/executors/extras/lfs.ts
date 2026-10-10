import { GitError } from '../../../errors/classify';
import { lfsAvailable, parseLfsLocksJson, type LfsLock } from '../../../service/extras/lfs';
import type { OpContext } from '../../queue';
import type { OpOf, OpResult } from '../../types';
import { assertSafeName, define, fail, git, type RunOpts } from '../util';
import { withLfsProgress } from './lfs-progress';
import { assertSafePath, recode, toGitPath } from './shared';

type Result = Promise<Omit<OpResult, 'opId'>>;

/** Fail early with LfsMissing when git-lfs is not usable (spec 09 §6.8 "Errors"). */
async function requireLfs(ctx: OpContext): Promise<void> {
  if (!(await lfsAvailable(ctx.service))) throw fail('LfsMissing', undefined, undefined, ['lfs']);
}

/** Run a `git lfs` command: unclassified failures become LfsError. */
async function lfs(ctx: OpContext, args: string[], o: RunOpts = {}) {
  try {
    return await git(ctx, ['lfs', ...args], o);
  } catch (e) {
    return recode(e, 'LfsError');
  }
}

/** Network `git lfs` command with GIT_LFS_PROGRESS tailing + credentials. */
function lfsNetwork(ctx: OpContext, args: string[]) {
  return withLfsProgress(ctx.progress, (env) => lfs(ctx, args, { network: 'generic', env }));
}

function patternsOf(patterns: string[]): string[] {
  if (!patterns.length) throw fail('Unknown', 'No pattern given.');
  return patterns.map((p) => assertSafePath(p, 'pattern'));
}

// ---- install / track / untrack (local) ----

async function install(ctx: OpContext): Result {
  await requireLfs(ctx);
  try {
    await git(ctx, ['lfs', 'install', '--local']);
  } catch (e) {
    if (e instanceof GitError && /hook already exists/i.test(`${e.serialized.stderr}\n${e.message}`)) {
      throw fail(
        'LfsError',
        'Git LFS could not install its hooks because hooks already exist. Add the git-lfs commands to them manually (see `git lfs update --manual`).',
        { hint: 'git lfs update --manual' },
        ['lfs', 'install', '--local'],
      );
    }
    recode(e, 'LfsError');
  }
  return { summary: 'Initialized Git LFS' };
}

async function track(ctx: OpContext, op: OpOf<'lfs.track'>): Result {
  const patterns = patternsOf(op.patterns);
  await requireLfs(ctx);
  await lfs(ctx, ['track', '--', ...patterns]);
  return { summary: `Tracking ${patterns.join(', ')} with LFS`, data: { patterns } };
}

async function untrack(ctx: OpContext, op: OpOf<'lfs.untrack'>): Result {
  const patterns = patternsOf(op.patterns);
  await requireLfs(ctx);
  await lfs(ctx, ['untrack', '--', ...patterns]);
  return { summary: `Stopped tracking ${patterns.join(', ')} with LFS`, data: { patterns } };
}

/**
 * "Convert existing files" (spec 09 §6.8): `git lfs track` the patterns, then re-add the tracked files
 * matching them through the (now LFS) clean filter with `git add --renormalize`. History is untouched.
 */
async function convert(ctx: OpContext, op: OpOf<'lfs.convert'>): Result {
  const patterns = patternsOf(op.patterns);
  await requireLfs(ctx);
  await lfs(ctx, ['track', '--', ...patterns]);
  // gitattributes-style patterns: glob pathspecs (`*.psd` matches in every directory)
  const ls = await git(ctx, ['ls-files', '-z', '--cached', '--', ...patterns], {
    env: { GIT_LITERAL_PATHSPECS: '0' },
  });
  const files = ls.stdout.split('\0').filter(Boolean);
  await git(ctx, ['add', '--', '.gitattributes']);
  for (let i = 0; i < files.length; i += 200) {
    await git(ctx, ['add', '--renormalize', '--', ...files.slice(i, i + 200)]);
  }
  return {
    summary: files.length
      ? `Converted ${files.length} file${files.length === 1 ? '' : 's'} to Git LFS`
      : `Tracking ${patterns.join(', ')} with LFS (no existing files matched)`,
    data: { patterns, files },
  };
}

// ---- network ----

async function pull(ctx: OpContext, op: OpOf<'lfs.pull'>): Result {
  await requireLfs(ctx);
  const args = ['pull'];
  if (op.remote) {
    assertSafeName(op.remote, 'remote');
    args.push(op.remote);
  }
  await lfsNetwork(ctx, args);
  return { summary: 'Pulled LFS objects' };
}

async function fetchObjects(ctx: OpContext, op: OpOf<'lfs.fetch'>): Result {
  await requireLfs(ctx);
  await lfsNetwork(ctx, ['fetch', ...(op.all ? ['--all'] : [])]);
  return { summary: op.all ? 'Fetched all LFS objects' : 'Fetched LFS objects' };
}

async function push(ctx: OpContext, op: OpOf<'lfs.push'>): Result {
  assertSafeName(op.remote, 'remote');
  await requireLfs(ctx);
  const args = ['push'];
  if (op.all) args.push('--all', op.remote);
  else {
    const head = ctx.service.repo.head;
    args.push(op.remote, head.kind === 'branch' && head.name ? head.name : 'HEAD');
  }
  await lfsNetwork(ctx, args);
  return { summary: `Pushed LFS objects to ${op.remote}` };
}

async function prune(ctx: OpContext): Result {
  await requireLfs(ctx);
  const r = await lfs(ctx, ['prune', '--verbose']);
  const m = /prun(?:ed|ing) (\d+) (?:local )?object/i.exec(`${r.stdout}\n${r.stderr}`);
  return {
    summary: m ? `Pruned ${m[1]} LFS objects` : 'Pruned LFS objects',
    data: { output: r.stdout.trim() },
  };
}

function lockFromJson(stdout: string): LfsLock | undefined {
  const t = stdout.trim();
  if (!t) return undefined;
  return parseLfsLocksJson(t.startsWith('[') ? t : `[${t}]`)[0];
}

async function lock(ctx: OpContext, op: OpOf<'lfs.lock'>): Result {
  const p = toGitPath(op.path);
  await requireLfs(ctx);
  const r = await lfs(ctx, ['lock', '--json', '--', p], { network: 'generic' });
  return { summary: `Locked ${p}`, data: lockFromJson(r.stdout) };
}

async function unlock(ctx: OpContext, op: OpOf<'lfs.unlock'>): Result {
  const p = toGitPath(op.path);
  await requireLfs(ctx);
  await lfs(ctx, ['unlock', '--json', ...(op.force ? ['--force'] : []), '--', p], { network: 'generic' });
  return { summary: `Unlocked ${p}` };
}

const NET = { network: true } as const;

export const lfsOps = {
  'lfs.install': define('lfs.install', { label: () => 'Initialize Git LFS', touches: ['config'] }, (ctx) =>
    install(ctx),
  ),
  'lfs.track': define(
    'lfs.track',
    { label: (op) => `LFS track ${op.patterns.join(', ')}`, touches: ['status', 'config'] },
    track,
  ),
  'lfs.untrack': define(
    'lfs.untrack',
    { label: (op) => `LFS untrack ${op.patterns.join(', ')}`, touches: ['status', 'config'] },
    untrack,
  ),
  'lfs.pull': define('lfs.pull', { label: () => 'LFS pull', touches: ['status'], ...NET }, pull),
  'lfs.fetch': define('lfs.fetch', { label: () => 'LFS fetch', touches: [], ...NET }, fetchObjects),
  'lfs.push': define('lfs.push', { label: (op) => `LFS push to ${op.remote}`, touches: [], ...NET }, push),
  'lfs.prune': define('lfs.prune', { label: () => 'LFS prune', touches: [] }, (ctx) => prune(ctx)),
  'lfs.convert': define(
    'lfs.convert',
    { label: (op) => `Convert ${op.patterns.join(', ')} to LFS`, touches: ['status', 'config'] },
    convert,
  ),
  'lfs.lock': define('lfs.lock', { label: (op) => `Lock ${op.path}`, touches: ['status'], ...NET }, lock),
  'lfs.unlock': define(
    'lfs.unlock',
    { label: (op) => `Unlock ${op.path}`, touches: ['status'], ...NET },
    unlock,
  ),
};
