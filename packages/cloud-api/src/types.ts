/**
 * GitHappens Cloud REST contract (spec 14 §5.3). Single source of truth for services/cloud and the
 * desktop CloudClient. All bodies are JSON unless noted; all `/v1/*` routes except the ones marked
 * PUBLIC require `Authorization: Bearer <access token>`.
 *
 * Conventions
 * - Errors: non-2xx with `ApiError` body. 401 `unauthorized` (expired/invalid access token → refresh
 *   and retry once), 403 `forbidden`, 404 `not_found`, 409 `conflict`, 410 `gone` (expired/deleted
 *   patch), 412 `precondition_failed` (If-Match version mismatch; body carries `currentVersion`),
 *   413 `too_large`, 422 `validation`, 429 `rate_limited` (+ `Retry-After` seconds).
 * - Optimistic concurrency: resources with `version` accept `If-Match: <version>` on writes; the server
 *   increments `version` on every successful write. Creating a sync category uses `If-Match: 0`.
 * - Pagination: list routes accept `?cursor=&limit=` (default 50, max 200) and return `Page<T>`.
 * - Times are ISO-8601 strings (UTC). Ids are UUIDs except patch ids (22-char base62, 128-bit random).
 * - Binary payloads (sync ciphertext, nonces) are base64url strings without padding.
 */

export type IsoTime = string;

