import type { RepoId } from '@githappens/git/types';
import type { PullRequest, RepoRef } from '@githappens/providers/types';
import { CheckCircle2, MessageSquare, Plus, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';

import { useContextMenu } from '../../components/ContextMenu';
import { formatDate } from '../../lib/format';
import { useRepoInfo } from '../../repo/queries';
import { useRepoUi } from '../../stores/repo-ui';
import { openIntegrationsPreferences } from '../../integrations/api';
import { STATE_LABEL } from '../../integrations/helpers';
import { customSelection, emptyListText } from '../../integrations/pr-filter-helpers';
import { useIntegrations, usePrList, useResolvedRemotes } from '../../integrations/queries';
import {
  isoSecs,
  ProviderErrorLine,
  RollupIcon,
  StateChip,
  toneClass,
  UserAvatar,
} from '../../integrations/ui';
import { openCreatePullRequest } from './CreatePullRequest';
import { MergedPrPill } from './MergedPrPill';
import { PrFiltersDialog } from './PrFiltersDialog';
import { PrFiltersButton, usePrFilterSelection } from './PrFiltersPicker';
import { checkoutPullRequest, openPullRequestView, prMenu } from './pr-actions';
import s from './PullRequestsSection.module.css';

interface Props {
  repoId: RepoId;
  /** Called by the "Connect an account" empty state; defaults to opening Preferences → Integrations. */
  onConnect?: () => void;
  /** Override how a PR opens; defaults to the PR center view. */
  onOpenPr?: (ref: RepoRef, number: number) => void;
}

/**
 * Left-panel PULL REQUESTS section body (spec 10 §4.5): merged/closed pill for the checked-out branch,
 * filter dropdown (presets, state filters, saved custom filters, "Manage filters…"), refresh, create,
 * PR rows with rollup status, review state and author; click opens the PR view, double-click checks it out.
 */
export function PullRequestsSection({ repoId, onConnect = openIntegrationsPreferences, onOpenPr }: Props) {
  const integrations = useIntegrations();
  const remotes = useResolvedRemotes(repoId);
  const sel = usePrFilterSelection(repoId);
  const [manageOpen, setManageOpen] = useState(false);
  const head = useRepoInfo(repoId).data?.head;
  const accounts = integrations.data ?? [];
  const providerRemotes = (remotes.data ?? []).filter((r) => r.kind);
  const linked = providerRemotes.filter((r) => r.integrationKey && r.ref);
  const enabled = linked.length > 0;
  const list = usePrList(repoId, sel.filter, enabled && sel.ready);
  const queryCapable = linked.some((r) => r.kind === 'github');
  const open = onOpenPr ?? ((ref: RepoRef, n: number) => openPullRequestView(repoId, ref, n));
  const currentBranch = head?.kind === 'branch' ? head.name : null;

  const toolbar = (
    <div className={s.toolbar}>
      <div className={s.presets}>
        <PrFiltersButton sel={sel} onManage={() => setManageOpen(true)} />
      </div>
      <button
        type="button"
        className={s.icon}
        title="Refresh pull requests"
        aria-label="Refresh pull requests"
        disabled={!enabled || list.isFetching}
        onClick={() => void list.refetch()}
      >
        <RefreshCw size={13} />
      </button>
      <button
        type="button"
        className={s.icon}
        title={
          currentBranch
            ? `Create pull request from ${currentBranch}`
            : 'Check out a branch to create a pull request'
        }
        aria-label="Create pull request"
        disabled={!enabled || !currentBranch}
        onClick={() => currentBranch && openCreatePullRequest(repoId, { headBranch: currentBranch })}
      >
        <Plus size={13} />
      </button>
    </div>
  );

  let body;
  if (integrations.isPending || remotes.isPending) {
    body = <p className={s.empty}>Loading…</p>;
  } else if (integrations.error || remotes.error) {
    body = (
      <ProviderErrorLine
        error={integrations.error ?? remotes.error}
        onRetry={() => void (integrations.error ? integrations.refetch() : remotes.refetch())}
      />
    );
  } else if (accounts.length === 0) {
    body = (
      <div className={s.empty}>
        <span>Connect a hosting account to see pull requests.</span>
        <button type="button" onClick={onConnect}>
          Connect an account
        </button>
      </div>
    );
  } else if (!enabled) {
    const host = providerRemotes[0]?.host;
    body = (
      <div className={s.empty}>
        {host ? (
          <>
            <span>No connected account for {host}.</span>
            <button type="button" onClick={onConnect}>
              Connect {host}
            </button>
          </>
        ) : (
          <span>No remote on a supported hosting provider.</span>
        )}
      </div>
    );
  } else if (list.error) {
    body = <ProviderErrorLine error={list.error} onRetry={() => void list.refetch()} />;
  } else if (list.isPending || !sel.ready) {
    body = <p className={s.empty}>Loading pull requests…</p>;
  } else if (!list.data?.length) {
    body = <p className={s.empty}>{emptyListText(sel.filter)}</p>;
  } else {
    body = (
      <div role="list" aria-label="Pull requests">
        {list.data.map((pr) => (
          <PrRow
            key={`${pr.repo.owner}/${pr.repo.name}#${pr.number}`}
            repoId={repoId}
            pr={pr}
            onOpen={() => open(pr.repo, pr.number)}
            refresh={() => void list.refetch()}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={s.section}>
      <MergedPrPill repoId={repoId} />
      {enabled && toolbar}
      {body}
      {enabled && (
        <PrFiltersDialog
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          queryCapable={queryCapable}
          onCreated={(id) => sel.select(customSelection(id))}
        />
      )}
    </div>
  );
}

function tooltip(pr: PullRequest): string {
  const reviewers = pr.reviewers.map((r) => `${r.user.login} (${r.state.replace('_', ' ')})`).join(', ');
  return [
    `#${pr.number} ${pr.title}`,
    `${pr.head.branch} → ${pr.base.branch} · ${STATE_LABEL[pr.state]}`,
    `by ${pr.author.login}, updated ${formatDate(isoSecs(pr.updatedAt))}`,
    reviewers && `Reviewers: ${reviewers}`,
    pr.assignees.length ? `Assignees: ${pr.assignees.map((a) => a.login).join(', ')}` : '',
    pr.labels.length ? `Labels: ${pr.labels.map((l) => l.name).join(', ')}` : '',
    `Checks: ${pr.checksRollup}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function PrRow({
  repoId,
  pr,
  onOpen,
  refresh,
}: {
  repoId: RepoId;
  pr: PullRequest;
  onOpen(): void;
  refresh(): void;
}) {
  const showMenu = useContextMenu((st) => st.show);
  const selected = useRepoUi(repoId, (u) => {
    const c = u.center as { kind: string; number?: number; ref?: RepoRef };
    return (
      c.kind === 'pr' &&
      c.number === pr.number &&
      c.ref?.name === pr.repo.name &&
      c.ref?.owner === pr.repo.owner
    );
  });
  return (
    <div
      role="listitem"
      tabIndex={0}
      title={tooltip(pr)}
      className={`${s.row} ${selected ? s.selected : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onDoubleClick={() => void checkoutPullRequest(repoId, pr)}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, prMenu(repoId, pr, refresh));
      }}
    >
      <RollupIcon rollup={pr.rollup} />
      <span className={s.num}>#{pr.number}</span>
      <span className={s.title}>{pr.title}</span>
      {pr.state === 'draft' && <span className={s.draft}>Draft</span>}
      {(pr.state === 'merged' || pr.state === 'closed') && <StateChip state={pr.state} />}
      {pr.reviewDecision === 'approved' && (
        <CheckCircle2 size={12} className={toneClass('green')} aria-label="Approved" />
      )}
      {pr.reviewDecision === 'changes_requested' && (
        <XCircle size={12} className={toneClass('red')} aria-label="Changes requested" />
      )}
      {pr.commentsCount > 0 && (
        <span className={s.meta} aria-label={`${pr.commentsCount} comments`}>
          <MessageSquare size={11} /> {pr.commentsCount}
        </span>
      )}
      <UserAvatar user={pr.author} size={16} />
    </div>
  );
}
