import type { PatchFile } from '@githappens/cloud-api/types';
import { createElement, useEffect, useRef, useState } from 'react';

import type { SuggestSession } from '../../../../shared/ipc/suggest-contract';
import { mountDialog } from '../../ai/mount';
import { copyText } from '../../cloud-patches/api';
import { errorText, extrasInvoke, extrasOn } from '../../cloud/extras-api';
import { useTabsStore } from '../../stores/tabs';
import { useToastStore } from '../../stores/toasts';
import s from './Suggest.module.css';
import { sessionForPath, useSuggestStore } from './suggest-store';

/** Close every tab showing the worktree so main can remove it (open repos hold file handles on Windows). */
async function closeWorktreeTabs(session: SuggestSession): Promise<void> {
  const tabs = useTabsStore.getState();
  for (const t of tabs.tabs) if (t.kind === 'repo' && sessionForPath([session], t.repoPath)) tabs.close(t.id);
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * "Suggesting changes on PR #42 — edit any file. [Discard] [Submit suggestion]" (spec 14 §4.3), shown
 * while the active tab is a suggestion worktree. Rendered by CloudFeaturesHost.
 */
export function SuggestModeBanner() {
  const sessions = useSuggestStore((st) => st.sessions);
  const refresh = useSuggestStore((st) => st.refresh);
  const active = useTabsStore((t) => t.tabs.find((x) => x.id === t.activeTabId));
  useEffect(() => {
    void refresh();
    return extrasOn('suggest:changed', () => void refresh());
  }, [refresh]);
  const session = sessionForPath(sessions, active?.kind === 'repo' ? active.repoPath : undefined);
  if (!session) return null;

  const discard = async (): Promise<void> => {
    if (!window.confirm('Discard this suggestion? Your edits in the suggestion worktree are deleted.'))
      return;
    await closeWorktreeTabs(session);
    try {
      await extrasInvoke('suggest:discard', { sessionId: session.sessionId });
    } catch (e) {
      useToastStore.getState().push({ kind: 'error', title: 'Could not discard', body: errorText(e) });
    }
    void refresh();
  };

  return (
    <div className={s.banner} role="status" aria-live="polite">
      <span className={s.bannerText}>
        <strong>Suggest mode</strong> · Suggesting changes on PR #{session.pr.number} ({session.pr.ref.owner}/
        {session.pr.ref.name}) — edit any file.
      </span>
      <button type="button" onClick={() => void discard()}>
        Discard
      </button>
      <button type="button" className="primary" onClick={() => void openSubmitSuggestion(session)}>
        Submit suggestion
      </button>
    </div>
  );
}

export function openSubmitSuggestion(session: SuggestSession): Promise<void> {
  return mountDialog<void>((done) =>
    createElement(SubmitSuggestionDialog, { session, onClose: () => done() }),
  );
}

function SubmitSuggestionDialog({ session, onClose }: { session: SuggestSession; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [addLabel, setAddLabel] = useState(false);
  const [files, setFiles] = useState<PatchFile[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    extrasInvoke('suggest:changes', { sessionId: session.sessionId }).then(
      (r) => {
        setFiles(r.files);
        setWarnings(r.warnings);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [session.sessionId]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    await closeWorktreeTabs(session);
    try {
      const r = await extrasInvoke('suggest:submit', {
        sessionId: session.sessionId,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        addLabel,
      });
      const toasts = useToastStore.getState();
      toasts.push({
        kind: 'success',
        title: r.commentPosted ? `Suggestion posted on PR #${session.pr.number}` : 'Suggestion created',
        body: 'The link was copied to the clipboard.',
      });
      copyText(r.suggestion.webUrl);
      for (const w of r.warnings) toasts.push({ kind: 'warning', title: w });
      void useSuggestStore.getState().refresh();
      onClose();
    } catch (e) {
      setError(errorText(e));
      await useTabsStore.getState().openRepo(session.worktreePath); // keep editing
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Submit suggestion"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 className={s.title}>Suggest changes on PR #{session.pr.number}</h2>
      <form
        className={s.body}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={s.field}>
          Title
          <input
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className={s.field}>
          Description (optional)
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div>
          <div className={s.muted}>Changed files</div>
          {!files && !error && <p className={s.muted}>Collecting changes…</p>}
          {files && !files.length && <p className={s.warn}>You have not changed any file yet.</p>}
          {files && files.length > 0 && (
            <ul className={s.files}>
              {files.map((f) => (
                <li key={f.path}>
                  <span className={s.status}>{f.status}</span>
                  <span style={{ flex: 1 }}>{f.path}</span>
                  <span className={s.add}>+{f.additions}</span>
                  <span className={s.del}>−{f.deletions}</span>
                </li>
              ))}
            </ul>
          )}
          {warnings.map((w) => (
            <p key={w} className={s.warn}>
              {w}
            </p>
          ))}
        </div>
        <label className={s.check}>
          <input type="checkbox" checked={addLabel} onChange={(e) => setAddLabel(e.target.checked)} /> Add the
          “code-suggestion” label to the pull request
        </label>
        <p className={s.muted}>
          The changes are shared as an end-to-end encrypted Cloud Patch (the key stays in the link) and a
          comment with the links is posted on the pull request. The suggestion worktree is removed afterwards.
        </p>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className={s.buttons}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !title.trim() || !files?.length}>
            {busy ? 'Submitting…' : 'Submit suggestion'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
