import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AZURE_AUTH, createAzureDevOpsProvider } from '../src/azure';
import { createBitbucketCloudProvider, createBitbucketDcProvider } from '../src/bitbucket';
import { buildMyPrsQuery, SEARCH_QUERY_MAX, searchQueries } from '../src/github/graphql';
import { createGitHubIssueTracker } from '../src/github/issues';
import { createGitHubProvider } from '../src/github/provider';
import { createGitLabIssueTracker } from '../src/gitlab/issues';
import { createGitLabProvider } from '../src/gitlab/provider';
import { HttpClient, ProviderError } from '../src/http';
import { createJiraCloudTracker, JIRA_AUTH } from '../src/jira';
import { mergeInvolved } from '../src/types';

/** Personal Launchpad queries (spec 11 §6.4) for every provider. */

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = (baseUrl: string, auth = 'Bearer t') =>
  new HttpClient({ baseUrl, auth: () => auth, retries: 0 });

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

const GH = 'https://api.github.com';
const actor = (login: string) => ({ login, id: `U_${login}`, avatarUrl: `https://a/${login}` });
const ghPr = (number: number, o: Record<string, unknown> = {}) => ({
  id: `PR_${number}`,
  number,
  title: `PR ${number}`,
  body: '',
  isDraft: false,
  state: 'OPEN',
  url: `https://github.com/acme/app/pull/${number}`,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  mergedAt: null,
  closedAt: null,
  isCrossRepository: false,
  author: actor('me'),
  headRefName: `feature/${number}`,
  headRefOid: 'aaa',
  headRepository: {
    id: 'R_1',
    name: 'app',
    url: 'https://github.com/acme/app',
    sshUrl: '',
    owner: { login: 'acme' },
  },
  baseRefName: 'main',
  baseRepository: { id: 'R_1', name: 'app', owner: { login: 'acme' }, viewerPermission: 'WRITE' },
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  viewerCanUpdate: true,
  viewerDidAuthor: true,
  comments: { totalCount: 0 },
  reviewRequests: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...o,
});

