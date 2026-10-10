import type { OrgPolicies, TeamView, UserRef } from '@githappens/cloud-api/types';
import type { RepoId } from '@githappens/git/types';

/**
 * Conflict Prevention + Team view IPC (spec 14 §4.4, §5.4, §6.5). The target-branch check is local
 * (`git merge-tree`); teammate overlaps come from opt-in, privacy-shaped footprints on the org's
 * GitHappens Cloud server. File contents never leave the machine.
 */

/** Where the target of a branch came from (spec 14 §6.5 resolution order). */
export type TargetSource = 'config' | 'pr' | 'remote-default' | 'heuristic';

/**
 * - `hidden`: detached HEAD / unborn branch / bare repo — indicator not shown.
 * - `no-target`: no target could be resolved — indicator not shown.
 * - `target-missing`: the target ref does not exist locally ("Target not available — fetch").
 * - `disabled`: `conflicts.detectTarget` is off (teammate overlaps may still be present).
 * - `ignored`: "Stop detecting for this target".
 * - `unsupported`: git < 2.38 (no `merge-tree --write-tree`).
 */
export type ConflictCheckState =
  | 'ok'
  | 'conflicts'
  | 'hidden'
  | 'no-target'
  | 'target-missing'
  | 'disabled'
  | 'ignored'
  | 'unsupported'
  | 'error';

/** Line ranges are 1-based inclusive `[start, end]`; `ours` = this branch, `theirs` = the target. */
export interface ConflictHunk {
  ours: [number, number];
  theirs: [number, number];
}

export interface TeammateOverlap {
  user: { id: string; name: string; avatarUrl?: string };
  /** Plaintext branch label only when the org policy shares branch names. */
  branchLabel?: string;
  branchHash: string;
  /** Resolved locally by hashing this user's own paths (never needs the server to know it). */
  path: string;
  pathHash: string;
  myRanges: [number, number][];
  theirRanges: [number, number][];
  updatedAt: string;
}

/** spec 14 §5.4 ConflictReport plus the check state the indicator needs. */
export interface ConflictReport {
  repoId: RepoId;
  /** Current branch ('' when hidden). */
  branch: string;
  /** Target ref, e.g. `origin/main` ('' when none). */
  target: string;
  checkedAt: string;
  targetConflicts: Array<{ path: string; hunks?: ConflictHunk[] }>;
  teammateOverlaps: TeammateOverlap[];
  state: ConflictCheckState;
  targetSource?: TargetSource;
  headSha?: string;
  targetSha?: string;
  /** The check included uncommitted changes (`conflicts.includeWip`). */
  wip: boolean;
  /** Conflicted files / overlaps hidden by ignore rules. */
  ignoredCount: number;
  error?: string;
}

export type ConflictIgnoreScope = 'file' | 'branch' | 'target';

/**
 * `file`: a repo path (target conflicts and teammate overlaps); `branch`: a teammate branchHash;
 * `target`: a target ref ("Stop detecting for this target"). `until` (ISO) makes the rule temporary.
 */
export interface ConflictIgnoreRule {
  scope: ConflictIgnoreScope;
  value: string;
  until?: string;
}

export interface TeamStatus {
  /** `cloud.serverUrl` is set. */
  configured: boolean;
  signedIn: boolean;
  orgId: string | null;
  orgName?: string;
  /** `team.footprints` setting. */
  footprintsEnabled: boolean;
  /** Effective: configured && signed in && org && footprints on. */
  active: boolean;
  policies?: Pick<OrgPolicies, 'footprintSharePaths' | 'footprintShareBranchNames'>;
  lastUploadAt?: string;
  lastPollAt?: string;
  error?: string;
}

export interface TeamViewResult {
  status: TeamStatus;
  /** Filtered to the repo when `repoId` was given (matched by repo identity). */
  repos: TeamView['repos'];
  /** Caller, so the UI can label "you". */
  me?: UserRef;
}

export interface ConflictsIpcContract {
  /** Current report; runs the check when the cache is stale (or always with `force`). */
  'conflicts:check': { req: { repoId: RepoId; force?: boolean }; res: ConflictReport };
  /** On-demand hunk ranges for one conflicted file of the last check (parsed from merge-tree markers). */
  'conflicts:hunks': { req: { repoId: RepoId; path: string }; res: ConflictHunk[] };
  /** Add (or `remove`) an ignore rule; returns the repo's active rules and re-emits the report. */
  'conflicts:ignore': {
    req: { repoId: RepoId; scope: ConflictIgnoreScope; value: string; until?: string; remove?: boolean };
    res: ConflictIgnoreRule[];
  };
  'conflicts:ignores': { req: { repoId: RepoId }; res: ConflictIgnoreRule[] };
  /**
   * "Change target…": persists `branch.<name>.githappens-target` (null clears it, back to automatic)
   * and re-checks. `branch` defaults to the current branch.
   */
  'conflicts:setTarget': {
    req: { repoId: RepoId; branch?: string; target: string | null };
    res: ConflictReport;
  };
  'team:status': { req: Record<string, never>; res: TeamStatus };
  /** Team view (`GET /v1/orgs/:org/team`); no network call unless footprints are active. */
  'team:view': { req: { repoId?: RepoId }; res: TeamViewResult };
}

export interface ConflictsEventContract {
  'conflicts:updated': { repoId: RepoId; report: ConflictReport };
}

export const CONFLICTS_INVOKE_CHANNELS = [
  'conflicts:check',
  'conflicts:hunks',
  'conflicts:ignore',
  'conflicts:ignores',
  'conflicts:setTarget',
  'team:status',
  'team:view',
] as const satisfies readonly (keyof ConflictsIpcContract)[];

export const CONFLICTS_EVENT_CHANNELS = [
  'conflicts:updated',
] as const satisfies readonly (keyof ConflictsEventContract)[];
