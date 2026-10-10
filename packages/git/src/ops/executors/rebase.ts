import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { rebaseTodoFor } from '../../service/phase3/history';
import { messages } from '../../service/phase3/shared';
import type { Sha, TodoItem } from '../../types';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import {
  cleanupRebaseScratch,
  copyEditor,
  opPaths,
  overwriteMessage,
  requireIdle,
  requireResolved,
  scratchDir,
  shQuote,
} from './history-util';
import { assertSafeName, define, fail, git, plural, withConflictFiles } from './util';

export interface RebaseOutcome {
  head: Sha | null;
  /** True when the rebase stopped on an `edit` step (still in progress, no conflicts). */
  stopped: boolean;
}

async function rebaseInProgress(ctx: OpContext): Promise<boolean> {
  const s = (await ctx.service.refreshRepoInfo()).state;
  return s === 'rebasing' || s === 'rebasing-interactive';
}

async function finish(ctx: OpContext, done: string): Promise<Omit<OpResult<RebaseOutcome>, 'opId'>> {
  const stopped = await rebaseInProgress(ctx);
  if (!stopped) await cleanupRebaseScratch(ctx.service);
  const head = await ctx.service.revParse('HEAD');
  return {
    summary: stopped ? `Rebase stopped at ${head?.slice(0, 7) ?? 'HEAD'} for editing` : done,
    data: { head, stopped },
  };
}

async function runRebase(ctx: OpContext, args: string[], env?: Record<string, string>): Promise<void> {
  try {
    await git(ctx, args, env ? { env } : {});
  } catch (e) {
    await ctx.service.refreshRepoInfo();
    await withConflictFiles(ctx.service, e, 'RebaseConflict');
  }
}

// ---- rebase (spec 05 §6.7) ----

