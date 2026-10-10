import { HttpClient, ProviderError } from '../http';

/** Normalized OAuth token response. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  scopes: string[];
  tokenType?: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string | string[];
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Splits "a b", "a,b" or ["a","b"] into scopes. */
export function splitScopes(s: string | string[] | null | undefined): string[] {
  if (!s) return [];
  return (Array.isArray(s) ? s : s.split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean);
}

/** Parses an RFC 6749 token response (JSON or form-encoded); `error` → ProviderError. */
export function parseTokenResponse(body: unknown, now = Date.now()): TokenSet {
  let raw: RawTokenResponse;
  if (typeof body === 'string') {
    try {
      raw = JSON.parse(body) as RawTokenResponse;
    } catch {
      raw = Object.fromEntries(new URLSearchParams(body)) as RawTokenResponse;
    }
  } else raw = (body ?? {}) as RawTokenResponse;
  if (raw.error || !raw.access_token) {
    throw new ProviderError({
      code: 'auth_required',
      message: raw.error_description ?? raw.error ?? 'The token endpoint returned no access token.',
      providerMessage: raw.error,
    });
  }
  const expiresIn =
    raw.expires_in === undefined || raw.expires_in === '' ? undefined : Number(raw.expires_in);
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token || undefined,
    expiresAt: expiresIn && Number.isFinite(expiresIn) ? now + expiresIn * 1000 : undefined,
    scopes: splitScopes(raw.scope),
    tokenType: raw.token_type,
  };
}

/** One-shot client for absolute URLs (token endpoints, broker). No retries: token calls aren't idempotent. */
export function oneShotClient(fetchImpl?: typeof fetch): HttpClient {
  return new HttpClient({ baseUrl: 'http://localhost', retries: 0, fetch: fetchImpl, timeoutMs: 30_000 });
}

async function postToken(
  url: string,
  form: Record<string, string | undefined>,
  http: HttpClient,
): Promise<TokenSet> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
  try {
    const data = await http.post<unknown>(url, body, { headers: { Accept: 'application/json' } });
    return parseTokenResponse(data);
  } catch (e) {
    throw toAuthError(e);
  }
}

/** invalid_grant & co. on token endpoints mean "sign in again". */
function toAuthError(e: unknown): unknown {
  if (e instanceof ProviderError && (e.code === 'validation' || e.code === 'auth_required')) {
    return new ProviderError({
      ...e.serialized,
      code: 'auth_required',
      message: e.serialized.providerMessage ?? e.message,
    });
  }
  return e;
}

/** Direct authorization-code exchange (public PKCE clients, e.g. GitLab). */
export function exchangeCode(o: {
  tokenUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientSecret?: string;
  http?: HttpClient;
}): Promise<TokenSet> {
  return postToken(
    o.tokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: o.clientId,
      client_secret: o.clientSecret,
      code: o.code,
      code_verifier: o.codeVerifier,
      redirect_uri: o.redirectUri,
    },
    o.http ?? oneShotClient(),
  );
}

const brokerBase = (u: string): string => u.replace(/\/+$/, '');

/** Code exchange through the OAuth broker: POST {brokerUrl}/token/{kind} {code, code_verifier, redirect_uri}. */
export async function brokerExchange(o: {
  brokerUrl: string;
  kind: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  http?: HttpClient;
}): Promise<TokenSet> {
  const http = o.http ?? oneShotClient();
  try {
    const data = await http.post<unknown>(`${brokerBase(o.brokerUrl)}/token/${encodeURIComponent(o.kind)}`, {
      code: o.code,
      code_verifier: o.codeVerifier,
      redirect_uri: o.redirectUri,
    });
    return parseTokenResponse(data);
  } catch (e) {
    throw toAuthError(e);
  }
}

/** Refresh through the OAuth broker: POST {brokerUrl}/refresh/{kind} {refresh_token}. */
export async function brokerRefresh(o: {
  brokerUrl: string;
  kind: string;
  refreshToken: string;
  http?: HttpClient;
}): Promise<TokenSet> {
  const http = o.http ?? oneShotClient();
  try {
    const data = await http.post<unknown>(
      `${brokerBase(o.brokerUrl)}/refresh/${encodeURIComponent(o.kind)}`,
      {
        refresh_token: o.refreshToken,
      },
    );
    return parseTokenResponse(data);
  } catch (e) {
    throw toAuthError(e);
  }
}

/**
 * Refreshes an access token — via the broker when `brokerUrl` is given (secret-holding
 * providers), else directly at `tokenUrl` (public clients). Rotating refresh tokens: when the
 * response lacks a new refresh token, the old one is kept.
 */
