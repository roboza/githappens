# 14 — Cloud & Team Features (OPTIONAL phase)

> Depends on: 02 (GitService), 05 (branch ops), 06 (WIP/staging), 07 (diff), 09 (fetch), 10 (providers/AuthService), 11 (workspaces/Launchpad), 13 (preferences/profiles).
> Roadmap: Phase 6 (spec 15 §8). Everything here is **optional**; the app must be fully functional with no backend configured.

---

## 1. Purpose

GitHappens ties a set of collaboration features to a GitHappens Cloud account: sign-in, settings sync, Cloud Patches (share uncommitted work via link), Code Suggest (propose edits to any file of a PR), Team view & Conflict Prevention (warn when teammates touch the same files on other branches), Insights (PR/DORA-style metrics), and Organizations with seats/licensing.

This spec decides, per feature, whether we **build it on our own lightweight backend ("GitHappens Cloud")**, **build it backend-free**, or **skip it**, and gives API sketches, data models, client integration and privacy rules.

Decision summary:

| Feature | Decision | Backend needed? | Priority |
|---|---|---|---|
| Account & sign-in | Build (OIDC via GitHub/GitLab/Google sign-in + email magic link) | Yes | P1 of phase |
| Settings sync | Build (encrypted blob sync) | Yes | P1 |
| Cloud Patches | Build (client-side encrypted patch blobs, link sharing) | Yes (blob store) | P1 |
| Code Suggest | Build on top of Cloud Patches + provider PR comment | Yes (reuses patches) | P2 |
| Conflict Prevention – target branch | Build **backend-free** (local `git merge-tree`) — can ship in Phase 3/4 | No | P1 (move earlier) |
| Team view / overlap with teammates | Build (opt-in "work footprints" per org) | Yes | P3 |
| Insights / DORA metrics | Build **backend-free** first (computed from provider APIs locally); org dashboards later | No (v1) | P3 |
| Organizations & seats | Build minimal orgs/teams/invites for sharing; **skip** billing/seat licensing | Yes | P2 (minimal) |
| Cloud workspaces sharing (spec 11) | Build on orgs | Yes | P2 |

---

## 2. Reference behavior

### 2.1 Account & sign-in
- First launch prompts to sign in with a GitHappens Cloud account; options include email/password, GitHub, GitLab, Bitbucket, Google, SSO for enterprise orgs. Signing in with GitHub also connects the GitHub integration. The account carries license/plan (Community, Pro, Advanced, Business/Enterprise) which gates features (private repos on GitHub with free tier, profiles, Launchpad snooze, Team view…).
- Sign-in happens in the system browser on githappens.dev and returns to the app *(inferred: custom protocol/loopback)*.

### 2.2 Settings sync *(inferred)*
- Some state follows the account across machines: integrations (account-linked), cloud workspaces, Launchpad pins/snoozes/saved views, profile information. Local preferences (UI layout, themes) are primarily stored in local profile files; full prefs sync is not a highlighted feature.

### 2.3 Cloud Patches
- Share changes without committing/pushing: stage files in the WIP and click the Cloud Patch icon, or right-click a commit → "Share commit as Cloud Patch". GitLens can also share stashes and comparisons.
- After creation a toast offers "Copy Cloud Patch link"; patches are listed in a CLOUD PATCHES left-panel section.
- Link visibility: **anyone with the link**, **anyone in my organization** (account required), or **only collaborators** (selected org members).
- Recipients open the link in the desktop app (or view on githappens.dev), preview, then apply the changes to their working directory or to a new/existing branch.

### 2.4 Code Suggest
- GitHub.com only. On a branch with an open PR, "Review code and suggest changes" opens an edit session; the reviewer edits **any file in the repo** (not limited to the PR diff), then "Suggest changes" with a title.
- This posts a comment on the PR with two links: review in the browser (githappens.dev) or locally (desktop app).
- The author reviews per file and can **Apply** to the current branch, **Apply to a branch** (new/existing), or on the web **Commit suggestions** which creates a commit on the remote branch. PRs with suggestions get a "Code Suggestions" label/indicator.

### 2.5 Conflict Prevention / Team view (10.8 preview)
- **Target branch alerts** (individual): your branch is compared against its target (main/develop); a target icon in the toolbar/branch crumb turns to a warning listing conflicted files; actions: rebase, merge, stop detecting for this target, change target. Grey icon = no conflicts.
- **Teammate overlap** (org feature): compares your branch with teammates' **unmerged** branches; warns both people; expanded view shows overlapping lines; actions: share as Cloud Patch, push, copy a summary of the overlap, ignore; invite non-members.
- **Team view**: visibility of which teammates are working on which branches/files across workspace repos.

### 2.6 Insights
- Workspace "Insights" opens a web dashboard (githappens.dev) for Cloud Workspaces on GitHub.com, GitLab.com, Bitbucket.org, Azure DevOps (hosted): PR cycle time, throughput, merge history, team trends; DORA-oriented metrics in newer marketing *(details inferred)*.

