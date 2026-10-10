import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GitError } from '@githappens/git';
import { ProviderError, type HostingProvider, type PullRequest } from '@githappens/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountStore } from '../src/main/integrations/account-store';
import {
  IntegrationService,
  toIpcProviderError,
  type ProviderFactory,
} from '../src/main/integrations/integration-service';
import { oauthConfigFromEnv } from '../src/main/integrations/oauth-config';
import type { SecretStore } from '../src/main/secrets/secret-store';
import type { RepoManager } from '../src/main/services/repo-manager';

class MemorySecrets implements SecretStore {
  readonly available = true;
  readonly backend = 'memory';
  readonly map = new Map<string, string>();
  get(a: string): string | null {
    return this.map.get(a) ?? null;
  }
  set(a: string, s: string): void {
    this.map.set(a, s);
  }
  delete(a: string): boolean {
    return this.map.delete(a);
  }
  deleteByPrefix(p: string): number {
    let n = 0;
    for (const k of [...this.map.keys()]) if (k.startsWith(p) && this.map.delete(k)) n++;
    return n;
  }
  listAccounts(p = ''): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(p));
  }
}

const pr = (over: Partial<PullRequest>): PullRequest =>
  ({
    repo: { integration: { kind: 'github', host: 'github.com', accountId: '1' }, owner: 'acme', name: 'app' },
    number: 1,
    id: '1',
    title: 't',
    body: '',
    state: 'open',
    author: { id: '1', login: 'octo' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    head: { repo: null, branch: 'feature', sha: 'a'.repeat(40) },
    base: { repo: null as never, branch: 'main' },
    reviewers: [],
    assignees: [],
    labels: [],
    checksRollup: 'none',
    rollup: 'none',
    isCrossRepository: false,
    webUrl: 'https://github.com/acme/app/pull/1',
    ...over,
  }) as PullRequest;

describe('IntegrationService (spec 10 §5.4)', () => {
  let dir: string;
  let secrets: MemorySecrets;
  let accounts: AccountStore;
  let provider: Partial<HostingProvider>;
  let factory: ProviderFactory;
  let runOp: ReturnType<typeof vi.fn>;
  let svc: IntegrationService;
  const changed = vi.fn();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-int-'));
    secrets = new MemorySecrets();
    accounts = new AccountStore(
      () => dir,
      () => 'p1',
      secrets,
    );
    provider = {
      kind: 'github',
      capabilities: { prRefspec: 'refs/pull/{n}/head' } as HostingProvider['capabilities'],
      matchRemoteUrl: (url: string) => {
        const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
        return m ? { owner: m[1]!, name: m[2]! } : null;
      },
      listPullRequests: vi.fn(async (_ref: unknown, filter: { state?: string }) => ({
        items:
          filter.state && filter.state !== 'open'
            ? []
            : [
                pr({ number: 2, updatedAt: '2026-01-02T00:00:00Z' }),
                pr({
                  number: 3,
                  isCrossRepository: true,
                  head: { repo: null, branch: 'fork', sha: 'b'.repeat(40) },
                }),
              ],
      })),
    };
    factory = {
      provider: () => provider as HostingProvider,
      tracker: () => null,
      validate: async (_k, _h, cred) => {
        if (cred.accessToken === 'bad')
          throw new ProviderError({ code: 'auth_required', message: 'Bad credentials' });
        return { user: { id: '1', login: 'octo', name: 'Octo' }, scopes: ['repo'] };
      },
      patPageUrl: (_k, h) => `https://${h}/settings/tokens/new`,
      gitUsername: () => 'x-access-token',
      defaultHost: (k) => (k === 'github' ? 'github.com' : null),
      authInfo: () => null,
    };
    runOp = vi.fn(async (_id: string, op: { localBranch?: string }) => ({
      opId: 'o',
      summary: '',
      data: { branch: op.localBranch },
    }));
    const repos = {
      get: () => ({
        remotes: async () => [
          { name: 'origin', fetchUrl: 'git@github.com:acme/app.git', pushUrl: '', fetchRefspecs: [] },
          { name: 'gl', fetchUrl: 'https://gitlab.com/acme/app.git', pushUrl: '', fetchRefspecs: [] },
        ],
        repo: { worktreeRoot: dir },
      }),
      runOp,
    } as unknown as RepoManager;
    svc = new IntegrationService(accounts, factory, repos, { changed, prIndex: vi.fn() });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('connects a PAT: token only in the secret store, metadata on disk', async () => {
    const meta = await svc.connect('github', '', { type: 'pat', accessToken: 'ghp_secret' }, 'pat');
    expect(meta).toMatchObject({ kind: 'github', host: 'github.com', login: 'octo', authType: 'pat' });
    const onDisk = fs.readFileSync(path.join(dir, 'integrations.json'), 'utf8');
    expect(onDisk).not.toContain('ghp_secret');
    expect(secrets.get(`p1/integration/${meta.key}`)).toContain('ghp_secret');
    expect(changed).toHaveBeenCalled();
    expect(svc.gitLogin('github.com')).toEqual({ username: 'x-access-token', password: 'ghp_secret' });
    expect(svc.gitLogin('gitlab.com')).toBeNull();

    svc.disconnect(meta.key);
    expect(svc.list()).toEqual([]);
    expect(secrets.map.size).toBe(0);
  });

  it('maps provider failures to IPC errors with providerCode', async () => {
    const err = await svc
      .connect('github', 'github.com', { type: 'pat', accessToken: 'bad' }, 'pat')
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).serialized.details?.providerCode).toBe('auth_required');
    expect(svc.list()).toEqual([]);
    const plain = new Error('x');
    expect(toIpcProviderError(plain)).toBe(plain);
  });

  it('resolves remotes to provider + account', async () => {
    const unconnected = await svc.resolveRemotes('r');
    expect(unconnected.map((r) => [r.remote, r.kind, r.integrationKey])).toEqual([
      ['origin', 'github', undefined],
      ['gl', 'gitlab', undefined],
    ]);
    const meta = await svc.connect('github', 'github.com', { type: 'pat', accessToken: 't' }, 'pat');
    const [origin] = await svc.resolveRemotes('r');
    expect(origin).toMatchObject({ integrationKey: meta.key, owner: 'acme', name: 'app' });
  });

  it('builds web links per provider', async () => {
    expect(await svc.webUrl('r', { kind: 'commit', sha: 'abc' })).toBe(
      'https://github.com/acme/app/commit/abc',
    );
    expect(await svc.webUrl('r', { kind: 'branch', name: 'feat/x' })).toBe(
      'https://github.com/acme/app/tree/feat/x',
    );
  });

  it('indexes open same-repo PRs by branch and caches the result', async () => {
    await svc.connect('github', 'github.com', { type: 'pat', accessToken: 't' }, 'pat');
    const entries = await svc.prIndex('r');
    expect(entries).toEqual([
      expect.objectContaining({
        remote: 'origin',
        branch: 'feature',
        pr: expect.objectContaining({ number: 2 }),
      }),
    ]);
    await svc.prIndex('r');
    // open + merged + closed per provider remote
    expect(provider.listPullRequests).toHaveBeenCalledTimes(3);
    await svc.prIndex('r', true);
    expect(provider.listPullRequests).toHaveBeenCalledTimes(6);
  });

  it('checks out fork PRs under pr/<n>-<branch> through the pr.checkout op', async () => {
    await svc.connect('github', 'github.com', { type: 'pat', accessToken: 't' }, 'pat');
    const r = await svc.checkoutPr(
      'r',
      pr({ number: 9, isCrossRepository: true, head: { repo: null, branch: 'fix it', sha: 'c'.repeat(40) } }),
    );
    expect(r.branch).toBe('pr/9-fix-it');
    expect(runOp).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({
        type: 'pr.checkout',
        remote: 'origin',
        sameRepo: false,
        refspec: 'refs/pull/{n}/head',
      }),
    );
  });

  it('prefers repository PR templates over the provider', async () => {
    fs.mkdirSync(path.join(dir, '.github'));
    fs.writeFileSync(path.join(dir, '.github', 'pull_request_template.md'), '## Summary\n');
    const ref = {
      integration: { kind: 'github' as const, host: 'github.com', accountId: '1' },
      owner: 'acme',
      name: 'app',
    };
    expect(await svc.templates('r', ref, 'main')).toEqual([
      { name: 'Default', path: '.github/pull_request_template.md', body: '## Summary\n' },
    ]);
  });
});

describe('oauthConfigFromEnv', () => {
  it('reads per-kind client ids and the broker url', () => {
    const c = oauthConfigFromEnv({ GH_OAUTH_AZURE_DEVOPS_CLIENT_ID: 'az', GH_OAUTH_BROKER_URL: 'https://b' });
    expect(c.clientId('azure-devops')).toBe('az');
    expect(c.clientId('github')).toBeNull();
    expect(c.brokerUrl).toBe('https://b');
  });
});
