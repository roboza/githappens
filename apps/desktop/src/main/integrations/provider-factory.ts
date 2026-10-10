import {
  AUTH_INFO,
  authInfo as lookupAuthInfo,
  AZURE_AUTH,
  AZURE_AUTH_INFO,
  BITBUCKET_AUTH,
  BITBUCKET_AUTH_INFO,
  bitbucketCloudErrorMessage,
  bitbucketDcErrorMessage,
  createAzureBoardsTracker,
  createAzureDevOpsProvider,
  createBitbucketCloudProvider,
  createBitbucketDcProvider,
  createGitHubIssueTracker,
  createGitHubProvider,
  createGitLabIssueTracker,
  createGitLabProvider,
  createJiraCloudTracker,
  createJiraDcTracker,
  createRefreshingAuth,
  EtagStore,
  createTrelloTracker,
  HttpClient,
  JIRA_AUTH,
  JIRA_AUTH_INFO,
  jiraErrorMessage,
  listAtlassianSites,
  listAzureOrganizations,
  ProviderError,
  refreshToken,
  RequestGate,
  TRELLO_AUTH,
  TRELLO_AUTH_INFO,
  trelloErrorMessage,
  validateToken,
  type AuthInfo,
  type AuthInfoFactory,
  type ConnectedIntegration,
  type HostingProvider,
  type IntegrationId,
  type IssueTracker,
  type ProviderUser,
  type RateLimitInfo,
} from '@githappens/providers';

import type { IntegrationKind } from '../../shared/ipc/integrations-contract';
import type { StoredCredential } from './account-store';
import type { ProviderFactory } from './integration-service';
import { BROKER_PROVIDER } from './oauth-manager';
import type { OAuthConfig } from './oauth-config';

const AUTH_TABLE: Readonly<Record<string, AuthInfoFactory>> = {
  ...AUTH_INFO,
  ...BITBUCKET_AUTH_INFO,
  ...AZURE_AUTH_INFO,
  ...JIRA_AUTH_INFO,
  ...TRELLO_AUTH_INFO,
};

const DEFAULT_HOSTS: Partial<Record<IntegrationKind, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  'azure-devops': 'dev.azure.com',
  'azure-boards': 'dev.azure.com',
  trello: 'trello.com',
};

export interface ProviderFactoryOptions {
  oauth: OAuthConfig;
  onRateLimit?: (integrationKey: string, r: RateLimitInfo) => void;
  /** Persist rotated OAuth tokens (GitLab, Atlassian and Entra rotate refresh tokens). */
  onCredentialRefreshed: (integrationKey: string, cred: StoredCredential) => void;
  onReauthRequired: (integrationKey: string, reason: string) => void;
}

/** Azure accounts may be scoped to one organization: host `dev.azure.com/<org>`. */
function splitAzureHost(host: string): { host: string; organization?: string } {
  const [h, org] = host.split('/');
  return { host: h!, organization: org || undefined };
}

/**
 * Builds provider clients from stored credentials (spec 10 §5.3). Each client gets its own
 * HttpClient with the kind's base URL, headers and Authorization scheme; refreshable OAuth
 * tokens renew themselves shortly before expiry and are written back to the secret store.
 */
