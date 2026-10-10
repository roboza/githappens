import type { RepoId } from '@githappens/git/types';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  GitflowConfig,
  GitflowFinishKind,
  GitflowSettings,
} from '../../../../shared/ipc/gitflow-contract';
import { IpcError } from '../../lib/api';
import { quiet, runOp } from '../../lib/ops';
import { useRefs, useRemotes } from '../../repo/queries';
import styles from './GitFlow.module.css';
import {
  canRebase,
  DEFAULT_GITFLOW_SETTINGS,
  defaultFinishChoices,
  finishError,
  finishOp,
  finishPushOps,
  finishTarget,
  flowName,
  initialSettings,
  isTaggedKind,
  KIND_TITLE,
  pickRemote,
  validateSettings,
  type FinishChoices,
} from './helpers';
import { confirmResetGitflow } from './reset';

/** Modal shell (native <dialog>: focus trap + Esc) shared by the Git Flow dialogs. */
function DialogShell({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 className={styles.title}>{title}</h2>
      {children}
    </dialog>
  );
}

const SETTING_FIELDS: { key: keyof GitflowSettings; label: string; placeholder?: string }[] = [
  { key: 'production', label: 'Production branch' },
  { key: 'develop', label: 'Development branch' },
  { key: 'feature', label: 'Feature prefix' },
  { key: 'release', label: 'Release prefix' },
  { key: 'hotfix', label: 'Hotfix prefix' },
  { key: 'bugfix', label: 'Bugfix prefix' },
  { key: 'support', label: 'Support prefix' },
  { key: 'versionTag', label: 'Version tag prefix', placeholder: '(none)' },
];

/**
 * Initialize Git Flow (spec 12 §4.9; also used by Preferences → Gitflow): branch names, prefixes and the
 * version tag prefix. Initializing creates develop from the production branch when it is missing.
 */
