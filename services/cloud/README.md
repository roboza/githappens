# @githappens/cloud — GitHappens Cloud

The optional, self-hostable backend for GitHappens's cloud and team features (spec 14): sign-in,
end-to-end encrypted settings sync, cloud workspaces and Launchpad state, Cloud Patches, minimal
organizations/teams/invites, and team footprints for conflict prevention. The desktop app works
fully without it.

- Runtime: Node ≥ 22.18 runs the TypeScript sources directly (type stripping), `node:http`, no web
  framework. The only npm dependency is `pg`.
- Storage: Postgres 16 (`GH_CLOUD_DATABASE_URL`) or an in-memory store for development; patch blobs
  on the filesystem (`GH_CLOUD_BLOB_DIR`), encrypted at rest.
- The REST contract is `packages/cloud-api/src/types.ts`; patch blobs are produced client-side by
  `sealPatchBundle()` in `packages/cloud-api/src/patch-crypto.ts`. The server never decrypts them.

## Run locally

```sh
pnpm install
pnpm --filter @githappens/cloud dev      # = node src/index.ts --dev
```

`--dev` turns on the **dev identity provider** (any email signs in immediately, no password) and the
`log` mail transport (magic links are printed to stdout). Without `GH_CLOUD_DATABASE_URL` the server
uses the in-memory store and prints a loud warning; everything is lost on restart. Keys are
generated once and kept in `./data` (git-ignored).

Point GitHappens (Preferences → Account → server URL) at `http://localhost:8787` and choose
"Development sign-in".

With Postgres:

```sh
docker run -d --name kl-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine
GH_CLOUD_DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres pnpm --filter @githappens/cloud dev
```

Migrations in `migrations/*.sql` are applied in order at startup (tracked in `schema_migrations`,
guarded by an advisory lock so several instances can start at once).

### Automating the dev sign-in (e2e tests)

1. Desktop opens `GET /oauth/authorize?response_type=code&client_id=desktop&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=<S256>&code_challenge_method=S256&state=<s>&idp=dev`.
2. The page contains a form with a hidden `areq` field; `POST /oauth/dev` with
   `application/x-www-form-urlencoded` `areq=<value>&email=<email>[&name=<display name>]`.
3. The server answers `302` to `redirect_uri?code=…&state=…`; the desktop exchanges the code at
   `POST /oauth/token` as usual.

## Self-hosting with Docker Compose

```sh
cd services/cloud
cp .env.example .env        # set GH_DB_PASSWORD, GH_CLOUD_PUBLIC_URL and at least one IdP
docker compose up -d --build
docker compose logs -f cloud
```

The compose file runs `postgres:16-alpine` and this server, with named volumes for the database
and for `/data` (blobs, generated keys). The image is built from the repository root (it needs
`packages/cloud-api`): `docker build -f services/cloud/Dockerfile -t githappens-cloud .`.

**TLS is required in production.** The server speaks plain HTTP; terminate TLS in a reverse proxy
(Caddy, nginx, Traefik) and set `GH_CLOUD_PUBLIC_URL=https://…` (this also enables HSTS and
`Secure` cookies). Behind a proxy set `GH_CLOUD_TRUST_PROXY=true` so rate limits see client IPs.
Plain `http://` is only acceptable for `localhost`; the web patch viewer's WebCrypto decryption
also only works in a secure context. The server logs a warning when the public URL is `http://`
on a non-loopback host.

Register these OAuth callback URLs with the identity providers you enable:
`<GH_CLOUD_PUBLIC_URL>/oauth/callback/github`, `…/gitlab`, `…/google`. Requested scopes are
identity-only (`read:user user:email`, `read_user`, `openid email profile`); upstream tokens are
discarded after sign-in and never reach the desktop app.

### Keys and backups

- Access tokens are Ed25519 JWTs (`kid` = hash of the public key). Set `GH_CLOUD_JWT_KEY` (PKCS#8
  PEM) or let the server generate `jwt-ed25519.pem` in the data dir. To rotate, move the old public
  key to `GH_CLOUD_JWT_PREVIOUS_KEYS` for 15 minutes (one access-token lifetime).
- `GH_CLOUD_SECRET` (or the generated `server-secret` file) signs upload/download/sign-in tokens
  and derives the blob encryption key. **Losing it makes stored patch blobs unreadable.** Back up
  the data volume (or set both values via env) together with the database.
