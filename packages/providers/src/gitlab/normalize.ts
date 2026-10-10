import { computeRollup } from '../github/normalize';
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
  TimelineItem,
} from '../types';

export interface GlUser {
  id: number;
  username: string;
  name?: string;
  avatar_url?: string | null;
  email?: string | null;
  public_email?: string | null;
}

export interface GlProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  namespace?: { full_path: string; kind?: string };
  description?: string | null;
  visibility?: 'private' | 'internal' | 'public';
  forked_from_project?: { id: number; path_with_namespace: string } | null;
  default_branch?: string | null;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  web_url: string;
  last_activity_at: string;
  star_count?: number;
  issues_enabled?: boolean;
  merge_method?: 'merge' | 'rebase_merge' | 'ff';
  squash_option?: 'never' | 'always' | 'default_on' | 'default_off';
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

export interface GlMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft?: boolean;
  work_in_progress?: boolean;
  author: GlUser;
  assignees?: GlUser[];
  reviewers?: GlUser[];
  labels?: Array<string | { name: string; color?: string }>;
  milestone?: { id: number; title: string } | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  source_branch: string;
  target_branch: string;
  source_project_id: number | null;
  target_project_id: number;
  sha: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  user_notes_count?: number;
  changes_count?: string | null;
  web_url: string;
  references?: { full?: string };
  head_pipeline?: { id: number; status: string } | null;
  user?: { can_merge?: boolean };
}

export interface GlApprovals {
  approved?: boolean;
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: Array<{ user: GlUser }>;
  user_has_approved?: boolean;
  user_can_approve?: boolean;
}

export function glUser(u: GlUser | null | undefined): ProviderUser {
  if (!u) return { id: 'ghost', login: 'ghost' };
  return {
    id: String(u.id),
    login: u.username,
    name: u.name ?? undefined,
    avatarUrl: u.avatar_url ?? undefined,
    email: u.email || u.public_email || undefined,
  };
}

/** 'group/sub/repo' → { owner: 'group/sub', name: 'repo' }. */
export function splitPath(full: string): { owner: string; name: string } {
  const i = full.lastIndexOf('/');
  return { owner: full.slice(0, i), name: full.slice(i + 1) };
}

export function accessLevel(p: GlProject): number {
  return Math.max(
    p.permissions?.project_access?.access_level ?? 0,
    p.permissions?.group_access?.access_level ?? 0,
  );
}

export function glRepo(p: GlProject, integration: IntegrationId): RemoteRepo {
  const { owner, name } = splitPath(p.path_with_namespace);
  const lvl = accessLevel(p);
  const parent = p.forked_from_project
    ? {
        integration,
        ...splitPath(p.forked_from_project.path_with_namespace),
        id: String(p.forked_from_project.id),
      }
    : undefined;
  return {
    ref: { integration, owner, name, id: String(p.id) },
    fullName: p.path_with_namespace,
    description: p.description ?? undefined,
    isPrivate: p.visibility !== 'public',
    isFork: !!p.forked_from_project,
    parent,
    defaultBranch: p.default_branch ?? 'main',
    httpsUrl: p.http_url_to_repo,
    sshUrl: p.ssh_url_to_repo,
    webUrl: p.web_url,
    updatedAt: p.last_activity_at,
    stars: p.star_count,
    viewerPermission: !p.permissions
      ? undefined
      : lvl >= 50
        ? 'admin'
        : lvl >= 40
          ? 'maintain'
          : lvl >= 30
            ? 'write'
            : 'read',
  };
}

export function allowedMergeMethods(p: GlProject | undefined): MergeMethod[] {
  if (!p) return ['merge', 'squash'];
  const base: MergeMethod =
    p.merge_method === 'ff' ? 'fast-forward' : p.merge_method === 'rebase_merge' ? 'semi-linear' : 'merge';
  return p.squash_option === 'never' ? [base] : [base, 'squash'];
}

export function pipelineRollup(status: string | null | undefined): PrRollupStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
    case 'canceled':
      return 'failure';
    case 'skipped':
    case undefined:
    case null:
      return 'none';
    default:
      return 'pending';
  }
}

export function jobStatus(status: string, allowFailure?: boolean): CheckStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return allowFailure ? 'neutral' : 'failure';
    case 'canceled':
    case 'canceling':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'manual':
      return 'action_required';
    case 'running':
      return 'in_progress';
    default:
      return 'queued';
  }
}

const DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:|draft\s-|\[wip\]|wip:)\s*/i;
export const stripDraftPrefix = (t: string): string => t.replace(DRAFT_PREFIX, '');
export const withDraftPrefix = (t: string, draft: boolean): string =>
  draft ? `Draft: ${stripDraftPrefix(t)}` : stripDraftPrefix(t);

