import { randomUUID } from 'node:crypto';

import {
  brokerExchange,
  exchangeCode,
  JIRA_AUTH,
  listAtlassianSites,
  ProviderError,
  revokeToken,
  runGitHubDeviceFlow,
  runLoopbackOAuth,
  type AuthInfo,
  type TokenSet,
} from '@githappens/providers';

import type { IntegrationKind, IntegrationsEventContract } from '../../shared/ipc/integrations-contract';
import type { OAuthFlows } from '../ipc/integrations-handlers';
import type { IntegrationService } from './integration-service';
import type { OAuthConfig } from './oauth-config';

export interface OAuthManagerOptions {
  service: IntegrationService;
  authInfo: (kind: IntegrationKind, host: string) => AuthInfo | null;
  config: OAuthConfig;
  openExternal: (url: string) => void | Promise<void>;
  progress: (p: IntegrationsEventContract['auth:oauthProgress']) => void;
}

/** Provider names on the broker's `/token/:provider` route (services/oauth-broker). */
export const BROKER_PROVIDER: Partial<Record<IntegrationKind, string>> = {
  'jira-cloud': 'atlassian',
  'azure-boards': 'azure-devops',
};

const ALL_KINDS: IntegrationKind[] = [
  'github',
  'gitlab',
  'bitbucket',
  'bitbucket-dc',
  'azure-devops',
  'jira-cloud',
  'jira-dc',
];

/**
 * OAuth sign-in (spec 10 §4.1): system browser only, never an embedded window.
 * GitHub uses the device flow when no broker is configured; public PKCE clients
 * (GitLab, Entra ID) exchange directly; secret-holding providers go through the broker.
 */
export class OAuthManager implements OAuthFlows {
  private readonly flows = new Map<string, AbortController>();

  constructor(private readonly o: OAuthManagerOptions) {}

  availability(): Partial<Record<IntegrationKind, boolean>> {
    const out: Partial<Record<IntegrationKind, boolean>> = {};
    for (const kind of ALL_KINDS) out[kind] = this.mode(kind, '') !== null;
    return out;
  }

  start(kind: IntegrationKind, host: string | undefined): { flowId: string } {
    const flowId = randomUUID();
    const ac = new AbortController();
    this.flows.set(flowId, ac);
    void this.run(flowId, kind, host ?? '', ac.signal).finally(() => this.flows.delete(flowId));
    return { flowId };
  }

  cancel(flowId: string): void {
    this.flows.get(flowId)?.abort();
  }

  /**
   * Best-effort token revocation before disconnecting (spec 10 §9): GitLab directly (public PKCE client),
   * GitHub through the broker (needs the client secret). Providers without an API return 'unsupported'.
   */
  async revoke(integrationKey: string): Promise<'revoked' | 'unsupported'> {
    const account = this.o.service.list().find((a) => a.key === integrationKey);
    const cred = this.o.service.credential(integrationKey);
    if (!account || !cred || cred.type !== 'oauth') return 'unsupported';
    return revokeToken({
      kind: BROKER_PROVIDER[account.kind] ?? account.kind,
      host: account.host.split('/')[0],
      token: cred.accessToken,
      clientId: this.o.config.clientId(account.kind) ?? undefined,
      brokerUrl: this.o.config.brokerUrl ?? undefined,
    });
  }

  private mode(
    kind: IntegrationKind,
    host: string,
  ): { info: AuthInfo; clientId: string; via: 'device' | 'pkce' | 'broker' } | null {
    const info = this.o.authInfo(kind, host);
    const clientId = this.o.config.clientId(kind);
    if (!info || !clientId || info.oauth === 'none') return null;
    if (kind === 'github' && info.deviceCodeUrl && !this.o.config.brokerUrl)
      return { info, clientId, via: 'device' };
    if (info.oauth === 'pkce-public') return { info, clientId, via: 'pkce' };
    return this.o.config.brokerUrl ? { info, clientId, via: 'broker' } : null;
  }

  private async run(flowId: string, kind: IntegrationKind, host: string, signal: AbortSignal): Promise<void> {
    try {
      const m = this.mode(kind, host);
      if (!m)
        throw new Error(
          'Sign-in with the browser is not configured for this service. Use a personal access token.',
        );
      const { info, clientId } = m;
      let tokens: TokenSet;
      if (m.via === 'device') {
        tokens = await runGitHubDeviceFlow({
          host: info.host,
          clientId,
          scopes: info.scopes,
          signal,
          onUserCode: async (d) => {
            this.o.progress({
              flowId,
              phase: 'device-code',
              userCode: d.userCode,
              verificationUri: d.verificationUri,
            });
            await this.o.openExternal(d.verificationUri);
          },
        });
      } else {
        const brokerUrl = this.o.config.brokerUrl;
        tokens = await runLoopbackOAuth({
          authorizeUrl: info.authorizeUrl!,
          clientId,
          scopes: info.scopes,
          scopeSeparator: info.scopeSeparator,
          signal,
          openBrowser: async (url) => {
            await this.o.openExternal(url);
            this.o.progress({ flowId, phase: 'browser-opened' });
          },
          // Atlassian 3LO needs the API audience and an explicit consent prompt.
          extraParams:
            kind === 'jira-cloud' ? { audience: JIRA_AUTH.audience, prompt: 'consent' } : undefined,
          tokenExchange: (code, codeVerifier, redirectUri) => {
            this.o.progress({ flowId, phase: 'exchanging' });
            return m.via === 'broker'
              ? brokerExchange({
                  brokerUrl: brokerUrl!,
                  kind: BROKER_PROVIDER[kind] ?? kind,
                  code,
                  codeVerifier,
                  redirectUri,
                })
              : exchangeCode({ tokenUrl: info.tokenUrl!, clientId, code, codeVerifier, redirectUri });
          },
        });
      }
      this.o.progress({ flowId, phase: 'exchanging' });
      let connectHost = info.host;
      let cloudId: string | undefined;
      if (kind === 'jira-cloud') {
        // 3LO tokens are not site-bound: pick the requested site (host) or the first accessible one.
        const sites = await listAtlassianSites({ token: tokens.accessToken });
        const want = host
          .replace(/^https?:\/\//, '')
          .replace(/\/+$/, '')
          .toLowerCase();
        const site = sites.find((x) => want && x.url.toLowerCase().includes(want)) ?? sites[0];
        if (!site) throw new Error('This Atlassian account has no Jira sites.');
        cloudId = site.id;
        connectHost = site.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      }
      await this.o.service.connect(
        kind,
        connectHost,
        {
          type: 'oauth',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          ...(cloudId ? { cloudId } : {}),
        },
        'oauth',
      );
      this.o.progress({ flowId, phase: 'done' });
    } catch (e) {
      const error =
        e instanceof ProviderError
          ? e.serialized.message
          : e instanceof Error
            ? e.message
            : 'Sign-in failed.';
      this.o.progress({ flowId, phase: 'error', error });
    }
  }
}
