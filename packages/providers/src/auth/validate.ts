import { HttpClient, ProviderError } from '../http';
import type { ProviderUser } from '../types';
import { authInfo, type AuthInfoFactory, AUTH_INFO } from './info';
import { splitScopes } from './token';

export interface TokenValidation {
  user: ProviderUser;
  /** Granted scopes ([] when unknown, see `scopesKnown`). */
  scopes: string[];
  /** false for fine-grained PATs / GitHub App tokens / GitLab OAuth without introspection. */
  scopesKnown: boolean;
  /** Required PAT scopes not granted (only meaningful when scopesKnown). */
  missingScopes: string[];
  /** GitLab server version. */
  serverVersion?: string;
}

/** GitHub scope implications (a parent scope grants its children). */
const GITHUB_IMPLIES: Record<string, string[]> = {
  repo: ['repo:status', 'repo_deployment', 'public_repo', 'repo:invite', 'security_events'],
  'admin:org': ['write:org', 'read:org'],
  'write:org': ['read:org'],
  'admin:public_key': ['write:public_key', 'read:public_key'],
  'write:public_key': ['read:public_key'],
  user: ['read:user', 'user:email', 'user:follow'],
  'admin:gpg_key': ['write:gpg_key', 'read:gpg_key'],
  'write:packages': ['read:packages'],
};

export function expandGitHubScopes(scopes: string[]): Set<string> {
  const out = new Set<string>();
  const add = (s: string): void => {
    if (out.has(s)) return;
    out.add(s);
    for (const c of GITHUB_IMPLIES[s] ?? []) add(c);
  };
  scopes.forEach(add);
  return out;
}

/** 'api' covers read_api/read_user/read_repository/write_repository on GitLab. */
function expandGitLabScopes(scopes: string[]): Set<string> {
  const out = new Set(scopes);
  if (out.has('api'))
    ['read_api', 'read_user', 'read_repository', 'write_repository'].forEach((s) => out.add(s));
  if (out.has('write_repository')) out.add('read_repository');
  return out;
}

const cmpVersion = (a: string, b: string): number => {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * Validates a token (PAT or OAuth) for `kind`/`host`: resolves the user and granted scopes.
 * `http` may be passed (e.g. with proxy-aware fetch); it must not carry its own auth — the
 * token is sent per request. 401 → ProviderError('auth_required').
 */
export async function validateToken(
  kind: string,
  host: string,
  token: string,
  http?: HttpClient,
  table: Readonly<Record<string, AuthInfoFactory>> = AUTH_INFO,
): Promise<TokenValidation> {
  const info = authInfo(kind, host, table);
  const client = http ?? new HttpClient({ baseUrl: info.apiBaseUrl, headers: info.headers, retries: 1 });
  const headers = { ...info.headers, Authorization: info.authorization(token) };
  const api = (p: string): string => `${info.apiBaseUrl}/${p}`;

  if (kind === 'github') {
    const res = await client.request<{
      id: number;
      login: string;
      name?: string;
      avatar_url?: string;
      email?: string;
    }>(api('user'), { headers });
    const header = res.headers.get('x-oauth-scopes');
    const scopes = splitScopes(header);
    const scopesKnown = header !== null;
    const have = expandGitHubScopes(scopes);
    const u = res.data;
    return {
      user: {
        id: String(u.id),
        login: u.login,
        name: u.name ?? undefined,
        avatarUrl: u.avatar_url,
        email: u.email ?? undefined,
      },
      scopes,
      scopesKnown,
      missingScopes: scopesKnown ? info.patScopes.filter((s) => !have.has(s)) : [],
    };
  }

  if (kind === 'gitlab') {
    const u = await client.get<{
      id: number;
      username: string;
      name?: string;
      avatar_url?: string;
      email?: string;
      public_email?: string;
    }>(api('user'), { headers });
    let serverVersion: string | undefined;
    try {
      serverVersion = (await client.get<{ version?: string }>(api('version'), { headers }))?.version;
    } catch {
      /* optional */
    }
    if (serverVersion && cmpVersion(serverVersion, '13.1.0') < 0) {
      throw new ProviderError({
        code: 'unsupported',
        message: `GitLab ${serverVersion} is not supported (13.1 or later is required).`,
      });
    }
    let scopes: string[] = [];
    let scopesKnown = false;
    try {
      const pat = await client.get<{ scopes?: string[] }>(api('personal_access_tokens/self'), { headers });
      scopes = pat?.scopes ?? [];
      scopesKnown = true;
    } catch (e) {
      if (
        !(e instanceof ProviderError) ||
        !['not_found', 'auth_required', 'insufficient_scope'].includes(e.code)
      )
        throw e;
      try {
        const webBase = info.apiBaseUrl.replace(/\/api\/v4$/, '');
        const ti = await client.get<{ scope?: string[] | string; scopes?: string[] }>(
          `${webBase}/oauth/token/info`,
          {
            headers,
          },
        );
        scopes = splitScopes(ti?.scope ?? ti?.scopes);
        scopesKnown = true;
      } catch {
        /* unknown */
      }
    }
    const have = expandGitLabScopes(scopes);
    return {
      user: {
        id: String(u.id),
        login: u.username,
        name: u.name ?? undefined,
        avatarUrl: u.avatar_url,
        email: u.email || u.public_email || undefined,
      },
      scopes,
      scopesKnown,
      missingScopes: scopesKnown ? info.patScopes.filter((s) => !have.has(s)) : [],
      serverVersion,
    };
  }

  throw new ProviderError({
    code: 'unsupported',
    message: `validateToken: unsupported provider kind '${kind}'`,
  });
}
