import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http';
import {
  AZURE_AUTH,
  azVoteToState,
  createAzureBoardsTracker,
  createAzureDevOpsProvider,
  parseAzureRemote,
  wiqlFor,
} from '../src/azure';
import type { PullRequest, RepoRef } from '../src/types';

const ORG = 'https://dev.azure.com/acme';
const API = `${ORG}/My%20Proj/_apis`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = () =>
  new HttpClient({ baseUrl: 'https://dev.azure.com', retries: 0, auth: () => AZURE_AUTH.authHeader('pat') });
const provider = () =>
  createAzureDevOpsProvider({ http: client(), host: 'dev.azure.com', organization: 'acme' });
const ref: RepoRef = {
  integration: { kind: 'azure-devops', host: 'dev.azure.com', accountId: '' },
  owner: 'acme/My Proj',
  name: 'web',
};

const conn = http.get(`${ORG}/_apis/connectionData`, () =>
  HttpResponse.json({ authenticatedUser: { id: 'me-id', providerDisplayName: 'Me' }, instanceId: 'coll-1' }),
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
  labels: [{ name: 'ui', active: true }],
  repository: azRepo,
  ...over,
});

describe('Azure DevOps', () => {
  it('parses remote URLs (dev.azure.com, visualstudio.com, ssh v3)', () => {
    const p = provider();
    expect(p.matchRemoteUrl('https://acme@dev.azure.com/acme/My%20Proj/_git/web')).toEqual({
      owner: 'acme/My Proj',
      name: 'web',
    });
    expect(p.matchRemoteUrl('https://acme.visualstudio.com/My%20Proj/_git/web')).toEqual({
      owner: 'acme/My Proj',
      name: 'web',
    });
    expect(p.matchRemoteUrl('https://acme.visualstudio.com/DefaultCollection/Proj/_git/web')).toEqual({
      owner: 'acme/Proj',
      name: 'web',
    });
    expect(p.matchRemoteUrl('git@ssh.dev.azure.com:v3/acme/My%20Proj/web')).toEqual({
      owner: 'acme/My Proj',
      name: 'web',
    });
    expect(p.matchRemoteUrl('acme@vs-ssh.visualstudio.com:v3/acme/Proj/web')).toEqual({
      owner: 'acme/Proj',
      name: 'web',
    });
    expect(p.matchRemoteUrl('https://dev.azure.com/acme/_git/solo')).toEqual({
      owner: 'acme/solo',
      name: 'solo',
    });
    expect(p.matchRemoteUrl('https://dev.azure.com/other/P/_git/web')).toBeNull();
    expect(p.matchRemoteUrl('https://github.com/acme/web.git')).toBeNull();
    expect(parseAzureRemote('https://dev.azure.com/acme/P/_git')).toBeNull();
  });

  it('maps reviewer votes to review states', () => {
    expect([10, 5, 0, -5, -10].map((v) => azVoteToState(v))).toEqual([
      'approved',
      'approved',
      'pending',
      'changes_requested',
      'changes_requested',
    ]);
  });

  it('normalizes PRs: status/isDraft, reviewers, labels, and $skip pagination', async () => {
    server.use(
      conn,
      http.get(`${API}/git/repositories/web/pullrequests`, ({ request }) => {
        const u = new URL(request.url);
        expect(u.searchParams.get('api-version')).toBe('7.1');
        expect(u.searchParams.get('searchCriteria.status')).toBe('all');
        expect(u.searchParams.get('searchCriteria.reviewerId')).toBe('me-id');
        const skip = Number(u.searchParams.get('$skip') ?? 0);
        if (skip === 50)
          return HttpResponse.json({ value: [azPr({ pullRequestId: 99, status: 'abandoned' })] });
        return HttpResponse.json({
          value: [
            azPr({
              reviewers: [
                { id: 'me-id', displayName: 'Me', vote: 0, isRequired: true },
                { id: 'bob', displayName: 'Bob', vote: 5 },
              ],
            }),
            azPr({ pullRequestId: 13, isDraft: true }),
            azPr({ pullRequestId: 14, status: 'completed', closedDate: '2024-03-02T00:00:00Z' }),
            azPr({ pullRequestId: 15, reviewers: [{ id: 'bob', vote: -10 }], mergeStatus: 'conflicts' }),
            ...Array.from({ length: 46 }, (_, i) => azPr({ pullRequestId: 100 + i })),
          ],
        });
      }),
    );
    const p = provider();
    const page = await p.listPullRequests(ref, { preset: 'review-requested', state: 'all' });
    const [a, b, c, d] = page.items as PullRequest[];
    expect(a!.state).toBe('open');
    expect(a!.reviewers.map((r) => [r.state, r.required])).toEqual([
      ['pending', true],
      ['approved', undefined],
    ]);
    expect(a!.reviewDecision).toBe('review_required');
    expect(a!.viewer.reviewRequested).toBe(true);
    expect(a!.head.branch).toBe('feature/x');
    expect(a!.labels).toEqual([{ name: 'ui' }]);
    expect(a!.webUrl).toBe('https://dev.azure.com/acme/My%20Proj/_git/web/pullrequest/12');
    expect(b!.state).toBe('draft');
    expect(c!.state).toBe('merged');
    expect(c!.mergedAt).toBe('2024-03-02T00:00:00.000Z');
    expect(d!.reviewDecision).toBe('changes_requested');
    expect(d!.mergeable).toBe('conflicting');
    expect(d!.rollup).toBe('failure');
    expect(page.nextCursor).toBe('50');
    const next = await p.listPullRequests(ref, { preset: 'review-requested', state: 'all' }, page.nextCursor);
    expect(next.items[0]!.state).toBe('closed');
    expect(next.nextCursor).toBeUndefined();
  });

  it('getPullRequest folds statuses + policy evaluations into checks and counts comments', async () => {
    server.use(
      conn,
      http.get(`${API}/git/repositories/web/pullrequests/12`, () => HttpResponse.json(azPr())),
      http.get(`${API}/git/repositories/web/pullrequests/12/statuses`, () =>
        HttpResponse.json({
          value: [{ id: 1, state: 'succeeded', context: { name: 'sonar', genre: 'qa' } }],
        }),
      ),
      http.get(`${API}/policy/evaluations`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('artifactId')).toBe(
          'vstfs:///CodeReview/CodeReviewId/proj-1/12',
        );
        return HttpResponse.json({
          value: [
            {
              evaluationId: 'e',
              status: 'running',
              configuration: { isBlocking: true, type: { displayName: 'Build' } },
              context: { buildId: 3 },
            },
          ],
        });
      }),
      http.get(`${API}/git/repositories/web/pullrequests/12/threads`, () =>
        HttpResponse.json({
          value: [
            {
              id: 1,
              publishedDate: '2024-03-01T01:00:00Z',
              comments: [
                {
                  id: 1,
                  author: { id: 'bob' },
                  content: 'hi',
                  publishedDate: '2024-03-01T01:00:00Z',
                  commentType: 'text',
                },
              ],
            },
            {
              id: 2,
              publishedDate: '2024-03-01T01:00:00Z',
              comments: [
                { id: 1, author: { id: 'bob' }, content: 'voted', commentType: 'system', publishedDate: 'x' },
              ],
            },
          ],
        }),
      ),
    );
    const pr = (await provider().getPullRequest(ref, 12)) as PullRequest;
    expect(pr.checksRollup).toBe('pending');
    expect(pr.commentsCount).toBe(1);
  });

  it('maps threads to timeline items (file threads, votes, comments)', async () => {
    server.use(
      conn,
      http.get(`${API}/git/repositories/web/pullrequests/12/threads`, () =>
        HttpResponse.json({
          value: [
            {
              id: 7,
              publishedDate: '2024-03-01T02:00:00Z',
              status: 'fixed',
              threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 9 } },
              comments: [
                {
                  id: 1,
                  author: { id: 'bob' },
                  content: 'fix',
                  publishedDate: '2024-03-01T02:00:00Z',
                  commentType: 'text',
                },
                {
                  id: 2,
                  parentCommentId: 1,
                  author: { id: 'me-id' },
                  content: 'done',
                  publishedDate: '2024-03-01T02:10:00Z',
                  commentType: 'text',
                },
              ],
            },
            {
              id: 8,
              publishedDate: '2024-03-01T03:00:00Z',
              properties: {
                CodeReviewThreadType: { $value: 'VoteUpdate' },
                CodeReviewVoteResult: { $value: '-10' },
              },
              comments: [
                {
                  id: 1,
                  author: { id: 'bob' },
                  content: 'Bob voted -10',
                  commentType: 'system',
                  publishedDate: 'x',
                },
              ],
            },
            {
              id: 6,
              publishedDate: '2024-03-01T01:00:00Z',
              comments: [
                {
                  id: 1,
                  author: { id: 'me-id' },
                  content: 'hello',
                  publishedDate: '2024-03-01T01:00:00Z',
                  commentType: 'text',
                },
              ],
            },
          ],
        }),
      ),
    );
    const t = await provider().getTimeline(ref, 12);
    expect(t.items.map((i) => i.kind)).toEqual(['comment', 'thread', 'review']);
    expect(t.items[0]).toMatchObject({ id: '12:6:1', editable: true });
    expect(t.items[1]).toMatchObject({
      id: '12:7',
      path: 'src/a.ts',
      line: 9,
      side: 'RIGHT',
      resolved: true,
    });
    expect(t.items[2]).toMatchObject({ state: 'changes_requested' });
  });

  it('completes a PR with merge strategy, last source commit and deleteSourceBranch', async () => {
    let body: any;
    server.use(
      http.patch(`${API}/git/repositories/web/pullrequests/12`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(azPr({ status: 'completed', lastMergeCommit: { commitId: 'merged1' } }));
      }),
    );
    const r = await provider().merge(ref, 12, {
      method: 'rebase-merge',
      expectedHeadSha: 'src1',
      deleteBranch: true,
      title: 'T',
    });
    expect(body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'src1' },
      completionOptions: { mergeStrategy: 'rebaseMerge', deleteSourceBranch: true, mergeCommitMessage: 'T' },
    });
    expect(r).toEqual({ merged: true, sha: 'merged1' });
  });

  it('abandon, draft toggle and vote', async () => {
    const bodies: unknown[] = [];
    server.use(
      conn,
      http.patch(`${API}/git/repositories/web/pullrequests/12`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(azPr());
      }),
      http.put(`${API}/git/repositories/web/pullrequests/12/reviewers/me-id`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    const p = provider();
    await p.close(ref, 12);
    await p.setDraft!(ref, 12, true);
    await p.submitReview(ref, 12, { event: 'APPROVE', commitSha: 'x' });
    expect(bodies).toEqual([{ status: 'abandoned' }, { isDraft: true }, { id: 'me-id', vote: 10 }]);
  });

  it('pages projects with x-ms-continuationtoken', async () => {
    server.use(
      http.get(`${ORG}/_apis/projects`, ({ request }) => {
        const token = new URL(request.url).searchParams.get('continuationToken');
        if (token === 'tok2') return HttpResponse.json({ value: [{ name: 'B' }] });
        return HttpResponse.json(
          { value: [{ name: 'A' }] },
          { headers: { 'x-ms-continuationtoken': 'tok2' } },
        );
      }),
    );
    expect(await provider().listOwners()).toEqual([
      { login: 'acme/A', kind: 'project' },
      { login: 'acme/B', kind: 'project' },
    ]);
  });

  it('maps 401, 203 sign-in pages and 429 to ProviderErrors', async () => {
    server.use(
      http.get(`${API}/git/repositories/web`, () => new HttpResponse('nope', { status: 401 })),
      http.get(
        `${API}/git/repositories/web2`,
        () =>
          new HttpResponse('<html>Sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } }),
      ),
      http.get(`${API}/git/repositories/web3`, () =>
        HttpResponse.json({ message: 'throttled' }, { status: 429, headers: { 'retry-after': '5' } }),
      ),
    );
    const p = provider();
    await expect(p.getRepo(ref)).rejects.toMatchObject({ code: 'auth_required' });
    await expect(p.getRepo({ ...ref, name: 'web2' })).rejects.toMatchObject({ code: 'auth_required' });
    await expect(p.getRepo({ ...ref, name: 'web3' })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('PAT auth header is Basic with an empty username; JWT is Bearer', () => {
    expect(AZURE_AUTH.authHeader('pat')).toBe(`Basic ${btoa(':pat')}`);
    expect(AZURE_AUTH.authHeader('eyJabc')).toBe('Bearer eyJabc');
  });
});

describe('Azure Boards', () => {
  it('builds WIQL presets', () => {
    expect(wiqlFor('P', { preset: 'assigned' })).toContain('[System.AssignedTo] = @Me');
    expect(wiqlFor("O'Brien", { preset: 'created' })).toContain("[System.TeamProject] = 'O''Brien'");
    expect(wiqlFor('P', { query: 'SELECT x' })).toBe('SELECT x');
  });

  it('lists assigned work items via WIQL + batch fetch', async () => {
    server.use(
      http.post(`${API}/wit/wiql`, () => HttpResponse.json({ workItems: [{ id: 1 }, { id: 2 }] })),
      http.get(`${ORG}/_apis/wit/workitems`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('ids')).toBe('1,2');
        return HttpResponse.json({
          value: [
            {
              id: 1,
              fields: {
                'System.Title': 'One',
                'System.State': 'Active',
                'System.Tags': 'a; b',
                'System.WorkItemType': 'Bug',
              },
            },
            { id: 2, fields: { 'System.Title': 'Two', 'System.State': 'New' } },
          ],
        });
      }),
    );
    const t = createAzureBoardsTracker({ http: client(), host: 'dev.azure.com', organization: 'acme' });
    const page = await t.listIssues('acme/My Proj', { preset: 'assigned' });
    expect(page.items.map((i) => [i.key, i.stateCategory, i.bodyFormat])).toEqual([
      ['1', 'in_progress', 'html'],
      ['2', 'todo', 'html'],
    ]);
    expect(page.items[0]!.labels).toEqual(['a', 'b']);
  });
});
