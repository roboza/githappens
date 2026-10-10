import type { ProviderInsights } from './insights';

/**
 * Normalized provider models and abstractions (spec 10 §5). Pure types — imported by
 * the renderer via '@githappens/providers/types'. No Electron, no Node APIs.
 */

// ---- identifiers (§5.1) ----

export type ProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'bitbucket-dc' | 'azure-devops';
export type TrackerKind = 'github' | 'gitlab' | 'jira-cloud' | 'jira-dc' | 'trello' | 'azure-boards';

export interface IntegrationId {
  kind: ProviderKind | TrackerKind;
  /** 'github.com', 'ghe.acme.com', 'dev.azure.com', 'acme.atlassian.net' */
  host: string;
  /** Provider user id (stable). */
  accountId: string;
}
export const integrationKey = (i: IntegrationId): string => `${i.kind}:${i.host}:${i.accountId}`;

export interface RepoRef {
  integration: IntegrationId;
  /** GH owner / GL namespace path / BB workspace / BBDC project key / Azure "org/project". */
  owner: string;
  name: string;
  id?: string;
}

/** A connected account as shown in the UI (no secrets). */
export interface ConnectedIntegration extends IntegrationId {
  key: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  authType: 'oauth' | 'pat';
  scopes: string[];
  connectedAt: number;
}

// ---- normalized models (§5.2) ----

export interface ProviderUser {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
  isTeam?: boolean;
}

export interface RemoteRepo {
  ref: RepoRef;
  fullName: string;
  description?: string;
  isPrivate: boolean;
  isFork: boolean;
  parent?: RepoRef;
  defaultBranch: string;
  httpsUrl: string;
  sshUrl: string;
  webUrl: string;
  updatedAt: string;
  stars?: number;
  viewerPermission?: 'read' | 'triage' | 'write' | 'maintain' | 'admin';
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';
export type CheckStatus =
  | 'queued'
  | 'in_progress'
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required';
export type PrRollupStatus = 'success' | 'pending' | 'failure' | 'none';
export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'rebase-merge' | 'semi-linear' | 'fast-forward';

export interface PullRequest {
  repo: RepoRef;
  number: number;
  id: string;
  title: string;
  body: string;
  state: PrState;
  author: ProviderUser;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  /** repo null => deleted fork */
  head: { repo: RepoRef | null; repoCloneUrl?: string; branch: string; sha: string };
  base: { repo: RepoRef; branch: string; sha?: string };
  reviewers: Array<{ user: ProviderUser; state: ReviewState; required?: boolean }>;
  assignees: ProviderUser[];
  labels: Array<{ name: string; color?: string }>;
  milestone?: { id: string; title: string };
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required' | null;
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  checksRollup: PrRollupStatus;
  rollup: PrRollupStatus;
  commentsCount: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  webUrl: string;
  isCrossRepository: boolean;
  viewer: {
    canMerge: boolean;
    canEdit: boolean;
    canApprove: boolean;
    isAuthor: boolean;
    reviewRequested: boolean;
  };
  allowedMergeMethods: MergeMethod[];
  stack?: { position: number; size: number; prev?: number; next?: number };
  /** For conditional refresh. */
  etag?: string;
}

export type TimelineItem =
  | { kind: 'comment'; id: string; author: ProviderUser; body: string; createdAt: string; editable: boolean }
  | { kind: 'review'; id: string; author: ProviderUser; state: ReviewState; body: string; createdAt: string }
  | {
      kind: 'thread';
      id: string;
      path: string;
      line?: number;
      side?: 'LEFT' | 'RIGHT';
      diffHunk?: string;
      resolved: boolean;
      outdated: boolean;
      comments: Array<{ id: string; author: ProviderUser; body: string; createdAt: string }>;
    }
  | { kind: 'commits'; shas: string[]; actor?: ProviderUser; createdAt: string; forced?: boolean }
  | { kind: 'event'; event: string; actor?: ProviderUser; createdAt: string; detail?: string };

export interface CheckRun {
  id: string;
  name: string;
  /** workflow / pipeline / build definition */
  group?: string;
  status: CheckStatus;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  canRerun: boolean;
  provider: 'actions' | 'gitlab-ci' | 'bitbucket-pipelines' | 'azure-pipelines' | 'status-api' | 'other';
}

export interface Issue {
  /** scope: repo full name / Jira site+project / Trello board / Azure org/project */
  tracker: { kind: TrackerKind; integration: IntegrationId; scope: string };
  /** '#12', 'ABC-12', Trello shortLink, Azure id */
  key: string;
  id: string;
  title: string;
  body: string;
  bodyFormat: 'markdown' | 'adf' | 'html';
  state: string;
  stateCategory: 'todo' | 'in_progress' | 'done';
  type?: string;
  priority?: string;
  assignees: ProviderUser[];
  reporter?: ProviderUser;
  labels: string[];
  sprint?: string;
  fixVersions?: string[];
  milestone?: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  commentsCount?: number;
}
export interface IssueRef {
  trackerKind: TrackerKind;
  integrationKey: string;
  scope: string;
  key: string;
  webUrl: string;
}

// ---- provider abstraction (§5.3) ----

export interface ProviderCapabilities {
  oauth: boolean;
  pat: boolean;
  graphql: boolean;
  prDraft: boolean;
  prLabels: boolean;
  prAssignees: boolean;
  prMilestone: boolean;
  prTeamsAsReviewers: boolean;
  prTemplates: boolean;
  prAutoMerge: boolean;
  prStacks: boolean;
  reviewThreadsResolve: boolean;
  mergeMethods: MergeMethod[];
  sshKeyUpload: boolean;
  forkList: boolean;
  createRepo: boolean;
  ci: boolean;
  ciRerun: boolean;
  issues: boolean;
  /** e.g. 'refs/pull/{n}/head' */
  prRefspec: string | null;
}

export interface ListPage<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface PrFilter {
  preset?: 'mine' | 'review-requested' | 'assigned' | 'all';
  state?: 'open' | 'closed' | 'merged' | 'all';
  query?: string;
  author?: string;
  head?: string;
}
export interface CreatePrInput {
  base: RepoRef;
  baseBranch: string;
  head: RepoRef;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
  reviewers?: string[];
  teamReviewers?: string[];
  assignees?: string[];
  labels?: string[];
  milestone?: string;
  deleteSourceBranch?: boolean;
  squash?: boolean;
}
export type UpdatePrInput = Partial<
  Pick<
    CreatePrInput,
    'title' | 'body' | 'reviewers' | 'teamReviewers' | 'assignees' | 'labels' | 'milestone' | 'baseBranch'
  >
> & { state?: 'open' | 'closed' };
export interface SubmitReviewInput {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body?: string;
  comments?: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; startLine?: number; body: string }>;
  commitSha: string;
}

