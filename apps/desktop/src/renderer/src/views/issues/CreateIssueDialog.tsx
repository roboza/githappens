import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { errorLine, intInvoke } from '../../integrations/api';
import { issueRefOf, parseLabels, supportsIssueType } from '../../integrations/issue-helpers';
import { ik } from '../../integrations/queries';
import { useToastStore } from '../../stores/toasts';
import { DialogShell } from './CreateBranchFromIssueDialog';
import { useIssueUi, type CreateIssueRequest } from './issue-store';
import s from './IssueDetail.module.css';

/** "+" in the ISSUES section (spec 10 §4.9): title, Markdown body, labels, (Jira/Azure) type → `issues:create`. */
export function CreateIssueDialog({ req, onClose }: { req: CreateIssueRequest; onClose(): void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [type, setType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const withType = supportsIssueType(req.trackerKind);

  const submit = async (): Promise<void> => {
    if (!title.trim()) return setError('Enter a title.');
    setBusy(true);
    try {
      const l = parseLabels(labels);
      const issue = await intInvoke('issues:create', {
        integrationKey: req.integrationKey,
        scope: req.scope,
        input: {
          title: title.trim(),
          body: body.trim() || undefined,
          labels: l.length ? l : undefined,
          type: withType && type.trim() ? type.trim() : undefined,
        },
      });
      useToastStore.getState().push({ kind: 'success', title: `Created ${issue.key}`, body: issue.title });
      void qc.invalidateQueries({ queryKey: ['issues', req.integrationKey, req.scope] });
      qc.setQueryData(ik.issue(req.integrationKey, issue.tracker.scope, issue.key), issue);
      onClose();
      useIssueUi.setState({ detail: { ref: issueRefOf(issue, req.integrationKey), repoId: req.repoId } });
    } catch (e) {
      setError(errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={`New issue${req.scopeLabel ? ` in ${req.scopeLabel}` : ''}`} onCancel={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="kl-new-issue-title">Title</label>
        <input
          id="kl-new-issue-title"
          autoFocus
          className={s.input}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
        />
        <label htmlFor="kl-new-issue-body">Description (Markdown)</label>
        <textarea
          id="kl-new-issue-body"
          className={s.textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <label htmlFor="kl-new-issue-labels">Labels (comma-separated)</label>
        <input
          id="kl-new-issue-labels"
          className={s.input}
          placeholder="bug, ui"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />
        {withType && (
          <>
            <label htmlFor="kl-new-issue-type">Type (optional)</label>
            <input
              id="kl-new-issue-type"
              className={s.input}
              placeholder="Task, Bug, Story…"
              value={type}
              onChange={(e) => setType(e.target.value)}
            />
          </>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className={s.buttons}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create issue'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
