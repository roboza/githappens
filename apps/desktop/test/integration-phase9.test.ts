import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ConnectedIntegration,
  HostingProvider,
  IssueRef,
  IssueTracker,
  PullRequest,
} from '@githappens/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountStore } from '../src/main/integrations/account-store';
import {
  buildWebUrl,
  IntegrationService,
  prIndexEntries,
  RECENT_PR_MS,
  selfAssignee,
  type ProviderFactory,
} from '../src/main/integrations/integration-service';
import { inferIssueLink } from '../src/main/integrations/issue-links';
import { sanitizePrFilters } from '../src/main/integrations/pr-filters';
import { createProviderFactory } from '../src/main/integrations/provider-factory';
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

const GH = { kind: 'github' as const, host: 'github.com', accountId: '1' };
const pr = (over: Partial<PullRequest>): PullRequest =>
  ({
    repo: { integration: GH, owner: 'acme', name: 'app' },
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

describe('issue link inference (spec 10 §4.9)', () => {
  const jira = {
    key: 'jira-cloud:acme.atlassian.net:u1',
    kind: 'jira-cloud' as const,
    host: 'acme.atlassian.net',
  };
  const repo = {
    integrationKey: 'github:github.com:1',
    kind: 'github' as const,
    owner: 'acme',
    name: 'app',
    webBase: 'https://github.com/acme/app',
  };

  it('maps Jira keys to the connected Jira site', () => {
    expect(inferIssueLink('feature/ABC-123-add-login', { accounts: [jira] })).toEqual({
      trackerKind: 'jira-cloud',
      integrationKey: jira.key,
      scope: 'ABC',
      key: 'ABC-123',
      webUrl: 'https://acme.atlassian.net/browse/ABC-123',
    });
    expect(inferIssueLink('ABC-7', { accounts: [jira] })?.key).toBe('ABC-7');
    expect(inferIssueLink('abc-7-lowercase', { accounts: [jira] })).toBeNull();
  });

  it('maps leading numbers to the repo’s GitHub/GitLab issues', () => {
    expect(inferIssueLink('42-fix-crash', { accounts: [], repo })).toMatchObject({
      key: '#42',
      scope: 'acme/app',
      webUrl: 'https://github.com/acme/app/issues/42',
    });
    expect(inferIssueLink('fix/#7', { accounts: [], repo })?.key).toBe('#7');
    expect(
      inferIssueLink('12-x', {
        accounts: [],
        repo: { ...repo, kind: 'gitlab', webBase: 'https://gitlab.com/a/b' },
      })?.webUrl,
    ).toBe('https://gitlab.com/a/b/-/issues/12');
    expect(inferIssueLink('release-2026', { accounts: [], repo })).toBeNull();
    expect(inferIssueLink('ABC-1-x', { accounts: [], repo: undefined })).toBeNull();
  });
});

describe('PR filters (pr-filters.json)', () => {
  it('sanitizes saved filters', () => {
    expect(
      sanitizePrFilters([
        { id: 'a', name: ' Bugs ', filter: { query: 'label:bug', state: 'open', preset: 'bogus' } },
        { id: 'a', name: 'dup', filter: {} },
        { id: '', name: 'no id', filter: {} },
        null,
        { id: 'b', name: 'Merged', filter: { state: 'merged', author: 'octo', extra: 1 } },
      ]),
    ).toEqual([
      { id: 'a', name: 'Bugs', filter: { state: 'open', query: 'label:bug' } },
      { id: 'b', name: 'Merged', filter: { state: 'merged', author: 'octo' } },
    ]);
    expect(() => sanitizePrFilters('x')).toThrow();
  });
});

describe('PR index states (spec 10 §4.6)', () => {
  it('keeps open PRs and PRs merged/closed in the last 7 days', () => {
    const now = Date.parse('2026-10-10T00:00:00Z');
    const day = 24 * 3600_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const entries = prIndexEntries(
      'origin',
      [
        pr({ number: 1, state: 'open', head: { repo: null, branch: 'a', sha: '' } }),
        pr({
          number: 2,
          state: 'merged',
          mergedAt: iso(now - 2 * day),
          head: { repo: null, branch: 'b', sha: '' },
        }),
        pr({
          number: 3,
          state: 'merged',
          mergedAt: iso(now - RECENT_PR_MS - day),
          head: { repo: null, branch: 'c', sha: '' },
        }),
        pr({
          number: 4,
          state: 'closed',
          closedAt: iso(now - day),
          head: { repo: null, branch: 'd', sha: '' },
        }),
        pr({ number: 5, state: 'draft', isCrossRepository: true }),
      ],
      now,
    );
    expect(entries.map((e) => [e.branch, e.pr.number, e.pr.state])).toEqual([
      ['a', 1, 'open'],
      ['b', 2, 'merged'],
      ['d', 4, 'closed'],
    ]);
    expect(entries[1]!.pr.mergedAt).toBe(iso(now - 2 * day));
  });
});

describe('provider web links (spec 10 §11)', () => {
  it('builds links per provider', () => {
    const file = { kind: 'file' as const, path: 'src/a b.ts', rev: 'abc', line: 3, endLine: 5 };
    expect(buildWebUrl('github', 'git@github.com:o/r.git', 'github.com', file)).toBe(
      'https://github.com/o/r/blob/abc/src/a%20b.ts#L3-L5',
    );
    expect(buildWebUrl('github', 'https://github.com/o/r', 'github.com', { kind: 'pr', number: 4 })).toBe(
      'https://github.com/o/r/pull/4',
    );
    expect(buildWebUrl('gitlab', 'https://gitlab.com/g/s/r.git', 'gitlab.com', file)).toBe(
      'https://gitlab.com/g/s/r/-/blob/abc/src/a%20b.ts#L3-5',
    );
    expect(
      buildWebUrl('gitlab', 'https://gitlab.com/g/r.git', 'gitlab.com', {
        kind: 'compare',
        base: 'main',
        head: 'f',
      }),
    ).toBe('https://gitlab.com/g/r/-/compare/main...f');
    expect(buildWebUrl('bitbucket', 'https://bitbucket.org/w/r.git', 'bitbucket.org', file)).toBe(
      'https://bitbucket.org/w/r/src/abc/src/a%20b.ts#lines-3:5',
    );
    expect(
      buildWebUrl('bitbucket-dc', 'https://bb.acme.com/scm/key/repo.git', 'bb.acme.com', {
        kind: 'commit',
        sha: 'abc',
      }),
    ).toBe('https://bb.acme.com/projects/KEY/repos/repo/commits/abc');
    expect(
      buildWebUrl('azure-devops', 'git@ssh.dev.azure.com:v3/org/proj/repo', 'ssh.dev.azure.com', {
        kind: 'branch',
        name: 'feat/x',
      }),
    ).toBe('https://dev.azure.com/org/proj/_git/repo?version=GBfeat%2Fx');
    expect(
      buildWebUrl('azure-devops', 'https://dev.azure.com/org/proj/_git/repo', 'dev.azure.com', {
        kind: 'pr',
        number: 9,
      }),
    ).toBe('https://dev.azure.com/org/proj/_git/repo/pullrequest/9');
    expect(buildWebUrl('github', 'not a url', '', { kind: 'repo' })).toBeNull();
  });
});

describe('IntegrationService phase-9 operations', () => {
  let dir: string;
  let accounts: AccountStore;
  let provider: Partial<HostingProvider>;
  let tracker: Partial<IssueTracker>;
  let runOp: ReturnType<typeof vi.fn>;
  let runRead: ReturnType<typeof vi.fn>;
  let svc: IntegrationService;
  let orgs: Array<{ id: string; name: string; url?: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-int9-'));
    accounts = new AccountStore(
      () => dir,
      () => 'p1',
      new MemorySecrets(),
    );
    provider = {
      kind: 'github',
      capabilities: { prRefspec: 'refs/pull/{n}/head' } as HostingProvider['capabilities'],
      matchRemoteUrl: (url: string) => {
        const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
        return m ? { owner: m[1]!, name: m[2]! } : null;
      },
      listPullRequests: vi.fn(async () => ({ items: [] })),
      listCiRuns: vi.fn(async () => ({
        items: [
          {
            id: '3',
            name: 'CI',
            group: 'CI',
            status: 'failure' as const,
            canRerun: true,
            provider: 'actions' as const,
          },
          {
            id: '2',
            name: 'CI',
            group: 'CI',
            status: 'failure' as const,
            canRerun: true,
            provider: 'actions' as const,
          },
          {
            id: '1',
            name: 'Lint',
            group: 'Lint',
            status: 'success' as const,
            canRerun: true,
            provider: 'actions' as const,
          },
        ],
      })),
      rerunCi: vi.fn(async () => undefined),
    };
    tracker = {
      kind: 'jira-cloud',
      transition: vi.fn(async () => undefined),
      updateIssue: vi.fn(async () => ({}) as never),
    };
    orgs = [{ id: 'contoso', name: 'contoso', url: 'https://dev.azure.com/contoso' }];
    const factory: ProviderFactory = {
      provider: () => provider as HostingProvider,
      tracker: () => tracker as IssueTracker,
      organizations: async () => orgs,
      validate: async (kind) => ({
        user: {
          id: kind === 'jira-cloud' ? 'acc-9' : '1',
          login: kind === 'jira-cloud' ? 'me@acme.com' : 'octo',
        },
        scopes: [],
      }),
      patPageUrl: () => '',
      gitUsername: () => 'x',
      defaultHost: (k) => (k === 'github' ? 'github.com' : k === 'azure-devops' ? 'dev.azure.com' : null),
      authInfo: () => null,
    };
    runOp = vi.fn(
      async (_id: string, op: { localBranch?: string; mode?: string; worktreePath?: string }) => ({
        opId: 'o',
        summary: '',
        data:
          op.mode === 'fetch'
            ? { branch: op.localBranch, ref: 'refs/githappens/pr/5' }
            : { branch: op.localBranch, path: op.worktreePath },
      }),
    );
    runRead = vi.fn();
    const repos = {
      get: () => ({
        remotes: async () => [
          { name: 'origin', fetchUrl: 'git@github.com:acme/app.git', pushUrl: '', fetchRefspecs: [] },
          { name: 'bob', fetchUrl: 'https://github.com/bob/app.git', pushUrl: '', fetchRefspecs: [] },
        ],
        refs: async () => [
          { type: 'local', shortName: 'ABC-1-login' },
          { type: 'local', shortName: '17-crash' },
          { type: 'local', shortName: 'main' },
          { type: 'remote', shortName: 'origin/ABC-2' },
        ],
        runRead,
        repo: { worktreeRoot: path.join(dir, 'app') },
      }),
      runOp,
    } as unknown as RepoManager;
    svc = new IntegrationService(accounts, factory, repos, { changed: vi.fn(), prIndex: vi.fn() });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const connectAll = async (): Promise<{ gh: ConnectedIntegration; jira: ConnectedIntegration }> => ({
    gh: await svc.connect('github', 'github.com', { type: 'pat', accessToken: 't' }, 'pat'),
    jira: await svc.connect(
      'jira-cloud',
      'acme.atlassian.net',
      { type: 'pat', accessToken: 't', username: 'u' },
      'pat',
    ),
  });

  it('stores and infers branch ↔ issue links', async () => {
    const { jira, gh } = await connectAll();
    const links = await svc.issueLinks('r');
    expect(Object.keys(links).sort()).toEqual(['17-crash', 'ABC-1-login']);
    expect(links['ABC-1-login']).toMatchObject({ integrationKey: jira.key, key: 'ABC-1' });
    expect(links['17-crash']).toMatchObject({ integrationKey: gh.key, key: '#17', scope: 'acme/app' });

    const manual: IssueRef = {
      trackerKind: 'github',
      integrationKey: gh.key,
      scope: 'acme/app',
      key: '#99',
      webUrl: 'u',
    };
    svc.setIssueLink('r', 'main', manual);
    expect(await svc.linkForBranch('r', 'main')).toEqual(manual);
    expect(fs.existsSync(path.join(dir, 'repos', 'r', 'issue-links.json'))).toBe(true);
    svc.setIssueLink('r', 'main', null);
    expect(await svc.linkForBranch('r', 'main')).toBeNull();
  });

  it('creates a branch from an issue, links it, transitions and self-assigns', async () => {
    const { jira } = await connectAll();
    const issue: IssueRef = {
      trackerKind: 'jira-cloud',
      integrationKey: jira.key,
      scope: 'ABC',
      key: 'ABC-5',
      webUrl: 'w',
    };
    const r = await svc.createBranch('r', 'ABC-5-x', 'main', true, issue, {
      transitionId: '21',
      assignSelf: true,
    });
    expect(r).toEqual({ branch: 'ABC-5-x' });
    expect(runOp).toHaveBeenCalledWith('r', {
      type: 'branch.create',
      name: 'ABC-5-x',
      startPoint: 'main',
      checkout: true,
    });
    expect(tracker.transition).toHaveBeenCalledWith('ABC', 'ABC-5', '21');
    expect(tracker.updateIssue).toHaveBeenCalledWith('ABC', 'ABC-5', { assignees: ['acc-9'] });
    expect(await svc.linkForBranch('r', 'ABC-5-x')).toEqual(issue);

    (tracker.transition as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));
    const r2 = await svc.createBranch('r', 'b2', 'main', false, issue, { transitionId: '21' });
    expect(r2.warnings?.[0]).toContain('Could not transition ABC-5');
  });

  it('self-assign uses the Jira accountId and the login elsewhere', () => {
    expect(selfAssignee({ kind: 'jira-cloud', accountId: 'acc', login: 'me@x' })).toBe('acc');
    expect(selfAssignee({ kind: 'github', accountId: '1', login: 'octo' })).toBe('octo');
  });

  it('persists PR filters per profile', () => {
    expect(svc.prFilters()).toEqual([]);
    svc.savePrFilters([{ id: 'x', name: 'Mine', filter: { query: 'author:@me' } }]);
    expect(svc.prFilters()).toEqual([{ id: 'x', name: 'Mine', filter: { query: 'author:@me' } }]);
    expect(fs.existsSync(path.join(dir, 'pr-filters.json'))).toBe(true);
  });

  it('checks conflicts with merge-tree and reads commits', async () => {
    runRead.mockResolvedValueOnce({ exitCode: 1, stdout: 'tree\nsrc/a.ts\nsrc/b.ts\n' });
    expect(await svc.conflictCheck('r', 'feature', 'origin/main')).toEqual({
      conflicts: true,
      files: ['src/a.ts', 'src/b.ts'],
    });
    expect(runRead.mock.calls[0]![0]).toEqual([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      'origin/main',
      'feature',
    ]);
    runRead.mockResolvedValueOnce({ exitCode: 0, stdout: 'tree\n' });
    expect(await svc.conflictCheck('r', 'a', 'b')).toEqual({ conflicts: false, files: [] });
    runRead.mockResolvedValueOnce({ exitCode: 129, stdout: '' });
    expect((await svc.conflictCheck('r', 'a', 'b')).unsupported).toBe(true);
    await expect(svc.conflictCheck('r', '--evil', 'b')).rejects.toThrow(/Invalid source/);

    runRead.mockResolvedValueOnce({
      exitCode: 0,
      stdout: [`${'a'.repeat(40)}`, 'Add login', 'Ann', 'ann@x', '100'].join('\u0000') + '\n',
    });
    expect(await svc.commits('r', 'origin/main', 'refs/githappens/pr/5')).toEqual([
      { sha: 'a'.repeat(40), subject: 'Add login', authorName: 'Ann', authorEmail: 'ann@x', date: 100 },
    ]);
    await expect(svc.commits('r', 'a..b', 'c')).rejects.toThrow();
  });

  it('checks out fork PRs via an existing fork remote, in a worktree', async () => {
    await connectAll();
    const fork = pr({
      number: 5,
      isCrossRepository: true,
      head: { repo: { integration: GH, owner: 'bob', name: 'app' }, branch: 'fix', sha: 'c'.repeat(40) },
    });
    const r = await svc.checkoutPr('r', fork, 'worktree');
    expect(r.branch).toBe('fix');
    expect(r.path).toBe(path.join(dir, 'app.worktrees', 'pr-5'));
    expect(runOp).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ remote: 'bob', sameRepo: true, mode: 'worktree', checkout: false }),
    );
    expect(await svc.fetchPr('r', fork)).toEqual({
      headRef: 'refs/githappens/pr/5',
      baseRef: 'refs/remotes/origin/main',
    });
    expect(runOp).toHaveBeenLastCalledWith(
      'r',
      expect.objectContaining({ mode: 'fetch', remote: 'origin', baseBranch: 'main', sameRepo: false }),
      true,
    );
  });

  it('re-runs the latest failed run per workflow', async () => {
    await connectAll();
    const ref = { integration: GH, owner: 'acme', name: 'app' };
    expect(await svc.rerunFailedCi(ref, 'main')).toEqual({ rerun: 1 });
    expect(provider.rerunCi).toHaveBeenCalledWith(ref, '3', { failedOnly: true });
  });

  it('keeps the last PR index when a background refresh is paused', async () => {
    await connectAll();
    (provider.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [pr({ number: 8 })],
    });
    expect((await svc.prIndex('r', true)).length).toBeGreaterThan(0);
    (provider.listPullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rate limited'));
    expect((await svc.prIndex('r', true, true))[0]!.pr.number).toBe(8);
  });

  it('scopes an Azure DevOps account to an organization', async () => {
    const az = await svc.connect('azure-devops', 'dev.azure.com', { type: 'pat', accessToken: 't' }, 'pat');
    expect(await svc.organizations(az.key)).toEqual([{ ...orgs[0], selected: false }]);
    const next = await svc.selectOrganization(az.key, 'contoso');
    expect(next.host).toBe('dev.azure.com/contoso');
    expect(svc.list().map((a) => a.key)).toEqual([next.key]);
    expect((await svc.organizations(next.key))[0]!.selected).toBe(true);
  });
});

