import type { FetchOutcome, GitOperation, OpResult, PushOutcome } from '@githappens/git/ops';
import type { RepoId, SerializedGitError } from '@githappens/git/types';

import { choose, confirm } from '../../components/Dialogs';
import { intInvoke } from '../../integrations/api';
import { invoke, IpcError } from '../../lib/api';
import { formatDate, shortSha } from '../../lib/format';
import { quiet, runOp, showError } from '../../lib/ops';
import { useSettingsStore } from '../../stores/settings';
import { useToastStore } from '../../stores/toasts';
import { openCreatePullRequest } from '../pr/CreatePullRequest';
import { syncInvoke, type PushPreviewResult } from './sync-api';
import {
  fetchToast,
  forcePushMessage,
  hookFailure,
  prAction,
  pullRecovery,
  pullRetryOp,
  withoutHooks,
} from './sync-model';
import styles from './Sync.module.css';

/**
 * Sync safety UX (spec 09 §4.3, §6.2, §6.4, §6.5, §6.12): fetch result toasts, Stash & Pull, diverged-pull
 * Merge / Rebase, force push with a preview of the commits that would be lost, PR links from push output and
 * the hook output modal with Retry / Retry without hooks. Called by `actions/git-actions.ts`.
 */

type PullOp = Extract<GitOperation, { type: 'pull' }>;
type PushOp = Extract<GitOperation, { type: 'push' }>;

const toast = useToastStore.getState;

/** The toolbar Pull (spec 09 §4.2): default strategy + autostash preference. */
function defaultPull(): PullOp {
  const v = useSettingsStore.getState().values;
  return {
    type: 'pull',
    strategy: v?.['git.pullMode'] ?? 'ff-if-possible',
    autostash: v?.['checkout.autostash'] === 'always',
  };
}

// ---- fetch ----

export async function runFetch(repoId: RepoId, op: Extract<GitOperation, { type: 'fetch' }>): Promise<void> {
  const r = await runOp(repoId, op);
  if (!r) return;
  const data = r.data as FetchOutcome | undefined;
  if (!data) return;
  const t = fetchToast(data);
  toast().push({ kind: 'success', title: t.title, ...(t.body ? { body: t.body } : {}) });
}

// ---- pull ----

const PULL_TOAST: Record<string, string> = {
  'up-to-date': 'Already up to date',
  'fast-forward': 'Fast-forwarded',
  merge: 'Pulled and merged',
  rebase: 'Pulled and rebased',
};

/** Pull with recovery: Stash & Pull on local changes, Merge / Rebase when ff-only can't fast-forward. */
export async function runPull(repoId: RepoId, op: PullOp): Promise<void> {
  try {
    await runOp(repoId, op, {
      successToast: (r) => PULL_TOAST[(r.data as { result?: string } | undefined)?.result ?? ''] ?? 'Pulled',
      handled: ['LocalChangesWouldBeOverwritten', 'DirtyWorktree', 'NotFastForwardable'],
    });
  } catch (e) {
    if (!(e instanceof IpcError)) return;
    const how = pullRecovery(e.code);
    if (how === 'stash') {
      const files = Array.isArray(e.error.details?.files) ? e.error.details.files : [];
      const pick = await choose({
        title: 'Local changes block the pull',
        message: (
          <>
            {e.message}
            {files.length > 0 && <pre className={styles.output}>{files.slice(0, 20).join('\n')}</pre>}
            <div className={styles.note}>
              Stash &amp; Pull stashes your changes, pulls, then re-applies them. If they conflict, the stash
              is kept.
            </div>
          </>
        ),
        choices: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'stash', label: 'Stash & Pull', primary: true },
        ],
      });
      if (pick?.value === 'stash') await runPull(repoId, pullRetryOp(op, 'stash'));
      return;
    }
    if (how === 'diverged') {
      const pick = await choose({
        title: "Can't fast-forward",
        message: (
          <>
            {e.message}
            <div className={styles.note}>Merge the remote changes into your branch, or rebase onto them.</div>
          </>
        ),
        choices: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'rebase', label: 'Rebase' },
          { value: 'merge', label: 'Merge', primary: true },
        ],
      });
      if (pick?.value === 'merge' || pick?.value === 'rebase')
        await runPull(repoId, pullRetryOp(op, pick.value));
    }
  }
}

