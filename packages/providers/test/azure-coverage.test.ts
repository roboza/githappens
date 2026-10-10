import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http';
import {
  AZURE_AUTH,
  AZURE_AUTH_INFO,
  AZURE_BOARDS_AUTH,
  AZURE_PAT_SCOPES,
  azPolicyToCheck,
  azStateCategory,
  azStatusToCheck,
  azureDevOpsAuthInfo,
  azWorkItemPatchOps,
  createAzureBoardsTracker,
  createAzureDevOpsProvider,
  parseAzureRemote,
  wiqlFor,
} from '../src/azure';
import type { PullRequest, RepoRef } from '../src/types';

/** Extra Azure DevOps / Boards / auth coverage (msw-backed, no real network). */

const ORG = 'https://dev.azure.com/acme';
const API = `${ORG}/My%20Proj/_apis`;
const PR = `${API}/git/repositories/web/pullrequests`;
const VSSPS = 'https://app.vssps.visualstudio.com';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = () =>
  new HttpClient({ baseUrl: 'https://dev.azure.com', retries: 0, auth: () => AZURE_AUTH.authHeader('pat') });
const provider = (o: { host?: string; organization?: string | null } = {}) =>
  createAzureDevOpsProvider({
    http: client(),
    host: o.host ?? 'dev.azure.com',
    organization: o.organization === null ? undefined : (o.organization ?? 'acme'),
  });
const ref: RepoRef = {
  integration: { kind: 'azure-devops', host: 'dev.azure.com', accountId: '' },
  owner: 'acme/My Proj',
  name: 'web',
};

const conn = http.get(`${ORG}/_apis/connectionData`, () =>
  HttpResponse.json({
    authenticatedUser: {
      id: 'me-id',
      providerDisplayName: 'Me',
      properties: { Account: { $value: 'me@acme.com' } },
    },
    instanceId: 'coll-1',
  }),
);

const azRepo = {
  id: 'repo-1',
  name: 'web',
  project: { id: 'proj-1', name: 'My Proj' },
  remoteUrl: 'https://acme@dev.azure.com/acme/My%20Proj/_git/web',
};
const azPr = (over: Record<string, unknown> = {}) => ({
  pullRequestId: 12,
  status: 'active',
  isDraft: false,
  title: 'Feature',
  description: 'desc',
  createdBy: { id: 'alice', displayName: 'Alice', uniqueName: 'alice@acme.com' },
  creationDate: '2024-03-01T00:00:00Z',
  sourceRefName: 'refs/heads/feature/x',
  targetRefName: 'refs/heads/main',
  lastMergeSourceCommit: { commitId: 'src1' },
  mergeStatus: 'succeeded',
  reviewers: [],
  labels: [],
  repository: azRepo,
  ...over,
});
const q = (request: Request) => new URL(request.url).searchParams;

