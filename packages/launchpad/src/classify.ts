import { integrationKey, type PullRequest } from '@githappens/providers/types';

import { repoKey, samePath } from './ids';
import { isSnoozeActive } from './snooze';
import type {
  ClassifiedItem,
  ClassifyContext,
  LaunchpadFlags,
  LaunchpadGroup,
  LaunchpadIssue,
  LaunchpadItem,
  LaunchpadPr,
} from './types';

/**
 * Deterministic grouping rules (spec 11 §5.3). Bump when a rule changes so cached snapshots and
 * table tests can be revisited.
 *
 * v1 approximations:
 *  - "hasn't reviewed since last head push" = the viewer's reviewer entry is missing or `pending`
 *    (providers reset a re-requested review to pending).
 *  - follow-up = author and someone else left a non-decision review (`commented`) or the PR was
 *    updated after `viewerLastActivityAt`; or the viewer requested changes on someone else's PR.
 */
export const CLASSIFIER_VERSION = 1;

/** Display order of groups (§5.3). Issues/WIPs slot in after PR groups; snoozed is a tab of its own. */
export const GROUP_ORDER: LaunchpadGroup[] = [
  'pinned',
  'current-branch',
  'needs-review',
  'blocked',
  'ready-to-merge',
  'follow-up',
  'waiting-for-review',
  'draft',
  'in-progress',
  'todo',
  'wip',
  'other',
  'snoozed',
];

export const GROUP_LABEL: Record<LaunchpadGroup, string> = {
  pinned: 'Pinned',
  'current-branch': 'Current branch',
  'needs-review': 'Needs your review',
  'ready-to-merge': 'Ready to merge',
  blocked: 'Blocked',
  'follow-up': 'Requires follow-up',
  'waiting-for-review': 'Waiting for review',
  draft: 'Draft',
  'in-progress': 'In progress',
  todo: 'To do',
  wip: 'Uncommitted changes',
  other: 'Other',
  snoozed: 'Snoozed',
};

