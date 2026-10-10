import type {
  CheckRun,
  CheckStatus,
  IntegrationId,
  MergeMethod,
  PrRollupStatus,
  ProviderUser,
  PullRequest,
  RemoteRepo,
  RepoRef,
  ReviewState,
  TimelineItem,
} from '../types';

// ---------- REST shapes (subset) ----------

export interface GhRestUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  email?: string | null;
  type?: string;
}

export interface GhRestRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description?: string | null;
  private: boolean;
  fork: boolean;
  parent?: { id: number; name: string; owner: { login: string } };
  default_branch?: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  updated_at: string;
  pushed_at?: string | null;
  stargazers_count?: number;
  has_issues?: boolean;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

export function restUser(u: GhRestUser | null | undefined): ProviderUser {
  if (!u) return { id: 'ghost', login: 'ghost' };
  return {
    id: String(u.id),
    login: u.login,
    name: u.name ?? undefined,
    avatarUrl: u.avatar_url,
    email: u.email ?? undefined,
  };
}

export function restRepo(r: GhRestRepo, integration: IntegrationId): RemoteRepo {
  const p = r.permissions;
  return {
    ref: { integration, owner: r.owner.login, name: r.name, id: String(r.id) },
    fullName: r.full_name,
    description: r.description ?? undefined,
    isPrivate: r.private,
    isFork: r.fork,
    parent: r.parent
      ? { integration, owner: r.parent.owner.login, name: r.parent.name, id: String(r.parent.id) }
      : undefined,
    defaultBranch: r.default_branch ?? 'main',
    httpsUrl: r.clone_url,
    sshUrl: r.ssh_url,
    webUrl: r.html_url,
    updatedAt: r.pushed_at && r.pushed_at > r.updated_at ? r.pushed_at : r.updated_at,
    stars: r.stargazers_count,
    viewerPermission: p
      ? p.admin
        ? 'admin'
        : p.maintain
          ? 'maintain'
          : p.push
            ? 'write'
            : p.triage
              ? 'triage'
              : 'read'
      : undefined,
  };
}

// ---------- GraphQL shapes ----------

export interface GqlActor {
  login: string;
  avatarUrl?: string;
  id?: string;
  name?: string | null;
}

export interface GqlPr {
  id: string;
  number: number;
  title: string;
  body: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  isCrossRepository: boolean;
  author: GqlActor | null;
  headRefName: string;
  headRefOid: string;
  headRepository: { id: string; name: string; url: string; sshUrl: string; owner: { login: string } } | null;
  baseRefName: string;
  baseRefOid?: string;
  baseRepository?: {
    id: string;
    name: string;
    owner: { login: string };
    viewerPermission?: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' | null;
    mergeCommitAllowed?: boolean;
    squashMergeAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
  } | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  viewerCanUpdate: boolean;
  viewerDidAuthor: boolean;
  viewerCanMergeAsAdmin?: boolean;
  comments: { totalCount: number };
  reviewRequests?: {
    nodes: Array<{
      asCodeOwner?: boolean;
      requestedReviewer:
        | { __typename: 'User' | 'Bot'; id: string; login: string; name?: string | null; avatarUrl?: string }
        | { __typename: 'Team'; id: string; slug: string; name: string; avatarUrl?: string | null }
        | { __typename: 'Mannequin' }
        | null;
    }>;
  };
  latestOpinionatedReviews?: { nodes: Array<{ state: string; author: GqlActor | null }> };
  assignees?: { nodes: GqlActor[] };
  labels?: { nodes: Array<{ name: string; color: string }> };
  milestone?: { id: string; number?: number; title: string } | null;
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}

export function gqlUser(a: GqlActor | null | undefined): ProviderUser {
  if (!a) return { id: 'ghost', login: 'ghost' };
  return { id: a.id ?? a.login, login: a.login, name: a.name ?? undefined, avatarUrl: a.avatarUrl };
}

export function reviewState(s: string): ReviewState {
  switch (s) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'DISMISSED':
      return 'dismissed';
    case 'PENDING':
      return 'pending';
    default:
      return 'commented';
  }
}

