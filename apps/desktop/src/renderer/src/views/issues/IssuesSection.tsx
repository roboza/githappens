import type { RepoId } from '@githappens/git/types';
import type { Issue } from '@githappens/providers/types';
import { Plus, RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { useContextMenu } from '../../components/ContextMenu';
import { useRepoInfo } from '../../repo/queries';
import { copyText, openExternal, openIntegrationsPreferences } from '../../integrations/api';
import { ISSUE_PRESETS, ISSUE_TRACKER_KINDS, providerLabel, type Tone } from '../../integrations/helpers';
import { useIntegrations, useIssues, useIssueScopes, useResolvedRemotes } from '../../integrations/queries';
import { useIntegrationPrefs } from '../../integrations/stores';
import { issueRefOf } from '../../integrations/issue-helpers';
import { ProviderErrorLine, toneClass, UserAvatar } from '../../integrations/ui';
import { useRememberQueryClient } from './issue-store';
import { openCreateBranchFromIssue, openCreateIssue, openIssueDetail } from './IssueHost';
import s from './IssuesSection.module.css';

const CATEGORY_TONE: Record<Issue['stateCategory'], Tone> = {
  todo: 'grey',
  in_progress: 'blue',
  done: 'green',
};

/**
 * Create a branch named after an issue: opens CreateBranchFromIssueDialog (spec 10 §4.9). Resolves when
 * the branch was created or the dialog was cancelled.
 */
export function createBranchFromIssue(
  repoId: RepoId,
  issue: Issue,
  integrationKey: string,
  base: string,
): Promise<void> {
  return openCreateBranchFromIssue({ repoId, issue, integrationKey, base });
}

/**
 * Left-panel ISSUES section body (spec 10 §4.9): tracker + scope (remembered per repo), preset filter,
 * issue rows; click → Issue panel, "+" → new issue, context menu / double-click → "Create branch from issue".
 */
export function IssuesSection({
  repoId,
  onConnect = openIntegrationsPreferences,
}: {
  repoId: RepoId;
  onConnect?: () => void;
}) {
  useRememberQueryClient();
  const integrations = useIntegrations();
  const remotes = useResolvedRemotes(repoId);
  const info = useRepoInfo(repoId).data;
  const sel = useIntegrationPrefs((st) => st.issues[repoId]);
  const setSel = useIntegrationPrefs((st) => st.setIssues);
  const showMenu = useContextMenu((st) => st.show);
  const [selected, setSelected] = useState<string | null>(null);

  const trackers = useMemo(
    () => (integrations.data ?? []).filter((a) => ISSUE_TRACKER_KINDS.has(a.kind)),
    [integrations.data],
  );
  const remoteKeys = (remotes.data ?? []).map((r) => r.integrationKey).filter(Boolean);
  const tracker =
    trackers.find((t) => t.key === sel?.integrationKey) ??
    trackers.find((t) => remoteKeys.includes(t.key)) ??
    trackers[0];
  const scopes = useIssueScopes(tracker?.key);
  const scopeList = scopes.data ?? [];
  const repoScopes = (remotes.data ?? [])
    .filter((r) => r.integrationKey === tracker?.key && r.ref)
    .map((r) => `${r.ref!.owner}/${r.ref!.name}`.toLowerCase());
  const scope =
    scopeList.find((sc) => sel?.integrationKey === tracker?.key && sc.scope === sel?.scope) ??
    scopeList.find((sc) => repoScopes.includes(sc.scope.toLowerCase())) ??
    scopeList[0];
  const preset = sel?.preset ?? 'assigned';
  const issues = useIssues(tracker?.key, scope?.scope, { preset });
  const items = useMemo(() => issues.data?.pages.flatMap((p) => p.items) ?? [], [issues.data]);

  const base = info?.head.kind === 'branch' ? info.head.name : (info?.head.sha ?? 'HEAD');
  const createBranch = (issue: Issue): void => {
    if (tracker) void createBranchFromIssue(repoId, issue, tracker.key, base);
  };
  // A single click opens the panel after the double-click window, so double-click still creates a branch.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewIssue = (issue: Issue): void => {
    clearTimeout(clickTimer.current);
    if (tracker) openIssueDetail(issueRefOf(issue, tracker.key), { repoId, issue });
  };

  if (integrations.isPending) return <p className={s.empty}>Loading…</p>;
  if (integrations.error)
    return <ProviderErrorLine error={integrations.error} onRetry={() => void integrations.refetch()} />;
  if (!tracker) {
    return (
      <div className={s.empty}>
        <span>Connect GitHub, GitLab, Jira or Azure DevOps to see issues.</span>
        <button type="button" onClick={onConnect}>
          Connect an account
        </button>
      </div>
    );
  }

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        {trackers.length > 1 && (
          <select
            aria-label="Issue tracker"
            value={tracker.key}
            onChange={(e) => setSel(repoId, { integrationKey: e.target.value, scope: undefined })}
          >
            {trackers.map((t) => (
              <option key={t.key} value={t.key}>
                {providerLabel(t.kind)} · {t.login}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Project"
          value={scope?.scope ?? ''}
          disabled={!scopeList.length}
          onChange={(e) => setSel(repoId, { integrationKey: tracker.key, scope: e.target.value })}
        >
          {!scopeList.length && <option value="">{scopes.isPending ? 'Loading…' : 'No projects'}</option>}
          {scopeList.map((sc) => (
            <option key={sc.scope} value={sc.scope}>
              {sc.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Issue filter"
          value={preset}
          onChange={(e) => setSel(repoId, { preset: e.target.value as typeof preset })}
        >
          {ISSUE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {scope && (
          <button
            type="button"
            className={s.icon}
            title="New issue"
            aria-label="New issue"
            onClick={() =>
              openCreateIssue({
                integrationKey: tracker.key,
                scope: scope.scope,
                scopeLabel: scope.label,
                trackerKind: tracker.kind,
                repoId,
              })
            }
          >
            <Plus size={13} />
          </button>
        )}
        <button
          type="button"
          className={s.icon}
          title="Refresh issues"
          aria-label="Refresh issues"
          disabled={issues.isFetching || !scope}
          onClick={() => void issues.refetch()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {scopes.error ? (
        <ProviderErrorLine error={scopes.error} onRetry={() => void scopes.refetch()} />
      ) : issues.error ? (
        <ProviderErrorLine error={issues.error} onRetry={() => void issues.refetch()} />
      ) : !scope ? (
        <p className={s.empty}>{scopes.isPending ? 'Loading projects…' : 'No projects available'}</p>
      ) : issues.isPending ? (
        <p className={s.empty}>Loading issues…</p>
      ) : items.length === 0 ? (
        <p className={s.empty}>No issues</p>
      ) : (
        <div role="list" aria-label="Issues">
          {items.map((issue) => (
            <div
              key={issue.id}
              role="listitem"
              tabIndex={0}
              className={`${s.row} ${selected === issue.id ? s.selected : ''}`}
              title={`${issue.key} ${issue.title}\n${issue.state}${issue.assignees.length ? ` · ${issue.assignees.map((a) => a.login).join(', ')}` : ''}\nClick to view · double-click to create a branch`}
              onClick={() => {
                setSelected(issue.id);
                clearTimeout(clickTimer.current);
                clickTimer.current = setTimeout(() => viewIssue(issue), 250);
              }}
              onDoubleClick={() => {
                clearTimeout(clickTimer.current);
                createBranch(issue);
              }}
              onKeyDown={(e) => e.key === 'Enter' && viewIssue(issue)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(issue.id);
                showMenu(e.clientX, e.clientY, [
                  { label: 'View issue', onSelect: () => viewIssue(issue) },
                  { label: 'Create branch from issue…', onSelect: () => createBranch(issue) },
                  'separator',
                  { label: 'Open in browser', onSelect: () => openExternal(issue.webUrl) },
                  { label: 'Copy link', onSelect: () => copyText(issue.webUrl) },
                  { label: 'Copy key', onSelect: () => copyText(issue.key) },
                ]);
              }}
            >
              <span className={s.key}>{issue.key}</span>
              <span className={s.title}>{issue.title}</span>
              <span className={`${s.state} ${toneClass(CATEGORY_TONE[issue.stateCategory])}`}>
                {issue.state}
              </span>
              {issue.assignees[0] && <UserAvatar user={issue.assignees[0]} size={16} />}
            </div>
          ))}
          {issues.hasNextPage && (
            <div className={s.more}>
              <button
                type="button"
                disabled={issues.isFetchingNextPage}
                onClick={() => void issues.fetchNextPage()}
              >
                {issues.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
