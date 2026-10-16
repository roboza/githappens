import type { GitOperation, OpResult } from '@githappens/git/ops';
import type { GitErrorCode, RepoId, SerializedGitError } from '@githappens/git/types';

import { confirm } from '../components/Dialogs';
import { useRepoUiStore } from '../stores/repo-ui';
import { useToastStore, type ToastAction, type ToastDetails } from '../stores/toasts';
import { invoke, IpcError } from './api';
import { lockDialogText } from './lock-dialog';

const CONFLICT_CODES = new Set<GitErrorCode>([
  'MergeConflict',
  'RebaseConflict',
  'CherryPickConflict',
  'RevertConflict',
  'StashConflict',
]);

export const isConflict = (e: unknown): boolean => e instanceof IpcError && CONFLICT_CODES.has(e.code);

export interface RunOpOptions {
  /** Toast on success (e.g. "Pushed main to origin"). */
  successToast?: string | ((r: OpResult) => string);
  /** Buttons on the success toast (e.g. Undo). */
  successActions?: ToastAction[];
  /** Error codes the caller handles itself (re-thrown without a toast). */
  handled?: GitErrorCode[];
}

/**
 * Run a mutating op (spec 02 `git:op:run`) with the shared error UX:
 * lock dialog with "Delete lock & retry" (§6.13), conflicts as an expected outcome
 * (§5.2), and readable error toasts with the git command and stderr excerpt (spec 01 §4.10).
 */
export async function runOp(
  repoId: RepoId,
  op: GitOperation,
  o: RunOpOptions = {},
): Promise<OpResult | null> {
  for (;;) {
    try {
      const r = await invoke('git:op:run', { repoId, op });
      if (o.successToast) {
        const title = typeof o.successToast === 'function' ? o.successToast(r) : o.successToast;
        useToastStore.getState().push({
          kind: 'success',
          title,
          body: r.warnings?.join('\n'),
          actions: o.successActions,
          // long enough to reach an Undo
          ...(o.successActions?.length ? { timeoutMs: 10_000 } : {}),
        });
      } else if (r.warnings?.length) {
        useToastStore
          .getState()
          .push({ kind: 'warning', title: 'Completed with warnings', body: r.warnings.join('\n') });
      }
      return r;
    } catch (e) {
      if (!(e instanceof IpcError)) throw e;
      const err = e.error;
      if (o.handled?.includes(err.code)) throw e;
      if (
        (err.code === 'IndexLocked' || err.code === 'RefLocked') &&
        typeof err.details?.lockPath === 'string'
      ) {
        const lockPath = err.details.lockPath;
        const retry = await confirm(
          'Repository is locked',
          lockDialogText(err.details),
          'Delete lock & retry',
          true,
        );
        if (!retry) return null;
        await invoke('git:lock:remove', { repoId, lockPath });
        continue;
      }
      if (err.code === 'Cancelled' || err.code === 'AuthCancelled') return null;
      if (CONFLICT_CODES.has(err.code)) {
        // Show the working tree so the conflict list (spec 08 §4.2) is right there.
        useRepoUiStore.getState().select(repoId, { kind: 'wip' });
        const files = Array.isArray(err.details?.files) ? err.details.files : [];
        useToastStore.getState().push({
          kind: 'warning',
          title: err.message,
          body: files.length
            ? `Conflicted files:\n${files.slice(0, 8).join('\n')}${files.length > 8 ? '\n…' : ''}`
            : 'Open a conflicted file from the right panel to resolve it in the merge tool.',
        });
        throw e;
      }
      showError(err, { repoId, retry: () => quiet(runOp(repoId, op, o)) });
      throw e;
    }
  }
}

/**
 * Error toast (spec 01 §4.10): message, git command + first 5 stderr lines, and up to two actions —
 * "Details" (full command + output, from the git output log) and "Retry" when the caller can re-run it.
 * Identical failures coalesce (×N).
 */
export function showError(err: SerializedGitError, ctx: { repoId?: RepoId; retry?: () => void } = {}): void {
  const excerpt = err.stderr.split(/\r?\n/).filter(Boolean).slice(0, 5).join('\n');
  const details: ToastDetails = {
    command: err.command,
    output: err.stderr,
    repoId: ctx.repoId,
    opId: err.opId,
  };
  useToastStore.getState().push({
    kind: 'error',
    key: `error|${err.code}|${err.message}|${err.command}`,
    title: err.message,
    body: [err.command, excerpt].filter(Boolean).join('\n'),
    details,
    actions: [
      {
        label: 'Details',
        keepOpen: true,
        run: () =>
          useToastStore.getState().showDetails({
            id: `details-${err.opId ?? 'error'}`,
            key: err.code,
            kind: 'error',
            title: err.message,
            details,
            count: 1,
            at: Date.now(),
            read: true,
          }),
      },
      ...(ctx.retry ? [{ label: 'Retry', run: ctx.retry }] : []),
    ],
  });
}

/** Swallow already-reported failures in fire-and-forget UI handlers. */
export const quiet = (p: Promise<unknown>): void => {
  p.catch(() => undefined);
};
