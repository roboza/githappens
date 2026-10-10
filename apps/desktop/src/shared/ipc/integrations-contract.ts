import type { RepoId } from '@githappens/git/types';
import type {
  CheckRun,
  ConnectedIntegration,
  CreatePrInput,
  Issue,
  IssueFilter,
  IssueRef,
  ListPage,
  MergeMethod,
  PrFilter,
  PrIndexEntry,
  ProviderKind,
  ProviderUser,
  PullRequest,
  RemoteRepo,
  RepoRef,
  SubmitReviewInput,
  TimelineItem,
  TrackerKind,
  UpdatePrInput,
} from '@githappens/providers/types';

/**
 * Integrations IPC (spec 10 §5.5). Tokens never cross IPC: the renderer only sees
 * `ConnectedIntegration` metadata. Provider failures arrive as IpcResult errors whose
 * `details.providerCode` carries the `ProviderErrorCode` (auth_required, rate_limited, …).
 */

export type IntegrationKind = ProviderKind | TrackerKind;

/** A provider remote of an open repo, resolved to a connected account (or not). */
export interface ResolvedRemote {
  remote: string;
  url: string;
  kind: ProviderKind | null;
  host: string;
  owner?: string;
  name?: string;
  /** Matching connected account, if any. */
  integrationKey?: string;
  ref?: RepoRef;
}

/** Provider web-link targets (spec 10 §11 `WebTarget`). */
export type WebTarget =
  | { kind: 'repo' }
  | { kind: 'commit'; sha: string }
  | { kind: 'branch'; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'file'; path: string; rev: string; line?: number; endLine?: number }
  | { kind: 'pr'; number: number }
  | { kind: 'compare'; base: string; head: string };

/** A CI run (GitHub Actions run / GitLab or Bitbucket pipeline / Azure build), spec 10 §4.8. */
export type CiRun = CheckRun & { runNumber?: number; branch?: string; event?: string; actor?: ProviderUser };

/** A commit of a PR / create-PR preview, read from local git (`git log base..head`). */
export interface PrCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** epoch seconds */
  date: number;
}

/** A user-defined PR filter, saved per profile in `pr-filters.json` (spec 10 §4.5). */
export interface SavedPrFilter {
  id: string;
  name: string;
  filter: PrFilter;
}

export interface IssueComment {
  id: string;
  author: ProviderUser;
  body: string;
  createdAt: string;
}

export interface IssueTransition {
  id: string;
  name: string;
  toCategory: Issue['stateCategory'];
}

/** Azure DevOps organization / Jira Cloud site an account can be scoped to (spec 10 §4.1 OrgSelector). */
export interface IntegrationOrg {
  id: string;
  name: string;
  url?: string;
  selected: boolean;
}

export interface IntegrationsIpcContract {
  // ---- accounts ----
  'auth:list': { req: Record<string, never>; res: ConnectedIntegration[] };
  /** OAuth: system browser + loopback/device flow; progress on `auth:oauthProgress`. */
  'auth:startOAuth': { req: { kind: IntegrationKind; host?: string }; res: { flowId: string } };
  'auth:cancelOAuth': { req: { flowId: string }; res: void };
  'auth:connectPat': {
    req: { kind: IntegrationKind; host: string; token: string; username?: string };
    res: ConnectedIntegration;
  };
  /** Forget the account; with `revoke` the token is first revoked at the provider where supported. */
  'auth:disconnect': { req: { integrationKey: string; revoke: boolean }; res: void };
  /** URL of the provider page to create a PAT with the right scopes. */
  'auth:tokenPageUrl': { req: { kind: IntegrationKind; host: string }; res: string };
  /** Which kinds can use OAuth right now (client ids configured). */
  'auth:oauthAvailability': { req: Record<string, never>; res: Partial<Record<IntegrationKind, boolean>> };
  /** Azure DevOps organizations / Jira Cloud sites the account can access. */
  'auth:organizations': { req: { integrationKey: string }; res: IntegrationOrg[] };
  /** Scope the account to one organization / site. The integration key may change (host is part of it). */
  'auth:selectOrganization': { req: { integrationKey: string; id: string }; res: ConnectedIntegration };

  // ---- repos ----
  'provider:listOwners': {
    req: { integrationKey: string };
    res: Array<{
      login: string;
      avatarUrl?: string;
      kind: 'user' | 'org' | 'group' | 'workspace' | 'project';
    }>;
  };
  'provider:listRepos': {
    req: { integrationKey: string; owner?: string; query?: string; cursor?: string };
    res: ListPage<RemoteRepo>;
  };
  'provider:listForks': { req: { ref: RepoRef; cursor?: string }; res: ListPage<RemoteRepo> };
  'provider:createRepo': {
    req: {
      integrationKey: string;
      owner?: string;
      name: string;
      private: boolean;
      description?: string;
      gitignore?: string;
      license?: string;
    };
    res: RemoteRepo;
  };
  'provider:fork': { req: { ref: RepoRef; owner?: string }; res: RemoteRepo };
  /** All remotes of an open repo with their provider + account match. */
  'provider:resolveRemotes': { req: { repoId: RepoId }; res: ResolvedRemote[] };
  /** Pure web link (no network). `remote` defaults to `origin`, else the first provider remote. */
  'provider:webUrl': { req: { repoId: RepoId; remote?: string; target: WebTarget }; res: string | null };