### 2.7 Organizations & seats
- An org groups users with licensed seats; admins invite members, create teams, manage SSO, seat assignment, and share cloud workspaces with teams. Licensing gates paid features per seat.

---

## 3. User stories

1. As a user, I want to sign in once so my settings, workspaces and Launchpad state follow me to another computer.
2. As a user, I want my synced data encrypted so the server operator can't read my preferences or tokens.
3. As a developer, I want to share my uncommitted changes with a teammate via a link without pushing a branch.
4. As a recipient, I want to preview a shared patch and apply it to my working tree or a new branch.
5. As a reviewer, I want to suggest edits to files not in the PR diff and let the author apply them in one click.
6. As a developer, I want to be warned early that my branch conflicts with `main` so I can rebase before opening a PR.
7. As a team member, I want to know when a teammate is changing the same file/lines on another branch.
8. As a lead, I want PR cycle-time and deployment-frequency metrics for a workspace without buying another tool.
9. As an org admin, I want to invite teammates and share workspaces with teams.
10. As a privacy-conscious user, I want every cloud feature to be opt-in and to work against a self-hosted backend.

---

## 4. UI specification

### 4.1 Account

```
TitleBar (spec 01) right side
└─ AccountButton (avatar or "Sign in")
   └─ AccountMenu: name/email · Org switcher · Manage account (browser) · Sync status ("Synced 2m ago" / error) · Sign out

Preferences → Account
├─ ServerUrl (default: none; "Use GitHappens Cloud" or custom self-hosted URL)
├─ SignInButtons: GitHub · GitLab · Google · Email link
├─ SyncSection: toggles per category (Preferences, Keybindings, Themes, Workspaces, Launchpad state, Integration list*) · "Sync now" · Last sync · Conflicts
├─ EncryptionSection: Sync passphrase setup / recovery key download / "Reset sync data"
└─ DangerZone: Delete cloud data · Delete account
```
`*` Integration **list** (which providers/hosts are connected) syncs, never tokens; the other machine shows "Reconnect GitHub" prompts.

Onboarding (spec 01) never forces sign-in; "Skip" is primary-equal.

### 4.2 Cloud Patches

```
WIP panel (spec 06) header: [Share as Cloud Patch] icon (enabled when there are changes)
Commit context menu: "Share commit as Cloud Patch" · Stash context menu: "Share stash as Cloud Patch"

CreateCloudPatchDialog
├─ Title (default: branch name + first changed file) · Description (markdown)
├─ Contents: [•] Staged only [ ] All working changes  (commit/stash: fixed) · file tree with checkboxes · binary/size warnings
├─ Visibility: Anyone with the link | Members of <org> | Specific people (member picker)
├─ Expiry: 7d | 30d (default) | 90d | never (org policy may cap)
├─ [x] End-to-end encrypt (default on for "Anyone with link"; key lives in link fragment)
└─ Create → toast "Cloud Patch created" [Copy link] [Open]

LeftPanel → CLOUD PATCHES section
├─ Tabs: Created by me | Shared with me
└─ PatchRow: title · repo · files count · created · visibility icon · ⋯ (Copy link, Open, Edit visibility, Delete)

CloudPatchView (center view, opened via link or row)
├─ Header: title, author, created, base commit (short sha + "available locally ✓ / ✗ fetch needed"), repo match status
├─ FileList + Monaco diff (read-only, spec 07)
├─ Comments (P3)
└─ Actions: Apply to working tree · Apply to new branch… · Apply to existing branch… · Download .patch · Delete (owner)
```

Deep link: `githappens://patch/{id}#k={key}` and web URL `https://{server}/p/{id}#k={key}` (web page shows minimal viewer if E2E key present client-side, plus "Open in GitHappens").

### 4.3 Code Suggest

```
PullRequestView (spec 10) header: [Suggest changes] (GitHub only in v1; provider-agnostic design)
→ enters SuggestModeBanner: "Suggesting changes on PR #42 — edit any file. [Discard] [Submit suggestion]"
   (implemented as an isolated worktree: edits never touch the user's main working tree)
SubmitSuggestionDialog: title, description, file list → Submit → posts PR comment + creates suggestion record

PullRequestView → SuggestionsBox: list of suggestions (author, title, status open/applied/dismissed)
SuggestionView: per-file diff with [Accept file] [Reject file]; footer: Apply to current branch · Apply to new branch · Commit & push to PR branch · Dismiss
```

### 4.4 Conflict Prevention & Team view

```
Toolbar (spec 01) branch crumb
└─ TargetIndicator: ◎ grey (no conflicts) | ◎ amber (conflicts with target) | ◎ red badge "2" (target + teammate overlaps)
   └─ ConflictPopover
       ├─ Target section: "feature/x conflicts with origin/main in 3 files" (file list, expandable hunks)
       │    Actions: Rebase onto main · Merge main in · Change target… · Stop detecting for this target
       ├─ Teammates section (org): "Ana is editing src/auth.ts (lines 40–58) on ana/refactor-auth"
       │    expanded: side-by-side line ranges; Actions: Share my changes as Cloud Patch · Push · Copy summary · Ignore (this file / this branch / 7 days)
       └─ Settings link (Preferences → Conflict Prevention)

LeftPanel → TEAM section (org, opt-in)
└─ Per workspace repo: teammates (avatar) → active branches → touched files (count), last activity
```

