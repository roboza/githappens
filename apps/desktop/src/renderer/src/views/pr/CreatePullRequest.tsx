import type { RepoId } from '@githappens/git/types';
import type { ProviderKind, ProviderUser, RepoRef } from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Loader2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';

import { formatDate, shortSha } from '../../lib/format';
import { quiet, runOp } from '../../lib/ops';
import { useRefs } from '../../repo/queries';
import { useToastStore } from '../../stores/toasts';
import type { PrCommit, ResolvedRemote } from '../../../../shared/ipc/integrations-contract';
import { intInvoke } from '../../integrations/api';
import {
  defaultPrSides,
  humanizeBranch,
  prFieldSupport,
  providerLabel,
  refKey,
} from '../../integrations/helpers';
import {
  ik,
  providerRetry,
  useConflictCheck,
  useMilestones,
  usePrCommits,
  usePrList,
  useResolvedRemotes,
} from '../../integrations/queries';
import { Markdown, ProviderErrorLine, uiStyles, UserAvatar } from '../../integrations/ui';
import { PrDraftButton } from '../ai/PrDraftButton';
import s from './CreatePullRequest.module.css';
import { openPullRequestView } from './pr-actions';

interface CreatePrRequest {
  repoId: RepoId;
  headBranch: string;
  baseBranch?: string;
  nonce: number;
}

const useCreatePrStore = create<{ req: CreatePrRequest | null }>(() => ({ req: null }));
let nonce = 0;

/**
 * Open the Create Pull Request dialog (spec 10 §4.4). `headBranch`/`baseBranch` may be local names
 * (`feature/x`) or remote-tracking names (`origin/feature/x`); remotes are resolved through
 * `provider:resolveRemotes`. Requires `<CreatePullRequestHost/>` to be mounted once.
 */
export function openCreatePullRequest(
  repoId: RepoId,
  opts: { headBranch: string; baseBranch?: string },
): void {
  useCreatePrStore.setState({ req: { repoId, ...opts, nonce: ++nonce } });
}

/** Mount once in App; renders the Create PR dialog when `openCreatePullRequest` is called. */
export function CreatePullRequestHost() {
  const req = useCreatePrStore((st) => st.req);
  if (!req) return null;
  return (
    <CreatePrDialog key={req.nonce} req={req} onClose={() => useCreatePrStore.setState({ req: null })} />
  );
}

type Linked = ResolvedRemote & { ref: RepoRef; integrationKey: string; kind: ProviderKind };

function CreatePrDialog({ req, onClose }: { req: CreatePrRequest; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const remotes = useResolvedRemotes(req.repoId);
  const refs = useRefs(req.repoId);
  const linked = useMemo(
    () => (remotes.data ?? []).filter((r): r is Linked => !!r.ref && !!r.integrationKey && !!r.kind),
    [remotes.data],
  );

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  let content;
  if (remotes.error || refs.error) {
    content = (
      <div className={s.body}>
        <ProviderErrorLine error={remotes.error ?? refs.error} onRetry={() => void remotes.refetch()} />
      </div>
    );
  } else if (remotes.isPending || refs.isPending) {
    content = <div className={s.body}>Loading remotes…</div>;
  } else if (!linked.length) {
    content = (
      <div className={s.body}>
        No remote of this repository is linked to a connected account. Connect the hosting provider in
        Preferences → Integrations.
      </div>
    );
  } else {
    content = <CreatePrForm req={req} linked={linked} refs={refs.data ?? []} onClose={onClose} />;
  }

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Create pull request"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className={s.header}>
        <GitPullRequest size={16} aria-hidden />
        <h2>Create Pull Request</h2>
        <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {content}
    </dialog>
  );
}

type RefList = NonNullable<ReturnType<typeof useRefs>['data']>;

