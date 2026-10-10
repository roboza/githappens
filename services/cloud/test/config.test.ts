import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, enabledIdps, loadConfig } from '../src/config.ts';

function issuesOf(env: Record<string, string>, argv: string[] = []): string[] {
  try {
    loadConfig(env, argv);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('loads a production-style configuration', () => {
    const c = loadConfig({
      GH_CLOUD_PUBLIC_URL: 'https://cloud.example.com/',
      GH_CLOUD_DATABASE_URL: 'postgres://kl:pw@db:5432/kl',
      GH_CLOUD_GITHUB_CLIENT_ID: 'gh',
      GH_CLOUD_GITHUB_CLIENT_SECRET: 'secret',
      GH_CLOUD_GITLAB_CLIENT_ID: 'gl',
      GH_CLOUD_GITLAB_CLIENT_SECRET: 'secret',
      GH_CLOUD_GITLAB_URL: 'https://gitlab.example.com',
      GH_CLOUD_MAIL_TRANSPORT: 'webhook',
      GH_CLOUD_MAIL_WEBHOOK: 'https://hooks.example.com/mail',
      GH_CLOUD_PATCH_MAX_EXPIRY_DAYS: '90',
      GH_CLOUD_PORT: '9000',
      GH_CLOUD_TRUST_PROXY: 'true',
    });
    expect(c.publicUrl).toBe('https://cloud.example.com');
    expect(c.port).toBe(9000);
    expect(c.gitlab).toEqual({
      clientId: 'gl',
      clientSecret: 'secret',
      baseUrl: 'https://gitlab.example.com',
    });
    expect(c.patchMaxExpiryDays).toBe(90);
    expect(c.patchMaxBytes).toBe(25 * 1024 * 1024);
    expect(c.trustProxy).toBe(true);
    expect(c.blobDir).toBe('./data/blobs');
    expect(enabledIdps(c)).toEqual(['github', 'gitlab', 'email']);
  });

  it('--dev enables the dev IdP and log mail with an in-memory store', () => {
    const c = loadConfig({}, ['--dev']);
    expect(c.databaseUrl).toBeUndefined();
    expect(c.publicUrl).toBe('http://localhost:8787');
    expect(enabledIdps(c)).toEqual(['email', 'dev']);
  });

  it('reports every problem', () => {
    const issues = issuesOf({
      GH_CLOUD_PUBLIC_URL: 'https://cloud.example.com/sub/path',
      GH_CLOUD_DATABASE_URL: 'mysql://x',
      GH_CLOUD_GITHUB_CLIENT_ID: 'gh',
      GH_CLOUD_MAIL_TRANSPORT: 'webhook',
      GH_CLOUD_PATCH_MAX_BYTES: 'lots',
      GH_CLOUD_SECRET: 'short',
      GH_CLOUD_DEV_LOGIN: 'maybe',
    });
    expect(issues.join('\n')).toMatch(/GH_CLOUD_PUBLIC_URL/);
    expect(issues.join('\n')).toMatch(/postgres/);
    expect(issues.join('\n')).toMatch(/GH_CLOUD_GITHUB_CLIENT_SECRET/);
    expect(issues.join('\n')).toMatch(/GH_CLOUD_MAIL_WEBHOOK is required/);
    expect(issues.join('\n')).toMatch(/GH_CLOUD_PATCH_MAX_BYTES/);
    expect(issues.join('\n')).toMatch(/GH_CLOUD_SECRET/);
    expect(issues.join('\n')).toMatch(/GH_CLOUD_DEV_LOGIN/);
  });

  it('requires at least one identity provider', () => {
    expect(issuesOf({})).toEqual([expect.stringMatching(/no identity provider configured/)]);
  });

  it('exits 78 on invalid configuration', () => {
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toContain('no identity provider configured');
  });
});
