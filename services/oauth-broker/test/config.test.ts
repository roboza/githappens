import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('loads a full configuration with defaults', () => {
    const config = loadConfig({
      GH_GITHUB_CLIENT_ID: 'gh',
      GH_GITHUB_CLIENT_SECRET: 's1',
      GH_GITLAB_CLIENT_ID: 'gl',
      GH_BITBUCKET_CLIENT_ID: 'bb',
      GH_BITBUCKET_CLIENT_SECRET: 's2',
      GH_ATLASSIAN_CLIENT_ID: 'atl',
      GH_ATLASSIAN_CLIENT_SECRET: 's3',
      GH_AZURE_CLIENT_ID: 'az',
      GH_GHE_HOSTS: JSON.stringify({ 'GHE.Corp.example:8443': { clientId: 'g', clientSecret: 's' } }),
      GH_GITLAB_HOSTS: JSON.stringify({ 'gitlab.corp.example': { clientId: 'g' } }),
      GH_BROKER_PORT: '9000',
      GH_BROKER_TRUST_PROXY: 'true',
    });
    expect(config.port).toBe(9000);
    expect(config.trustProxy).toBe(true);
    expect(config.azureTenant).toBe('organizations');
    expect(config.maxBodyBytes).toBe(8192);
    expect(config.providers.gitlab).toEqual({ clientId: 'gl' });
    expect(config.providers['azure-devops']).toEqual({ clientId: 'az' });
    expect(config.gheHosts['ghe.corp.example:8443']).toEqual({ clientId: 'g', clientSecret: 's' });
    expect(config.gitlabHosts['gitlab.corp.example']).toEqual({ clientId: 'g' });
  });

  it('falls back to PORT', () => {
    expect(loadConfig({ PORT: '3000', GH_GITLAB_CLIENT_ID: 'gl' }).port).toBe(3000);
  });

  it('requires at least one provider', () => {
    expect(issuesOf({})).toEqual([expect.stringMatching(/no provider configured/)]);
  });

  it('requires secrets for confidential-only providers', () => {
    const issues = issuesOf({
      GH_GITHUB_CLIENT_ID: 'gh',
      GH_BITBUCKET_CLIENT_ID: 'bb',
      GH_ATLASSIAN_CLIENT_ID: 'atl',
    });
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toMatch(/GH_GITHUB_CLIENT_SECRET/);
  });

  it('reports every problem at once', () => {
    const issues = issuesOf({
      GH_GITLAB_CLIENT_ID: 'gl',
      GH_BROKER_PORT: 'abc',
      GH_GHE_HOSTS: '{not json',
      GH_GITLAB_HOSTS: JSON.stringify({ 'bad host/': { clientId: 'x' } }),
      GH_AZURE_TENANT: 'bad tenant!',
      GH_BROKER_TRUST_PROXY: 'maybe',
      GH_BITBUCKET_CLIENT_SECRET: 'orphan',
    });
    expect(issues.length).toBeGreaterThanOrEqual(6);
  });

  it('does not echo secret values in error messages', () => {
    try {
      loadConfig({ GH_GITHUB_CLIENT_SECRET: 'super-secret-value' });
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-value');
      return;
    }
    throw new Error('expected ConfigError');
  });
});