export function rollupState(s: string | null | undefined): PrRollupStatus {
  switch (s) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

/** Spec 10 §4.5 status-icon rules. */
export function computeRollup(
  checks: PrRollupStatus,
  reviewDecision: PullRequest['reviewDecision'],
  mergeable: PullRequest['mergeable'],
): PrRollupStatus {
  if (checks === 'failure' || reviewDecision === 'changes_requested' || mergeable === 'conflicting')
    return 'failure';
  if ((checks === 'success' || checks === 'none') && (reviewDecision === 'approved' || !reviewDecision))
    return 'success';
  return 'pending';
}

export function gqlPr(n: GqlPr, base: RepoRef, viewerLogin?: string): PullRequest {
  const integration = base.integration;
  const state: PullRequest['state'] =
    n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : n.isDraft ? 'draft' : 'open';

  const reviewers = new Map<string, PullRequest['reviewers'][number]>();
  for (const r of n.latestOpinionatedReviews?.nodes ?? []) {
    if (!r.author) continue;
    reviewers.set(r.author.login.toLowerCase(), { user: gqlUser(r.author), state: reviewState(r.state) });
  }
  let reviewRequested = false;
  for (const rr of n.reviewRequests?.nodes ?? []) {
    const rv = rr.requestedReviewer;
    if (!rv || rv.__typename === 'Mannequin') continue;
    if (rv.__typename === 'Team') {
      reviewers.set(`team:${rv.slug}`, {
        user: {
          id: rv.id,
          login: rv.slug,
          name: rv.name,
          avatarUrl: rv.avatarUrl ?? undefined,
          isTeam: true,
        },
        state: 'pending',
        required: rr.asCodeOwner || undefined,
      });
    } else {
      if (viewerLogin && rv.login.toLowerCase() === viewerLogin.toLowerCase()) reviewRequested = true;
      reviewers.set(rv.login.toLowerCase(), {
        user: { id: rv.id, login: rv.login, name: rv.name ?? undefined, avatarUrl: rv.avatarUrl },
        state: 'pending',
        required: rr.asCodeOwner || undefined,
      });
    }
  }

  const reviewDecision: PullRequest['reviewDecision'] =
    n.reviewDecision === 'APPROVED'
      ? 'approved'
      : n.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : n.reviewDecision === 'REVIEW_REQUIRED'
          ? 'review_required'
          : null;
  const mergeable: PullRequest['mergeable'] =
    n.mergeable === 'MERGEABLE' ? 'mergeable' : n.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown';
  const checksRollup = rollupState(n.commits?.nodes[0]?.commit.statusCheckRollup?.state);

  const br = n.baseRepository;
  const allowedMergeMethods: MergeMethod[] = br
    ? [
        ...(br.mergeCommitAllowed ? (['merge'] as const) : []),
        ...(br.squashMergeAllowed ? (['squash'] as const) : []),
        ...(br.rebaseMergeAllowed ? (['rebase'] as const) : []),
      ]
    : ['merge', 'squash', 'rebase'];
  const perm = br?.viewerPermission;
  const canWrite = perm === 'WRITE' || perm === 'MAINTAIN' || perm === 'ADMIN';
  const isOpen = state === 'open' || state === 'draft';

  const hr = n.headRepository;
  const headRepo: RepoRef | null = hr
    ? { integration, owner: hr.owner.login, name: hr.name, id: hr.id }
    : null;

  return {
    repo: base,
    number: n.number,
    id: n.id,
    title: n.title,
    body: n.body ?? '',
    state,
    author: gqlUser(n.author),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    mergedAt: n.mergedAt ?? undefined,
    closedAt: n.closedAt ?? undefined,
    head: {
      repo: headRepo,
      repoCloneUrl: hr ? `${hr.url}.git` : undefined,
      branch: n.headRefName,
      sha: n.headRefOid,
    },
    base: { repo: base, branch: n.baseRefName, sha: n.baseRefOid },
    reviewers: [...reviewers.values()],
    assignees: (n.assignees?.nodes ?? []).map(gqlUser),
    labels: (n.labels?.nodes ?? []).map((l) => ({
      name: l.name,
      color: l.color ? `#${l.color}` : undefined,
    })),
    milestone: n.milestone
      ? { id: String(n.milestone.number ?? n.milestone.id), title: n.milestone.title }
      : undefined,
    reviewDecision,
    mergeable,
    checksRollup,
    rollup: computeRollup(checksRollup, reviewDecision, mergeable),
    commentsCount: n.comments.totalCount,
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    webUrl: n.url,
    isCrossRepository: n.isCrossRepository,
    viewer: {
      canMerge: isOpen && (canWrite || !!n.viewerCanMergeAsAdmin),
      canEdit: n.viewerCanUpdate,
      canApprove: isOpen && !n.viewerDidAuthor,
      isAuthor: n.viewerDidAuthor,
      reviewRequested,
    },
    allowedMergeMethods,
  };
}

// ---------- timeline ----------

interface GqlTimelineNode {
  __typename: string;
  [k: string]: unknown;
}
export interface GqlThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      body: string;
      createdAt: string;
      diffHunk?: string;
      author: GqlActor | null;
    }>;
  };
}

const EVENT_NAMES: Record<string, string> = {
  LabeledEvent: 'labeled',
  UnlabeledEvent: 'unlabeled',
  AssignedEvent: 'assigned',
  UnassignedEvent: 'unassigned',
  ReviewRequestedEvent: 'review_requested',
  ReviewRequestRemovedEvent: 'review_request_removed',
  MergedEvent: 'merged',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
  ReadyForReviewEvent: 'ready_for_review',
  ConvertToDraftEvent: 'convert_to_draft',
  RenamedTitleEvent: 'renamed',
  BaseRefChangedEvent: 'base_changed',
  HeadRefDeletedEvent: 'head_ref_deleted',
};

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function eventDetail(n: Any): string | undefined {
  switch (n.__typename) {
    case 'LabeledEvent':
    case 'UnlabeledEvent':
      return n.label?.name;
    case 'AssignedEvent':
    case 'UnassignedEvent':
      return n.assignee?.login;
    case 'ReviewRequestedEvent':
    case 'ReviewRequestRemovedEvent':
      return n.requestedReviewer?.login ?? n.requestedReviewer?.slug;
    case 'MergedEvent':
      return n.commit?.oid;
    case 'RenamedTitleEvent':
      return `${n.previousTitle} → ${n.currentTitle}`;
    case 'BaseRefChangedEvent':
      return `${n.previousRefName} → ${n.currentRefName}`;
    case 'HeadRefDeletedEvent':
      return n.headRefName;
    default:
      return undefined;
  }
}

