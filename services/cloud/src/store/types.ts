/**
 * Persistence interface. Two implementations: {@link MemoryStore} (tests / development) and
 * {@link PgStore} (Postgres 16). The store is deliberately "dumb": authorization lives in the route
 * handlers; the store only guarantees atomicity where a check-and-write must not race (versions,
 * single-use codes, refresh rotation, nonces). All times are passed in by the caller (no SQL `now()`)
 * so tests can drive the clock.
 */
import type {
  OrgPolicies,
  OrgRole,
  PatchFile,
  PatchKind,
  PatchVisibility,
  RepoIdentity,
  SuggestionStatus,
  WorkspaceShare,
  FootprintFile,
} from '@githappens/cloud-api/types';

export interface UserRec {
  id: string;
  /** Lower-cased. */
  email: string;
  name: string;
  avatarUrl?: string;
  createdAt: Date;
  /** Set when the account is scheduled for deletion (hard delete 7 days later). */
  deletedAt?: Date;
}

export interface IdentityRec {
  provider: string;
  host: string;
  subject: string;
  userId: string;
}

export interface AuthCodeRec {
  /** sha256 of the code. */
  hash: Buffer;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: Date;
}

export interface RefreshTokenRec {
  id: string;
  userId: string;
  /** All tokens descending from one sign-in share a family; reuse of a rotated token revokes it. */
  familyId: string;
  hash: Buffer;
  createdAt: Date;
  expiresAt: Date;
  usedAt?: Date;
  revokedAt?: Date;
}

export interface OrgRec {
  id: string;
  name: string;
  slug: string;
  policies: OrgPolicies;
  footprintSalt: string;
  createdBy: string;
  createdAt: Date;
}

export interface MemberRec {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: Date;
}

export interface TeamRec {
  id: string;
  orgId: string;
  name: string;
  memberIds: string[];
  createdAt: Date;
}

export interface InviteRec {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  tokenHash: Buffer;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
}

export interface SyncRec {
  userId: string;
  category: string;
  version: number;
  ciphertext: Buffer;
  nonce: Buffer;
  deviceId?: string;
  updatedAt: Date;
}

