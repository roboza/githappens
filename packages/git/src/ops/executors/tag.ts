import type { OpContext } from '../queue';
import type { OpResult, PushOutcome } from '../types';
import { assertSafeName, define, git } from './util';
import { parsePorcelainPush, pushOrThrow } from './sync';

type Result = Promise<Omit<OpResult, 'opId'>>;

async function createTag(
  ctx: OpContext,
  op: { name: string; target: string; annotated?: { message: string; sign?: boolean } },
): Result {
  assertSafeName(op.name, 'tag name');
  assertSafeName(op.target, 'tag target');
  if (op.annotated) {
    const mode = op.annotated.sign ? '-s' : '-a';
    const msg = op.annotated.message.trim() ? op.annotated.message : op.name;
    await git(ctx, ['tag', mode, '-F', '-', '--cleanup=whitespace', '--', op.name, op.target], {
      stdin: Buffer.from(`${msg.replace(/\s+$/, '')}\n`, 'utf8'),
    });
  } else {
    await git(ctx, ['tag', '--no-sign', '--', op.name, op.target]);
  }
  return { summary: `Created tag ${op.name}` };
}

async function pushRefs(ctx: OpContext, args: string[]): Promise<PushOutcome> {
  const r = await git(ctx, args, { network: 'push', expectedExitCodes: [0, 1] });
  const refs = parsePorcelainPush(r.stdout);
  pushOrThrow(args, r, refs, ctx.opId);
  return { refs };
}

async function deleteTag(ctx: OpContext, op: { name: string; local: boolean; remotes: string[] }): Result {
  assertSafeName(op.name, 'tag name');
  if (op.local) await git(ctx, ['tag', '-d', '--', op.name]);
  for (const remote of op.remotes) {
    assertSafeName(remote, 'remote');
    await pushRefs(ctx, [
      'push',
      '--porcelain',
      '--progress',
      '--delete',
      '--',
      remote,
      `refs/tags/${op.name}`,
    ]);
  }
  return { summary: `Deleted tag ${op.name}` };
}

async function pushTag(
  ctx: OpContext,
  op: { name: string; remote: string },
): Promise<Omit<OpResult<PushOutcome>, 'opId'>> {
  assertSafeName(op.name, 'tag name');
  assertSafeName(op.remote, 'remote');
  const data = await pushRefs(ctx, [
    'push',
    '--porcelain',
    '--progress',
    '--',
    op.remote,
    `refs/tags/${op.name}`,
  ]);
  return { summary: `Pushed tag ${op.name} to ${op.remote}`, data };
}

export const tagOps = {
  'tag.create': define(
    'tag.create',
    { label: (op) => `Create tag ${op.name}`, touches: ['refs'], undoable: true },
    (ctx, op) => createTag(ctx, op),
  ),
  'tag.delete': define(
    'tag.delete',
    { label: (op) => `Delete tag ${op.name}`, touches: ['refs'], undoable: true, network: true },
    (ctx, op) => deleteTag(ctx, op),
  ),
  'tag.push': define(
    'tag.push',
    { label: (op) => `Push tag ${op.name} to ${op.remote}`, touches: ['refs'], network: true },
    (ctx, op) => pushTag(ctx, op),
  ),
};