export async function refreshToken(o: {
  refreshToken: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string[];
  brokerUrl?: string;
  kind?: string;
  http?: HttpClient;
}): Promise<TokenSet> {
  let t: TokenSet;
  if (o.brokerUrl) {
    if (!o.kind) throw new Error('refreshToken: kind is required with brokerUrl');
    t = await brokerRefresh({
      brokerUrl: o.brokerUrl,
      kind: o.kind,
      refreshToken: o.refreshToken,
      http: o.http,
    });
  } else {
    if (!o.tokenUrl) throw new Error('refreshToken: tokenUrl or brokerUrl is required');
    t = await postToken(
      o.tokenUrl,
      {
        grant_type: 'refresh_token',
        refresh_token: o.refreshToken,
        client_id: o.clientId,
        scope: o.scopes?.length ? o.scopes.join(' ') : undefined,
      },
      o.http ?? oneShotClient(),
    );
  }
  return { ...t, refreshToken: t.refreshToken ?? o.refreshToken };
}

/**
 * Builds an `HttpClientOptions.auth` function that refreshes the token `skewMs` before expiry,
 * single-flight (concurrent requests share one refresh). `save` must persist the new token set
 * atomically (rotating refresh tokens). Refresh failures propagate (→ auth:reauthRequired).
 */
export function createRefreshingAuth(o: {
  get: () => TokenSet | Promise<TokenSet>;
  refresh: (current: TokenSet) => Promise<TokenSet>;
  save: (next: TokenSet) => void | Promise<void>;
  authorization?: (token: string) => string;
  skewMs?: number;
  now?: () => number;
}): () => Promise<string> {
  let inflight: Promise<TokenSet> | null = null;
  const skew = o.skewMs ?? 120_000;
  const now = o.now ?? Date.now;
  const header = o.authorization ?? ((t: string) => `Bearer ${t}`);
  return async () => {
    const cur = await o.get();
    if (!cur.expiresAt || !cur.refreshToken || cur.expiresAt - now() > skew) return header(cur.accessToken);
    inflight ??= (async () => {
      try {
        const next = await o.refresh(cur);
        await o.save(next);
        return next;
      } finally {
        inflight = null;
      }
    })();
    return header((await inflight).accessToken);
  };
}

const BROKER_REVOKE: Readonly<Record<string, string>> = {
  github: 'github',
  'github-enterprise': 'github',
  bitbucket: 'bitbucket',
  'bitbucket-cloud': 'bitbucket',
  'jira-cloud': 'atlassian',
  atlassian: 'atlassian',
};

/**
 * Best-effort token revocation on disconnect. GitLab (public PKCE client) revokes directly at
 * `https://{host}/oauth/revoke`; secret-holding providers (GitHub, Bitbucket, Atlassian) go
 * through the broker's `POST /revoke/{provider}` (501 → 'unsupported'); Entra ID (Azure) has no
 * revocation endpoint for public clients → 'unsupported'. Other HTTP failures throw ProviderError.
 */
export async function revokeToken(o: {
  kind: string;
  host?: string;
  token: string;
  clientId?: string;
  brokerUrl?: string;
  fetch?: typeof fetch;
}): Promise<'revoked' | 'unsupported'> {
  const http = oneShotClient(o.fetch);
  if (o.kind === 'gitlab' || o.kind === 'gitlab-self-managed') {
    const host = (o.host || 'gitlab.com').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const body = new URLSearchParams({ token: o.token });
    if (o.clientId) body.set('client_id', o.clientId);
    await http.post(`https://${host}/oauth/revoke`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return 'revoked';
  }
  const provider = BROKER_REVOKE[o.kind];
  if (!provider || !o.brokerUrl) return 'unsupported';
  const UNSUPPORTED = 'broker: revocation unsupported';
  const broker = new HttpClient({
    baseUrl: 'http://localhost',
    retries: 0,
    fetch: o.fetch,
    timeoutMs: 30_000,
    errorMessage: (status) => (status === 501 ? UNSUPPORTED : undefined),
  });
  try {
    const r = await broker.post<{ revoked?: boolean } | undefined>(
      `${brokerBase(o.brokerUrl)}/revoke/${encodeURIComponent(provider)}`,
      { token: o.token },
    );
    return r?.revoked === false ? 'unsupported' : 'revoked';
  } catch (e) {
    if (e instanceof ProviderError && e.serialized.providerMessage === UNSUPPORTED) return 'unsupported';
    throw e;
  }
}