describe('rate-limit budget policy (spec 10 §6.4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pauses background requests of an account below 10% remaining, shared across clients', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 1, login: 'octo' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '5',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-reset': String(resetAt),
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRateLimit = vi.fn();
    const factory = createProviderFactory({
      oauth: { brokerUrl: null, clientId: () => null },
      onRateLimit,
      onCredentialRefreshed: vi.fn(),
      onReauthRequired: vi.fn(),
    });
    const account = {
      kind: 'github',
      host: 'github.com',
      accountId: '1',
      key: 'github:github.com:1',
      login: 'octo',
      authType: 'pat',
      scopes: [],
      connectedAt: 0,
    } as ConnectedIntegration;
    const cred = { type: 'pat' as const, accessToken: 't' };
    await factory.provider(account, cred).getViewer();
    expect(onRateLimit).toHaveBeenCalledWith(account.key, expect.objectContaining({ remaining: 5 }));
    await expect(factory.provider(account, cred, { background: true }).getViewer()).rejects.toMatchObject({
      code: 'rate_limited',
    });
    // user-initiated requests still go
    await factory.provider(account, cred).getViewer();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // another account is unaffected
    const other = { ...account, accountId: '2', key: 'github:github.com:2' };
    await factory.provider(other, cred, { background: true }).getViewer();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
