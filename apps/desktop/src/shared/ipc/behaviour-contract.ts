import type { CommandLogEntry, GitErrorCode, RepoId } from '@githappens/git/types';

/**
 * Behaviour IPC (Phase 7): git output log (spec 02 §5.3 `git:output:*`), auto-fetch scheduler state
 * (spec 09 §6.2 `sync:autoFetch:state`), OS notifications (spec 01 `notify:desktop`), profile identity
 * status for the commit composer (spec 13 §6) and the logs folder (spec 01 `logs:open`).
 */

export interface AutoFetchState {
  repoId: RepoId;
  /** False when the interval is 0, the repo is bare, or it has no remotes. */
  enabled: boolean;
  /** Epoch ms of the last successful auto- or manual fetch seen by the scheduler. */
  lastFetchAt: number | null;
  /** Epoch ms of the next scheduled attempt (null while paused / disabled). */
  nextFetchAt: number | null;
  lastError?: { code: GitErrorCode; message: string; at: number };
  /** Paused after an authentication / host-key failure until a manual fetch or "Resume". */
  paused: boolean;
  /** Consecutive failures (drives the exponential backoff). */
  failures: number;
  running: boolean;
}

export interface IdentityStatus {
  /** Active profile identity (may be empty). */
  profile: { name: string; email: string };
  /** `git config --local user.*` of the repository. */
  local: { name?: string; email?: string };
  /** What a commit made by the app uses, and where it comes from. */
  effective: { name?: string; email?: string; source: 'repo' | 'profile' | 'git' | 'mixed' };
  /** Repo-local identity differs from the profile (composer notice). */
  overridden: boolean;
  /** Profile name or email is empty (prompt to fix it). */
  profileIncomplete: boolean;
}

export interface BehaviourIpcContract {
  'git:output:list': { req: { repoId: RepoId; limit?: number }; res: CommandLogEntry[] };
  'git:output:clear': { req: { repoId: RepoId }; res: void };
  /** OS notification; shown only when the window is unfocused and `notifications.desktop` is on. */
  'notify:desktop': { req: { title: string; body?: string; force?: boolean }; res: boolean };
  'autofetch:state': { req: { repoId: RepoId }; res: AutoFetchState | null };
  'autofetch:resume': { req: { repoId: RepoId }; res: void };
  /** The repo in the active tab (others fetch at most every 5 minutes). */
  'autofetch:setActive': { req: { repoId: RepoId | null }; res: void };
  'identity:status': { req: { repoId: RepoId }; res: IdentityStatus };
  /** Reveal `userData/logs` (main.log with extended logging). */
  'logs:open': { req: Record<string, never>; res: void };
}

export interface BehaviourEventContract {
  'git:output:append': { repoId: RepoId; entry: CommandLogEntry };
  'sync:autoFetch:state': AutoFetchState;
}

export const BEHAVIOUR_INVOKE_CHANNELS = [
  'git:output:list',
  'git:output:clear',
  'notify:desktop',
  'autofetch:state',
  'autofetch:resume',
  'autofetch:setActive',
  'identity:status',
  'logs:open',
] as const satisfies readonly (keyof BehaviourIpcContract)[];

export const BEHAVIOUR_EVENT_CHANNELS = [
  'git:output:append',
  'sync:autoFetch:state',
] as const satisfies readonly (keyof BehaviourEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof BehaviourIpcContract, (typeof BEHAVIOUR_INVOKE_CHANNELS)[number]> =
  true;
const eventExhaustive: Exhaustive<keyof BehaviourEventContract, (typeof BEHAVIOUR_EVENT_CHANNELS)[number]> =
  true;
void invokeExhaustive;
void eventExhaustive;
