import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubIssueTracker } from '../src/github/issues';
import { createGitHubProvider, githubGraphqlUrl, matchGitHubRemoteUrl } from '../src/github/provider';
import { HttpClient, ProviderError } from '../src/http';
import type { IntegrationId, PullRequest, RepoRef } from '../src/types';

/**
 * Minimal GraphQL operation matcher on top of `http.post` (msw's `graphql` namespace needs the
 * `graphql` peer package, which isn't installed). Falls through when the operation name differs.
 */
function gqlLink(url: string) {
  const op = (
    name: string,
    resolver: (a: { variables: Record<string, any> }) => Response | Promise<Response>,
  ) =>
    http.post(url, async ({ request }) => {
      const body = (await request.clone().json()) as { query: string; variables?: Record<string, any> };
      if (/(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] !== name) return undefined;
      return resolver({ variables: body.variables ?? {} });
    });
  return { query: op, mutation: op };
}

const API = 'https://api.github.com';
const GQL = 'https://api.github.com/graphql';
const gh = gqlLink(GQL);
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = (baseUrl = API): HttpClient =>
  new HttpClient({
    baseUrl,
    auth: () => 'Bearer test-token',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    retries: 0,
  });
const integration: IntegrationId = { kind: 'github', host: 'github.com', accountId: '1' };
const ref: RepoRef = { integration, owner: 'acme', name: 'app' };
const provider = () => createGitHubProvider({ http: client(), host: 'github.com', accountId: '1' });

const actor = (login: string) => ({
  login,
  avatarUrl: `https://avatars/${login}`,
  id: `U_${login}`,
  name: login.toUpperCase(),
});

function prNode(o: Record<string, unknown> = {}) {
  return {
    id: 'PR_1',
    number: 1,
    title: 'Add login',
    body: 'Body',
    isDraft: false,
    state: 'OPEN',
    url: 'https://github.com/acme/app/pull/1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    isCrossRepository: false,
    author: actor('alice'),
    headRefName: 'feature/login',
    headRefOid: 'aaa111',
    headRepository: {
      id: 'R_1',
      name: 'app',
      url: 'https://github.com/acme/app',
      sshUrl: 'git@github.com:acme/app.git',
      owner: { login: 'acme' },
    },
    baseRefName: 'main',
    baseRefOid: 'bbb222',
    baseRepository: {
      id: 'R_1',
      name: 'app',
      owner: { login: 'acme' },
      viewerPermission: 'WRITE',
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
    },
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    viewerCanUpdate: true,
    viewerDidAuthor: false,
    comments: { totalCount: 4 },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: actor('bob') }] },
    assignees: { nodes: [actor('alice')] },
    labels: { nodes: [{ name: 'bug', color: 'ff0000' }] },
    milestone: { id: 'MI_1', number: 3, title: 'v1' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...o,
  };
}