### 4.5 Insights

```
WorkspaceView header (spec 11) → [Insights]
InsightsView (center view)
├─ RangeSelect (7d/30d/90d) · RepoFilter · AuthorFilter (team mode)
├─ KPI tiles: PR cycle time (median, p75) · Time to first review · PRs merged/week · Deployment frequency* · Change failure rate* · MTTR*
├─ Charts: cycle-time trend (line), throughput (bars per week), review load per reviewer (bars), PR size distribution
└─ Footnote: data source and sampling ("Computed locally from 412 PRs via GitHub API")
```
`*` DORA metrics only when deployment signal configured (§6.6). Charts follow the dataviz rules (spec 13 tokens).

### 4.6 Organizations

Preferences → Organization: org name, members (invite by email, role admin/member), teams (create, add members), shared workspaces list, policies (patch max expiry, allow public links, footprint sharing default). No seats/billing UI.

---

## 5. Data model & IPC

### 5.1 Backend overview ("GitHappens Cloud")

- **Stack**: Node 20 + Fastify + TypeScript, PostgreSQL 16, S3-compatible object storage (MinIO for self-host), Redis optional (rate limits, presence). Single Docker image + `docker-compose.yml` for self-hosting. Lives in `/services/cloud` (new top-level folder; add to spec 00 layout).
- **Auth**: our own OIDC-ish token issuance. Desktop does Authorization Code + PKCE against `https://{server}/oauth/authorize` with loopback redirect (same AuthService machinery as spec 10). Server federates identity to GitHub/GitLab/Google OAuth or email magic link. Issues short-lived access JWT (15 min, EdDSA) + rotating refresh token (30 d, stored hashed). Desktop stores tokens in SecretStore (spec 13 §5.1) as `<profileId>/cloud/{serverUrl}/{userId}`.
- **API style**: REST JSON under `/v1`, cursor pagination, `ETag`/`If-Match` for optimistic concurrency, `429` with `Retry-After`.

### 5.2 Postgres schema (sketch)

```sql
create table users (id uuid primary key, email citext unique, name text, avatar_url text, created_at timestamptz default now(), deleted_at timestamptz);
create table identities (user_id uuid references users, provider text, subject text, host text, primary key (provider, host, subject));
create table refresh_tokens (id uuid primary key, user_id uuid references users, hash bytea, device_name text, expires_at timestamptz, rotated_from uuid, revoked_at timestamptz);
create table orgs (id uuid primary key, name text, slug text unique, created_by uuid references users, policies jsonb default '{}');
create table org_members (org_id uuid references orgs, user_id uuid references users, role text check (role in ('owner','admin','member')), primary key (org_id, user_id));
create table teams (id uuid primary key, org_id uuid references orgs, name text);
create table team_members (team_id uuid references teams, user_id uuid references users, primary key (team_id, user_id));
create table invites (id uuid primary key, org_id uuid, email citext, role text, token_hash bytea, expires_at timestamptz, accepted_at timestamptz);

create table sync_items (user_id uuid references users, category text, version bigint, ciphertext bytea, nonce bytea, updated_at timestamptz, device_id text, primary key (user_id, category));

create table workspaces (id uuid primary key, owner_user_id uuid, org_id uuid null, version bigint, doc jsonb, updated_at timestamptz);
create table workspace_shares (workspace_id uuid references workspaces, principal_type text, principal_id uuid, primary key (workspace_id, principal_type, principal_id));

create table repo_identities (id uuid primary key, org_id uuid null, provider text, host text, owner text, name text,
  initial_commit_sha text,                      -- `git rev-list --max-parents=0 HEAD` (first) to match forks/mirrors
  unique (provider, host, owner, name));

create table patches (id text primary key /* 22-char base62 */, author_id uuid, org_id uuid null, repo_identity_id uuid null,
  title text, description text, kind text check (kind in ('wip','commit','stash','suggestion')),
  base_sha text, base_branch text, files jsonb /* [{path, status, additions, deletions}] — omitted if e2e */,
  e2e boolean, blob_key text, blob_size int, sha256 text,
  visibility text check (visibility in ('link','org','collaborators')),
  expires_at timestamptz, created_at timestamptz default now(), deleted_at timestamptz);
create table patch_collaborators (patch_id text references patches, user_id uuid, primary key (patch_id, user_id));

create table suggestions (id uuid primary key, patch_id text references patches, provider text, host text, owner text, repo text,
  pr_number int, pr_head_sha text, comment_id text, status text default 'open', created_at timestamptz);

create table footprints (org_id uuid, user_id uuid, repo_identity_id uuid, branch_hash text, branch_label text null,
  base_ref text, head_sha text, files jsonb /* [{pathHash, path?, ranges:[[start,end]]}] */, updated_at timestamptz,
  primary key (org_id, user_id, repo_identity_id, branch_hash));
```