// ---- push ----

/** Push with the full safety net: rejected → Pull / Force push…, stale lease, hook failures, PR link. */
export async function runPush(repoId: RepoId, op: PushOp, successToast?: string): Promise<OpResult | null> {
  try {
    const r = await runOp(repoId, op, {
      handled: ['PushRejectedNonFastForward', 'PushRejectedStaleLease', 'HookFailed'],
    });
    if (r) afterPush(repoId, op, r, successToast);
    return r;
  } catch (e) {
    if (!(e instanceof IpcError)) return null;
    const target = `${op.remote}/${op.remoteBranch}`;
    if (e.code === 'HookFailed') {
      const retry = await hookOutputDialog(e.error, op);
      if (retry) return runPush(repoId, retry as PushOp, successToast);
      return null;
    }
    if (e.code === 'PushRejectedStaleLease') {
      const again = await confirm(
        'The remote changed',
        `${target} moved since you last looked, so the force push was refused and nothing was overwritten. Review the remote commits again?`,
        'Review…',
      );
      if (again) return forcePush(repoId, op, successToast);
      return null;
    }
    // non-fast-forward
    const pick = await choose({
      title: 'Push rejected',
      message: `${target} has commits you don't have locally. Pull first, or force push (with lease) to overwrite them.`,
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'force', label: 'Force push…', danger: true },
        { value: 'pull', label: 'Pull', primary: true },
      ],
    });
    if (pick?.value === 'pull') {
      await runPull(repoId, defaultPull());
      return null;
    }
    if (pick?.value === 'force') return forcePush(repoId, op, successToast);
    return null;
  }
}

/**
 * Force push (spec 09 §4.3, §6.5 step 6): fresh preview of the remote branch, a confirm listing the commits
 * that would be lost, then `--force-with-lease=<ref>:<the sha shown>` (+ `--force-if-includes`).
 */
export async function forcePush(repoId: RepoId, op: PushOp, successToast?: string): Promise<OpResult | null> {
  let pv: PushPreviewResult;
  try {
    pv = await syncInvoke('git:push:preview', {
      repoId,
      localRef: op.localRef,
      remote: op.remote,
      remoteBranch: op.remoteBranch,
    });
  } catch (e) {
    if (e instanceof IpcError) showError(e.error, { repoId });
    return null;
  }
  const target = `${op.remote}/${op.remoteBranch}`;
  if (pv.wouldLose.length || pv.remoteSha) {
    const pick = await choose({
      title: pv.wouldLose.length ? 'Force push will overwrite remote commits' : 'Force push',
      message: (
        <>
          {forcePushMessage(target, pv.wouldLose.length, pv.truncated)}
          {pv.wouldLose.length > 0 && (
            <ul className={styles.lost} aria-label="Commits that would be lost">
              {pv.wouldLose.map((c) => (
                <li key={c.sha}>
                  <span className={styles.sha}>{shortSha(c.sha)}</span>
                  <span className={styles.subject} title={c.subject}>
                    {c.subject}
                  </span>
                  <span className={styles.author}>
                    {c.authorName} · {formatDate(c.authorTime)}
                  </span>
                </li>
              ))}
              {pv.truncated && <li>…and more</li>}
            </ul>
          )}
          <div className={styles.note}>
            The push only succeeds if {target} is still at{' '}
            {pv.remoteSha ? shortSha(pv.remoteSha) : '(absent)'}.
          </div>
        </>
      ),
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'pull', label: 'Pull instead' },
        { value: 'force', label: 'Force Push', danger: true, primary: !pv.wouldLose.length },
      ],
    });
    if (pick?.value === 'pull') {
      await runPull(repoId, defaultPull());
      return null;
    }
    if (pick?.value !== 'force') return null;
  }
  return runPush(
    repoId,
    { ...op, force: 'lease', expectedRemoteSha: pv.leaseSha, forceIfIncludes: true },
    successToast ?? `Force pushed ${op.localRef} to ${target}`,
  );
}

