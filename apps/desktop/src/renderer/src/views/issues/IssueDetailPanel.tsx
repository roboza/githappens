import type { Issue } from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, GitBranch, Link, Pencil, UserPlus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { copyText, errorLine, intInvoke, openExternal } from '../../integrations/api';
import { issueBodyText, parseLabels } from '../../integrations/issue-helpers';
import {
  ik,
  invalidateIssue,
  useIssue,
  useIssueComments,
  useIssueTransitions,
} from '../../integrations/queries';
import { Markdown, ProviderErrorLine, isoSecs, toneClass, uiStyles, UserAvatar } from '../../integrations/ui';
import type { Tone } from '../../integrations/helpers';
import { formatDate } from '../../lib/format';
import { invoke } from '../../lib/api';
import { qk } from '../../repo/queries';
import { useToastStore } from '../../stores/toasts';
import { useActiveRepoId, useIssueUi, type DetailTarget } from './issue-store';
import s from './IssueDetail.module.css';
import { TrackerIcon } from './TrackerIcon';

const CATEGORY_TONE: Record<Issue['stateCategory'], Tone> = {
  todo: 'grey',
  in_progress: 'blue',
  done: 'green',
};

const toastError = (title: string, e: unknown): void => {
  useToastStore.getState().push({ kind: 'error', title, body: errorLine(e) });
};

/**
 * Issue panel (spec 10 §4.9): right-side drawer with title / status / assignees / labels editing,
 * description, comments and the Create branch / Open in browser / Copy link actions.
 */
