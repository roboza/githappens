import type { RepoId } from '@githappens/git/types';

import { choose, confirm } from '../../components/Dialogs';
import type { MenuEntry } from '../../components/ContextMenu';
import { invoke, IpcError } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useToastStore } from '../../stores/toasts';
import { undoInvoke } from './api';

/**
 * Undo / redo UX (spec 05 §4.7): toast with a Redo link, an explanatory dialog when the journal refuses (drift),
 * the reflog fallback when the journal is empty, and the History popover entries.
 */

const UNDO_TOAST_MS = 5_000;

/** Offer to move HEAD's branch back to its previous reflog position. Resolves true when it ran. */
export async function restoreFromReflog(repoId: RepoId, intro: string): Promise<boolean> {
  const fb = await undoInvoke('undo:reflog', { repoId }).catch(() => null);
  if (!fb) {
    if (intro) await confirm('Nothing to undo', intro, 'OK');
    return false;
  }
  const what = fb.subject ? ` (before "${fb.subject}")` : '';
  const ok = await confirm(
    `Restore ${fb.selector}?`,
    `${intro ? `${intro} ` : ''}The reflog has an earlier position: ${fb.selector} at ${shortSha(fb.sha)}${what}. Move ${
      fb.selector.split('@')[0]
    } back there? Local changes are kept; you can undo this.`,
    `Restore ${fb.selector}`,
  );
  if (!ok) return false;
  await runOp(
    repoId,
    { type: 'reflog.restore', target: fb.sha, selector: fb.selector },
    { successToast: `Restored ${fb.selector} (${shortSha(fb.sha)})` },
  ).catch(() => null);
  return true;
}

async function explainFailure(repoId: RepoId, e: unknown): Promise<void> {
  const message = e instanceof IpcError ? e.message : String(e);
  const pick = await choose({
    title: "Can't undo safely",
    message: `${message}\n\nThe repository changed since that action, so GitHappens won't force it.`,
    choices: [
      { value: 'reflog', label: 'Show reflog option' },
      { value: 'ok', label: 'OK', primary: true },
    ],
  });
  if (pick?.value === 'reflog')
    await restoreFromReflog(repoId, 'The reflog may still have the state you want.');
}

export async function undo(repoId: RepoId): Promise<void> {
  const peek = await invoke('git:undo:peek', { repoId });
  if (!peek.undo) {
    if (peek.blockedBy) await confirm('Nothing to undo', peek.blockedBy, 'OK');
    else await restoreFromReflog(repoId, 'There is nothing to undo in the journal.');
    return;
  }
  const label = peek.undo.label;
  try {
    await runOp(repoId, { type: 'undo.run' }, { handled: ['Unknown'] });
  } catch (e) {
    if (e instanceof IpcError && e.code === 'Unknown') await explainFailure(repoId, e);
    return;
  }
  useToastStore.getState().push({
    kind: 'success',
    title: `Undid: ${label}`,
    timeoutMs: UNDO_TOAST_MS,
    actions: [{ label: 'Redo', run: () => void redo(repoId) }],
  });
}

export async function redo(repoId: RepoId): Promise<void> {
  const peek = await invoke('git:undo:peek', { repoId });
  if (peek.redo) quiet(runOp(repoId, { type: 'redo.run' }, { successToast: `Redid: ${peek.redo.label}` }));
}

/** Run undo (or redo) `n` times in a row, stopping at the first failure. */
async function repeat(repoId: RepoId, type: 'undo.run' | 'redo.run', n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const ok = await runOp(repoId, { type }, i === n - 1 ? { successToast: (r) => r.summary ?? 'Done' } : {})
      .then(Boolean)
      .catch(() => false);
    if (!ok) return;
  }
}

const ago = (ts: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

/**
 * History popover (spec 05 §4.7 "our extension"): the last 20 journal entries, newest first. Picking an undone
 * entry redoes up to it; picking a done entry undoes everything above it and it. Barriers are not clickable.
 */
export async function undoHistoryMenu(repoId: RepoId): Promise<MenuEntry[]> {
  const list = await undoInvoke('undo:list', { repoId, limit: 20 }).catch(() => []);
  if (!list.length) {
    return [
      { label: 'No undo history yet', disabled: true },
      'separator',
      { label: 'Restore from reflog…', onSelect: () => void restoreFromReflog(repoId, '') },
    ];
  }
  const redoable = list.filter((e) => e.status === 'undone');
  const done = list.filter((e) => e.status === 'done');
  const items: MenuEntry[] = [];
  // redo stack: newest-undone first in the list; the lowest one is redone first
  redoable.forEach((e, i) => {
    const steps = redoable.length - i;
    items.push({
      label: `↷ ${e.label} · ${ago(e.ts)}`,
      title: `Redo ${steps === 1 ? 'this action' : `${steps} actions`}`,
      onSelect: () => void repeat(repoId, 'redo.run', steps),
    });
  });
  if (redoable.length && done.length) items.push('separator');
  let blocked = false;
  done.forEach((e, i) => {
    if (!e.undoable) blocked = true;
    items.push({
      label: `${e.undoable ? '↶' : '⛔'} ${e.label} · ${ago(e.ts)}`,
      disabled: blocked,
      title: blocked
        ? e.undoable
          ? 'An earlier network action blocks undo past this point'
          : `Cannot undo past ${e.label}`
        : `Undo ${i === 0 ? 'this action' : `the last ${i + 1} actions`}`,
      onSelect: blocked ? undefined : () => void repeat(repoId, 'undo.run', i + 1),
    });
  });
  items.push('separator', {
    label: 'Restore from reflog…',
    onSelect: () => void restoreFromReflog(repoId, ''),
  });
  return items;
}
