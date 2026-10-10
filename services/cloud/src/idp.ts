/**
 * Federation to upstream identity providers (spec 14 §6.1). The server is a confidential OAuth
 * client of GitHub / GitLab / Google (client secrets from env); it only asks for identity scopes
 * and never hands upstream tokens to the desktop app.
 */
import type { CloudConfig, OAuthClient } from './config.ts';
import type { FetchLike } from './context.ts';

export type FederatedIdp = 'github' | 'gitlab' | 'google';

export interface FederatedProfile {
  /** Upstream host (github.com, gitlab.example.com, accounts.google.com). */
  host: string;
  subject: string;
  /** Verified email, lower-cased; undefined when the provider has none verified. */
  email?: string;
  name: string;
  avatarUrl?: string;
}

export class IdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdpError';
  }
}

interface IdpSpec {
  authorizeUrl(client: OAuthClient, redirectUri: string, state: string, loginHint?: string): string;
  exchange(client: OAuthClient, code: string, redirectUri: string, f: FetchLike): Promise<string>;
  profile(accessToken: string, f: FetchLike): Promise<FederatedProfile>;
}

const UA = 'githappens-cloud';
const TIMEOUT = 10_000;

async function getJson(
  f: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> | unknown[]> {
  let res: Response;
  try {
    res = await f(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new IdpError('The identity provider could not be reached.');
  }
  if (!res.ok) throw new IdpError(`The identity provider returned HTTP ${res.status}.`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new IdpError('The identity provider returned an invalid response.');
  }
}

async function tokenRequest(f: FetchLike, url: string, params: Record<string, string>): Promise<string> {
  const body = await getJson(f, url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': UA,
    },
    body: new URLSearchParams(params).toString(),
  });
  const token = (body as Record<string, unknown>).access_token;
  if (typeof token !== 'string' || !token) throw new IdpError('The identity provider rejected the sign-in.');
  return token;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https:\/\/[^\s"'<>]{1,500}$/.test(s) ? s : undefined;
};

function github(): IdpSpec {
  return {
    authorizeUrl(client, redirectUri, state, loginHint) {
      const u = new URL('https://github.com/login/oauth/authorize');
      u.searchParams.set('client_id', client.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', 'read:user user:email');
      u.searchParams.set('state', state);
      u.searchParams.set('allow_signup', 'true');
      if (loginHint) u.searchParams.set('login', loginHint);
      return u.toString();
    },
    exchange(client, code, redirectUri, f) {
      return tokenRequest(f, 'https://github.com/login/oauth/access_token', {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
    },
    async profile(token, f) {
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': UA,
      };
      const user = (await getJson(f, 'https://api.github.com/user', { headers })) as Record<string, unknown>;
      const emails = (await getJson(f, 'https://api.github.com/user/emails', { headers })) as unknown[];
      const verified = Array.isArray(emails)
        ? (emails as Array<Record<string, unknown>>).filter(
            (e) => e.verified === true && typeof e.email === 'string',
          )
        : [];
      const primary = verified.find((e) => e.primary === true) ?? verified[0];
      if (typeof user.id !== 'number' && typeof user.id !== 'string')
        throw new IdpError('GitHub returned no user id.');
      return {
        host: 'github.com',
        subject: String(user.id),
        email: str(primary?.email)?.toLowerCase(),
        name: str(user.name) ?? str(user.login) ?? 'GitHub user',
        avatarUrl: httpsUrl(user.avatar_url),
      };
    },
  };
}

function gitlab(baseUrl: string): IdpSpec {
  const host = new URL(baseUrl).host;
  return {
    authorizeUrl(client, redirectUri, state, loginHint) {
      const u = new URL(`${baseUrl}/oauth/authorize`);
      u.searchParams.set('client_id', client.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'read_user');
      u.searchParams.set('state', state);
      if (loginHint) u.searchParams.set('login_hint', loginHint);
      return u.toString();
    },
    exchange(client, code, redirectUri, f) {
      return tokenRequest(f, `${baseUrl}/oauth/token`, {
        grant_type: 'authorization_code',
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
    },
    async profile(token, f) {
      const user = (await getJson(f, `${baseUrl}/api/v4/user`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': UA },
      })) as Record<string, unknown>;
      if (typeof user.id !== 'number' && typeof user.id !== 'string')
        throw new IdpError('GitLab returned no user id.');
      // `email` on /user is the primary address, which GitLab requires to be confirmed.
      const confirmed = user.confirmed_at === undefined || user.confirmed_at !== null;
      return {
        host,
        subject: String(user.id),
        email: confirmed ? str(user.email)?.toLowerCase() : undefined,
        name: str(user.name) ?? str(user.username) ?? 'GitLab user',
        avatarUrl: httpsUrl(user.avatar_url),
      };
    },
  };
}

function google(): IdpSpec {
  return {
    authorizeUrl(client, redirectUri, state, loginHint) {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.searchParams.set('client_id', client.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email profile');
      u.searchParams.set('state', state);
      u.searchParams.set('prompt', 'select_account');
      if (loginHint) u.searchParams.set('login_hint', loginHint);
      return u.toString();
    },
    exchange(client, code, redirectUri, f) {
      return tokenRequest(f, 'https://oauth2.googleapis.com/token', {
        grant_type: 'authorization_code',
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
    },
    async profile(token, f) {
      const info = (await getJson(f, 'https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': UA },
      })) as Record<string, unknown>;
      const sub = str(info.sub);
      if (!sub) throw new IdpError('Google returned no subject.');
      return {
        host: 'accounts.google.com',
        subject: sub,
        email: info.email_verified === true ? str(info.email)?.toLowerCase() : undefined,
        name: str(info.name) ?? str(info.email) ?? 'Google user',
        avatarUrl: httpsUrl(info.picture),
      };
    },
  };
}

export function federation(
  config: CloudConfig,
  idp: FederatedIdp,
): { client: OAuthClient; spec: IdpSpec } | undefined {
  if (idp === 'github' && config.github) return { client: config.github, spec: github() };
  if (idp === 'gitlab' && config.gitlab)
    return { client: config.gitlab, spec: gitlab(config.gitlab.baseUrl) };
  if (idp === 'google' && config.google) return { client: config.google, spec: google() };
  return undefined;
}