  // ---- pull requests ----
  /** PRs of every provider remote of the repo, merged and sorted by update time. */
  'pr:list': { req: { repoId: RepoId; filter: PrFilter; background?: boolean }; res: PullRequest[] };
  'pr:get': { req: { ref: RepoRef; number: number }; res: PullRequest };
  'pr:timeline': { req: { ref: RepoRef; number: number; cursor?: string }; res: ListPage<TimelineItem> };
  'pr:checks': { req: { ref: RepoRef; sha: string; background?: boolean }; res: CheckRun[] };
  'pr:create': { req: CreatePrInput; res: PullRequest };
  'pr:update': { req: { ref: RepoRef; number: number; patch: UpdatePrInput }; res: PullRequest };
  /** `inReplyTo`: reply in a review thread (thread / comment id from the timeline). */
  'pr:comment': {
    req: { ref: RepoRef; number: number; body: string; inReplyTo?: string };
    res: TimelineItem;
  };
  'pr:review': { req: { ref: RepoRef; number: number; input: SubmitReviewInput }; res: void };
  'pr:merge': {
    req: {
      ref: RepoRef;
      number: number;
      method: MergeMethod;
      title?: string;
      message?: string;
      deleteBranch?: boolean;
      expectedHeadSha: string;
    };
    res: { merged: boolean; sha?: string; message?: string };
  };
  'pr:close': { req: { ref: RepoRef; number: number }; res: void };
  'pr:reopen': { req: { ref: RepoRef; number: number }; res: void };
  /** Draft ↔ ready for review. */
  'pr:setDraft': { req: { ref: RepoRef; number: number; draft: boolean }; res: void };
  'pr:resolveThread': { req: { ref: RepoRef; threadId: string; resolved: boolean }; res: void };
  /** Enable (method) / disable (null) auto-merge. */
  'pr:setAutoMerge': { req: { ref: RepoRef; number: number; method: MergeMethod | null }; res: void };
  /**
   * Fetch the PR head and check it out (spec 10 §6.3): `branch` (default) creates/updates a local branch,
   * `worktree` adds a worktree for it (`worktreePath` defaults to `../<repo>.worktrees/pr-<n>`).
   */
  'pr:checkout': {
    req: { repoId: RepoId; pr: PullRequest; mode?: 'branch' | 'worktree'; worktreePath?: string };
    res: { branch: string; path?: string };
  };
  /** Fetch PR head + base without touching branches; returns local refs for the Commits / Files tabs. */
  'pr:fetch': { req: { repoId: RepoId; pr: PullRequest }; res: { headRef: string; baseRef: string } };
  /** Commits in `head` not in `base`, newest first (local `git log`; max 250). */
  'pr:commits': { req: { repoId: RepoId; base: string; head: string }; res: PrCommit[] };
  /** Would merging `source` into `target` conflict? (`git merge-tree --write-tree`, spec 10 §6.3). */
  'pr:conflictCheck': {
    req: { repoId: RepoId; source: string; target: string };
    res: { conflicts: boolean; files: string[]; unsupported?: boolean };
  };
  /** PR body templates: local files first, then the provider (spec 10 §6.4). */
  'pr:templates': {
    req: { repoId: RepoId; ref: RepoRef; branch: string };
    res: Array<{ name: string; path: string; body: string }>;
  };
  'pr:searchUsers': { req: { ref: RepoRef; query: string }; res: ProviderUser[] };
  'pr:labels': { req: { ref: RepoRef }; res: Array<{ name: string; color?: string }> };
  'pr:milestones': { req: { ref: RepoRef }; res: Array<{ id: string; title: string }> };
  /**
   * Branch → PR map for graph badges; also pushed as `pr:indexUpdated`. Holds open PRs plus PRs merged or
   * closed in the last 7 days (merged pill / closed badge).
   */
  'pr:index': { req: { repoId: RepoId; background?: boolean }; res: PrIndexEntry[] };
  /** Custom PR filters of the active profile. */
  'pr:filters': { req: Record<string, never>; res: SavedPrFilter[] };
  'pr:saveFilters': { req: { filters: SavedPrFilter[] }; res: SavedPrFilter[] };

  // ---- CI (spec 10 §4.8) ----
  'ci:list': {
    req: { ref: RepoRef; branch?: string; cursor?: string; background?: boolean };
    res: ListPage<CiRun>;
  };
  'ci:rerun': { req: { ref: RepoRef; runId: string; failedOnly?: boolean }; res: void };
  'ci:cancel': { req: { ref: RepoRef; runId: string }; res: void };
  /** Re-run the failed jobs of the latest failed run per workflow on `branch`; returns how many. */
  'ci:rerunFailed': { req: { ref: RepoRef; branch: string }; res: { rerun: number } };

