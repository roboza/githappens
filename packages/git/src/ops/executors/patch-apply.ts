import fs from 'node:fs';
import path from 'node:path';

import { GitError } from '../../errors/classify';
import type { Sha } from '../../types';
import type { OpContext } from '../queue';
import type { OpOf, OpResult, PatchApplyOutcome } from '../types';
import { validateBranchName } from './branch';
import { requireIdle } from './history-util';
import { assertSafeName, define, fail, git, plural, read, unmergedPaths } from './util';

/**
 * Apply a patch file (Cloud Patches, spec 14 §6.3 "Open/apply"). The patch is `git diff --binary
 * --full-index` output, or `git format-patch --stdout --binary` output for shared commits (mode `am`).
 *
 * Targets: the current working tree, a new branch created at the patch base, or an existing branch.
 * Branch targets need a clean working tree unless `autostash` is set; the stash is left in the stash list
 * (it belongs to the branch the user left). One undo-journal entry ('patch-apply') reverts the whole op.
 *
 * `git apply --3way` is tried first (needs the pre-image blobs; conflicts leave markers + unmerged index
 * entries and are reported, not thrown), then a plain `git apply`, then — only with `reject: true` —
 * `git apply --reject`, which applies what it can and leaves `.rej` files. When nothing applies the op
 * fails with `details.patchApply = 'does-not-apply'` so the UI can offer the reject / whitespace retries.
 */

type Op = OpOf<'patch.apply'>;
type Result = Promise<Omit<OpResult<PatchApplyOutcome>, 'opId'>>;

const APPLY_BASE = ['apply', '--whitespace=nowarn', '--binary'];

function applyArgs(op: Op, extra: string[]): string[] {
  return [...APPLY_BASE, ...extra, ...(op.ignoreWhitespace ? ['--ignore-whitespace'] : []), op.patchFile];
}

/** Changed (non-ignored) paths incl. untracked. */
async function isDirty(ctx: OpContext): Promise<boolean> {
  const st = await ctx.service.status({ untracked: 'all' });
  return st.entries.some((e) => e.kind !== 'ignored');
}

/** Paths a patch touches (new and old names), from `git apply --numstat -z`. */
async function patchPaths(ctx: OpContext, file: string): Promise<string[]> {
  const r = await read(ctx.service, ['apply', '--numstat', '-z', file], { expectedExitCodes: [0, 1, 128] });
  if (r.exitCode !== 0) return [];
  const out: string[] = [];
  const tokens = r.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:-|\d+)\t(?:-|\d+)\t(.*)$/s.exec(tokens[i]!);
    if (!m) continue;
    if (m[1] === '') out.push(tokens[++i] ?? '', tokens[++i] ?? '');
    else out.push(m[1]!);
  }
  return out.filter(Boolean);
}

interface ApplyStep {
  applied: boolean;
  conflicts: string[];
  rejects: string[];
  /** Changes were staged (3-way implies --index). */
  staged: boolean;
}

async function runApply(ctx: OpContext, op: Op): Promise<ApplyStep> {
  const svc = ctx.service;
  const threeWay = op.threeWay !== false;
  let lastErr = '';
  if (threeWay) {
    const r = await git(ctx, applyArgs(op, ['--3way']), { expectedExitCodes: [0, 1, 128] });
    if (r.exitCode === 0) return { applied: true, conflicts: [], rejects: [], staged: true };
    const conflicts = await unmergedPaths(svc);
    if (conflicts.length) return { applied: true, conflicts, rejects: [], staged: true };
    lastErr = r.stderr;
  }
  const plain = await git(ctx, applyArgs(op, []), { expectedExitCodes: [0, 1, 128] });
  if (plain.exitCode === 0) return { applied: true, conflicts: [], rejects: [], staged: false };
  lastErr = plain.stderr || lastErr;
  if (op.reject) {
    const files = await patchPaths(ctx, op.patchFile);
    const r = await git(ctx, applyArgs(op, ['--reject']), { expectedExitCodes: [0, 1, 128] });
    const rejects = files.map((f) => `${f}.rej`).filter((f) => fs.existsSync(path.join(svc.cwd, f)));
    if (r.exitCode === 0 || rejects.length) return { applied: true, conflicts: [], rejects, staged: false };
    lastErr = r.stderr || lastErr;
  }
  const excerpt = lastErr.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ');
  throw fail(
    'Unknown',
    `The patch does not apply to this branch${excerpt ? `: ${excerpt}` : '.'}`,
    { patchApply: 'does-not-apply' },
    applyArgs(op, threeWay ? ['--3way'] : []),
  );
}

async function runAm(ctx: OpContext, op: Op): Promise<boolean> {
  const args = ['am', '--3way', '--quiet', ...(op.ignoreWhitespace ? ['--ignore-whitespace'] : [])];
  const r = await git(ctx, [...args, op.patchFile], { expectedExitCodes: [0, 1, 128] });
  if (r.exitCode === 0) return true;
  await git(ctx, ['am', '--abort'], { expectedExitCodes: [0, 1, 128] });
  return false;
}