- Multiple instances must share the database, the blob directory, `GH_CLOUD_JWT_KEY` and
  `GH_CLOUD_SECRET`. Rate limits are per instance.

## Configuration

| Variable                                                                     | Default                     | Meaning                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GH_CLOUD_PORT` (or `PORT`)                                                  | `8787`                      | Listen port                                                                                                                                                                                                                                                                     |
| `GH_CLOUD_HOST`                                                              | `0.0.0.0`                   | Listen address                                                                                                                                                                                                                                                                  |
| `GH_CLOUD_PUBLIC_URL`                                                        | `http://localhost:<port>`   | Origin used for every absolute URL (upload/download/web/invite links, JWT issuer). No path.                                                                                                                                                                                     |
| `GH_CLOUD_DATABASE_URL`                                                      | —                           | `postgres://…`; absent → in-memory store (development only, loud warning)                                                                                                                                                                                                       |
| `GH_CLOUD_DATA_DIR`                                                          | `./data`                    | Generated keys live here                                                                                                                                                                                                                                                        |
| `GH_CLOUD_BLOB_DIR`                                                          | `<data dir>/blobs`          | Patch blobs (AES-256-GCM at rest)                                                                                                                                                                                                                                               |
| `GH_CLOUD_JWT_KEY`                                                           | generated                   | Ed25519 PKCS#8 PEM private key (`\n` escapes allowed)                                                                                                                                                                                                                           |
| `GH_CLOUD_JWT_PREVIOUS_KEYS`                                                 | —                           | Old PEM public keys still accepted (rotation)                                                                                                                                                                                                                                   |
| `GH_CLOUD_SECRET`                                                            | generated                   | ≥ 32 chars; HMAC tokens + blob encryption key                                                                                                                                                                                                                                   |
| `GH_CLOUD_GITHUB_CLIENT_ID` / `_SECRET`                                      | —                           | Enables "Continue with GitHub"                                                                                                                                                                                                                                                  |
| `GH_CLOUD_GITLAB_CLIENT_ID` / `_SECRET`                                      | —                           | Enables "Continue with GitLab"                                                                                                                                                                                                                                                  |
| `GH_CLOUD_GITLAB_URL`                                                        | `https://gitlab.com`        | GitLab instance for federation                                                                                                                                                                                                                                                  |
| `GH_CLOUD_GOOGLE_CLIENT_ID` / `_SECRET`                                      | —                           | Enables "Continue with Google"                                                                                                                                                                                                                                                  |
| `GH_CLOUD_MAIL_TRANSPORT`                                                    | `none` (`log` with `--dev`) | `none` disables email links; `log` prints links to stdout (dev only); `webhook` POSTs JSON `{kind, to, subject, text, link}` to `GH_CLOUD_MAIL_WEBHOOK`                                                                                                                         |
| `GH_CLOUD_MAIL_WEBHOOK`                                                      | —                           | Required for `webhook`                                                                                                                                                                                                                                                          |
| `GH_CLOUD_DEV_LOGIN`                                                         | `false`                     | Dev IdP: any email signs in. **Never in production.**                                                                                                                                                                                                                           |
| `GH_CLOUD_PATCH_MAX_BYTES`                                                   | `26214400` (25 MB)          | Max patch blob size (413 above)                                                                                                                                                                                                                                                 |
| `GH_CLOUD_PATCH_MAX_EXPIRY_DAYS`                                             | unset (no cap)              | Server-wide cap on patch expiry                                                                                                                                                                                                                                                 |
| `GH_CLOUD_SYNC_MAX_BYTES`                                                    | `1048576`                   | Max sync item ciphertext                                                                                                                                                                                                                                                        |
| `GH_CLOUD_MAX_BODY_BYTES`                                                    | `2097152`                   | Max JSON request body                                                                                                                                                                                                                                                           |
| `GH_CLOUD_RATE_IP_PER_MIN`                                                   | `600`                       | Requests per minute per client IP (burst = same)                                                                                                                                                                                                                                |
| `GH_CLOUD_RATE_USER_PER_MIN`                                                 | `1200`                      | Requests per minute per signed-in user                                                                                                                                                                                                                                          |
| `GH_CLOUD_RATE_AUTH_PER_MIN`                                                 | `30`                        | `POST /oauth/*` per minute per IP (token, magic link, dev)                                                                                                                                                                                                                      |
| `GH_CLOUD_TRUST_PROXY`                                                       | `false`                     | Take the client IP from the last `X-Forwarded-For` hop                                                                                                                                                                                                                          |
| `GH_CLOUD_JOB_INTERVAL_SEC`                                                  | `3600`                      | Maintenance job interval (`0` = off)                                                                                                                                                                                                                                            |
| `GH_CLOUD_S3_ENDPOINT` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | —                           | S3-compatible blob storage (AWS S3, MinIO, R2…) instead of `GH_CLOUD_BLOB_DIR`; all four together                                                                                                                                                                               |
| `GH_CLOUD_S3_REGION` / `_SESSION_TOKEN`                                      | `us-east-1` / —             | SigV4 signing region, optional STS token                                                                                                                                                                                                                                        |
| `GH_CLOUD_S3_FORCE_PATH_STYLE`                                               | `true`                      | `<endpoint>/<bucket>/<key>` (MinIO); `false` = virtual-hosted buckets                                                                                                                                                                                                           |
| `GH_CLOUD_S3_PREFIX`                                                         | `patches/`                  | Object key prefix                                                                                                                                                                                                                                                               |
| `GH_CLOUD_S3_DIRECT`                                                         | `false`                     | Hand clients presigned bucket URLs (upload/download bypass the server). Blobs are then stored as uploaded: enable default bucket encryption and a CORS rule for `GET` from `GH_CLOUD_PUBLIC_URL` (web viewer). Otherwise the server proxies and encrypts at rest (AES-256-GCM). |