async function rebaseRun(
  ctx: OpContext,
  op: OpOf<'rebase.run'>,
): Promise<Omit<OpResult<RebaseOutcome>, 'opId'>> {
  assertSafeName(op.onto, 'rebase target');
  if (op.branch) assertSafeName(op.branch, 'branch');
  if (op.upstream) assertSafeName(op.upstream, 'upstream');
  const svc = ctx.service;
  const info = await requireIdle(ctx, 'rebase');
  if (!(await svc.revParse(op.onto))) throw fail('Unknown', `Unknown revision "${op.onto}".`);
  const branch = op.branch?.replace(/^refs\/heads\//, '');
  const args = ['rebase', '--autostash'];
  if (op.upstream) args.push('--onto', op.onto, op.upstream);
  else args.push(op.onto);
  if (branch) args.push(branch);
  await runRebase(ctx, args);
  const name = branch ?? (info.head.kind === 'branch' ? info.head.name : 'HEAD');
  return finish(ctx, `Rebased ${name} onto ${op.onto}`);
}

async function rebaseContinue(
  ctx: OpContext,
  message?: string,
): Promise<Omit<OpResult<RebaseOutcome>, 'opId'>> {
  const svc = ctx.service;
  if (!(await rebaseInProgress(ctx))) throw fail('Unknown', 'There is no rebase in progress.');
  await requireResolved(svc, 'RebaseConflict');
  if (message?.trim()) {
    // the commit of the stopped step is made from rebase-merge/message (editor = no-op)
    const p = await opPaths(svc);
    overwriteMessage(message, [path.join(p['rebase-merge'], 'message'), p.MERGE_MSG]);
  }
  await runRebase(ctx, ['rebase', '--continue']);
  return finish(ctx, 'Rebase complete');
}

async function rebaseSkip(ctx: OpContext): Promise<Omit<OpResult<RebaseOutcome>, 'opId'>> {
  if (!(await rebaseInProgress(ctx))) throw fail('Unknown', 'There is no rebase in progress.');
  await runRebase(ctx, ['rebase', '--skip']);
  return finish(ctx, 'Rebase complete');
}

async function rebaseAbort(ctx: OpContext): Promise<Omit<OpResult, 'opId'>> {
  if (!(await rebaseInProgress(ctx))) throw fail('Unknown', 'There is no rebase in progress.');
  await git(ctx, ['rebase', '--abort']);
  await cleanupRebaseScratch(ctx.service);
  return { summary: 'Rebase aborted' };
}

// ---- interactive rebase (spec 05 §6.8) ----

interface Resolved extends TodoItem {
  sha: Sha;
}

/**
 * Turn the UI's todo (oldest first) into a git todo that never needs an editor (spec 05 §6.8 step 1):
 * reword = `pick` + `exec git commit --amend -F <msg>`; a squash group = `pick` + `fixup`… + one
 * `exec … -F <combined msg>`; fixup-only groups keep the target's message.
 */
export function buildTodo(
  items: Resolved[],
  fullMessages: Map<Sha, string>,
  squashMessages: Map<Sha, string>,
  writeMsg: (text: string) => string,
): string {
  const lines: string[] = [];
  const subject = (i: TodoItem): string => i.summary.replace(/[\r\n]+/g, ' ');
  let k = 0;
  while (k < items.length) {
    const t = items[k]!;
    if (t.action === 'drop') {
      lines.push(`drop ${t.sha} ${subject(t)}`);
      k++;
      continue;
    }
    if (t.action === 'squash' || t.action === 'fixup') {
      throw fail('Unknown', `"${subject(t)}" has no earlier commit to ${t.action} into.`);
    }
    lines.push(`${t.action === 'edit' ? 'edit' : 'pick'} ${t.sha} ${subject(t)}`);
    const members: Resolved[] = [];
    let j = k + 1;
    for (; j < items.length; j++) {
      const m = items[j]!;
      if (m.action === 'drop') lines.push(`drop ${m.sha} ${subject(m)}`);
      else if (m.action === 'squash' || m.action === 'fixup') {
        members.push(m);
        lines.push(`fixup ${m.sha} ${subject(m)}`);
      } else break;
    }
    let msg: string | undefined;
    if (members.some((m) => m.action === 'squash')) {
      const combined = [t, ...members.filter((m) => m.action === 'squash')]
        .map((m) =>
          (m === t && t.action === 'reword' && t.newMessage
            ? t.newMessage
            : (fullMessages.get(m.sha) ?? m.summary)
          ).trim(),
        )
        .join('\n\n');
      msg = squashMessages.get(t.sha) ?? t.newMessage ?? combined;
    } else if (members.length && squashMessages.has(t.sha)) msg = squashMessages.get(t.sha);
    else if (t.action === 'reword' && t.newMessage?.trim()) msg = t.newMessage;
    if (msg !== undefined) {
      if (!msg.trim()) throw fail('EmptyCommitMessage', 'The commit message is empty.');
      lines.push(`exec git commit --amend --allow-empty --no-verify -F ${shQuote(writeMsg(msg))}`);
    }
    k = j;
  }
  return lines.join('\n') + '\n';
}

async function rebaseInteractive(
  ctx: OpContext,
  op: OpOf<'rebase.interactive'>,
): Promise<Omit<OpResult<RebaseOutcome>, 'opId'>> {
  assertSafeName(op.onto, 'rebase target');
  assertSafeName(op.upstream, 'upstream');
  const svc = ctx.service;
  const info = await requireIdle(ctx, 'rebase');
  const [onto, upstream] = await Promise.all([svc.revParse(op.onto), svc.revParse(op.upstream)]);
  if (!onto) throw fail('Unknown', `Unknown revision "${op.onto}".`);
  if (!upstream) throw fail('Unknown', `Unknown revision "${op.upstream}".`);
  const range = await rebaseTodoFor(svc, upstream, 'HEAD'); // rejects merges in the range
  const inRange = new Set(range.map((r) => r.sha));
  const items: Resolved[] = [];
  const seen = new Set<Sha>();
  for (const t of op.todo) {
    assertSafeName(t.sha, 'commit');
    const sha = await svc.revParse(t.sha);
    if (!sha || !inRange.has(sha) || seen.has(sha)) {
      throw fail('Unknown', 'The rebase list is out of date; refresh and try again.', { commit: t.sha });
    }
    seen.add(sha);
    items.push({ ...t, sha });
  }
  if (items.length !== range.length) {
    throw fail('Unknown', 'The rebase list is out of date; refresh and try again.');
  }
  const squashMessages = new Map<Sha, string>();
  for (const [k, v] of Object.entries(op.squashMessages ?? {})) {
    const sha = await svc.revParse(k);
    if (sha) squashMessages.set(sha, v);
  }
  const needsMessages = items.filter((i) => i.action === 'squash').length > 0;
  const full = needsMessages
    ? await messages(
        svc,
        items.map((i) => i.sha),
      )
    : new Map<Sha, string>();

  const dir = scratchDir(svc, path.join('rebase-i', randomUUID()));
  let n = 0;
  const todo = buildTodo(items, full, squashMessages, (text) => {
    const f = path.join(dir, `msg-${++n}.txt`);
    fs.writeFileSync(f, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return f;
  });
  const todoFile = path.join(dir, 'todo');
  fs.writeFileSync(todoFile, todo, 'utf8');

  await runRebase(ctx, ['rebase', '-i', '--autostash', '--no-autosquash', '--onto', onto, upstream], {
    GIT_SEQUENCE_EDITOR: copyEditor(todoFile),
    GIT_EDITOR: 'true',
  });
  const name = info.head.kind === 'branch' ? info.head.name : 'HEAD';
  const kept = items.filter((i) => i.action !== 'drop').length;
  return finish(ctx, `Rebased ${name} (${plural(kept, 'commit')})`);
}

const TOUCHES: ('status' | 'refs' | 'graph' | 'repoState' | 'conflicts' | 'stash')[] = [
  'status',
  'refs',
  'graph',
  'repoState',
  'conflicts',
  'stash',
];

export const rebaseOps = {
  'rebase.run': define(
    'rebase.run',
    {
      label: (op) =>
        `Rebase ${op.branch ? `${op.branch.replace(/^refs\/heads\//, '')} ` : ''}onto ${op.onto}`,
      touches: TOUCHES,
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => rebaseRun(ctx, op),
  ),
  'rebase.interactive': define(
    'rebase.interactive',
    {
      label: (op) => `Interactive rebase (${plural(op.todo.length, 'commit')})`,
      touches: TOUCHES,
      undoable: true,
      cancellable: false,
    },
    (ctx, op) => rebaseInteractive(ctx, op),
  ),
  'rebase.continue': define(
    'rebase.continue',
    { label: () => 'Continue rebase', touches: TOUCHES, cancellable: false },
    (ctx, op) => rebaseContinue(ctx, op.message),
  ),
  'rebase.skip': define(
    'rebase.skip',
    { label: () => 'Skip commit', touches: TOUCHES, cancellable: false },
    (ctx) => rebaseSkip(ctx),
  ),
  'rebase.abort': define(
    'rebase.abort',
    { label: () => 'Abort rebase', touches: TOUCHES, cancellable: false },
    (ctx) => rebaseAbort(ctx),
  ),
};