### 5.3 REST API sketch

```
Auth
  GET  /oauth/authorize?client_id=desktop&code_challenge=…&redirect_uri=http://127.0.0.1:PORT/cb&state=…&idp=github|gitlab|google|email
  POST /oauth/token            {grant_type: authorization_code|refresh_token, code, code_verifier, refresh_token}
  POST /oauth/revoke           {token}
  GET  /v1/me                  → {id, email, name, avatarUrl, orgs:[{id,name,role}]}
  DELETE /v1/me                → schedules account deletion (hard delete in 7 days)

Sync
  GET  /v1/sync                → [{category, version, updatedAt}]
  GET  /v1/sync/{category}     → {version, ciphertext(b64), nonce(b64)}
  PUT  /v1/sync/{category}     If-Match: <version>   {ciphertext, nonce, deviceId} → 200 {version} | 412 (conflict)

Workspaces (spec 11 cloud kind)
  GET/POST /v1/workspaces · GET/PUT/DELETE /v1/workspaces/{id} (If-Match) · PUT /v1/workspaces/{id}/shares
Launchpad state
  GET/PUT /v1/launchpad/state  (itemStates, savedViews; If-Match)

Orgs
  POST /v1/orgs · GET /v1/orgs/{id} · POST /v1/orgs/{id}/invites · POST /v1/invites/{token}/accept
  GET/POST /v1/orgs/{id}/teams · PUT /v1/orgs/{id}/teams/{tid}/members · PATCH /v1/orgs/{id}/policies

Patches
  POST /v1/patches             {title, description, kind, repo:{provider,host,owner,name,initialCommitSha}, baseSha, baseBranch,
                                files?, e2e, size, sha256, visibility, collaborators?, expiresAt}
                               → {id, uploadUrl (presigned PUT, 15 min), webUrl}
  POST /v1/patches/{id}/complete              (server verifies size/sha256 of uploaded blob)
  GET  /v1/patches?scope=mine|shared&repo=…    → list
  GET  /v1/patches/{id}        → metadata + downloadUrl (presigned GET, 5 min) — authz by visibility
  PATCH /v1/patches/{id}       {title, visibility, collaborators, expiresAt}
  DELETE /v1/patches/{id}

Suggestions (Code Suggest)
  POST /v1/suggestions         {patchId, provider, host, owner, repo, prNumber, prHeadSha} → {id, webUrl, deepLink}
  GET  /v1/suggestions?provider=&owner=&repo=&pr=   → list (authz: user must prove repo access, §6.4)
  PATCH /v1/suggestions/{id}   {status: applied|dismissed}

Team footprints (opt-in)
  PUT  /v1/orgs/{org}/footprints              {repoIdentity, branchHash, branchLabel?, baseRef, headSha, files:[{pathHash, path?, ranges}]}
  DELETE /v1/orgs/{org}/footprints/{repoIdentityId}/{branchHash}
  GET  /v1/orgs/{org}/footprints?repo={repoIdentityId}&since=…   → others' footprints (excludes caller)
  GET  /v1/orgs/{org}/team?workspace={id}     → team view aggregation
```

### 5.4 Desktop types & IPC

```ts
export interface CloudSession { serverUrl: string; user: { id: string; email: string; name: string; avatarUrl?: string }; orgs: Array<{ id: string; name: string; role: 'owner' | 'admin' | 'member' }>; activeOrgId?: string }
export type SyncCategory = 'preferences' | 'keybindings' | 'themes' | 'workspaces-local' | 'launchpad' | 'integrations-list' | 'profiles';
export interface SyncStatus { enabled: Record<SyncCategory, boolean>; lastSyncAt?: string; state: 'idle' | 'syncing' | 'error' | 'locked'; error?: string; conflicts: SyncCategory[] }

export interface CloudPatchMeta {
  id: string; title: string; description?: string; kind: 'wip' | 'commit' | 'stash' | 'suggestion';
  author: { id: string; name: string; avatarUrl?: string }; createdAt: string; expiresAt?: string;
  repo?: { provider: string; host: string; owner: string; name: string; initialCommitSha?: string };
  baseSha: string; baseBranch?: string; e2e: boolean; visibility: 'link' | 'org' | 'collaborators';
  files?: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R'; additions: number; deletions: number }>;
  webUrl: string; deepLink: string;
}
export interface PatchBundle {                         // encrypted/uploaded payload (JSON then gzip)
  format: 'githappens-patch/1'; baseSha: string; baseBranch?: string; createdWith: string;
  patch: string;                                       // `git diff --binary` output
  files: CloudPatchMeta['files']; title: string; description?: string;
}
export interface ConflictReport {
  repoId: string; branch: string; target: string; checkedAt: string;
  targetConflicts: Array<{ path: string; hunks?: Array<{ ours: [number, number]; theirs: [number, number] }> }>;
  teammateOverlaps: Array<{ user: { id: string; name: string; avatarUrl?: string }; branchLabel?: string; path: string; myRanges: [number, number][]; theirRanges: [number, number][]; updatedAt: string }>;
}
export interface InsightsQuery { workspaceId: string; range: '7d' | '30d' | '90d'; repos?: string[]; authors?: string[] }
export interface InsightsResult { prCycleTimeHrs: { median: number; p75: number }; timeToFirstReviewHrs: { median: number }; mergedPerWeek: Array<{ week: string; count: number }>;
  prSize: { p50: number; p90: number }; reviewLoad: Array<{ reviewer: string; count: number }>;
  dora?: { deploymentsPerWeek: number; leadTimeHrs: number; changeFailureRate: number; mttrHrs: number }; sampleSize: number; source: string }
```