At least one identity provider must be configured. Invalid configuration exits with code 78
(`EX_CONFIG`) and lists every problem.

## API

Implemented exactly as `packages/cloud-api/src/types.ts` describes: `/oauth/authorize`,
`/oauth/token`, `/oauth/revoke`, `/.well-known/githappens-cloud`, `/healthz`, and all `/v1` routes
(account, sync, workspaces + shares, Launchpad state, orgs/members/invites/teams/policies, patches,
footprints, repo identities, team view), plus the public pages `/p/:id` (patch viewer) and
`/invite/:token`, and the presigned blob URLs `/v1/blobs/<token>`.

### Contract notes (clarifications chosen by this server)

- **`/oauth/token` errors** follow RFC 6749 §5.2: HTTP 400 `{ error: 'invalid_grant' |
'invalid_request' | 'unsupported_grant_type' | 'invalid_client', error_description, message }`
  (`message` mirrors the description for ApiError-style clients). A failed refresh means "sign in
  again". Rate limiting is still 429 `rate_limited`. `/oauth/token` and `/oauth/revoke` accept JSON
  or form bodies.
- **Status codes for creates** are `201` (`POST /v1/orgs`, `/v1/workspaces`, `/v1/patches`,
  invites, teams); other successes are `200`, deletes `204`, `DELETE /v1/me` `202`.
- **`If-Match`** is optional everywhere: absent = unconditional write. Accepted forms: `3`, `"3"`,
  `W/"3"`. Responses carry `ETag: "<version>"`. A `PUT /v1/workspaces/:id/shares` also bumps the
  workspace version.
- **Workspaces**: `GET /v1/workspaces` lists own workspaces plus those shared with the caller
  (as a user, team member or org member); org admins can additionally open any workspace of their
  org by id. Only the owner or an org admin can edit, share or delete
  (shared users are read-only). Share principals must belong to the workspace's org (personal
  workspaces: to an org the caller is in). `localPath`/`localPaths` keys are stripped from docs.
- **Patches**: org policies apply to patches created with that `orgId`; an expiry beyond
  `patchMaxExpiryDays` (or none) is clamped to the cap, not rejected. `collaborators` must be org
  members and are kept only for `visibility: 'collaborators'`. A non-empty `files` list with
  `e2e: true` is rejected (422). `GET /v1/patches` defaults to `scope=mine`; `shared` excludes the
  caller's own patches. Expired/deleted/incomplete patches answer 410 until the purge job removes
  them (≤ `GH_CLOUD_JOB_INTERVAL_SEC`), then 404. Blob tokens are HMAC-signed `{patchId, op, exp}`;
  an invalid/expired one is 403; a successful upload answers 200 `{}`. Pending uploads that are
  never completed are purged after 24 h. Patch authors are shown without email.
