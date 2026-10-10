import type { GitOperation } from '@githappens/git/ops';
import type { RepoId, RepoOperationState } from '@githappens/git/types';
import { useQueryClient } from '@tanstack/react-query';
import { GitMerge, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { confirm } from '../../components/Dialogs';
import { invoke } from '../../lib/api';
import { shortSha } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useIsRunning } from '../../stores/ops';
import { useRepoUiStore } from '../../stores/repo-ui';
import { useToastStore } from '../../stores/toasts';
import {
  clearMergeSessions,
  conflictKeys,
  setMergeSession,
  unsavedMergePaths,
  useConflictState,
} from './conflict-queries';
import {
  ABORT,
  bannerModel,
  BANNER_OPS,
  describeOperation,
  DONE_TOAST,
  NEXT_TOAST,
  OP_NOUN,
  SKIP,
} from './banner-model';
import { useConflictBadgeScope } from './prediction';
import styles from './OperationBanner.module.css';

function leaveMergeTool(repoId: RepoId): void {
  const ui = useRepoUiStore.getState();
  if (ui.get(repoId).center.kind === 'merge') ui.update(repoId, () => ({ center: { kind: 'graph' } }));
}

/** "stash@{n} was kept, drop it?" once a conflicted stash apply/pop has been fully resolved (spec 08 §6.7). */
function offerStashDrop(repoId: RepoId, stash: NonNullable<RepoOperationState['stash']>): void {
  useToastStore.getState().push({
    kind: 'info',
    key: `stash-kept|${stash.sha}`,
    title: `stash@{${stash.index}} was kept`,
    body: 'The stash is not dropped automatically after a conflicted apply. Drop it now that the changes are resolved?',
    timeoutMs: null,
    actions: [
      {
        label: 'Drop stash',
        run: () =>
          quiet(
            runOp(
              repoId,
              { type: 'stash.drop', index: stash.index, sha: stash.sha },
              { successToast: `Dropped stash@{${stash.index}}` },
            ),
          ),
      },
      { label: 'Keep', run: () => undefined },
    ],
  });
}

/**
 * In-progress operation banner (spec 05 §4.1 `OperationBanner`, spec 08 §4.2 `ConflictBanner`):
 * merge / rebase / cherry-pick / revert / stash apply / am status with Continue, Skip, Abort (or "Reset
 * conflicted changes" for stash applies) and "Mark all resolved". Renders nothing when no operation is in
 * progress.
 */
