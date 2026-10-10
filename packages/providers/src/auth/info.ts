/**
 * Per-provider auth descriptors (spec 10 §6.1). Pure data: the main-process AuthService /
 * ProviderService use these to build OAuth URLs, PAT pages, git credentials and the
 * HttpClient configuration for an integration.
 */

export type OAuthMode =
  /** Public client + PKCE, token endpoint called directly (GitLab, Entra ID). */
  | 'pkce-public'
  /** Provider needs a client secret → code exchange/refresh via the OAuth broker. */
  | 'broker'
  /** No OAuth (PAT only). */
  | 'none';

export interface AuthInfo {
  kind: string;
  /** Normalized host ('github.com', 'ghe.acme.com'). */
  host: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  /** GitHub device flow (no secret needed). */
  deviceCodeUrl?: string;
  revokeUrl?: string;
  /** OAuth scopes requested. */
  scopes: string[];
  /** Scopes a PAT must carry (shown in the "Required scopes" list). */
  patScopes: string[];
  /** Token creation page, scopes pre-filled where the provider supports it. */
  patPageUrl: string;
  /** Username to pair with the token for HTTPS git (askpass). */
  usernameForGit: string;
  /** REST API base for the HttpClient. */
  apiBaseUrl: string;
  graphqlUrl?: string;
  /** Default headers for the HttpClient (Accept, API version…). */
  headers: Record<string, string>;
  /** Builds the Authorization header value for a token. */
  authorization: (token: string) => string;
  /** OAuth strategy on this host (self-hosted defaults to PAT unless an app id is supplied). */
  oauth: OAuthMode;
  /** OAuth access tokens expire and come with refresh tokens. */
  refreshable: boolean;
  /** Characters joining scopes in the authorize URL. */
  scopeSeparator: string;
}

export type AuthInfoFactory = (host: string) => AuthInfo;

/** 'https://GHE.acme.com/' → 'ghe.acme.com' (keeps an explicit port). */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

const bearer = (token: string): string => `Bearer ${token}`;

export const GITHUB_SCOPES = ['repo', 'read:org', 'read:user', 'user:email', 'workflow', 'write:public_key'];

export const githubAuthInfo: AuthInfoFactory = (rawHost) => {
  const host = normalizeHost(rawHost || 'github.com');
  const dotCom = host === 'github.com' || host === 'www.github.com';
  const web = `https://${dotCom ? 'github.com' : host}`;
  return {
    kind: 'github',
    host: dotCom ? 'github.com' : host,
    authorizeUrl: `${web}/login/oauth/authorize`,
    tokenUrl: `${web}/login/oauth/access_token`,
    deviceCodeUrl: `${web}/login/device/code`,
    scopes: GITHUB_SCOPES,
    patScopes: GITHUB_SCOPES,
    patPageUrl: `${web}/settings/tokens/new?scopes=${GITHUB_SCOPES.join(',')}&description=GitHappens`,
    usernameForGit: 'x-access-token',
    apiBaseUrl: dotCom ? 'https://api.github.com' : `${web}/api/v3`,
    graphqlUrl: dotCom ? 'https://api.github.com/graphql' : `${web}/api/graphql`,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    authorization: bearer,
    oauth: dotCom ? 'broker' : 'none',
    refreshable: false,
    scopeSeparator: ' ',
  };
};

export const GITLAB_OAUTH_SCOPES = ['api', 'read_user', 'read_repository', 'write_repository'];
export const GITLAB_PAT_SCOPES = ['api', 'read_user', 'write_repository'];

export const gitlabAuthInfo: AuthInfoFactory = (rawHost) => {
  const host = normalizeHost(rawHost || 'gitlab.com');
  const web = `https://${host}`;
  return {
    kind: 'gitlab',
    host,
    authorizeUrl: `${web}/oauth/authorize`,
    tokenUrl: `${web}/oauth/token`,
    revokeUrl: `${web}/oauth/revoke`,
    scopes: GITLAB_OAUTH_SCOPES,
    patScopes: GITLAB_PAT_SCOPES,
    patPageUrl: `${web}/-/user_settings/personal_access_tokens?name=GitHappens&scopes=${GITLAB_PAT_SCOPES.join(',')}`,
    usernameForGit: 'oauth2',
    apiBaseUrl: `${web}/api/v4`,
    graphqlUrl: `${web}/api/graphql`,
    headers: {},
    authorization: bearer,
    oauth: host === 'gitlab.com' ? 'pkce-public' : 'none',
    refreshable: true,
    scopeSeparator: ' ',
  };
};

/**
 * Registry keyed by provider/tracker kind. Other provider modules (bitbucket, azure, jira…)
 * export their own factories; ProviderService can merge them:
 * `authInfo(kind, host, { ...AUTH_INFO, ...BITBUCKET_AUTH_INFO })`.
 */
export const AUTH_INFO: Readonly<Record<string, AuthInfoFactory>> = {
  github: githubAuthInfo,
  gitlab: gitlabAuthInfo,
};

export function authInfo(
  kind: string,
  host: string,
  table: Readonly<Record<string, AuthInfoFactory>> = AUTH_INFO,
): AuthInfo {
  const f = table[kind];
  if (!f) throw new Error(`No auth descriptor registered for provider kind '${kind}'`);
  return f(host);
}

/** Builds an OAuth authorize URL (code flow + PKCE S256). */
export function buildAuthorizeUrl(o: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  scopeSeparator?: string;
  extraParams?: Record<string, string>;
}): string {
  const u = new URL(o.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  if (o.scopes.length) u.searchParams.set('scope', o.scopes.join(o.scopeSeparator ?? ' '));
  u.searchParams.set('state', o.state);
  u.searchParams.set('code_challenge', o.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(o.extraParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}