- **Orgs**: the last owner cannot be demoted or leave (409); only owners grant/revoke the owner
  role, remove owners, invite owners or delete the org. Accepting an invite as an existing member
  is a no-op 200; used/expired invites are 410. Deleting an org deletes its workspaces, teams,
  invites, footprints and repo identities and makes its patches 410.
- **Footprints**: `GET …/footprints` `repo` is optional (all repos when absent). Plaintext `path`
  and `branchLabel` are silently dropped unless the org policy allows them. Footprints are hidden
  14 days after their last update and deleted by the job.
- **Accounts**: `DELETE /v1/me` takes effect immediately (tokens revoked, patches 410, footprints
  deleted); everything else including blobs is hard-deleted after 7 days. Orgs where the user was
  the last owner pass to the longest-standing admin/member, or are deleted when empty. Signing in
  to an account pending deletion is refused. `GET /v1/me/export` additionally includes
  `launchpadState`.
- **Identity linking**: a federated sign-in with a verified email that matches an existing
  account is linked to it; GitHub/GitLab/Google accounts without a verified email are refused.

## Security

- Access tokens: EdDSA JWT, 15 min. Refresh tokens: opaque 256-bit, stored as SHA-256, 30 days,
  rotated on every use; presenting an already-rotated token revokes the whole token family.
- Authorization codes are single-use, 5 minutes, bound to the PKCE S256 challenge and the exact
  loopback `redirect_uri` (`http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`).
- Federation state is HMAC-signed, single-use, and bound to the browser with an HttpOnly cookie.
  Magic links are single-use and expire after 15 minutes.
- Rate limits per IP, per user and (stricter) for sign-in endpoints; request size limits for JSON
  bodies and blob uploads; strict input validation on every field the server reads.
- Logs are structured JSON with a field allowlist: route _patterns_ (never raw paths or query
  strings, which can carry blob/invite tokens), status, duration, user id. No request bodies,
  tokens, codes, emails or link fragments are logged. The `log` mail transport is the one
  deliberate exception (dev only).
- No CORS (`/v1` is for the desktop app; the web viewer is same-origin). All responses carry
  `Cache-Control: no-store`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, frame
  denial; HTML pages use a per-response nonce CSP with no external resources.
- The patch viewer decrypts in the browser with the `#k=` fragment, which never reaches the server.
- Audit log (`audit_log` table) of share/visibility/membership/policy changes.

## Development

```sh
pnpm --filter @githappens/cloud typecheck
pnpm --filter @githappens/cloud test                    # in-process API suite on MemoryStore
GH_CLOUD_TEST_PG_URL=postgres://postgres:pw@localhost:5432/postgres \
  pnpm --filter @githappens/cloud test                  # same suite on PgStore (schema per test)
```

Layout: `src/app.ts` (server + routing), `src/routes/*` (endpoints), `src/store/{types,memory,pg,
migrate}.ts` (persistence), `src/blob.ts` (blob storage), `src/crypto.ts` (ids, tokens, JWT, keys),
`src/jobs.ts` (maintenance), `src/views.ts` (HTML pages), `src/idp.ts` (federation).

Not implemented in this phase: Code Suggest (§6.4), Insights (§6.6), S3-compatible blob storage,
SSO/SCIM.

## API description, load test

- `GET /openapi.json` serves the OpenAPI 3.1 document generated from `packages/cloud-api/src/types.ts`
  (`pnpm --filter @githappens/cloud openapi`; a test fails when the committed `openapi.json` is stale).
- `pnpm --filter @githappens/cloud load-test [--rate=1000] [--total=1000] [--url=…]` creates Cloud
  Patches end to end (create → upload → complete → get → download) at the target rate and prints
  throughput and latency percentiles. Without `--url` it starts an in-process server (memory store, or
  Postgres when `GH_CLOUD_DATABASE_URL` is set).
- S3 tests run against a signature-checking fake S3; set `GH_CLOUD_TEST_S3_URL=http://127.0.0.1:9000`
  (MinIO, `minioadmin` credentials) to also run them against a real implementation.