/** Converts timeline nodes (+ review threads on the first page) to TimelineItems, sorted by time. */
export function gqlTimeline(nodes: GqlTimelineNode[], threads: GqlThread[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let commits: Extract<TimelineItem, { kind: 'commits' }> | null = null;
  for (const raw of nodes) {
    const n = raw as Any;
    if (n.__typename !== 'PullRequestCommit') commits = null;
    switch (n.__typename) {
      case 'IssueComment':
        out.push({
          kind: 'comment',
          id: String(n.databaseId ?? n.id),
          author: gqlUser(n.author),
          body: n.body ?? '',
          createdAt: n.createdAt,
          editable: !!n.viewerCanUpdate,
        });
        break;
      case 'PullRequestReview':
        // Bare "COMMENTED" reviews are produced by thread replies; their content lives in threads.
        if (n.state === 'COMMENTED' && !n.body) break;
        out.push({
          kind: 'review',
          id: String(n.databaseId ?? n.id),
          author: gqlUser(n.author),
          state: reviewState(n.state),
          body: n.body ?? '',
          createdAt: n.createdAt,
        });
        break;
      case 'PullRequestCommit': {
        const c = n.commit;
        const actor = c.author?.user ? gqlUser(c.author.user) : undefined;
        if (commits && commits.actor?.login === actor?.login) commits.shas.push(c.oid);
        else {
          commits = { kind: 'commits', shas: [c.oid], actor, createdAt: c.committedDate };
          out.push(commits);
        }
        break;
      }
      case 'HeadRefForcePushedEvent':
        out.push({
          kind: 'commits',
          shas: n.afterCommit?.oid ? [n.afterCommit.oid] : [],
          actor: n.actor ? gqlUser(n.actor) : undefined,
          createdAt: n.createdAt,
          forced: true,
        });
        break;
      default: {
        const event = EVENT_NAMES[n.__typename];
        if (!event) break;
        out.push({
          kind: 'event',
          event,
          actor: n.actor ? gqlUser(n.actor) : undefined,
          createdAt: n.createdAt,
          detail: eventDetail(n),
        });
      }
    }
  }
  for (const t of threads) {
    const first = t.comments.nodes[0];
    if (!first) continue;
    out.push({
      kind: 'thread',
      id: t.id,
      path: t.path,
      line: t.line ?? t.originalLine ?? undefined,
      side: t.diffSide,
      diffHunk: first.diffHunk,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({
        id: String(c.databaseId ?? c.id),
        author: gqlUser(c.author),
        body: c.body,
        createdAt: c.createdAt,
      })),
    });
  }
  return out.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
}

const timeOf = (i: TimelineItem): string =>
  i.kind === 'thread' ? (i.comments[0]?.createdAt ?? '') : i.createdAt;

// ---------- checks ----------

export interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  app?: { slug?: string; name?: string } | null;
}
export interface GhStatus {
  id: number;
  context: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  target_url?: string | null;
  created_at: string;
  updated_at: string;
}

export function checkStatus(status: string, conclusion: string | null | undefined): CheckStatus {
  if (status !== 'completed') return status === 'in_progress' ? 'in_progress' : 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'timed_out':
      return 'timed_out';
    case 'action_required':
      return 'action_required';
    default:
      return 'neutral';
  }
}

export function restCheckRun(c: GhCheckRun): CheckRun {
  const actions = c.app?.slug === 'github-actions';
  return {
    id: String(c.id),
    name: c.name,
    group: c.app?.name ?? undefined,
    status: checkStatus(c.status, c.conclusion),
    startedAt: c.started_at ?? undefined,
    completedAt: c.completed_at ?? undefined,
    detailsUrl: c.html_url ?? c.details_url ?? undefined,
    canRerun: actions && c.status === 'completed',
    provider: actions ? 'actions' : 'other',
  };
}

export function restStatus(s: GhStatus): CheckRun {
  return {
    id: `status:${s.id}`,
    name: s.context,
    status: s.state === 'pending' ? 'in_progress' : s.state === 'success' ? 'success' : 'failure',
    startedAt: s.created_at,
    completedAt: s.state === 'pending' ? undefined : s.updated_at,
    detailsUrl: s.target_url ?? undefined,
    canRerun: false,
    provider: 'status-api',
  };
}