export interface ApiError {
  error:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'gone'
    | 'precondition_failed'
    | 'too_large'
    | 'validation'
    | 'rate_limited'
    | 'server';
  message: string;
  /** 412 only. */
  currentVersion?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// =================================================================================================
// Auth — OAuth 2.0 Authorization Code + PKCE (S256) with a loopback redirect (RFC 8252).
// =================================================================================================
//
// GET  /oauth/authorize?response_type=code&client_id=desktop&redirect_uri=http://127.0.0.1:<port>/callback
//        &code_challenge=<S256>&code_challenge_method=S256&state=<random>&idp=<IdpId>[&login_hint=<email>]
//      PUBLIC. Browser page. Federates to the chosen identity provider, then redirects to
//      `redirect_uri?code=…&state=…` (or `?error=…`). redirect_uri must be http://127.0.0.1:<any port>/…
//      or http://localhost:<port>/….
// POST /oauth/token        PUBLIC. Form or JSON `TokenRequest` → `TokenResponse`.
// POST /oauth/revoke       PUBLIC. `{ token }` (refresh token) → 200 `{}` (always, even if unknown).
// GET  /.well-known/githappens-cloud   PUBLIC → `ServerInfo` (desktop calls it to validate a server URL).
// GET  /healthz            PUBLIC → `{ status: 'ok' }`.

/** `dev` exists only when the server runs with GH_CLOUD_DEV_LOGIN=1 (tests / local development). */
export type IdpId = 'github' | 'gitlab' | 'google' | 'email' | 'dev';

export interface ServerInfo {
  name: string;
  version: string;
  /** Identity providers configured on this server. */
  idps: IdpId[];
  limits: { patchMaxBytes: number; patchMaxExpiryDays: number | null };
}

export type TokenRequest =
  | {
      grant_type: 'authorization_code';
      code: string;
      code_verifier: string;
      redirect_uri: string;
      client_id: 'desktop';
    }
  | { grant_type: 'refresh_token'; refresh_token: string; client_id: 'desktop' };

export interface TokenResponse {
  access_token: string; // JWT (EdDSA), 15 min
  token_type: 'Bearer';
  expires_in: number; // seconds
  refresh_token: string; // opaque, 30 d, rotated on every use (reuse of an old one revokes the family)
}

// =================================================================================================
// Account
// =================================================================================================
// GET    /v1/me          → Me
// DELETE /v1/me          → 202 `{ deleteAfter: IsoTime }` (hard delete incl. blobs within 7 days)
// GET    /v1/me/export   → `{ user, orgs, syncCategories: SyncCategoryInfo[], patches: PatchMeta[], workspaces: CloudWorkspace[] }`

export interface UserRef {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export type OrgRole = 'owner' | 'admin' | 'member';

export interface Me extends UserRef {
  email: string;
  orgs: Array<{ id: string; name: string; slug: string; role: OrgRole }>;
}

// =================================================================================================
// Settings sync — server stores opaque ciphertext only (spec 14 §6.2)
// =================================================================================================
// GET  /v1/sync                → SyncCategoryInfo[]
// GET  /v1/sync/:category      → SyncItem | 404
// PUT  /v1/sync/:category      If-Match: <version> (0 to create)  body SyncPut → `{ version }` | 412
// DELETE /v1/sync              → 204 (deletes every category incl. `_keys`; "Reset sync data")

/** Desktop categories plus `_keys` (wrapped data-encryption key). Server accepts /^[a-z_][a-z0-9-]{0,40}$/. */
export type SyncCategory =
  | '_keys'
  | 'preferences'
  | 'keybindings'
  | 'themes'
  | 'workspaces-local'
  | 'launchpad'
  | 'integrations-list'
  | 'profiles';

export interface SyncCategoryInfo {
  category: string;
  version: number;
  updatedAt: IsoTime;
  size: number;
  deviceId?: string;
}

export interface SyncItem extends SyncCategoryInfo {
  ciphertext: string; // base64url
  nonce: string; // base64url
}

export interface SyncPut {
  ciphertext: string;
  nonce: string;
  deviceId: string;
}

// =================================================================================================
// Cloud workspaces & Launchpad state (spec 11 §6.6)
// =================================================================================================
// GET    /v1/workspaces                 → CloudWorkspace[] (own + shared with me via org/team)
// POST   /v1/workspaces                 `{ orgId?, doc }` → 201 CloudWorkspace
// GET    /v1/workspaces/:id             → CloudWorkspace
// PUT    /v1/workspaces/:id             If-Match  `{ doc }` → CloudWorkspace | 412
// DELETE /v1/workspaces/:id             → 204 (owner or org admin)
// PUT    /v1/workspaces/:id/shares      `{ shares: WorkspaceShare[] }` → CloudWorkspace
// GET    /v1/launchpad/state            → `{ version, doc }` (doc = itemStates + savedViews JSON, plaintext)
// PUT    /v1/launchpad/state            If-Match  `{ doc }` → `{ version }` | 412

export interface WorkspaceShare {
  principalType: 'team' | 'user' | 'org';
  principalId: string;
}

export interface CloudWorkspace {
  id: string;
  ownerUserId: string;
  orgId?: string;
  version: number;
  /** Workspace document WITHOUT local paths (spec 11 Workspace minus localPath fields). */
  doc: Record<string, unknown>;
  shares: WorkspaceShare[];
  updatedAt: IsoTime;
}

// =================================================================================================
// Organizations (minimal: no seats / billing) — spec 14 §6.7
// =================================================================================================
// POST   /v1/orgs                               `{ name, slug? }` → 201 Org (caller becomes owner)
// GET    /v1/orgs/:id                           → OrgDetail (members only)
// PATCH  /v1/orgs/:id                           `{ name? }` → Org (admin)
// DELETE /v1/orgs/:id                           → 204 (owner)
// PATCH  /v1/orgs/:id/policies                  `Partial<OrgPolicies>` → OrgPolicies (admin)
// PATCH  /v1/orgs/:id/members/:userId           `{ role }` → OrgMember (admin; owners only by owner)
// DELETE /v1/orgs/:id/members/:userId           → 204 (admin, or self = leave; deletes their footprints)
// POST   /v1/orgs/:id/invites                   `{ email, role }` → 201 `Invite & { acceptUrl }` (admin).
//                                               acceptUrl = `<server>/invite/<token>` (PUBLIC page that
//                                               deep-links `githappens://invite/<token>`); token 7 days.
// GET    /v1/orgs/:id/invites                   → Invite[] (admin; pending only)
// DELETE /v1/orgs/:id/invites/:inviteId         → 204
// POST   /v1/invites/:token/accept              → Org (any signed-in user; email need not match in v1)
// GET    /v1/orgs/:id/teams                     → Team[]
// POST   /v1/orgs/:id/teams                     `{ name }` → 201 Team (admin)
// PATCH  /v1/orgs/:id/teams/:teamId             `{ name }` → Team (admin)
// DELETE /v1/orgs/:id/teams/:teamId             → 204 (admin)
// PUT    /v1/orgs/:id/teams/:teamId/members     `{ userIds: string[] }` → Team (admin)

export interface OrgPolicies {
  /** Max patch expiry in days; null = no cap. */
  patchMaxExpiryDays: number | null;
  /** Allow `visibility: 'link'` patches by members. */
  allowPublicLinks: boolean;
  /** Footprints carry plaintext paths (default false → path hashes only). */
  footprintSharePaths: boolean;
  /** Footprints carry a plaintext branch label (default false → hash only). */
  footprintShareBranchNames: boolean;
}

export const DEFAULT_ORG_POLICIES: OrgPolicies = {
  patchMaxExpiryDays: null,
  allowPublicLinks: true,
  footprintSharePaths: false,
  footprintShareBranchNames: false,
};

export interface Org {
  id: string;
  name: string;
  slug: string;
  policies: OrgPolicies;
  /** Per-org secret for footprint path HMACs (members only; spec 14 §6.5). base64url, 32 bytes. */
  footprintSalt: string;
}

export interface OrgMember {
  user: UserRef;
  role: OrgRole;
  joinedAt: IsoTime;
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  memberIds: string[];
}

export interface OrgDetail extends Org {
  members: OrgMember[];
  teams: Team[];
  myRole: OrgRole;
}

export interface Invite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  expiresAt: IsoTime;
  createdAt: IsoTime;
}

// =================================================================================================
// Cloud Patches (spec 14 §6.3)
// =================================================================================================
// POST   /v1/patches                    PatchCreate → 201 PatchCreated (status 'pending' until complete)
// PUT    <uploadUrl>                    raw bytes (application/octet-stream), ≤ size; token in URL, no Bearer
// POST   /v1/patches/:id/complete       → PatchMeta (server verifies byte length + sha256)
// GET    /v1/patches?scope=mine|shared[&repo=<RepoIdentity key>]&cursor&limit → Page<PatchMeta>
//        mine = authored; shared = visibility org (my orgs) or collaborators including me
// GET    /v1/patches/:id                → PatchMeta & { downloadUrl } — Bearer OPTIONAL: anonymous allowed
//                                        for visibility 'link'; 401 if anonymous and not 'link'; 403 if not
//                                        allowed; 410 if expired/deleted/not completed.
// GET    <downloadUrl>                  raw bytes; token in URL (5 min TTL), no Bearer
// PATCH  /v1/patches/:id                PatchUpdate → PatchMeta (author)
// DELETE /v1/patches/:id                → 204 (author or org admin)
// GET    /p/:id                         PUBLIC HTML viewer page; decrypts in the browser using the `#k=` fragment
//                                       (fragment never reaches the server) and offers "Open in GitHappens"
//                                       (githappens://patch/<id>#k=<key>).
//
// Blob = output of `sealPatchBundle()` (patch-crypto.ts): gzip(JSON PatchBundle), optionally AES-256-GCM
// encrypted (e2e). sha256 is over the uploaded bytes.

export type PatchKind = 'wip' | 'commit' | 'stash' | 'suggestion';
export type PatchVisibility = 'link' | 'org' | 'collaborators';

export interface RepoIdentity {
  provider: string; // 'github' | 'gitlab' | … | 'git' (unknown host)
  host: string;
  owner: string;
  name: string;
  /** First root commit (`git rev-list --max-parents=0 HEAD | tail -1`) — matches forks/mirrors. */
  initialCommitSha?: string;
}

export interface PatchFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface PatchCreate {
  title: string; // stored plaintext; desktop sends a generic title ("Encrypted patch") when e2e && !shareTitle
  description?: string;
  kind: PatchKind;
  orgId?: string; // required for 'org' / 'collaborators'
  repo?: RepoIdentity;
  baseSha: string;
  baseBranch?: string;
  /** Omitted for e2e patches. */
  files?: PatchFile[];
  e2e: boolean;
  size: number; // bytes of the blob that will be uploaded
  sha256: string; // hex
  visibility: PatchVisibility;
  collaborators?: string[]; // user ids (org members)
  expiresAt?: IsoTime; // omitted = no expiry (subject to org policy cap)
}

export interface PatchCreated {
  id: string;
  uploadUrl: string; // absolute, 15 min TTL
  webUrl: string; // <server>/p/<id> (desktop appends #k=<key> for e2e)
}

export interface PatchMeta {
  id: string;
  title: string;
  description?: string;
  kind: PatchKind;
  author: UserRef;
  orgId?: string;
  repo?: RepoIdentity;
  baseSha: string;
  baseBranch?: string;
  files?: PatchFile[];
  e2e: boolean;
  size: number;
  sha256: string;
  visibility: PatchVisibility;
  collaborators?: UserRef[];
  createdAt: IsoTime;
  expiresAt?: IsoTime;
  webUrl: string;
}

export interface PatchWithDownload extends PatchMeta {
  downloadUrl: string;
}

export interface PatchUpdate {
  title?: string;
  description?: string;
  visibility?: PatchVisibility;
  collaborators?: string[];
  expiresAt?: IsoTime | null;
}

// =================================================================================================
// Team footprints (opt-in per org; spec 14 §6.5) — never file contents
// =================================================================================================
// PUT    /v1/orgs/:orgId/footprints                          FootprintPut → `{ repoIdentityId }`
// DELETE /v1/orgs/:orgId/footprints/:repoIdentityId/:branchHash → 204
// GET    /v1/orgs/:orgId/footprints?repo=<repoIdentityId>[&since=IsoTime] → Footprint[] (excludes caller)
// GET    /v1/orgs/:orgId/repo-identities?key=<repoIdentityKey> → `{ id } | 404` (resolve id for a repo)
// GET    /v1/orgs/:orgId/team                                → TeamView (aggregated, includes caller)
// Footprints expire 14 days after their last update; leaving the org deletes them.

export interface FootprintFile {
  /** base64url(HMAC-SHA256(orgFootprintSalt, repoIdentityKey + ':' + path)). */
  pathHash: string;
  /** Only when org policy footprintSharePaths = true. */
  path?: string;
  /** Changed line ranges in BASE-file coordinates, inclusive [start, end]; empty = whole file / unknown. */
  ranges: Array<[number, number]>;
}

export interface FootprintPut {
  repo: RepoIdentity;
  /** base64url(HMAC-SHA256(orgFootprintSalt, repoIdentityKey + ':' + branchName)). */
  branchHash: string;
  branchLabel?: string; // only when footprintShareBranchNames
  baseRef: string; // e.g. 'origin/main'
  headSha: string;
  files: FootprintFile[]; // ≤ 500
}

export interface Footprint extends Omit<FootprintPut, 'repo'> {
  user: UserRef;
  repoIdentityId: string;
  updatedAt: IsoTime;
}

export interface TeamView {
  repos: Array<{
    repoIdentityId: string;
    repo: RepoIdentity;
    members: Array<{
      user: UserRef;
      branches: Array<{ branchHash: string; branchLabel?: string; fileCount: number; updatedAt: IsoTime }>;
      lastActivity: IsoTime;
    }>;
  }>;
}

/** Canonical key for a repo identity (used for HMACs and the `repo` query parameter). */
export function repoIdentityKey(r: Pick<RepoIdentity, 'provider' | 'host' | 'owner' | 'name'>): string {
  return `${r.provider}:${r.host.toLowerCase()}/${r.owner.toLowerCase()}/${r.name.toLowerCase()}`;
}

// =================================================================================================
// Code Suggest (spec 14 §4.3, §6.4) — a suggestion is a Cloud Patch of kind 'suggestion' plus the
// coordinates of the pull request it was made for. The server never verifies repository access (that
// would need provider tokens, which never reach this server): read access to a suggestion is exactly
// read access to its patch (link / org / collaborators), so possession of the link is the capability.
// =================================================================================================
// POST  /v1/suggestions                 SuggestionCreate → 201 Suggestion (patch must be the caller's,
//                                       kind 'suggestion', completed and live)
// GET   /v1/suggestions?provider=&host=&owner=&repo=&pr=   → Suggestion[] — newest first; only
//                                       suggestions whose patch the caller can read (anonymous callers
//                                       see link-visibility ones). `host` and `pr` are optional.
// GET   /v1/suggestions/:id             → Suggestion — Bearer OPTIONAL (same rule as the patch)
// PATCH /v1/suggestions/:id             SuggestionUpdate → Suggestion. `status`: anyone who can read
//                                       the patch (signed in); `commentId`: the suggestion's author only.

export type SuggestionStatus = 'open' | 'applied' | 'dismissed';

export interface SuggestionPrRef {
  /** Provider kind ('github', 'gitlab', …). */
  provider: string;
  /** Provider host ('github.com', 'ghe.acme.com'). */
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export interface SuggestionCreate extends SuggestionPrRef {
  patchId: string;
  /** PR head the suggestion was made against (40/64 hex). */
  prHeadSha: string;
  title: string;
  /** Provider comment id once the PR comment exists (can be set later with PATCH). */
  commentId?: string;
  /** Identity for the `Co-authored-by:` trailer when the author commits the suggestion. */
  coAuthor?: { name: string; email: string };
}

export interface SuggestionUpdate {
  status?: SuggestionStatus;
  commentId?: string;
}

export interface Suggestion extends SuggestionPrRef {
  id: string;
  patchId: string;
  author: UserRef;
  prHeadSha: string;
  title: string;
  status: SuggestionStatus;
  /** Who last changed `status` (absent while open). */
  statusBy?: UserRef;
  commentId?: string;
  coAuthor?: { name: string; email: string };
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** Web viewer of the underlying patch (`<server>/p/<patchId>`; the desktop appends `#k=` for e2e). */
  webUrl: string;
  /** `githappens://suggestion/<id>`. */
  deepLink: string;
}

// =================================================================================================
// Service metadata
// =================================================================================================
// GET  /openapi.json     PUBLIC → OpenAPI 3.1 document generated from this file (services/cloud/openapi.json)

/** Cloud workspace document written by the desktop (`CloudWorkspace.doc`); never contains local paths. */
export interface CloudWorkspaceDoc {
  format: 'githappens-workspace/1';
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  repos: Array<{
    name: string;
    /** Clone URL without credentials. */
    remoteUrl?: string;
    provider?: { kind: string; host: string; owner: string; name: string; webUrl?: string };
  }>;
}
