import type { RepoId } from '@githappens/git/types';
import type { ProviderUser, PullRequest, UpdatePrInput } from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { errorLine, intInvoke } from '../../integrations/api';
import { invalidatePr, useLabels, useMilestones } from '../../integrations/queries';
import { ProviderErrorLine, uiStyles, UserAvatar } from '../../integrations/ui';
import { useToastStore } from '../../stores/toasts';
import { prViewCaps, userIdent } from './pr-view-helpers';
import s from './PullRequestView.module.css';

/** Sidebar editors of the PR view (spec 10 §4.7): reviewers, assignees, labels, milestone. */

/** `pr:update` + toast on error + invalidate. Resolves true on success. */
export function usePrUpdate(repoId: RepoId, pr: PullRequest) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const [busy, setBusy] = useState(false);
  const update = async (patch: UpdatePrInput, what: string): Promise<boolean> => {
    setBusy(true);
    try {
      await intInvoke('pr:update', { ref: pr.repo, number: pr.number, patch });
      return true;
    } catch (e) {
      push({ kind: 'error', title: `Could not ${what}`, body: errorLine(e) });
      return false;
    } finally {
      setBusy(false);
      invalidatePr(qc, repoId, pr.repo, pr.number);
    }
  };
  return { update, busy };
}

