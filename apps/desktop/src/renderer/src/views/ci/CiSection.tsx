import type { RepoId } from '@githappens/git/types';
import type { CheckStatus, RepoRef } from '@githappens/providers/types';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  MinusCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { useContextMenu, type MenuEntry } from '../../components/ContextMenu';
import { useRepoInfo } from '../../repo/queries';
import { useToastStore } from '../../stores/toasts';
import type { CiRun } from '../../../../shared/ipc/integrations-contract';
import { errorLine, intInvoke, openExternal, openIntegrationsPreferences } from '../../integrations/api';
import { refKey } from '../../integrations/helpers';
import { useCiRuns, useIntegrations, useResolvedRemotes } from '../../integrations/queries';
import { ProviderErrorLine, toneClass, uiStyles, UserAvatar } from '../../integrations/ui';
import {
  CI_STATUS_LABEL,
  ciSectionTitle,
  ciStatusTone,
  dedupeRuns,
  groupRuns,
  pickCiRemote,
  runActions,
  runTooltip,
  shortAge,
} from './ci-helpers';
import s from './CiSection.module.css';

export { ciSectionTitle } from './ci-helpers';

type Scope = 'current' | 'all';

const scopeKey = (repoId: RepoId): string => `kl.ci.scope.${repoId}`;
function loadScope(repoId: RepoId): Scope {
  try {
    return window.localStorage.getItem(scopeKey(repoId)) === 'all' ? 'all' : 'current';
  } catch {
    return 'current';
  }
}
function saveScope(repoId: RepoId, scope: Scope): void {
  try {
    window.localStorage.setItem(scopeKey(repoId), scope);
  } catch {
    // storage unavailable: keep the choice for this session only
  }
}

/** Invalidate cached CI runs (all, or one repo's) after a re-run / cancel. */
export function invalidateCiRuns(qc: QueryClient, ref?: RepoRef): void {
  void qc.invalidateQueries({ queryKey: ref ? ['ci', refKey(ref), ref.owner, ref.name] : ['ci'] });
}

/** "ACTIONS" / "PIPELINES" for the repo's CI remote (left-panel section header). */
export function useCiSectionTitle(repoId: RepoId): string {
  const remotes = useResolvedRemotes(repoId);
  return ciSectionTitle(pickCiRemote(remotes.data ?? [])?.kind);
}

async function runMutation(
  qc: QueryClient,
  ref: RepoRef,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    useToastStore.getState().push({ kind: 'success', title: label });
  } catch (e) {
    useToastStore.getState().push({ kind: 'error', title: `${label} failed`, body: errorLine(e) });
  } finally {
    invalidateCiRuns(qc, ref);
  }
}

/** Context menu of a CI run row (spec 10 §4.8). */
export function ciRunMenu(qc: QueryClient, ref: RepoRef, run: CiRun): MenuEntry[] {
  const a = runActions(run);
  const name = `${run.name}${run.runNumber !== undefined ? ` #${run.runNumber}` : ''}`;
  return [
    {
      label: 'Open in browser',
      disabled: !a.open,
      onSelect: () => run.detailsUrl && openExternal(run.detailsUrl),
    },
    'separator',
    {
      label: 'Re-run',
      disabled: !a.rerun,
      title: !run.canRerun ? 'This run cannot be re-run' : a.cancel ? 'The run is still running' : undefined,
      onSelect: () =>
        void runMutation(qc, ref, `Re-running ${name}`, () => intInvoke('ci:rerun', { ref, runId: run.id })),
    },
    ...(a.rerunFailed
      ? [
          {
            label: 'Re-run failed jobs',
            onSelect: () =>
              void runMutation(qc, ref, `Re-running failed jobs of ${name}`, () =>
                intInvoke('ci:rerun', { ref, runId: run.id, failedOnly: true }),
              ),
          },
        ]
      : []),
    ...(a.cancel
      ? [
          {
            label: 'Cancel run',
            danger: true,
            onSelect: () =>
              void runMutation(qc, ref, `Cancelled ${name}`, () =>
                intInvoke('ci:cancel', { ref, runId: run.id }),
              ),
          },
        ]
      : []),
  ];
}

interface Props {
  repoId: RepoId;
  /** Poll only while the section is expanded (default true). */
  active?: boolean;
  onConnect?: () => void;
}

/**
 * Left-panel ACTIONS / PIPELINES section body (spec 10 §4.8): CI runs of the provider remote (origin
 * first) for the current branch or all branches, grouped by workflow, with re-run / cancel.
 */