export interface MrContext {
  viewer?: ProviderUser;
  baseProject?: GlProject;
  /** undefined → same project; null → deleted fork. */
  sourceProject?: GlProject | null;
  approvals?: GlApprovals;
}

export function glMr(mr: GlMr, base: RepoRef, ctx: MrContext): PullRequest {
  const integration = base.integration;
  const draft = mr.draft ?? mr.work_in_progress ?? DRAFT_PREFIX.test(mr.title);
  const state: PullRequest['state'] =
    mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : draft ? 'draft' : 'open';
  const cross = mr.source_project_id !== mr.target_project_id;
  let headRepo: RepoRef | null = base;
  let repoCloneUrl: string | undefined = ctx.baseProject?.http_url_to_repo;
  if (cross) {
    const sp = ctx.sourceProject;
    if (sp) {
      headRepo = { integration, ...splitPath(sp.path_with_namespace), id: String(sp.id) };
      repoCloneUrl = sp.http_url_to_repo;
    } else {
      headRepo = null;
      repoCloneUrl = undefined;
    }
  }

  // reviewers + approvals
  const ap = ctx.approvals;
  const approvedBy = new Map((ap?.approved_by ?? []).map((a) => [a.user.id, a.user]));
  const reviewers: PullRequest['reviewers'] = (mr.reviewers ?? []).map((u) => ({
    user: glUser(u),
    state: approvedBy.has(u.id) ? 'approved' : 'pending',
  }));
  for (const [id, u] of approvedBy)
    if (!(mr.reviewers ?? []).some((r) => r.id === id))
      reviewers.push({ user: glUser(u), state: 'approved' });

  let reviewDecision: PullRequest['reviewDecision'] = null;
  if (ap) {
    if ((ap.approvals_left ?? 0) > 0) reviewDecision = 'review_required';
    else if (ap.approved || approvedBy.size > 0) reviewDecision = 'approved';
  } else if (mr.detailed_merge_status === 'not_approved') reviewDecision = 'review_required';

  const dms = mr.detailed_merge_status ?? '';
  const mergeable: PullRequest['mergeable'] =
    mr.has_conflicts || dms === 'conflict'
      ? 'conflicting'
      : ['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(dms) ||
          ['checking', 'unchecked', 'cannot_be_merged_recheck'].includes(mr.merge_status ?? '')
        ? 'unknown'
        : 'mergeable';

  let checksRollup: PrRollupStatus;
  if (mr.head_pipeline !== undefined) checksRollup = pipelineRollup(mr.head_pipeline?.status);
  else checksRollup = dms === 'ci_still_running' ? 'pending' : dms === 'ci_must_pass' ? 'failure' : 'none';

  const viewer = ctx.viewer;
  const isAuthor = !!viewer && String(mr.author.id) === viewer.id;
  const lvl = ctx.baseProject ? accessLevel(ctx.baseProject) : 0;
  const isOpen = state === 'open' || state === 'draft';
  const labels = (mr.labels ?? []).map((l) =>
    typeof l === 'string' ? { name: l } : { name: l.name, color: l.color },
  );

  return {
    repo: base,
    number: mr.iid,
    id: String(mr.id),
    title: stripDraftPrefix(mr.title),
    body: mr.description ?? '',
    state,
    author: glUser(mr.author),
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    mergedAt: mr.merged_at ?? undefined,
    closedAt: mr.closed_at ?? undefined,
    head: { repo: headRepo, repoCloneUrl, branch: mr.source_branch, sha: mr.sha },
    base: { repo: base, branch: mr.target_branch, sha: mr.diff_refs?.base_sha },
    reviewers,
    assignees: (mr.assignees ?? []).map(glUser),
    labels,
    milestone: mr.milestone ? { id: String(mr.milestone.id), title: mr.milestone.title } : undefined,
    reviewDecision,
    mergeable,
    checksRollup,
    rollup: computeRollup(checksRollup, reviewDecision, mergeable),
    commentsCount: mr.user_notes_count ?? 0,
    changedFiles: mr.changes_count ? parseInt(mr.changes_count, 10) || undefined : undefined,
    webUrl: mr.web_url,
    isCrossRepository: cross,
    viewer: {
      canMerge: isOpen && (mr.user?.can_merge ?? lvl >= 30),
      canEdit: isAuthor || lvl >= 30,
      canApprove: isOpen && (ap?.user_can_approve ?? !isAuthor),
      isAuthor,
      reviewRequested: !!viewer && (mr.reviewers ?? []).some((r) => String(r.id) === viewer.id),
    },
    allowedMergeMethods: allowedMergeMethods(ctx.baseProject),
  };
}

// ---------------- timeline ----------------

export interface GlNote {
  id: number;
  type?: string | null;
  body: string;
  author: GlUser;
  created_at: string;
  system: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
    head_sha?: string;
  } | null;
}
export interface GlDiscussion {
  id: string;
  individual_note: boolean;
  notes: GlNote[];
}

