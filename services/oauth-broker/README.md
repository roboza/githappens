# @githappens/oauth-broker

A tiny, stateless OAuth **code→token exchange** service for the GitHappens desktop app
(spec 10 §6.1, spec 00 §4).

## Why it exists

GitHappens signs users in with the RFC 8252 native-app pattern: system browser, PKCE, and a
loopback (`http://127.0.0.1:<port>/callback`) or `githappens://` redirect. Some providers
(GitHub OAuth Apps, Bitbucket Cloud, Atlassian 3LO) still require a **client secret** at the
token endpoint, and a secret shipped inside a desktop binary is not a secret. The broker holds
those secrets server-side. The app sends it the authorization code, and the broker adds
`client_id` + `client_secret`, calls the provider, and returns the tokens.

The broker stores nothing. It has no database, sessions or cookies, and it never logs request
bodies, codes, verifiers, tokens or secrets. Builds without `OAUTH_BROKER_URL` fall back to
GitHub Device Flow (no secret needed) or PAT entry.

GitLab and Azure DevOps (Entra ID) support public PKCE clients and do not strictly need the
broker. They are supported so that one code path can serve every provider, and so that
operators who register confidential apps can use them.

## API

All bodies are JSON (`Content-Type: application/json`, max 8 KB). Every response carries
`Cache-Control: no-store`. Errors always look like `{ "error": "...", "error_description": "..." }`.

### `POST /token/:provider`

`provider` ∈ `github | gitlab | bitbucket | atlassian | azure-devops`

```jsonc
{
  "code": "…", // required
  "redirect_uri": "http://127.0.0.1:53682/callback", // required, must match the authorize request
  "code_verifier": "…", // optional PKCE verifier (43-128 chars); forwarded to github, gitlab, azure-devops
  "host": "ghe.example.com", // github/gitlab only: GHE / self-managed host (default github.com / gitlab.com)
  "scope": "…", // azure-devops only (default "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access")
}
```

### `POST /refresh/:provider`

```jsonc
{ "refresh_token": "…", "host": "…" /* github/gitlab */, "scope": "…" /* azure-devops */ }
```

Note: GitHub OAuth App tokens do not expire. Refresh only applies to GitHub Apps that use
expiring user tokens.

### `POST /revoke/:provider`

Revokes a user token at the provider when the user disconnects (spec 10 §9).

```jsonc
{ "token": "…" /* access token, required */, "host": "…" /* github/gitlab only */ }
```

- `github`: `DELETE https://api.github.com/applications/{client_id}/token` (GHE: `https://{host}/api/v3/…`)
  with HTTP Basic client auth and `{ "access_token": token }`.
- `gitlab`: `POST https://{host}/oauth/revoke` (form `token`, `client_id`, `client_secret` if configured).
- `bitbucket`, `atlassian`, `azure-devops`: no revocation API → `501 { "error": "unsupported" }`.

Success is `200 { "revoked": true }`. An upstream 404/422 (token already invalid) also counts
as revoked. Upstream 5xx, network failure or timeout → `502 upstream_error`; upstream 401/403
→ `502 broker_misconfigured`. Validation, CORS, rate-limit and 404 rules match `/token`.

### Success response (200, normalized)

```json
{
  "access_token": "…",
  "token_type": "bearer",
  "refresh_token": "…",
  "expires_in": 7200,
  "refresh_token_expires_in": 15724800,
  "scope": "repo read:org"
}
```

