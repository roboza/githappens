import { GitError } from '../../errors/classify';
import type { DiffSpec, FileDiff } from '../../types';
import { diffHash } from '../diff-hash';
import type { OpContext } from '../queue';
import type { OpOf, OpResult } from '../types';
import { patchHeader } from './patch';
import { define, fail, git, staleDiff } from './util';

/**
 * Revert hunk (spec 07 §4.3, §6.6): reverse-apply one hunk of a commit / compare diff to
 * the working tree, so the inverse lands as unstaged changes. The executor recomputes the diff the UI
 * showed and refuses when its hash changed; undo restores the worktree (journal kind `revert-hunk`).
 */

const matches = (f: FileDiff, p: string): boolean => f.newPath === p || f.oldPath === p;

/** Hunk text exactly as git printed it (header + `+`/`-`/` ` lines + "\ No newline" markers). */
function hunkText(file: FileDiff, i: number): string {
  const h = file.hunks[i]!;
  let out = `${h.header}\n`;
  for (const l of h.lines) {
    if (l.type === 'nonewline') out += '\\ No newline at end of file\n';
    else out += `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.content}\n`;
  }
  return out;
}

/**
 * Patch holding the selected hunks of `file` (pure; applied with `git apply -R`). A whole added file
 * reverses into a deletion and a whole deleted file into a re-creation; the worktree file is the new path.
 */
export function buildRevertPatch(file: FileDiff, hunkIndices: number[]): string {
  if (!hunkIndices.length) return '';
  for (const i of hunkIndices) if (!file.hunks[i]) throw staleDiff();
  const all = hunkIndices.length === file.hunks.length;
  const name = file.newPath ?? file.oldPath!;
  let header: string;
  if (file.status === 'A' && all) header = patchHeader(name, { newFile: file.newMode ?? '100644' });
  else if (file.status === 'D') {
    if (!all) throw fail('Unknown', 'This file was deleted; revert the whole file instead of one hunk.');
    header = patchHeader(name, { deletedFile: file.oldMode ?? '100644' });
  } else header = patchHeader(name, 'modify');
  return (
    header +
    [...hunkIndices]
      .sort((a, b) => a - b)
      .map((i) => hunkText(file, i))
      .join('')
  );
}

type RevertableSpec = Extract<DiffSpec, { kind: 'commit' | 'range' }>;

function assertRevertable(spec: DiffSpec): asserts spec is RevertableSpec {
  if (spec.kind !== 'commit' && spec.kind !== 'range') {
    throw fail('Unknown', 'Revert hunk works on commit and comparison diffs; use Discard for WIP changes.');
  }
}

async function revertHunk(ctx: OpContext, op: OpOf<'diff.revertHunk'>): Promise<Omit<OpResult, 'opId'>> {
  const svc = ctx.service;
  if (!svc.repo.worktreeRoot) throw fail('Unknown', 'This operation needs a working tree (bare repository).');
  const spec: DiffSpec = op.spec;
  assertRevertable(spec);
  const p = op.path.replace(/\\/g, '/');
  const oldPath = op.oldPath?.replace(/\\/g, '/');
  const paths = oldPath && oldPath !== p ? [oldPath, p] : [p];
  const files = await svc.diff(
    { ...spec, paths },
    { contextLines: op.contextLines ?? 3, ignoreWhitespace: 'none' },
  );
  const file =
    files.find((f) => matches(f, p)) ?? (oldPath ? files.find((f) => matches(f, oldPath)) : undefined);
  if (!file || diffHash(file) !== op.diffHash) throw staleDiff();
  if (file.binary || file.tooLarge || file.submodule || file.lfsPointer) {
    throw fail('Unknown', 'Revert hunk is not available for this file.');
  }
  const indices = op.hunkIndex === 'all' ? file.hunks.map((_, i) => i) : [op.hunkIndex];
  const patch = buildRevertPatch(file, indices);
  if (!patch) return {};
  try {
    // zero-context hunks (`-U0`) need --unidiff-zero to apply at all
    const zero = (op.contextLines ?? 3) === 0 ? ['--unidiff-zero'] : [];
    await git(ctx, ['apply', '-R', '--recount', '--whitespace=nowarn', ...zero, '-'], {
      stdin: Buffer.from(patch, 'utf8'),
    });
  } catch (e) {
    if (!(e instanceof GitError) || e.code === 'Cancelled') throw e;
    const s = e.serialized;
    throw new GitError({
      ...s,
      code: 'Unknown',
      message:
        'The change no longer applies to the working tree (the file has diverged). Revert the whole commit instead.',
    });
  }
  const what = op.hunkIndex === 'all' ? 'changes' : 'hunk';
  return { summary: `Reverted ${what} in ${file.newPath ?? p}` };
}

export const revertHunkOps = {
  'diff.revertHunk': define(
    'diff.revertHunk',
    {
      label: (op) => `Revert ${op.hunkIndex === 'all' ? 'changes' : 'hunk'} in ${op.path}`,
      touches: ['status'],
      undoable: true,
    },
    revertHunk,
  ),
};
