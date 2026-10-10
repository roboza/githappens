import type { RepoId } from '@githappens/git/types';
import type {
  CheckRun,
  CheckStatus,
  MergeMethod,
  PullRequest,
  RepoRef,
  ReviewState,
  TimelineItem,
  UpdatePrInput,
} from '@githappens/providers/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  Link2,
  Loader2,
  MessageSquare,
  MinusCircle,
  MoreHorizontal,
  Quote,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { prompt } from '../../components/Dialogs';
import { formatDate, shortSha } from '../../lib/format';
import { useToastStore } from '../../stores/toasts';
import { copyText, errorLine, intInvoke, openExternal } from '../../integrations/api';
import {
  defaultMergeCommit,
  MERGE_METHOD_LABEL,
  mergeabilitySummary,
  type Tone,
} from '../../integrations/helpers';
import { invalidatePr, usePrChecks, usePrTimeline, usePullRequest } from '../../integrations/queries';
import {
  isoSecs,
  Markdown,
  ProviderErrorLine,
  RollupIcon,
  StateChip,
  toneClass,
  uiStyles,
  UserAvatar,
} from '../../integrations/ui';
import {
  checkoutPullRequest,
  closePullRequest,
  closePullRequestView,
  reopenPullRequest,
  setPullRequestDraft,
} from './pr-actions';
import {
  appendQuote,
  checkCounts,
  checkDuration,
  isFailure,
  issueWebUrl,
  parseLinkedIssues,
  pluralize,
  prViewCaps,
  type PrViewCaps,
} from './pr-view-helpers';
import { PrCommitsTab, usePrFetch } from './PrCommitsTab';
import { EditableBox, LabelsEditor, MilestoneEditor, UserListEditor } from './PrEditors';
import { PrFilesTab } from './PrFilesTab';
import s from './PullRequestView.module.css';
import { SuggestChangesButton, SuggestionsBox } from '../suggest';

interface Props {
  repoId: RepoId;
  repoRef: RepoRef;
  number: number;
}

type Tab = 'overview' | 'commits' | 'files' | 'checks';

const ago = (iso: string | undefined): string => (iso ? formatDate(isoSecs(iso)) : '');
const isTyping = (t: EventTarget): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** Quote `body` into the composer (spec 10 §4.7 "Quote reply"). */
type QuoteFn = (body: string, author?: string) => void;

/**
 * Pull Request center view (spec 10 §4.7): header with state/title/branches and actions; tabs Overview
 * (description, timeline, composer, merge box, sidebar editors), Commits, Files changed and Checks.
 * `Esc` returns to the graph, `R` refreshes.
 */
export default function PullRequestView({ repoId, repoRef, number }: Props) {
  const qc = useQueryClient();
  const pr = usePullRequest(repoRef, number);
  const back = (): void => closePullRequestView(repoId);

  if (!pr.data) {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        back();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        invalidatePr(qc, repoId, repoRef, number);
      }
    };
    return (
      <div className={s.view} tabIndex={-1} onKeyDown={onKeyDown} aria-busy={pr.isPending}>
        <div className={s.header}>
          <div className={s.titleRow}>
            <button
              type="button"
              className={s.bare}
              aria-label="Back to graph"
              title="Back to graph (Esc)"
              onClick={back}
            >
              <ArrowLeft size={16} />
            </button>
            <h1>
              Pull request <span className={s.number}>#{number}</span>
            </h1>
          </div>
          <div style={{ height: 8 }} />
        </div>
        {pr.error ? (
          <ProviderErrorLine error={pr.error} onRetry={() => void pr.refetch()} />
        ) : (
          <div className={s.loading}>
            <div className={s.skeleton} style={{ width: '40%' }} />
            <div className={s.skeleton} style={{ width: '70%' }} />
            <div className={s.skeleton} style={{ width: '55%' }} />
          </div>
        )}
      </div>
    );
  }

  return <LoadedView repoId={repoId} pr={pr.data} fetching={pr.isFetching} onBack={back} />;
}