| Channel | Payload → Result |
|---|---|
| `cloud:signIn` | `{ serverUrl, idp } → CloudSession` (browser + loopback, PKCE) |
| `cloud:signOut` / `cloud:session` | |
| `cloud:setActiveOrg` | `{ orgId }` |
| `sync:status` / `sync:setEnabled` / `sync:now` / `sync:resolveConflict` | `{ category, keep: 'local' \| 'remote' }` |
| `sync:setupPassphrase` / `sync:unlock` / `sync:exportRecoveryKey` | E2E key management |
| `patch:create` | `{ repoId, source: { kind: 'wip', stagedOnly: boolean, paths?: string[] } \| { kind: 'commit', sha } \| { kind: 'stash', ref }, title, description?, visibility, collaborators?, expiresInDays?, e2e } → CloudPatchMeta` |
| `patch:list` / `patch:get` / `patch:update` / `patch:delete` | |
| `patch:open` | `{ url } → { meta, bundle, localMatch: { repoId?, baseAvailable: boolean } }` |
| `patch:apply` | `{ patchId, repoId, target: { kind: 'worktree' } \| { kind: 'new-branch', name, base? } \| { kind: 'existing-branch', name }, threeWay: boolean } → { applied: boolean; conflicts: string[] }` |
| `suggest:start` | `{ repoId, pr: RepoRef & { number } } → { sessionId, worktreePath }` |
| `suggest:submit` / `suggest:discard` / `suggest:list` / `suggest:apply` | |
| `conflicts:check` | `{ repoId, branch?, target? } → ConflictReport` |
| `conflicts:ignore` | `{ repoId, scope: 'file' \| 'branch' \| 'target', value, until? }` |
| `team:footprintsEnabled` | `{ orgId, repoIdentityId, enabled }` |
| `team:view` | `{ workspaceId } → TeamView` |
| `insights:compute` | `InsightsQuery → InsightsResult` (progress events `insights:progress`) |
| `org:*` | members, invites, teams, policies |

Events: `cloud:sessionChanged`, `sync:statusChanged`, `conflicts:updated { repoId, report }`, `patch:opened` (deep link).

---

## 6. Implementation details

### 6.1 Sign-in

Reuse spec 10 AuthService loopback+PKCE flow with a `cloud` provider. Deep link `githappens://` also handles `patch/` and `suggestion/` routes (single protocol handler router in main). Session refresh single-flight. Sign-in with GitHub at the cloud server does **not** give the desktop GitHub API access; after sign-in we offer "Also connect GitHub integration" (separate OAuth with repo scopes) — keeps tokens off our server.

### 6.2 Settings sync (end-to-end encrypted)

1. On enabling sync, the user creates a **sync passphrase** (or we generate a 24-word recovery key). Derive `KEK = Argon2id(passphrase, salt=userId, m=64MB, t=3)`; generate random 256-bit `DEK`; store `wrap(DEK, KEK)` as sync category `_keys` (ciphertext) on server; cache `DEK` in keytar.
2. Each category is serialized (canonical JSON, excluding paths and secrets: strip `localPath`, tokens, SSH key paths, terminal env), gzipped, encrypted with XChaCha20-Poly1305 (libsodium) with random nonce, uploaded with `If-Match: version`.
3. Pull on startup, on focus (≥ 5 min since last), and every 15 min; push debounced 10 s after local change.
4. Conflict (412): for mergeable categories (keybindings, launchpad item states) do a 3-way JSON merge keyed by id with last-writer-wins per key using `updatedAt`; for preferences, per-key LWW; unresolved → `conflicts` list → UI asks keep local/remote.
5. Lost passphrase → "Reset sync data" deletes server categories and re-uploads from this device.

Server sees only ciphertext, category names, sizes and timestamps.

### 6.3 Cloud Patches

Create:
1. Build patch text in main process (GitService):
   - WIP staged: `git diff --cached --binary --full-index --no-color --no-ext-diff`
   - WIP all: `git diff --binary --full-index HEAD` + untracked files via `git add -N` on a temporary index (`GIT_INDEX_FILE=tmp; git read-tree HEAD; git add -A -- <paths>; git diff --cached --binary`) — never touches the user's real index.
   - Commit: `git format-patch -1 --stdout --binary {sha}` (preserves message/author).
   - Stash: `git stash show -p --binary --include-untracked {ref}` (git ≥ 2.32 for `--include-untracked`).
   - `baseSha` = `HEAD` (WIP) / `{sha}^` (commit) / `{stash}^1` (stash).
