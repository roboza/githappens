import { ignorePatternFor, rawIgnorePatternFor, type IgnoreKind } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';

import { confirm } from '../../components/Dialogs';
import { quiet, runOp } from '../../lib/ops';
import { useToastStore } from '../../stores/toasts';
import { stashFiles } from '../ops/branching-actions';
import { noteEolWarnings } from './composer-store';
import { opPathOf, type WipRow } from './staging-helpers';

const what = (paths: string[]): string => (paths.length === 1 ? paths[0]! : `${paths.length} files`);

export async function stageFiles(repoId: RepoId, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const r = await runOp(repoId, { type: 'wip.stage', paths }).catch(() => null);
  if (r) noteEolWarnings(repoId, r.data);
}

export async function stageAll(repoId: RepoId): Promise<boolean> {
  const r = await runOp(repoId, { type: 'wip.stageAll' }).catch(() => null);
  if (r) noteEolWarnings(repoId, r.data);
  return !!r;
}

export function unstageFiles(repoId: RepoId, paths: string[]): void {
  if (paths.length) quiet(runOp(repoId, { type: 'wip.unstage', paths }));
}

/** Discard with confirmation (journaled: Undo restores, spec 06 §6.2). */
export async function discardRows(repoId: RepoId, rows: WipRow[]): Promise<void> {
  if (!rows.length) return;
  const paths = rows.map(opPathOf);
  const ok = await confirm(
    `Discard changes to ${what(rows.map((r) => r.path))}?`,
    'The changes will be discarded. You can undo this.',
    'Discard',
    true,
  );
  if (!ok) return;
  quiet(runOp(repoId, { type: 'wip.discard', paths, includeUntracked: rows.some((r) => r.untracked) }));
}

/**
 * Ignore (spec 06 §6.7): appends an escaped pattern to the root `.gitignore`; "and stop tracking" also
 * removes the files from the index. Reports "Already ignored by <file>:<line>" instead of duplicating.
 */
export async function ignoreRows(
  repoId: RepoId,
  kind: IgnoreKind,
  rows: WipRow[],
  stopTracking = false,
): Promise<void> {
  // a name that is not valid UTF-8 gets `?` for its invalid bytes (gitignore patterns match bytes)
  const patternFor = (r: WipRow): string | null =>
    r.rawKey ? rawIgnorePatternFor(kind, r.rawKey) : ignorePatternFor(kind, r.path);
  const patterns = [...new Set(rows.map(patternFor).filter((p): p is string => !!p))];
  const trackedRows = stopTracking ? rows.filter((r) => !r.untracked && r.status !== 'A') : [];
  const tracked = trackedRows.map(opPathOf);
  if (stopTracking && tracked.length) {
    const ok = await confirm(
      `Ignore and stop tracking ${what(trackedRows.map((r) => r.path))}?`,
      'The files are removed from the repository (staged deletion) but stay on disk.',
      'Stop tracking',
      true,
    );
    if (!ok) return;
  }
  for (const [i, pattern] of patterns.entries()) {
    const r = await runOp(repoId, {
      type: 'wip.ignore',
      pattern,
      ...(i === 0 && tracked.length ? { stopTracking: tracked } : {}),
    }).catch(() => null);
    if (!r) return;
    const already = (r.data as { alreadyIgnored?: { source: string; line: number; pattern: string } })
      ?.alreadyIgnored;
    if (!already && !r.warnings?.length) {
      useToastStore.getState().push({
        kind: 'success',
        title:
          tracked.length && i === 0 ? `Ignored and untracked ${pattern}` : `Added ${pattern} to .gitignore`,
      });
    }
  }
}

/** Stash only these files (spec 06 §4.3 "Stash file(s)"), via the branching module's stashFiles. */
export function stashRows(repoId: RepoId, rows: WipRow[]): void {
  stashFiles(repoId, rows.map(opPathOf));
}