function LoadedView({
  repoId,
  pr: p,
  fetching,
  onBack,
}: {
  repoId: RepoId;
  pr: PullRequest;
  fetching: boolean;
  onBack(): void;
}) {
  const qc = useQueryClient();
  const checks = usePrChecks(p.repo, p.head.sha);
  const [tab, setTab] = useState<Tab>('overview');
  const [fetchWanted, setFetchWanted] = useState(false);
  const prFetch = usePrFetch(repoId, p, fetchWanted);
  const caps = prViewCaps(p.repo.integration.kind);
  const live = p.state === 'open' || p.state === 'draft';

  // Composer draft lifted here so "Quote reply" anywhere in the timeline can prefill it.
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const quote: QuoteFn = (body, author) => {
    setDraft((d) => appendQuote(d, body, author));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  const refresh = (): void => {
    invalidatePr(qc, repoId, p.repo, p.number);
    void checks.refetch();
  };

  const openTab = (t: Tab): void => {
    if (t === 'commits' || t === 'files') setFetchWanted(true);
    setTab(t);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      refresh();
    }
  };

  const failed = checks.data?.filter((c) => isFailure(c.status)).length ?? 0;
  const tabBtn = (t: Tab, label: string) => (
    <button type="button" role="tab" className={s.tab} aria-selected={tab === t} onClick={() => openTab(t)}>
      {label}
    </button>
  );

  return (
    <div className={s.view} tabIndex={-1} onKeyDown={onKeyDown}>
      <Header repoId={repoId} pr={p} caps={caps} fetching={fetching} onBack={onBack} onRefresh={refresh} />
      <div className={s.header} style={{ paddingTop: 0 }}>
        <div className={s.tabs} role="tablist">
          {tabBtn('overview', 'Overview')}
          {tabBtn('commits', 'Commits')}
          {tabBtn(
            'files',
            p.changedFiles !== undefined ? `Files changed (${p.changedFiles})` : 'Files changed',
          )}
          {tabBtn(
            'checks',
            `Checks ${checks.data ? `(${checks.data.length}${failed ? `, ${failed} failing` : ''})` : ''}`,
          )}
        </div>
      </div>
      {tab === 'files' ? (
        <div className={s.fill}>
          <PrFilesTab repoId={repoId} pr={p} fetch={prFetch} />
        </div>
      ) : (
        <div className={s.scroll}>
          {tab === 'overview' && (
            <div className={s.overview}>
              <div className={s.main}>
                <StateBanner pr={p} onRefresh={refresh} />
                <DescriptionCard repoId={repoId} pr={p} onQuote={quote} />
                <SuggestionsBox repoId={repoId} pr={p} />
                <Timeline repoId={repoId} pr={p} caps={caps} onQuote={quote} />
                <Composer repoId={repoId} pr={p} text={draft} setText={setDraft} inputRef={composerRef} />
                {live && <MergeBox repoId={repoId} pr={p} caps={caps} onRefresh={refresh} />}
              </div>
              <Sidebar
                repoId={repoId}
                pr={p}
                caps={caps}
                checks={checks.data}
                checksError={checks.error}
                onChecks={() => openTab('checks')}
              />
            </div>
          )}
          {tab === 'commits' && <PrCommitsTab repoId={repoId} pr={p} fetch={prFetch} />}
          {tab === 'checks' && (
            <ChecksPane
              pr={p}
              caps={caps}
              checks={checks.data}
              error={checks.error}
              loading={checks.isPending}
              onRetry={() => void checks.refetch()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Header({
  repoId,
  pr,
  caps,
  fetching,
  onBack,
  onRefresh,
}: {
  repoId: RepoId;
  pr: PullRequest;
  caps: PrViewCaps;
  fetching: boolean;
  onBack(): void;
  onRefresh(): void;
}) {
  const showMenu = useContextMenu((st) => st.show);
  const push = useToastStore((st) => st.push);
  const live = pr.state === 'open' || pr.state === 'draft';
  // The head is fetchable while the PR is open, or when its source repo still exists.
  const canCheckout = !!pr.head.repo && (live || !!pr.head.branch);
  const checkoutTitle = canCheckout
    ? 'Fetch and check out the PR branch'
    : 'The source repository of this pull request was deleted';

  const update = async (patch: UpdatePrInput, what: string): Promise<void> => {
    try {
      await intInvoke('pr:update', { ref: pr.repo, number: pr.number, patch });
      onRefresh();
    } catch (e) {
      push({ kind: 'error', title: `Could not ${what}`, body: errorLine(e) });
    }
  };

  const editTitle = async (): Promise<void> => {
    const r = await prompt({
      title: 'Edit title',
      initial: pr.title,
      okLabel: 'Save',
      validate: (v) => (v.trim() ? null : 'Title is required.'),
    });
    if (r && r.value.trim() !== pr.title) await update({ title: r.value.trim() }, 'rename the pull request');
  };

  const menu = (): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (pr.viewer.canEdit) items.push({ label: 'Edit title…', onSelect: () => void editTitle() });
    if (caps.prDraft && live && pr.viewer.canEdit) {
      items.push(
        pr.state === 'draft'
          ? { label: 'Ready for review', onSelect: () => void setPullRequestDraft(pr, false, onRefresh) }
          : { label: 'Convert to draft', onSelect: () => void setPullRequestDraft(pr, true, onRefresh) },
      );
    }
    items.push(
      {
        label: 'Checkout',
        disabled: !canCheckout,
        title: canCheckout ? undefined : checkoutTitle,
        onSelect: () => void checkoutPullRequest(repoId, pr),
      },
      {
        label: 'Checkout in new worktree',
        disabled: !canCheckout,
        title: canCheckout ? undefined : checkoutTitle,
        onSelect: () => void checkoutPullRequest(repoId, pr, 'worktree'),
      },
      'separator',
      { label: 'Copy link', onSelect: () => copyText(pr.webUrl) },
      { label: 'Copy number', onSelect: () => copyText(`#${pr.number}`) },
    );
    if (pr.viewer.canEdit && pr.state === 'closed') {
      items.push('separator', {
        label: 'Reopen pull request',
        onSelect: () => void reopenPullRequest(pr, onRefresh),
      });
    } else if (pr.viewer.canEdit && live) {
      items.push('separator', {
        label: 'Close pull request…',
        danger: true,
        onSelect: () => void closePullRequest(pr, onRefresh),
      });
    }
    return items;
  };

  return (
    <div className={s.header}>
      <div className={s.titleRow}>
        <button
          type="button"
          className={s.bare}
          aria-label="Back to graph"
          title="Back to graph (Esc)"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <StateChip state={pr.state} />
        <h1
          title={pr.viewer.canEdit ? `${pr.title} (double-click to edit)` : pr.title}
          onDoubleClick={() => pr.viewer.canEdit && void editTitle()}
        >
          {pr.title} <span className={s.number}>#{pr.number}</span>
        </h1>
        <button
          type="button"
          className={s.iconBtn}
          title="Refresh (R)"
          onClick={onRefresh}
          disabled={fetching}
        >
          <RefreshCw size={13} className={fetching ? uiStyles.spin : undefined} />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          title="Open in browser"
          onClick={() => openExternal(pr.webUrl)}
        >
          <ExternalLink size={13} /> Open on web
        </button>
        <SuggestChangesButton repoId={repoId} pr={pr} />
        {live && (
          <button
            type="button"
            className={s.iconBtn}
            title={checkoutTitle}
            disabled={!canCheckout}
            onClick={() => void checkoutPullRequest(repoId, pr)}
          >
            <Download size={13} /> Checkout
          </button>
        )}
        <button
          type="button"
          className={s.iconBtn}
          aria-label="More actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 2, menu());
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className={s.meta}>
        <UserAvatar user={pr.author} size={16} />
        <span>
          <strong>{pr.author.login}</strong> {pr.state === 'merged' ? 'merged' : 'wants to merge'}
          {pr.changedFiles !== undefined ? ` ${pr.changedFiles} files` : ''} into
        </span>
        <span className={s.branch}>{pr.base.branch}</span>
        <span>from</span>
        <span
          className={s.branch}
          title={pr.head.repo ? `${pr.head.repo.owner}/${pr.head.repo.name}` : 'deleted fork'}
        >
          {pr.isCrossRepository && pr.head.repo ? `${pr.head.repo.owner}:` : ''}
          {pr.head.branch}
        </span>
        {pr.additions !== undefined && (
          <span>
            <span className={toneClass('green')}>+{pr.additions}</span>{' '}
            <span className={toneClass('red')}>−{pr.deletions ?? 0}</span>
          </span>
        )}
        {pr.stack && (
          <span title="Stacked pull requests">
            · {pr.stack.position} of {pr.stack.size} in stack
          </span>
        )}
        <span>· updated {ago(pr.updatedAt)}</span>
      </div>
    </div>
  );
}

/** Merged / closed banner (spec 10 §4.7). */
function StateBanner({ pr, onRefresh }: { pr: PullRequest; onRefresh(): void }) {
  const t = usePrTimeline(pr.repo, pr.number);
  if (pr.state !== 'merged' && pr.state !== 'closed') return null;
  const items = t.data?.pages.flatMap((pg) => pg.items) ?? [];
  const ev = [...items]
    .reverse()
    .find(
      (it): it is Extract<TimelineItem, { kind: 'event' }> =>
        it.kind === 'event' && it.event === (pr.state === 'merged' ? 'merged' : 'closed'),
    );
  if (pr.state === 'merged') {
    const sha = ev?.detail && /^[0-9a-f]{7,64}$/i.test(ev.detail) ? ev.detail : undefined;
    return (
      <div className={`${s.banner} ${s.bannerMerged}`} role="status">
        <GitMerge size={14} />
        <span className={s.grow}>
          Merged{ev?.actor ? ` by ${ev.actor.login}` : ''} into <code>{pr.base.branch}</code>
          {pr.mergedAt ? ` ${ago(pr.mergedAt)}` : ''}
          {sha && (
            <>
              {' '}
              as{' '}
              <button
                type="button"
                className={uiStyles.linkBtn}
                title="Copy sha"
                onClick={() => copyText(sha)}
              >
                <code>{shortSha(sha)}</code>
              </button>
            </>
          )}
          .{' '}
          {pr.head.repo && (
            <span className={s.dim}>
              The <code>{pr.head.branch}</code> branch can be deleted if it is no longer needed.
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className={`${s.banner} ${s.bannerClosed}`} role="status">
      <XCircle size={14} />
      <span className={s.grow}>
        Closed{ev?.actor ? ` by ${ev.actor.login}` : ''}
        {pr.closedAt ? ` ${ago(pr.closedAt)}` : ''} without merging.
      </span>
      {pr.viewer.canEdit && (
        <button type="button" className={s.iconBtn} onClick={() => void reopenPullRequest(pr, onRefresh)}>
          <RotateCcw size={12} /> Reopen
        </button>
      )}
    </div>
  );
}

/** Description card with markdown editing (Edit → Write/Preview, Ctrl+Enter saves, Esc cancels). */
function DescriptionCard({ repoId, pr, onQuote }: { repoId: RepoId; pr: PullRequest; onQuote: QuoteFn }) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (editing === null || busy) return;
    if (editing === pr.body) {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      await intInvoke('pr:update', { ref: pr.repo, number: pr.number, patch: { body: editing } });
      setEditing(null);
      setPreview(false);
    } catch (e) {
      push({ kind: 'error', title: 'Could not update the description', body: errorLine(e) });
    } finally {
      setBusy(false);
      invalidatePr(qc, repoId, pr.repo, pr.number);
    }
  };

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <UserAvatar user={pr.author} size={16} />
        <span className={s.grow}>
          <strong>{pr.author.login}</strong> opened {ago(pr.createdAt)}
        </span>
        {editing === null && (
          <>
            {pr.body.trim() && (
              <button
                type="button"
                className={s.linkAction}
                title="Quote reply"
                onClick={() => onQuote(pr.body, pr.author.login)}
              >
                <Quote size={11} /> Quote reply
              </button>
            )}
            {pr.viewer.canEdit && (
              <button
                type="button"
                className={s.linkAction}
                onClick={() => {
                  setEditing(pr.body);
                  setPreview(false);
                }}
              >
                Edit
              </button>
            )}
          </>
        )}
      </div>
      {editing === null ? (
        <div className={s.cardBody}>
          <Markdown text={pr.body} />
        </div>
      ) : (
        <div className={s.composer}>
          <div className={s.segmented} role="group" aria-label="Editor mode">
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
          {preview ? (
            <div className={s.previewBox}>
              <Markdown text={editing} />
            </div>
          ) : (
            <textarea
              aria-label="Description"
              autoFocus
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
            />
          )}
          <div className={s.actions}>
            <span className={s.grow}>Markdown supported · Ctrl+Enter to save</span>
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
              {busy && <Loader2 size={13} className={uiStyles.spin} />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const REVIEW_TEXT: Record<ReviewState, { text: string; tone: Tone }> = {
  approved: { text: 'approved these changes', tone: 'green' },
  changes_requested: { text: 'requested changes', tone: 'red' },
  commented: { text: 'reviewed', tone: 'grey' },
  pending: { text: 'started a review', tone: 'yellow' },
  dismissed: { text: 'review dismissed', tone: 'grey' },
};

function Timeline({
  repoId,
  pr,
  caps,
  onQuote,
}: {
  repoId: RepoId;
  pr: PullRequest;
  caps: PrViewCaps;
  onQuote: QuoteFn;
}) {
  const t = usePrTimeline(pr.repo, pr.number);
  if (t.error) return <ProviderErrorLine error={t.error} onRetry={() => void t.refetch()} />;
  if (!t.data) return <div className={s.dim}>Loading timeline…</div>;
  const items = t.data.pages.flatMap((pg) => pg.items);
  return (
    <>
      {items.map((it, i) => (
        <TimelineEntry
          key={'id' in it ? it.id : `${it.kind}-${i}`}
          repoId={repoId}
          pr={pr}
          caps={caps}
          item={it}
          onQuote={onQuote}
        />
      ))}
      {t.hasNextPage && (
        <div className={s.actions} style={{ justifyContent: 'center' }}>
          <button type="button" disabled={t.isFetchingNextPage} onClick={() => void t.fetchNextPage()}>
            {t.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

function QuoteButton({ body, author, onQuote }: { body: string; author: string; onQuote: QuoteFn }) {
  if (!body.trim()) return null;
  return (
    <button
      type="button"
      className={s.linkAction}
      title="Quote reply"
      aria-label={`Quote reply to ${author}`}
      onClick={() => onQuote(body, author)}
    >
      <Quote size={11} /> Quote reply
    </button>
  );
}

function TimelineEntry({
  repoId,
  pr,
  caps,
  item,
  onQuote,
}: {
  repoId: RepoId;
  pr: PullRequest;
  caps: PrViewCaps;
  item: TimelineItem;
  onQuote: QuoteFn;
}) {
  switch (item.kind) {
    case 'comment':
      return (
        <div className={s.card}>
          <div className={s.cardHead}>
            <UserAvatar user={item.author} size={16} />
            <span className={s.grow}>
              <strong>{item.author.login}</strong> commented {ago(item.createdAt)}
            </span>
            <QuoteButton body={item.body} author={item.author.login} onQuote={onQuote} />
          </div>
          <div className={s.cardBody}>
            <Markdown text={item.body} empty="" />
          </div>
        </div>
      );
    case 'review': {
      const r = REVIEW_TEXT[item.state];
      if (!item.body.trim()) {
        return (
          <div className={s.event}>
            <ReviewIcon state={item.state} />
            <UserAvatar user={item.author} size={14} />
            <strong>{item.author.login}</strong>
            <span className={toneClass(r.tone)}>{r.text}</span> {ago(item.createdAt)}
          </div>
        );
      }
      return (
        <div className={s.card}>
          <div className={s.cardHead}>
            <ReviewIcon state={item.state} />
            <UserAvatar user={item.author} size={16} />
            <span className={s.grow}>
              <strong>{item.author.login}</strong> <span className={toneClass(r.tone)}>{r.text}</span>{' '}
              {ago(item.createdAt)}
            </span>
            <QuoteButton body={item.body} author={item.author.login} onQuote={onQuote} />
          </div>
          <div className={s.cardBody}>
            <Markdown text={item.body} empty="" />
          </div>
        </div>
      );
    }
    case 'thread':
      return <ThreadCard repoId={repoId} pr={pr} caps={caps} thread={item} onQuote={onQuote} />;
    case 'commits':
      return (
        <div className={s.event}>
          <GitCommitHorizontal size={13} />
          {item.actor && <strong>{item.actor.login}</strong>}
          {item.forced ? 'force-pushed' : 'pushed'} {item.shas.length} commit
          {item.shas.length === 1 ? '' : 's'}
          {item.shas.slice(0, 5).map((sha) => (
            <code key={sha}>{shortSha(sha)}</code>
          ))}
          {item.shas.length > 5 && '…'} {ago(item.createdAt)}
        </div>
      );
    case 'event':
      return (
        <div className={s.event}>
          <CircleDot size={11} />
          {item.actor && <strong>{item.actor.login}</strong>}
          {item.event.replace(/_/g, ' ')}
          {item.detail && <code>{item.detail}</code>} {ago(item.createdAt)}
        </div>
      );
  }
}

/**
 * Review thread: resolved threads start collapsed; Resolve / Unresolve (provider `reviewThreadsResolve`) and an
 * inline Reply box (`pr:comment { inReplyTo: thread.id }` — every provider's `addComment` accepts the thread id).
 */
function ThreadCard({
  repoId,
  pr,
  caps,
  thread,
  onQuote,
}: {
  repoId: RepoId;
  pr: PullRequest;
  caps: PrViewCaps;
  thread: Extract<TimelineItem, { kind: 'thread' }>;
  onQuote: QuoteFn;
}) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const [expanded, setExpanded] = useState(!thread.resolved);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'reply' | 'resolve'>(null);
  const hunk = thread.diffHunk?.split('\n').slice(-6).join('\n');
  const count = thread.comments.length;

  const resolve = async (resolved: boolean): Promise<void> => {
    setBusy('resolve');
    try {
      await intInvoke('pr:resolveThread', { ref: pr.repo, threadId: thread.id, resolved });
      if (resolved) setExpanded(false);
    } catch (e) {
      push({
        kind: 'error',
        title: resolved ? 'Could not resolve the conversation' : 'Could not unresolve the conversation',
        body: errorLine(e),
      });
    } finally {
      setBusy(null);
      invalidatePr(qc, repoId, pr.repo, pr.number);
    }
  };

  const sendReply = async (): Promise<void> => {
    if (!reply?.trim() || busy) return;
    setBusy('reply');
    try {
      await intInvoke('pr:comment', { ref: pr.repo, number: pr.number, body: reply, inReplyTo: thread.id });
      setReply(null);
    } catch (e) {
      push({ kind: 'error', title: 'Could not reply', body: errorLine(e) });
    } finally {
      setBusy(null);
      invalidatePr(qc, repoId, pr.repo, pr.number);
    }
  };

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <button
          type="button"
          className={s.bare}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse conversation' : 'Expand conversation'}
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <MessageSquare size={12} />
        <span className={`${s.path} ${s.grow}`}>
          {thread.path}
          {thread.line !== undefined ? `:${thread.line}` : ''}
          {!expanded && <span className={s.dim}> · {pluralize(count, 'comment')}</span>}
        </span>
        {thread.resolved && <span className={s.badge}>Resolved</span>}
        {thread.outdated && <span className={s.badge}>Outdated</span>}
      </div>
      {expanded && (
        <>
          {hunk && <pre className={s.hunk}>{hunk}</pre>}
          {thread.comments.map((c) => (
            <div key={c.id} className={`${s.cardBody} ${s.reply}`}>
              <div className={s.event} style={{ padding: '0 0 4px' }}>
                <UserAvatar user={c.author} size={14} />
                <strong>{c.author.login}</strong>
                <span className={s.grow}>{ago(c.createdAt)}</span>
                <QuoteButton body={c.body} author={c.author.login} onQuote={onQuote} />
              </div>
              <Markdown text={c.body} empty="" />
            </div>
          ))}
          {reply !== null ? (
            <div className={s.composer}>
              <textarea
                aria-label="Reply"
                autoFocus
                placeholder="Reply… (Ctrl+Enter to send)"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void sendReply();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setReply(null);
                  }
                }}
              />
              <div className={s.actions}>
                <button type="button" disabled={!!busy} onClick={() => setReply(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!!busy || !reply.trim()}
                  onClick={() => void sendReply()}
                >
                  {busy === 'reply' && <Loader2 size={13} className={uiStyles.spin} />} Reply
                </button>
              </div>
            </div>
          ) : (
            <div className={s.threadActions}>
              <button type="button" className={s.iconBtn} onClick={() => setReply('')}>
                Reply…
              </button>
              {caps.reviewThreadsResolve && (
                <button
                  type="button"
                  className={s.iconBtn}
                  disabled={!!busy}
                  onClick={() => void resolve(!thread.resolved)}
                >
                  {busy === 'resolve' && <Loader2 size={12} className={uiStyles.spin} />}
                  {thread.resolved ? 'Unresolve conversation' : 'Resolve conversation'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ReviewIcon({ state }: { state: ReviewState }) {
  if (state === 'approved')
    return <CheckCircle2 size={13} className={toneClass('green')} aria-label="Approved" />;
  if (state === 'changes_requested')
    return <XCircle size={13} className={toneClass('red')} aria-label="Changes requested" />;
  if (state === 'pending')
    return <CircleDashed size={13} className={toneClass('yellow')} aria-label="Pending" />;
  return <MessageSquare size={13} className={toneClass('grey')} aria-label="Commented" />;
}

/** Comment + review composer (Ctrl/Cmd+Enter comments). Text is owned by the view (quote reply). */
function Composer({
  repoId,
  pr,
  text,
  setText,
  inputRef,
}: {
  repoId: RepoId;
  pr: PullRequest;
  text: string;
  setText(v: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | 'comment' | 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'>(null);
  const [error, setError] = useState<unknown>(null);
  const push = useToastStore((st) => st.push);
  const canReview =
    pr.viewer.canApprove && !pr.viewer.isAuthor && (pr.state === 'open' || pr.state === 'draft');

  const run = async (kind: NonNullable<typeof busy>): Promise<void> => {
    if (kind === 'comment' && !text.trim()) return;
    if (kind === 'REQUEST_CHANGES' && !text.trim()) {
      setError(new Error('Explain which changes you are requesting.'));
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'comment') {
        await intInvoke('pr:comment', { ref: pr.repo, number: pr.number, body: text });
      } else {
        await intInvoke('pr:review', {
          ref: pr.repo,
          number: pr.number,
          input: { event: kind, body: text.trim() || undefined, commitSha: pr.head.sha },
        });
        push({
          kind: 'success',
          title:
            kind === 'APPROVE'
              ? `Approved #${pr.number}`
              : kind === 'REQUEST_CHANGES'
                ? `Requested changes on #${pr.number}`
                : `Review submitted`,
        });
      }
      setText('');
      invalidatePr(qc, repoId, pr.repo, pr.number);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={s.card}>
      <div className={s.composer}>
        <textarea
          ref={inputRef}
          aria-label="Comment"
          placeholder="Leave a comment (Markdown). Ctrl+Enter to send."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run('comment');
            }
          }}
        />
        {error !== null && <ProviderErrorLine error={error} />}
        <div className={s.actions}>
          <span className={s.grow}>Markdown supported</span>
          {canReview && (
            <>
              <button
                type="button"
                className={s.reject}
                disabled={!!busy}
                onClick={() => void run('REQUEST_CHANGES')}
              >
                {busy === 'REQUEST_CHANGES' && <Loader2 size={13} className={uiStyles.spin} />} Request
                changes
              </button>
              <button
                type="button"
                className={s.approve}
                disabled={!!busy}
                onClick={() => void run('APPROVE')}
              >
                {busy === 'APPROVE' && <Loader2 size={13} className={uiStyles.spin} />} Approve
              </button>
            </>
          )}
          <button
            type="button"
            className="primary"
            disabled={!!busy || !text.trim()}
            onClick={() => void run('comment')}
          >
            {busy === 'comment' && <Loader2 size={13} className={uiStyles.spin} />} Comment
          </button>
        </div>
      </div>
    </div>
  );
}

function MergeBox({
  repoId,
  pr,
  caps,
  onRefresh,
}: {
  repoId: RepoId;
  pr: PullRequest;
  caps: PrViewCaps;
  onRefresh(): void;
}) {
  const qc = useQueryClient();
  const push = useToastStore((st) => st.push);
  const methods: MergeMethod[] = pr.allowedMergeMethods.length ? pr.allowedMergeMethods : ['merge'];
  const [method, setMethod] = useState<MergeMethod>(methods[0]!);
  const defaults = defaultMergeCommit(pr, method);
  const [title, setTitle] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(!pr.isCrossRepository);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The PR model has no auto-merge state: remember what we set in this view.
  const [autoMerge, setAutoMerge] = useState<MergeMethod | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const summary = mergeabilitySummary(pr);
  const isDraft = pr.state === 'draft';
  const disabledReason = !pr.viewer.canMerge
    ? 'You do not have permission to merge this pull request'
    : isDraft
      ? 'Draft pull requests cannot be merged — mark it ready for review first'
      : summary.blocked
        ? summary.text
        : undefined;

  const merge = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await intInvoke('pr:merge', {
        ref: pr.repo,
        number: pr.number,
        method,
        title: defaults ? (title ?? defaults.title) : undefined,
        message: defaults ? (message ?? defaults.message) : undefined,
        deleteBranch,
        expectedHeadSha: pr.head.sha,
      });
      if (r.merged) push({ kind: 'success', title: `Merged #${pr.number}`, body: r.message });
      else setError(new Error(r.message ?? 'The provider did not merge the pull request.'));
      invalidatePr(qc, repoId, pr.repo, pr.number);
    } catch (e) {
      setError(e);
      // Head moved / stale state: refresh so a retry uses the new head sha (spec 10 §8).
      invalidatePr(qc, repoId, pr.repo, pr.number);
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoMerge = async (enable: boolean): Promise<void> => {
    setAutoBusy(true);
    try {
      await intInvoke('pr:setAutoMerge', { ref: pr.repo, number: pr.number, method: enable ? method : null });
      setAutoMerge(enable ? method : null);
      push({
        kind: 'success',
        title: enable ? `Auto-merge enabled for #${pr.number}` : `Auto-merge disabled for #${pr.number}`,
      });
      invalidatePr(qc, repoId, pr.repo, pr.number);
    } catch (e) {
      push({
        kind: 'error',
        title: enable ? 'Could not enable auto-merge' : 'Could not disable auto-merge',
        body: errorLine(e),
      });
    } finally {
      setAutoBusy(false);
    }
  };

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={`${s.mergeLine} ${toneClass(isDraft ? 'grey' : summary.tone)}`}>
          <RollupIcon
            rollup={
              isDraft
                ? 'pending'
                : summary.tone === 'green'
                  ? 'success'
                  : summary.tone === 'red'
                    ? 'failure'
                    : 'pending'
            }
          />
          {isDraft ? 'This pull request is still a draft' : summary.text}
        </span>
      </div>
      <div className={s.mergeForm}>
        {isDraft && caps.prDraft && pr.viewer.canEdit && (
          <div className={s.actions} style={{ justifyContent: 'flex-start' }}>
            <button
              type="button"
              className="primary"
              onClick={() => void setPullRequestDraft(pr, false, onRefresh)}
            >
              Ready for review
            </button>
          </div>
        )}
        <select
          aria-label="Merge method"
          value={method}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
        >
          {methods.map((m) => (
            <option key={m} value={m}>
              {MERGE_METHOD_LABEL[m] ?? m}
            </option>
          ))}
        </select>
        {defaults && (
          <>
            <input
              type="text"
              aria-label="Commit title"
              value={title ?? defaults.title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              aria-label="Commit message"
              value={message ?? defaults.message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </>
        )}
        <label className={s.check}>
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />{' '}
          Delete source branch after merge
        </label>
        {caps.prAutoMerge && pr.viewer.canMerge && (
          <label className={s.check}>
            <input
              type="checkbox"
              checked={autoMerge !== null}
              disabled={autoBusy}
              onChange={(e) => void toggleAutoMerge(e.target.checked)}
            />{' '}
            {autoMerge
              ? `Auto-merge enabled (${MERGE_METHOD_LABEL[autoMerge] ?? autoMerge})`
              : 'Enable auto-merge — merge automatically when all requirements are met'}
            {autoBusy && <Loader2 size={12} className={uiStyles.spin} />}
          </label>
        )}
        {error !== null && <ProviderErrorLine error={error} />}
        <div className={s.actions}>
          <button
            type="button"
            className="primary"
            disabled={busy || !!disabledReason}
            title={disabledReason}
            onClick={() => void merge()}
          >
            {busy && <Loader2 size={13} className={uiStyles.spin} />} {MERGE_METHOD_LABEL[method] ?? 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckIcon({ status }: { status: CheckStatus }) {
  if (status === 'success')
    return <CheckCircle2 size={13} className={toneClass('green')} aria-label="Passed" />;
  if (isFailure(status)) return <XCircle size={13} className={toneClass('red')} aria-label="Failed" />;
  if (status === 'queued' || status === 'in_progress')
    return <CircleDot size={13} className={toneClass('yellow')} aria-label="In progress" />;
  return <MinusCircle size={13} className={toneClass('grey')} aria-label={status} />;
}

function ChecksPane({
  pr,
  caps,
  checks,
  error,
  loading,
  onRetry,
}: {
  pr: PullRequest;
  caps: PrViewCaps;
  checks: CheckRun[] | undefined;
  error: unknown;
  loading: boolean;
  onRetry(): void;
}) {
  const push = useToastStore((st) => st.push);
  const [rerunning, setRerunning] = useState(false);
  if (error) return <ProviderErrorLine error={error} onRetry={onRetry} />;
  if (loading || !checks) return <div className={s.loading}>Loading checks…</div>;
  if (!checks.length) return <div className={s.loading}>No checks reported for the head commit.</div>;
  const failed = checks.filter((c) => isFailure(c.status)).length;

  const rerunFailed = async (): Promise<void> => {
    setRerunning(true);
    try {
      const r = await intInvoke('ci:rerunFailed', { ref: pr.repo, branch: pr.head.branch });
      push(
        r.rerun
          ? { kind: 'success', title: `Re-running ${pluralize(r.rerun, 'failed workflow')}` }
          : { kind: 'info', title: 'No failed runs to re-run' },
      );
      onRetry();
    } catch (e) {
      push({ kind: 'error', title: 'Could not re-run the failed checks', body: errorLine(e) });
    } finally {
      setRerunning(false);
    }
  };

  const groups = new Map<string, CheckRun[]>();
  for (const c of checks) groups.set(c.group ?? 'Checks', [...(groups.get(c.group ?? 'Checks') ?? []), c]);
  return (
    <div className={s.checksPane}>
      {caps.ciRerun && failed > 0 && (
        <div className={s.tabToolbar}>
          <span className={s.grow}>{pluralize(failed, 'failing check')}</span>
          <button type="button" className={s.iconBtn} disabled={rerunning} onClick={() => void rerunFailed()}>
            {rerunning ? <Loader2 size={12} className={uiStyles.spin} /> : <RotateCcw size={12} />} Re-run
            failed checks
          </button>
        </div>
      )}
      {[...groups].map(([group, list]) => (
        <div key={group} className={s.card}>
          <div className={s.cardHead}>
            <strong>{group}</strong>
          </div>
          {list.map((c) => (
            <div key={c.id} className={s.checkRow}>
              <CheckIcon status={c.status} />
              <span title={c.name}>{c.name}</span>
              <span className={s.dim}>{c.status.replace(/_/g, ' ')}</span>
              <span className={s.dim}>{checkDuration(c)}</span>
              {c.detailsUrl && (
                <button type="button" className={s.iconBtn} onClick={() => openExternal(c.detailsUrl!)}>
                  <ExternalLink size={12} /> Details
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Closing references / Jira keys of the PR plus the branch's linked issue (spec 10 §4.7). */
function LinkedIssuesBox({ repoId, pr }: { repoId: RepoId; pr: PullRequest }) {
  const kind = pr.repo.integration.kind;
  const link = useQuery({
    queryKey: ['issues', 'linkForBranch', repoId, pr.head.branch],
    queryFn: () => intInvoke('issues:linkForBranch', { repoId, branch: pr.head.branch }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const refs = parseLinkedIssues(pr.title, pr.body, pr.head.branch);
  const branchIssue = link.data ?? null;
  type Chip = { key: string; label: string; url: string | null; title?: string };
  const chips: Chip[] = refs.map((r) => {
    if (r.kind === 'jira') {
      const url =
        branchIssue && branchIssue.key.toUpperCase() === r.key.toUpperCase() ? branchIssue.webUrl : null;
      return { key: `j:${r.key}`, label: r.key, url };
    }
    const label = `${r.repo ?? ''}#${r.number}`;
    return {
      key: `n:${label}`,
      label,
      url: issueWebUrl(kind, pr.webUrl, r.number, r.repo),
      title: r.closing ? 'Closed when this pull request is merged' : undefined,
    };
  });
  if (branchIssue) {
    const norm = (k: string): string => k.replace(/^#/, '').toUpperCase();
    const dup = chips.some((c) => norm(c.label) === norm(branchIssue.key));
    if (!dup) {
      chips.push({
        key: `b:${branchIssue.key}`,
        label: branchIssue.key,
        url: branchIssue.webUrl || null,
        title: `Linked to ${pr.head.branch}`,
      });
    }
  }

  return (
    <section className={s.box}>
      <h3>Linked issues</h3>
      {chips.length === 0 ? (
        <span className={s.none}>None</span>
      ) : (
        <div className={s.labels}>
          {chips.map((c) =>
            c.url ? (
              <button
                key={c.key}
                type="button"
                className={`${s.label} ${s.chipLink}`}
                title={c.title ?? c.url}
                onClick={() => openExternal(c.url!)}
              >
                <Link2 size={10} /> {c.label}
              </button>
            ) : (
              <span key={c.key} className={s.label} title={c.title}>
                {c.label}
              </span>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function Sidebar({
  repoId,
  pr,
  caps,
  checks,
  checksError,
  onChecks,
}: {
  repoId: RepoId;
  pr: PullRequest;
  caps: PrViewCaps;
  checks: CheckRun[] | undefined;
  checksError: unknown;
  onChecks(): void;
}) {
  const counts = checks ? checkCounts(checks) : null;
  const editable = pr.viewer.canEdit && (pr.state === 'open' || pr.state === 'draft');
  return (
    <aside className={s.sidebar}>
      <EditableBox
        title="Reviewers"
        editable={editable}
        editor={() => <UserListEditor repoId={repoId} pr={pr} field="reviewers" />}
      >
        {pr.reviewers.length === 0 ? (
          <span className={s.none}>No reviewers</span>
        ) : (
          pr.reviewers.map((r) => (
            <div
              key={r.user.login}
              className={s.person}
              title={`${r.user.login}: ${r.state.replace('_', ' ')}`}
            >
              <UserAvatar user={r.user} size={18} />
              <span>
                {r.user.isTeam ? '@' : ''}
                {r.user.login}
                {r.required ? ' *' : ''}
              </span>
              <ReviewIcon state={r.state} />
            </div>
          ))
        )}
      </EditableBox>
      {caps.prAssignees && (
        <EditableBox
          title="Assignees"
          editable={editable}
          editor={() => <UserListEditor repoId={repoId} pr={pr} field="assignees" />}
        >
          {pr.assignees.length === 0 ? (
            <span className={s.none}>No one assigned</span>
          ) : (
            pr.assignees.map((u) => (
              <div key={u.login} className={s.person}>
                <UserAvatar user={u} size={18} />
                <span>{u.login}</span>
              </div>
            ))
          )}
        </EditableBox>
      )}
      {caps.prLabels && (
        <EditableBox
          title="Labels"
          editable={editable}
          editor={() => <LabelsEditor repoId={repoId} pr={pr} />}
        >
          {pr.labels.length === 0 ? (
            <span className={s.none}>None</span>
          ) : (
            <div className={s.labels}>
              {pr.labels.map((l) => (
                <span key={l.name} className={s.label}>
                  {l.color && (
                    <span
                      className={s.swatch}
                      style={{ background: l.color.startsWith('#') ? l.color : `#${l.color}` }}
                    />
                  )}
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </EditableBox>
      )}
      {caps.prMilestone && (
        <EditableBox
          title="Milestone"
          editable={editable}
          editor={(close) => <MilestoneEditor repoId={repoId} pr={pr} onDone={close} />}
        >
          {pr.milestone ? <span>{pr.milestone.title}</span> : <span className={s.none}>No milestone</span>}
        </EditableBox>
      )}
      <LinkedIssuesBox repoId={repoId} pr={pr} />
      <section className={s.box}>
        <h3>Checks</h3>
        {checksError ? (
          <span className={toneClass('red')}>{errorLine(checksError)}</span>
        ) : !counts ? (
          <span className={s.none}>Loading…</span>
        ) : checks!.length === 0 ? (
          <span className={s.none}>No checks</span>
        ) : (
          <button type="button" className={uiStyles.linkBtn} onClick={onChecks}>
            {counts.passed} passed
            {counts.failed ? `, ${counts.failed} failed` : ''}
            {counts.pending ? `, ${counts.pending} pending` : ''}
            {counts.other ? `, ${counts.other} skipped` : ''}
          </button>
        )}
      </section>
      <section className={s.box}>
        <h3>Head</h3>
        <code className={s.dim}>{shortSha(pr.head.sha)}</code>
      </section>
    </aside>
  );
}