const SYSTEM_EVENTS: Array<[RegExp, string]> = [
  [/^added .*label/i, 'labeled'],
  [/^removed .*label/i, 'unlabeled'],
  [/^assigned to /i, 'assigned'],
  [/^unassigned /i, 'unassigned'],
  [/^requested review from /i, 'review_requested'],
  [/^removed review request/i, 'review_request_removed'],
  [/^(marked this merge request as \*\*draft\*\*|marked as a \*\*work in progress\*\*)/i, 'convert_to_draft'],
  [
    /^(marked this merge request as \*\*ready\*\*|unmarked as a \*\*work in progress\*\*)/i,
    'ready_for_review',
  ],
  [/^changed title/i, 'renamed'],
  [/^changed target branch/i, 'base_changed'],
  [/^unapproved this merge request/i, 'unapproved'],
  [/^merged\b/i, 'merged'],
  [/^closed\b/i, 'closed'],
  [/^reopened\b/i, 'reopened'],
  [/^deleted the .* branch|^deleted source branch/i, 'head_ref_deleted'],
  [/^mentioned in /i, 'mentioned'],
  [/^changed milestone|^milestone/i, 'milestoned'],
];

/** Encodes thread ids as `{iid}:{discussionId}` so setThreadResolved can find the MR. */
export const threadId = (iid: number, discussionId: string): string => `${iid}:${discussionId}`;

export function glTimeline(
  discussions: GlDiscussion[],
  iid: number,
  currentHeadSha: string | undefined,
  viewerId?: string,
): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const d of discussions) {
    const first = d.notes[0];
    if (!first) continue;
    if (d.individual_note || first.system) {
      for (const n of d.notes) {
        if (!n.system) {
          out.push({
            kind: 'comment',
            id: String(n.id),
            author: glUser(n.author),
            body: n.body,
            createdAt: n.created_at,
            editable: !!viewerId && String(n.author.id) === viewerId,
          });
          continue;
        }
        const body = n.body.trim();
        const added = /^added \d+ (new )?commits?/i.test(body);
        if (added) {
          const shas = [...body.matchAll(/<li>\s*([0-9a-f]{7,40})\s+-/gi)].map((m) => m[1]!);
          out.push({ kind: 'commits', shas, actor: glUser(n.author), createdAt: n.created_at });
          continue;
        }
        if (/^approved this merge request/i.test(body)) {
          out.push({
            kind: 'review',
            id: String(n.id),
            author: glUser(n.author),
            state: 'approved',
            body: '',
            createdAt: n.created_at,
          });
          continue;
        }
        if (/^requested changes/i.test(body)) {
          out.push({
            kind: 'review',
            id: String(n.id),
            author: glUser(n.author),
            state: 'changes_requested',
            body: '',
            createdAt: n.created_at,
          });
          continue;
        }
        const ev = SYSTEM_EVENTS.find(([re]) => re.test(body));
        out.push({
          kind: 'event',
          event: ev?.[1] ?? 'system',
          actor: glUser(n.author),
          createdAt: n.created_at,
          detail: body,
        });
      }
      continue;
    }
    const pos = first.position;
    const resolvableNotes = d.notes.filter((n) => n.resolvable);
    out.push({
      kind: 'thread',
      id: threadId(iid, d.id),
      path: pos?.new_path ?? pos?.old_path ?? '',
      line: pos ? (pos.new_line ?? pos.old_line ?? undefined) : undefined,
      side: pos ? (pos.new_line != null ? 'RIGHT' : 'LEFT') : undefined,
      resolved: resolvableNotes.length > 0 && resolvableNotes.every((n) => n.resolved),
      outdated: !!pos?.head_sha && !!currentHeadSha && pos.head_sha !== currentHeadSha,
      comments: d.notes
        .filter((n) => !n.system)
        .map((n) => ({ id: String(n.id), author: glUser(n.author), body: n.body, createdAt: n.created_at })),
    });
  }
  return out;
}

// ---------------- CI ----------------

export interface GlJob {
  id: number;
  name: string;
  stage?: string;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  web_url?: string;
  allow_failure?: boolean;
}

export function glJob(j: GlJob): CheckRun {
  return {
    id: String(j.id),
    name: j.name,
    group: j.stage,
    status: jobStatus(j.status, j.allow_failure),
    startedAt: j.started_at ?? undefined,
    completedAt: j.finished_at ?? undefined,
    detailsUrl: j.web_url,
    canRerun: ['success', 'failed', 'canceled', 'skipped'].includes(j.status),
    provider: 'gitlab-ci',
  };
}