2. Size check: refuse > 25 MB compressed (configurable server limit); warn on binaries > 1 MB.
3. If `e2e`: random 256-bit key → encrypt gzipped `PatchBundle` with XChaCha20-Poly1305; key encoded base64url in URL fragment `#k=` (never sent to the server). Metadata `files` omitted (server only stores title if user agrees; title can also be encrypted inside the bundle — default: title stored in plaintext only for non-e2e).
4. `POST /v1/patches` → presigned upload → `PUT` blob → `POST …/complete`.
5. Add to local "Created by me" cache; toast with Copy link.

Open/apply:
1. Deep link or pasted URL → `patch:open` → GET metadata (auth if visibility ≠ link) → download blob → decrypt with fragment key → verify sha256.
2. Match local repo: open repos whose remotes match `repo` identity or whose root commit equals `initialCommitSha` (`git rev-list --max-parents=0 HEAD`). If none, prompt to pick/clone.
3. Check base: `git cat-file -e {baseSha}^{commit}`; if missing, `git fetch --all` then retry; still missing → allow 3-way apply attempt with warning.
4. Apply via OperationQueue (journal entry for undo, spec 05):
   - Worktree: `git apply --3way --whitespace=nowarn --binary {file}` (3-way requires blobs in object db; fallback `git apply --reject` → `.rej` files reported).
   - New branch: `git switch -c {name} {baseSha}` then apply (+ optional commit with patch title).
   - Existing branch: requires clean worktree or autostash.
   - Commit kind: `git am --3way` on new branch preserves authorship.
5. Conflicts → open conflict UI (spec 08) for files with markers.

Visibility enforcement on server: `link` → anyone with id (id has 128 bits entropy); `org` → requester member of `org_id`; `collaborators` → in `patch_collaborators` or author. Expiry job deletes blobs daily.

### 6.4 Code Suggest