export const groupPriority = (g: LaunchpadGroup): number => {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

const lc = (s: string | undefined): string => (s ?? '').toLowerCase();

function viewerIdentity(pr: PullRequest, ctx: ClassifyContext): { id?: string; login?: string } {
  const v = ctx.viewers?.[integrationKey(pr.repo.integration)];
  return { id: v?.id ?? pr.repo.integration.accountId, login: v?.login };
}

const isViewer = (u: { id: string; login: string }, v: { id?: string; login?: string }): boolean =>
  (!!v.id && u.id === v.id) || (!!v.login && lc(u.login) === lc(v.login));

/** Whether the PR's head branch is checked out in an open repo of the same repository. */
function onCurrentBranch(item: LaunchpadPr, ctx: ClassifyContext): boolean {
  const pr = item.pr;
  const key = repoKey(integrationKey(pr.repo.integration), pr.repo.owner, pr.repo.name);
  const headKey = pr.head.repo
    ? repoKey(integrationKey(pr.head.repo.integration), pr.head.repo.owner, pr.head.repo.name)
    : undefined;
  return (ctx.currentBranches ?? []).some(
    (b) =>
      b.branch === pr.head.branch &&
      (samePath(b.localPath, item.repo?.localPath) || !!b.repoKeys?.some((k) => k === key || k === headKey)),
  );
}

/** Issue keys linked to a branch name: last path segment is `{key}` or starts with `{key}-`. */
function branchMatchesIssue(branch: string, key: string): boolean {
  const k = lc(key.replace(/^#/, '').replace(/[^A-Za-z0-9-]+/g, '-'));
  if (!k) return false;
  const seg = lc(branch.split('/').pop());
  return seg === k || seg.startsWith(`${k}-`);
}

function issueOnCurrentBranch(item: LaunchpadIssue, ctx: ClassifyContext): boolean {
  const issue = item.issue;
  const numeric = /^#?\d+$/.test(issue.key);
  const key = repoKey(integrationKey(issue.tracker.integration), ...splitScope(issue.tracker.scope));
  return (ctx.currentBranches ?? []).some(
    (b) =>
      branchMatchesIssue(b.branch, issue.key) &&
      // `#12` is only unique within a repo; Jira-style keys are global.
      (!numeric || samePath(b.localPath, item.repo?.localPath) || !!b.repoKeys?.includes(key)),
  );
}

function splitScope(scope: string): [string, string] {
  const i = scope.lastIndexOf('/');
  return i < 0 ? [scope, ''] : [scope.slice(0, i), scope.slice(i + 1)];
}

/** Sub-status flags for a PR (independent of the group). */
export function prFlags(pr: PullRequest): LaunchpadFlags {
  const people = pr.reviewers.filter((r) => !r.user.isTeam || r.state === 'pending');
  const flags: LaunchpadFlags = {};
  if (people.length === 0) flags.noReviewers = true;
  if (pr.mergeable === 'conflicting') flags.conflicts = true;
  if (pr.checksRollup === 'failure') flags.failingChecks = true;
  if (pr.reviewDecision === 'changes_requested') flags.changesRequested = true;
  if (pr.reviewDecision === 'approved') flags.approved = true;
  if (pr.state === 'draft') flags.draft = true;
  return flags;
}

/** Status group of a PR, ignoring pin/snooze (rules 1–8). */
export function classifyPrStatus(item: LaunchpadPr, ctx: ClassifyContext): LaunchpadGroup {
  const pr = item.pr;
  const v = viewerIdentity(pr, ctx);
  const isAuthor =
    pr.viewer.isAuthor || item.involvement.includes('author') || isViewer(pr.author, { id: v.id });
  const open = pr.state === 'open';
  const active = open || pr.state === 'draft';
  const viewerReview = pr.reviewers.find((r) => !r.user.isTeam && isViewer(r.user, v));

  // 1. current branch
  if (active && onCurrentBranch(item, ctx)) return 'current-branch';
  if (!active) return 'other';

  // 2. blocked
  if (
    isAuthor &&
    (pr.mergeable === 'conflicting' ||
      pr.checksRollup === 'failure' ||
      pr.reviewDecision === 'changes_requested')
  )
    return 'blocked';

  // 3. ready to merge (null decision = no required reviews, §8)
  if (
    (isAuthor || pr.viewer.canMerge) &&
    open &&
    (pr.checksRollup === 'success' || pr.checksRollup === 'none') &&
    (pr.reviewDecision === 'approved' || pr.reviewDecision == null) &&
    pr.mergeable === 'mergeable'
  )
    return 'ready-to-merge';

  // 4. needs review (drafts only when explicitly requested, §8)
  const requested = pr.viewer.reviewRequested || item.involvement.includes('review-requested');
  const pendingOnViewer = viewerReview?.state === 'pending';
  if (!isAuthor && (requested || pendingOnViewer) && (!viewerReview || pendingOnViewer)) {
    if (open || requested) return 'needs-review';
  }

  // 5. follow-up
  if (isAuthor) {
    const othersCommented = pr.reviewers.some((r) => r.state === 'commented' && !isViewer(r.user, v));
    const updatedSinceMe =
      !!item.viewerLastActivityAt &&
      Date.parse(pr.updatedAt) > Date.parse(item.viewerLastActivityAt) &&
      pr.commentsCount > 0;
    if (open && (othersCommented || updatedSinceMe)) return 'follow-up';
  } else if (open && viewerReview?.state === 'changes_requested') {
    return 'follow-up';
  }

  // 6. waiting for review
  if (isAuthor && open) {
    const approvals = pr.reviewers.some((r) => r.state === 'approved') || pr.reviewDecision === 'approved';
    if (!approvals) return 'waiting-for-review';
  }

  // 7. draft
  if (isAuthor && pr.state === 'draft') return 'draft';

  // 8. other
  return 'other';
}

/** Status group of an issue (spec 11 §5.3 issues). */
export function classifyIssueStatus(item: LaunchpadIssue, ctx: ClassifyContext): LaunchpadGroup {
  const issue = item.issue;
  if (issue.stateCategory === 'done') return 'other';
  if (issueOnCurrentBranch(item, ctx)) return 'current-branch';
  const v = ctx.viewers?.[integrationKey(issue.tracker.integration)] ?? {
    id: issue.tracker.integration.accountId,
  };
  const mine = item.involvement.includes('assignee') || issue.assignees.some((a) => isViewer(a, v));
  if (!mine) return 'other';
  return issue.stateCategory === 'in_progress' ? 'in-progress' : 'todo';
}

/** Apply user state + rules to one item. */
export function classify(item: LaunchpadItem, ctx: ClassifyContext): ClassifiedItem {
  const st = ctx.itemStates?.[item.uid];
  let statusGroup: LaunchpadGroup;
  let flags: LaunchpadFlags = {};
  if (item.type === 'pr') {
    statusGroup = classifyPrStatus(item, ctx);
    flags = prFlags(item.pr);
  } else if (item.type === 'issue') statusGroup = classifyIssueStatus(item, ctx);
  else statusGroup = 'wip';

  const snoozed = isSnoozeActive(st?.snooze, item.updatedAt, ctx.now) ? st!.snooze : undefined;
  // Rule 0 (pinned) is evaluated before 0' (snoozed); the service clears one when setting the other.
  const group: LaunchpadGroup = st?.pinnedAt ? 'pinned' : snoozed ? 'snoozed' : statusGroup;
  const out = { ...item, group, statusGroup, flags } as ClassifiedItem;
  if (st?.pinnedAt) out.pinnedAt = st.pinnedAt;
  if (snoozed) out.snoozed = snoozed;
  return out;
}

export const classifyAll = (items: readonly LaunchpadItem[], ctx: ClassifyContext): ClassifiedItem[] =>
  items.map((i) => classify(i, ctx));