async function stashIfDirty(ctx: OpContext, op: Op, what: string): Promise<Sha | undefined> {
  if (!(await isDirty(ctx))) return undefined;
  const autostash = op.target.kind !== 'worktree' && op.target.autostash;
  if (!autostash) {
    throw fail('Unknown', `Commit or stash your changes before applying the patch to ${what}.`, {
      dirty: 'local-changes',
    });
  }
  const before = await ctx.service.revParse('refs/stash');
  await git(ctx, [
    'stash',
    'push',
    '--include-untracked',
    '-m',
    `autostash: before applying patch to ${what}`,
  ]);
  const after = await ctx.service.revParse('refs/stash');
  return after && after !== before ? after : undefined;
}

async function applyPatch(ctx: OpContext, op: Op): Result {
  const svc = ctx.service;
  if (!op.patchFile || !path.isAbsolute(op.patchFile) || !fs.existsSync(op.patchFile))
    throw fail('Unknown', 'The patch file is missing.');
  const info = await requireIdle(ctx, 'apply a patch');
  const warnings: string[] = [];
  const data: PatchApplyOutcome = { applied: false, conflicts: [], rejects: [] };
  let stashSha: Sha | undefined;
  let wasClean = true;

  // ---- switch to the target branch ----
  const t = op.target;
  if (t.kind === 'new-branch') {
    const v = await validateBranchName(svc, t.name);
    if (!v.valid) throw fail('InvalidRefName', v.reason);
    if (await svc.revParse(`refs/heads/${t.name}`))
      throw fail('Unknown', `A branch named "${t.name}" already exists.`);
    const base = t.base ?? 'HEAD';
    assertSafeName(base, 'base commit');
    const baseSha = await svc.revParse(`${base}^{commit}`);
    if (!baseSha) throw fail('Unknown', `The base commit ${base.slice(0, 12)} is not available locally.`);
    stashSha = await stashIfDirty(ctx, op, t.name);
    try {
      await git(ctx, ['switch', '--no-track', '-c', t.name, baseSha]);
    } catch (e) {
      if (stashSha) await git(ctx, ['stash', 'pop', '--index', '-q']).catch(() => undefined);
      throw e;
    }
    data.branch = t.name;
  } else if (t.kind === 'existing-branch') {
    assertSafeName(t.name, 'branch name');
    if (!(await svc.revParse(`refs/heads/${t.name}`)))
      throw fail('Unknown', `The branch "${t.name}" does not exist.`);
    const current = info.head.kind === 'branch' && info.head.name === t.name;
    if (!current) {
      stashSha = await stashIfDirty(ctx, op, t.name);
      try {
        await git(ctx, ['switch', t.name]);
      } catch (e) {
        if (stashSha) await git(ctx, ['stash', 'pop', '--index', '-q']).catch(() => undefined);
        throw e;
      }
    } else {
      wasClean = !(await isDirty(ctx));
    }
    data.branch = t.name;
  } else {
    wasClean = !(await isDirty(ctx));
  }
  if (stashSha) {
    data.autostash = stashSha;
    warnings.push('Your local changes were stashed before switching branches.');
  }

  // ---- apply ----
  const wantsCommit = op.mode === 'am' && t.kind !== 'worktree';
  if (wantsCommit && wasClean && (await runAm(ctx, op))) {
    data.applied = true;
    data.commit = (await svc.revParse('HEAD')) ?? undefined;
  } else {
    if (wantsCommit) {
      warnings.push(
        wasClean
          ? 'The commit did not apply cleanly, so its changes were applied without committing.'
          : 'The branch has local changes, so the patch was applied without committing.',
      );
    }
    const step = await runApply(ctx, op);
    data.applied = step.applied;
    data.conflicts = step.conflicts;
    data.rejects = step.rejects;
    const message = op.commitMessage?.trim();
    if (message && op.mode === 'apply' && t.kind !== 'worktree') {
      if (step.conflicts.length || step.rejects.length) {
        warnings.push('The patch was not committed because it did not apply cleanly.');
      } else if (!wasClean) {
        warnings.push('The branch has local changes, so the patch was applied without committing.');
      } else {
        await git(ctx, ['add', '-A']);
        await git(ctx, ['commit', '-q', '--no-verify', '-F', '-'], { stdin: `${message}\n` });
        data.commit = (await svc.revParse('HEAD')) ?? undefined;
      }
    }
  }
  if (data.conflicts.length) warnings.push(`${plural(data.conflicts.length, 'file')} with conflicts`);
  if (data.rejects.length) warnings.push(`${plural(data.rejects.length, 'rejected hunk file')} (.rej)`);
  await svc.refreshRepoInfo().catch(() => undefined);

  const where =
    t.kind === 'worktree' ? 'the working tree' : t.kind === 'new-branch' ? `new branch ${t.name}` : t.name;
  const summary = data.conflicts.length
    ? `Applied patch to ${where} with conflicts`
    : data.rejects.length
      ? `Partially applied patch to ${where}`
      : `Applied patch to ${where}`;
  return { summary, data, ...(warnings.length ? { warnings } : {}) };
}

export const patchApplyOps = {
  'patch.apply': define(
    'patch.apply',
    {
      label: (op) => (op.title ? `Apply patch '${op.title}'` : 'Apply patch'),
      touches: ['status', 'refs', 'graph', 'conflicts', 'stash'],
      undoable: true,
      cancellable: false,
    },
    async (ctx, op) => {
      try {
        return await applyPatch(ctx, op);
      } catch (e) {
        if (e instanceof GitError) throw e;
        throw fail('Unknown', e instanceof Error ? e.message : String(e));
      }
    },
  ),
};
