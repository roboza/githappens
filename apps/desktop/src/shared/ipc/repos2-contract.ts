import type { RepoId } from '@githappens/git/types';
import type { RemoteRepo } from '@githappens/providers/types';

import type { OpenRepoResult, RepoRecord } from './shell-contract';

/**
 * Repository management completion (spec 03 §5): registry groups / reorder / columns, validate + dubious
 * ownership consent, repo details, extended clone (shallow / sparse / blobless / LFS) and init (templates,
 * license, bare, remote), templates, provider repo creation, sparse-checkout state and the CLI shim.
 * Merged into the main `IpcContract` (see `REPOS2_INVOKE_CHANNELS`).
 */

// ---- registry ---------------------------------------------------------------------------------------

export type RepoGroupKind = 'open' | 'favorites' | 'recent' | 'custom';

export interface RepoGroup {
  /** `open` / `favorites` / `recent` for the built-ins, `custom:<uuid>` for user groups. */
  id: string;
  kind: RepoGroupKind;
  name: string;
  /** One of the 8 palette tokens (`--kl-graph-lane-N` colours), or undefined for the default. */
  color?: string;
  collapsed: boolean;
  order: number;
}

export interface RepoColumnWidths {
  name: number;
  remote: number;
  branch: number;
}

export interface RepoRegistryState {
  repos: RepoRecord[];
  groups: RepoGroup[];
  columnWidths: RepoColumnWidths;
}

export const DEFAULT_COLUMN_WIDTHS: RepoColumnWidths = { name: 320, remote: 240, branch: 160 };

// ---- validate / safe.directory ----------------------------------------------------------------------

export interface SafeDirectoryInfo {
  /** The value git asked to trust (from its own hint when available). */
  path: string;
  /** Exactly what will run, for display: `git config --global --add safe.directory <path>`. */
  command: string;
}

export type ValidateRepoResult = OpenRepoResult & {
  /** For `reason: 'unsafeDirectory'`: what consenting would run. */
  safeDirectory?: SafeDirectoryInfo;
};

export interface CloneTargetInfo {
  path: string;
  exists: boolean;
  /** Exists and has no entries (clone allowed). */
  empty: boolean;
  /** Toplevel of an enclosing repository (nested clone warning, spec 03 §8). */
  insideRepo?: string;
}

// ---- details ----------------------------------------------------------------------------------------

export interface RepoDetails {
  path: string;
  isBare: boolean;
  branch?: string;
  remotes: { name: string; url: string }[];
  lastCommit?: { sha: string; subject: string; author: string; date: number };
  /** `git count-objects -v` size-pack + size (bytes). */
  sizeBytes?: number;
  readme?: { name: string; markdown: string; truncated: boolean };
}

// ---- clone / init -----------------------------------------------------------------------------------

export interface CloneRequest2 {
  opId: string;
  url: string;
  parentDir: string;
  folderName: string;
  shallow?: {
    depth?: number;
    /** `--shallow-since` date, e.g. `2024-01-31`. */
    sinceDate?: string;
    branch?: string;
    singleBranch?: boolean;
    /** Allowlisted extra flags (`--no-tags --jobs=4` …). */
    customFlags?: string;
  };
  sparse?: { paths: string[]; blobless: boolean };
  /** Blobless partial clone without sparse. */
  blobless?: boolean;
  recurseSubmodules: boolean;
  bare?: boolean;
  /** Default true: `git lfs pull` when the repo uses LFS. */
  lfsPull?: boolean;
}

export interface CloneResult2 {
  path: string;
  lfs?: 'pulled' | 'unavailable' | 'failed';
  sparse?: boolean;
  /** Credentials were embedded in the URL; they were removed from the saved remote. */
  strippedCredentials?: boolean;
  warnings?: string[];
}

export interface LicenseChoice {
  spdxId: string;
  author: string;
  year: number;
}

export type RepoVisibility = 'public' | 'private';

export interface RemoteInitRequest {
  integrationKey: string;
  /** Org / group / workspace; undefined = the account itself. */
  owner?: string;
  name: string;
  description?: string;
  visibility: RepoVisibility;
  protocol: 'https' | 'ssh';
}

export interface InitRequest2 {
  parentDir: string;
  name: string;
  defaultBranch: string;
  gitignoreTemplates: string[];
  license?: LicenseChoice;
  createReadme: boolean;
  initialCommit: boolean;
  bare: boolean;
  /** Create the repo on a provider too, then add `origin` and push (requires `initialCommit`). */
  remote?: RemoteInitRequest;
  /** For progress on `repos:cloneProgress` (push) and cancellation via `repos:cancel2`. */
  opId?: string;
}

export interface InitResult2 {
  path: string;
  remote?: { fullName: string; webUrl: string; cloneUrl: string };
  /** The remote was created but the push failed; the local repo is kept. */
  pushError?: string;
}

// ---- CLI shim ---------------------------------------------------------------------------------------