// ---- personal queries for the Launchpad (spec 11 §6.4) ----

/** How the viewer is involved with a PR / issue. */
export type Involvement = 'author' | 'assignee' | 'reviewer' | 'review-requested' | 'mentioned' | 'creator';

export interface MyPullRequestsOptions {
  /** Restrict to these repositories (workspace scope). Omitted → every repo of the account. */
  repos?: Array<{ owner: string; name: string }>;
  /** Max results per underlying query (default 50). */
  limit?: number;
}
export interface MyPullRequest {
  pr: PullRequest;
  involvement: Involvement[];
}
export interface MyIssuesOptions {
  /** Restrict to these tracker scopes (repo full names / Jira project keys). */
  scopes?: string[];
  /** Also return open issues the viewer created (default true). */
  includeCreated?: boolean;
  limit?: number;
}
export interface MyIssue {
  issue: Issue;
  involvement: Involvement[];
}

/** Merge rows of several personal queries by a key, unioning involvement (first payload wins). */
export function mergeInvolved<T extends { involvement: Involvement[] }>(
  rows: Iterable<T>,
  key: (row: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const cur = out.get(k);
    if (!cur) out.set(k, { ...r, involvement: [...new Set(r.involvement)] });
    else cur.involvement = [...new Set([...cur.involvement, ...r.involvement])];
  }
  return [...out.values()];
}

