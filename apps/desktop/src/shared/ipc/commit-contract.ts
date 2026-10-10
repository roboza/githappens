import type { CoAuthor } from '@githappens/git/ops';
import type { RepoId } from '@githappens/git/types';

export type { CoAuthor };

/** Per-commit signing choice (spec 06 §4.5): follow `commit.gpgSign`, force `-S`, or `--no-gpg-sign`. */
export type SignChoice = 'config' | 'on' | 'off';

/** Composer draft persisted per repo + branch across restarts (spec 06 §4.5 "Message draft persistence"). */
export interface StoredDraft {
  summary: string;
  description: string;
  coAuthors: CoAuthor[];
  /** ms since epoch; drafts older than 90 days are pruned. */
  updatedAt: number;
}

/** Commit template (spec 06 §6.9): `commit.template` from git config, else `.git/githappens/commit-template.txt`. */
export interface CommitTemplate {
  path?: string;
  text?: string;
  scope?: 'repo' | 'global' | 'githappens';
}

/** Everything the composer needs besides the draft (spec 06 §4.5, §4.6, §6.8). */
export interface CommitContext {
  /** Executable hooks that run on commit (`pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`). */
  hooks: string[];
  /** `commit.gpgSign` resolves to true. */
  signByDefault: boolean;
  /** A signing key / format is configured (shows the Sign toggle). */
  signingConfigured: boolean;
  /** HEAD is reachable from its upstream (amending requires a force push). */
  headPushed: { upstream: string } | null;
  /** Unborn branch: amend / reword are unavailable. */
  unborn: boolean;
}

/** Staged text file whose index content uses CRLF or mixed line endings (spec 06 §4.8). */
export interface EolIssue {
  path: string;
  eol: 'crlf' | 'mixed';
}

/** `git check-ignore -v` result for a path (spec 06 §6.7). */
export interface IgnoreCheck {
  ignored: boolean;
  source?: string;
  line?: number;
  pattern?: string;
}

/**
 * Commit composer IPC (spec 06 §5). Mutations stay `git:op:run` variants (`commit.create`,
 * `commit.rewordHead`, `commit.saveTemplate`, `wip.*`); these are the composer's reads plus the
 * main-side draft store.
 */
export interface CommitIpcContract {
  /** `git shortlog -sne --all` (cached) + provider collaborators when connected; filtered by `q`. */
  'commit:coAuthorSuggestions': { req: { repoId: RepoId; q: string; limit?: number }; res: CoAuthor[] };
  'commit:template': { req: { repoId: RepoId }; res: CommitTemplate };
  'commit:context': { req: { repoId: RepoId }; res: CommitContext };
  'commit:eolCheck': { req: { repoId: RepoId }; res: EolIssue[] };
  'commit:checkIgnore': { req: { repoId: RepoId; path: string }; res: IgnoreCheck };
  'commit:draft:get': { req: { repoId: RepoId; branch: string | null }; res: StoredDraft | null };
  /** `draft: null` clears it (after a successful commit). */
  'commit:draft:set': {
    req: { repoId: RepoId; branch: string | null; draft: StoredDraft | null };
    res: void;
  };
}

export interface CommitEventContract {
  /** Hook stdout/stderr while `commit.create` runs (git sends hook output to stderr). */
  'commit:hookOutput': { repoId: RepoId; opId: string; chunk: string; stream: 'out' | 'err' };
}

export const COMMIT_INVOKE_CHANNELS = [
  'commit:coAuthorSuggestions',
  'commit:template',
  'commit:context',
  'commit:eolCheck',
  'commit:checkIgnore',
  'commit:draft:get',
  'commit:draft:set',
] as const satisfies readonly (keyof CommitIpcContract)[];

export const COMMIT_EVENT_CHANNELS = [
  'commit:hookOutput',
] as const satisfies readonly (keyof CommitEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const commitInvokeExhaustive: Exhaustive<keyof CommitIpcContract, (typeof COMMIT_INVOKE_CHANNELS)[number]> =
  true;
const commitEventExhaustive: Exhaustive<keyof CommitEventContract, (typeof COMMIT_EVENT_CHANNELS)[number]> =
  true;
void commitInvokeExhaustive;
void commitEventExhaustive;

/** `git:progress` phase used by `commit.create` to stream hook output (forwarded as `commit:hookOutput`). */
export const HOOK_OUTPUT_PHASE = 'hook-output';
