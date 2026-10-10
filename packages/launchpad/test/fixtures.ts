import type { IntegrationId, Issue, PullRequest, RepoRef } from '@githappens/providers/types';

import { issueItem, prItem, wipItem } from '../src/items';
import type { ClassifyContext, Involvement, LaunchpadIssue, LaunchpadPr, WipStatus } from '../src/types';

export const GH: IntegrationId = { kind: 'github', host: 'github.com', accountId: '1' };
export const GH_KEY = 'github:github.com:1';
export const REF: RepoRef = { integration: GH, owner: 'acme', name: 'app' };
export const ME = { id: '1', login: 'me' };
export const ALICE = { id: '2', login: 'alice' };
export const BOB = { id: '3', login: 'bob' };
export const NOW = Date.parse('2026-10-09T12:00:00Z');

type PrPatch = Omit<Partial<PullRequest>, 'viewer'> & { viewer?: Partial<PullRequest['viewer']> };

export function pr(p: PrPatch = {}): PullRequest {
  const base: PullRequest = {
    repo: REF,
    number: 1,
    id: 'PR_1',
    title: 'Add login',
    body: '',
    state: 'open',
    author: ALICE,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    head: { repo: REF, branch: 'feature/login', sha: 'aaa' },
    base: { repo: REF, branch: 'main' },
    reviewers: [],
    assignees: [],
    labels: [],
    reviewDecision: null,
    mergeable: 'unknown',
    checksRollup: 'pending',
    rollup: 'pending',
    commentsCount: 0,
    webUrl: 'https://github.com/acme/app/pull/1',
    isCrossRepository: false,
    viewer: { canMerge: false, canEdit: false, canApprove: true, isAuthor: false, reviewRequested: false },
    allowedMergeMethods: ['merge', 'squash'],
  };
  return { ...base, ...p, viewer: { ...base.viewer, ...p.viewer } } as PullRequest;
}

/** A PR authored by the viewer. */
export const mine = (p: PrPatch = {}): PullRequest =>
  pr({ author: ME, ...p, viewer: { isAuthor: true, canEdit: true, canApprove: false, ...p.viewer } });

export const prIt = (
  p: PullRequest,
  inv: Involvement[] = [],
  extra: Partial<LaunchpadPr> = {},
): LaunchpadPr => ({
  ...prItem(p, inv),
  ...extra,
});

export function issue(p: Partial<Issue> = {}): Issue {
  return {
    tracker: {
      kind: 'jira-cloud',
      integration: { kind: 'jira-cloud', host: 'acme.atlassian.net', accountId: 'J1' },
      scope: 'ABC',
    },
    key: 'ABC-12',
    id: '10012',
    title: 'Fix crash on save',
    body: '',
    bodyFormat: 'adf',
    state: 'To Do',
    stateCategory: 'todo',
    assignees: [{ id: 'J1', login: 'me' }],
    labels: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    webUrl: 'https://acme.atlassian.net/browse/ABC-12',
    ...p,
  };
}
export const issueIt = (i: Issue, inv: Involvement[] = ['assignee']): LaunchpadIssue => issueItem(i, inv);

export function wip(p: Partial<WipStatus> = {}): WipStatus {
  return {
    path: 'C:\\code\\app',
    name: 'app',
    branch: 'main',
    staged: 1,
    unstaged: 2,
    untracked: 0,
    conflicted: 0,
    lastModified: '2026-10-09T10:00:00Z',
    ...p,
  };
}
export const wipIt = (w: WipStatus) => wipItem(w, NOW);

export const ctx = (c: Partial<ClassifyContext> = {}): ClassifyContext => ({
  now: NOW,
  viewers: { [GH_KEY]: ME },
  ...c,
});