function afterPush(repoId: RepoId, op: PushOp, r: OpResult, successToast?: string): void {
  const data = r.data as PushOutcome | undefined;
  const title = successToast ?? r.summary ?? `Pushed ${op.localRef}`;
  const warnings = r.warnings?.filter(Boolean) ?? [];
  const hint = data?.prUrlHint;
  const base = { kind: 'success' as const, title, ...(warnings.length ? { body: warnings.join('\n') } : {}) };
  if (!hint) {
    toast().push(base);
    return;
  }
  const head = op.localRef.replace(/^refs\/heads\//, '');
  const id = toast().push({ ...base, timeoutMs: 15_000 });
  void intInvoke('provider:resolveRemotes', { repoId })
    .catch(() => [])
    .then((linked) => {
      const a = prAction(hint, op.remote, linked);
      if (!a) return;
      toast().dismiss(id);
      toast().push({
        ...base,
        timeoutMs: 15_000,
        actions: [
          {
            label: 'Create pull request',
            run: () =>
              a.kind === 'in-app'
                ? openCreatePullRequest(repoId, { headBranch: op.remoteBranch || head })
                : void invoke('shell:openExternal', { url: a.url }).catch(() => undefined),
          },
        ],
      });
    });
}

// ---- hooks ----

/**
 * Hook output modal (spec 09 §4.3 "Hook output"): the hook's output with Retry / Retry without hooks / Close.
 * Resolves to the op to re-run (or null). Exported so commit / other hook-running flows can reuse it.
 */
export async function hookOutputDialog(
  err: SerializedGitError,
  op: GitOperation,
): Promise<GitOperation | null> {
  const f = hookFailure(err, op);
  if (!f) return null;
  const skip = withoutHooks(op);
  const pick = await choose({
    title: `${f.hook} hook failed`,
    message: (
      <>
        The {f.hook} hook stopped the {op.type.split('.')[0]}. Its output:
        <pre className={styles.output} aria-label="Hook output">
          {f.output || '(no output)'}
        </pre>
        {skip && op.type.startsWith('push') && (
          <div className={styles.note}>
            Retrying without hooks also skips the Git LFS upload done by its pre-push hook.
          </div>
        )}
      </>
    ),
    choices: [
      { value: 'close', label: 'Close' },
      ...(skip ? [{ value: 'skip', label: 'Retry without hooks', danger: true }] : []),
      { value: 'retry', label: 'Retry', primary: true },
    ],
  });
  if (pick?.value === 'retry') return op;
  if (pick?.value === 'skip' && skip) return skip;
  return null;
}

/** Run any op; a HookFailed result opens the hook output modal (Retry / Retry without hooks). */
export async function runWithHookModal(
  repoId: RepoId,
  op: GitOperation,
  o: Parameters<typeof runOp>[2] = {},
): Promise<OpResult | null> {
  try {
    return await runOp(repoId, op, { ...o, handled: [...(o.handled ?? []), 'HookFailed'] });
  } catch (e) {
    if (!(e instanceof IpcError) || e.code !== 'HookFailed') throw e;
    const next = await hookOutputDialog(e.error, op);
    return next ? runWithHookModal(repoId, next, o) : null;
  }
}

/** Fire-and-forget helpers for menus / toolbar. */
export const pushQuiet = (repoId: RepoId, op: PushOp, successToast?: string): void =>
  quiet(runPush(repoId, op, successToast));
