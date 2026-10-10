import { HttpClient } from '../http';
import { type AuthInfoFactory, normalizeHost } from '../auth/info';
import { type AuthDescriptor, basicAuth } from '../bitbucket/shared';

const stripScheme = (host: string): string => host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

/**
 * Jira Cloud: Atlassian OAuth 2.0 (3LO; secret → broker; rotating refresh tokens) against
 * `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`, or email + API token (Basic)
 * against `https://{site}/rest/api/3`. Spec 10 §6.1.
 */
export const JIRA_AUTH: AuthDescriptor & {
  audience: string;
  accessibleResourcesUrl: string;
  oauthApiBaseUrl(cloudId: string): string;
} = {
  kind: 'jira-cloud',
  defaultHost: 'atlassian.net',
  authorizeUrl: 'https://auth.atlassian.com/authorize',
  tokenUrl: 'https://auth.atlassian.com/oauth/token',
  audience: 'api.atlassian.com',
  accessibleResourcesUrl: 'https://api.atlassian.com/oauth/token/accessible-resources',
  scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
  patPageUrl: () => 'https://id.atlassian.com/manage-profile/security/api-tokens',
  usernameForGit: '',
  apiBaseUrl: (host) => `https://${stripScheme(host)}/rest/api/3`,
  oauthApiBaseUrl: (cloudId) => `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`,
  authHeader: (token, username) => (username ? basicAuth(username, token) : `Bearer ${token}`),
};

/** Jira Data Center: personal access token as Bearer. */
export const JIRA_DC_AUTH: AuthDescriptor = {
  kind: 'jira-dc',
  defaultHost: '',
  scopes: [],
  patPageUrl: (host) =>
    `https://${stripScheme(host)}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`,
  usernameForGit: '',
  apiBaseUrl: (host) => `https://${stripScheme(host)}/rest/api/2`,
  authHeader: (token) => `Bearer ${token}`,
};

// ---- AuthInfo factories (same shape as src/auth/info.ts → merge into AUTH_INFO) ----

/** `host` is the site ('acme.atlassian.net'); OAuth callers re-point apiBaseUrl via JIRA_AUTH.oauthApiBaseUrl(cloudId). */
export const jiraCloudAuthInfo: AuthInfoFactory = (rawHost) => {
  const host = normalizeHost(rawHost);
  return {
    kind: 'jira-cloud',
    host,
    authorizeUrl: JIRA_AUTH.authorizeUrl,
    tokenUrl: JIRA_AUTH.tokenUrl,
    scopes: JIRA_AUTH.scopes,
    patScopes: [],
    patPageUrl: JIRA_AUTH.patPageUrl(host),
    usernameForGit: '',
    apiBaseUrl: JIRA_AUTH.apiBaseUrl(host),
    headers: {},
    // OAuth (Bearer). API tokens need Basic `email:token` → JIRA_AUTH.authHeader(token, email).
    authorization: (token) => JIRA_AUTH.authHeader(token),
    oauth: 'broker',
    refreshable: true,
    scopeSeparator: ' ',
  };
};

export const jiraDcAuthInfo: AuthInfoFactory = (rawHost) => {
  const host = normalizeHost(rawHost);
  return {
    kind: 'jira-dc',
    host,
    scopes: [],
    patScopes: [],
    patPageUrl: JIRA_DC_AUTH.patPageUrl(host),
    usernameForGit: '',
    apiBaseUrl: JIRA_DC_AUTH.apiBaseUrl(host),
    headers: {},
    authorization: (token) => JIRA_DC_AUTH.authHeader(token),
    oauth: 'none',
    refreshable: false,
    scopeSeparator: ' ',
  };
};

export const JIRA_AUTH_INFO: Readonly<Record<string, AuthInfoFactory>> = {
  'jira-cloud': jiraCloudAuthInfo,
  'jira-dc': jiraDcAuthInfo,
};

/** An Atlassian site the OAuth 3LO token can reach (cloudId → `JIRA_AUTH.oauthApiBaseUrl`). */
export interface AtlassianSite {
  /** cloudId */
  id: string;
  name: string;
  /** 'https://acme.atlassian.net' */
  url: string;
  scopes: string[];
}

/** `GET https://api.atlassian.com/oauth/token/accessible-resources` (Bearer) — spec 10 §6.1. */
export async function listAtlassianSites(o: {
  token: string;
  fetch?: typeof fetch;
}): Promise<AtlassianSite[]> {
  const http = new HttpClient({
    baseUrl: 'https://api.atlassian.com',
    retries: 0,
    fetch: o.fetch,
    auth: () => `Bearer ${o.token}`,
    timeoutMs: 30_000,
  });
  const r = await http.get<Array<{ id: string; name?: string; url: string; scopes?: string[] }>>(
    JIRA_AUTH.accessibleResourcesUrl,
  );
  return (r ?? []).map((s) => ({ id: s.id, name: s.name ?? s.url, url: s.url, scopes: s.scopes ?? [] }));
}