export function GitFlowInitDialog({
  repoId,
  config,
  onClose,
}: {
  repoId: RepoId;
  /** Current config (re-initialize), or null for a fresh setup. */
  config: GitflowConfig | null;
  onClose(): void;
}) {
  const refs = useRefs(repoId).data;
  const locals = useMemo(
    () => (refs ?? []).filter((r) => r.type === 'local').map((r) => r.shortName),
    [refs],
  );
  // until the user edits, follow the defaults (refs may arrive after the first render: main/master)
  const [edited, setEdited] = useState<GitflowSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const s = edited ?? initialSettings(config, locals);
  const errors = validateSettings(s);
  const invalid = Object.keys(errors).length > 0;
  const developMissing = !locals.includes(s.develop.trim());

  const submit = async (): Promise<void> => {
    if (invalid) return;
    setBusy(true);
    try {
      const r = await runOp(
        repoId,
        { type: 'gitflow.init', ...s },
        { successToast: (x) => x.summary ?? 'Initialized Git Flow' },
      );
      if (r) onClose();
    } catch {
      /* reported by runOp */
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={config ? 'Git Flow settings' : 'Initialize Git Flow'} onClose={onClose}>
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={styles.grid}>
          {SETTING_FIELDS.map((f) => (
            <FieldRow key={f.key} label={f.label} error={errors[f.key]}>
              <input
                className={`${styles.input} ${errors[f.key] ? styles.invalid : ''}`}
                aria-label={f.label}
                placeholder={f.placeholder}
                value={s[f.key]}
                list={
                  f.key === 'production' || f.key === 'develop' ? `gitflow-branches-${repoId}` : undefined
                }
                onChange={(e) => setEdited({ ...s, [f.key]: e.target.value })}
              />
            </FieldRow>
          ))}
        </div>
        <datalist id={`gitflow-branches-${repoId}`}>
          {locals.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        {developMissing && !errors.develop && (
          <p className={styles.hint}>
            {s.develop.trim()} does not exist yet; it will be created from {s.production.trim()}.
          </p>
        )}
        <div className={styles.buttons}>
          <button
            type="button"
            onClick={() =>
              setEdited({ ...DEFAULT_GITFLOW_SETTINGS, production: initialSettings(null, locals).production })
            }
          >
            Reset to defaults
          </button>
          {config && (
            <button
              type="button"
              className={styles.danger}
              disabled={busy}
              title="Remove all gitflow.* settings from this repository"
              onClick={() => void confirmResetGitflow(repoId).then((done) => done && onClose())}
            >
              Remove configuration…
            </button>
          )}
          <span className={styles.spacer} />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || invalid}>
            Initialize
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function FieldRow({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.label}>{label}</span>
      {children}
      {error && <span className={styles.fieldError}>{error}</span>}
    </>
  );
}

/**
 * Finish a flow branch (spec 12 §4.9). Feature/bugfix: rebase on develop, delete, push develop.
 * Release/hotfix: tag name (prefilled), tag message (required), delete, push production/develop/tag. A
 * hotfix goes into the open release branch instead of develop when exactly one exists (AVH). The finish is
 * one undoable op; pushes run afterwards as normal push ops.
 */
export function GitFlowFinishDialog({
  repoId,
  config,
  kind,
  branch,
  releases = [],
  onClose,
}: {
  repoId: RepoId;
  config: GitflowConfig;
  kind: GitflowFinishKind;
  /** Full branch name, e.g. `release/1.2`. */
  branch: string;
  /** Local release branches (a hotfix finishes into the single open one instead of develop). */
  releases?: readonly string[];
  onClose(): void;
}) {
  const name = flowName(branch, config[kind]);
  const tagged = isTaggedKind(kind);
  const target = finishTarget(config, kind, releases);
  const [c, setC] = useState<FinishChoices>(() => defaultFinishChoices(config, kind, name));
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRefs(repoId).data ?? [];
  const remote = pickRemote((useRemotes(repoId).data ?? []).map((r) => r.name));
  const behind = refs.filter(
    (r) =>
      r.type === 'local' &&
      (r.shortName === target || (tagged && r.shortName === config.production)) &&
      (r.upstream?.behind ?? 0) > 0,
  );
  const validation = finishError(kind, c);
  const set = (patch: Partial<FinishChoices>): void => {
    setC((prev) => ({ ...prev, ...patch }));
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (validation) return;
    setBusy(true);
    setError(null);
    try {
      const r = await runOp(repoId, finishOp(kind, name, c), {
        successToast: (x) => x.summary ?? `Finished ${branch}`,
        handled: ['Unknown', 'TagAlreadyExists', 'DirtyWorktree', 'EmptyCommitMessage', 'InvalidRefName'],
      });
      if (!r) return;
      onClose();
      if (c.push && remote) {
        for (const op of finishPushOps(config, kind, c.tagName, remote, target)) {
          if (!(await runOp(repoId, op, { successToast: (x) => x.summary ?? 'Pushed' }))) break;
        }
      }
    } catch (e) {
      if (e instanceof IpcError && !['MergeConflict', 'RebaseConflict'].includes(e.code)) {
        const hint = typeof e.error.details?.hint === 'string' ? e.error.details.hint : undefined;
        setError({ message: e.message, hint });
      } else onClose(); // conflicts: the section shows the paused finish (runOp toasted the files)
    } finally {
      setBusy(false);
    }
  };

  const createDevelop = (): void =>
    quiet(
      runOp(
        repoId,
        { type: 'branch.create', name: config.develop, startPoint: config.production, checkout: false },
        { successToast: `Created ${config.develop}` },
      ).then(() => setError(null)),
    );

  return (
    <DialogShell title={`Finish ${KIND_TITLE[kind]} ${name}`} onClose={onClose}>
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          quiet(submit());
        }}
      >
        <p className={styles.hint}>
          {!tagged
            ? `Merges ${branch} into ${config.develop}.`
            : `Merges ${branch} into ${config.production}, tags it and merges it into ${target}.`}
          {target !== config.develop &&
            ` ${target} is open, so the hotfix goes there instead of ${config.develop}; finishing the release brings it to ${config.develop}.`}
        </p>
        {canRebase(kind) ? (
          <label className={styles.check}>
            <input type="checkbox" checked={c.rebase} onChange={(e) => set({ rebase: e.target.checked })} />
            Rebase on {config.develop} before merging
          </label>
        ) : (
          <div className={styles.grid}>
            <FieldRow label="Tag name">
              <input
                className={styles.input}
                aria-label="Tag name"
                value={c.tagName}
                onChange={(e) => set({ tagName: e.target.value })}
              />
            </FieldRow>
            <FieldRow label="Tag message">
              <textarea
                className={styles.input}
                aria-label="Tag message"
                rows={4}
                autoFocus
                placeholder="Required"
                value={c.tagMessage}
                onChange={(e) => set({ tagMessage: e.target.value })}
              />
            </FieldRow>
          </div>
        )}
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={c.deleteBranch}
            onChange={(e) => set({ deleteBranch: e.target.checked })}
          />
          Delete {branch} after finishing
        </label>
        <label className={styles.check} title={remote ? undefined : 'This repository has no remotes'}>
          <input
            type="checkbox"
            disabled={!remote}
            checked={c.push && !!remote}
            onChange={(e) => set({ push: e.target.checked })}
          />
          {tagged ? `Push ${config.production}, ${target} and tags` : `Push ${config.develop}`}
          {remote ? ` to ${remote}` : ''}
        </label>
        {behind.length > 0 && (
          <p className={styles.hint}>
            {behind.map((r) => r.shortName).join(' and ')} {behind.length === 1 ? 'is' : 'are'} behind the
            remote. Consider fetching and pulling first.
          </p>
        )}
        {(error || (validation && tagged && c.tagMessage !== '')) && (
          <p className={styles.error} role="alert">
            {error?.message ?? validation}
          </p>
        )}
        <div className={styles.buttons}>
          {error?.hint === 'gitflow.createDevelop' && (
            <button type="button" onClick={createDevelop}>
              Create {config.develop}
            </button>
          )}
          <span className={styles.spacer} />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !!validation}>
            Finish {KIND_TITLE[kind]}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
