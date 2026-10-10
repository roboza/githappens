import type { IntegrationKind } from '../../shared/ipc/integrations-contract';

/**
 * OAuth app registration (spec 10 §4.1). Client ids are public; secrets live only in the
 * OAuth broker (services/oauth-broker). Nothing is configured by default — PATs always work,
 * and OAuth buttons appear once the matching ids are provided at build or launch time.
 *
 * - `GH_OAUTH_BROKER_URL`        broker base URL (GitHub, Bitbucket, Jira code exchange)
 * - `GH_OAUTH_<KIND>_CLIENT_ID`  per kind, e.g. GH_OAUTH_GITHUB_CLIENT_ID, GH_OAUTH_AZURE_DEVOPS_CLIENT_ID
 */
export interface OAuthConfig {
  brokerUrl: string | null;
  clientId(kind: IntegrationKind): string | null;
}

const envName = (kind: string): string =>
  `GH_OAUTH_${kind.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CLIENT_ID`;

export function oauthConfigFromEnv(env: Record<string, string | undefined> = process.env): OAuthConfig {
  const brokerUrl = env.GH_OAUTH_BROKER_URL?.trim() || null;
  return {
    brokerUrl,
    clientId: (kind) => env[envName(kind)]?.trim() || null,
  };
}