export interface CliInstallStatus {
  platform: NodeJS.Platform;
  installed: boolean;
  /** Launcher script written by the app (`githappens` / `githappens.cmd`). */
  shimPath: string;
  /** Where the command is linked / which directory is put on PATH. */
  target: string;
  /** What installing does, shown before asking for consent. */
  description: string;
}

export interface CliInstallResult {
  ok: boolean;
  message: string;
  /** Command for the user to run themselves (permission denied on /usr/local/bin). */
  manualCommand?: string;
  /** Windows: PATH changed — new terminals pick it up. */
  restartTerminals?: boolean;
}

// ---- sparse -----------------------------------------------------------------------------------------

export interface SparseStateInfo {
  enabled: boolean;
  cone: boolean;
  patterns: string[];
  filter?: string;
}

export interface Repos2IpcContract {
  /** Registry incl. groups and persisted column widths. */
  'repos:state': { req: Record<string, never>; res: RepoRegistryState };
  /** Validate without adding to recents (spec 03 §5). */
  'repos:validate': { req: { path: string }; res: ValidateRepoResult };
  /** Release one reference of an open repo by path (watcher/queue disposed when unused). */
  'repos:close': { req: { path: string }; res: void };
  'repos:reorderFavorites': { req: { paths: string[] }; res: void };
  'repos:groups:save': { req: { groups: RepoGroup[] }; res: void };
  'repos:groups:assign': { req: { path: string; groupId: string; member: boolean }; res: void };
  'repos:columns:save': { req: { columnWidths: RepoColumnWidths }; res: void };
  'repos:details': { req: { path: string }; res: RepoDetails };
  /** Explicit consent only: `git config --global --add safe.directory <path>`. */
  'repos:safeDirectory:add': { req: { path: string }; res: void };
  'repos:inspectTarget': { req: { parentDir: string; folderName: string }; res: CloneTargetInfo };
  /** Clone with shallow / sparse / blobless / LFS options; progress on `repos:cloneProgress`. */
  'repos:clone2': { req: CloneRequest2; res: CloneResult2 };
  'repos:cancel2': { req: { opId: string }; res: void };
  'repos:init2': { req: InitRequest2; res: InitResult2 };
  'templates:gitignore:list': { req: Record<string, never>; res: string[] };
  /** Concatenated with `### Name ###` headers. */
  'templates:gitignore:get': { req: { names: string[] }; res: string };
  'templates:license:list': { req: Record<string, never>; res: { spdxId: string; name: string }[] };
  'templates:license:render': { req: LicenseChoice; res: string };
  'providers:repos:create': {
    req: {
      integrationKey: string;
      owner?: string;
      name: string;
      description?: string;
      visibility: RepoVisibility;
    };
    res: RemoteRepo;
  };
  'sparse:state': { req: { repoId: RepoId }; res: SparseStateInfo };
  'cli:status': { req: Record<string, never>; res: CliInstallStatus };
  'cli:install': { req: Record<string, never>; res: CliInstallResult };
}

export const REPOS2_INVOKE_CHANNELS = [
  'repos:state',
  'repos:validate',
  'repos:close',
  'repos:reorderFavorites',
  'repos:groups:save',
  'repos:groups:assign',
  'repos:columns:save',
  'repos:details',
  'repos:safeDirectory:add',
  'repos:inspectTarget',
  'repos:clone2',
  'repos:cancel2',
  'repos:init2',
  'templates:gitignore:list',
  'templates:gitignore:get',
  'templates:license:list',
  'templates:license:render',
  'providers:repos:create',
  'sparse:state',
  'cli:status',
  'cli:install',
] as const satisfies readonly (keyof Repos2IpcContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof Repos2IpcContract, (typeof REPOS2_INVOKE_CHANNELS)[number]> = true;
void invokeExhaustive;

// ---- pure helpers shared by main + renderer ---------------------------------------------------------

/** `Receiving objects:  42% (420/1000), 12.34 MiB | 3.21 MiB/s` → transferred + speed. */
export function parseTransfer(text: string): { transferred?: string; speed?: string } {
  const m = /([\d.]+\s*[KMGT]?i?B)\s*\|\s*([\d.]+\s*[KMGT]?i?B\/s)/.exec(text);
  if (m) return { transferred: m[1]!.replace(/\s+/g, ' '), speed: m[2]!.replace(/\s+/g, ' ') };
  const t = /,\s*([\d.]+\s*[KMGT]?i?B)\s*(?:\||$|,)/.exec(text);
  return t ? { transferred: t[1]!.replace(/\s+/g, ' ') } : {};
}

/** True when an http(s)/ftp URL embeds a user name / token (mirrors `stripUrlCredentials` in @githappens/git). */
export function hasEmbeddedCredentials(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@/i.exec(url.trim());
  if (!m) return false;
  return !(/^(git\+)?ssh:/i.test(m[1]!) && !m[2]!.includes(':'));
}

/** "user/repo.git", "git@host:user/repo.git", "C:\\src\\repo" → "repo". */
export function folderFromUrl(url: string): string {
  const last =
    url
      .trim()
      .replace(/[/\\]+$/, '')
      .split(/[/:\\]/)
      .pop() ?? '';
  return last.replace(/\.git$/i, '');
}