export function OperationBanner({ repoId }: { repoId: RepoId }) {
  const qc = useQueryClient();
  const state = useConflictState(repoId);
  const busy = useIsRunning(repoId, BANNER_OPS);
  useConflictBadgeScope(repoId);
  const s = state.data;

  // stash-apply resolved → offer to drop the kept stash (the op disappears once nothing is unmerged)
  const prev = useRef<RepoOperationState | undefined>(undefined);
  const resetting = useRef(false);
  useEffect(() => {
    const before = prev.current;
    prev.current = s;
    if (!s || !before) return;
    if (before.op === 'stash-apply' && before.stash && s.op === null && !resetting.current) {
      void invoke('git:stash:list', { repoId })
        .then((list) => {
          const still = list.find((x) => x.sha === before.stash!.sha);
          if (still) offerStashDrop(repoId, { index: still.index, sha: still.sha, message: still.message });
        })
        .catch(() => undefined);
    }
    if (s.op === null) resetting.current = false;
  }, [s, repoId]);

  if (!s?.op) return null;
  const op = s.op;
  const m = bannerModel(s);

  const refresh = (): void => void qc.invalidateQueries({ queryKey: conflictKeys.state(repoId) });
  const run = async (o: GitOperation, toast?: string, after?: () => void): Promise<boolean> => {
    try {
      const r = await runOp(repoId, o, { successToast: toast });
      if (r) after?.();
      return !!r;
    } finally {
      refresh();
    }
  };

  /** After Continue / Skip: "Rebase complete" when done, else the next step (spec 08 §6.7). */
  const reportStep = async (): Promise<void> => {
    const next = await invoke('git:conflict:state', { repoId }).catch(() => null);
    if (!next) return;
    const done = next.op !== op;
    const title = done ? DONE_TOAST[op] : NEXT_TOAST[op];
    if (!title) return;
    const step = !done && next.rebase?.total ? ` — step ${next.rebase.step}/${next.rebase.total}` : '';
    useToastStore.getState().push({
      kind: done ? 'success' : next.conflicts.length ? 'warning' : 'info',
      title: `${title}${step}`,
      ...(!done && next.conflicts.length
        ? {
            body: `${next.conflicts.length} conflicted file${next.conflicts.length === 1 ? '' : 's'} in the next step.`,
          }
        : {}),
    });
  };

  const onContinue = async (): Promise<void> => {
    if (op === 'merge') {
      // spec 08 §4.2 / spec 06: Continue focuses the commit composer, prefilled from MERGE_MSG
      leaveMergeTool(repoId);
      useRepoUiStore.getState().select(repoId, { kind: 'wip' });
      useToastStore.getState().push({
        kind: 'info',
        title: 'Commit the merge',
        body: 'The commit message is prefilled from MERGE_MSG — review it in the commit panel and commit.',
      });
      return;
    }
    const o: GitOperation =
      op === 'rebase'
        ? { type: 'rebase.continue' }
        : op === 'am'
          ? { type: 'am.continue' }
          : { type: 'sequencer.continue' };
    const ok = await run(o, undefined, () => {
      clearMergeSessions(repoId);
      leaveMergeTool(repoId);
    });
    if (ok) await reportStep();
  };

  const onSkip = async (): Promise<void> => {
    const o = SKIP[op];
    if (!o) return;
    const what =
      op === 'rebase' && s.rebase?.currentCommit
        ? shortSha(s.rebase.currentCommit.sha)
        : op === 'am'
          ? 'this patch'
          : 'this commit';
    const ok = await confirm(
      `Skip ${what}?`,
      `The changes of ${what} will not be applied and any resolutions made for it are lost.`,
      op === 'am' ? 'Skip patch' : 'Skip commit',
      true,
    );
    if (!ok) return;
    const done = await run(o, undefined, () => {
      clearMergeSessions(repoId);
      leaveMergeTool(repoId);
    });
    if (done) await reportStep();
  };

  const onAbort = async (): Promise<void> => {
    const unsaved = unsavedMergePaths(repoId);
    const unsavedNote = unsaved.length > 0 && (
      <>
        <br />
        <br />
        Unsaved merge-tool changes in {unsaved.length} file{unsaved.length === 1 ? '' : 's'} will be
        discarded.
      </>
    );
    if (op === 'stash-apply') {
      const ok = await confirm(
        'Reset conflicted changes?',
        <>
          Stash applies have no abort: this runs <code>git reset --merge</code>, which discards the conflicted
          changes from the stash (your other uncommitted changes are kept). The stash
          {s.stash ? ` stash@{${s.stash.index}}` : ''} itself is kept, so you can apply it again.
          {unsavedNote}
        </>,
        'Reset conflicted changes',
        true,
      );
      if (!ok) return;
      resetting.current = true;
      await run({ type: 'conflict.resetMerge' }, 'Conflicted changes reset — the stash was kept', () => {
        clearMergeSessions(repoId);
        leaveMergeTool(repoId);
      });
      return;
    }
    const o = ABORT[op];
    if (!o) return;
    const ok = await confirm(
      `Abort the ${OP_NOUN[op]}?`,
      <>
        All resolutions will be lost and the repository returns to its state before the {OP_NOUN[op]}.
        {unsavedNote}
      </>,
      `Abort ${OP_NOUN[op]}`,
      true,
    );
    if (!ok) return;
    await run(o, `${OP_NOUN[op][0]!.toUpperCase()}${OP_NOUN[op].slice(1)} aborted`, () => {
      clearMergeSessions(repoId);
      leaveMergeTool(repoId);
    });
  };

  const onMarkAll = async (): Promise<void> => {
    const paths = s.conflicts.map((c) => c.path);
    const unsaved = unsavedMergePaths(repoId).filter((p) => paths.includes(p));
    if (
      unsaved.length &&
      !(await confirm(
        'Unsaved merge-tool changes',
        `${unsaved.join(', ')} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes in the merge tool that will be discarded. Mark everything resolved as it is on disk?`,
        'Mark all resolved',
      ))
    )
      return;
    for (const p of paths) setMergeSession(repoId, p, null);
    await run(
      { type: 'conflict.markResolved', paths },
      `Marked ${paths.length} file${paths.length === 1 ? '' : 's'} resolved`,
      () => leaveMergeTool(repoId),
    );
  };

  const conflicts = s.conflicts.length;
  return (
    <div className={`${styles.banner} ${conflicts ? styles.conflicted : ''}`} role="status">
      {conflicts ? (
        <TriangleAlert size={16} className={styles.icon} aria-hidden />
      ) : (
        <GitMerge size={16} className={styles.icon} aria-hidden />
      )}
      <div className={styles.text}>
        <span className={styles.title} title={describeOperation(s)}>
          {describeOperation(s)}
        </span>
        <span className={styles.status}>{m.status}</span>
        {op === 'stash-apply' && (
          <span className={styles.status}>
            Resolve and stage the files; the stash was kept and can be dropped afterwards.
          </span>
        )}
      </div>
      <div className={styles.buttons}>
        {m.abort && (
          <button type="button" className={styles.danger} disabled={busy} onClick={() => quiet(onAbort())}>
            {m.abort === 'reset' ? 'Reset conflicted changes' : 'Abort'}
          </button>
        )}
        {m.skip && (
          <button type="button" disabled={busy} onClick={() => quiet(onSkip())}>
            Skip
          </button>
        )}
        {m.markAll && (
          <button
            type="button"
            disabled={busy}
            title="Every conflicted file is free of conflict markers"
            onClick={() => quiet(onMarkAll())}
          >
            Mark all resolved
          </button>
        )}
        {m.continueLabel && (
          <button
            type="button"
            className="primary"
            disabled={busy || !m.canContinue}
            title={!m.canContinue ? 'Resolve all conflicted files first' : undefined}
            onClick={() => quiet(onContinue())}
          >
            {m.continueLabel}
          </button>
        )}
      </div>
    </div>
  );
}
