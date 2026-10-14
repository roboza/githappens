import type { PullStrategy } from '@githappens/git/ops';

/**
 * Workspaces IPC (spec 11 §5.1, §5.4): named groups of repositories with a cross-repo overview,
 * bulk fetch/pull/clone and directory-synced / provider-defined kinds. Cloud sharing is spec 14.
 */

/** `cloud` without a `cloud` block is a provider-defined workspace (repos picked from an integration). */
export type WorkspaceKind = 'local' | 'directory' | 'cloud';

export interface WorkspaceRepoProvider {
  integrationKey: string;
  owner: string;
  name: string;
  cloneUrlHttps: string;
  cloneUrlSsh: string;
  webUrl: string;
}

export interface WorkspaceRepo {
  /** Stable uuid within the workspace. */
  id: string;
  name: string;
  /** Absolute; undefined => not cloned / not located. */
  localPath?: string;
  provider?: WorkspaceRepoProvider;
  /** `origin` URL recorded when the repo was added; lets a missing local repo be re-cloned. */
  remoteUrl?: string;
  addedAt: string;
}

export interface WorkspaceDirectorySync {
  root: string;
  depth: number;
  includeNested: boolean;
  ignore: string[];
}

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  name: string;
  description?: string;
  color?: string;
  /** Emoji or built-in glyph id. */
  icon?: string;
  order: number;
  hidden: boolean;
  repos: WorkspaceRepo[];
  /** kind = 'directory'. */
  directory?: WorkspaceDirectorySync;
  cloud?: {
    remoteId: string;
    orgId?: string;
    sharedWith?: Array<{ type: 'user' | 'team'; id: string; name: string }>;
    version: number;
    syncedAt?: string;
  };
  /** Where missing repos are cloned. */
  defaultCloneRoot?: string;
  /**
   * Repos hidden from the overview, by local path (stable across directory re-scans) or, for repos
   * without one, by repo id. See `isRepoHidden`.
   */
  hiddenRepos?: string[];
  createdAt: string;
  updatedAt: string;
}

/** `profiles/<id>/workspaces.json`. */
export interface WorkspaceFile {
  version: 1;
  workspaces: Workspace[];
}

export type OperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface RepoStatusSummary {
  workspaceRepoId: string;
  localPath?: string;
  exists: boolean;
  isRepo: boolean;
  head?: { branch?: string; detached: boolean; sha: string };
  upstream?: string;
  ahead: number;
  behind: number;
  wip: { staged: number; unstaged: number; untracked: number; conflicted: number };
  stashCount: number;
  /** ISO time; mtime of `.git/FETCH_HEAD`. */
  lastFetchAt?: string;
  operationInProgress?: OperationInProgress;
  /** Filled by the Launchpad layer when available. */
  openPrs?: { mine: number; total: number; needsMyReview: number };
  /** "Status timed out", "Not a git repository", … */
  error?: string;
}

/** The key a repo is hidden under (`Workspace.hiddenRepos`). */
export const hiddenRepoKey = (r: Pick<WorkspaceRepo, 'id' | 'localPath'>): string => r.localPath ?? r.id;

export const isRepoHidden = (ws: Pick<Workspace, 'hiddenRepos'>, r: WorkspaceRepo): boolean =>
  !!ws.hiddenRepos?.includes(hiddenRepoKey(r));

export type BulkOp = 'fetch' | 'pull' | 'push' | 'clone';

export interface BulkOpRequest {
  workspaceId: string;
  repoIds: string[];
  op: BulkOp;
  options?: {
    pullMode?: PullStrategy;
    /** Rebase/merge pulls only: stash local changes around the pull. */
    autostash?: boolean;
    /** Push only: publish branches without an upstream to `origin` and track them. */
    setUpstream?: boolean;
    cloneRoot?: string;
    protocol?: 'https' | 'ssh';
    /** 1–16; defaults to the `workspaces.bulkConcurrency` setting. */
    concurrency?: number;
  };
}

export type BulkRepoState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface BulkOpProgress {
  bulkId: string;
  workspaceId: string;
  op: BulkOp;
  repoId: string;
  state: BulkRepoState;
  message?: string;
  /** 0..1 for clones. */
  progress?: number;
}

/** A repo found by a directory scan / .code-workspace import. */
export interface ScannedRepo {
  path: string;
  name: string;
  remotes: Array<{ name: string; url: string }>;
}

/** Input for a repo being added: a local path, a provider repo, or both. */
export interface NewWorkspaceRepo {
  name?: string;
  localPath?: string;
  provider?: WorkspaceRepoProvider;
  remoteUrl?: string;
}

export interface CreateWorkspaceInput {
  kind: WorkspaceKind;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  repos?: NewWorkspaceRepo[];
  directory?: WorkspaceDirectorySync;
  defaultCloneRoot?: string;
}

export type WorkspacePatch = Partial<
  Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'hidden' | 'defaultCloneRoot' | 'directory'>
>;

