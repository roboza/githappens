import type {
  OrgRole,
  PatchFile,
  PatchKind,
  PatchMeta,
  PatchVisibility,
  RepoIdentity,
  UserRef,
} from '@githappens/cloud-api/types';
import type { PatchApplyTarget } from '@githappens/git/ops';
import type { FileDiff, RepoId, Sha } from '@githappens/git/types';

export type { PatchApplyTarget, PatchFile, PatchKind, PatchVisibility, RepoIdentity, UserRef };

/**
 * Cloud Patches IPC (spec 14 §5.4 `patch:*`, §6.3). Patch text is built and applied in main; applying is
 * the `patch.apply` git op (undo journal). E2E keys travel only inside links (`#k=`) and are never sent to
 * the server; keys of the user's own patches are kept in the SecretStore so their links survive restarts.
 */

/** What to share. `stash.ref` is the stash commit sha. */
export type PatchSource =
  | { kind: 'wip'; stagedOnly: boolean; paths?: string[] }
  | { kind: 'commit'; sha: Sha }
  | { kind: 'stash'; ref: Sha };

/** Server patch metadata plus local extras. */
export interface CloudPatch extends PatchMeta {
  /** `githappens://patch/<id>` (+ `#k=` when the key is known in this session). */
  deepLink: string;
  /** Web link to share (`webUrl` + `#k=` when the key is known in this session). */
  shareUrl: string;
  /** e2e patch whose key is available in this session (links above are complete). */
  hasKey: boolean;
  /** Authored by the signed-in user. */
  mine: boolean;
  /** Real title kept locally for e2e patches created on this machine (server only has a generic one). */
  localTitle?: string;
}

export interface PatchAvailability {
  /** A GitHappens Cloud server is configured. */
  configured: boolean;
  signedIn: boolean;
  serverUrl: string | null;
  user?: UserRef;
  orgs: Array<{ id: string; name: string; role: OrgRole }>;
  activeOrgId: string | null;
}

/** Create-dialog preview: what would be shared. */
export interface PatchDraft {
  kind: PatchKind;
  title: string;
  baseSha: Sha;
  baseBranch?: string;
  files: PatchFile[];
  warnings: string[];
  /** Raw patch text bytes. */
  size: number;
  /** Server limit for the uploaded (compressed) blob. */
  maxBytes: number;
}

export interface PatchCreateReq {
  repoId: RepoId;
  source: PatchSource;
  title: string;
  description?: string;
  visibility: PatchVisibility;
  /** Org for 'org' / 'collaborators' (defaults to the active org). */
  orgId?: string;
  /** User ids (org members) for 'collaborators'. */
  collaborators?: string[];
  /** Omitted / null = never. */
  expiresInDays?: number | null;
  /** End-to-end encrypt (default: on for 'link'). */
  e2e?: boolean;
  /** e2e only: store the real title in plaintext on the server (default false → "Encrypted patch"). */
  shareTitle?: boolean;
  /** Override the patch kind (Code Suggest creates WIP patches of kind 'suggestion'). */
  kind?: 'suggestion';
}

export interface PatchCreateRes {
  patch: CloudPatch;
  /** Link to share (web URL, with `#k=` for e2e). */
  shareUrl: string;
  deepLink: string;
  warnings: string[];
}

export interface PatchRepoCandidate {
  repoId: RepoId;
  path: string;
  name: string;
  match: 'remote' | 'root-commit' | 'chosen';
  baseAvailable: boolean;
}

export interface OpenedPatch {
  patch: CloudPatch;
  /** Decrypted bundle contents. */
  bundle: {
    title: string;
    description?: string;
    kind: PatchKind;
    baseSha: Sha;
    baseBranch?: string;
    createdWith: string;
    files: PatchFile[];
    /** Raw patch text (for "Download .patch"). */
    patch: string;
  };
  /** Parsed patch for the read-only diff (same order as `bundle.files`). */
  diff: FileDiff[];
  localMatch: {
    /** Best match when unambiguous. */
    repoId?: RepoId;
    baseAvailable: boolean;
    candidates: PatchRepoCandidate[];
  };
  warnings: string[];
}

export type PatchOpenRes =
  | { status: 'opened'; opened: OpenedPatch }
  /** The link points at another server than the configured one; repeat with `allowOtherServer`. */
  | { status: 'server-mismatch'; linkServer: string; configuredServer: string | null };

export interface PatchApplyReq {
  patchId: string;
  repoId: RepoId;
  target: PatchApplyTarget;
  /** Default true. */
  threeWay?: boolean;
  ignoreWhitespace?: boolean;
  /** Fall back to `git apply --reject` (.rej files). */
  reject?: boolean;
  /** Branch targets: commit the result (commit patches keep their author via `git am`). */
  commit?: boolean;
}

export interface PatchApplyRes {
  applied: boolean;
  conflicts: string[];
  rejects: string[];
  branch?: string;
  commit?: Sha;
  summary?: string;
  warnings: string[];
}

export interface PatchesIpcContract {
  'patch:availability': { req: Record<string, never>; res: PatchAvailability };
  'patch:preview': { req: { repoId: RepoId; source: PatchSource }; res: PatchDraft };
  'patch:create': { req: PatchCreateReq; res: PatchCreateRes };
  'patch:list': {
    req: { scope: 'mine' | 'shared'; repoId?: RepoId };
    /** `offline`: the server was unreachable; `items` come from the local "created by me" cache. */
    res: { items: CloudPatch[]; offline?: boolean };
  };
  'patch:get': { req: { id: string }; res: CloudPatch };
  'patch:update': {
    req: {
      id: string;
      title?: string;
      description?: string;
      visibility?: PatchVisibility;
      collaborators?: string[];
      /** null = never expires. */
      expiresInDays?: number | null;
    };
    res: CloudPatch;
  };
  'patch:delete': { req: { id: string }; res: null };
  'patch:open': { req: { url: string; allowOtherServer?: boolean }; res: PatchOpenRes };
  /** Re-check one repo for an opened patch (user picked a repo): base availability. */
  'patch:checkRepo': { req: { patchId: string; repoId: RepoId }; res: PatchRepoCandidate };
  /** `git fetch --all`, then re-check the base commit. */
  'patch:fetchBase': { req: { patchId: string; repoId: RepoId }; res: { baseAvailable: boolean } };
  'patch:apply': { req: PatchApplyReq; res: PatchApplyRes };
  /** Org members for the "Specific people" picker (excludes the signed-in user). */
  'patch:collaboratorCandidates': {
    req: { orgId?: string };
    res: { orgId: string | null; members: UserRef[] };
  };
}

export interface PatchesEventContract {
  /** Patch lists / availability changed (created, updated, deleted, sign-in/out). */
  'patch:changed': { reason: 'created' | 'updated' | 'deleted' | 'session' };
}

export const PATCHES_INVOKE_CHANNELS = [
  'patch:availability',
  'patch:preview',
  'patch:create',
  'patch:list',
  'patch:get',
  'patch:update',
  'patch:delete',
  'patch:open',
  'patch:checkRepo',
  'patch:fetchBase',
  'patch:apply',
  'patch:collaboratorCandidates',
] as const satisfies readonly (keyof PatchesIpcContract)[];

export const PATCHES_EVENT_CHANNELS = [
  'patch:changed',
] as const satisfies readonly (keyof PatchesEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof PatchesIpcContract, (typeof PATCHES_INVOKE_CHANNELS)[number]> = true;
const eventExhaustive: Exhaustive<keyof PatchesEventContract, (typeof PATCHES_EVENT_CHANNELS)[number]> = true;
void invokeExhaustive;
void eventExhaustive;
