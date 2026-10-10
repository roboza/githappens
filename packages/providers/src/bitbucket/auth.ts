import { type AuthInfoFactory, normalizeHost } from '../auth/info';
import { type AuthDescriptor, basicAuth } from './shared';

const stripScheme = (host: string): string => host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

/**
 * Bitbucket Cloud: OAuth consumer (secret → broker) or an Atlassian API token used with
 * Basic `email:token` (app passwords are deprecated). Spec 10 §6.1.
 */
export const BITBUCKET_AUTH: AuthDescriptor = {
  kind: 'bitbucket',
  defaultHost: 'bitbucket.org',
  authorizeUrl: 'https://bitbucket.org/site/oauth2/authorize',
  tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
  scopes: ['account', 'account:write', 'repository:write', 'pullrequest:write', 'pipeline'],
  patPageUrl: () => 'https://id.atlassian.com/manage-profile/security/api-tokens',
  // OAuth access tokens use x-token-auth; API tokens use the Bitbucket username instead.
  usernameForGit: 'x-token-auth',
  apiBaseUrl: () => 'https://api.bitbucket.org/2.0',
  authHeader: (token, username) => (username ? basicAuth(username, token) : `Bearer ${token}`),
};

/** Bitbucket Data Center / Server: HTTP access token as Bearer. */
export const BITBUCKET_DC_AUTH: AuthDescriptor = {
  kind: 'bitbucket-dc',
  defaultHost: '',
  scopes: ['REPO_WRITE', 'PROJECT_ADMIN'],
  patPageUrl: (host) => `https://${stripScheme(host)}/plugins/servlet/access-tokens/manage`,
  usernameForGit: '{username}',
  apiBaseUrl: (host) => `https://${stripScheme(host)}/rest/api/latest`,
  authHeader: (token) => `Bearer ${token}`,
};

// ---- AuthInfo factories (same shape as src/auth/info.ts → merge into AUTH_INFO) ----

export const bitbucketAuthInfo: AuthInfoFactory = () => ({
  kind: 'bitbucket',
  host: 'bitbucket.org',
  authorizeUrl: BITBUCKET_AUTH.authorizeUrl,
  tokenUrl: BITBUCKET_AUTH.tokenUrl,
  scopes: BITBUCKET_AUTH.scopes,
  patScopes: [
    'read:user:bitbucket',
    'read:workspace:bitbucket',
    'write:repository:bitbucket',
    'write:pullrequest:bitbucket',
    'read:pipeline:bitbucket',
    'write:ssh-key:bitbucket',
  ],
  patPageUrl: BITBUCKET_AUTH.patPageUrl('bitbucket.org'),
  usernameForGit: BITBUCKET_AUTH.usernameForGit,
  apiBaseUrl: BITBUCKET_AUTH.apiBaseUrl('bitbucket.org'),
  headers: {},
  // OAuth tokens. API tokens need Basic `email:token` → use BITBUCKET_AUTH.authHeader(token, email).
  authorization: (token) => BITBUCKET_AUTH.authHeader(token),
  oauth: 'broker',
  refreshable: true,
  scopeSeparator: ' ',
});

export const bitbucketDcAuthInfo: AuthInfoFactory = (rawHost) => {
  const host = normalizeHost(rawHost);
  return {
    kind: 'bitbucket-dc',
    host,
    scopes: [],
    patScopes: BITBUCKET_DC_AUTH.scopes,
    patPageUrl: BITBUCKET_DC_AUTH.patPageUrl(host),
    usernameForGit: BITBUCKET_DC_AUTH.usernameForGit,
    apiBaseUrl: BITBUCKET_DC_AUTH.apiBaseUrl(host),
    headers: {},
    authorization: (token) => BITBUCKET_DC_AUTH.authHeader(token),
    oauth: 'none',
    refreshable: false,
    scopeSeparator: ' ',
  };
};

export const BITBUCKET_AUTH_INFO: Readonly<Record<string, AuthInfoFactory>> = {
  bitbucket: bitbucketAuthInfo,
  'bitbucket-dc': bitbucketDcAuthInfo,
};