export function createProviderFactory(o: ProviderFactoryOptions): ProviderFactory {
  const info = (kind: IntegrationKind, host: string): AuthInfo | null => {
    try {
      return lookupAuthInfo(kind, host || DEFAULT_HOSTS[kind] || '', AUTH_TABLE);
    } catch {
      return null;
    }
  };

  /** Authorization header for a credential, per kind (Basic for API tokens with a username). */
  const header = (kind: IntegrationKind, token: string, username?: string): string => {
    switch (kind) {
      case 'bitbucket':
        return BITBUCKET_AUTH.authHeader(token, username);
      case 'azure-devops':
      case 'azure-boards':
        return AZURE_AUTH.authHeader(token, username);
      case 'jira-cloud':
        return JIRA_AUTH.authHeader(token, username);
      case 'trello':
        return TRELLO_AUTH.authHeader(token, username);
      default:
        return info(kind, '')?.authorization(token) ?? `Bearer ${token}`;
    }
  };

  const baseUrl = (kind: IntegrationKind, host: string): string => {
    const i = info(kind, host);
    if (!i) throw new ProviderError({ code: 'unsupported', message: `Unsupported service: ${kind}` });
    return i.apiBaseUrl;
  };

  const errorMessage = (
    kind: IntegrationKind,
  ): ((s: number, b: unknown) => string | undefined) | undefined =>
    kind === 'bitbucket'
      ? bitbucketCloudErrorMessage
      : kind === 'bitbucket-dc'
        ? bitbucketDcErrorMessage
        : kind === 'jira-cloud' || kind === 'jira-dc'
          ? jiraErrorMessage
          : kind === 'trello'
            ? trelloErrorMessage
            : undefined;

  // One request budget + ETag cache per connected account, shared by every client built for it (§6.4).
  const gates = new Map<string, RequestGate>();
  const etags = new Map<string, EtagStore>();
  const perKey = <T>(m: Map<string, T>, key: string, make: () => T): T => {
    let v = m.get(key);
    if (!v) m.set(key, (v = make()));
    return v;
  };

  const http = (
    kind: IntegrationKind,
    host: string,
    cred: StoredCredential,
    key: string | null,
    background = false,
  ): HttpClient => {
    const i = info(kind, host);
    let current = cred;
    const auth =
      key && cred.type === 'oauth' && cred.refreshToken && cred.expiresAt
        ? createRefreshingAuth({
            get: () => ({ ...current, scopes: [] }),
            authorization: (t) => header(kind, t),
            refresh: async (cur) => {
              try {
                const viaBroker = i?.oauth === 'broker';
                return await refreshToken({
                  refreshToken: cur.refreshToken!,
                  tokenUrl: i?.tokenUrl,
                  clientId: o.oauth.clientId(kind) ?? undefined,
                  scopes: i?.scopes,
                  brokerUrl: viaBroker ? (o.oauth.brokerUrl ?? undefined) : undefined,
                  kind: BROKER_PROVIDER[kind] ?? kind,
                });
              } catch (e) {
                o.onReauthRequired(key, 'Your sign-in expired. Reconnect the account.');
                throw e;
              }
            },
            save: (next) => {
              current = {
                ...current,
                accessToken: next.accessToken,
                refreshToken: next.refreshToken,
                expiresAt: next.expiresAt,
              };
              o.onCredentialRefreshed(key, current);
            },
          })
        : () => header(kind, cred.accessToken, cred.username);
    return new HttpClient({
      // Jira Cloud OAuth (3LO) goes through api.atlassian.com with the site's cloudId.
      baseUrl:
        kind === 'jira-cloud' && cred.cloudId ? JIRA_AUTH.oauthApiBaseUrl(cred.cloudId) : baseUrl(kind, host),
      headers: i?.headers,
      auth,
      errorMessage: errorMessage(kind),
      onRateLimit: key ? (r) => o.onRateLimit?.(key, r) : undefined,
      userAgent: 'GitHappens',
      gate: key ? perKey(gates, key, () => new RequestGate()) : undefined,
      etagStore: key ? perKey(etags, key, () => new EtagStore()) : undefined,
      background,
    });
  };

  const hosting = (
    kind: IntegrationKind,
    host: string,
    cred: StoredCredential,
    key: string | null,
    integration?: IntegrationId,
    bg = false,
  ): HostingProvider => {
    const accountId = integration?.accountId;
    switch (kind) {
      case 'github':
        return createGitHubProvider({ http: http(kind, host, cred, key, bg), host, accountId });
      case 'gitlab':
        return createGitLabProvider({ http: http(kind, host, cred, key, bg), host, accountId });
      case 'bitbucket':
        return createBitbucketCloudProvider({ http: http(kind, host, cred, key, bg), integration });
      case 'bitbucket-dc':
        return createBitbucketDcProvider({ http: http(kind, host, cred, key, bg), host, integration });
      case 'azure-devops': {
        const a = splitAzureHost(host);
        return createAzureDevOpsProvider({
          http: http(kind, a.host, cred, key, bg),
          host: a.host,
          organization: a.organization,
          integration,
        });
      }
      default:
        throw new ProviderError({ code: 'unsupported', message: `${kind} is not a code hosting service.` });
    }
  };

  const tracker = (
    kind: IntegrationKind,
    host: string,
    cred: StoredCredential,
    key: string | null,
    integration?: IntegrationId,
    bg = false,
  ): IssueTracker | null => {
    switch (kind) {
      case 'github':
        return createGitHubIssueTracker({
          http: http(kind, host, cred, key, bg),
          host,
          accountId: integration?.accountId,
        });
      case 'gitlab':
        return createGitLabIssueTracker({
          http: http(kind, host, cred, key, bg),
          host,
          accountId: integration?.accountId,
        });
      case 'jira-cloud':
        return createJiraCloudTracker({ http: http(kind, host, cred, key, bg), site: host, integration });
      case 'jira-dc':
        return createJiraDcTracker({ http: http(kind, host, cred, key, bg), host, integration });
      case 'trello':
        return createTrelloTracker({ http: http(kind, host, cred, key, bg), integration });
      case 'azure-devops':
      case 'azure-boards': {
        const a = splitAzureHost(host);
        if (!a.organization) return null;
        return createAzureBoardsTracker({
          http: http(kind, a.host, cred, key, bg),
          host: a.host,
          organization: a.organization,
          integration,
        });
      }
      default:
        return null;
    }
  };

  return {
    authInfo: info,
    defaultHost: (kind) => DEFAULT_HOSTS[kind] ?? null,
    patPageUrl: (kind, host) => info(kind, host)?.patPageUrl ?? '',
    gitUsername: (kind, cred) => {
      if (kind === 'bitbucket' && cred.type === 'pat' && cred.username) return cred.username;
      const u = info(kind, '')?.usernameForGit ?? 'git';
      return u === '{username}' ? (cred.username ?? 'git') : u;
    },
    provider: (account, cred, opts) =>
      hosting(account.kind, account.host, cred, account.key, account, !!opts?.background),
    tracker: (account, cred, opts) =>
      tracker(account.kind, account.host, cred, account.key, account, !!opts?.background),

    async organizations(account, cred) {
      if (account.kind === 'azure-devops' || account.kind === 'azure-boards') {
        const vssps = new HttpClient({
          baseUrl: 'https://app.vssps.visualstudio.com',
          auth: () => header(account.kind, cred.accessToken, cred.username),
          userAgent: 'GitHappens',
        });
        return (await listAzureOrganizations(vssps)).map((x) => ({ id: x.name, name: x.name, url: x.url }));
      }
      if (account.kind === 'jira-cloud' && cred.type === 'oauth') {
        const sites = await listAtlassianSites({ token: cred.accessToken });
        return sites.map((x) => ({ id: x.id, name: x.name, url: x.url }));
      }
      return [];
    },

    async validate(kind, host, cred) {
      if (kind === 'github' || kind === 'gitlab') {
        const v = await validateToken(kind, host, cred.accessToken, undefined, AUTH_TABLE);
        if (v.scopesKnown && v.missingScopes.length) {
          throw new ProviderError({
            code: 'insufficient_scope',
            message: `The token is missing required scopes: ${v.missingScopes.join(', ')}.`,
            missingScopes: v.missingScopes,
          });
        }
        return { user: v.user, scopes: v.scopes };
      }
      if (kind === 'jira-cloud' || kind === 'jira-dc') {
        if (kind === 'jira-cloud' && !cred.username && !cred.cloudId) {
          throw new ProviderError({
            code: 'validation',
            message: 'Enter the email address of your Atlassian account.',
          });
        }
        const me = await http(kind, host, cred, null).get<{
          accountId?: string;
          name?: string;
          key?: string;
          displayName?: string;
          emailAddress?: string;
          avatarUrls?: Record<string, string>;
        }>('myself');
        const user: ProviderUser = {
          id: me.accountId ?? me.key ?? me.name ?? '',
          login: me.emailAddress ?? me.name ?? me.displayName ?? '',
          name: me.displayName,
          avatarUrl: me.avatarUrls?.['48x48'],
          email: me.emailAddress,
        };
        return { user, scopes: [] };
      }
      if (kind === 'trello') {
        // Power-Up API key (username field) + user token → GET /1/members/me.
        if (!cred.username) {
          throw new ProviderError({ code: 'validation', message: 'Enter your Trello Power-Up API key.' });
        }
        const me = await http(kind, host, cred, null).get<{
          id: string;
          username?: string;
          fullName?: string;
          avatarUrl?: string | null;
          email?: string | null;
        }>('members/me', { query: { fields: 'id,username,fullName,avatarUrl,email' } });
        const user: ProviderUser = {
          id: me.id,
          login: me.username ?? me.id,
          name: me.fullName,
          avatarUrl: me.avatarUrl ? `${me.avatarUrl}/50.png` : undefined,
          email: me.email ?? undefined,
        };
        return { user, scopes: ['read', 'write'] };
      }
      const hostingKind = kind === 'azure-boards' ? 'azure-devops' : kind;
      const p = hosting(hostingKind, host, cred, null);
      const user = await p.getViewer();
      const scopes = await p.getGrantedScopes().catch(() => []);
      return { user, scopes };
    },
  };
}

export type { ConnectedIntegration };