describe('Azure DevOps — identity, orgs and repos', () => {
  it('getViewer uses connectionData for a single org and the VSSPS profile otherwise', async () => {
    let profileCalls = 0;
    server.use(
      conn,
      http.get(`${VSSPS}/_apis/profile/profiles/me`, ({ request }) => {
        profileCalls++;
        expect(q(request).get('api-version')).toBe('7.1');
        if (profileCalls === 1) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        return HttpResponse.json({ id: 'pid', displayName: 'Pat', emailAddress: 'pat@x.com' });
      }),
      http.get(`${VSSPS}/_apis/accounts`, ({ request }) => {
        expect(q(request).get('memberId')).toBe('pid');
        return HttpResponse.json({ value: [{ accountName: 'acme' }, { accountName: 'beta' }] });
      }),
    );
    expect(await provider().getViewer()).toEqual({ id: 'me-id', login: 'me@acme.com', name: 'Me' });
    expect(await provider().listOrganizations()).toEqual(['acme']);
    expect(await provider().getGrantedScopes()).toEqual([]);
    expect(await provider().listLabels(ref)).toEqual([]);

    const multi = provider({ organization: null });
    // First profile fetch fails → cached promise is dropped and the next call retries.
    await expect(multi.getViewer()).rejects.toMatchObject({ code: 'server' });
    expect(await multi.getViewer()).toEqual({
      id: 'pid',
      login: 'pat@x.com',
      name: 'Pat',
      email: 'pat@x.com',
    });
    expect(await multi.listOrganizations()).toEqual(['acme', 'beta']);
    expect(profileCalls).toBe(2);
  });

  it('getViewer falls back to providerDisplayName / id when no Account property is present', async () => {
    server.use(
      http.get(`${ORG}/_apis/connectionData`, () =>
        HttpResponse.json({ authenticatedUser: { id: 'u1', displayName: 'D' }, instanceId: 'c' }),
      ),
    );
    expect(await provider().getViewer()).toEqual({ id: 'u1', login: 'u1', name: 'D' });
  });

  it('getViewer (profile) falls back to publicAlias then id', async () => {
    server.use(
      http.get(`${VSSPS}/_apis/profile/profiles/me`, () =>
        HttpResponse.json({ id: 'pid', publicAlias: 'alias' }),
      ),
    );
    expect(await provider({ organization: null }).getViewer()).toMatchObject({ login: 'alias' });
  });

  it('listRepos per project and across orgs, filters disabled repos and the query', async () => {
    server.use(
      http.get(`${API}/git/repositories`, () =>
        HttpResponse.json({
          value: [
            {
              ...azRepo,
              defaultBranch: 'refs/heads/develop',
              project: {
                id: 'proj-1',
                name: 'My Proj',
                visibility: 'public',
                description: 'Proj desc',
                lastUpdateTime: '2024-01-01T00:00:00Z',
              },
              isFork: true,
              parentRepository: {
                id: 'up-1',
                name: 'upstream',
                project: { name: 'Up' },
                collection: { name: 'other' },
              },
            },
            { ...azRepo, id: 'dis', name: 'disabled', isDisabled: true },
          ],
        }),
      ),
      http.get(`${VSSPS}/_apis/profile/profiles/me`, () => HttpResponse.json({ id: 'pid' })),
      http.get(`${VSSPS}/_apis/accounts`, () =>
        HttpResponse.json({ value: [{ accountName: 'acme' }, { accountName: 'beta' }] }),
      ),
      http.get(`${ORG}/_apis/git/repositories`, () =>
        HttpResponse.json({ value: [{ id: 'r2', name: 'api', project: { id: 'p', name: 'Core' } }] }),
      ),
      http.get('https://dev.azure.com/beta/_apis/git/repositories', () =>
        HttpResponse.json({
          value: [{ id: 'r3', name: 'site', project: { id: 'p', name: 'Web', description: '' } }],
        }),
      ),
    );
    const one = await provider().listRepos({ owner: 'acme/My Proj' });
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toEqual({
      ref: { integration: ref.integration, owner: 'acme/My Proj', name: 'web', id: 'repo-1' },
      fullName: 'acme/My Proj/web',
      description: 'Proj desc',
      isPrivate: false,
      isFork: true,
      parent: { integration: ref.integration, owner: 'other/Up', name: 'upstream', id: 'up-1' },
      defaultBranch: 'develop',
      httpsUrl: 'https://dev.azure.com/acme/My%20Proj/_git/web',
      sshUrl: 'git@ssh.dev.azure.com:v3/acme/My Proj/web',
      webUrl: 'https://dev.azure.com/acme/My%20Proj/_git/web',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const all = await provider({ organization: null }).listRepos({});
    expect(all.items.map((r) => [r.fullName, r.isPrivate, r.defaultBranch, r.description])).toEqual([
      ['acme/Core/api', true, 'main', undefined],
      ['beta/Web/site', true, 'main', undefined],
    ]);
    const filtered = await provider({ organization: null }).listRepos({ query: 'SITE' });
    expect(filtered.items.map((r) => r.fullName)).toEqual(['beta/Web/site']);
  });

  it('listForks resolves the repo id and uses the collection instance id', async () => {
    server.use(
      conn,
      http.get(`${API}/git/repositories/web`, () => HttpResponse.json(azRepo)),
      http.get(`${API}/git/repositories/repo-1/forks/coll-1`, () =>
        HttpResponse.json({
          value: [
            {
              id: 'f1',
              name: 'web',
              project: { id: 'p2', name: 'Forks' },
              remoteUrl: 'https://dev.azure.com/other/Forks/_git/web',
            },
            { id: 'f2', name: 'web2', project: { id: 'p3', name: 'Mine' } },
          ],
        }),
      ),
    );
    const forks = await provider().listForks!(ref);
    expect(forks.items.map((f) => f.ref.owner)).toEqual(['other/Forks', 'acme/Mine']);
  });

  it('owner without an org is rejected unless an organization is known', async () => {
    await expect(provider({ organization: null }).getRepo({ ...ref, owner: 'Proj' })).rejects.toMatchObject({
      code: 'validation',
    });
    server.use(http.get(`${ORG}/Proj/_apis/git/repositories/web`, () => HttpResponse.json(azRepo)));
    const r = await provider().getRepo({ ...ref, owner: 'Proj' });
    expect(r.fullName).toBe('acme/My Proj/web');
  });

  it('legacy {org}.visualstudio.com hosts build org URLs and restrict remotes to that org', async () => {
    const p = provider({ host: 'https://ACME.visualstudio.com/', organization: null });
    expect(p.matchRemoteUrl('https://acme.visualstudio.com/P/_git/web')).toEqual({
      owner: 'acme/P',
      name: 'web',
    });
    expect(p.matchRemoteUrl('https://other.visualstudio.com/P/_git/web')).toBeNull();
    expect(p.matchRemoteUrl('not a url')).toBeNull();
    expect(await p.listOrganizations()).toEqual(['acme']);
    server.use(
      http.get('https://acme.visualstudio.com/P/_apis/git/repositories/web', () =>
        HttpResponse.json({ id: 'r', name: 'web', project: { id: 'p', name: 'P' } }),
      ),
      http.get('https://acme.vssps.visualstudio.com/_apis/identities', ({ request }) => {
        expect(q(request).get('filterValue')).toBe('bo');
        return HttpResponse.json({ value: [{ id: 'i', properties: { Mail: { $value: 'bo@x' } } }] });
      }),
    );
    const repo = await p.getRepo({ ...ref, owner: 'P' });
    expect(repo.webUrl).toBe('https://acme.visualstudio.com/P/_git/web');
    expect(repo.httpsUrl).toBe('https://acme.visualstudio.com/P/_git/web');
    expect(await p.searchUsers!({ ...ref, owner: 'acme/P' }, 'bo')).toEqual([
      { id: 'i', login: 'bo@x', name: undefined, email: 'bo@x', isTeam: undefined },
    ]);
  });

  it('parseAzureRemote rejects malformed ssh paths and unknown hosts', () => {
    expect(parseAzureRemote('git@ssh.dev.azure.com:v2/a/b/c')).toBeNull();
    expect(parseAzureRemote('https://example.com/a/_git/b')).toBeNull();
    expect(parseAzureRemote('https://dev.azure.com/acme/P/_git/')).toBeNull();
    expect(parseAzureRemote('')).toBeNull();
    // Undecodable path segments are kept verbatim.
    expect(parseAzureRemote('git@ssh.dev.azure.com:v3/acme/P%ZZ/web')).toEqual({
      org: 'acme',
      project: 'P%ZZ',
      repo: 'web',
    });
  });

  it('searchUsers on dev.azure.com maps identities (Account, team flag)', async () => {
    server.use(
      http.get('https://vssps.dev.azure.com/acme/_apis/identities', ({ request }) => {
        expect(q(request).get('searchFilter')).toBe('General');
        expect(q(request).get('queryMembership')).toBe('None');
        return HttpResponse.json({
          value: [
            { id: 'a', providerDisplayName: 'Al', properties: { Account: { $value: 'al@acme' } } },
            { id: 't', providerDisplayName: 'Team', isContainer: true },
            { id: 'z' },
          ],
        });
      }),
    );
    expect(await provider().searchUsers!(ref, 'a')).toEqual([
      { id: 'a', login: 'al@acme', name: 'Al', email: undefined, isTeam: undefined },
      { id: 't', login: 'Team', name: 'Team', email: undefined, isTeam: true },
      { id: 'z', login: 'z', name: undefined, email: undefined, isTeam: undefined },
    ]);
  });
});

describe('Azure DevOps — pull requests', () => {
  it('listPullRequests: mine preset, head filter, query + author filters, viewer lookup failure', async () => {
    server.use(
      http.get(`${ORG}/_apis/connectionData`, () => HttpResponse.json({}, { status: 500 })),
      http.get(PR, ({ request }) => {
        const s = q(request);
        expect(s.get('searchCriteria.status')).toBe('active');
        expect(s.get('searchCriteria.creatorId')).toBeNull();
        expect(s.get('searchCriteria.sourceRefName')).toBe('refs/heads/feature/x');
        expect(s.get('$skip')).toBeNull();
        return HttpResponse.json({
          value: [
            azPr(),
            azPr({ pullRequestId: 13, title: 'Other' }),
            azPr({ pullRequestId: 14, createdBy: { id: 'b', displayName: 'Bob' } }),
          ],
        });
      }),
    );
    const page = await provider().listPullRequests(ref, {
      preset: 'mine',
      head: 'feature/x',
      query: 'feat',
      author: 'ALICE',
    });
    expect(page.items.map((p) => p.number)).toEqual([12]);
    expect(page.items[0]!.viewer.isAuthor).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('listPullRequests maps merged/closed state filters and the creator id', async () => {
    const seen: Array<[string | null, string | null]> = [];
    server.use(
      conn,
      http.get(PR, ({ request }) => {
        seen.push([q(request).get('searchCriteria.status'), q(request).get('searchCriteria.creatorId')]);
        return HttpResponse.json({ value: [] });
      }),
    );
    const p = provider();
    await p.listPullRequests(ref, { state: 'merged', preset: 'mine' });
    await p.listPullRequests(ref, { state: 'closed' });
    expect(seen).toEqual([
      ['completed', 'me-id'],
      ['abandoned', null],
    ]);
  });

  it('searchMyPullRequests merges author + reviewer roles and filters by repo', async () => {
    server.use(
      conn,
      http.get(`${ORG}/_apis/git/pullrequests`, ({ request }) => {
        const s = q(request);
        expect(s.get('searchCriteria.status')).toBe('active');
        expect(['100', '50']).toContain(s.get('$top'));
        if (s.get('searchCriteria.creatorId') === 'me-id')
          return HttpResponse.json({
            value: [
              azPr({ createdBy: { id: 'me-id', displayName: 'Me' } }),
              azPr({
                pullRequestId: 50,
                repository: { ...azRepo, id: 'o', name: 'other' },
              }),
            ],
          });
        expect(s.get('searchCriteria.reviewerId')).toBe('me-id');
        return HttpResponse.json({
          value: [azPr({ createdBy: { id: 'me-id' }, reviewers: [{ id: 'me-id', vote: 0 }] })],
        });
      }),
    );
    const r = await provider().searchMyPullRequests!({
      repos: [{ owner: 'ACME/My Proj', name: 'web' }],
      limit: 500,
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.pr.number).toBe(12);
    expect(r[0]!.involvement.sort()).toEqual(['author', 'reviewer']);
    expect(r[0]!.pr.viewer.isAuthor).toBe(true);
    const all = await provider().searchMyPullRequests!();
    expect(all.map((x) => x.pr.number).sort()).toEqual([12, 50]);
  });

  it('getPrChecks keeps the latest status per context, maps genres and skips disabled policies', async () => {
    server.use(
      http.get(`${PR}/12`, () => HttpResponse.json(azPr())),
      http.get(`${PR}/12/statuses`, () =>
        HttpResponse.json({
          value: [
            { id: 1, state: 'failed', context: { name: 'ci', genre: 'continuous-integration' } },
            {
              id: 3,
              state: 'succeeded',
              description: 'CI ok',
              context: { name: 'ci', genre: 'continuous-integration' },
              targetUrl: 'https://ci',
              creationDate: '2024-03-01T00:00:00Z',
              updatedDate: '2024-03-01T00:05:00Z',
            },
            { id: 2, state: 'pending', context: { name: 'build', genre: 'azure-pipelines' } },
            { id: 4, state: 'notApplicable', context: { name: 'lint' } },
          ],
        }),
      ),
      http.get(`${API}/policy/evaluations`, () =>
        HttpResponse.json({
          value: [
            {
              evaluationId: 'a',
              status: 'approved',
              configuration: {
                isBlocking: false,
                type: { displayName: 'Minimum reviewers' },
                settings: { displayName: 'Two reviewers' },
              },
              startedDate: '2024-03-01T00:00:00Z',
              completedDate: '2024-03-01T00:01:00Z',
            },
            { evaluationId: 'b', status: 'queued', configuration: { isEnabled: false } },
            { evaluationId: 'c', status: 'broken', configuration: {} },
          ],
        }),
      ),
    );
    const checks = await provider().getPrChecks(ref, 12);
    expect(checks).toEqual([
      {
        id: 'status:3',
        name: 'CI ok',
        group: 'continuous-integration/ci',
        status: 'success',
        startedAt: '2024-03-01T00:00:00.000Z',
        completedAt: '2024-03-01T00:05:00.000Z',
        detailsUrl: 'https://ci',
        canRerun: false,
        provider: 'status-api',
      },
      {
        id: 'status:2',
        name: 'build',
        group: 'azure-pipelines/build',
        status: 'in_progress',
        startedAt: undefined,
        completedAt: undefined,
        detailsUrl: undefined,
        canRerun: false,
        provider: 'azure-pipelines',
      },
      {
        id: 'status:4',
        name: 'lint',
        group: 'lint',
        status: 'skipped',
        startedAt: undefined,
        completedAt: undefined,
        detailsUrl: undefined,
        canRerun: false,
        provider: 'status-api',
      },
      {
        id: 'policy:a',
        name: 'Two reviewers',
        group: 'Minimum reviewers (optional)',
        status: 'success',
        startedAt: '2024-03-01T00:00:00.000Z',
        completedAt: '2024-03-01T00:01:00.000Z',
        canRerun: false,
        provider: 'other',
      },
      {
        id: 'policy:c',
        name: 'Policy',
        group: 'Policy',
        status: 'failure',
        startedAt: undefined,
        completedAt: undefined,
        canRerun: false,
        provider: 'other',
      },
    ]);
  });

  it('getPullRequest tolerates failing statuses/policies/threads/viewer', async () => {
    server.use(
      http.get(`${ORG}/_apis/connectionData`, () => new HttpResponse('x', { status: 500 })),
      http.get(`${PR}/12`, () =>
        HttpResponse.json(
          azPr({
            status: 'abandoned',
            closedDate: '2024-03-05T00:00:00Z',
            mergeStatus: 'failure',
            reviewers: [{ id: 'team', isContainer: true, vote: 0, isRequired: true }],
            forkSource: {
              repository: {
                id: 'f',
                name: 'web',
                project: { id: 'p', name: 'Fork' },
                remoteUrl: 'https://dev.azure.com/forker/Fork/_git/web',
              },
            },
          }),
        ),
      ),
      http.get(`${PR}/12/statuses`, () => new HttpResponse('x', { status: 500 })),
      http.get(`${API}/policy/evaluations`, () => new HttpResponse('x', { status: 500 })),
      http.get(`${PR}/12/threads`, () => new HttpResponse('x', { status: 500 })),
    );
    const pr = (await provider().getPullRequest(ref, 12)) as PullRequest;
    expect(pr.state).toBe('closed');
    expect(pr.closedAt).toBe('2024-03-05T00:00:00.000Z');
    expect(pr.mergeable).toBe('conflicting');
    expect(pr.isCrossRepository).toBe(true);
    expect(pr.head.repo?.owner).toBe('forker/Fork');
    expect(pr.reviewDecision).toBe('review_required');
    expect(pr.reviewers[0]!.user.isTeam).toBe(true);
    expect(pr.checksRollup).toBe('none');
    expect(pr.commentsCount).toBe(0);
    expect(pr.viewer.canMerge).toBe(false);
  });

  it('getPullRequest: approved decision, unknown mergeable, unknown author', async () => {
    server.use(
      conn,
      http.get(`${PR}/12`, () =>
        HttpResponse.json(
          azPr({
            mergeStatus: 'queued',
            reviewers: [{ id: 'bob', vote: 10, imageUrl: 'img' }],
          }),
        ),
      ),
      http.get(`${PR}/12/statuses`, () => HttpResponse.json({ value: [] })),
      http.get(`${API}/policy/evaluations`, () => HttpResponse.json({ value: [] })),
      http.get(`${PR}/12/threads`, () => HttpResponse.json({ value: [] })),
    );
    const pr = (await provider().getPullRequest(ref, 12)) as PullRequest;
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.mergeable).toBe('unknown');
    expect(pr.reviewers[0]!.user).toMatchObject({ login: 'bob', avatarUrl: 'img' });
  });

  it('timeline maps RefUpdate/other system threads, left-side file threads and skips deleted', async () => {
    server.use(
      conn,
      http.get(`${PR}/12/threads`, () =>
        HttpResponse.json({
          value: [
            {
              id: 1,
              publishedDate: '2024-03-01T01:00:00Z',
              properties: { CodeReviewThreadType: { $value: 'RefUpdate' } },
              comments: [{ id: 1, author: { id: 'bob' }, commentType: 'system', publishedDate: 'x' }],
            },
            {
              id: 2,
              publishedDate: '2024-03-01T02:00:00Z',
              properties: { CodeReviewThreadType: { $value: 'StatusUpdate' } },
              comments: [
                {
                  id: 1,
                  author: { id: 'bob' },
                  content: 'Bob set status',
                  commentType: 'system',
                  publishedDate: 'x',
                },
              ],
            },
            {
              id: 3,
              publishedDate: '2024-03-01T03:00:00Z',
              comments: [{ id: 1, author: { id: 'bob' }, commentType: 'system', publishedDate: 'x' }],
            },
            {
              id: 4,
              publishedDate: '2024-03-01T04:00:00Z',
              status: 'active',
              threadContext: { filePath: 'b.ts', leftFileStart: { line: 3 } },
              comments: [{ id: 1, author: { id: 'bob' }, publishedDate: 'bad-date' }],
            },
            { id: 5, publishedDate: '2024-03-01T05:00:00Z', isDeleted: true, comments: [] },
            {
              id: 6,
              publishedDate: '2024-03-01T06:00:00Z',
              comments: [{ id: 1, author: { id: 'bob' }, isDeleted: true, publishedDate: 'x' }],
            },
            {
              id: 7,
              publishedDate: '2024-03-01T07:00:00Z',
              properties: { CodeReviewThreadType: { $value: 'VoteUpdate' } },
              comments: [{ id: 1, author: { id: 'bob' }, commentType: 'system', publishedDate: 'x' }],
            },
          ],
        }),
      ),
    );
    const t = await provider().getTimeline(ref, 12);
    expect(t.items).toEqual([
      {
        kind: 'commits',
        shas: [],
        actor: expect.objectContaining({ id: 'bob' }),
        createdAt: '2024-03-01T01:00:00.000Z',
      },
      {
        kind: 'event',
        event: 'StatusUpdate',
        actor: expect.objectContaining({ id: 'bob' }),
        createdAt: '2024-03-01T02:00:00.000Z',
        detail: 'Bob set status',
      },
      {
        kind: 'event',
        event: 'system',
        actor: expect.objectContaining({ id: 'bob' }),
        createdAt: '2024-03-01T03:00:00.000Z',
        detail: undefined,
      },
      {
        kind: 'thread',
        id: '12:4',
        path: 'b.ts',
        line: 3,
        side: 'LEFT',
        resolved: false,
        outdated: false,
        comments: [
          { id: '12:4:1', author: expect.objectContaining({ id: 'bob' }), body: '', createdAt: 'bad-date' },
        ],
      },
      {
        kind: 'review',
        id: '12:7',
        author: expect.objectContaining({ id: 'bob' }),
        state: 'pending',
        body: '',
        createdAt: '2024-03-01T07:00:00.000Z',
      },
    ]);
  });

  it('getChecks reads latest commit statuses', async () => {
    server.use(
      http.get(`${API}/git/repositories/web/commits/abc/statuses`, ({ request }) => {
        expect(q(request).get('latestOnly')).toBe('true');
        return HttpResponse.json({
          value: [
            { id: 1, state: 'error', context: { name: 'x' } },
            { id: 2, state: 'notSet', context: { name: 'y' } },
          ],
        });
      }),
    );
    const checks = await provider().getChecks(ref, 'abc');
    expect(checks.map((c) => c.status)).toEqual(['failure', 'queued']);
  });

  it('listPrTemplates probes paths until one exists; non-404 errors propagate', async () => {
    const probed: string[] = [];
    server.use(
      http.get(`${API}/git/repositories/web/items`, ({ request }) => {
        const s = q(request);
        probed.push(s.get('path')!);
        expect(s.get('versionDescriptor.version')).toBe('main');
        expect(s.get('includeContent')).toBe('true');
        if (s.get('path') === '/docs/pull_request_template.md')
          return HttpResponse.json({ content: '## Template' });
        return HttpResponse.json({ message: 'nope' }, { status: 404 });
      }),
    );
    expect(await provider().listPrTemplates!(ref, 'main')).toEqual([
      { name: 'pull_request_template.md', path: 'docs/pull_request_template.md', body: '## Template' },
    ]);
    expect(probed).toEqual([
      '/.azuredevops/pull_request_template.md',
      '/.vsts/pull_request_template.md',
      '/docs/pull_request_template.md',
    ]);

    server.use(
      http.get(`${API}/git/repositories/web/items`, ({ request }) =>
        q(request).get('path') === '/pull_request_template.md'
          ? new HttpResponse('raw body', { headers: { 'content-type': 'text/plain' } })
          : new HttpResponse(null, { status: 404 }),
      ),
    );
    expect((await provider().listPrTemplates!(ref, 'main'))[0]!.body).toBe('raw body');

    server.use(http.get(`${API}/git/repositories/web/items`, () => new HttpResponse(null, { status: 404 })));
    expect(await provider().listPrTemplates!(ref, 'main')).toEqual([]);

    server.use(http.get(`${API}/git/repositories/web/items`, () => new HttpResponse(null, { status: 401 })));
    await expect(provider().listPrTemplates!(ref, 'main')).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('createPullRequest from a fork with reviewers, labels, squash and delete-source-branch', async () => {
    let body: any;
    server.use(
      conn,
      http.get(`${ORG}/Forks/_apis/git/repositories/web`, () =>
        HttpResponse.json({ id: 'fork-id', name: 'web', project: { id: 'p', name: 'Forks' } }),
      ),
      http.post(PR, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(azPr({ isDraft: true, createdBy: { id: 'me-id' } }), { status: 201 });
      }),
    );
    const pr = await provider().createPullRequest({
      base: ref,
      baseBranch: 'main',
      head: { ...ref, owner: 'acme/Forks' },
      headBranch: 'feat',
      title: 'T',
      body: 'B',
      draft: true,
      reviewers: ['r1'],
      teamReviewers: ['t1'],
      labels: ['l1'],
      deleteSourceBranch: true,
      squash: true,
    });
    expect(body).toEqual({
      sourceRefName: 'refs/heads/feat',
      targetRefName: 'refs/heads/main',
      title: 'T',
      description: 'B',
      isDraft: true,
      reviewers: [{ id: 'r1' }, { id: 't1' }],
      labels: [{ name: 'l1' }],
      forkSource: { repository: { id: 'fork-id' } },
      completionOptions: { deleteSourceBranch: true, mergeStrategy: 'squash' },
    });
    expect(pr.state).toBe('draft');
    expect(pr.viewer.isAuthor).toBe(true);
  });

  it('createPullRequest in the same repo sends no forkSource/completionOptions', async () => {
    let body: any;
    server.use(
      conn,
      http.post(PR, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(azPr());
      }),
    );
    await provider().createPullRequest({
      base: ref,
      baseBranch: 'main',
      head: ref,
      headBranch: 'feat',
      title: 'T',
      body: '',
    });
    expect(body).toEqual({
      sourceRefName: 'refs/heads/feat',
      targetRefName: 'refs/heads/main',
      title: 'T',
      description: '',
      isDraft: false,
      reviewers: [],
      labels: [],
    });
  });

  it('updatePullRequest adds reviewers + labels and patches fields; empty patch re-reads', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const rec = async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.push([request.method, new URL(request.url).pathname, text ? JSON.parse(text) : undefined]);
      return HttpResponse.json(azPr({ title: 'New' }));
    };
    server.use(
      conn,
      http.put(`${PR}/12/reviewers/:id`, rec),
      http.post(`${PR}/12/labels`, rec),
      http.patch(`${PR}/12`, rec),
      http.get(`${PR}/12`, rec),
    );
    const p = provider();
    const pr = await p.updatePullRequest(ref, 12, {
      title: 'New',
      body: 'Body',
      baseBranch: 'dev',
      state: 'closed',
      reviewers: ['r1'],
      teamReviewers: ['t1'],
      labels: ['bug'],
    });
    expect(pr.title).toBe('New');
    const base = '/acme/My%20Proj/_apis/git/repositories/web/pullrequests/12';
    expect(calls).toEqual([
      ['PUT', `${base}/reviewers/r1`, { vote: 0 }],
      ['PUT', `${base}/reviewers/t1`, { vote: 0 }],
      ['POST', `${base}/labels`, { name: 'bug' }],
      [
        'PATCH',
        base,
        { title: 'New', description: 'Body', targetRefName: 'refs/heads/dev', status: 'abandoned' },
      ],
    ]);
    calls.length = 0;
    await p.updatePullRequest(ref, 12, { state: 'open' });
    expect(calls).toEqual([['PATCH', base, { status: 'active' }]]);
    calls.length = 0;
    await p.updatePullRequest(ref, 12, {});
    expect(calls).toEqual([['GET', base, undefined]]);
  });

  it('addComment starts a thread or replies to an existing comment', async () => {
    const bodies: unknown[] = [];
    server.use(
      conn,
      http.post(`${PR}/12/threads`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          id: 40,
          publishedDate: '2024-03-01T00:00:00Z',
          comments: [
            {
              id: 1,
              author: { id: 'me-id' },
              content: 'hello',
              publishedDate: '2024-03-01T00:00:00Z',
              commentType: 'text',
            },
          ],
        });
      }),
      http.post(`${PR}/12/threads/40/comments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 2, author: { id: 'me-id' }, publishedDate: '2024-03-01T00:01:00Z' });
      }),
      http.post(`${PR}/12/threads/41/comments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 3, author: { id: 'me-id' }, content: 'srv', publishedDate: 'x' });
      }),
    );
    const p = provider();
    expect(await p.addComment(ref, 12, 'hello')).toMatchObject({
      kind: 'comment',
      id: '12:40:1',
      body: 'hello',
      editable: true,
    });
    expect(await p.addComment(ref, 12, 'reply', '12:40:1')).toEqual({
      kind: 'comment',
      id: '12:40:2',
      author: expect.objectContaining({ id: 'me-id' }),
      body: 'reply',
      createdAt: '2024-03-01T00:01:00.000Z',
      editable: true,
    });
    expect(await p.addComment(ref, 12, 'r2', '41')).toMatchObject({
      id: '12:41:3',
      body: 'srv',
      createdAt: 'x',
    });
    expect(bodies).toEqual([
      { comments: [{ parentCommentId: 0, content: 'hello', commentType: 1 }], status: 'active' },
      { content: 'reply', parentCommentId: 1, commentType: 1 },
      { content: 'r2', parentCommentId: 1, commentType: 1 },
    ]);
  });

  it('addComment fails when Azure returns an empty thread', async () => {
    server.use(
      conn,
      http.post(`${PR}/12/threads`, () =>
        HttpResponse.json({ id: 40, publishedDate: '2024-03-01T00:00:00Z', comments: [] }),
      ),
    );
    await expect(provider().addComment(ref, 12, 'x')).rejects.toMatchObject({ code: 'server' });
  });

  it('submitReview posts file threads (left/right), a summary and a -5 vote', async () => {
    const bodies: unknown[] = [];
    server.use(
      conn,
      http.post(`${PR}/12/threads`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({});
      }),
      http.put(`${PR}/12/reviewers/me-id`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    await provider().submitReview(ref, 12, {
      event: 'REQUEST_CHANGES',
      body: 'Summary',
      commitSha: 'x',
      comments: [
        { path: '/a.ts', line: 5, side: 'LEFT', body: 'L' },
        { path: 'b.ts', line: 9, startLine: 7, side: 'RIGHT', body: 'R' },
      ],
    });
    expect(bodies).toEqual([
      {
        comments: [{ parentCommentId: 0, content: 'L', commentType: 1 }],
        status: 'active',
        threadContext: {
          filePath: '/a.ts',
          leftFileStart: { line: 5, offset: 1 },
          leftFileEnd: { line: 5, offset: 1 },
        },
      },
      {
        comments: [{ parentCommentId: 0, content: 'R', commentType: 1 }],
        status: 'active',
        threadContext: {
          filePath: '/b.ts',
          rightFileStart: { line: 7, offset: 1 },
          rightFileEnd: { line: 9, offset: 1 },
        },
      },
      { comments: [{ parentCommentId: 0, content: 'Summary', commentType: 1 }], status: 'active' },
      { id: 'me-id', vote: -5 },
    ]);
  });

  it('submitReview with COMMENT only posts the body (no vote)', async () => {
    let posts = 0;
    server.use(
      http.post(`${PR}/12/threads`, () => {
        posts++;
        return HttpResponse.json({});
      }),
    );
    await provider().submitReview(ref, 12, { event: 'COMMENT', body: 'just a note', commitSha: 'x' });
    expect(posts).toBe(1);
  });

  it('setThreadResolved patches the thread status (fixed / active) and validates the id', async () => {
    const seen: Array<[string, unknown]> = [];
    server.use(
      http.patch(`${PR}/12/threads/:tid`, async ({ request, params }) => {
        seen.push([String(params.tid), await request.json()]);
        return HttpResponse.json({ id: Number(params.tid), status: 'fixed' });
      }),
    );
    const p = provider();
    await p.setThreadResolved!(ref, '12:7', true);
    await p.setThreadResolved!(ref, '12:8', false);
    expect(seen).toEqual([
      ['7', { status: 'fixed' }],
      ['8', { status: 'active' }],
    ]);
    await expect(p.setThreadResolved!(ref, '12', true)).rejects.toMatchObject({ code: 'validation' });
  });

  it('setThreadResolved surfaces HTTP errors', async () => {
    server.use(
      http.patch(`${PR}/12/threads/7`, () => HttpResponse.json({ message: 'gone' }, { status: 404 })),
    );
    await expect(provider().setThreadResolved!(ref, '12:7', true)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('merge reports blocked / queued / other merge statuses and rejects unsupported methods', async () => {
    const replies = [
      azPr({ mergeStatus: 'rejectedByPolicy' }),
      azPr({ mergeStatus: 'queued' }),
      azPr({ mergeStatus: 'conflicts', mergeFailureMessage: 'Conflicts in a.ts' }),
      azPr({ mergeStatus: undefined }),
    ];
    let body: any;
    server.use(
      http.patch(`${PR}/12`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(replies.shift());
      }),
    );
    const p = provider();
    const input = { method: 'squash' as const, expectedHeadSha: 's', title: 'T', message: 'M' };
    expect(await p.merge(ref, 12, input)).toEqual({
      merged: false,
      message: 'Completion is blocked by branch policies.',
    });
    expect(body.completionOptions).toEqual({
      mergeStrategy: 'squash',
      deleteSourceBranch: false,
      mergeCommitMessage: 'T\n\nM',
    });
    expect(await p.merge(ref, 12, { method: 'merge', expectedHeadSha: 's' })).toEqual({
      merged: false,
      message: 'Merge queued.',
    });
    expect(body.completionOptions.mergeCommitMessage).toBeUndefined();
    expect(await p.merge(ref, 12, { method: 'rebase', expectedHeadSha: 's' })).toEqual({
      merged: false,
      message: 'Conflicts in a.ts',
    });
    expect(await p.merge(ref, 12, { method: 'rebase', expectedHeadSha: 's' })).toEqual({
      merged: false,
      message: 'Merge status: unknown',
    });
    await expect(p.merge(ref, 12, { method: 'fast-forward', expectedHeadSha: 's' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('setAutoMerge sets the viewer as auto-completer with a strategy, or clears it', async () => {
    const bodies: unknown[] = [];
    server.use(
      conn,
      http.patch(`${PR}/12`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(azPr());
      }),
    );
    const p = provider();
    await p.setAutoMerge!(ref, 12, 'squash');
    await p.setAutoMerge!(ref, 12, 'semi-linear');
    await p.setAutoMerge!(ref, 12, null);
    expect(bodies).toEqual([
      { autoCompleteSetBy: { id: 'me-id' }, completionOptions: { mergeStrategy: 'squash' } },
      { autoCompleteSetBy: { id: 'me-id' }, completionOptions: { mergeStrategy: 'noFastForward' } },
      { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } },
    ]);
  });

  it('setAutoMerge fails when the viewer cannot be resolved', async () => {
    server.use(http.get(`${ORG}/_apis/connectionData`, () => new HttpResponse(null, { status: 401 })));
    await expect(provider().setAutoMerge!(ref, 12, 'merge')).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('reopen and setDraft(false) patch the PR status / draft flag', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${PR}/12`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(azPr());
      }),
    );
    const p = provider();
    await p.reopen!(ref, 12);
    await p.setDraft!(ref, 12, false);
    expect(bodies).toEqual([{ status: 'active' }, { isDraft: false }]);
  });

  it('reopen surfaces conflicts as ProviderErrors', async () => {
    server.use(http.patch(`${PR}/12`, () => HttpResponse.json({ message: 'nope' }, { status: 409 })));
    await expect(provider().reopen!(ref, 12)).rejects.toMatchObject({ code: 'conflict' });
    await expect(provider().setDraft!(ref, 12, true)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('write paths still succeed when the viewer identity cannot be resolved', async () => {
    server.use(
      http.get(`${ORG}/_apis/connectionData`, () => new HttpResponse(null, { status: 500 })),
      http.post(PR, () => HttpResponse.json(azPr())),
      http.patch(`${PR}/12`, () => HttpResponse.json(azPr())),
      http.get(`${PR}/12/threads`, () =>
        HttpResponse.json({
          value: [
            {
              id: 1,
              publishedDate: '2024-03-01T00:00:00Z',
              comments: [
                { id: 1, author: { id: 'me-id' }, content: 'c', publishedDate: 'x', commentType: 'text' },
              ],
            },
          ],
        }),
      ),
      http.post(`${PR}/12/threads`, () =>
        HttpResponse.json({
          id: 2,
          publishedDate: '2024-03-01T00:00:00Z',
          comments: [
            { id: 1, author: { id: 'me-id' }, content: 'n', publishedDate: 'x', commentType: 'text' },
          ],
        }),
      ),
    );
    const p = provider();
    const created = await p.createPullRequest({
      base: ref,
      baseBranch: 'main',
      head: ref,
      headBranch: 'f',
      title: 'T',
      body: '',
    });
    expect(created.viewer.isAuthor).toBe(false);
    expect((await p.updatePullRequest(ref, 12, { title: 'x' })).viewer.isAuthor).toBe(false);
    expect(await p.addComment(ref, 12, 'n')).toMatchObject({ kind: 'comment', editable: false });
    const t = await p.getTimeline(ref, 12);
    expect(t.items[0]).toMatchObject({ editable: false });
  });

  it('a 203 response without HTML still maps to auth_required', async () => {
    server.use(http.patch(`${PR}/12`, () => HttpResponse.json({}, { status: 203 })));
    await expect(provider().close(ref, 12)).rejects.toMatchObject({ code: 'auth_required' });
  });
});

describe('Azure DevOps — pipelines (CI)', () => {
  const build = (over: Record<string, unknown>) => ({
    id: 1,
    buildNumber: '20240301.7',
    status: 'completed',
    result: 'succeeded',
    definition: { name: 'CI' },
    sourceBranch: 'refs/heads/main',
    reason: 'manual',
    requestedFor: { id: 'u', displayName: 'U', uniqueName: 'u@x' },
    queueTime: '2024-03-01T00:00:00Z',
    startTime: '2024-03-01T00:01:00Z',
    finishTime: '2024-03-01T00:09:00Z',
    _links: { web: { href: 'https://build/1' } },
    ...over,
  });

  it('listCiRuns maps build status/result, branch filter and continuation token', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/build/builds`, ({ request }) => {
        const s = q(request);
        seen.push(s);
        if (s.get('continuationToken') === 'next')
          return HttpResponse.json({ value: [build({ id: 9, status: 'notStarted', result: undefined })] });
        return HttpResponse.json(
          {
            value: [
              build({}),
              build({ id: 2, result: 'partiallySucceeded' }),
              build({ id: 3, result: 'canceled' }),
              build({ id: 4, result: 'failed' }),
              build({
                id: 5,
                status: 'inProgress',
                result: undefined,
                finishTime: undefined,
                startTime: undefined,
                buildNumber: 'abc',
                definition: undefined,
                requestedFor: undefined,
                _links: undefined,
              }),
              build({ id: 6, status: 'cancelling' }),
            ],
          },
          { headers: { 'x-ms-continuationtoken': 'next' } },
        );
      }),
    );
    const p = provider();
    const page = await p.listCiRuns!({ ...ref, id: 'repo-1' }, { branch: 'main' });
    expect(seen[0]!.get('repositoryId')).toBe('repo-1');
    expect(seen[0]!.get('repositoryType')).toBe('TfsGit');
    expect(seen[0]!.get('branchName')).toBe('refs/heads/main');
    expect(seen[0]!.get('$top')).toBe('30');
    expect(seen[0]!.get('queryOrder')).toBe('queueTimeDescending');
    expect(page.items.map((r) => r.status)).toEqual([
      'success',
      'neutral',
      'cancelled',
      'failure',
      'in_progress',
      'in_progress',
    ]);
    expect(page.items[0]).toEqual({
      id: '1',
      name: 'CI',
      group: 'CI',
      status: 'success',
      startedAt: '2024-03-01T00:01:00.000Z',
      completedAt: '2024-03-01T00:09:00.000Z',
      detailsUrl: 'https://build/1',
      canRerun: true,
      provider: 'azure-pipelines',
      runNumber: 202403017,
      branch: 'main',
      event: 'manual',
      actor: { id: 'u', login: 'u@x', name: 'U', avatarUrl: undefined, isTeam: undefined },
    });
    expect(page.items[4]).toMatchObject({
      name: 'Build abc',
      group: undefined,
      startedAt: '2024-03-01T00:00:00.000Z',
      completedAt: undefined,
      canRerun: false,
      runNumber: 5,
      actor: undefined,
      detailsUrl: undefined,
    });
    expect(page.nextCursor).toBe('next');
    const next = await p.listCiRuns!({ ...ref, id: 'repo-1' }, { cursor: page.nextCursor });
    expect(seen[1]!.get('branchName')).toBeNull();
    expect(next.items[0]!.status).toBe('queued');
    expect(next.nextCursor).toBeUndefined();
  });

  it('listCiRuns resolves the repo id when the ref has none', async () => {
    server.use(
      http.get(`${API}/git/repositories/web`, () => HttpResponse.json(azRepo)),
      http.get(`${API}/build/builds`, ({ request }) => {
        expect(q(request).get('repositoryId')).toBe('repo-1');
        return HttpResponse.json({ value: [] });
      }),
    );
    expect(await provider().listCiRuns!(ref, {})).toEqual({ items: [], nextCursor: undefined });
  });

  it('listCiRuns surfaces errors', async () => {
    server.use(http.get(`${API}/build/builds`, () => HttpResponse.json({ message: 'no' }, { status: 403 })));
    await expect(provider().listCiRuns!({ ...ref, id: 'r' }, {})).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('rerunCi PATCHes the build with retry=true; cancelCi sets status cancelling', async () => {
    const seen: Array<[string, string | null, unknown]> = [];
    server.use(
      http.patch(`${API}/build/builds/:id`, async ({ request, params }) => {
        seen.push([String(params.id), q(request).get('retry'), await request.json()]);
        expect(q(request).get('api-version')).toBe('7.1');
        return HttpResponse.json({ id: Number(params.id) });
      }),
    );
    const p = provider();
    await p.rerunCi!(ref, '42');
    await p.cancelCi!(ref, '43');
    expect(seen).toEqual([
      ['42', 'true', {}],
      ['43', null, { status: 'cancelling' }],
    ]);
  });

  it('rerunCi / cancelCi surface errors', async () => {
    server.use(
      http.patch(`${API}/build/builds/:id`, () => HttpResponse.json({ message: 'x' }, { status: 404 })),
    );
    await expect(provider().rerunCi!(ref, '1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider().cancelCi!(ref, '1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Azure DevOps — status mapping helpers', () => {
  it('maps statuses and policy evaluations to check statuses', () => {
    expect(
      (['succeeded', 'failed', 'error', 'pending', 'notApplicable', 'notSet'] as const).map(azStatusToCheck),
    ).toEqual(['success', 'failure', 'failure', 'in_progress', 'skipped', 'queued']);
    expect(
      (['approved', 'rejected', 'broken', 'running', 'notApplicable', 'queued'] as const).map(
        azPolicyToCheck,
      ),
    ).toEqual(['success', 'failure', 'failure', 'in_progress', 'skipped', 'queued']);
  });
});

describe('Azure auth descriptors', () => {
  it('builds PAT page URLs, API base URLs and auth headers', () => {
    expect(AZURE_AUTH.patPageUrl('dev.azure.com')).toBe('https://dev.azure.com/_usersSettings/tokens');
    expect(AZURE_AUTH.patPageUrl('https://dev.azure.com/acme/')).toBe(
      'https://dev.azure.com/acme/_usersSettings/tokens',
    );
    expect(AZURE_AUTH.patPageUrl('acme.visualstudio.com')).toBe(
      'https://acme.visualstudio.com/_usersSettings/tokens',
    );
    expect(AZURE_AUTH.apiBaseUrl('https://dev.azure.com/')).toBe('https://dev.azure.com');
    expect(AZURE_AUTH.authHeader('eyJjwt', 'user')).toBe(`Basic ${btoa('user:eyJjwt')}`);
    expect(AZURE_BOARDS_AUTH.kind).toBe('azure-boards');
  });

  it('AuthInfo factories describe Entra PKCE + PAT for DevOps and Boards', () => {
    const info = azureDevOpsAuthInfo('');
    expect(info).toMatchObject({
      kind: 'azure-devops',
      host: 'dev.azure.com',
      authorizeUrl: AZURE_AUTH.authorizeUrl,
      tokenUrl: AZURE_AUTH.tokenUrl,
      scopes: AZURE_AUTH.scopes,
      patScopes: AZURE_PAT_SCOPES,
      patPageUrl: 'https://dev.azure.com/_usersSettings/tokens',
      usernameForGit: 'githappens',
      apiBaseUrl: 'https://dev.azure.com',
      oauth: 'pkce-public',
      refreshable: true,
      scopeSeparator: ' ',
    });
    expect(info.authorization('pat')).toBe(`Basic ${btoa(':pat')}`);
    expect(info.authorization('eyJx')).toBe('Bearer eyJx');
    const boards = AZURE_AUTH_INFO['azure-boards']!('acme.visualstudio.com');
    expect(boards.kind).toBe('azure-boards');
    expect(boards.patPageUrl).toBe('https://acme.visualstudio.com/_usersSettings/tokens');
    expect(AZURE_AUTH_INFO['azure-devops']!('dev.azure.com').kind).toBe('azure-devops');
  });
});

describe('Azure Boards — extra coverage', () => {
  const tracker = (host = 'dev.azure.com') =>
    createAzureBoardsTracker({ http: client(), host, organization: 'acme' });

  it('wiqlFor covers mentioned / all-open / updatedSince; azStateCategory honors categories', () => {
    expect(wiqlFor('P', { preset: 'mentioned' })).toContain('[System.Id] IN (@RecentMentions)');
    const w = wiqlFor('P', { preset: 'all-open', updatedSince: '2024-05-06T07:08:09Z' });
    expect(w).toContain("[System.State] NOT IN ('Closed', 'Done', 'Removed')");
    expect(w).toContain("[System.ChangedDate] >= '2024-05-06'");
    expect(w).not.toContain('@Me');
    expect(wiqlFor('P', {})).toContain('[System.AssignedTo] = @Me');
    expect(azStateCategory('X', 'Completed')).toBe('done');
    expect(azStateCategory('X', 'Removed')).toBe('done');
    expect(azStateCategory('X', 'Proposed')).toBe('todo');
    expect(azStateCategory('X', 'InProgress')).toBe('in_progress');
    expect(azStateCategory('Resolved')).toBe('done');
    expect(azStateCategory('Committed')).toBe('in_progress');
    expect(azWorkItemPatchOps({ assignees: [] })).toEqual([
      { op: 'add', path: '/fields/System.AssignedTo', value: '' },
    ]);
  });

  it('listScopes lists projects of the organization', async () => {
    server.use(
      http.get(`${ORG}/_apis/projects`, ({ request }) => {
        expect(q(request).get('$top')).toBe('500');
        return HttpResponse.json({ value: [{ name: 'A' }, { name: 'B' }] });
      }),
    );
    expect(await tracker().listScopes()).toEqual([
      { scope: 'acme/A', label: 'A' },
      { scope: 'acme/B', label: 'B' },
    ]);
  });

  it('getIssue normalizes all fields; missing work items are not_found', async () => {
    server.use(
      http.get(`${ORG}/_apis/wit/workitems`, ({ request }) => {
        if (q(request).get('ids') === '404') return HttpResponse.json({ value: [] });
        return HttpResponse.json({
          value: [
            {
              id: 7,
              fields: {
                'System.Title': 'T',
                'System.Description': '<p>d</p>',
                'System.State': 'Closed',
                'System.WorkItemType': 'Bug',
                'Microsoft.VSTS.Common.Priority': 2,
                'System.AssignedTo': { id: 'a', displayName: 'A', uniqueName: 'a@x', imageUrl: 'img' },
                'System.CreatedBy': { displayName: 'C', uniqueName: 'c@x' },
                'System.IterationPath': 'P\\Sprint 1',
                'System.CreatedDate': '2024-01-01T00:00:00Z',
                'System.ChangedDate': '2024-01-02T00:00:00Z',
                'System.CommentCount': 3,
              },
              _links: { html: { href: 'https://web/7' } },
            },
          ],
        });
      }),
    );
    const t = tracker();
    expect(await t.getIssue('My Proj', '7')).toEqual({
      tracker: { kind: 'azure-boards', integration: expect.anything(), scope: 'My Proj' },
      key: '7',
      id: '7',
      title: 'T',
      body: '<p>d</p>',
      bodyFormat: 'html',
      state: 'Closed',
      stateCategory: 'done',
      type: 'Bug',
      priority: '2',
      assignees: [{ id: 'a', login: 'a@x', name: 'A', avatarUrl: 'img' }],
      reporter: { id: 'c@x', login: 'c@x', name: 'C', avatarUrl: undefined },
      labels: [],
      sprint: 'P\\Sprint 1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      webUrl: 'https://web/7',
      commentsCount: 3,
    });
    await expect(t.getIssue('My Proj', '404')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('listIssues on a visualstudio.com host pages ids and builds fallback web URLs', async () => {
    const VS = 'https://acme.visualstudio.com';
    const ids = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
    server.use(
      http.post(`${VS}/P/_apis/wit/wiql`, () => HttpResponse.json({ workItems: ids })),
      http.get(`${VS}/_apis/wit/workitems`, ({ request }) => {
        const got = q(request).get('ids')!.split(',').map(Number);
        return HttpResponse.json({ value: got.map((id) => ({ id, fields: {} })) });
      }),
    );
    const t = tracker('https://acme.visualstudio.com/');
    const p1 = await t.listIssues('acme/P', { preset: 'assigned' });
    expect(p1.items).toHaveLength(50);
    expect(p1.total).toBe(60);
    expect(p1.nextCursor).toBe('50');
    expect(p1.items[0]!.webUrl).toBe('https://acme.visualstudio.com/P/_workitems/edit/1');
    expect(p1.items[0]!.assignees).toEqual([]);
    expect(p1.items[0]!.reporter).toBeUndefined();
    const p2 = await t.listIssues('acme/P', { preset: 'assigned' }, p1.nextCursor);
    expect(p2.items).toHaveLength(10);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('listIssues with no matching ids skips the batch fetch', async () => {
    server.use(http.post(`${API}/wit/wiql`, () => HttpResponse.json({ workItems: [] })));
    expect(await tracker().listIssues('acme/My Proj', {})).toEqual({
      items: [],
      nextCursor: undefined,
      total: 0,
    });
  });

  it('addComment posts the preview comments API; listComments falls back for missing authors', async () => {
    let posted: unknown;
    server.use(
      http.post(`${API}/wit/workItems/7/comments`, async ({ request }) => {
        expect(q(request).get('api-version')).toBe('7.1-preview.4');
        posted = await request.json();
        return HttpResponse.json({ id: 1 });
      }),
      http.get(`${API}/wit/workItems/7/comments`, () => HttpResponse.json({ comments: [{ id: 5 }] })),
    );
    const t = tracker();
    await t.addComment!('acme/My Proj', '7', 'hi');
    expect(posted).toEqual({ text: 'hi' });
    expect(await t.listComments!('acme/My Proj', '7')).toEqual([
      { id: '5', author: { id: '', login: 'unknown' }, body: '', createdAt: '' },
    ]);
  });

  it('write calls surface HTTP errors', async () => {
    server.use(
      http.post(`${API}/wit/workItems/7/comments`, () =>
        HttpResponse.json({ message: 'x' }, { status: 400 }),
      ),
    );
    await expect(tracker().addComment!('acme/My Proj', '7', 'hi')).rejects.toMatchObject({
      code: 'validation',
    });
  });
});
