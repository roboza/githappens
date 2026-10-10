import { integrationKey, type Issue, type PullRequest } from '@githappens/providers/types';

import { issueUid, prUid, wipUid } from './ids';
import type { Involvement, LaunchpadIssue, LaunchpadPr, LaunchpadWip, WipStatus } from './types';

/** Normalize a provider PR into a Launchpad item (§6.4 step 2). */
export function prItem(pr: PullRequest, involvement: Involvement[] = []): LaunchpadPr {
  const inv = new Set(involvement);
  if (pr.viewer.isAuthor) inv.add('author');
  if (pr.viewer.reviewRequested) inv.add('review-requested');
  return {
    uid: prUid(pr),
    type: 'pr',
    title: pr.title,
    updatedAt: pr.updatedAt,
    webUrl: pr.webUrl,
    integrationKey: integrationKey(pr.repo.integration),
    repo: { fullName: `${pr.repo.owner}/${pr.repo.name}`, provider: pr.repo.integration.kind },
    involvement: [...inv],
    pr,
  };
}

/**
 * Display name of an issue's scope: Trello scopes are `"{boardId}/{boardName}"` → board name;
 * everything else (repo full name, Jira project, Azure "org/project") is shown as is.
 */
export function issueScopeLabel(issue: Pick<Issue, 'tracker'>): string {
  const { kind, scope } = issue.tracker;
  if (kind === 'trello') {
    const i = scope.indexOf('/');
    return i < 0 ? scope : scope.slice(i + 1);
  }
  return scope;
}

export function issueItem(issue: Issue, involvement: Involvement[] = []): LaunchpadIssue {
  return {
    uid: issueUid(issue),
    type: 'issue',
    title: issue.title,
    updatedAt: issue.updatedAt,
    webUrl: issue.webUrl,
    integrationKey: integrationKey(issue.tracker.integration),
    repo: { fullName: issueScopeLabel(issue), provider: issue.tracker.kind },
    involvement,
    issue,
  };
}

export const wipCount = (s: WipStatus): number => s.staged + s.unstaged + s.untracked + s.conflicted;

export function wipItem(status: WipStatus, now = Date.now()): LaunchpadWip {
  return {
    uid: wipUid(status.path),
    type: 'wip',
    title: status.name,
    updatedAt: status.lastModified ?? new Date(now).toISOString(),
    repo: { fullName: status.name, localPath: status.path },
    involvement: [],
    status,
  };
}