function CreatePrForm({
  req,
  linked,
  refs,
  onClose,
}: {
  req: CreatePrRequest;
  linked: Linked[];
  refs: RefList;
  onClose(): void;
}) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  // Defaults are computed once per dialog; later ref changes must not reset user edits.
  const [defaults] = useState(() =>
    defaultPrSides(
      linked.map((l) => l.remote),
      refs,
      req.headBranch,
      req.baseBranch,
    ),
  );
  const [headRemote, setHeadRemote] = useState(defaults.headRemote);
  const [headBranch, setHeadBranch] = useState(defaults.headBranch);
  const [baseRemote, setBaseRemote] = useState(defaults.baseRemote);
  const [baseBranch, setBaseBranch] = useState(defaults.baseBranch);
  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [templateChoice, setTemplateChoice] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [reviewers, setReviewers] = useState<ProviderUser[]>([]);
  const [assignees, setAssignees] = useState<ProviderUser[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const [deleteSource, setDeleteSource] = useState(true);
  const [squash, setSquash] = useState(false);
  const [milestone, setMilestone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const head = linked.find((l) => l.remote === headRemote) ?? linked[0]!;
  const base = linked.find((l) => l.remote === baseRemote) ?? linked[0]!;
  const support = prFieldSupport(base.kind);
  const sameRepo =
    refKey(head.ref) === refKey(base.ref) &&
    head.ref.owner === base.ref.owner &&
    head.ref.name === base.ref.name;

  const branchesOf = (remote: string): string[] =>
    refs
      .filter((r) => r.type === 'remote' && r.shortName.startsWith(`${remote}/`) && !r.symrefTarget)
      .map((r) => r.shortName.slice(remote.length + 1));
  const pushed = branchesOf(head.remote).includes(headBranch);
  const localExists = refs.some((r) => r.type === 'local' && r.shortName === headBranch);
  // Local revs for the git-side previews (conflict check, commit list): the local head branch when it
  // exists, else its remote-tracking branch; the base is always the remote-tracking target branch.
  const headRev = localExists ? headBranch : pushed ? `${head.remote}/${headBranch}` : undefined;
  const baseRev = branchesOf(base.remote).includes(baseBranch) ? `${base.remote}/${baseBranch}` : undefined;
  const conflicts = useConflictCheck(req.repoId, headRev, baseRev);
  const commits = usePrCommits(req.repoId, baseRev, headRev);
  const milestoneSupported = base.kind === 'github' || base.kind === 'gitlab';
  const milestones = useMilestones(base.ref, milestoneSupported);

  const templates = useQuery({
    queryKey: ik.templates(req.repoId, base.ref, headBranch),
    queryFn: () => intInvoke('pr:templates', { repoId: req.repoId, ref: base.ref, branch: headBranch }),
    staleTime: 5 * 60_000,
    retry: providerRetry,
  });
  const templateList = templates.data ?? [];
  const templateName = templateChoice ?? (templateList.length === 1 ? templateList[0]!.name : '');
  const templateBody = templateList.find((t) => t.name === templateName)?.body ?? '';
  // Default title (spec 10 §4.4): the subject of the only commit, else the humanized branch name.
  const onlyCommit = commits.data?.length === 1 ? commits.data[0] : undefined;
  const effectiveTitle = title ?? (onlyCommit ? onlyCommit.subject : humanizeBranch(headBranch));
  const effectiveBody = body ?? templateBody;

  const existing = usePrList(req.repoId, { preset: 'all', state: 'open', head: headBranch }, !!headBranch);
  const dup = existing.data?.find(
    (p) =>
      p.head.branch === headBranch &&
      p.base.repo.owner === base.ref.owner &&
      p.base.repo.name === base.ref.name,
  );

  const pushBranch = (): void =>
    quiet(
      runOp(
        req.repoId,
        {
          type: 'push',
          localRef: headBranch,
          remote: head.remote,
          remoteBranch: headBranch,
          setUpstream: true,
        },
        { successToast: `Pushed ${headBranch} to ${head.remote}` },
      ),
    );

  const submit = async (): Promise<void> => {
    if (!effectiveTitle.trim() || !headBranch.trim() || !baseBranch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const pr = await intInvoke('pr:create', {
        base: base.ref,
        baseBranch: baseBranch.trim(),
        head: head.ref,
        headBranch: headBranch.trim(),
        title: effectiveTitle.trim(),
        body: effectiveBody,
        draft: support.draft ? draft : undefined,
        reviewers: reviewers.filter((u) => !u.isTeam).map((u) => u.login),
        teamReviewers: reviewers.filter((u) => u.isTeam).map((u) => u.login),
        assignees: support.assignees ? assignees.map((u) => u.login) : undefined,
        labels: support.labels ? labels : undefined,
        deleteSourceBranch: support.deleteSourceBranch ? deleteSource : undefined,
        squash: support.squash ? squash : undefined,
        milestone: milestoneSupported && milestone ? milestone : undefined,
      });
      push({ kind: 'success', title: `PR #${pr.number} created`, body: pr.title });
      void qc.invalidateQueries({ queryKey: ['pr', 'list'] });
      void qc.invalidateQueries({ queryKey: ik.prIndex(req.repoId) });
      onClose();
      openPullRequestView(req.repoId, pr.repo, pr.number);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remoteSelect = (value: string, set: (v: string) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      {linked.map((l) => (
        <option key={l.remote} value={l.remote} title={`${l.ref.owner}/${l.ref.name} on ${l.host}`}>
          {l.remote} ({l.ref.owner})
        </option>
      ))}
    </select>
  );

  return (
    <>
      <form
        id="kl-create-pr"
        className={s.body}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className={s.repoRow}>
          <div className={s.side}>
            <span>Source</span>
            <div className={s.pair}>
              {remoteSelect(headRemote, setHeadRemote, 'Source remote')}
              <input
                type="text"
                aria-label="Source branch"
                list="kl-pr-head-branches"
                value={headBranch}
                spellCheck={false}
                onChange={(e) => setHeadBranch(e.target.value)}
              />
              <datalist id="kl-pr-head-branches">
                {refs
                  .filter((r) => r.type === 'local')
                  .map((r) => (
                    <option key={r.shortName} value={r.shortName} />
                  ))}
              </datalist>
            </div>
          </div>
          <ArrowRight size={16} className={s.arrow} aria-hidden />
          <div className={s.side}>
            <span>Target</span>
            <div className={s.pair}>
              {remoteSelect(baseRemote, setBaseRemote, 'Target remote')}
              <input
                type="text"
                aria-label="Target branch"
                list="kl-pr-base-branches"
                value={baseBranch}
                spellCheck={false}
                onChange={(e) => setBaseBranch(e.target.value)}
              />
              <datalist id="kl-pr-base-branches">
                {branchesOf(base.remote).map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
          </div>
        </div>

        {!pushed && headBranch && (
          <div className={s.banner} data-tone="warn">
            <span>
              <code>{headBranch}</code> is not on {head.remote}.
            </span>
            {localExists && (
              <button type="button" onClick={pushBranch}>
                Push {headBranch}
              </button>
            )}
          </div>
        )}
        {sameRepo && headBranch === baseBranch && (
          <div className={s.banner} data-tone="warn">
            <span>Source and target are the same branch.</span>
          </div>
        )}
        {dup && (
          <div className={s.banner} data-tone="info">
            <span>
              PR #{dup.number} already exists for this branch: {dup.title}
            </span>
            <button
              type="button"
              onClick={() => {
                onClose();
                openPullRequestView(req.repoId, dup.repo, dup.number);
              }}
            >
              Open it
            </button>
          </div>
        )}

        {conflicts.data?.unsupported ? (
          <div className={s.banner} data-tone="info">
            <span>Conflict check skipped: it needs Git 2.38 or newer.</span>
          </div>
        ) : conflicts.data?.conflicts ? (
          <div className={s.banner} data-tone="warn" role="alert">
            <AlertTriangle size={14} className={s.warnIcon} aria-hidden />
            <div className={s.conflicts}>
              <strong>These branches have conflicts</strong>
              <span>The pull request can be created, but conflicts must be resolved before merging.</span>
              {conflicts.data.files.length > 0 && (
                <ul>
                  {conflicts.data.files.slice(0, 5).map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                  {conflicts.data.files.length > 5 && <li>and {conflicts.data.files.length - 5} more…</li>}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {templateList.length > 0 && (
          <label className={s.field}>
            Template
            <select
              value={templateName}
              onChange={(e) => {
                setTemplateChoice(e.target.value);
                setBody(templateList.find((t) => t.name === e.target.value)?.body ?? '');
              }}
            >
              <option value="">None</option>
              {templateList.map((t) => (
                <option key={t.path} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className={s.field}>
          Title
          <input type="text" required value={effectiveTitle} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className={s.field}>
          <div className={s.bodyHead}>
            <span>Description</span>
            <PrDraftButton
              repoId={req.repoId}
              head={localExists ? headBranch : `${head.remote}/${headBranch}`}
              base={
                branchesOf(base.remote).includes(baseBranch) ? `${base.remote}/${baseBranch}` : baseBranch
              }
              template={templateBody}
              onFill={(d) => {
                if (d.title !== undefined) setTitle(d.title);
                if (d.body !== undefined) setBody(d.body);
              }}
            />
            <button type="button" className={s.tab} aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" className={s.tab} aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
          {preview ? (
            <div className={s.preview}>
              <Markdown text={effectiveBody} empty="Nothing to preview." />
            </div>
          ) : (
            <textarea
              aria-label="Description"
              value={effectiveBody}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Describe the change (Markdown)"
            />
          )}
        </div>

        <div className={s.grid2}>
          <UserPicker label="Reviewers" repoRef={base.ref} value={reviewers} onChange={setReviewers} />
          {support.assignees && (
            <UserPicker label="Assignees" repoRef={base.ref} value={assignees} onChange={setAssignees} />
          )}
          {support.labels && <LabelPicker repoRef={base.ref} value={labels} onChange={setLabels} />}
          {milestoneSupported && (
            <label className={s.field}>
              Milestone
              <select
                value={milestone}
                disabled={milestones.isPending && !milestones.error}
                onChange={(e) => setMilestone(e.target.value)}
              >
                <option value="">
                  {milestones.isPending && !milestones.error
                    ? 'Loading…'
                    : milestones.error
                      ? 'Milestones unavailable'
                      : 'No milestone'}
                </option>
                {(milestones.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {headRev && baseRev && <CommitsPreview commits={commits.data} loading={commits.isPending} />}

        <div className={s.options}>
          {support.draft && (
            <label>
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Create as
              draft
            </label>
          )}
          {support.deleteSourceBranch && (
            <label>
              <input
                type="checkbox"
                checked={deleteSource}
                onChange={(e) => setDeleteSource(e.target.checked)}
              />{' '}
              Delete source branch on merge
            </label>
          )}
          {support.squash && (
            <label>
              <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} /> Squash
              commits
            </label>
          )}
        </div>
      </form>
      <footer className={s.footer}>
        <div>{error !== null && <ProviderErrorLine error={error} />}</div>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          form="kl-create-pr"
          className="primary"
          disabled={busy || !effectiveTitle.trim() || !headBranch.trim() || !baseBranch.trim()}
          title={`Create on ${providerLabel(base.kind)} (Ctrl+Enter)`}
        >
          {busy && <Loader2 size={14} className={uiStyles.spin} />} Create Pull Request
        </button>
      </footer>
    </>
  );
}

/** Collapsible list of the commits the PR will contain (`git log base..head`). */
function CommitsPreview({ commits, loading }: { commits: PrCommit[] | undefined; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const n = commits?.length ?? 0;
  return (
    <div className={s.commits}>
      <button
        type="button"
        className={s.commitsToggle}
        aria-expanded={open}
        disabled={loading || n === 0}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {loading
          ? 'Loading commits…'
          : n === 0
            ? 'No commits between these branches'
            : `${n}${n >= 250 ? '+' : ''} commit${n === 1 ? '' : 's'}`}
      </button>
      {open && n > 0 && (
        <ul className={s.commitList}>
          {commits!.map((c) => (
            <li key={c.sha} title={`${c.sha}\n${c.authorName} <${c.authorEmail}>`}>
              <code>{shortSha(c.sha)}</code>
              <span className={s.commitSubject}>{c.subject}</span>
              <span className={uiStyles.muted}>
                {c.authorName}, {formatDate(c.date)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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

/** Async user/team search chip picker (reviewers, assignees). */
export function UserPicker({
  label,
  repoRef,
  value,
  onChange,
}: {
  label: string;
  repoRef: RepoRef;
  value: ProviderUser[];
  onChange(v: ProviderUser[]): void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebounced(text.trim(), 250);
  const results = useQuery({
    queryKey: ['pr', 'users', refKey(repoRef), repoRef.owner, repoRef.name, q],
    queryFn: () => intInvoke('pr:searchUsers', { ref: repoRef, query: q }),
    enabled: open && q.length > 0,
    staleTime: 60_000,
    retry: providerRetry,
  });
  const chosen = new Set(value.map((u) => u.login));
  const options = (results.data ?? []).filter((u) => !chosen.has(u.login));
  return (
    <div className={`${s.field} ${s.picker}`}>
      {label}
      <div className={s.chips}>
        {value.map((u) => (
          <span key={u.login} className={s.chip}>
            <UserAvatar user={u} size={14} />
            {u.isTeam ? `@${u.login}` : u.login}
            <button
              type="button"
              aria-label={`Remove ${u.login}`}
              onClick={() => onChange(value.filter((x) => x.login !== u.login))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          type="text"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder="Search…"
          value={text}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
        />
      </div>
      {open && q && (
        <div className={s.dropdown} role="listbox">
          {results.isFetching && !options.length ? (
            <div className={s.hint}>Searching…</div>
          ) : results.error ? (
            <ProviderErrorLine error={results.error} />
          ) : options.length === 0 ? (
            <div className={s.hint}>No matches</div>
          ) : (
            options.map((u) => (
              <button
                key={u.login}
                type="button"
                role="option"
                aria-selected={false}
                className={s.option}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange([...value, u]);
                  setText('');
                }}
              >
                <UserAvatar user={u} size={16} />
                <span>{u.isTeam ? `@${u.login}` : u.login}</span>
                {u.name && <span className={uiStyles.muted}>{u.name}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Label chip picker over the repo's label list. */
export function LabelPicker({
  repoRef,
  value,
  onChange,
}: {
  repoRef: RepoRef;
  value: string[];
  onChange(v: string[]): void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const labels = useQuery({
    queryKey: ik.labels(repoRef),
    queryFn: () => intInvoke('pr:labels', { ref: repoRef }),
    enabled: open || value.length > 0,
    staleTime: 5 * 60_000,
    retry: providerRetry,
  });
  const all = labels.data ?? [];
  const colorOf = (name: string): string | undefined => {
    const c = all.find((l) => l.name === name)?.color;
    return c ? (c.startsWith('#') ? c : `#${c}`) : undefined;
  };
  const needle = text.trim().toLowerCase();
  const options = all.filter((l) => !value.includes(l.name) && l.name.toLowerCase().includes(needle));
  return (
    <div className={`${s.field} ${s.picker}`}>
      Labels
      <div className={s.chips}>
        {value.map((name) => (
          <span key={name} className={s.chip}>
            <span className={s.swatch} style={{ background: colorOf(name) ?? 'var(--kl-text-disabled)' }} />
            {name}
            <button
              type="button"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(value.filter((x) => x !== name))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          type="text"
          aria-label="Search labels"
          placeholder="Filter…"
          value={text}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {open && (
        <div className={s.dropdown} role="listbox">
          {labels.isPending ? (
            <div className={s.hint}>Loading labels…</div>
          ) : labels.error ? (
            <ProviderErrorLine error={labels.error} />
          ) : options.length === 0 ? (
            <div className={s.hint}>No labels</div>
          ) : (
            options.map((l) => (
              <button
                key={l.name}
                type="button"
                role="option"
                aria-selected={false}
                className={s.option}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange([...value, l.name]);
                  setText('');
                }}
              >
                <span
                  className={s.swatch}
                  style={{ background: colorOf(l.name) ?? 'var(--kl-text-disabled)' }}
                />
                {l.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