  // ---- issues ----
  'issues:scopes': { req: { integrationKey: string }; res: Array<{ scope: string; label: string }> };
  'issues:list': {
    req: {
      integrationKey: string;
      scope: string;
      filter: IssueFilter;
      cursor?: string;
      background?: boolean;
    };
    res: ListPage<Issue>;
  };
  'issues:get': { req: { integrationKey: string; scope: string; key: string }; res: Issue };
  'issues:create': {
    req: {
      integrationKey: string;
      scope: string;
      input: { title: string; body?: string; type?: string; assignees?: string[]; labels?: string[] };
    };
    res: Issue;
  };
  'issues:update': {
    req: {
      integrationKey: string;
      scope: string;
      key: string;
      patch: Partial<{ title: string; body: string; assignees: string[]; labels: string[] }>;
    };
    res: Issue;
  };
  'issues:transitions': {
    req: { integrationKey: string; scope: string; key: string };
    res: IssueTransition[];
  };
  'issues:transition': {
    req: { integrationKey: string; scope: string; key: string; transitionId: string };
    res: void;
  };
  'issues:comment': { req: { integrationKey: string; scope: string; key: string; body: string }; res: void };
  'issues:comments': { req: { integrationKey: string; scope: string; key: string }; res: IssueComment[] };
  /** Assign the issue to the connected account itself. */
  'issues:assignSelf': { req: { integrationKey: string; scope: string; key: string }; res: Issue };
  /**
   * Create a branch for an issue (spec 10 §4.9) and link it (`issue-links.json`); optionally transition the
   * issue (e.g. to "In Progress") and assign it to the connected account.
   */
  'issues:createBranch': {
    req: {
      repoId: RepoId;
      issue: IssueRef;
      branchName: string;
      base: string;
      checkout: boolean;
      transitionId?: string;
      assignSelf?: boolean;
    };
    res: { branch: string; warnings?: string[] };
  };
  /** Issue linked to a branch: stored link first, else inferred from the name (`ABC-123`, `42-…`). */
  'issues:linkForBranch': { req: { repoId: RepoId; branch: string }; res: IssueRef | null };
  /** Stored + inferred links of every local branch (for ref-label tracker icons). */
  'issues:links': { req: { repoId: RepoId }; res: Record<string, IssueRef> };
  /** Link (or with `issue: null`, unlink) a branch manually. */
  'issues:setLink': { req: { repoId: RepoId; branch: string; issue: IssueRef | null }; res: void };

  // ---- SSH (spec 10 §4 "add SSH key to provider") ----
  'ssh:upload': { req: { integrationKey: string; title: string; publicKey: string }; res: { id: string } };
}

export interface IntegrationsEventContract {
  'auth:changed': { integrations: ConnectedIntegration[] };
  'auth:oauthProgress': {
    flowId: string;
    phase: 'browser-opened' | 'device-code' | 'exchanging' | 'done' | 'error';
    /** Device flow: code to show the user + verification URL. */
    userCode?: string;
    verificationUri?: string;
    error?: string;
  };
  'provider:rateLimit': { integrationKey: string; remaining: number; limit: number; resetAt: number };
  'pr:indexUpdated': { repoId: RepoId; entries: PrIndexEntry[] };
  'auth:reauthRequired': { integrationKey: string; reason: string };
}

export const INTEGRATIONS_INVOKE_CHANNELS = [
  'auth:list',
  'auth:startOAuth',
  'auth:cancelOAuth',
  'auth:connectPat',
  'auth:disconnect',
  'auth:tokenPageUrl',
  'auth:oauthAvailability',
  'auth:organizations',
  'auth:selectOrganization',
  'provider:listOwners',
  'provider:listRepos',
  'provider:listForks',
  'provider:createRepo',
  'provider:fork',
  'provider:resolveRemotes',
  'provider:webUrl',
  'pr:list',
  'pr:get',
  'pr:timeline',
  'pr:checks',
  'pr:create',
  'pr:update',
  'pr:comment',
  'pr:review',
  'pr:merge',
  'pr:close',
  'pr:reopen',
  'pr:setDraft',
  'pr:resolveThread',
  'pr:setAutoMerge',
  'pr:checkout',
  'pr:fetch',
  'pr:commits',
  'pr:conflictCheck',
  'pr:templates',
  'pr:searchUsers',
  'pr:labels',
  'pr:milestones',
  'pr:index',
  'pr:filters',
  'pr:saveFilters',
  'ci:list',
  'ci:rerun',
  'ci:cancel',
  'ci:rerunFailed',
  'issues:scopes',
  'issues:list',
  'issues:get',
  'issues:create',
  'issues:update',
  'issues:transitions',
  'issues:transition',
  'issues:comment',
  'issues:comments',
  'issues:assignSelf',
  'issues:createBranch',
  'issues:linkForBranch',
  'issues:links',
  'issues:setLink',
  'ssh:upload',
] as const satisfies readonly (keyof IntegrationsIpcContract)[];

export const INTEGRATIONS_EVENT_CHANNELS = [
  'auth:changed',
  'auth:oauthProgress',
  'provider:rateLimit',
  'pr:indexUpdated',
  'auth:reauthRequired',
] as const satisfies readonly (keyof IntegrationsEventContract)[];