describe('GitHub PR normalization', () => {
  it('lists PRs via GraphQL and normalizes open/draft/merged/fork/deleted-fork', async () => {
    let vars: Record<string, unknown> = {};
    server.use(
      gh.query('GitHappensPrList', ({ variables }) => {
        vars = variables;
        return HttpResponse.json({
          data: {
            viewer: { login: 'carol' },
            repository: {
              pullRequests: {
                totalCount: 5,
                pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
                nodes: [
                  prNode(),
                  prNode({
                    number: 2,
                    isDraft: true,
                    reviewDecision: 'REVIEW_REQUIRED',
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
                    reviewRequests: {
                      nodes: [
                        {
                          asCodeOwner: true,
                          requestedReviewer: {
                            __typename: 'User',
                            id: 'U_carol',
                            login: 'carol',
                            name: 'Carol',
                          },
                        },
                        { requestedReviewer: { __typename: 'Team', id: 'T_1', slug: 'core', name: 'Core' } },
                      ],
                    },
                  }),
                  prNode({ number: 3, state: 'MERGED', mergedAt: '2026-01-03T00:00:00Z' }),
                  prNode({
                    number: 4,
                    isCrossRepository: true,
                    headRepository: {
                      id: 'R_9',
                      name: 'app-fork',
                      url: 'https://github.com/dave/app-fork',
                      sshUrl: 'git@github.com:dave/app-fork.git',
                      owner: { login: 'dave' },
                    },
                    mergeable: 'CONFLICTING',
                  }),
                  prNode({
                    number: 5,
                    isCrossRepository: true,
                    headRepository: null,
                    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                  }),
                ],
              },
            },
          },
        });
      }),
    );
    const page = await provider().listPullRequests(ref, { state: 'open' });
    expect(vars).toMatchObject({ owner: 'acme', name: 'app', states: ['OPEN'], first: 50, after: null });
    expect(page.nextCursor).toBe('CUR1');
    expect(page.total).toBe(5);
    const [open, draft, merged, fork, deleted] = page.items as [
      PullRequest,
      PullRequest,
      PullRequest,
      PullRequest,
      PullRequest,
    ];

    expect(open).toMatchObject({
      number: 1,
      state: 'open',
      checksRollup: 'success',
      rollup: 'success',
      reviewDecision: 'approved',
      mergeable: 'mergeable',
      labels: [{ name: 'bug', color: '#ff0000' }],
      milestone: { id: '3', title: 'v1' },
      allowedMergeMethods: ['merge', 'squash'],
      commentsCount: 4,
      isCrossRepository: false,
      head: { branch: 'feature/login', sha: 'aaa111', repoCloneUrl: 'https://github.com/acme/app.git' },
      base: { branch: 'main', sha: 'bbb222' },
      viewer: { canMerge: true, canEdit: true, canApprove: true, isAuthor: false, reviewRequested: false },
    });
    expect(open.reviewers).toEqual([{ user: expect.objectContaining({ login: 'bob' }), state: 'approved' }]);
    expect(open.head.repo).toMatchObject({ owner: 'acme', name: 'app' });

    expect(draft.state).toBe('draft');
    expect(draft.rollup).toBe('pending');
    expect(draft.viewer.reviewRequested).toBe(true);
    expect(draft.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ login: 'carol' }),
          state: 'pending',
          required: true,
        }),
        expect.objectContaining({
          user: expect.objectContaining({ login: 'core', isTeam: true }),
          state: 'pending',
        }),
      ]),
    );

    expect(merged.state).toBe('merged');
    expect(merged.mergedAt).toBe('2026-01-03T00:00:00Z');
    expect(merged.viewer.canMerge).toBe(false);

    expect(fork.isCrossRepository).toBe(true);
    expect(fork.head.repo).toMatchObject({ owner: 'dave', name: 'app-fork', integration });
    expect(fork.head.repoCloneUrl).toBe('https://github.com/dave/app-fork.git');
    expect(fork.rollup).toBe('failure');

    expect(deleted.head.repo).toBeNull();
    expect(deleted.head.repoCloneUrl).toBeUndefined();
    expect(deleted.checksRollup).toBe('none');
  });

  it('uses the search API for presets', async () => {
    let q = '';
    server.use(
      gh.query('GitHappensPrSearch', ({ variables }) => {
        q = String(variables.q);
        return HttpResponse.json({
          data: {
            viewer: { login: 'alice' },
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [prNode(), {}],
            },
          },
        });
      }),
    );
    const page = await provider().listPullRequests(ref, { preset: 'mine', query: 'label:bug' });
    expect(q).toContain('repo:acme/app');
    expect(q).toContain('is:pr');
    expect(q).toContain('is:open');
    expect(q).toContain('author:@me');
    expect(q).toContain('label:bug');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it('getPullRequest honors ETags', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/pulls/1`, ({ request }) =>
        request.headers.get('if-none-match') === '"v1"'
          ? new HttpResponse(null, { status: 304 })
          : HttpResponse.json({ number: 1 }, { headers: { etag: '"v2"' } }),
      ),
      gh.query('GitHappensPr', () =>
        HttpResponse.json({
          data: {
            viewer: { login: 'x' },
            repository: { pullRequest: prNode({ viewerCanMergeAsAdmin: true }) },
          },
        }),
      ),
    );
    const p = provider();
    expect(await p.getPullRequest(ref, 1, { etag: '"v1"' })).toBe('not-modified');
    const pr = (await p.getPullRequest(ref, 1)) as PullRequest;
    expect(pr.etag).toBe('"v2"');
    expect(pr.title).toBe('Add login');
  });

  it('builds the timeline from items + review threads', async () => {
    server.use(
      gh.query('GitHappensPrTimeline', ({ variables }) => {
        expect(variables.withThreads).toBe(true);
        return HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  pageInfo: { hasNextPage: true, endCursor: 'T1' },
                  nodes: [
                    {
                      __typename: 'PullRequestCommit',
                      commit: {
                        oid: 'c1',
                        committedDate: '2026-01-01T01:00:00Z',
                        author: { user: actor('alice') },
                      },
                    },
                    {
                      __typename: 'PullRequestCommit',
                      commit: {
                        oid: 'c2',
                        committedDate: '2026-01-01T01:01:00Z',
                        author: { user: actor('alice') },
                      },
                    },
                    {
                      __typename: 'IssueComment',
                      id: 'IC_1',
                      databaseId: 77,
                      body: 'hi',
                      createdAt: '2026-01-01T02:00:00Z',
                      viewerCanUpdate: true,
                      author: actor('bob'),
                    },
                    {
                      __typename: 'PullRequestReview',
                      id: 'RV_1',
                      databaseId: 8,
                      state: 'CHANGES_REQUESTED',
                      body: 'fix',
                      createdAt: '2026-01-01T03:00:00Z',
                      author: actor('bob'),
                    },
                    {
                      __typename: 'PullRequestReview',
                      id: 'RV_2',
                      databaseId: 9,
                      state: 'COMMENTED',
                      body: '',
                      createdAt: '2026-01-01T03:30:00Z',
                      author: actor('bob'),
                    },
                    {
                      __typename: 'HeadRefForcePushedEvent',
                      createdAt: '2026-01-01T04:00:00Z',
                      actor: actor('alice'),
                      beforeCommit: { oid: 'c2' },
                      afterCommit: { oid: 'c3' },
                    },
                    {
                      __typename: 'LabeledEvent',
                      createdAt: '2026-01-01T05:00:00Z',
                      actor: actor('bob'),
                      label: { name: 'bug' },
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: 'PRRT_1',
                      isResolved: true,
                      isOutdated: true,
                      path: 'src/a.ts',
                      line: null,
                      originalLine: 12,
                      diffSide: 'RIGHT',
                      comments: {
                        nodes: [
                          {
                            id: 'C1',
                            databaseId: 101,
                            body: 'nit',
                            createdAt: '2026-01-01T03:10:00Z',
                            diffHunk: '@@ -1 +1 @@',
                            author: actor('bob'),
                          },
                          {
                            id: 'C2',
                            databaseId: 102,
                            body: 'done',
                            createdAt: '2026-01-01T03:20:00Z',
                            author: actor('alice'),
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }),
    );
    const t = await provider().getTimeline(ref, 1);
    expect(t.nextCursor).toBe('T1');
    expect(t.items.map((i) => i.kind)).toEqual([
      'commits',
      'comment',
      'review',
      'thread',
      'commits',
      'event',
    ]);
    expect(t.items[0]).toMatchObject({ kind: 'commits', shas: ['c1', 'c2'] });
    expect(t.items[1]).toMatchObject({ kind: 'comment', id: '77', editable: true });
    expect(t.items[2]).toMatchObject({ kind: 'review', state: 'changes_requested' });
    expect(t.items[3]).toMatchObject({
      kind: 'thread',
      id: 'PRRT_1',
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
      resolved: true,
      outdated: true,
      diffHunk: '@@ -1 +1 @@',
    });
    expect(t.items[4]).toMatchObject({ kind: 'commits', forced: true, shas: ['c3'] });
    expect(t.items[5]).toMatchObject({ kind: 'event', event: 'labeled', detail: 'bug' });
  });

  it('combines check runs and commit statuses', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/commits/abc/check-runs`, () =>
        HttpResponse.json({
          check_runs: [
            {
              id: 1,
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              app: { slug: 'github-actions', name: 'GitHub Actions' },
              html_url: 'https://x/1',
            },
            {
              id: 2,
              name: 'lint',
              status: 'in_progress',
              conclusion: null,
              app: { slug: 'other', name: 'Other' },
            },
          ],
        }),
      ),
      http.get(`${API}/repos/acme/app/commits/abc/status`, () =>
        HttpResponse.json({
          statuses: [
            {
              id: 5,
              context: 'ci/jenkins',
              state: 'success',
              created_at: 'a',
              updated_at: 'b',
              target_url: 'https://j',
            },
          ],
        }),
      ),
    );
    const checks = await provider().getChecks(ref, 'abc');
    expect(checks).toEqual([
      expect.objectContaining({
        id: '1',
        status: 'failure',
        canRerun: true,
        provider: 'actions',
        group: 'GitHub Actions',
      }),
      expect.objectContaining({ id: '2', status: 'in_progress', canRerun: false, provider: 'other' }),
      expect.objectContaining({
        id: 'status:5',
        name: 'ci/jenkins',
        status: 'success',
        provider: 'status-api',
      }),
    ]);
  });
});

