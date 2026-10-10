import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../../service/atomic-write';
import { worktreePath } from '../../service/phase3/load';
import { assertSafeRev } from '../../service/rev-set';
import type { OpContext } from '../queue';
import type { OpResult } from '../types';
import { define, fail, git } from './util';

/**
 * Resolve a worktree path for writing: inside the worktree (no `..`, no absolute paths, nothing under
 * `.git`), also after following symlinked parent directories.
 */
export function writableWorktreePath(ctx: OpContext, rel: string): string {
  const abs = worktreePath(ctx.service, rel);
  const root = fs.realpathSync.native(ctx.service.repo.worktreeRoot!);
  // the deepest existing ancestor must still be inside the (real) worktree
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realDir = fs.realpathSync.native(dir);
  const relReal = path.relative(root, realDir);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw fail('Unknown', `Path is outside the working tree: "${rel}".`);
  }
  try {
    if (fs.lstatSync(abs).isDirectory()) throw fail('Unknown', `"${rel}" is a directory.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return abs;
}

/** In-app editor save (spec 07 §6.10): atomic write (temp + fsync + rename), mode preserved. */
async function writeFile(ctx: OpContext, rel: string, content: string): Promise<Omit<OpResult, 'opId'>> {
  const abs = writableWorktreePath(ctx, rel);
  await writeFileAtomic(abs, Buffer.from(content, 'utf8'));
  return { summary: `Saved ${rel}` };
}

/** "Checkout file at this commit" (spec 07 §2.3): restore index + worktree copy of one path from `rev`. */
async function checkoutAt(ctx: OpContext, rev: string, rel: string): Promise<Omit<OpResult, 'opId'>> {
  assertSafeRev(rev);
  writableWorktreePath(ctx, rel);
  await git(ctx, ['checkout', rev, '--', rel.replace(/\\/g, '/')], { env: { GIT_LITERAL_PATHSPECS: '1' } });
  return { summary: `Checked out ${rel} at ${rev.slice(0, 7)}` };
}

export const fileOps = {
  'file.write': define('file.write', { label: (op) => `Save ${op.path}`, touches: ['status'] }, (ctx, op) =>
    writeFile(ctx, op.path, op.content),
  ),
  'file.checkoutAt': define(
    'file.checkoutAt',
    { label: (op) => `Checkout ${op.path} at ${op.rev.slice(0, 7)}`, touches: ['status'], undoable: true },
    (ctx, op) => checkoutAt(ctx, op.rev, op.path),
  ),
};