export function IssueDetailPanel({ target, onClose }: { target: DetailTarget; onClose(): void }) {
  const { ref } = target;
  const { integrationKey, scope, key } = ref;
  const qc = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const issueQ = useIssue(integrationKey, scope, key);
  const issue = issueQ.data;
  const activeRepo = useActiveRepoId();
  const repoId = target.repoId ?? activeRepo;

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const busy = useRef(false);
  /** Run a mutation: refresh the issue on success, toast on failure. */
  const mutate = async (label: string, fn: () => Promise<Issue | void>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      const updated = await fn();
      if (updated) qc.setQueryData(ik.issue(integrationKey, scope, key), updated);
      invalidateIssue(qc, integrationKey, scope, key);
      return true;
    } catch (e) {
      toastError(label, e);
      return false;
    } finally {
      busy.current = false;
    }
  };
  const update = (label: string, patch: Partial<{ title: string; body: string; labels: string[] }>) =>
    mutate(label, () => intInvoke('issues:update', { integrationKey, scope, key, patch }));

  return (
    <dialog
      ref={dialog}
      className={s.panel}
      aria-label={`Issue ${key}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === dialog.current) onClose(); // backdrop click
      }}
    >
      <header className={s.header}>
        <div className={s.headMain}>
          <div className={s.keyLine}>
            <TrackerIcon kind={ref.trackerKind} />
            <span className={s.key}>{key}</span>
            {issue?.type && <span>· {issue.type}</span>}
          </div>
          {issue ? (
            <TitleEditor
              title={issue.title}
              onSave={(title) => update(`Could not rename ${key}`, { title })}
            />
          ) : issueQ.isPending ? (
            <div className={s.skeleton} style={{ width: '70%', height: 16 }} />
          ) : null}
        </div>
        <button type="button" className={s.iconBtn} aria-label="Close" title="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className={s.actions}>
        <CreateBranchButton issue={issue} integrationKey={integrationKey} repoId={repoId} />
        <button type="button" onClick={() => openExternal(issue?.webUrl ?? ref.webUrl)}>
          <ExternalLink size={13} /> Open in browser
        </button>
        <button type="button" onClick={() => copyText(issue?.webUrl ?? ref.webUrl)}>
          <Link size={13} /> Copy link
        </button>
      </div>

      <div className={s.scroll}>
        {issueQ.error ? (
          <ProviderErrorLine error={issueQ.error} onRetry={() => void issueQ.refetch()} />
        ) : !issue ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <section className={s.box} aria-label="Details">
              <div className={s.fields}>
                <Field label="Status">
                  <StatusEditor issue={issue} integrationKey={integrationKey} mutate={mutate} />
                </Field>
                <Field label="Assignees">
                  {issue.assignees.length === 0 && <span className={s.muted}>Unassigned</span>}
                  {issue.assignees.map((a) => (
                    <span key={a.id || a.login} className={s.person}>
                      <UserAvatar user={a} size={16} />
                      {a.name || a.login}
                    </span>
                  ))}
                  <button
                    type="button"
                    className={s.linkBtn}
                    onClick={() =>
                      void mutate(`Could not assign ${key}`, () =>
                        intInvoke('issues:assignSelf', { integrationKey, scope, key }),
                      )
                    }
                  >
                    <UserPlus size={12} /> Assign to me
                  </button>
                </Field>
                <Field label="Labels">
                  <LabelsEditor
                    labels={issue.labels}
                    onSave={(labels) => update(`Could not update labels of ${key}`, { labels })}
                  />
                </Field>
                {issue.priority && <Field label="Priority">{issue.priority}</Field>}
                {issue.sprint && <Field label="Sprint">{issue.sprint}</Field>}
                {!!issue.fixVersions?.length && (
                  <Field label="Fix versions">{issue.fixVersions.join(', ')}</Field>
                )}
                {issue.milestone && <Field label="Milestone">{issue.milestone}</Field>}
                {issue.reporter && (
                  <Field label="Reporter">
                    <span className={s.person}>
                      <UserAvatar user={issue.reporter} size={16} />
                      {issue.reporter.name || issue.reporter.login}
                    </span>
                  </Field>
                )}
                <Field label="Updated">
                  <span title={issue.updatedAt}>{formatDate(isoSecs(issue.updatedAt))}</span>
                </Field>
              </div>
            </section>

            <DescriptionBox
              issue={issue}
              onSave={(body) => update(`Could not update the description of ${key}`, { body })}
            />
          </>
        )}

        <CommentsBox integrationKey={integrationKey} scope={scope} issueKey={key} />
      </div>
    </dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className={s.fieldLabel}>{label}</span>
      <span className={s.fieldValue}>{children}</span>
    </>
  );
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className={s.box} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={s.skeleton} style={{ width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

function TitleEditor({ title, onSave }: { title: string; onSave(title: string): Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <h2 className={s.titleText}>
        {title}{' '}
        <button
          type="button"
          className={s.iconBtn}
          style={{ width: 20, height: 20, verticalAlign: 'middle' }}
          title="Edit title"
          aria-label="Edit title"
          onClick={() => setDraft(title)}
        >
          <Pencil size={12} />
        </button>
      </h2>
    );
  }
  const save = async (): Promise<void> => {
    const t = draft.trim();
    if (!t || t === title) return setDraft(null);
    if (await onSave(t)) setDraft(null);
  };
  return (
    <form
      className={s.titleEdit}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        aria-label="Issue title"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <button type="submit" className={s.iconBtn} title="Save title" aria-label="Save title">
        <Check size={14} />
      </button>
      <button
        type="button"
        className={s.iconBtn}
        title="Cancel"
        aria-label="Cancel editing title"
        onClick={() => setDraft(null)}
      >
        <X size={14} />
      </button>
    </form>
  );
}

function StatusEditor({
  issue,
  integrationKey,
  mutate,
}: {
  issue: Issue;
  integrationKey: string;
  mutate(label: string, fn: () => Promise<Issue | void>): Promise<boolean>;
}) {
  const { scope } = issue.tracker;
  const [want, setWant] = useState(false);
  const transitions = useIssueTransitions(integrationKey, scope, issue.key, want);
  return (
    <>
      <span className={`${uiStyles.chip} ${toneClass(CATEGORY_TONE[issue.stateCategory])}`}>
        {issue.state}
      </span>
      <select
        aria-label="Change status"
        value=""
        onFocus={() => setWant(true)}
        onMouseDown={() => setWant(true)}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          void mutate(`Could not change the status of ${issue.key}`, () =>
            intInvoke('issues:transition', { integrationKey, scope, key: issue.key, transitionId: id }),
          );
        }}
      >
        <option value="">{transitions.isFetching && !transitions.data ? 'Loading…' : 'Move to…'}</option>
        {(transitions.data ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {transitions.error && (
        <ProviderErrorLine error={transitions.error} onRetry={() => void transitions.refetch()} />
      )}
    </>
  );
}

function LabelsEditor({ labels, onSave }: { labels: string[]; onSave(labels: string[]): Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <>
        {labels.length === 0 && <span className={s.muted}>None</span>}
        {labels.map((l) => (
          <span key={l} className={s.labelChip}>
            {l}
          </span>
        ))}
        <button type="button" className={s.linkBtn} onClick={() => setDraft(labels.join(', '))}>
          Edit
        </button>
      </>
    );
  }
  return (
    <form
      className={s.titleEdit}
      style={{ flex: 1 }}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(parseLabels(draft)).then((ok) => ok && setDraft(null));
      }}
    >
      <input
        autoFocus
        aria-label="Labels (comma-separated)"
        placeholder="bug, ui"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <button type="submit" className={s.iconBtn} title="Save labels" aria-label="Save labels">
        <Check size={14} />
      </button>
    </form>
  );
}

function DescriptionBox({ issue, onSave }: { issue: Issue; onSave(body: string): Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = issueBodyText(issue);
  return (
    <section className={s.box} aria-label="Description">
      <h3 className={s.boxTitle}>
        Description
        {draft === null && (
          <button type="button" className={s.linkBtn} onClick={() => setDraft(text)}>
            Edit
          </button>
        )}
      </h3>
      {draft !== null ? (
        <>
          <textarea
            autoFocus
            className={s.textarea}
            aria-label="Description"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <div className={s.row}>
            {issue.bodyFormat === 'html' && <span className={s.hint}>Saved as plain text</span>}
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onSave(draft).then((ok) => {
                  setSaving(false);
                  if (ok) setDraft(null);
                });
              }}
            >
              Save
            </button>
          </div>
        </>
      ) : issue.bodyFormat === 'html' ? (
        text ? (
          <pre className={s.plain}>{text}</pre>
        ) : (
          <p className={s.muted}>No description provided.</p>
        )
      ) : (
        <Markdown text={text} />
      )}
    </section>
  );
}

function CommentsBox({
  integrationKey,
  scope,
  issueKey,
}: {
  integrationKey: string;
  scope: string;
  issueKey: string;
}) {
  const qc = useQueryClient();
  const comments = useIssueComments(integrationKey, scope, issueKey);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const send = async (): Promise<void> => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await intInvoke('issues:comment', { integrationKey, scope, key: issueKey, body });
      setDraft('');
      invalidateIssue(qc, integrationKey, scope, issueKey);
    } catch (e) {
      toastError(`Could not comment on ${issueKey}`, e);
    } finally {
      setSending(false);
    }
  };
  const list = comments.data ?? [];
  return (
    <section className={s.box} aria-label="Comments">
      <h3 className={s.boxTitle}>Comments{list.length ? ` (${list.length})` : ''}</h3>
      {comments.error ? (
        <ProviderErrorLine error={comments.error} onRetry={() => void comments.refetch()} />
      ) : comments.isPending ? (
        <Skeleton lines={3} />
      ) : list.length === 0 ? (
        <p className={s.muted}>No comments yet.</p>
      ) : (
        list.map((c) => (
          <div key={c.id} className={s.comment}>
            <UserAvatar user={c.author} size={20} />
            <div className={s.commentBody}>
              <span className={s.commentMeta}>
                <strong>{c.author.name || c.author.login}</strong> ·{' '}
                <span title={c.createdAt}>{formatDate(isoSecs(c.createdAt))}</span>
              </span>
              <Markdown text={c.body} empty="" />
            </div>
          </div>
        ))
      )}
      <textarea
        className={s.textarea}
        style={{ minHeight: 64 }}
        aria-label="Add a comment"
        placeholder="Add a comment (Markdown)…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className={s.row}>
        <span className={s.hint}>Ctrl+Enter to send</span>
        <button
          type="button"
          className="primary"
          disabled={!draft.trim() || sending}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Comment'}
        </button>
      </div>
    </section>
  );
}

function CreateBranchButton({
  issue,
  integrationKey,
  repoId,
}: {
  issue: Issue | undefined;
  integrationKey: string;
  repoId: DetailTarget['repoId'];
}) {
  const info = useQuery({
    queryKey: qk.info(repoId ?? ''),
    queryFn: () => invoke('git:repo:info', { repoId: repoId! }),
    enabled: !!repoId,
  }).data;
  const base = info?.head.kind === 'branch' ? info.head.name : (info?.head.sha ?? 'HEAD');
  return (
    <button
      type="button"
      disabled={!issue || !repoId}
      title={repoId ? 'Create a branch for this issue' : 'Open a repository to create a branch'}
      onClick={() => {
        if (!issue || !repoId) return;
        useIssueUi.getState().branch?.resolve();
        useIssueUi.setState({
          branch: { repoId, issue, integrationKey, base, resolve: () => undefined },
        });
      }}
    >
      <GitBranch size={13} /> Create branch
    </button>
  );
}