export interface BranchTrack {
  upstream?: string;
  ahead: number;
  behind: number;
  /** Upstream configured but deleted on the remote. */
  gone: boolean;
}

/** Branches tab (spec 11 §4.1): branch names present in ≥ 2 repos × repos. */
export interface BranchMatrix {
  repos: Array<{ repoId: string; name: string }>;
  rows: Array<{ branch: string; cells: Record<string, BranchTrack | null> }>;
}

/** Expanded overview row: local branches + the last commits on HEAD. */
export interface WorkspaceRepoDetails {
  branches: Array<BranchTrack & { name: string; current: boolean }>;
  commits: Array<{ sha: string; subject: string; author: string; date: number }>;
}

export interface WorkspacesIpcContract {
  'workspace:list': { req: Record<string, never>; res: Workspace[] };
  /** Directory kind: the initial scan runs before this resolves. */
  'workspace:create': { req: CreateWorkspaceInput; res: Workspace };
  'workspace:update': { req: { id: string; patch: WorkspacePatch }; res: Workspace };
  'workspace:delete': { req: { id: string }; res: void };
  /** Full ordering of workspace ids (ids not listed keep their relative order at the end). */
  'workspace:reorder': { req: { ids: string[] }; res: Workspace[] };
  /** Duplicate paths / provider repos are ignored. Local paths are validated as git repos. */
  'workspace:addRepos': { req: { workspaceId: string; repos: NewWorkspaceRepo[] }; res: Workspace };
  'workspace:removeRepos': { req: { workspaceId: string; repoIds: string[] }; res: Workspace };
  /** Hide repos from (or show them again in) the overview; hidden repos skip status and "Open all". */
  'workspace:setReposHidden': {
    req: { workspaceId: string; repoIds: string[]; hidden: boolean };
    res: Workspace;
  };
  'workspace:scanDirectory': {
    req: { root: string; depth?: number; ignore?: string[]; includeNested?: boolean };
    res: { repos: ScannedRepo[]; truncated: boolean };
  };
  /** Without `filePath` main shows an open dialog; `null` when cancelled. */
  'workspace:importCodeWorkspace': {
    req: { filePath?: string };
    res: { workspace: Workspace; skipped: Array<{ folder: string; reason: string }> } | null;
  };
  /** Without `filePath` main shows a save dialog; `null` when cancelled. */
  'workspace:exportJson': { req: { workspaceId: string; filePath?: string }; res: { path: string } | null };
  /** Accepts a `WorkspaceFile` or a single workspace; imported with fresh ids. */
  'workspace:importJson': { req: { filePath?: string }; res: Workspace[] | null };
  /** Cached for a few seconds (shared by realpath across workspaces) unless `force`. */
  'workspace:status': { req: { workspaceId: string; force?: boolean }; res: RepoStatusSummary[] };
  /** Not saved when the repo's remote doesn't match and `force` is not set. */
  'workspace:locate': {
    req: { workspaceId: string; repoId: string; path: string; force?: boolean };
    res: { repo?: WorkspaceRepo; mismatch?: { expected: string; actual: string[] } };
  };
  'workspace:bulk': { req: BulkOpRequest; res: { bulkId: string } };
  'workspace:bulkCancel': { req: { bulkId: string }; res: void };
  /** Paths of the (existing) local repos to open as tabs; the renderer opens them. */
  'workspace:openAll': {
    req: { workspaceId: string; repoIds?: string[] };
    res: { paths: string[]; missing: string[] };
  };
  'workspace:branches': { req: { workspaceId: string }; res: BranchMatrix };
  'workspace:repoDetails': { req: { workspaceId: string; repoId: string }; res: WorkspaceRepoDetails };
}

export interface WorkspacesEventContract {
  /** `sync` is set when a directory-synced workspace picked up added/removed repos. */
  'workspace:changed': {
    workspaces: Workspace[];
    sync?: { workspaceId: string; added: string[]; removed: string[] };
  };
  'workspace:statusUpdated': { workspaceId: string; summaries: RepoStatusSummary[] };
  'workspace:bulkProgress': BulkOpProgress;
}

export const WORKSPACES_INVOKE_CHANNELS = [
  'workspace:list',
  'workspace:create',
  'workspace:update',
  'workspace:delete',
  'workspace:reorder',
  'workspace:addRepos',
  'workspace:removeRepos',
  'workspace:setReposHidden',
  'workspace:scanDirectory',
  'workspace:importCodeWorkspace',
  'workspace:exportJson',
  'workspace:importJson',
  'workspace:status',
  'workspace:locate',
  'workspace:bulk',
  'workspace:bulkCancel',
  'workspace:openAll',
  'workspace:branches',
  'workspace:repoDetails',
] as const satisfies readonly (keyof WorkspacesIpcContract)[];

export const WORKSPACES_EVENT_CHANNELS = [
  'workspace:changed',
  'workspace:statusUpdated',
  'workspace:bulkProgress',
] as const satisfies readonly (keyof WorkspacesEventContract)[];