Only `access_token` and `token_type` are always present. `scope` is always space-separated
(GitHub's comma list is converted). Providers that rotate refresh tokens (GitLab, Atlassian)
return a new `refresh_token` on every refresh, and the app must persist it atomically.

### `GET /healthz`

`{ "status": "ok", "providers": ["github", …] }`. Not rate limited, and successful probes are not logged.

### Error codes

| HTTP | `error`                                                                 | Meaning                                                                    |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 400  | `invalid_request`                                                       | Missing/unknown/malformed field, bad JSON                                  |
| 400  | `invalid_redirect_uri`                                                  | Not `http://127.0.0.1:<port>/…` or `githappens://…`                        |
| 400  | `unknown_host`                                                          | No GHE / GitLab self-managed app configured for `host`                     |
| 400  | provider's code (`invalid_grant`, `bad_verification_code`, …)           | Provider rejected the grant; `error_description` is scrubbed and truncated |
| 403  | `cors_denied`                                                           | Request had an `Origin` header (browser) or was a preflight                |
| 404  | `not_found` / `unsupported_provider`                                    | Unknown path / provider not enabled on this broker                         |
| 405  | `method_not_allowed`                                                    |                                                                            |
| 413  | `payload_too_large`                                                     | Body > 8 KB                                                                |
| 415  | `unsupported_media_type`                                                | Not `application/json`                                                     |
| 429  | `rate_limited`                                                          | Per-IP token bucket empty; see `Retry-After`                               |
| 501  | `unsupported`                                                           | `/revoke` on a provider without a revocation API                           |
| 502  | `broker_misconfigured`                                                  | Provider rejected the broker's client credentials (`invalid_client`)       |
| 502  | `upstream_error` / `upstream_unreachable` / `upstream_invalid_response` | Provider 5xx, network failure, or no `access_token`                        |
| 504  | `upstream_timeout`                                                      | Provider did not answer within `GH_BROKER_UPSTREAM_TIMEOUT_MS`             |

## Configuration

| Variable                                          | Default         | Notes                                                                                   |
| ------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `GH_BROKER_PORT` (or `PORT`)                      | `8080`          |                                                                                         |
| `GH_BROKER_HOST`                                  | `0.0.0.0`       |                                                                                         |
| `GH_GITHUB_CLIENT_ID` / `GH_GITHUB_CLIENT_SECRET` |                 | Secret required                                                                         |
| `GH_GHE_HOSTS`                                    |                 | JSON `{"ghe.example.com": {"clientId": "…", "clientSecret": "…"}}`                      |
| `GH_GITLAB_CLIENT_ID` / `GH_GITLAB_CLIENT_SECRET` |                 | Secret optional (public PKCE app)                                                       |
| `GH_GITLAB_HOSTS`                                 |                 | JSON, same shape as `GH_GHE_HOSTS`; `clientSecret` optional                             |
| `GH_BITBUCKET_CLIENT_ID` / `_SECRET`              |                 | Consumer key / secret. Secret required                                                  |
| `GH_ATLASSIAN_CLIENT_ID` / `_SECRET`              |                 | Secret required                                                                         |
| `GH_AZURE_CLIENT_ID` / `GH_AZURE_CLIENT_SECRET`   |                 | Secret optional (public client)                                                         |
| `GH_AZURE_TENANT`                                 | `organizations` | Entra tenant: `organizations`, `common`, a GUID or a domain                             |
| `GH_BROKER_UPSTREAM_TIMEOUT_MS`                   | `10000`         | Per upstream call                                                                       |
| `GH_BROKER_RATE_CAPACITY`                         | `20`            | Burst per client IP                                                                     |
| `GH_BROKER_RATE_REFILL_PER_MIN`                   | `20`            | Sustained requests/minute per IP                                                        |
| `GH_BROKER_TRUST_PROXY`                           | `false`         | Set `true` behind a reverse proxy: the client IP is the **rightmost** `X-Forwarded-For` |

A provider is enabled when its client ID is set. Configuration is validated at boot, and on any
problem the process prints every issue (never the secret values) and exits with code 78.

## Registering the OAuth apps

The callback URL registered with the provider is the **desktop app's** redirect. The broker
never receives the browser redirect, so its own URL is never a callback.

- **GitHub / GitHub Enterprise Server.** Go to _Settings → Developer settings → OAuth Apps → New_.
  Set the authorization callback URL to `http://127.0.0.1/callback`. GitHub lets a loopback
  redirect use any port when the registered callback has none, so the app can use
  `http://127.0.0.1:<ephemeral>/callback`. Enable **Device Flow** too, for builds without the
  broker. Repeat on each GHE instance and add it to `GH_GHE_HOSTS`.
- **GitLab.com / self-managed.** Go to _User or Admin settings → Applications_. Set the redirect
  URI to `http://127.0.0.1/callback`. Untick _Confidential_ for a public PKCE app (then no secret
  is needed), and pick the scopes `api read_user read_repository write_repository`. GitLab matches
  the redirect exactly, so the app must use the registered form (fixed port or `githappens://oauth/callback`).
- **Bitbucket Cloud.** Go to _Workspace settings → OAuth consumers → Add consumer_. Set the
  callback URL to `githappens://oauth/callback`, because Bitbucket wants one fixed URL. Tick the
  scopes from spec 10 §6.1. The key and secret become `GH_BITBUCKET_CLIENT_ID`/`_SECRET`.
- **Atlassian (Jira Cloud 3LO).** Go to _developer.atlassian.com → Console → Create → OAuth 2.0
  integration_. Set the callback URL to `http://127.0.0.1:<fixed port>/callback`, or to
  `githappens://oauth/callback`. Atlassian matches it exactly. Add the Jira API scopes
  `read:jira-work write:jira-work read:jira-user` and include `offline_access` in the authorize request.
- **Azure DevOps (Microsoft Entra ID).** Go to _Entra admin center → App registrations → New_ and
  choose _Accounts in any organizational directory_. Under _Mobile and desktop applications_,
  add the redirect URI `http://127.0.0.1` (Entra ignores the port for loopback). Grant the
  delegated _Azure DevOps → user_impersonation_ permission. For a public client, enable
  _Allow public client flows_ and leave `GH_AZURE_CLIENT_SECRET` unset.

## Running

```sh
# from the repo root
pnpm --filter @githappens/oauth-broker start      # node src/index.ts (Node >= 22.18)
pnpm --filter @githappens/oauth-broker test
pnpm --filter @githappens/oauth-broker typecheck
```

There are no runtime dependencies. The service uses only `node:http`, `node:crypto` and global
`fetch`, and Node runs the TypeScript directly through type stripping.

## Deploying

The broker is a single container. It listens on `$GH_BROKER_PORT` (or `$PORT`), keeps no state,
and scales horizontally. Rate limits are per instance.

```sh
docker build -t githappens-oauth-broker services/oauth-broker
docker run -p 8080:8080 --env-file broker.env githappens-oauth-broker
```

- **Fly.io.** Run `fly launch --no-deploy` in `services/oauth-broker`, then
  `fly secrets set GH_GITHUB_CLIENT_SECRET=…` and the other secrets. Set `internal_port = 8080`,
  add an `[http_service.checks]` entry for `GET /healthz`, and set `GH_BROKER_TRUST_PROXY=true`.
  Fly appends the client IP to `X-Forwarded-For`.
- **Render.** Create a _Web Service_ from the Dockerfile with the root directory
  `services/oauth-broker` and the health check path `/healthz`. Render injects `PORT`. Put the
  secrets in an environment group and set `GH_BROKER_TRUST_PROXY=true`.
- **Any container host / Kubernetes.** Terminate TLS in front of the broker; it speaks plain
  HTTP. Map the liveness/readiness probes to `/healthz`. The process shuts down gracefully on
  `SIGTERM`, finishing in-flight exchanges for up to the upstream timeout + 2 s.

The desktop build sets `OAUTH_BROKER_URL=https://<your broker>`.

## Security notes

- **Secrets** come only from the environment. Prefer the platform's secret store, and never
  bake them into the image. Rotate them at the provider and redeploy.
- **Logs** are one JSON line per request: `ts, level, msg, reqId, method, route, provider, host,
grant, status, upstreamStatus, upstreamError, error, durationMs`. The logger only accepts that
  allow-list, and any other key is replaced with `[redacted]`. Client IPs are not logged.
- **`redirect_uri` allow-list.** Only `http://127.0.0.1:<port>/…` and `githappens://…` are
  accepted, so the broker cannot be used to redeem codes issued to other web origins.
- **Upstream hosts** are fixed per provider. A GHE or GitLab `host` must be in the configured
  map, so there is no SSRF to arbitrary hosts. Redirects from upstream are not followed.
- **No CORS.** Requests with an `Origin` header and preflights are refused, and no
  `Access-Control-*` headers are ever sent. The desktop app calls the broker from the Electron
  main process.
- **Abuse limits.** There is an 8 KB body cap, header and request timeouts, a per-IP token
  bucket, and an upstream timeout. The broker adds the secret but cannot mint tokens without a
  valid code or refresh token from the provider. PKCE (where supported) binds the code to the
  app instance that started the flow.
- **Error descriptions** from providers are passed through truncated, with any occurrence of
  the client secret, code, verifier or refresh token replaced by `[redacted]`.