describe('GitHub searchMyPullRequests', () => {
  it('batches the four personal searches in one GraphQL request and merges involvement', async () => {
    let calls = 0;
    let body: { query: string; variables: Record<string, any> } | undefined;
    server.use(
      http.post(`${GH}/graphql`, async ({ request }) => {
        calls++;
        body = (await request.json()) as typeof body;
        return HttpResponse.json({
          data: {
            viewer: { login: 'me' },
            s0: { issueCount: 2, nodes: [ghPr(1), ghPr(2)] },
            s1: {
              issueCount: 1,
              nodes: [
                ghPr(3, {
                  author: actor('alice'),
                  viewerDidAuthor: false,
                  baseRepository: { id: 'R_2', name: 'web', owner: { login: 'other' } },
                  url: 'https://github.com/other/web/pull/3',
                  reviewRequests: {
                    nodes: [{ requestedReviewer: { __typename: 'User', id: 'U_me', login: 'me' } }],
                  },
                }),
              ],
            },
            s2: { issueCount: 1, nodes: [ghPr(1)] },
            s3: { issueCount: 1, nodes: [{}] },
          },
        });
      }),
    );
    const p = createGitHubProvider({ http: client(GH), host: 'github.com', accountId: '9' });
    const rows = await p.searchMyPullRequests!();
    expect(calls).toBe(1);
    expect(body!.query).toMatch(/query GitHappensMyPullRequests/);
    expect(Object.keys(body!.variables).filter((k) => k.startsWith('q'))).toHaveLength(4);
    expect(body!.variables.q0).toBe('is:open is:pr archived:false author:@me sort:updated-desc');
    expect(body!.variables.q1).toContain('review-requested:@me');
    expect(body!.variables.q2).toContain('assignee:@me');
    expect(body!.variables.q3).toContain('mentions:@me');
    expect(rows.map((r) => [r.pr.number, r.involvement])).toEqual([
      [1, ['author', 'assignee']],
      [2, ['author']],
      [3, ['review-requested']],
    ]);
    const third = rows[2]!.pr;
    expect(third.repo).toMatchObject({ owner: 'other', name: 'web', integration: { accountId: '9' } });
    expect(third.viewer.reviewRequested).toBe(true);
  });

  it('adds repo: qualifiers for a workspace scope and splits long queries', async () => {
    let vars: Record<string, string> = {};
    server.use(
      http.post(`${GH}/graphql`, async ({ request }) => {
        vars = ((await request.json()) as { variables: Record<string, string> }).variables;
        const data: Record<string, unknown> = { viewer: { login: 'me' } };
        for (const k of Object.keys(vars)) if (k.startsWith('q')) data[`s${k.slice(1)}`] = { nodes: [] };
        return HttpResponse.json({ data });
      }),
    );
    const repos = Array.from({ length: 12 }, (_, i) => ({ owner: 'acme-corporation', name: `service-${i}` }));
    const p = createGitHubProvider({ http: client(GH), host: 'github.com', accountId: '9' });
    await p.searchMyPullRequests!({ repos, limit: 20 });
    const qs = Object.entries(vars).filter(([k]) => k.startsWith('q'));
    expect(qs.length).toBeGreaterThan(4);
    for (const [, q] of qs) expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
    expect(qs.map(([, q]) => q).join(' ')).toContain('repo:acme-corporation/service-11');
    expect(vars.first).toBe(20);
  });

  it('builds aliased queries', () => {
    const q = buildMyPrsQuery(2);
    expect(q).toContain('$q0: String!, $q1: String!');
    expect(q).toContain('s1: search(type: ISSUE, query: $q1');
    expect(searchQueries('base', undefined)).toEqual(['base']);
  });

  it('surfaces rate limiting as a ProviderError', async () => {
    server.use(
      http.post(`${GH}/graphql`, () =>
        HttpResponse.json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
      ),
    );
    const p = createGitHubProvider({ http: client(GH), host: 'github.com', accountId: '9' });
    await expect(p.searchMyPullRequests!()).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('GitHub searchMyIssues', () => {
  const ghIssue = (n: number, o: Record<string, unknown> = {}) => ({
    id: 1000 + n,
    number: n,
    title: `Issue ${n}`,
    state: 'open',
    labels: [{ name: 'bug' }],
    assignees: [{ id: 9, login: 'me' }],
    user: { id: 9, login: 'me' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    html_url: `https://github.com/acme/app/issues/${n}`,
    repository_url: 'https://api.github.com/repos/acme/app',
    ...o,
  });
  it('searches assigned + created issues and excludes PRs', async () => {
    const queries: string[] = [];
    server.use(
      http.get(`${GH}/search/issues`, ({ request }) => {
        const q = new URL(request.url).searchParams.get('q')!;
        queries.push(q);
        return HttpResponse.json({
          items: q.includes('assignee:@me')
            ? [ghIssue(1), ghIssue(2, { pull_request: {} })]
            : [ghIssue(1), ghIssue(3)],
        });
      }),
    );
    const t = createGitHubIssueTracker({ http: client(GH), host: 'github.com', accountId: '9' });
    const rows = await t.searchMyIssues!({ scopes: ['acme/app'] });
    expect(queries.every((q) => q.includes('repo:acme/app'))).toBe(true);
    expect(rows.map((r) => [r.issue.key, r.issue.tracker.scope, r.involvement])).toEqual([
      ['#1', 'acme/app', ['assignee', 'creator']],
      ['#3', 'acme/app', ['creator']],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------------------------

const GL = 'https://gitlab.com/api/v4';
const glUser = (id: number, username: string) => ({ id, username, name: username });
const glMr = (iid: number, o: Record<string, unknown> = {}) => ({
  id: 5000 + iid,
  iid,
  project_id: 1,
  title: `MR ${iid}`,
  state: 'opened',
  draft: false,
  author: glUser(100, 'me'),
  reviewers: [],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  source_branch: `feat-${iid}`,
  target_branch: 'main',
  source_project_id: 1,
  target_project_id: 1,
  sha: 'abc',
  detailed_merge_status: 'mergeable',
  web_url: `https://gitlab.com/grp/sub/app/-/merge_requests/${iid}`,
  references: { full: `grp/sub/app!${iid}` },
  ...o,
});

describe('GitLab personal queries', () => {
  it('queries created_by_me, reviewer_id and assigned_to_me and merges', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${GL}/user`, () => HttpResponse.json(glUser(100, 'me'))),
      http.get(`${GL}/merge_requests`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        expect(sp.get('state')).toBe('opened');
        const key = sp.get('reviewer_id') ? `reviewer:${sp.get('reviewer_id')}` : sp.get('scope')!;
        seen.push(key);
        if (key === 'created_by_me') return HttpResponse.json([glMr(1), glMr(2)]);
        if (key.startsWith('reviewer'))
          return HttpResponse.json([
            glMr(7, {
              author: glUser(5, 'alice'),
              reviewers: [glUser(100, 'me')],
              web_url: 'https://gitlab.com/other/lib/-/merge_requests/7',
              references: undefined,
            }),
          ]);
        return HttpResponse.json([glMr(1)]);
      }),
    );
    const p = createGitLabProvider({ http: client(GL), host: 'gitlab.com', accountId: '100' });
    const rows = await p.searchMyPullRequests!();
    expect(seen.sort()).toEqual(['assigned_to_me', 'created_by_me', 'reviewer:100']);
    expect(rows.map((r) => [`${r.pr.repo.owner}/${r.pr.repo.name}`, r.pr.number, r.involvement])).toEqual([
      ['grp/sub/app', 1, ['author', 'assignee']],
      ['grp/sub/app', 2, ['author']],
      ['other/lib', 7, ['reviewer']],
    ]);
    expect(rows[2]!.pr.reviewers[0]).toMatchObject({ user: { login: 'me' }, state: 'pending' });
  });

  it('filters to workspace repos', async () => {
    server.use(
      http.get(`${GL}/user`, () => HttpResponse.json(glUser(100, 'me'))),
      http.get(`${GL}/merge_requests`, () => HttpResponse.json([glMr(1)])),
    );
    const p = createGitLabProvider({ http: client(GL), host: 'gitlab.com', accountId: '100' });
    expect(await p.searchMyPullRequests!({ repos: [{ owner: 'grp', name: 'other' }] })).toEqual([]);
  });

  it('lists my issues (assigned + created)', async () => {
    const issue = (iid: number) => ({
      id: 9000 + iid,
      iid,
      project_id: 1,
      title: `Issue ${iid}`,
      state: 'opened',
      labels: ['workflow::in progress'],
      assignees: [glUser(100, 'me')],
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      web_url: `https://gitlab.com/grp/app/-/issues/${iid}`,
      references: { full: `grp/app#${iid}` },
    });
    server.use(
      http.get(`${GL}/issues`, ({ request }) => {
        const scope = new URL(request.url).searchParams.get('scope');
        return HttpResponse.json(scope === 'assigned_to_me' ? [issue(1)] : [issue(1), issue(2)]);
      }),
    );
    const t = createGitLabIssueTracker({ http: client(GL), host: 'gitlab.com', accountId: '100' });
    const rows = await t.searchMyIssues!();
    expect(
      rows.map((r) => [r.issue.key, r.issue.tracker.scope, r.issue.stateCategory, r.involvement]),
    ).toEqual([
      ['#1', 'grp/app', 'in_progress', ['assignee', 'creator']],
      ['#2', 'grp/app', 'in_progress', ['creator']],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Bitbucket Cloud & Data Center
// ---------------------------------------------------------------------------------------------

const BB = 'https://api.bitbucket.org/2.0';
const BB_ME = { uuid: '{me}', nickname: 'me', display_name: 'Me' };
const bbPr = (id: number, repo: string, o: Record<string, unknown> = {}) => ({
  id,
  title: `PR ${id}`,
  state: 'OPEN',
  author: BB_ME,
  created_on: '2026-10-01T00:00:00Z',
  updated_on: '2026-10-02T00:00:00Z',
  source: { branch: { name: 'f' }, commit: { hash: 'a' }, repository: { full_name: repo } },
  destination: { branch: { name: 'main' }, commit: { hash: 'b' }, repository: { full_name: repo } },
  participants: [],
  links: { html: { href: `https://bitbucket.org/${repo}/pull-requests/${id}` } },
  ...o,
});

describe('Bitbucket Cloud searchMyPullRequests', () => {
  it('lists authored PRs across repos, plus reviewer PRs of workspace repos', async () => {
    let reviewerQ: string | null = null;
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json(BB_ME)),
      http.get(`${BB}/pullrequests/:user`, ({ params, request }) => {
        expect(params.user).toBe('{me}');
        expect(new URL(request.url).searchParams.get('state')).toBe('OPEN');
        return HttpResponse.json({ values: [bbPr(1, 'ws/app'), bbPr(2, 'ws/lib')] });
      }),
      http.get(`${BB}/repositories/ws/app/pullrequests`, ({ request }) => {
        reviewerQ = new URL(request.url).searchParams.get('q');
        return HttpResponse.json({
          values: [bbPr(9, 'ws/app', { author: { uuid: '{alice}', nickname: 'alice' }, reviewers: [BB_ME] })],
        });
      }),
    );
    const p = createBitbucketCloudProvider({ http: client(BB) });
    const all = await p.searchMyPullRequests!();
    expect(all.map((r) => [r.pr.repo.name, r.pr.number, r.involvement])).toEqual([
      ['app', 1, ['author']],
      ['lib', 2, ['author']],
    ]);
    const scoped = await p.searchMyPullRequests!({ repos: [{ owner: 'ws', name: 'app' }] });
    expect(reviewerQ).toBe('reviewers.uuid="{me}" AND state="OPEN"');
    expect(scoped.map((r) => [r.pr.number, r.involvement])).toEqual([
      [1, ['author']],
      [9, ['reviewer']],
    ]);
  });
});

const DC = 'https://git.acme.com/rest/api/latest';
const dcRepo = (slug: string) => ({ id: 1, slug, name: slug, project: { key: 'PRJ' } });
const dcPr = (id: number, slug: string, o: Record<string, unknown> = {}) => ({
  id,
  version: 1,
  title: `PR ${id}`,
  state: 'OPEN',
  open: true,
  createdDate: 1700000000000,
  updatedDate: 1700000100000,
  fromRef: { id: 'refs/heads/f', displayId: 'f', latestCommit: 'a', repository: dcRepo(slug) },
  toRef: { id: 'refs/heads/main', displayId: 'main', latestCommit: 'b', repository: dcRepo(slug) },
  author: { user: { name: 'me', id: 1 }, role: 'AUTHOR' },
  reviewers: [],
  ...o,
});

describe('Bitbucket DC searchMyPullRequests', () => {
  it('uses the dashboard endpoint for AUTHOR and REVIEWER roles', async () => {
    const roles: string[] = [];
    server.use(
      http.get(`${DC}/application-properties`, () =>
        HttpResponse.json({}, { headers: { 'X-AUSERNAME': 'me' } }),
      ),
      http.get(`${DC}/users/me`, () => HttpResponse.json({ name: 'me', slug: 'me', id: 1 })),
      http.get(`${DC}/dashboard/pull-requests`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        expect(sp.get('state')).toBe('OPEN');
        roles.push(sp.get('role')!);
        return HttpResponse.json({
          isLastPage: true,
          values:
            sp.get('role') === 'AUTHOR'
              ? [dcPr(1, 'app')]
              : [
                  dcPr(2, 'lib', {
                    author: { user: { name: 'alice', id: 2 }, role: 'AUTHOR' },
                    reviewers: [{ user: { name: 'me', id: 1 }, role: 'REVIEWER', status: 'UNAPPROVED' }],
                  }),
                ],
        });
      }),
    );
    const p = createBitbucketDcProvider({ http: client(DC), host: 'git.acme.com' });
    const rows = await p.searchMyPullRequests!();
    expect(roles.sort()).toEqual(['AUTHOR', 'REVIEWER']);
    expect(rows.map((r) => [r.pr.repo.owner, r.pr.repo.name, r.pr.number, r.involvement])).toEqual([
      ['PRJ', 'app', 1, ['author']],
      ['PRJ', 'lib', 2, ['reviewer']],
    ]);
    expect(rows[1]!.pr.reviewers[0]!.state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------------------------

describe('Azure DevOps searchMyPullRequests', () => {
  const ORG = 'https://dev.azure.com/acme';
  const azPr = (id: number, creator: string) => ({
    pullRequestId: id,
    status: 'active',
    title: `PR ${id}`,
    createdBy: { id: creator, displayName: creator },
    creationDate: '2026-10-01T00:00:00Z',
    sourceRefName: 'refs/heads/f',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    reviewers: creator === 'me-id' ? [] : [{ id: 'me-id', displayName: 'Me', vote: 0 }],
    repository: { id: 'r1', name: 'web', project: { id: 'p1', name: 'Proj' } },
  });
  it('queries the org-level endpoint by creatorId and reviewerId', async () => {
    const params: string[] = [];
    server.use(
      http.get(`${ORG}/_apis/connectionData`, () =>
        HttpResponse.json({ authenticatedUser: { id: 'me-id' }, instanceId: 'x' }),
      ),
      http.get(`${ORG}/_apis/git/pullrequests`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        expect(sp.get('searchCriteria.status')).toBe('active');
        if (sp.get('searchCriteria.creatorId')) {
          params.push('creator');
          return HttpResponse.json({ value: [azPr(1, 'me-id')] });
        }
        params.push(`reviewer:${sp.get('searchCriteria.reviewerId')}`);
        return HttpResponse.json({ value: [azPr(2, 'alice')] });
      }),
    );
    const p = createAzureDevOpsProvider({
      http: new HttpClient({
        baseUrl: 'https://dev.azure.com',
        retries: 0,
        auth: () => AZURE_AUTH.authHeader('pat'),
      }),
      host: 'dev.azure.com',
      organization: 'acme',
    });
    const rows = await p.searchMyPullRequests!();
    expect(params.sort()).toEqual(['creator', 'reviewer:me-id']);
    expect(rows.map((r) => [r.pr.repo.owner, r.pr.repo.name, r.pr.number, r.involvement])).toEqual([
      ['acme/Proj', 'web', 1, ['author']],
      ['acme/Proj', 'web', 2, ['reviewer']],
    ]);
    expect(rows[0]!.pr.viewer.isAuthor).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------------------------

describe('Jira searchMyIssues', () => {
  const CLOUD = 'https://acme.atlassian.net/rest/api/3';
  const jIssue = (key: string) => ({
    id: key.replace(/\D/g, ''),
    key,
    fields: {
      summary: `Summary ${key}`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      assignee: { accountId: 'acc-1', displayName: 'Me' },
      labels: [],
      created: '2026-10-01T00:00:00.000+0000',
      updated: '2026-10-02T00:00:00.000+0000',
    },
  });
  it('runs assignee = currentUser() (+ reporter) JQL with a project filter', async () => {
    const jqls: string[] = [];
    server.use(
      http.post(`${CLOUD}/search/jql`, async ({ request }) => {
        const body = (await request.json()) as { jql: string };
        jqls.push(body.jql);
        return HttpResponse.json({
          issues: body.jql.includes('assignee') ? [jIssue('ABC-1')] : [jIssue('ABC-1'), jIssue('ABC-2')],
          isLast: true,
        });
      }),
    );
    const t = createJiraCloudTracker({
      http: new HttpClient({
        baseUrl: CLOUD,
        retries: 0,
        auth: () => JIRA_AUTH.authHeader('tok', 'me@acme.com'),
      }),
      site: 'acme',
    });
    const rows = await t.searchMyIssues!({ scopes: ['ABC', 'XYZ'] });
    expect(jqls.find((j) => j.includes('assignee'))).toContain(
      'project in ("ABC", "XYZ") AND assignee = currentUser() AND statusCategory != Done',
    );
    expect(jqls.find((j) => j.includes('reporter'))).toContain('reporter = currentUser()');
    expect(jqls.every((j) => j.endsWith('ORDER BY updated DESC'))).toBe(true);
    expect(rows.map((r) => [r.issue.key, r.involvement])).toEqual([
      ['ABC-1', ['assignee', 'creator']],
      ['ABC-2', ['creator']],
    ]);
  });

  it('skips the reporter query when includeCreated is false', async () => {
    let n = 0;
    server.use(
      http.post(`${CLOUD}/search/jql`, () => {
        n++;
        return HttpResponse.json({ issues: [], isLast: true });
      }),
    );
    const t = createJiraCloudTracker({
      http: new HttpClient({
        baseUrl: CLOUD,
        retries: 0,
        auth: () => JIRA_AUTH.authHeader('tok', 'me@acme.com'),
      }),
      site: 'acme',
    });
    expect(await t.searchMyIssues!({ includeCreated: false })).toEqual([]);
    expect(n).toBe(1);
  });
});

describe('mergeInvolved', () => {
  it('unions involvement per key, keeping first payload', () => {
    const rows = mergeInvolved(
      [
        { k: 'a', v: 1, involvement: ['author' as const] },
        { k: 'a', v: 2, involvement: ['assignee' as const, 'author' as const] },
        { k: 'b', v: 3, involvement: [] },
      ],
      (r) => r.k,
    );
    expect(rows).toEqual([
      { k: 'a', v: 1, involvement: ['author', 'assignee'] },
      { k: 'b', v: 3, involvement: [] },
    ]);
  });
  it('ProviderError is exported for consumers', () => {
    expect(new ProviderError({ code: 'network', message: 'x' }).code).toBe('network');
  });
});