describe('GitHub REST, pagination and errors', () => {
  const repo = (owner: string, name: string) => ({
    id: Math.floor(Math.random() * 1e6),
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    private: false,
    fork: true,
    default_branch: 'main',
    clone_url: `https://github.com/${owner}/${name}.git`,
    ssh_url: `git@github.com:${owner}/${name}.git`,
    html_url: `https://github.com/${owner}/${name}`,
    updated_at: '2026-01-01T00:00:00Z',
    permissions: { admin: false, push: true, pull: true },
  });

  it('paginates forks via Link headers', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/forks`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        if (page === '2') return HttpResponse.json([repo('eve', 'app')]);
        return HttpResponse.json([repo('dave', 'app')], {
          headers: {
            link: `<${API}/repos/acme/app/forks?per_page=100&sort=newest&page=2>; rel="next", <${API}/repos/acme/app/forks?page=2>; rel="last"`,
          },
        });
      }),
    );
    const p = provider();
    const first = await p.listForks(ref);
    expect(first.items[0]).toMatchObject({
      fullName: 'dave/app',
      isFork: true,
      viewerPermission: 'write',
      ref: { owner: 'dave', integration },
    });
    expect(first.nextCursor).toContain('page=2');
    const second = await p.listForks(ref, first.nextCursor);
    expect(second.items[0]!.fullName).toBe('eve/app');
    expect(second.nextCursor).toBeUndefined();
  });

  it('maps rate limiting to rate_limited with retryAt', async () => {
    server.use(
      http.get(`${API}/repos/acme/app`, () =>
        HttpResponse.json(
          { message: 'API rate limit exceeded' },
          {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-limit': '5000',
              'x-ratelimit-reset': '1900000000',
            },
          },
        ),
      ),
    );
    const err = await provider()
      .getRepo(ref)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('rate_limited');
    expect((err as ProviderError).serialized.retryAt).toBe(1_900_000_000_000);
  });

  it('maps GraphQL RATE_LIMITED errors too', async () => {
    server.use(
      gh.query('GitHappensPrList', () =>
        HttpResponse.json(
          { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
          { headers: { 'x-ratelimit-reset': '1900000001' } },
        ),
      ),
    );
    const err = (await provider()
      .listPullRequests(ref, {})
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe('rate_limited');
    expect(err.serialized.retryAt).toBe(1_900_000_001_000);
  });

  it('maps 401 to auth_required', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })),
    );
    await expect(provider().getViewer()).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('reports missing scopes (REST headers and GraphQL)', async () => {
    server.use(
      http.post(`${API}/user/keys`, () =>
        HttpResponse.json(
          { message: 'Not Found' },
          {
            status: 403,
            headers: {
              'x-accepted-oauth-scopes': 'admin:public_key, write:public_key',
              'x-oauth-scopes': 'repo, write:public_key',
            },
          },
        ),
      ),
      gh.query('GitHappensAssignable', () =>
        HttpResponse.json({
          data: null,
          errors: [
            {
              type: 'INSUFFICIENT_SCOPES',
              message:
                "Your token has not been granted the required scopes to execute this query. The 'login' field requires one of the following scopes: ['read:org'], but your token has only been granted the: ['repo'] scopes.",
            },
          ],
        }),
      ),
      http.get(`${API}/orgs/acme/teams`, () => HttpResponse.json([])),
    );
    const p = provider();
    const e1 = (await p.uploadSshKey!('k', 'ssh-ed25519 AAAA x').catch((e: unknown) => e)) as ProviderError;
    expect(e1.code).toBe('insufficient_scope');
    expect(e1.serialized.missingScopes).toEqual(['admin:public_key']);
    const e2 = (await p.searchUsers(ref, 'a').catch((e: unknown) => e)) as ProviderError;
    expect(e2.code).toBe('insufficient_scope');
    expect(e2.serialized.missingScopes).toEqual(['read:org']);
  });

  it('reads granted scopes from X-OAuth-Scopes', async () => {
    server.use(
      http.get(`${API}/user`, () =>
        HttpResponse.json({ id: 1, login: 'a' }, { headers: { 'x-oauth-scopes': 'repo, read:org' } }),
      ),
    );
    expect(await provider().getGrantedScopes()).toEqual(['repo', 'read:org']);
  });

  it('merges with the expected head sha and deletes the branch', async () => {
    const calls: string[] = [];
    let mergeBody: unknown;
    server.use(
      http.get(`${API}/repos/acme/app/pulls/7`, () =>
        HttpResponse.json({ head: { ref: 'feat/x', repo: { full_name: 'dave/app' } } }),
      ),
      http.put(`${API}/repos/acme/app/pulls/7/merge`, async ({ request }) => {
        mergeBody = await request.json();
        return HttpResponse.json({ sha: 'm1', merged: true, message: 'Pull Request successfully merged' });
      }),
      http.delete(`${API}/repos/dave/app/git/refs/heads/feat/x`, ({ request }) => {
        calls.push(new URL(request.url).pathname);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const r = await provider().merge(ref, 7, {
      method: 'squash',
      expectedHeadSha: 'h1',
      deleteBranch: true,
      title: 'T',
    });
    expect(mergeBody).toEqual({ merge_method: 'squash', commit_title: 'T', sha: 'h1' });
    expect(r).toMatchObject({ merged: true, sha: 'm1' });
    expect(calls).toEqual(['/repos/dave/app/git/refs/heads/feat/x']);
  });

  it('maps a moved head (409) to conflict', async () => {
    server.use(
      http.put(`${API}/repos/acme/app/pulls/7/merge`, () =>
        HttpResponse.json({ message: 'Head branch was modified.' }, { status: 409 }),
      ),
    );
    await expect(provider().merge(ref, 7, { method: 'merge', expectedHeadSha: 'old' })).rejects.toMatchObject(
      { code: 'conflict' },
    );
    await expect(
      provider().merge(ref, 7, { method: 'fast-forward', expectedHeadSha: 'old' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('creates a cross-repo PR and applies follow-ups', async () => {
    const seen: Record<string, unknown> = {};
    server.use(
      http.post(`${API}/repos/acme/app/pulls`, async ({ request }) => {
        seen.create = await request.json();
        return HttpResponse.json({ number: 9 }, { status: 201 });
      }),
      http.patch(`${API}/repos/acme/app/issues/9`, async ({ request }) => {
        seen.issue = await request.json();
        return HttpResponse.json({});
      }),
      http.post(`${API}/repos/acme/app/pulls/9/requested_reviewers`, async ({ request }) => {
        seen.reviewers = await request.json();
        return HttpResponse.json({});
      }),
      gh.query('GitHappensPr', ({ variables }) => {
        expect(variables.number).toBe(9);
        return HttpResponse.json({
          data: { viewer: { login: 'dave' }, repository: { pullRequest: prNode({ number: 9 }) } },
        });
      }),
    );
    const pr = await provider().createPullRequest({
      base: ref,
      baseBranch: 'main',
      head: { integration, owner: 'dave', name: 'app' },
      headBranch: 'feat/x',
      title: 'T',
      body: 'B',
      draft: true,
      reviewers: ['bob'],
      teamReviewers: ['core'],
      labels: ['bug'],
      assignees: ['dave'],
      milestone: '3',
    });
    expect(pr.number).toBe(9);
    expect(seen.create).toEqual({ title: 'T', body: 'B', head: 'dave:feat/x', base: 'main', draft: true });
    expect(seen.issue).toEqual({ assignees: ['dave'], labels: ['bug'], milestone: 3 });
    expect(seen.reviewers).toEqual({ reviewers: ['bob'], team_reviewers: ['core'] });
  });

  it('toggles draft via GraphQL mutations and resolves threads', async () => {
    const ops: string[] = [];
    server.use(
      gh.query('GitHappensPrId', () =>
        HttpResponse.json({ data: { repository: { pullRequest: { id: 'PR_X' } } } }),
      ),
      gh.mutation('GitHappensConvertToDraft', ({ variables }) => {
        ops.push(`draft:${variables.id}`);
        return HttpResponse.json({
          data: { convertPullRequestToDraft: { pullRequest: { id: 'PR_X', isDraft: true } } },
        });
      }),
      gh.mutation('GitHappensReadyForReview', ({ variables }) => {
        ops.push(`ready:${variables.id}`);
        return HttpResponse.json({
          data: { markPullRequestReadyForReview: { pullRequest: { id: 'PR_X', isDraft: false } } },
        });
      }),
      gh.mutation('GitHappensResolveThread', ({ variables }) => {
        ops.push(`resolve:${variables.id}`);
        return HttpResponse.json({
          data: { resolveReviewThread: { thread: { id: 'T', isResolved: true } } },
        });
      }),
    );
    const p = provider();
    await p.setDraft!(ref, 1, true);
    await p.setDraft!(ref, 1, false);
    await p.setThreadResolved!(ref, 'PRRT_1', true);
    expect(ops).toEqual(['draft:PR_X', 'ready:PR_X', 'resolve:PRRT_1']);
  });

  it('lists PR templates from .github via the contents API', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    server.use(
      http.get(`${API}/repos/acme/app/contents/.github`, () =>
        HttpResponse.json([
          { name: 'PULL_REQUEST_TEMPLATE', path: '.github/PULL_REQUEST_TEMPLATE', type: 'dir' },
          { name: 'pull_request_template.md', path: '.github/pull_request_template.md', type: 'file' },
        ]),
      ),
      http.get(`${API}/repos/acme/app/contents`, () =>
        HttpResponse.json([{ name: 'README.md', path: 'README.md', type: 'file' }]),
      ),
      http.get(`${API}/repos/acme/app/contents/docs`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
      http.get(`${API}/repos/acme/app/contents/.github/PULL_REQUEST_TEMPLATE`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('ref')).toBe('feat');
        return HttpResponse.json([
          { name: 'bugfix.md', path: '.github/PULL_REQUEST_TEMPLATE/bugfix.md', type: 'file' },
        ]);
      }),
      http.get(`${API}/repos/acme/app/contents/.github/PULL_REQUEST_TEMPLATE/bugfix.md`, () =>
        HttpResponse.json({ content: b64('## Bug'), encoding: 'base64' }),
      ),
      http.get(`${API}/repos/acme/app/contents/.github/pull_request_template.md`, () =>
        HttpResponse.json({ content: b64('## Default'), encoding: 'base64' }),
      ),
    );
    const t = await provider().listPrTemplates(ref, 'feat');
    expect(t).toEqual([
      { name: 'bugfix', path: '.github/PULL_REQUEST_TEMPLATE/bugfix.md', body: '## Bug' },
      { name: 'Default', path: '.github/pull_request_template.md', body: '## Default' },
    ]);
  });

  it('lists Actions runs and reruns failed jobs', async () => {
    let rerun = '';
    server.use(
      http.get(`${API}/repos/acme/app/actions/runs`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('branch')).toBe('main');
        return HttpResponse.json({
          total_count: 1,
          workflow_runs: [
            {
              id: 42,
              name: 'CI',
              display_title: 'Fix',
              run_number: 7,
              head_branch: 'main',
              event: 'push',
              status: 'completed',
              conclusion: 'failure',
              created_at: 'a',
              updated_at: 'b',
              html_url: 'https://r',
              actor: { id: 1, login: 'alice' },
            },
          ],
        });
      }),
      http.post(`${API}/repos/acme/app/actions/runs/42/rerun-failed-jobs`, ({ request }) => {
        rerun = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 201 });
      }),
    );
    const p = provider();
    const runs = await p.listCiRuns!(ref, { branch: 'main' });
    expect(runs.items[0]).toMatchObject({
      id: '42',
      status: 'failure',
      runNumber: 7,
      group: 'CI',
      actor: { login: 'alice' },
    });
    await p.rerunCi!(ref, '42', { failedOnly: true });
    expect(rerun).toBe('/repos/acme/app/actions/runs/42/rerun-failed-jobs');
  });
});

describe('GitHub Enterprise + remote URL mapping', () => {
  it('derives the GraphQL endpoint for GHE', async () => {
    expect(githubGraphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(githubGraphqlUrl('https://ghe.acme.com/api/v3')).toBe('https://ghe.acme.com/api/graphql');
    const ghe = gqlLink('https://ghe.acme.com/api/graphql');
    server.use(
      ghe.query('GitHappensPrList', () =>
        HttpResponse.json({
          data: {
            viewer: { login: 'a' },
            repository: {
              pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        }),
      ),
    );
    const p = createGitHubProvider({
      http: client('https://ghe.acme.com/api/v3'),
      host: 'ghe.acme.com',
      accountId: '1',
    });
    expect(
      (await p.listPullRequests({ ...ref, integration: { ...integration, host: 'ghe.acme.com' } }, {})).items,
    ).toEqual([]);
  });

  it.each([
    ['https://github.com/acme/app.git', { owner: 'acme', name: 'app' }],
    ['https://github.com/acme/app', { owner: 'acme', name: 'app' }],
    ['https://user@github.com/acme/app.git/', { owner: 'acme', name: 'app' }],
    ['git@github.com:acme/app.git', { owner: 'acme', name: 'app' }],
    ['github.com:acme/app', { owner: 'acme', name: 'app' }],
    ['ssh://git@github.com/acme/app.git', { owner: 'acme', name: 'app' }],
    ['ssh://git@ssh.github.com:443/acme/app.git', { owner: 'acme', name: 'app' }],
    ['https://GitHub.com/Acme/App.git', { owner: 'Acme', name: 'App' }],
    ['https://gitlab.com/acme/app.git', null],
    ['https://github.com/acme', null],
    ['git@ghe.acme.com:acme/app.git', null],
  ])('github.com matches %s', (url, expected) => {
    expect(matchGitHubRemoteUrl('github.com', url)).toEqual(expected);
    expect(provider().matchRemoteUrl(url)).toEqual(expected);
  });

  it.each([
    ['https://ghe.acme.com/team/svc.git', { owner: 'team', name: 'svc' }],
    ['git@ghe.acme.com:team/svc.git', { owner: 'team', name: 'svc' }],
    ['ssh://git@ghe.acme.com:2222/team/svc.git', { owner: 'team', name: 'svc' }],
    ['https://github.com/team/svc.git', null],
  ])('GHE host matches %s', (url, expected) => {
    expect(matchGitHubRemoteUrl('https://ghe.acme.com/', url)).toEqual(expected);
  });
});

describe('GitHub issue tracker', () => {
  it('lists issues via search, excluding PRs', async () => {
    let q = '';
    server.use(
      http.get(`${API}/search/issues`, ({ request }) => {
        q = new URL(request.url).searchParams.get('q') ?? '';
        return HttpResponse.json(
          {
            total_count: 2,
            items: [
              {
                id: 11,
                number: 12,
                title: 'Crash',
                body: 'x',
                state: 'open',
                labels: [{ name: 'bug' }],
                assignees: [{ id: 1, login: 'alice' }],
                user: { id: 2, login: 'bob' },
                created_at: 'a',
                updated_at: 'b',
                html_url: 'https://github.com/acme/app/issues/12',
                comments: 3,
                repository_url: `${API}/repos/acme/app`,
              },
              {
                id: 13,
                number: 14,
                title: 'PR',
                state: 'open',
                labels: [],
                created_at: 'a',
                updated_at: 'b',
                html_url: '',
                pull_request: {},
              },
            ],
          },
          { headers: { link: `<${API}/search/issues?q=x&page=2>; rel="next"` } },
        );
      }),
    );
    const t = createGitHubIssueTracker({ http: client(), host: 'github.com', accountId: '1' });
    const page = await t.listIssues('acme/app', { preset: 'assigned' });
    expect(q).toBe('is:issue repo:acme/app is:open assignee:@me');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      key: '#12',
      title: 'Crash',
      stateCategory: 'todo',
      labels: ['bug'],
      tracker: { kind: 'github', scope: 'acme/app' },
      commentsCount: 3,
    });
    expect(page.nextCursor).toContain('page=2');
  });

  it('mentioned preset and cross-repo scope', async () => {
    let q = '';
    server.use(
      http.get(`${API}/search/issues`, ({ request }) => {
        q = new URL(request.url).searchParams.get('q') ?? '';
        return HttpResponse.json({ total_count: 0, items: [] });
      }),
    );
    const t = createGitHubIssueTracker({ http: client(), host: 'github.com', accountId: '1' });
    await t.listIssues('', { preset: 'mentioned' });
    expect(q).toBe('is:issue is:open mentions:@me');
  });
});
