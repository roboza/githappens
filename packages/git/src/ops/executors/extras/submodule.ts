import fs from 'node:fs';
import nodePath from 'node:path';

import type { GitService } from '../../../service/git-service';
import { GITMODULES_REGEXP, parseGitmodulesConfig } from '../../../service/extras/submodules';
import type { OpContext } from '../../queue';
import type { OpOf, OpResult } from '../../types';
import { assertSafeName, define, fail, git, read } from '../util';
import { as, toGitPath } from './shared';

type Result = Promise<Omit<OpResult, 'opId'>>;

function assertUrl(url: string): void {
  if (!url.trim() || /[\0\r\n]/.test(url)) throw fail('Unknown', 'Invalid submodule URL.');
}

/** Submodule name for a path, from `.gitmodules` (falls back to the path). */
async function submoduleName(service: GitService, p: string): Promise<string> {
  const r = await read(
    service,
    ['config', '-z', '--file', '.gitmodules', '--get-regexp', GITMODULES_REGEXP],
    {
      expectedExitCodes: [0, 1, 128],
    },
  );
  if (r.exitCode !== 0) return p;
  return parseGitmodulesConfig(r.stdout).find((m) => m.path === p)?.name ?? p;
}

// ---- add (spec 09 §6.9) ----

async function add(ctx: OpContext, op: OpOf<'submodule.add'>): Result {
  assertUrl(op.url);
  const p = toGitPath(op.path);
  const args = ['submodule', 'add', '--progress'];
  if (op.branch) {
    assertSafeName(op.branch, 'branch');
    args.push('-b', op.branch);
  }
  args.push('--', op.url, p);
  await as('SubmoduleError', () => git(ctx, args, { network: 'clone' }));
  // nested submodules of the new module
  await as('SubmoduleError', () =>
    git(ctx, ['submodule', 'update', '--init', '--recursive', '--progress', '--', p], { network: 'clone' }),
  );
  return { summary: `Added submodule ${p}`, data: { path: p } };
}

// ---- init / update ----

async function update(ctx: OpContext, op: OpOf<'submodule.update'>): Result {
  const paths = (op.paths ?? []).map(toGitPath);
  const args = ['submodule', 'update'];
  if (op.init) args.push('--init');
  if (op.recursive) args.push('--recursive');
  if (op.remote) args.push('--remote');
  args.push('--progress', '--', ...paths);
  await as('SubmoduleError', () => git(ctx, args, { network: 'clone' }));
  const what = paths.length === 1 ? paths[0]! : paths.length ? `${paths.length} submodules` : 'submodules';
  return { summary: op.remote ? `Updated ${what} to latest remote` : `Updated ${what}` };
}

// ---- edit URL (spec 09 §6.9 "Edit URL") ----

async function setUrl(ctx: OpContext, op: OpOf<'submodule.setUrl'>): Result {
  assertUrl(op.url);
  const p = toGitPath(op.path);
  const declared = await read(
    ctx.service,
    ['config', '-z', '--file', '.gitmodules', '--get-regexp', GITMODULES_REGEXP],
    { expectedExitCodes: [0, 1, 128] },
  );
  const known = declared.exitCode === 0 ? parseGitmodulesConfig(declared.stdout) : [];
  if (!known.some((m) => m.path === p)) throw fail('SubmoduleError', `No submodule at "${p}".`, { path: p });
  // `set-url` rewrites `.gitmodules` and runs `submodule sync` for an initialized module (git >= 2.25)
  await as('SubmoduleError', () => git(ctx, ['submodule', 'set-url', '--', p, op.url]));
  await as('SubmoduleError', () => git(ctx, ['submodule', 'sync', '--recursive', '--', p]));
  await git(ctx, ['add', '--', '.gitmodules']);
  return { summary: `Changed the URL of ${p}`, data: { path: p, url: op.url } };
}

// ---- remove ----

async function remove(ctx: OpContext, op: OpOf<'submodule.remove'>): Result {
  const p = toGitPath(op.path);
  const svc = ctx.service;
  const name = await submoduleName(svc, p);
  await as('SubmoduleError', () => git(ctx, ['submodule', 'deinit', '-f', '--', p]));
  await as('SubmoduleError', () => git(ctx, ['rm', '-f', '--', p]));
  // remove the module's git dir, guarded to <commonDir>/modules
  const modulesRoot = nodePath.join(svc.repo.commonDir, 'modules');
  const target = nodePath.resolve(modulesRoot, ...name.split('/'));
  const rel = nodePath.relative(modulesRoot, target);
  const warnings: string[] = [];
  if (rel && !rel.startsWith('..') && !nodePath.isAbsolute(rel)) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      warnings.push(`Could not delete ${target}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { summary: `Removed submodule ${p}`, ...(warnings.length ? { warnings } : {}) };
}

export const submoduleOps = {
  'submodule.add': define(
    'submodule.add',
    {
      label: (op) => `Add submodule ${op.path}`,
      touches: ['submodules', 'status', 'config'],
      network: true,
    },
    add,
  ),
  'submodule.update': define(
    'submodule.update',
    {
      label: (op) =>
        `${op.init ? 'Initialize' : 'Update'} submodule${op.paths?.length === 1 ? ` ${op.paths[0]}` : 's'}`,
      touches: ['submodules', 'status', 'config'],
      network: true,
    },
    update,
  ),
  'submodule.setUrl': define(
    'submodule.setUrl',
    { label: (op) => `Edit submodule URL ${op.path}`, touches: ['submodules', 'status', 'config'] },
    setUrl,
  ),
  'submodule.remove': define(
    'submodule.remove',
    { label: (op) => `Remove submodule ${op.path}`, touches: ['submodules', 'status', 'config'] },
    remove,
  ),
};