Built from Cloud Patches + provider comments (spec 10):
1. `suggest:start`: fetch PR head (spec 10 §6.3), create **isolated worktree** `git worktree add --detach {userData}/suggest/{id} {headSha}`; open its files in the in-app editor (spec 07) with a "Suggest mode" banner. The user's main checkout is untouched.
2. Submit: `git -C {wt} add -A && git -C {wt} diff --cached --binary {headSha}` → patch (kind `suggestion`, visibility `collaborators` = PR participants who have accounts, or `link` with E2E key when participants aren't on our server).
3. `POST /v1/suggestions` with PR coords. The server does **not** verify repo access (that would require sending provider tokens, which we never do); it stores the suggestion record, and read access is governed solely by the underlying patch's visibility — possession of the link is the capability.
4. Desktop posts a PR comment through ProviderService: "💡 Code suggestion: {title} — {n} files. Open in GitHappens: {deepLink} · View: {webUrl}" and, if allowed, adds label `code-suggestion` (GitHub; created if missing with user confirmation).
5. Author side: PullRequestView fetches suggestions by scanning PR comments for our link pattern (works even without server listing) → SuggestionView → per-file accept/reject (build filtered patch with `git apply --include={path}`) → Apply to current branch / new branch / **Commit & push to PR branch** (apply on PR head branch locally, commit "Apply code suggestion: {title}" with `Co-authored-by: {suggester}` trailer, push via spec 09).
6. Clean up worktree on submit/discard (`git worktree remove --force`).

Provider-agnostic: comment posting uses `addComment`, so GitLab/Bitbucket/Azure work too, not only github.com.

### 6.5 Conflict Prevention

**Target branch check (no backend)**:
1. Target resolution: per branch setting → PR base from PrIndex (spec 10) → `branch.<name>.githappens-target` config → repo default branch (`git symbolic-ref refs/remotes/origin/HEAD`) → `main`/`master`/`develop` heuristics.
2. Run after each fetch (spec 09) and on commit to the branch (debounced 30 s), in background, low priority, read-only:
   `git merge-tree --write-tree --name-only --no-messages {target} {HEAD}` (git ≥ 2.38). Exit 1 → conflicts; output after tree oid lists conflicted paths. For hunk ranges (expanded view) run `git merge-tree --write-tree {target} HEAD` and parse conflict markers from the resulting tree's blobs (`git cat-file -p {tree}:{path}`) — only on demand.
   Also include **WIP**: optional mode that writes a temp tree of the working directory (`GIT_INDEX_FILE` temp + `git add -A` + `git write-tree` + `git commit-tree`) and checks that commit.
3. Cache by `(headSha, targetSha)`; result in `conflicts:updated` event → TargetIndicator.
4. Actions route to spec 05 rebase/merge ops.

**Teammate overlap (backend, opt-in per org & repo)**:
1. Footprint computation (client): for each local branch with unpushed or unmerged work (ahead of target), `git diff --unified=0 --no-color {merge-base(target,branch)} {branch}` → per file list of changed line ranges in the **base** file coordinates (from `@@ -a,b +c,d @@` use `a..a+b`), plus WIP diff for current branch. Limit 500 files/branch.
2. Privacy shaping before upload (org policy):
   - `pathHash = HMAC-SHA256(orgSalt, repoIdentity + ':' + path)`; plaintext `path` only if org policy `sharePaths=true` (default **false**; then UI shows path only to members who also have that file — they compute the same HMAC locally to resolve names).
   - Branch name sent as `branchHash` + optional label (policy).
   - No file contents, ever.
3. `PUT /v1/orgs/{org}/footprints` on change (debounced 2 min) and delete on branch merge/delete.
4. Overlap detection (client): `GET …/footprints?repo=` every 5 min while repo is open; intersect pathHashes with own footprints; overlap if line ranges intersect within ±3 lines (or any change to the same file if ranges missing). Results merged into ConflictReport.
5. "Copy summary" generates markdown: who, file, ranges, branches; "Share as Cloud Patch" → §6.3 with collaborators = teammate.

**Team view**: aggregation endpoint returns per repo: members with active footprints, branch labels (if shared), file counts, last activity. Rendered in TEAM section.

### 6.6 Insights (backend-free v1)

Computed locally from provider APIs (spec 10) for workspace repos:
- Fetch merged/closed PRs in range: GitHub GraphQL `search(query:"repo:o/r is:pr is:merged merged:>=2026-07-01", first:100)` with `createdAt mergedAt additions deletions reviews(first:1){nodes{submittedAt}} author{login}`; GitLab `GET /merge_requests?state=merged&updated_after=`; Bitbucket `state=MERGED`; Azure `searchCriteria.status=completed&minTime=`.
- Metrics: cycle time = mergedAt − createdAt (or first commit time when available); time to first review = first non-author review/comment − createdAt (ready-for-review time for drafts); throughput per ISO week; PR size = additions + deletions; review load = reviews per reviewer.
- DORA (optional, configured per workspace): deployment signal = GitHub Deployments API (`GET /repos/{o}/{r}/deployments?environment=production` + statuses), or tags matching a pattern (`git for-each-ref refs/tags --format='%(refname:short) %(creatordate:iso-strict)'`), or pipeline runs on default branch. Lead time = deploy time − commit time of included commits (`git rev-list prevTag..tag`); change failure rate = deployments followed by revert/hotfix (heuristic: commits matching `^Revert|hotfix` within 24 h) or failed deployment statuses; MTTR = failure → next successful deploy.
- Cache results per (repo, range) for 6 h in `userData/cache/insights/`. Rate-limit aware (spec 10).
- Later (org): server-side scheduled computation using a GitHub App installation — out of scope.

### 6.7 Organizations & seats

Minimal: create org, invite by email (magic-link invite token, 7-day expiry), roles owner/admin/member, teams, policies JSON. Sharing primitives (workspaces, patches, footprints) check membership. **Skip**: seats, licensing, billing, SSO/SAML/SCIM (later if ever; would use `node-saml`/`openid-client`).

### 6.8 Privacy & security requirements

- Every cloud feature off by default; first use shows a disclosure listing exactly what is uploaded.
- Never upload provider tokens, SSH keys, file contents (except inside explicitly shared patches), absolute local paths, or repo contents for Insights (computed locally).
- E2E encryption for sync (always) and patches (default for public links). Server-side encryption at rest for blobs (SSE) regardless.
- Data retention: patches expire (default 30 d), footprints TTL 14 d after last update, deleted accounts purged within 7 d incl. blobs; `GET /v1/me/export` for data export (GDPR).
- Self-hosting: `serverUrl` configurable; desktop pins nothing to our domain; TLS required (except `localhost` dev).
- Server security: rate limits per IP/user, presigned URLs short TTL, patch ids 128-bit random, audit log of share/visibility changes, no request-body logging, CSP on web viewer, link fragment keys never reach server logs.
- Telemetry: none in this spec.

---

## 7. Step-by-step implementation plan

**Track A — backend-free (can land before Phase 6):**
1. Conflict Prevention target check: target resolution, `merge-tree` runner, cache, TargetIndicator + popover, ignore rules, actions → spec 05. Tests with fixture repos (clean, conflicting, rename/delete conflicts, binary).
2. Insights v1: provider queries, metric calculators (pure, unit-tested with fixed fixtures), InsightsView charts, caching.

**Track B — backend:**
3. Scaffold `/services/cloud` (Fastify, Postgres migrations via `node-pg-migrate`, MinIO, docker-compose, OpenAPI spec generation, health checks).
4. Auth server: OAuth authorize/token/revoke with PKCE, IdP federation (GitHub, GitLab, Google, email magic link), JWT signing keys rotation, refresh-token rotation with reuse detection.
5. Desktop `cloud` sign-in via AuthService; AccountButton/menu; Preferences → Account; deep-link router.
6. Sync: libsodium (`sodium-native` in main), key setup/unlock/recovery, category serializers, push/pull scheduler, conflict merge, UI.
7. Cloud workspaces + Launchpad state sync endpoints (spec 11 §6.6 hooks).
8. Orgs: create/invite/accept/teams/policies API + Preferences → Organization UI; share cloud workspaces with teams.
9. Cloud Patches API + blob storage + expiry job; desktop create (WIP/commit/stash), CLOUD PATCHES section, CloudPatchView, apply flows with 3-way and undo journal; minimal web viewer page (static, decrypts in browser).
10. Code Suggest: isolated worktree session, submit (patch + PR comment), detection from PR comments, SuggestionView per-file apply, commit & push.
11. Footprints: client computation + HMAC shaping, API, polling, overlap intersection, ConflictPopover teammates section, TEAM section.
12. Hardening: load tests (1k patches/min), security review, data export/delete, self-host docs.

---

## 8. Edge cases

- Signed in on two machines with different passphrases → second machine can't unlock → "Enter sync passphrase" prompt; wrong passphrase errors don't wipe data.
- Sync category schema version newer than this app → skip category with "Update the app to sync X".
- Patch base commit not present locally and not fetchable (private fork) → 3-way fails → offer apply with `--reject` or apply on a new orphan-free branch from nearest common commit (best effort).
- Patch with renames/mode changes/binary/LFS pointers → `--binary --full-index` preserves binaries; LFS files transported as pointers only (warn: recipient needs LFS objects pushed).
- Patch containing submodule pointer changes → included as gitlink changes; warning.
- CRLF/autocrlf differences between sender and recipient → `git apply --ignore-whitespace` retry option.
- Huge WIP (> 25 MB) → refuse with suggestion to push a branch.
- Recipient opens link without the fragment (key stripped by chat app) → "This patch is encrypted; ask for the full link".
- Expired/deleted patch → 410 Gone page.
- Code Suggest on PR from a fork where reviewer lacks push access → "Commit & push" hidden for reviewer; author applies.
- PR head moved after suggestion → SuggestionView shows "Based on older head abc123"; 3-way apply.
- Conflict check on very large repos → `merge-tree` can be slow; time box 20 s, run at idle priority (`nice` on Unix / lower priority class on Windows), skip on battery saver (setting).
- Target branch missing locally (`origin/main` not fetched) → indicator grey with "Target not available — fetch".
- Detached HEAD / unborn branch / bare repo → indicator hidden.
- Footprint false positives from formatting-only changes → ignore whitespace-only hunks (`--ignore-space-change` in footprint diff, setting).
- Teammate left org → footprints deleted by server on membership removal.
- Server unreachable → all cloud UI degrades to cached data with banner; local features unaffected.
- Self-signed self-hosted server → certificate trust prompt (same mechanism as spec 10 GHE).
- Insights on repos with 10k+ PRs in range → sample cap 2,000 with explicit "sampled" note.

---

## 9. Acceptance criteria

- [ ] App runs with zero cloud configuration; no network calls to any GitHappens server unless the user configures/signs in.
- [ ] Sign-in via system browser (GitHub/GitLab/Google/email) to a self-hosted server via docker-compose works on all OSes; sign-out revokes refresh token.
- [ ] Sync round-trips preferences, keybindings, themes, workspaces (without paths) and Launchpad state between two machines; server DB contains only ciphertext for sync categories (verified by test).
- [ ] Conflict between two devices resolves automatically for keyed categories, prompts otherwise.
- [ ] Cloud Patch from staged WIP, full WIP (incl. untracked), commit and stash can be created, linked, opened on another machine and applied to working tree / new branch / existing branch; binary files preserved; undo journal entry created.
- [ ] E2E patches are unreadable server-side; link without fragment cannot be decrypted.
- [ ] Visibility rules enforced (link / org / collaborators) by API tests.
- [ ] Code Suggest: reviewer edits a file outside the PR diff in an isolated worktree, submits; PR receives a comment with links; author applies per-file and commit & pushes with co-author trailer. User's main worktree untouched throughout.
- [ ] Target-branch conflict indicator correctly flags fixture conflicts within 5 s after fetch, and actions rebase/merge work.
- [ ] With footprints enabled in an org, two users editing overlapping ranges of the same file on different branches both see warnings within 5 min; no file contents or plaintext paths (with default policy) stored on server.
- [ ] Insights shows cycle time, time to first review, throughput, PR size and review load for a GitHub workspace computed locally; DORA tiles appear when a deployment signal is configured.
- [ ] Org invite/accept, teams, and sharing a cloud workspace with a team work end-to-end.
- [ ] Account deletion removes all user data including blobs within 7 days (job tested).

---

## 10. Out of scope / later

- Seats, licensing, billing, plan gating — skipped entirely (our app has no paid tiers by default).
- Enterprise SSO (SAML/OIDC org login), SCIM provisioning, audit-log export.
- Real-time collaboration (presence, live co-editing) and comments threads on patches (P3 maybe).
- Server-side Insights via GitHub App installations, scheduled reports, cross-org benchmarks.
- AI features on the server (AI lives in spec 12, BYO key, client-side).
- Mobile/web full client (only the minimal patch viewer page).
- Syncing provider tokens or SSH keys between machines — never.
