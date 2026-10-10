import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { errorLine, intInvoke } from '../../integrations/api';
import { branchNameForIssue } from '../../integrations/helpers';
import { defaultTransition, issueRefOf, validateBranchName } from '../../integrations/issue-helpers';
import { ik, invalidateIssue, useIssueTransitions } from '../../integrations/queries';
import { invoke } from '../../lib/api';
import { qk } from '../../repo/queries';
import { useToastStore } from '../../stores/toasts';
import type { BranchRequest } from './issue-store';
import s from './IssueDetail.module.css';

/** Native modal <dialog> shell shared by the issue dialogs (Esc / backdrop cancel). */
export function DialogShell({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 className={s.dialogTitle}>{title}</h2>
      {children}
    </dialog>
  );
}

/**
 * CreateBranchFromIssueDialog (spec 10 §4.9): branch name (prefilled `{key}-{slug}`), base ref,
 * Checkout / Transition issue to … / Assign to me → `issues:createBranch` (which also links the branch).
 */
export function CreateBranchFromIssueDialog({ req, onClose }: { req: BranchRequest; onClose(): void }) {
  const { repoId, issue, integrationKey } = req;
  const { scope } = issue.tracker;
  const qc = useQueryClient();
  const [name, setName] = useState(() => branchNameForIssue(issue));
  const [base, setBase] = useState(req.base);
  const [checkout, setCheckout] = useState(true);
  const [doTransition, setDoTransition] = useState(false);
  const [transitionId, setTransitionId] = useState<string>('');
  const [assignSelf, setAssignSelf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refs = useQuery({
    queryKey: qk.refs(repoId),
    queryFn: () => invoke('git:refs', { repoId }),
  });
  const locals = useMemo(
    () => (refs.data ?? []).filter((r) => r.type === 'local').map((r) => r.shortName),
    [refs.data],
  );
  const transitions = useIssueTransitions(integrationKey, scope, issue.key);
  const tList = transitions.data ?? [];
  const selectedTransition = transitionId || defaultTransition(tList)?.id || tList[0]?.id || '';

  const submit = async (): Promise<void> => {
    const branchName = name.trim();
    const local = validateBranchName(branchName);
    if (local) return setError(local);
    if (locals.includes(branchName)) return setError(`A branch named "${branchName}" already exists.`);
    if (!base.trim()) return setError('Choose a base branch or ref.');
    setBusy(true);
    try {
      const v = await invoke('git:branch:validateName', { repoId, name: branchName }).catch(() => null);
      if (v && !v.valid) {
        setError(v.reason ?? 'Invalid branch name.');
        return;
      }
      const res = await intInvoke('issues:createBranch', {
        repoId,
        issue: issueRefOf(issue, integrationKey),
        branchName,
        base: base.trim(),
        checkout,
        transitionId: doTransition && selectedTransition ? selectedTransition : undefined,
        assignSelf: assignSelf || undefined,
      });
      const warnings = res.warnings?.filter(Boolean) ?? [];
      useToastStore.getState().push({
        kind: warnings.length ? 'warning' : 'success',
        title: `Created ${res.branch}`,
        body: [`Linked to ${issue.key}`, ...warnings].join('\n'),
      });
      void qc.invalidateQueries({ queryKey: ik.issueLinks(repoId) });
      void qc.invalidateQueries({ queryKey: qk.refs(repoId) });
      void qc.invalidateQueries({ queryKey: qk.info(repoId) });
      invalidateIssue(qc, integrationKey, scope, issue.key);
      onClose();
    } catch (e) {
      setError(errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  const baseOptions = locals.includes(req.base) ? locals : [req.base, ...locals];

  return (
    <DialogShell title={`Create branch for ${issue.key}`} onCancel={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="kl-issue-branch-name">Branch name</label>
        <input
          id="kl-issue-branch-name"
          autoFocus
          className={s.input}
          value={name}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <label htmlFor="kl-issue-branch-base">Base</label>
        <input
          id="kl-issue-branch-base"
          className={s.input}
          list="kl-issue-branch-bases"
          value={base}
          spellCheck={false}
          onChange={(e) => {
            setBase(e.target.value);
            setError(null);
          }}
        />
        <datalist id="kl-issue-branch-bases">
          {baseOptions.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <label className={s.check}>
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />{' '}
          Checkout after create
        </label>
        {tList.length > 0 && (
          <label className={s.check}>
            <input
              type="checkbox"
              checked={doTransition}
              onChange={(e) => setDoTransition(e.target.checked)}
            />{' '}
            Transition issue to
            <select
              aria-label="Transition"
              value={selectedTransition}
              onChange={(e) => {
                setTransitionId(e.target.value);
                setDoTransition(true);
              }}
            >
              {tList.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={s.check}>
          <input type="checkbox" checked={assignSelf} onChange={(e) => setAssignSelf(e.target.checked)} />{' '}
          Assign to me
        </label>
        <div className={s.buttons}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create branch'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