export interface WorkspaceRec {
  id: string;
  ownerUserId: string;
  orgId?: string;
  version: number;
  doc: Record<string, unknown>;
  shares: WorkspaceShare[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LaunchpadRec {
  userId: string;
  version: number;
  doc: Record<string, unknown>;
  updatedAt: Date;
}

export interface RepoIdentityRec {
  id: string;
  orgId: string;
  key: string;
  repo: RepoIdentity;
  createdAt: Date;
}

export interface PatchRec {
  id: string;
  authorId: string;
  orgId?: string;
  repo?: RepoIdentity;
  repoKey?: string;
  title: string;
  description?: string;
  kind: PatchKind;
  baseSha: string;
  baseBranch?: string;
  files?: PatchFile[];
  e2e: boolean;
  size: number;
  sha256: string;
  visibility: PatchVisibility;
  collaborators: string[];
  status: 'pending' | 'complete';
  createdAt: Date;
  completedAt?: Date;
  expiresAt?: Date;
  deletedAt?: Date;
}

export interface SuggestionRec {
  id: string;
  patchId: string;
  authorId: string;
  provider: string;
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
  prHeadSha: string;
  title: string;
  status: SuggestionStatus;
  statusBy?: string;
  commentId?: string;
  coAuthor?: { name: string; email: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface SuggestionQuery {
  provider: string;
  /** Lower-cased comparison; omitted = any host. */
  host?: string;
  owner: string;
  repo: string;
  prNumber?: number;
  limit: number;
}

export interface FootprintRec {
  orgId: string;
  userId: string;
  repoIdentityId: string;
  branchHash: string;
  branchLabel?: string;
  baseRef: string;
  headSha: string;
  files: FootprintFile[];
  updatedAt: Date;
}

export interface AuditRec {
  at: Date;
  actorId: string;
  orgId?: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export type VersionedWrite<T> = { ok: true; value: T } | { ok: false; currentVersion: number };

export interface PatchCursor {
  createdAt: Date;
  id: string;
}

export interface PatchQuery {
  /** `mine`: authored by userId. `shared`: org visibility in `orgIds` or collaborator = userId (not authored). */
  scope: 'mine' | 'shared';
  userId: string;
  orgIds: string[];
  repoKey?: string;
  now: Date;
  cursor?: PatchCursor;
  limit: number;
}

export interface Store {
  readonly kind: 'memory' | 'postgres';
  close(): Promise<void>;

  // users & identities
  createUser(user: UserRec): Promise<void>;
  getUser(id: string): Promise<UserRec | undefined>;
  getUsers(ids: string[]): Promise<UserRec[]>;
  getUserByEmail(email: string): Promise<UserRec | undefined>;
  updateUserProfile(id: string, patch: { name?: string; avatarUrl?: string }): Promise<void>;
  markUserDeleted(id: string, at: Date): Promise<void>;
  listUsersDeletedBefore(cutoff: Date): Promise<UserRec[]>;
  /** Hard delete the user and everything that hangs off it (identities, tokens, sync, workspaces, memberships, patches rows, footprints). */
  purgeUser(id: string): Promise<void>;
  findIdentity(provider: string, host: string, subject: string): Promise<IdentityRec | undefined>;
  linkIdentity(identity: IdentityRec): Promise<void>;

  // auth codes, nonces, refresh tokens
  saveAuthCode(code: AuthCodeRec): Promise<void>;
  /** Atomically fetch-and-delete; undefined if unknown or expired. */
  consumeAuthCode(hash: Buffer, now: Date): Promise<AuthCodeRec | undefined>;
  /** Insert-if-absent: true the first time a nonce is seen. */
  consumeNonce(nonce: string, expiresAt: Date): Promise<boolean>;
  insertRefreshToken(token: RefreshTokenRec): Promise<void>;
  findRefreshToken(hash: Buffer): Promise<RefreshTokenRec | undefined>;
  /** Atomically mark a live token as used (rotated). False if it was already used/revoked. */
  markRefreshTokenUsed(id: string, at: Date): Promise<boolean>;
  revokeRefreshFamily(familyId: string, at: Date): Promise<void>;
  revokeUserRefreshTokens(userId: string, at: Date): Promise<void>;
  /** Drop expired auth codes, nonces, refresh tokens and stale invites. */
  cleanupAuth(now: Date): Promise<number>;

  // orgs
  createOrg(org: OrgRec, owner: MemberRec): Promise<void>;
  getOrg(id: string): Promise<OrgRec | undefined>;
  getOrgBySlug(slug: string): Promise<OrgRec | undefined>;
  updateOrg(id: string, patch: { name?: string; policies?: OrgPolicies }): Promise<void>;
  deleteOrg(id: string): Promise<void>;
  listOrgsForUser(userId: string): Promise<Array<{ org: OrgRec; role: OrgRole }>>;
  getMember(orgId: string, userId: string): Promise<MemberRec | undefined>;
  listMembers(orgId: string): Promise<MemberRec[]>;
  upsertMember(member: MemberRec): Promise<void>;
  /** Removes the membership, the user's team memberships in that org and their footprints in that org. */
  removeMember(orgId: string, userId: string): Promise<void>;

  // teams
  listTeams(orgId: string): Promise<TeamRec[]>;
  getTeam(id: string): Promise<TeamRec | undefined>;
  createTeam(team: TeamRec): Promise<void>;
  renameTeam(id: string, name: string): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  setTeamMembers(id: string, userIds: string[]): Promise<void>;
  listTeamIdsForUser(userId: string): Promise<string[]>;

  // invites
  createInvite(invite: InviteRec): Promise<void>;
  listPendingInvites(orgId: string, now: Date): Promise<InviteRec[]>;
  getInvite(id: string): Promise<InviteRec | undefined>;
  getInviteByTokenHash(hash: Buffer): Promise<InviteRec | undefined>;
  deleteInvite(id: string): Promise<void>;
  /** Atomically mark accepted; false if already accepted. */
  markInviteAccepted(id: string, at: Date): Promise<boolean>;

  // settings sync
  listSync(userId: string): Promise<SyncRec[]>;
  getSync(userId: string, category: string): Promise<SyncRec | undefined>;
  /** expectedVersion 0 = create; undefined = unconditional. */
  putSync(
    rec: Omit<SyncRec, 'version'>,
    expectedVersion: number | undefined,
  ): Promise<VersionedWrite<number>>;
  deleteAllSync(userId: string): Promise<void>;

  // workspaces & launchpad
  createWorkspace(ws: WorkspaceRec): Promise<void>;
  getWorkspace(id: string): Promise<WorkspaceRec | undefined>;
  listWorkspacesVisibleTo(userId: string, orgIds: string[], teamIds: string[]): Promise<WorkspaceRec[]>;
  listWorkspacesOwnedBy(userId: string): Promise<WorkspaceRec[]>;
  updateWorkspace(
    id: string,
    expectedVersion: number | undefined,
    patch: { doc?: Record<string, unknown>; shares?: WorkspaceShare[] },
    at: Date,
  ): Promise<VersionedWrite<WorkspaceRec>>;
  deleteWorkspace(id: string): Promise<void>;
  getLaunchpad(userId: string): Promise<LaunchpadRec | undefined>;
  putLaunchpad(
    userId: string,
    expectedVersion: number | undefined,
    doc: Record<string, unknown>,
    at: Date,
  ): Promise<VersionedWrite<number>>;

  // repo identities & footprints
  upsertRepoIdentity(rec: RepoIdentityRec): Promise<RepoIdentityRec>;
  findRepoIdentity(orgId: string, key: string): Promise<RepoIdentityRec | undefined>;
  getRepoIdentities(ids: string[]): Promise<RepoIdentityRec[]>;
  upsertFootprint(fp: FootprintRec): Promise<void>;
  deleteFootprint(orgId: string, userId: string, repoIdentityId: string, branchHash: string): Promise<void>;
  listFootprints(
    orgId: string,
    q: { repoIdentityId?: string; since?: Date; excludeUserId?: string; notBefore: Date },
  ): Promise<FootprintRec[]>;
  deleteFootprintsForUser(userId: string): Promise<void>;
  deleteFootprintsBefore(cutoff: Date): Promise<number>;

  // patches
  createPatch(patch: PatchRec): Promise<void>;
  getPatch(id: string): Promise<PatchRec | undefined>;
  updatePatch(
    id: string,
    patch: Partial<
      Pick<
        PatchRec,
        | 'title'
        | 'description'
        | 'visibility'
        | 'collaborators'
        | 'expiresAt'
        | 'status'
        | 'completedAt'
        | 'deletedAt'
      >
    >,
  ): Promise<void>;
  listPatches(q: PatchQuery): Promise<PatchRec[]>;
  listPatchesByAuthor(userId: string): Promise<PatchRec[]>;
  markPatchesDeleted(by: { authorId?: string; orgId?: string }, at: Date): Promise<void>;
  /** Patches whose blob and row should be purged: deleted, expired, or pending since before `pendingCutoff`. */
  listPatchesToPurge(now: Date, pendingCutoff: Date, limit: number): Promise<PatchRec[]>;
  hardDeletePatch(id: string): Promise<void>;

  // code suggestions (rows cascade with their patch and author)
  createSuggestion(rec: SuggestionRec): Promise<void>;
  getSuggestion(id: string): Promise<SuggestionRec | undefined>;
  /** Newest first; owner/repo/host compared case-insensitively. */
  listSuggestions(q: SuggestionQuery): Promise<SuggestionRec[]>;
  updateSuggestion(
    id: string,
    patch: Partial<Pick<SuggestionRec, 'status' | 'statusBy' | 'commentId' | 'updatedAt'>>,
  ): Promise<void>;

  // audit log (share / visibility / membership changes)
  audit(entry: AuditRec): Promise<void>;
}