/** Sidebar section with an optional pencil button that toggles an inline popover editor. */
export function EditableBox({
  title,
  editable,
  editor,
  children,
}: {
  title: string;
  editable: boolean;
  editor: (close: () => void) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <section
      ref={ref}
      className={s.box}
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <h3 className={s.boxHead}>
        <span>{title}</span>
        {editable && (
          <button
            type="button"
            className={s.bare}
            aria-label={`Edit ${title.toLowerCase()}`}
            title={`Edit ${title.toLowerCase()}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Pencil size={11} />
          </button>
        )}
      </h3>
      {children}
      {open && (
        <div className={s.popover} role="dialog" aria-label={`Edit ${title.toLowerCase()}`}>
          {editor(() => setOpen(false))}
        </div>
      )}
    </section>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const sameUser = (a: ProviderUser, b: ProviderUser): boolean =>
  (!!a.id && a.id === b.id) || a.login.toLowerCase() === b.login.toLowerCase();

/** Reviewers / assignees: current list with remove buttons + provider user search to add. */
export function UserListEditor({
  repoId,
  pr,
  field,
}: {
  repoId: RepoId;
  pr: PullRequest;
  field: 'reviewers' | 'assignees';
}) {
  const kind = pr.repo.integration.kind;
  const caps = prViewCaps(kind);
  const { update, busy } = usePrUpdate(repoId, pr);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const current: ProviderUser[] = field === 'reviewers' ? pr.reviewers.map((r) => r.user) : pr.assignees;
  // Azure DevOps' update only adds reviewers; removal happens on the website.
  const canRemove = !(field === 'reviewers' && kind === 'azure-devops');
  const results = useQuery({
    queryKey: ['pr', 'searchUsers', kind, pr.repo.integration.host, pr.repo.owner, pr.repo.name, q],
    queryFn: () => intInvoke('pr:searchUsers', { ref: pr.repo, query: q }),
    enabled: q.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  const noun = field === 'reviewers' ? 'reviewers' : 'assignees';

  const save = async (next: ProviderUser[]): Promise<void> => {
    if (field === 'assignees') {
      await update({ assignees: next.map((u) => userIdent(kind, u)) }, `update the ${noun}`);
      return;
    }
    const users = next.filter((u) => !u.isTeam || !caps.prTeamsAsReviewers);
    const teams = next.filter((u) => u.isTeam && caps.prTeamsAsReviewers);
    await update(
      {
        reviewers: users.map((u) => userIdent(kind, u)),
        ...(caps.prTeamsAsReviewers ? { teamReviewers: teams.map((u) => userIdent(kind, u)) } : {}),
      },
      `update the ${noun}`,
    );
  };

  const candidates = (results.data ?? []).filter((u) => field === 'reviewers' || !u.isTeam);

  return (
    <div className={s.editor}>
      <input
        type="search"
        autoFocus
        placeholder={field === 'reviewers' ? 'Search users or teams…' : 'Search users…'}
        aria-label={`Search ${noun}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {current.length > 0 && (
        <div className={s.editorList} aria-label={`Current ${noun}`}>
          {current.map((u) => (
            <div key={u.id || u.login} className={s.person}>
              <UserAvatar user={u} size={16} />
              <span>
                {u.isTeam ? '@' : ''}
                {u.login}
              </span>
              {canRemove && (
                <button
                  type="button"
                  className={s.bare}
                  aria-label={`Remove ${u.login}`}
                  title={`Remove ${u.login}`}
                  disabled={busy}
                  onClick={() => void save(current.filter((c) => !sameUser(c, u)))}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!canRemove && <span className={s.none}>Remove reviewers on the provider&apos;s website.</span>}
      {q && (
        <div className={s.editorList} aria-label="Search results">
          {results.error ? (
            <ProviderErrorLine error={results.error} onRetry={() => void results.refetch()} />
          ) : !results.data ? (
            <span className={s.none}>Searching…</span>
          ) : candidates.length === 0 ? (
            <span className={s.none}>No matches</span>
          ) : (
            candidates.map((u) => {
              const has = current.some((c) => sameUser(c, u));
              return (
                <button
                  key={u.id || u.login}
                  type="button"
                  className={s.pickRow}
                  disabled={busy || (has && !canRemove)}
                  aria-pressed={has}
                  onClick={() => void save(has ? current.filter((c) => !sameUser(c, u)) : [...current, u])}
                >
                  <UserAvatar user={u} size={16} />
                  <span>
                    {u.isTeam ? '@' : ''}
                    {u.login}
                    {u.name && u.name !== u.login ? <span className={s.dim}> {u.name}</span> : null}
                  </span>
                  {has && <Check size={12} />}
                </button>
              );
            })
          )}
        </div>
      )}
      {busy && (
        <span className={s.dim}>
          <Loader2 size={11} className={uiStyles.spin} /> Saving…
        </span>
      )}
    </div>
  );
}

/** Labels: toggle from the repo's labels (`pr:labels`). */
export function LabelsEditor({ repoId, pr }: { repoId: RepoId; pr: PullRequest }) {
  const labels = useLabels(pr.repo);
  const { update, busy } = usePrUpdate(repoId, pr);
  const [filter, setFilter] = useState('');
  const kind = pr.repo.integration.kind;
  const additiveOnly = kind === 'azure-devops';
  const has = (name: string): boolean => pr.labels.some((l) => l.name.toLowerCase() === name.toLowerCase());
  const list = (labels.data ?? []).filter((l) => l.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const toggle = (name: string): void => {
    const next = has(name)
      ? pr.labels.filter((l) => l.name.toLowerCase() !== name.toLowerCase()).map((l) => l.name)
      : [...pr.labels.map((l) => l.name), name];
    void update({ labels: next }, 'update the labels');
  };

  return (
    <div className={s.editor}>
      <input
        type="search"
        autoFocus
        placeholder="Filter labels…"
        aria-label="Filter labels"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {additiveOnly && <span className={s.none}>Remove labels on the provider&apos;s website.</span>}
      <div className={s.editorList}>
        {labels.error ? (
          <ProviderErrorLine error={labels.error} onRetry={() => void labels.refetch()} />
        ) : !labels.data ? (
          <span className={s.none}>Loading labels…</span>
        ) : list.length === 0 ? (
          <span className={s.none}>No labels</span>
        ) : (
          list.map((l) => {
            const on = has(l.name);
            return (
              <button
                key={l.name}
                type="button"
                className={s.pickRow}
                aria-pressed={on}
                disabled={busy || (on && additiveOnly)}
                onClick={() => toggle(l.name)}
              >
                <span
                  className={s.swatch}
                  style={{
                    background: l.color ? (l.color.startsWith('#') ? l.color : `#${l.color}`) : undefined,
                  }}
                />
                <span>{l.name}</span>
                {on && <Check size={12} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Milestone: pick one of `pr:milestones`, or none. */
export function MilestoneEditor({ repoId, pr, onDone }: { repoId: RepoId; pr: PullRequest; onDone(): void }) {
  const milestones = useMilestones(pr.repo);
  const { update, busy } = usePrUpdate(repoId, pr);
  const pick = async (id: string): Promise<void> => {
    if (id === (pr.milestone?.id ?? '')) return onDone();
    if (await update({ milestone: id }, 'update the milestone')) onDone();
  };

  return (
    <div className={s.editor}>
      <div className={s.editorList}>
        <button
          type="button"
          className={s.pickRow}
          aria-pressed={!pr.milestone}
          disabled={busy}
          onClick={() => void pick('')}
        >
          <span>No milestone</span>
          {!pr.milestone && <Check size={12} />}
        </button>
        {milestones.error ? (
          <ProviderErrorLine error={milestones.error} onRetry={() => void milestones.refetch()} />
        ) : !milestones.data ? (
          <span className={s.none}>Loading milestones…</span>
        ) : (
          milestones.data.map((m) => (
            <button
              key={m.id}
              type="button"
              className={s.pickRow}
              aria-pressed={pr.milestone?.id === m.id}
              disabled={busy}
              onClick={() => void pick(m.id)}
            >
              <span>{m.title}</span>
              {pr.milestone?.id === m.id && <Check size={12} />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
