/**
 * Per-provider token endpoint knowledge (spec 10 §6.1). Each provider turns a validated
 * grant into an upstream HTTP request; the broker adds the client secret here and nowhere else.
 */
import { type BrokerConfig, type ClientCredentials, type ProviderId } from './config.ts';

export type Grant =
  | { type: 'authorization_code'; code: string; redirectUri: string; codeVerifier?: string; scope?: string }
  | { type: 'refresh_token'; refreshToken: string; scope?: string };

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Upstream token-revocation call (spec 10 §9 "Disconnect"). */
export interface RevokeRequest extends UpstreamRequest {
  method: 'POST' | 'DELETE';
}

export interface ProviderSpec {
  id: ProviderId;
  /** Accepts a `host` field selecting an Enterprise / self-managed instance. */
  multiHost: boolean;
  /** Accepts a `scope` field (Entra ID needs it on every token request). */
  acceptsScope: boolean;
  /** Forward `code_verifier` upstream (providers without PKCE support may reject it). */
  forwardsPkce: boolean;
  defaultHost: string;
  build(creds: ClientCredentials, grant: Grant, host: string, config: BrokerConfig): UpstreamRequest;
  /** Build the token-revocation call; absent when the provider has no revocation API. */
  revoke?(creds: ClientCredentials, token: string, host: string): RevokeRequest;
}

export const AZURE_DEVOPS_DEFAULT_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default offline_access';

const FORM = 'application/x-www-form-urlencoded';
const UA = 'githappens-oauth-broker';

function grantParams(grant: Grant, forwardsPkce: boolean): Record<string, string> {
  if (grant.type === 'authorization_code') {
    const p: Record<string, string> = {
      grant_type: 'authorization_code',
      code: grant.code,
      redirect_uri: grant.redirectUri,
    };
    if (forwardsPkce && grant.codeVerifier) p.code_verifier = grant.codeVerifier;
    return p;
  }
  return { grant_type: 'refresh_token', refresh_token: grant.refreshToken };
}

function form(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

function basicAuth(creds: ClientCredentials): string {
  return `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret ?? ''}`, 'utf8').toString('base64')}`;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  github: {
    id: 'github',
    multiHost: true,
    acceptsScope: false,
    forwardsPkce: true,
    defaultHost: 'github.com',
    build(creds, grant, host) {
      return {
        url: `https://${host}/login/oauth/access_token`,
        headers: { 'content-type': FORM, accept: 'application/json', 'user-agent': UA },
        body: form({
          ...grantParams(grant, this.forwardsPkce),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
      };
    },
    revoke(creds, token, host) {
      // OAuth App token revocation: https://docs.github.com/rest/apps/oauth-applications#delete-an-app-token
      const apiBase = host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
      return {
        method: 'DELETE',
        url: `${apiBase}/applications/${encodeURIComponent(creds.clientId)}/token`,
        headers: {
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': UA,
          authorization: basicAuth(creds),
        },
        body: JSON.stringify({ access_token: token }),
      };
    },
  },
  gitlab: {
    id: 'gitlab',
    multiHost: true,
    acceptsScope: false,
    forwardsPkce: true,
    defaultHost: 'gitlab.com',
    build(creds, grant, host) {
      return {
        url: `https://${host}/oauth/token`,
        headers: { 'content-type': FORM, accept: 'application/json', 'user-agent': UA },
        body: form({
          ...grantParams(grant, this.forwardsPkce),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
      };
    },
    revoke(creds, token, host) {
      // RFC 7009 endpoint; a public (non-confidential) app sends no client_secret.
      return {
        method: 'POST',
        url: `https://${host}/oauth/revoke`,
        headers: { 'content-type': FORM, accept: 'application/json', 'user-agent': UA },
        body: form({ token, client_id: creds.clientId, client_secret: creds.clientSecret }),
      };
    },
  },
  bitbucket: {
    id: 'bitbucket',
    multiHost: false,
    acceptsScope: false,
    forwardsPkce: false,
    defaultHost: 'bitbucket.org',
    build(creds, grant) {
      // Bitbucket Cloud authenticates the consumer with HTTP Basic (key:secret).
      return {
        url: 'https://bitbucket.org/site/oauth2/access_token',
        headers: {
          'content-type': FORM,
          accept: 'application/json',
          'user-agent': UA,
          authorization: basicAuth(creds),
        },
        body: form(grantParams(grant, this.forwardsPkce)),
      };
    },
  },
  atlassian: {
    id: 'atlassian',
    multiHost: false,
    acceptsScope: false,
    forwardsPkce: false,
    defaultHost: 'auth.atlassian.com',
    build(creds, grant) {
      // Atlassian 3LO takes a JSON body.
      return {
        url: 'https://auth.atlassian.com/oauth/token',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({
          ...grantParams(grant, this.forwardsPkce),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
      };
    },
  },
  'azure-devops': {
    id: 'azure-devops',
    multiHost: false,
    acceptsScope: true,
    forwardsPkce: true,
    defaultHost: 'login.microsoftonline.com',
    build(creds, grant, _host, config) {
      return {
        url: `https://login.microsoftonline.com/${encodeURIComponent(config.azureTenant)}/oauth2/v2.0/token`,
        headers: { 'content-type': FORM, accept: 'application/json', 'user-agent': UA },
        body: form({
          ...grantParams(grant, this.forwardsPkce),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: grant.scope ?? AZURE_DEVOPS_DEFAULT_SCOPE,
        }),
      };
    },
  },
};

export function isProviderId(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** Resolve credentials for provider + host, or undefined when this broker does not serve it. */
export function resolveCredentials(
  config: BrokerConfig,
  provider: ProviderSpec,
  host: string,
): ClientCredentials | undefined {
  if (host === provider.defaultHost) return config.providers[provider.id];
  if (provider.id === 'github')
    return Object.hasOwn(config.gheHosts, host) ? config.gheHosts[host] : undefined;
  if (provider.id === 'gitlab') {
    return Object.hasOwn(config.gitlabHosts, host) ? config.gitlabHosts[host] : undefined;
  }
  return undefined;
}

/** Whether the provider has any usable credentials (default host or any enterprise host). */
export function isProviderEnabled(config: BrokerConfig, id: ProviderId): boolean {
  if (config.providers[id]) return true;
  if (id === 'github') return Object.keys(config.gheHosts).length > 0;
  if (id === 'gitlab') return Object.keys(config.gitlabHosts).length > 0;
  return false;
}
