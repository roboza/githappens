import { type AuthInfoFactory, normalizeHost } from '../auth/info';
import { type AuthDescriptor, basicAuth } from '../bitbucket/shared';

/**
 * Azure DevOps: Entra ID v2 (public client + PKCE + loopback) or PAT (Basic with an empty
 * username). Entra access tokens are JWTs ("eyJ…") and go out as Bearer. Spec 10 §6.1.
 */
export const AZURE_AUTH: AuthDescriptor = {
  kind: 'azure-devops',
  defaultHost: 'dev.azure.com',
  authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
  scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access'],
  patPageUrl: (host) => {
    const h = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    // `host` may be 'dev.azure.com/{org}' or '{org}.visualstudio.com'.
    return h.endsWith('.visualstudio.com') || h.includes('/')
      ? `https://${h}/_usersSettings/tokens`
      : 'https://dev.azure.com/_usersSettings/tokens';
  },
  usernameForGit: 'githappens',
  apiBaseUrl: (host) => `https://${host.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`,
  authHeader: (token, username) =>
    token.startsWith('eyJ') && username === undefined ? `Bearer ${token}` : basicAuth(username ?? '', token),
};

export const AZURE_BOARDS_AUTH: AuthDescriptor = { ...AZURE_AUTH, kind: 'azure-boards' };

// ---- AuthInfo factories (same shape as src/auth/info.ts → merge into AUTH_INFO) ----

export const AZURE_PAT_SCOPES = [
  'Code (Read & write)',
  'Work Items (Read & write)',
  'Build (Read & execute)',
  'User Profile (Read)',
  'Project and Team (Read)',
  'Graph (Read)',
];

export const azureDevOpsAuthInfo: AuthInfoFactory = (rawHost) => {
  const host = normalizeHost(rawHost || 'dev.azure.com');
  return {
    kind: 'azure-devops',
    host,
    authorizeUrl: AZURE_AUTH.authorizeUrl,
    tokenUrl: AZURE_AUTH.tokenUrl,
    scopes: AZURE_AUTH.scopes,
    patScopes: AZURE_PAT_SCOPES,
    patPageUrl: AZURE_AUTH.patPageUrl(host),
    usernameForGit: AZURE_AUTH.usernameForGit,
    apiBaseUrl: AZURE_AUTH.apiBaseUrl(host),
    headers: {},
    authorization: (token) => AZURE_AUTH.authHeader(token),
    oauth: 'pkce-public',
    refreshable: true,
    scopeSeparator: ' ',
  };
};

export const AZURE_AUTH_INFO: Readonly<Record<string, AuthInfoFactory>> = {
  'azure-devops': azureDevOpsAuthInfo,
  'azure-boards': (host) => ({ ...azureDevOpsAuthInfo(host), kind: 'azure-boards' }),
};
