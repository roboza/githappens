import type {
  Involvement,
  Issue,
  ProviderKind,
  PullRequest,
  SerializedProviderError,
  TrackerKind,
} from '@githappens/providers/types';

/**
 * Launchpad model (spec 11 §5.2). Pure types — shared by the main-process LaunchpadService and
 * the renderer. No Node/Electron imports.
 */

export type LaunchpadItemType = 'pr' | 'issue' | 'wip';

/**
 * Display groups. PR groups follow §5.3; `in-progress` / `todo` are the issue groups and `wip` holds
 * uncommitted work (not status-grouped, sorted by last modification).
 */
export type LaunchpadGroup =
  | 'pinned'
  | 'current-branch'
  | 'needs-review'
  | 'ready-to-merge'
  | 'blocked'
  | 'follow-up'
  | 'waiting-for-review'
  | 'draft'
  | 'in-progress'
  | 'todo'
  | 'wip'
  | 'other'
  | 'snoozed';

export type { Involvement };

export interface LaunchpadRepo {
  workspaceRepoId?: string;
  localPath?: string;
  /** "owner/name" (Azure: "org/project/name"; Jira: project key). */
  fullName: string;
  provider?: ProviderKind | TrackerKind;
}

export interface LaunchpadItemBase {
  /** `${type}:${integrationKey}:${scope}:${key}` or `wip:${repoPath}` */
  uid: string;
  type: LaunchpadItemType;
  title: string;
  updatedAt: string;
  webUrl?: string;
  /** Connected account the item came from (absent for WIPs). */
  integrationKey?: string;
  repo?: LaunchpadRepo;
  involvement: Involvement[];
}

export interface LaunchpadPr extends LaunchpadItemBase {
  type: 'pr';
  pr: PullRequest;
  /** Optional: when the viewer last commented/pushed (improves the follow-up rule). */
  viewerLastActivityAt?: string;
}
export interface LaunchpadIssue extends LaunchpadItemBase {
  type: 'issue';
  issue: Issue;
}

/** Uncommitted work in a local repository (from the workspace status service). */
export interface WipStatus {
  path: string;
  name: string;
  branch?: string;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** ISO time of the most recent change (best effort). */
  lastModified?: string;
}
export interface LaunchpadWip extends LaunchpadItemBase {
  type: 'wip';
  status: WipStatus;
}
export type LaunchpadItem = LaunchpadPr | LaunchpadIssue | LaunchpadWip;

/** Sub-status markers shown as glyphs and counted in the status bar. */
export interface LaunchpadFlags {
  noReviewers?: boolean;
  conflicts?: boolean;
  failingChecks?: boolean;
  changesRequested?: boolean;
  approved?: boolean;
  draft?: boolean;
}

/** An item after user state + classification (what the UI renders). */
export type ClassifiedItem = LaunchpadItem & {
  /** Display group (pinned/snoozed take precedence). */
  group: LaunchpadGroup;
  /** Status group ignoring pin/snooze (used for glyphs, summary and status-bar click-through). */
  statusGroup: LaunchpadGroup;
  flags: LaunchpadFlags;
  pinnedAt?: string;
  snoozed?: ItemUserState['snooze'];
};

export interface LaunchpadGrouped {
  group: LaunchpadGroup | string;
  label: string;
  items: ClassifiedItem[];
  priority: number;
}

export interface SnoozeState {
  until?: string;
  /** Snoozed until the item's `updatedAt` moves past this value. */
  untilUpdatedAfter?: string;
  indefinite?: boolean;
  snoozedAt: string;
}

export interface ItemUserState {
  uid: string;
  pinnedAt?: string;
  snooze?: SnoozeState;
  /** Last refresh the item was returned by a source (garbage collection after 30 days). */
  lastSeenAt?: string;
}

export type LaunchpadScope = { kind: 'all' } | { kind: 'workspace'; workspaceId: string };

export interface LaunchpadFilters {
  scope: LaunchpadScope;
  mode: 'personal' | 'team';
  providers?: string[];
  repos?: string[];
  labels?: string[];
  authors?: string[];
  milestones?: string[];
  sprints?: string[];
  fixVersions?: string[];
  updatedWithin?: '24h' | '7d' | '30d' | 'any';
  text?: string;
}

export type LaunchpadTab = 'prs' | 'issues' | 'wips' | 'all' | 'snoozed';
export type LaunchpadGroupBy = 'status' | 'repo' | 'provider' | 'none';

export interface SavedView {
  id: string;
  name: string;
  tab: 'prs' | 'issues' | 'wips' | 'all';
  filters: LaunchpadFilters;
  groupBy: LaunchpadGroupBy;
}

export interface LaunchpadStateFile {
  version: 1;
  itemStates: Record<string, ItemUserState>;
  savedViews: SavedView[];
  lastFilters: LaunchpadFilters;
}

export interface LaunchpadSummary {
  needsReview: number;
  readyToMerge: number;
  blocked: number;
  noReviewers: number;
  conflicts: number;
  /** Some sources failed; counts are computed from available data. */
  partial?: boolean;
}

export interface LaunchpadSourceError {
  /** Integration key (or 'wip'). */
  source: string;
  /** Human label, e.g. "GitLab (gitlab.com)". */
  label: string;
  error: SerializedProviderError;
}

/** Context the classifier needs besides the item itself. */
export interface ClassifyContext {
  now: number;
  itemStates?: Record<string, ItemUserState>;
  /** Checked-out branches of open repo tabs (for `current-branch`). */
  currentBranches?: Array<{ branch: string; localPath?: string; repoKeys?: string[] }>;
  /** Viewer identity per integration key (matches reviewers when `pr.viewer` flags are absent). */
  viewers?: Record<string, { id?: string; login?: string }>;
}

export const DEFAULT_FILTERS: LaunchpadFilters = { scope: { kind: 'all' }, mode: 'personal' };