export interface HostingProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  // identity
  getViewer(): Promise<ProviderUser>;
  getGrantedScopes(): Promise<string[]>;

  // repos
  listRepos(opts: {
    owner?: string;
    query?: string;
    cursor?: string;
    pageSize?: number;
  }): Promise<ListPage<RemoteRepo>>;
  listOwners(): Promise<
    Array<{ login: string; avatarUrl?: string; kind: 'user' | 'org' | 'group' | 'workspace' | 'project' }>
  >;
  getRepo(ref: RepoRef): Promise<RemoteRepo>;
  listForks(ref: RepoRef, cursor?: string): Promise<ListPage<RemoteRepo>>;
  createFork?(ref: RepoRef, opts?: { owner?: string }): Promise<RemoteRepo>;
  createRepo?(opts: {
    owner?: string;
    name: string;
    private: boolean;
    description?: string;
    gitignore?: string;
    license?: string;
  }): Promise<RemoteRepo>;
  /** Pure parse of a clone URL for this provider/host; null when it doesn't belong to it. */
  matchRemoteUrl(url: string): Omit<RepoRef, 'integration'> | null;

  // pull requests
  listPullRequests(ref: RepoRef, filter: PrFilter, cursor?: string): Promise<ListPage<PullRequest>>;
  getPullRequest(
    ref: RepoRef,
    number: number,
    opts?: { etag?: string },
  ): Promise<PullRequest | 'not-modified'>;
  getTimeline(ref: RepoRef, number: number, cursor?: string): Promise<ListPage<TimelineItem>>;
  getChecks(ref: RepoRef, sha: string): Promise<CheckRun[]>;
  listPrTemplates(ref: RepoRef, branch: string): Promise<Array<{ name: string; path: string; body: string }>>;
  searchUsers(ref: RepoRef, query: string): Promise<ProviderUser[]>;
  listLabels(ref: RepoRef): Promise<Array<{ name: string; color?: string }>>;
  listMilestones?(ref: RepoRef): Promise<Array<{ id: string; title: string }>>;
  createPullRequest(input: CreatePrInput): Promise<PullRequest>;
  updatePullRequest(ref: RepoRef, number: number, patch: UpdatePrInput): Promise<PullRequest>;
  addComment(ref: RepoRef, number: number, body: string, inReplyTo?: string): Promise<TimelineItem>;
  submitReview(ref: RepoRef, number: number, input: SubmitReviewInput): Promise<void>;
  setThreadResolved?(ref: RepoRef, threadId: string, resolved: boolean): Promise<void>;
  merge(
    ref: RepoRef,
    number: number,
    input: {
      method: MergeMethod;
      title?: string;
      message?: string;
      deleteBranch?: boolean;
      expectedHeadSha: string;
    },
  ): Promise<{ merged: boolean; sha?: string; message?: string }>;
  setAutoMerge?(ref: RepoRef, number: number, method: MergeMethod | null): Promise<void>;
  close(ref: RepoRef, number: number): Promise<void>;
  reopen?(ref: RepoRef, number: number): Promise<void>;
  setDraft?(ref: RepoRef, number: number, draft: boolean): Promise<void>;

  // CI
  listCiRuns?(
    ref: RepoRef,
    opts: { branch?: string; cursor?: string },
  ): Promise<
    ListPage<CheckRun & { runNumber?: number; branch?: string; event?: string; actor?: ProviderUser }>
  >;
  rerunCi?(ref: RepoRef, runId: string, opts?: { failedOnly?: boolean }): Promise<void>;
  cancelCi?(ref: RepoRef, runId: string): Promise<void>;

  // Launchpad (spec 11 §6.4): one cross-repo search per account instead of one call per repo.
  /** Open PRs the viewer authored, is assigned to, is requested to review or is mentioned in. */
  searchMyPullRequests?(opts?: MyPullRequestsOptions): Promise<MyPullRequest[]>;
  /** Insights queries (spec 14 §6.6); see `insights.ts`. */
  insights?(): ProviderInsights;

  // SSH
  uploadSshKey?(title: string, publicKey: string): Promise<{ id: string }>;
  listSshKeys?(): Promise<Array<{ id: string; title: string; fingerprint?: string }>>;
}

export interface IssueFilter {
  preset?: 'assigned' | 'created' | 'mentioned' | 'all-open';
  /** JQL, GH query, WIQL */
  query?: string;
  updatedSince?: string;
}

export interface IssueTracker {
  readonly kind: TrackerKind;
  listScopes(): Promise<Array<{ scope: string; label: string }>>;
  listIssues(scope: string, filter: IssueFilter, cursor?: string): Promise<ListPage<Issue>>;
  getIssue(scope: string, key: string): Promise<Issue>;
  createIssue?(
    scope: string,
    input: { title: string; body?: string; type?: string; assignees?: string[]; labels?: string[] },
  ): Promise<Issue>;
  updateIssue?(
    scope: string,
    key: string,
    patch: Partial<{ title: string; body: string; assignees: string[]; labels: string[] }>,
  ): Promise<Issue>;
  listTransitions?(
    scope: string,
    key: string,
  ): Promise<Array<{ id: string; name: string; toCategory: Issue['stateCategory'] }>>;
  transition?(scope: string, key: string, transitionId: string): Promise<void>;
  /** Open issues assigned to (and optionally created by) the viewer across scopes (spec 11 §6.4). */
  searchMyIssues?(opts?: MyIssuesOptions): Promise<MyIssue[]>;
  addComment?(scope: string, key: string, body: string): Promise<void>;
  listComments?(
    scope: string,
    key: string,
  ): Promise<Array<{ id: string; author: ProviderUser; body: string; createdAt: string }>>;
}

// ---- errors (§5.5) ----

export type ProviderErrorCode =
  | 'auth_required'
  | 'token_expired'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'not_found'
  | 'forbidden_org_policy'
  | 'network'
  | 'conflict'
  | 'validation'
  | 'unsupported'
  | 'server';

export interface SerializedProviderError {
  code: ProviderErrorCode;
  message: string;
  retryAt?: number;
  missingScopes?: string[];
  providerMessage?: string;
  helpUrl?: string;
}

/** Branch → PR mapping for graph badges (spec 10 §5.4 PrIndex). */
export interface PrIndexEntry {
  remote: string;
  branch: string;
  pr: Pick<PullRequest, 'number' | 'title' | 'state' | 'rollup' | 'stack' | 'webUrl'> &
    Partial<Pick<PullRequest, 'mergedAt' | 'closedAt' | 'updatedAt'>>;
}