export function CiSection({ repoId, active = true, onConnect = openIntegrationsPreferences }: Props) {
  const qc = useQueryClient();
  const integrations = useIntegrations();
  const remotes = useResolvedRemotes(repoId);
  const head = useRepoInfo(repoId).data?.head;
  const [scope, setScopeState] = useState<Scope>(() => loadScope(repoId));
  const currentBranch = head?.kind === 'branch' ? head.name : undefined;
  const providerRemotes = (remotes.data ?? []).filter((r) => r.kind);
  const remote = pickCiRemote(providerRemotes);
  const ref = remote?.integrationKey ? remote.ref : undefined;
  const branch = scope === 'current' ? currentBranch : undefined;
  const queryEnabled = active && !!ref && (scope === 'all' || !!currentBranch);
  const runs = useCiRuns(ref, branch, queryEnabled);
  const items = useMemo(() => dedupeRuns(runs.data?.pages.flatMap((p) => p.items) ?? []), [runs.data]);
  const groups = useMemo(() => groupRuns(items), [items]);
  const accounts = integrations.data ?? [];

  const setScope = (v: Scope): void => {
    setScopeState(v);
    saveScope(repoId, v);
  };

  const toolbar = (
    <div className={s.toolbar}>
      <div className={s.scopes} role="group" aria-label="Branch filter">
        <button
          type="button"
          className={s.scope}
          aria-pressed={scope === 'current'}
          title={currentBranch ? `Runs on ${currentBranch}` : 'HEAD is detached'}
          onClick={() => setScope('current')}
        >
          Current branch
        </button>
        <button
          type="button"
          className={s.scope}
          aria-pressed={scope === 'all'}
          onClick={() => setScope('all')}
        >
          All branches
        </button>
      </div>
      <button
        type="button"
        className={s.icon}
        title="Refresh runs"
        aria-label="Refresh runs"
        disabled={!queryEnabled || runs.isFetching}
        onClick={() => void runs.refetch()}
      >
        <RefreshCw size={13} className={runs.isFetching ? uiStyles.spin : undefined} />
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
  } else if (!remote) {
    body = <p className={s.empty}>No remote on a supported hosting provider.</p>;
  } else if (accounts.length === 0 || !ref) {
    body = (
      <div className={s.empty}>
        <span>Connect {remote.host ?? 'the hosting provider'} to see CI runs.</span>
        <button type="button" onClick={onConnect}>
          Connect {remote.host ?? 'an account'}
        </button>
      </div>
    );
  } else if (scope === 'current' && !currentBranch) {
    body = <p className={s.empty}>Check out a branch to see its runs.</p>;
  } else if (runs.error) {
    body = <ProviderErrorLine error={runs.error} onRetry={() => void runs.refetch()} />;
  } else if (runs.isPending) {
    body = <p className={s.empty}>Loading runs…</p>;
  } else if (!items.length) {
    body = <p className={s.empty}>{branch ? `No runs on ${branch}` : 'No runs yet'}</p>;
  } else {
    body = (
      <div role="list" aria-label="CI runs">
        {groups.map((g) => (
          <div key={g.group} role="group" aria-label={g.group}>
            <div className={s.group} title={g.group}>
              <span className={s.groupName}>{g.group}</span>
              <span className={s.count}>{g.runs.length}</span>
            </div>
            {g.runs.map((r) => (
              <RunRow key={r.id} run={r} onMenu={() => ciRunMenu(qc, ref, r)} showBranch={!branch} />
            ))}
          </div>
        ))}
        {runs.hasNextPage && (
          <button
            type="button"
            className={s.more}
            disabled={runs.isFetchingNextPage}
            onClick={() => void runs.fetchNextPage()}
          >
            {runs.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={s.section}>
      {ref && toolbar}
      {body}
    </div>
  );
}

export function CiStatusIcon({ status, size = 13 }: { status: CheckStatus; size?: number }) {
  const cls = toneClass(ciStatusTone(status));
  const label = CI_STATUS_LABEL[status];
  switch (status) {
    case 'success':
      return <CheckCircle2 size={size} className={cls} aria-label={label} />;
    case 'failure':
      return <XCircle size={size} className={cls} aria-label={label} />;
    case 'timed_out':
      return <Clock size={size} className={cls} aria-label={label} />;
    case 'in_progress':
      return <Loader2 size={size} className={`${cls} ${uiStyles.spin}`} aria-label={label} />;
    case 'queued':
      return <CircleDashed size={size} className={cls} aria-label={label} />;
    case 'cancelled':
      return <Ban size={size} className={cls} aria-label={label} />;
    case 'action_required':
      return <AlertCircle size={size} className={cls} aria-label={label} />;
    default:
      return <MinusCircle size={size} className={cls} aria-label={label} />;
  }
}

function RunRow({ run, onMenu, showBranch }: { run: CiRun; onMenu(): MenuEntry[]; showBranch: boolean }) {
  const showMenu = useContextMenu((st) => st.show);
  const open = (): void => {
    if (run.detailsUrl) openExternal(run.detailsUrl);
  };
  const time = run.startedAt ?? run.completedAt;
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={s.row}
      title={runTooltip(run)}
      onDoubleClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, onMenu());
      }}
    >
      <CiStatusIcon status={run.status} />
      {run.runNumber !== undefined && <span className={s.num}>#{run.runNumber}</span>}
      <span className={s.name}>{run.name}</span>
      {showBranch && run.branch && <span className={s.branch}>{run.branch}</span>}
      {run.event && <span className={s.meta}>{run.event}</span>}
      {run.actor && <UserAvatar user={run.actor} size={14} />}
      {time && <span className={s.meta}>{shortAge(time)}</span>}
    </div>
  );
}
