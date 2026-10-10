import type { PatchFile, PatchVisibility, SuggestionStatus } from '@githappens/cloud-api/types';
import type { FileDiff, RepoId, Sha } from '@githappens/git/types';
import type { RepoRef } from '@githappens/providers/types';

export type { SuggestionStatus };

/**
 * Code Suggest IPC (spec 14 §4.3, §6.4). A reviewer edits any file of a PR in an isolated worktree
 * (`<userData>/suggest/<sessionId>`, detached at the PR head — the main checkout is never touched),
 * submits the diff as a Cloud Patch of kind `suggestion` plus a PR comment with the links; the PR author
 * finds suggestions in PR comments (link pattern) and on the server, and applies them per file.
 */

/** The PR coordinates Code Suggest needs (a subset of the provider `PullRequest`). */
export interface SuggestPr {
  ref: RepoRef;
  number: number;
  title: string;
  headSha: Sha;
  headBranch: string;
  baseBranch: string;
  isCrossRepository: boolean;
  /** Fork clone URL (cross-repository PRs). */
  headCloneUrl?: string;
  webUrl?: string;
}

export interface SuggestSession {
  sessionId: string;
  /** The repository the PR belongs to (the worktree's main repo). */
  repoId: RepoId;
  pr: SuggestPr;
  /** Absolute path of the isolated worktree; open it as a repo tab to edit. */
  worktreePath: string;
  createdAt: string;
}

export interface SuggestSubmitReq {
  sessionId: string;
  title: string;
  description?: string;
  /** Default 'link' with end-to-end encryption (PR participants may not use this server). */
  visibility?: PatchVisibility;
  orgId?: string;
  collaborators?: string[];
  /** Add the `code-suggestion` label to the PR (created by the provider if missing). */
  addLabel?: boolean;
  /** Keep the worktree after submitting (default: removed). */
  keepWorktree?: boolean;
}

/** One suggestion as seen from a PR (merged from PR comments and the server list). */
export interface SuggestionInfo {
  /** Server suggestion id when known, else the patch id. */
  key: string;
  id?: string;
  patchId: string;
  title: string;
  /** Suggester: provider login (comments) and/or cloud account name. */
  author: { login?: string; name?: string };
  createdAt?: string;
  status: SuggestionStatus;
  prHeadSha?: Sha;
  /** Web link including `#k=` when the key is known (from the comment link). */
  webUrl: string;
  deepLink: string;
  /** The patch is end-to-end encrypted and no key was found (link without fragment). */
  missingKey: boolean;
  coAuthor?: { name: string; email: string };
  source: 'comment' | 'server' | 'both';
  commentId?: string;
}

export interface OpenedSuggestion {
  suggestion: SuggestionInfo;
  title: string;
  description?: string;
  baseSha: Sha;
  files: PatchFile[];
  diff: FileDiff[];
  /** The PR head moved since the suggestion was made ("Based on older head abc123"). */
  outdated?: { suggestedOn: Sha; currentHead: Sha };
}

export type SuggestApplyTarget =
  | { kind: 'current' }
  | { kind: 'new-branch'; name: string }
  /** Commit on the PR head branch with a `Co-authored-by` trailer and push it (same-repo PRs). */
  | { kind: 'pr-branch'; pr: SuggestPr };

export interface SuggestApplyReq {
  repoId: RepoId;
  patchId: string;
  /** Accepted files (paths as in `OpenedSuggestion.files`); rejected ones are left out. */
  paths: string[];
  target: SuggestApplyTarget;
  /** Server suggestion id: marked `applied` on success. */
  suggestionId?: string;
  title: string;
  coAuthor?: { name: string; email: string };
}

export interface SuggestApplyRes {
  applied: boolean;
  conflicts: string[];
  rejects: string[];
  branch?: string;
  commit?: Sha;
  pushed?: boolean;
  warnings: string[];
}

export interface SuggestIpcContract {
  /** Fetch the PR head if needed and create the isolated worktree. */
  'suggest:start': { req: { repoId: RepoId; pr: SuggestPr }; res: SuggestSession };
  'suggest:sessions': { req: Record<string, never>; res: SuggestSession[] };
  /** Files changed in the session's worktree so far (submit dialog). */
  'suggest:changes': { req: { sessionId: string }; res: { files: PatchFile[]; warnings: string[] } };
  'suggest:submit': {
    req: SuggestSubmitReq;
    res: { suggestion: SuggestionInfo; commentPosted: boolean; warnings: string[] };
  };
  /** Remove the worktree and forget the session. */
  'suggest:discard': { req: { sessionId: string }; res: null };
  /** Suggestions for a PR: comment links (no server needed) merged with the server list. */
  'suggest:list': {
    req: { repoId: RepoId; pr: SuggestPr };
    res: { items: SuggestionInfo[]; serverAvailable: boolean };
  };
  /** Download + decrypt a suggestion's patch. `url` = web/deep link (with `#k=`) or a listed `key`. */
  'suggest:open': {
    req: { url?: string; info?: SuggestionInfo; prHeadSha?: Sha };
    res: OpenedSuggestion;
  };
  'suggest:apply': { req: SuggestApplyReq; res: SuggestApplyRes };
  'suggest:setStatus': { req: { id: string; status: SuggestionStatus }; res: null };
}

export interface SuggestEventContract {
  'suggest:changed': { reason: 'started' | 'submitted' | 'discarded' | 'applied' | 'status' };
}

export const SUGGEST_INVOKE_CHANNELS = [
  'suggest:start',
  'suggest:sessions',
  'suggest:changes',
  'suggest:submit',
  'suggest:discard',
  'suggest:list',
  'suggest:open',
  'suggest:apply',
  'suggest:setStatus',
] as const satisfies readonly (keyof SuggestIpcContract)[];

export const SUGGEST_EVENT_CHANNELS = [
  'suggest:changed',
] as const satisfies readonly (keyof SuggestEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof SuggestIpcContract, (typeof SUGGEST_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof SuggestEventContract, (typeof SUGGEST_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;
