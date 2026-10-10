import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { searchQueries, SEARCH_QUERY_MAX } from '../src/github/graphql';
import { createGitHubIssueTracker } from '../src/github/issues';
import { createGitHubProvider, sshFingerprint } from '../src/github/provider';
import { HttpClient, type ProviderError } from '../src/http';
import type { IntegrationId, PullRequest, RepoRef } from '../src/types';

/** GraphQL operation matcher on top of `http.post` (msw's `graphql` namespace isn't usable here). */
function gqlLink(url: string) {
  const op = (
    name: string,
    resolver: (a: { variables: Record<string, any>; query: string }) => Response | Promise<Response>,
  ) =>
    http.post(url, async ({ request }) => {
      const body = (await request.clone().json()) as { query: string; variables?: Record<string, any> };
      if (/(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] !== name) return undefined;
      return resolver({ variables: body.variables ?? {}, query: body.query });
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
const tracker = (accountId: string | null = '1') =>
  createGitHubIssueTracker({
    http: client(),
    host: 'https://github.com/',
    accountId: accountId ?? undefined,
  });

const actor = (login: string) => ({
  login,
  avatarUrl: `https://avatars/${login}`,
  id: `U_${login}`,
  name: login.toUpperCase(),
});

const me = { id: 1, login: 'alice', name: 'Alice', avatar_url: 'https://a/alice', email: 'a@x' };

const repoJson = (owner: string, name: string, o: Record<string, unknown> = {}) => ({
  id: 100,
  name,
  full_name: `${owner}/${name}`,
  owner: { login: owner },
  description: null,
  private: false,
  fork: false,
  default_branch: 'main',
  clone_url: `https://github.com/${owner}/${name}.git`,
  ssh_url: `git@github.com:${owner}/${name}.git`,
  html_url: `https://github.com/${owner}/${name}`,
  updated_at: '2026-01-01T00:00:00Z',
  ...o,
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
      rebaseMergeAllowed: true,
    },
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    viewerCanUpdate: true,
    viewerDidAuthor: false,
    comments: { totalCount: 0 },
    ...o,
  };
}

const prResponse = (number = 1, o: Record<string, unknown> = {}) =>
  HttpResponse.json({
    data: { viewer: { login: 'alice' }, repository: { pullRequest: prNode({ number, ...o }) } },
  });

const issueJson = (o: Record<string, unknown> = {}) => ({
  id: 500,
  number: 12,
  title: 'Crash',
  body: 'It crashes',
  state: 'open',
  labels: ['bug', { name: 'p1' }],
  assignees: [{ id: 1, login: 'alice' }],
  user: { id: 2, login: 'bob' },
  milestone: { title: 'v1' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  html_url: 'https://github.com/acme/app/issues/12',
  comments: 2,
  ...o,
});

const err = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e as ProviderError,
  );

// ---------------------------------------------------------------------------

describe('GitHub provider: repos', () => {
  it('createRepo posts to user/repos for the viewer and normalizes the result', async () => {
    let body: unknown;
    let userCalls = 0;
    server.use(
      http.get(`${API}/user`, () => {
        userCalls++;
        return HttpResponse.json(me);
      }),
      http.post(`${API}/user/repos`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          repoJson('alice', 'new', {
            id: 7,
            private: true,
            description: 'Desc',
            permissions: { admin: true },
            pushed_at: '2026-02-01T00:00:00Z',
            stargazers_count: 3,
          }),
          { status: 201 },
        );
      }),
    );
    // No accountId → integration resolves via GET /user (cached viewer).
    const p = createGitHubProvider({ http: client(), host: 'github.com' });
    const r = await p.createRepo!({ owner: 'Alice', name: 'new', private: true, description: 'Desc' });
    expect(body).toEqual({ name: 'new', private: true, description: 'Desc' });
    expect(r).toEqual({
      ref: {
        integration: { kind: 'github', host: 'github.com', accountId: '1' },
        owner: 'alice',
        name: 'new',
        id: '7',
      },
      fullName: 'alice/new',
      description: 'Desc',
      isPrivate: true,
      isFork: false,
      parent: undefined,
      defaultBranch: 'main',
      httpsUrl: 'https://github.com/alice/new.git',
      sshUrl: 'git@github.com:alice/new.git',
      webUrl: 'https://github.com/alice/new',
      updatedAt: '2026-02-01T00:00:00Z',
      stars: 3,
      viewerPermission: 'admin',
    });
    expect(userCalls).toBe(1);
  });

  it('createRepo posts to orgs/{org}/repos with templates', async () => {
    let body: unknown;
    let path = '';
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.post(`${API}/orgs/:org/repos`, async ({ request, params }) => {
        path = String(params.org);
        body = await request.json();
        return HttpResponse.json(repoJson('acme', 'svc', { permissions: { maintain: true } }), {
          status: 201,
        });
      }),
    );
    const r = await provider().createRepo!({
      owner: 'acme',
      name: 'svc',
      private: false,
      gitignore: 'Node',
      license: 'mit',
    });
    expect(path).toBe('acme');
    expect(body).toEqual({
      name: 'svc',
      private: false,
      gitignore_template: 'Node',
      license_template: 'mit',
    });
    expect(r).toMatchObject({ fullName: 'acme/svc', viewerPermission: 'maintain', ref: { integration } });
  });

  it('createRepo maps 422 to validation and 403 with accepted scopes to insufficient_scope', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.post(`${API}/user/repos`, () =>
        HttpResponse.json({ message: 'name already exists on this account' }, { status: 422 }),
      ),
      http.post(`${API}/orgs/acme/repos`, () =>
        HttpResponse.json(
          { message: 'Resource not accessible' },
          { status: 403, headers: { 'x-accepted-oauth-scopes': 'repo', 'x-oauth-scopes': 'read:user' } },
        ),
      ),
    );
    const p = provider();
    expect((await err(p.createRepo!({ name: 'x', private: false }))).code).toBe('validation');
    const e = await err(p.createRepo!({ owner: 'acme', name: 'x', private: false }));
    expect(e.code).toBe('insufficient_scope');
    expect(e.serialized.missingScopes).toEqual(['repo']);
  });

  it('createFork forks into the viewer account or an organization', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.post(`${API}/repos/acme/app/forks`, async ({ request }) => {
        const b = (await request.json()) as { organization?: string };
        bodies.push(b);
        const owner = b.organization ?? 'alice';
        return HttpResponse.json(
          repoJson(owner, 'app', {
            fork: true,
            parent: { id: 9, name: 'app', owner: { login: 'acme' } },
            permissions: { push: true },
          }),
          { status: 202 },
        );
      }),
    );
    const p = provider();
    const mine = await p.createFork!(ref);
    const same = await p.createFork!(ref, { owner: 'ALICE' });
    const org = await p.createFork!(ref, { owner: 'contoso' });
    expect(bodies).toEqual([{}, {}, { organization: 'contoso' }]);
    expect(mine).toMatchObject({
      fullName: 'alice/app',
      isFork: true,
      parent: { integration, owner: 'acme', name: 'app', id: '9' },
      viewerPermission: 'write',
    });
    expect(same.fullName).toBe('alice/app');
    expect(org.ref).toMatchObject({ owner: 'contoso', name: 'app', integration });
  });

  it('createFork maps 404 to not_found', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.post(`${API}/repos/acme/app/forks`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect((await err(provider().createFork!(ref))).code).toBe('not_found');
  });

  it('listRepos covers the default, own-owner and org listings', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.get(`${API}/user/repos`, ({ request }) => {
        seen.push(`user:${new URL(request.url).searchParams.get('affiliation')}`);
        return HttpResponse.json([repoJson('alice', 'a', { permissions: { triage: true } })], {
          headers: { link: `<${API}/user/repos?page=2>; rel="next"` },
        });
      }),
      http.get(`${API}/orgs/acme/repos`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        seen.push(`org:${sp.get('per_page')}:${sp.get('affiliation')}`);
        return HttpResponse.json([repoJson('acme', 'b', { permissions: { pull: true } })]);
      }),
    );
    const p = provider();
    const all = await p.listRepos({});
    const own = await p.listRepos({ owner: 'Alice' });
    const org = await p.listRepos({ owner: 'acme', pageSize: 500 });
    expect(seen).toEqual(['user:owner,collaborator,organization_member', 'user:owner', 'org:100:null']);
    expect(all.items[0]).toMatchObject({ fullName: 'alice/a', viewerPermission: 'triage' });
    expect(all.nextCursor).toContain('page=2');
    expect(own.items).toHaveLength(1);
    expect(org.items[0]).toMatchObject({ fullName: 'acme/b', viewerPermission: 'read' });
    expect(org.nextCursor).toBeUndefined();
  });

  it('listRepos with a query searches across the viewer and their orgs', async () => {
    const qs: string[] = [];
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.get(`${API}/user/orgs`, ({ request }) => {
        if (new URL(request.url).searchParams.get('page') === '2')
          return HttpResponse.json([{ login: 'contoso' }]);
        return HttpResponse.json([{ login: 'acme' }], {
          headers: { link: `<${API}/user/orgs?per_page=100&page=2>; rel="next"` },
        });
      }),
      http.get(`${API}/search/repositories`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        qs.push(`${sp.get('q')}|${sp.get('per_page')}|${sp.get('sort')}`);
        return HttpResponse.json({ total_count: 1, items: [repoJson('acme', 'app')] });
      }),
    );
    const p = provider();
    const res = await p.listRepos({ query: 'app', pageSize: 20 });
    const scoped = await p.listRepos({ query: 'app', owner: 'acme' });
    expect(qs).toEqual([
      'app in:name fork:true user:alice org:acme org:contoso|20|updated',
      'app in:name fork:true user:acme|100|updated',
    ]);
    expect(res).toMatchObject({ total: 1, items: [{ fullName: 'acme/app', viewerPermission: undefined }] });
    expect(scoped.items).toHaveLength(1);
  });

  it('listOwners returns the viewer and their orgs', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(me)),
      http.get(`${API}/user/orgs`, () =>
        HttpResponse.json([{ login: 'acme', avatar_url: 'https://a/acme' }]),
      ),
    );
    expect(await provider().listOwners()).toEqual([
      { login: 'alice', avatarUrl: 'https://a/alice', kind: 'user' },
      { login: 'acme', avatarUrl: 'https://a/acme', kind: 'org' },
    ]);
  });

  it('getViewer refetches and a failed viewer lookup is not cached', async () => {
    let n = 0;
    server.use(
      http.get(`${API}/user`, () => {
        n++;
        return n === 1
          ? HttpResponse.json({ message: 'boom' }, { status: 500 })
          : HttpResponse.json({ id: 1, login: 'alice', name: null, email: null });
      }),
    );
    const p = createGitHubProvider({ http: client(), host: 'https://API.github.com/' });
    expect((await err(p.getViewer())).code).toBe('server');
    expect(await p.getViewer()).toEqual({
      id: '1',
      login: 'alice',
      name: undefined,
      avatarUrl: undefined,
      email: undefined,
    });
    // host 'api.github.com' is normalized to github.com
    expect(p.matchRemoteUrl('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
    expect(await p.getGrantedScopes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('GitHub provider: pull request mutations', () => {
  it('setDraft converts to draft and marks ready via the PR node id', async () => {
    const ops: Array<{ op: string; vars: Record<string, any> }> = [];
    server.use(
      gh.query('GitHappensPrId', ({ variables }) => {
        ops.push({ op: 'id', vars: variables });
        return HttpResponse.json({ data: { repository: { pullRequest: { id: 'PR_kw1' } } } });
      }),
      gh.mutation('GitHappensConvertToDraft', ({ variables, query }) => {
        ops.push({ op: 'draft', vars: variables });
        expect(query).toContain('convertPullRequestToDraft');
        return HttpResponse.json({
          data: { convertPullRequestToDraft: { pullRequest: { id: 'PR_kw1', isDraft: true } } },
        });
      }),
      gh.mutation('GitHappensReadyForReview', ({ variables, query }) => {
        ops.push({ op: 'ready', vars: variables });
        expect(query).toContain('markPullRequestReadyForReview');
        return HttpResponse.json({
          data: { markPullRequestReadyForReview: { pullRequest: { id: 'PR_kw1', isDraft: false } } },
        });
      }),
    );
    const p = provider();
    await expect(p.setDraft!(ref, 5, true)).resolves.toBeUndefined();
    await expect(p.setDraft!(ref, 5, false)).resolves.toBeUndefined();
    expect(ops).toEqual([
      { op: 'id', vars: { owner: 'acme', name: 'app', number: 5 } },
      { op: 'draft', vars: { id: 'PR_kw1' } },
      { op: 'id', vars: { owner: 'acme', name: 'app', number: 5 } },
      { op: 'ready', vars: { id: 'PR_kw1' } },
    ]);
  });

  it('setDraft throws not_found when the PR does not exist', async () => {
    server.use(
      gh.query('GitHappensPrId', () => HttpResponse.json({ data: { repository: { pullRequest: null } } })),
    );
    const e = await err(provider().setDraft!(ref, 404, true));
    expect(e.code).toBe('not_found');
    expect(e.message).toContain('#404');
  });

  it('setThreadResolved resolves and unresolves review threads', async () => {
    const ops: string[] = [];
    server.use(
      gh.mutation('GitHappensResolveThread', ({ variables }) => {
        ops.push(`resolve:${variables.id}`);
        return HttpResponse.json({
          data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } },
        });
      }),
      gh.mutation('GitHappensUnresolveThread', ({ variables }) => {
        ops.push(`unresolve:${variables.id}`);
        return HttpResponse.json({
          data: { unresolveReviewThread: { thread: { id: variables.id, isResolved: false } } },
        });
      }),
    );
    const p = provider();
    await p.setThreadResolved!(ref, 'PRRT_a', true);
    await p.setThreadResolved!(ref, 'PRRT_a', false);
    expect(ops).toEqual(['resolve:PRRT_a', 'unresolve:PRRT_a']);
  });

  it('setThreadResolved surfaces GraphQL NOT_FOUND and FORBIDDEN errors', async () => {
    server.use(
      gh.mutation('GitHappensResolveThread', () =>
        HttpResponse.json({
          data: null,
          errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a node with the global id of 'x'" }],
        }),
      ),
      gh.mutation('GitHappensUnresolveThread', () =>
        HttpResponse.json({
          data: { unresolveReviewThread: null },
          errors: [
            {
              type: 'FORBIDDEN',
              path: ['unresolveReviewThread'],
              message: 'Resource protected by organization SAML enforcement.',
            },
          ],
        }),
      ),
    );
    const p = provider();
    const e1 = await err(p.setThreadResolved!(ref, 'x', true));
    expect(e1.code).toBe('not_found');
    const e2 = await err(p.setThreadResolved!(ref, 'x', false));
    expect(e2.code).toBe('forbidden_org_policy');
  });

  it('setAutoMerge enables with the uppercased method and disables with null', async () => {
    const ops: Array<[string, Record<string, any>]> = [];
    server.use(
      gh.query('GitHappensPrId', () =>
        HttpResponse.json({ data: { repository: { pullRequest: { id: 'PR_am' } } } }),
      ),
      gh.mutation('GitHappensEnableAutoMerge', ({ variables }) => {
        ops.push(['on', variables]);
        return HttpResponse.json({ data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_am' } } } });
      }),
      gh.mutation('GitHappensDisableAutoMerge', ({ variables }) => {
        ops.push(['off', variables]);
        return HttpResponse.json({ data: { disablePullRequestAutoMerge: { pullRequest: { id: 'PR_am' } } } });
      }),
    );
    const p = provider();
    await p.setAutoMerge!(ref, 3, 'squash');
    await p.setAutoMerge!(ref, 3, 'rebase');
    await p.setAutoMerge!(ref, 3, null);
    expect(ops).toEqual([
      ['on', { id: 'PR_am', method: 'SQUASH' }],
      ['on', { id: 'PR_am', method: 'REBASE' }],
      ['off', { id: 'PR_am' }],
    ]);
    expect((await err(p.setAutoMerge!(ref, 3, 'fast-forward'))).code).toBe('unsupported');
  });

  it('setAutoMerge maps UNPROCESSABLE and unknown GraphQL errors', async () => {
    let n = 0;
    server.use(
      gh.query('GitHappensPrId', () =>
        HttpResponse.json({ data: { repository: { pullRequest: { id: 'PR_am' } } } }),
      ),
      gh.mutation('GitHappensEnableAutoMerge', () => {
        n++;
        if (n === 1)
          return HttpResponse.json({
            data: null,
            errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is in clean status' }],
          });
        if (n === 2)
          return HttpResponse.json({
            data: null,
            errors: [{ message: 'Head branch was modified. Review and try.' }],
          });
        return HttpResponse.json({ data: null, errors: [{ message: 'Something went wrong' }] });
      }),
    );
    const p = provider();
    expect((await err(p.setAutoMerge!(ref, 3, 'merge'))).code).toBe('validation');
    expect((await err(p.setAutoMerge!(ref, 3, 'merge'))).code).toBe('conflict');
    const e = await err(p.setAutoMerge!(ref, 3, 'merge'));
    expect(e.code).toBe('server');
    expect(e.message).toBe('Something went wrong');
  });

  it('reopen and close PATCH the pull state', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${API}/repos/acme/app/pulls/8`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ number: 8 });
      }),
    );
    const p = provider();
    await expect(p.reopen!(ref, 8)).resolves.toBeUndefined();
    await p.close(ref, 8);
    expect(bodies).toEqual([{ state: 'open' }, { state: 'closed' }]);
  });

  it('reopen maps 404 and 422', async () => {
    server.use(
      http.patch(`${API}/repos/acme/app/pulls/9`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
      http.patch(`${API}/repos/acme/app/pulls/10`, () =>
        HttpResponse.json({ message: 'state cannot be changed. The branch was deleted' }, { status: 422 }),
      ),
    );
    expect((await err(provider().reopen!(ref, 9))).code).toBe('not_found');
    expect((await err(provider().reopen!(ref, 10))).code).toBe('validation');
  });

  it('updatePullRequest patches pull + issue fields and syncs reviewers', async () => {
    const seen: Record<string, unknown[]> = { pull: [], issue: [], del: [], add: [] };
    server.use(
      http.patch(`${API}/repos/acme/app/pulls/4`, async ({ request }) => {
        seen.pull!.push(await request.json());
        return HttpResponse.json({});
      }),
      http.patch(`${API}/repos/acme/app/issues/4`, async ({ request }) => {
        seen.issue!.push(await request.json());
        return HttpResponse.json({});
      }),
      http.get(`${API}/repos/acme/app/pulls/4/requested_reviewers`, () =>
        HttpResponse.json({
          users: [
            { id: 1, login: 'Bob' },
            { id: 2, login: 'carol' },
          ],
          teams: [{ slug: 'core' }],
        }),
      ),
      http.delete(`${API}/repos/acme/app/pulls/4/requested_reviewers`, async ({ request }) => {
        seen.del!.push(await request.json());
        return HttpResponse.json({});
      }),
      http.post(`${API}/repos/acme/app/pulls/4/requested_reviewers`, async ({ request }) => {
        seen.add!.push(await request.json());
        return HttpResponse.json({});
      }),
      gh.query('GitHappensPr', () => prResponse(4)),
    );
    const p = provider();
    const pr = await p.updatePullRequest(ref, 4, {
      title: 'T',
      body: 'B',
      baseBranch: 'dev',
      state: 'closed',
      labels: ['x'],
      assignees: ['alice'],
      milestone: '2',
      reviewers: ['bob', 'dave'],
      teamReviewers: ['docs'],
    });
    expect(pr.number).toBe(4);
    await p.updatePullRequest(ref, 4, { milestone: '' });
    // Only users given: team list untouched; nothing to change → no DELETE/POST.
    await p.updatePullRequest(ref, 4, { reviewers: ['bob', 'carol'] });
    // Only teams given, no change in users.
    await p.updatePullRequest(ref, 4, { teamReviewers: ['core', 'docs'] });
    expect(seen.pull).toEqual([{ title: 'T', body: 'B', base: 'dev', state: 'closed' }]);
    expect(seen.issue).toEqual([{ labels: ['x'], assignees: ['alice'], milestone: 2 }, { milestone: null }]);
    expect(seen.del).toEqual([{ reviewers: ['carol'], team_reviewers: ['core'] }]);
    expect(seen.add).toEqual([
      { reviewers: ['dave'], team_reviewers: ['docs'] },
      { reviewers: [], team_reviewers: ['docs'] },
    ]);
  });

  it('addComment posts issue comments, REST replies and GraphQL thread replies', async () => {
    const seen: string[] = [];
    const restComment = {
      id: 55,
      body: 'hi',
      created_at: '2026-01-01T00:00:00Z',
      user: { id: 1, login: 'alice' },
    };
    server.use(
      http.post(`${API}/repos/acme/app/issues/2/comments`, async ({ request }) => {
        seen.push(`issue:${JSON.stringify(await request.json())}`);
        return HttpResponse.json(restComment, { status: 201 });
      }),
      http.post(`${API}/repos/acme/app/pulls/2/comments/99/replies`, async ({ request }) => {
        seen.push(`reply:${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ ...restComment, id: 56, user: null }, { status: 201 });
      }),
      gh.mutation('GitHappensThreadReply', ({ variables }) => {
        seen.push(`thread:${variables.id}:${variables.body}`);
        return HttpResponse.json({
          data: {
            addPullRequestReviewThreadReply: {
              comment: { id: 'PRRC_1', databaseId: 77, body: 'ok', createdAt: 'c', author: actor('bob') },
            },
          },
        });
      }),
    );
    const p = provider();
    expect(await p.addComment(ref, 2, 'hi')).toEqual({
      kind: 'comment',
      id: '55',
      author: { id: '1', login: 'alice', name: undefined, avatarUrl: undefined, email: undefined },
      body: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
      editable: true,
    });
    expect(await p.addComment(ref, 2, 'r', '99')).toMatchObject({ id: '56', author: { login: 'ghost' } });
    expect(await p.addComment(ref, 2, 'ok', 'PRRT_x')).toEqual({
      kind: 'comment',
      id: '77',
      author: { id: 'U_bob', login: 'bob', name: 'BOB', avatarUrl: 'https://avatars/bob' },
      body: 'ok',
      createdAt: 'c',
      editable: true,
    });
    expect(seen).toEqual(['issue:{"body":"hi"}', 'reply:{"body":"r"}', 'thread:PRRT_x:ok']);
  });

  it('submitReview maps inline comments', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/repos/acme/app/pulls/3/reviews`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 1 });
      }),
    );
    const p = provider();
    await p.submitReview(ref, 3, {
      event: 'COMMENT',
      commitSha: 'abc',
      body: 'Looks ok',
      comments: [
        { path: 'a.ts', line: 3, side: 'RIGHT', body: 'nit' },
        { path: 'b.ts', line: 9, startLine: 5, side: 'LEFT', body: 'range' },
      ],
    } as any);
    expect(body).toEqual({
      commit_id: 'abc',
      event: 'COMMENT',
      body: 'Looks ok',
      comments: [
        { path: 'a.ts', line: 3, side: 'RIGHT', body: 'nit' },
        { path: 'b.ts', line: 9, side: 'LEFT', start_line: 5, start_side: 'LEFT', body: 'range' },
      ],
    });
    await p.submitReview(ref, 3, { event: 'APPROVE', commitSha: 'abc' } as any);
    expect(body).toEqual({ commit_id: 'abc', event: 'APPROVE' });
  });

  it('merge without branch deletion, and reports a failed branch deletion', async () => {
    server.use(
      http.put(`${API}/repos/acme/app/pulls/7/merge`, () => HttpResponse.json({ sha: 'm1', merged: true })),
      http.get(`${API}/repos/acme/app/pulls/7`, () =>
        HttpResponse.json({ head: { ref: 'feat/x', repo: { full_name: 'acme/app' } } }),
      ),
      http.delete(`${API}/repos/acme/app/git/refs/heads/feat/x`, () =>
        HttpResponse.json({ message: 'Reference does not exist' }, { status: 422 }),
      ),
      http.put(`${API}/repos/acme/app/pulls/8/merge`, () =>
        HttpResponse.json({ sha: 'm2', merged: true, message: 'ok' }),
      ),
      http.get(`${API}/repos/acme/app/pulls/8`, () =>
        HttpResponse.json({ head: { ref: 'gone', repo: null } }),
      ),
    );
    const p = provider();
    expect(await p.merge(ref, 7, { method: 'merge', expectedHeadSha: 'h' })).toEqual({
      merged: true,
      sha: 'm1',
      message: undefined,
    });
    const r = await p.merge(ref, 7, {
      method: 'rebase',
      expectedHeadSha: 'h',
      deleteBranch: true,
      message: 'M',
    });
    expect(r.merged).toBe(true);
    expect(r.message).toMatch(/^Merged\. The branch could not be deleted: /);
    expect(await p.merge(ref, 8, { method: 'merge', expectedHeadSha: 'h', deleteBranch: true })).toEqual({
      merged: true,
      sha: 'm2',
      message: 'ok',
    });
  });

  it('getPullRequest and listPullRequests report missing PRs/repos as not_found', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/pulls/404`, () => HttpResponse.json({ number: 404 })),
      gh.query('GitHappensPr', () =>
        HttpResponse.json({ data: { viewer: { login: 'a' }, repository: { pullRequest: null } } }),
      ),
      gh.query('GitHappensPrList', () =>
        HttpResponse.json({ data: { viewer: { login: 'a' }, repository: null } }),
      ),
      gh.query('GitHappensPrTimeline', () => HttpResponse.json({ data: { repository: null } })),
    );
    const p = provider();
    expect((await err(p.getPullRequest(ref, 404))).code).toBe('not_found');
    expect((await err(p.listPullRequests(ref, { state: 'all' }))).code).toBe('not_found');
    expect((await err(p.getTimeline(ref, 404))).code).toBe('not_found');
  });

  it('createPullRequest on the same repo skips follow-ups when not needed', async () => {
    let created: unknown;
    server.use(
      http.post(`${API}/repos/acme/app/pulls`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ number: 11 }, { status: 201 });
      }),
      gh.query('GitHappensPr', () => prResponse(11)),
    );
    const pr = await provider().createPullRequest({
      base: ref,
      baseBranch: 'main',
      head: { integration, owner: 'ACME', name: 'app' },
      headBranch: 'feat/y',
      title: 'T',
    } as any);
    expect(created).toEqual({ title: 'T', head: 'feat/y', base: 'main' });
    expect(pr.number).toBe(11);
  });
});

// ---------------------------------------------------------------------------

describe('GitHub provider: lists and search', () => {
  it('listMilestones lists open milestones across pages', async () => {
    const reqs: string[] = [];
    server.use(
      http.get(`${API}/repos/acme/app/milestones`, ({ request }) => {
        const u = new URL(request.url);
        reqs.push(u.search);
        if (u.searchParams.get('page') === '2') return HttpResponse.json([{ number: 4, title: 'v2' }]);
        return HttpResponse.json([{ number: 3, title: 'v1' }], {
          headers: { link: `<${API}/repos/acme/app/milestones?state=open&per_page=100&page=2>; rel="next"` },
        });
      }),
    );
    expect(await provider().listMilestones!(ref)).toEqual([
      { id: '3', title: 'v1' },
      { id: '4', title: 'v2' },
    ]);
    expect(reqs[0]).toContain('state=open');
    expect(reqs[0]).toContain('per_page=100');
    expect(reqs).toHaveLength(2);
  });

  it('listMilestones maps 404 to not_found', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/milestones`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect((await err(provider().listMilestones!(ref))).code).toBe('not_found');
  });

  it('listLabels prefixes colors', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/labels`, () =>
        HttpResponse.json([{ name: 'bug', color: 'f00' }, { name: 'x' }]),
      ),
    );
    expect(await provider().listLabels(ref)).toEqual([
      { name: 'bug', color: '#f00' },
      { name: 'x', color: undefined },
    ]);
  });

  it('searchUsers merges assignable users with matching teams and tolerates team errors', async () => {
    let assignableQ: unknown = 'unset';
    let teamsFail = false;
    server.use(
      gh.query('GitHappensAssignable', ({ variables }) => {
        assignableQ = variables.q;
        return HttpResponse.json({
          data: { repository: { assignableUsers: { nodes: [actor('bob'), { login: 'x' }] } } },
        });
      }),
      http.get(`${API}/orgs/acme/teams`, () =>
        teamsFail
          ? HttpResponse.json({ message: 'Not Found' }, { status: 404 })
          : HttpResponse.json([
              { id: 1, slug: 'core', name: 'Core Team' },
              { id: 2, slug: 'docs', name: 'Docs' },
            ]),
      ),
    );
    const p = provider();
    const all = await p.searchUsers(ref, '');
    expect(assignableQ).toBeNull();
    expect(all).toEqual([
      { id: 'U_bob', login: 'bob', name: 'BOB', avatarUrl: 'https://avatars/bob' },
      { id: 'x', login: 'x', name: undefined, avatarUrl: undefined },
      { id: '1', login: 'core', name: 'Core Team', isTeam: true },
      { id: '2', login: 'docs', name: 'Docs', isTeam: true },
    ]);
    const filtered = await p.searchUsers(ref, 'TEAM');
    expect(filtered.filter((u) => u.isTeam).map((u) => u.login)).toEqual(['core']);
    teamsFail = true;
    expect((await p.searchUsers(ref, 'b')).every((u) => !u.isTeam)).toBe(true);
  });

  it('listPullRequests search covers states, presets, author and head', async () => {
    const qs: string[] = [];
    server.use(
      gh.query('GitHappensPrSearch', ({ variables }) => {
        qs.push(String(variables.q));
        return HttpResponse.json({
          data: {
            viewer: { login: 'alice' },
            search: { issueCount: 9, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
          },
        });
      }),
    );
    const p = provider();
    const r = await p.listPullRequests(ref, { state: 'closed', preset: 'review-requested' }, 'C1');
    expect(r).toEqual({ items: [], nextCursor: undefined, total: 9 });
    await p.listPullRequests(ref, { state: 'merged', preset: 'assigned', head: 'feat' });
    await p.listPullRequests(ref, { state: 'all', author: 'bob' });
    expect(qs).toEqual([
      'repo:acme/app is:pr is:closed is:unmerged review-requested:@me sort:updated-desc',
      'repo:acme/app is:pr is:merged assignee:@me head:feat sort:updated-desc',
      'repo:acme/app is:pr author:bob sort:updated-desc',
    ]);
  });

  it('listPullRequests normalizes edge-case PR shapes', async () => {
    let vars: Record<string, any> = {};
    server.use(
      gh.query('GitHappensPrList', ({ variables }) => {
        vars = variables;
        return HttpResponse.json({
          data: {
            viewer: { login: 'alice' },
            repository: {
              pullRequests: {
                totalCount: 3,
                pageInfo: { hasNextPage: true, endCursor: null },
                nodes: [
                  prNode({
                    body: null,
                    author: null,
                    baseRepository: null,
                    reviewDecision: 'CHANGES_REQUESTED',
                    mergeable: 'UNKNOWN',
                    milestone: { id: 'MI_9', title: 'later' },
                    labels: { nodes: [{ name: 'nocolor', color: '' }] },
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] },
                    latestOpinionatedReviews: {
                      nodes: [
                        { state: 'DISMISSED', author: actor('x') },
                        { state: 'PENDING', author: actor('y') },
                        { state: 'COMMENTED', author: null },
                      ],
                    },
                    reviewRequests: {
                      nodes: [
                        { requestedReviewer: null },
                        { requestedReviewer: { __typename: 'Mannequin' } },
                        { requestedReviewer: { __typename: 'Bot', id: 'B1', login: 'dependabot' } },
                      ],
                    },
                    viewerCanMergeAsAdmin: true,
                  }),
                  prNode({
                    number: 2,
                    state: 'CLOSED',
                    closedAt: 'z',
                    baseRepository: {
                      id: 'R',
                      name: 'app',
                      owner: { login: 'acme' },
                      viewerPermission: 'ADMIN',
                    },
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'EXPECTED' } } }] },
                  }),
                  prNode({
                    number: 3,
                    viewerDidAuthor: true,
                    reviewDecision: 'REVIEW_REQUIRED',
                    baseRepository: {
                      id: 'R',
                      name: 'app',
                      owner: { login: 'acme' },
                      viewerPermission: 'READ',
                    },
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
                  }),
                ],
              },
            },
          },
        });
      }),
    );
    const page = await provider().listPullRequests(ref, { state: 'all', head: 'feat' }, 'CUR');
    expect(vars).toMatchObject({ states: null, head: 'feat', after: 'CUR' });
    expect(page.nextCursor).toBeUndefined();
    const [a, b, c] = page.items as [PullRequest, PullRequest, PullRequest];
    expect(a).toMatchObject({
      body: '',
      author: { id: 'ghost', login: 'ghost' },
      reviewDecision: 'changes_requested',
      mergeable: 'unknown',
      checksRollup: 'failure',
      rollup: 'failure',
      milestone: { id: 'MI_9', title: 'later' },
      labels: [{ name: 'nocolor', color: undefined }],
      allowedMergeMethods: ['merge', 'squash', 'rebase'],
      viewer: { canMerge: true },
      assignees: [],
    });
    expect(a.reviewers.map((r) => [r.user.login, r.state])).toEqual([
      ['x', 'dismissed'],
      ['y', 'pending'],
      ['dependabot', 'pending'],
    ]);
    expect(b).toMatchObject({
      state: 'closed',
      closedAt: 'z',
      checksRollup: 'pending',
      allowedMergeMethods: [],
      viewer: { canMerge: false, canApprove: false },
    });
    expect(c).toMatchObject({
      reviewDecision: 'review_required',
      checksRollup: 'failure',
      viewer: { canMerge: false, canApprove: false, isAuthor: true },
    });
  });

  it('searchMyPullRequests batches role queries and merges involvement', async () => {
    let captured: { vars: Record<string, any>; query: string } | undefined;
    server.use(
      gh.query('GitHappensMyPullRequests', ({ variables, query }) => {
        captured = { vars: variables, query };
        return HttpResponse.json({
          data: {
            viewer: { login: 'alice' },
            s0: { issueCount: 1, nodes: [prNode()] },
            s1: { issueCount: 2, nodes: [prNode(), {}] },
            s3: {
              issueCount: 2,
              nodes: [
                prNode({
                  id: 'PR_2',
                  number: 5,
                  baseRepository: null,
                  url: 'https://github.com/other/thing/pull/5',
                }),
                prNode({
                  id: 'PR_3',
                  number: 6,
                  baseRepository: null,
                  url: 'https://elsewhere.com/x/y/pull/6',
                }),
              ],
            },
          },
        });
      }),
    );
    const rows = await provider().searchMyPullRequests!({ limit: 500 });
    expect(captured!.vars).toEqual({
      first: 100,
      q0: 'is:open is:pr archived:false author:@me sort:updated-desc',
      q1: 'is:open is:pr archived:false review-requested:@me sort:updated-desc',
      q2: 'is:open is:pr archived:false assignee:@me sort:updated-desc',
      q3: 'is:open is:pr archived:false mentions:@me sort:updated-desc',
    });
    expect(captured!.query).toContain('s3: search(type: ISSUE, query: $q3, first: $first)');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ involvement: ['author', 'review-requested'], pr: { id: 'PR_1' } });
    expect(rows[0]!.pr.repo).toEqual({ integration, owner: 'acme', name: 'app', id: 'R_1' });
    expect(rows[1]).toMatchObject({
      involvement: ['mentioned'],
      pr: { repo: { owner: 'other', name: 'thing' } },
    });
    expect(rows[2]!.pr.repo).toMatchObject({ owner: '', name: '' });
  });

  it('searchMyPullRequests splits long repo lists into multiple queries', async () => {
    let vars: Record<string, any> = {};
    server.use(
      gh.query('GitHappensMyPullRequests', ({ variables }) => {
        vars = variables;
        return HttpResponse.json({ data: { viewer: { login: 'alice' } } });
      }),
    );
    const repos = Array.from({ length: 20 }, (_, i) => ({ owner: 'acme', name: `repository-${i}` }));
    expect(await provider().searchMyPullRequests!({ repos })).toEqual([]);
    const qKeys = Object.keys(vars).filter((k) => /^q\d+$/.test(k));
    expect(qKeys.length).toBeGreaterThan(4);
    expect(qKeys.length % 4).toBe(0);
    expect(vars.first).toBe(50);
    for (const k of qKeys) expect(String(vars[k]).length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
    const joined = qKeys.map((k) => String(vars[k])).filter((q) => q.includes('author:@me'));
    expect(joined.join(' ').match(/repo:/g)).toHaveLength(20);
  });

  it('searchQueries keeps a single oversized repo per query', () => {
    const long = { owner: 'o', name: 'n'.repeat(300) };
    expect(searchQueries('base', [long, long])).toEqual([
      `base repo:o/${long.name}`,
      `base repo:o/${long.name}`,
    ]);
    expect(searchQueries('base', [])).toEqual(['base']);
  });

  it('getTimeline normalizes every event type and paginates without threads', async () => {
    const withThreads: boolean[] = [];
    const ev = (t: string, o: Record<string, unknown> = {}) => ({
      __typename: t,
      createdAt: '2026-01-02T00:00:00Z',
      actor: actor('bob'),
      ...o,
    });
    server.use(
      gh.query('GitHappensPrTimeline', ({ variables }) => {
        withThreads.push(variables.withThreads);
        return HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { __typename: 'IssueComment', id: 'IC', createdAt: '2026-01-01T00:00:00Z', author: null },
                    {
                      __typename: 'PullRequestReview',
                      id: 'RV',
                      state: 'APPROVED',
                      createdAt: '2026-01-01T00:01:00Z',
                      author: actor('bob'),
                    },
                    {
                      __typename: 'PullRequestReview',
                      id: 'RV2',
                      databaseId: 3,
                      state: 'COMMENTED',
                      body: 'note',
                      createdAt: '2026-01-01T00:01:30Z',
                      author: actor('bob'),
                    },
                    {
                      __typename: 'PullRequestCommit',
                      commit: { oid: 'c1', committedDate: '2026-01-01T00:02:00Z', author: { name: 'x' } },
                    },
                    {
                      __typename: 'PullRequestCommit',
                      commit: { oid: 'c2', committedDate: '2026-01-01T00:03:00Z', author: null },
                    },
                    {
                      __typename: 'PullRequestCommit',
                      commit: {
                        oid: 'c3',
                        committedDate: '2026-01-01T00:04:00Z',
                        author: { user: actor('carol') },
                      },
                    },
                    { __typename: 'HeadRefForcePushedEvent', createdAt: '2026-01-01T00:05:00Z', actor: null },
                    ev('UnlabeledEvent', { label: { name: 'bug' } }),
                    ev('AssignedEvent', { assignee: { login: 'carol' } }),
                    ev('UnassignedEvent', { assignee: null }),
                    ev('ReviewRequestedEvent', { requestedReviewer: { slug: 'core' } }),
                    ev('ReviewRequestRemovedEvent', { requestedReviewer: { login: 'dave' } }),
                    ev('MergedEvent', { commit: { oid: 'm1' } }),
                    ev('ClosedEvent', { actor: null }),
                    ev('ReopenedEvent'),
                    ev('ReadyForReviewEvent'),
                    ev('ConvertToDraftEvent'),
                    ev('RenamedTitleEvent', { previousTitle: 'a', currentTitle: 'b' }),
                    ev('BaseRefChangedEvent', { previousRefName: 'main', currentRefName: 'dev' }),
                    ev('HeadRefDeletedEvent', { headRefName: 'feat' }),
                    ev('SomethingNewEvent'),
                  ],
                },
              },
            },
          },
        });
      }),
    );
    const t = await provider().getTimeline(ref, 1, 'CUR');
    expect(withThreads).toEqual([false]);
    expect(t.nextCursor).toBeUndefined();
    expect(t.items.slice(0, 6)).toEqual([
      {
        kind: 'comment',
        id: 'IC',
        author: { id: 'ghost', login: 'ghost' },
        body: '',
        createdAt: '2026-01-01T00:00:00Z',
        editable: false,
      },
      expect.objectContaining({ kind: 'review', id: 'RV', state: 'approved', body: '' }),
      expect.objectContaining({ kind: 'review', id: '3', state: 'commented', body: 'note' }),
      { kind: 'commits', shas: ['c1', 'c2'], actor: undefined, createdAt: '2026-01-01T00:02:00Z' },
      expect.objectContaining({
        kind: 'commits',
        shas: ['c3'],
        actor: expect.objectContaining({ login: 'carol' }),
      }),
      { kind: 'commits', shas: [], actor: undefined, createdAt: '2026-01-01T00:05:00Z', forced: true },
    ]);
    const events = t.items
      .slice(6)
      .map((i) => (i.kind === 'event' ? [i.event, i.detail, !!i.actor] : i.kind));
    expect(events).toEqual([
      ['unlabeled', 'bug', true],
      ['assigned', 'carol', true],
      ['unassigned', undefined, true],
      ['review_requested', 'core', true],
      ['review_request_removed', 'dave', true],
      ['merged', 'm1', true],
      ['closed', undefined, false],
      ['reopened', undefined, true],
      ['ready_for_review', undefined, true],
      ['convert_to_draft', undefined, true],
      ['renamed', 'a → b', true],
      ['base_changed', 'main → dev', true],
      ['head_ref_deleted', 'feat', true],
    ]);
  });

  it('getTimeline skips empty review threads and prefers the current line', async () => {
    server.use(
      gh.query('GitHappensPrTimeline', () =>
        HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                reviewThreads: {
                  nodes: [
                    {
                      id: 'T0',
                      isResolved: false,
                      isOutdated: false,
                      path: 'x',
                      line: 1,
                      originalLine: 1,
                      diffSide: 'LEFT',
                      comments: { nodes: [] },
                    },
                    {
                      id: 'T1',
                      isResolved: false,
                      isOutdated: false,
                      path: 'a.ts',
                      line: 4,
                      originalLine: 2,
                      diffSide: 'LEFT',
                      comments: {
                        nodes: [{ id: 'C', body: 'b', createdAt: 'x', author: null }],
                      },
                    },
                    {
                      id: 'T2',
                      isResolved: false,
                      isOutdated: true,
                      path: 'b.ts',
                      line: null,
                      originalLine: null,
                      diffSide: 'RIGHT',
                      comments: {
                        nodes: [{ id: 'D', databaseId: 1, body: 'c', createdAt: 'w', author: null }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );
    const t = await provider().getTimeline(ref, 1);
    expect(t.items).toEqual([
      expect.objectContaining({ kind: 'thread', id: 'T2', line: undefined, side: 'RIGHT' }),
      {
        kind: 'thread',
        id: 'T1',
        path: 'a.ts',
        line: 4,
        side: 'LEFT',
        diffHunk: undefined,
        resolved: false,
        outdated: false,
        comments: [{ id: 'C', author: { id: 'ghost', login: 'ghost' }, body: 'b', createdAt: 'x' }],
      },
    ]);
  });

  it('getChecks paginates check runs and treats a missing status as empty', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/commits/abc/check-runs`, ({ request }) => {
        if (new URL(request.url).searchParams.get('page') === '2')
          return HttpResponse.json({
            check_runs: [
              { id: 2, name: 'b', status: 'queued', conclusion: null, app: null, details_url: 'https://d' },
            ],
          });
        return HttpResponse.json(
          {
            check_runs: [
              {
                id: 1,
                name: 'a',
                status: 'completed',
                conclusion: 'success',
                started_at: 's',
                completed_at: 'c',
                app: { slug: 'github-actions' },
              },
            ],
          },
          { headers: { link: `<${API}/repos/acme/app/commits/abc/check-runs?page=2>; rel="next"` } },
        );
      }),
      http.get(`${API}/repos/acme/app/commits/abc/status`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect(await provider().getChecks(ref, 'abc')).toEqual([
      {
        id: '1',
        name: 'a',
        group: undefined,
        status: 'success',
        startedAt: 's',
        completedAt: 'c',
        detailsUrl: undefined,
        canRerun: true,
        provider: 'actions',
      },
      {
        id: '2',
        name: 'b',
        group: undefined,
        status: 'queued',
        startedAt: undefined,
        completedAt: undefined,
        detailsUrl: 'https://d',
        canRerun: false,
        provider: 'other',
      },
    ]);
  });

  it('getChecks maps pending/failure commit statuses and rethrows non-404 errors', async () => {
    let fail = false;
    server.use(
      http.get(`${API}/repos/acme/app/commits/abc/check-runs`, () => HttpResponse.json({ check_runs: [] })),
      http.get(`${API}/repos/acme/app/commits/abc/status`, () =>
        fail
          ? HttpResponse.json({ message: 'nope' }, { status: 403 })
          : HttpResponse.json({
              statuses: [
                { id: 1, context: 'p', state: 'pending', created_at: 'a', updated_at: 'b' },
                { id: 2, context: 'e', state: 'error', created_at: 'a', updated_at: 'b' },
              ],
            }),
      ),
    );
    const p = provider();
    expect(await p.getChecks(ref, 'abc')).toEqual([
      expect.objectContaining({
        id: 'status:1',
        status: 'in_progress',
        completedAt: undefined,
        detailsUrl: undefined,
      }),
      expect.objectContaining({ id: 'status:2', status: 'failure', completedAt: 'b' }),
    ]);
    fail = true;
    expect((await err(p.getChecks(ref, 'abc'))).code).toBe('insufficient_scope');
  });

  it('listPrTemplates finds root and docs templates and decodes plain content', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/contents/.github`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
      http.get(`${API}/repos/acme/app/contents`, () =>
        HttpResponse.json([
          { name: 'PULL_REQUEST_TEMPLATE.md', path: 'PULL_REQUEST_TEMPLATE.md', type: 'file' },
        ]),
      ),
      http.get(`${API}/repos/acme/app/contents/docs`, () =>
        HttpResponse.json([
          { name: 'pull_request_template', path: 'docs/pull_request_template', type: 'dir' },
          { name: 'pull_request_template.md', path: 'docs/pull_request_template.md', type: 'file' },
        ]),
      ),
      http.get(`${API}/repos/acme/app/contents/docs/pull_request_template`, () =>
        HttpResponse.json([
          { name: 'feature.md', path: 'docs/pull_request_template/feature.md', type: 'file' },
          { name: 'notes.txt', path: 'docs/pull_request_template/notes.txt', type: 'file' },
        ]),
      ),
      http.get(`${API}/repos/acme/app/contents/PULL_REQUEST_TEMPLATE.md`, () =>
        HttpResponse.json({ content: 'plain', encoding: 'utf-8' }),
      ),
      http.get(`${API}/repos/acme/app/contents/docs/pull_request_template/feature.md`, () =>
        HttpResponse.json({}),
      ),
      http.get(`${API}/repos/acme/app/contents/docs/pull_request_template.md`, () =>
        // A single-file response (not an array) is also handled by `dir()`; here it is the content.
        HttpResponse.json({ content: Buffer.from('docs').toString('base64'), encoding: 'base64' }),
      ),
    );
    expect(await provider().listPrTemplates(ref, 'main')).toEqual([
      { name: 'Default', path: 'PULL_REQUEST_TEMPLATE.md', body: 'plain' },
      { name: 'feature', path: 'docs/pull_request_template/feature.md', body: '' },
      { name: 'Default', path: 'docs/pull_request_template.md', body: 'docs' },
    ]);
  });

  it('listPrTemplates ignores non-array listings and rethrows non-404 errors', async () => {
    let fail = false;
    server.use(
      http.get(`${API}/repos/acme/app/contents/.github`, () =>
        fail
          ? HttpResponse.json({ message: 'x' }, { status: 500 })
          : HttpResponse.json({ name: 'x', type: 'file' }),
      ),
      http.get(`${API}/repos/acme/app/contents`, () => HttpResponse.json([])),
      http.get(`${API}/repos/acme/app/contents/docs`, () => HttpResponse.json([])),
    );
    const p = provider();
    expect(await p.listPrTemplates(ref, 'main')).toEqual([]);
    fail = true;
    expect((await err(p.listPrTemplates(ref, 'main'))).code).toBe('server');
  });
});

// ---------------------------------------------------------------------------

describe('GitHub provider: CI and SSH', () => {
  const run = (o: Record<string, unknown>) => ({
    id: 1,
    run_number: 1,
    status: 'completed',
    conclusion: 'success',
    created_at: 'created',
    updated_at: 'updated',
    html_url: 'https://r',
    ...o,
  });

  it('listCiRuns normalizes workflow runs and follows the cursor', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/repos/acme/app/actions/runs`, ({ request }) => {
        urls.push(request.url);
        if (new URL(request.url).searchParams.get('page') === '2')
          return HttpResponse.json({ total_count: 12, workflow_runs: [] });
        return HttpResponse.json(
          {
            total_count: 12,
            workflow_runs: [
              run({
                id: 10,
                name: 'CI',
                display_title: 'Fix bug',
                run_number: 3,
                head_branch: 'main',
                event: 'push',
                run_started_at: 'started',
                actor: { id: 1, login: 'alice', avatar_url: 'https://a' },
              }),
              run({ id: 11, name: 'Deploy', status: 'queued', conclusion: null }),
              run({ id: 12, status: 'in_progress', conclusion: null }),
              run({ id: 13, conclusion: 'startup_failure' }),
              run({ id: 14, conclusion: 'cancelled' }),
              run({ id: 15, conclusion: 'skipped' }),
              run({ id: 16, conclusion: 'timed_out' }),
              run({ id: 17, conclusion: 'action_required' }),
              run({ id: 18, conclusion: 'stale' }),
              run({ id: 19, conclusion: 'failure' }),
            ],
          },
          { headers: { link: `<${API}/repos/acme/app/actions/runs?page=2>; rel="next"` } },
        );
      }),
    );
    const p = provider();
    const page = await p.listCiRuns!(ref, {});
    expect(new URL(urls[0]!).searchParams.get('per_page')).toBe('30');
    expect(new URL(urls[0]!).searchParams.has('branch')).toBe(false);
    expect(page.total).toBe(12);
    expect(page.nextCursor).toContain('page=2');
    expect(page.items[0]).toEqual({
      id: '10',
      name: 'Fix bug',
      group: 'CI',
      status: 'success',
      startedAt: 'started',
      completedAt: 'updated',
      detailsUrl: 'https://r',
      canRerun: true,
      provider: 'actions',
      runNumber: 3,
      branch: 'main',
      event: 'push',
      actor: { id: '1', login: 'alice', name: undefined, avatarUrl: 'https://a', email: undefined },
    });
    expect(page.items[1]).toMatchObject({
      name: 'Deploy',
      status: 'queued',
      startedAt: 'created',
      completedAt: undefined,
      canRerun: false,
      actor: undefined,
    });
    expect(page.items[2]).toMatchObject({ name: 'Run #1', status: 'in_progress' });
    expect(page.items.slice(3).map((i) => i.status)).toEqual([
      'failure',
      'cancelled',
      'skipped',
      'timed_out',
      'action_required',
      'neutral',
      'failure',
    ]);
    const next = await p.listCiRuns!(ref, { cursor: page.nextCursor });
    expect(urls[1]).toBe(`${API}/repos/acme/app/actions/runs?page=2`);
    expect(next.items).toEqual([]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('listCiRuns maps 404 (Actions disabled) to not_found', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/actions/runs`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect((await err(provider().listCiRuns!(ref, { branch: 'main' }))).code).toBe('not_found');
  });

  it('rerunCi reruns a whole run and cancelCi cancels it', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${API}/repos/acme/app/actions/runs/:id/:action`, async ({ request, params }) => {
        calls.push(`${request.method} ${params.id} ${params.action} ${await request.text()}`);
        return new HttpResponse(null, { status: params.action === 'cancel' ? 202 : 201 });
      }),
    );
    const p = provider();
    await expect(p.rerunCi!(ref, '42')).resolves.toBeUndefined();
    await p.rerunCi!(ref, '42', { failedOnly: false });
    await expect(p.cancelCi!(ref, '42')).resolves.toBeUndefined();
    expect(calls).toEqual(['POST 42 rerun ', 'POST 42 rerun ', 'POST 42 cancel ']);
  });

  it('rerunCi / cancelCi map 403 and 409 errors', async () => {
    server.use(
      http.post(`${API}/repos/acme/app/actions/runs/1/rerun`, () =>
        HttpResponse.json(
          { message: 'Must have admin rights' },
          { status: 403, headers: { 'x-accepted-oauth-scopes': 'workflow', 'x-oauth-scopes': 'repo' } },
        ),
      ),
      http.post(`${API}/repos/acme/app/actions/runs/1/cancel`, () =>
        HttpResponse.json({ message: 'Cannot cancel a workflow run that is completed.' }, { status: 409 }),
      ),
    );
    const e = await err(provider().rerunCi!(ref, '1'));
    expect(e.code).toBe('insufficient_scope');
    expect(e.serialized.missingScopes).toEqual(['workflow']);
    expect((await err(provider().cancelCi!(ref, '1'))).code).toBe('conflict');
  });

  it('uploads and lists SSH keys with fingerprints', async () => {
    let body: unknown;
    const key = `ssh-ed25519 ${Buffer.from('hello').toString('base64')} me@host`;
    server.use(
      http.post(`${API}/user/keys`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 9 }, { status: 201 });
      }),
      http.get(`${API}/user/keys`, () =>
        HttpResponse.json([
          { id: 9, title: 'laptop', key },
          { id: 10, key: 'garbage' },
        ]),
      ),
    );
    const p = provider();
    expect(await p.uploadSshKey!('laptop', `  ${key}\n`)).toEqual({ id: '9' });
    expect(body).toEqual({ title: 'laptop', key });
    const keys = await p.listSshKeys!();
    expect(keys[0]).toMatchObject({ id: '9', title: 'laptop' });
    expect(keys[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(keys[1]).toEqual({ id: '10', title: '', fingerprint: undefined });
    expect(sshFingerprint(key)).toBe(keys[0]!.fingerprint);
  });
});

// ---------------------------------------------------------------------------

describe('GitHub GraphQL error handling', () => {
  const listWith = (body: unknown, headers: Record<string, string> = {}) =>
    server.use(gh.query('GitHappensPrList', () => HttpResponse.json(body as any, { headers })));

  it('tolerates nested partial errors when data is present', async () => {
    listWith({
      data: {
        viewer: { login: 'a' },
        repository: {
          pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
      errors: [
        {
          type: 'FORBIDDEN',
          path: ['repository', 'pullRequests', 'nodes', 0, 'headRepository'],
          message: 'x',
        },
      ],
    });
    expect((await provider().listPullRequests(ref, {})).items).toEqual([]);
  });

  it('throws nested errors when there is no data, and an empty response as server', async () => {
    listWith({
      data: null,
      errors: [{ type: 'FORBIDDEN', path: ['repository', 'x'], message: 'Not allowed' }],
    });
    const e1 = await err(provider().listPullRequests(ref, {}));
    expect(e1.code).toBe('insufficient_scope');
    listWith({});
    const e2 = await err(provider().listPullRequests(ref, {}));
    expect(e2.code).toBe('server');
    expect(e2.message).toBe('Empty GraphQL response');
  });

  it('maps BAD_USER_INPUT, scope errors without a list, rate limits without reset, and joins messages', async () => {
    listWith({ data: null, errors: [{ type: 'BAD_USER_INPUT', message: 'bad' }, { message: 'second' }] });
    const e1 = await err(provider().listPullRequests(ref, {}));
    expect(e1.code).toBe('validation');
    expect(e1.serialized.providerMessage).toBe('bad; second');

    listWith({
      data: { viewer: null },
      errors: [{ type: 'INSUFFICIENT_SCOPES', path: ['a', 'b'], message: 'nope' }],
    });
    const e2 = await err(provider().listPullRequests(ref, {}));
    expect(e2.code).toBe('insufficient_scope');
    expect(e2.serialized.missingScopes).toBeUndefined();

    listWith({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] });
    const before = Date.now();
    const e3 = await err(provider().listPullRequests(ref, {}));
    expect(e3.code).toBe('rate_limited');
    expect(e3.serialized.retryAt).toBeGreaterThanOrEqual(before + 59_000);

    listWith({
      data: null,
      errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
    });
    expect((await err(provider().listPullRequests(ref, {}))).code).toBe('insufficient_scope');
  });
});

// ---------------------------------------------------------------------------

describe('GitHub issue tracker: mutations', () => {
  it('createIssue posts the issue and normalizes it', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/repos/acme/app/issues`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(issueJson({ repository_url: `${API}/repos/acme/app` }), { status: 201 });
      }),
    );
    const t = tracker();
    const i = await t.createIssue!('acme/app', {
      title: 'Crash',
      body: 'It crashes',
      assignees: ['alice'],
      labels: ['bug'],
      type: 'Bug',
    });
    expect(body).toEqual({ title: 'Crash', body: 'It crashes', assignees: ['alice'], labels: ['bug'] });
    expect(i).toEqual({
      tracker: { kind: 'github', integration, scope: 'acme/app' },
      key: '#12',
      id: '500',
      title: 'Crash',
      body: 'It crashes',
      bodyFormat: 'markdown',
      state: 'open',
      stateCategory: 'todo',
      assignees: [{ id: '1', login: 'alice', name: undefined, avatarUrl: undefined, email: undefined }],
      reporter: { id: '2', login: 'bob', name: undefined, avatarUrl: undefined, email: undefined },
      labels: ['bug', 'p1'],
      milestone: 'v1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      webUrl: 'https://github.com/acme/app/issues/12',
      commentsCount: 2,
    });
  });

  it('createIssue validates the scope and maps 410/404/403 errors', async () => {
    server.use(
      http.post(`${API}/repos/acme/gone/issues`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
      http.post(`${API}/repos/acme/locked/issues`, () =>
        HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 }),
      ),
    );
    const t = tracker();
    const v = await err(t.createIssue!('acme', { title: 'x' }));
    expect(v.code).toBe('validation');
    expect(v.message).toContain("'acme'");
    expect((await err(t.createIssue!('acme/gone', { title: 'x' }))).code).toBe('not_found');
    expect((await err(t.createIssue!('acme/locked', { title: 'x' }))).code).toBe('insufficient_scope');
  });

  it('updateIssue PATCHes the patch and resolves the account via GET /user when needed', async () => {
    let body: unknown;
    let userCalls = 0;
    server.use(
      http.get(`${API}/user`, () => {
        userCalls++;
        return HttpResponse.json({ id: 77, login: 'alice' });
      }),
      http.patch(`${API}/repos/acme/app/issues/12`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          issueJson({
            title: 'New',
            body: null,
            state: 'closed',
            state_reason: 'completed',
            assignees: undefined,
            user: undefined,
            milestone: null,
          }),
        );
      }),
    );
    const t = tracker(null);
    const i = await t.updateIssue!('acme/app', '#12', { title: 'New', labels: [] });
    await t.updateIssue!('acme/app', '12', { body: 'b' });
    expect(userCalls).toBe(1);
    expect(body).toEqual({ body: 'b' });
    expect(i).toMatchObject({
      tracker: { integration: { kind: 'github', host: 'github.com', accountId: '77' }, scope: 'acme/app' },
      title: 'New',
      body: '',
      state: 'closed (completed)',
      stateCategory: 'done',
      assignees: [],
      reporter: undefined,
      milestone: undefined,
    });
  });

  it('updateIssue maps 404 to not_found', async () => {
    server.use(
      http.patch(`${API}/repos/acme/app/issues/999`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect((await err(tracker().updateIssue!('acme/app', '#999', { title: 'x' }))).code).toBe('not_found');
  });

  it('listTransitions depends on the issue state', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/issues/:n`, ({ params }) =>
        HttpResponse.json(
          issueJson({ number: Number(params.n), state: params.n === '1' ? 'open' : 'closed' }),
        ),
      ),
    );
    const t = tracker();
    expect(await t.listTransitions!('acme/app', '#1')).toEqual([
      { id: 'close', name: 'Close as completed', toCategory: 'done' },
      { id: 'close:not_planned', name: 'Close as not planned', toCategory: 'done' },
    ]);
    expect(await t.listTransitions!('acme/app', '#2')).toEqual([
      { id: 'reopen', name: 'Reopen', toCategory: 'todo' },
    ]);
  });

  it('listTransitions maps 404 to not_found', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/issues/5`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect((await err(tracker().listTransitions!('acme/app', '#5'))).code).toBe('not_found');
  });

  it('transition PATCHes state and state_reason', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch(`${API}/repos/acme/app/issues/3`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(issueJson({ number: 3 }));
      }),
    );
    const t = tracker();
    await t.transition!('acme/app', '#3', 'close');
    await t.transition!('acme/app', '#3', 'close:not_planned');
    await t.transition!('acme/app', '3', 'reopen');
    expect(bodies).toEqual([
      { state: 'closed', state_reason: 'completed' },
      { state: 'closed', state_reason: 'not_planned' },
      { state: 'open' },
    ]);
  });

  it('transition maps 403 to insufficient_scope', async () => {
    server.use(
      http.patch(`${API}/repos/acme/app/issues/3`, () =>
        HttpResponse.json(
          { message: 'Must have push access' },
          { status: 403, headers: { 'x-accepted-oauth-scopes': 'repo, public_repo', 'x-oauth-scopes': '' } },
        ),
      ),
    );
    const e = await err(tracker().transition!('acme/app', '#3', 'close'));
    expect(e.code).toBe('insufficient_scope');
  });

  it('addComment posts the comment body', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/repos/acme/app/issues/4/comments`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
      http.post(`${API}/repos/acme/app/issues/5/comments`, () =>
        HttpResponse.json({ message: 'Issue is locked' }, { status: 422 }),
      ),
    );
    const t = tracker();
    await expect(t.addComment!('acme/app', '#4', 'Thanks!')).resolves.toBeUndefined();
    expect(body).toEqual({ body: 'Thanks!' });
    expect((await err(t.addComment!('acme/app', '#5', 'x'))).code).toBe('validation');
  });

  it('listComments follows Link pagination', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/repos/acme/app/issues/6/comments`, ({ request }) => {
        urls.push(request.url);
        if (new URL(request.url).searchParams.get('page') === '2')
          return HttpResponse.json([{ id: 2, body: 'second', created_at: 'b', user: null }]);
        return HttpResponse.json(
          [{ id: 1, body: 'first', created_at: 'a', user: { id: 3, login: 'carol' } }],
          {
            headers: { link: `<${API}/repos/acme/app/issues/6/comments?per_page=100&page=2>; rel="next"` },
          },
        );
      }),
    );
    expect(await tracker().listComments!('acme/app', '#6')).toEqual([
      {
        id: '1',
        author: { id: '3', login: 'carol', name: undefined, avatarUrl: undefined, email: undefined },
        body: 'first',
        createdAt: 'a',
      },
      { id: '2', author: { id: 'ghost', login: 'ghost' }, body: 'second', createdAt: 'b' },
    ]);
    expect(new URL(urls[0]!).searchParams.get('per_page')).toBe('100');
    expect(urls).toHaveLength(2);
  });

  it('listComments maps 404 to not_found', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/issues/7/comments`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    expect((await err(tracker().listComments!('acme/app', '#7'))).code).toBe('not_found');
  });
});

describe('GitHub issue tracker: queries', () => {
  it('getIssue fetches and normalizes a closed issue', async () => {
    server.use(
      http.get(`${API}/repos/acme/app/issues/8`, () =>
        HttpResponse.json(issueJson({ number: 8, state: 'closed', state_reason: null })),
      ),
    );
    expect(await tracker().getIssue('acme/app', '#8')).toMatchObject({
      key: '#8',
      state: 'closed',
      stateCategory: 'done',
      tracker: { scope: 'acme/app' },
    });
  });

  it('listScopes pages through repos and skips repos without issues', async () => {
    server.use(
      http.get(`${API}/user/repos`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        if (sp.get('page') === '2') return HttpResponse.json([repoJson('acme', 'c')]);
        expect(sp.get('affiliation')).toBe('owner,collaborator,organization_member');
        return HttpResponse.json([repoJson('acme', 'a'), repoJson('acme', 'b', { has_issues: false })], {
          headers: { link: `<${API}/user/repos?page=2>; rel="next"` },
        });
      }),
    );
    expect(await tracker().listScopes()).toEqual([
      { scope: 'acme/a', label: 'acme/a' },
      { scope: 'acme/c', label: 'acme/c' },
    ]);
  });

  it('listIssues builds queries for each preset, raw queries and cursors', async () => {
    const qs: string[] = [];
    server.use(
      http.get(`${API}/search/issues`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        qs.push(sp.get('q') ?? `cursor:${sp.get('page')}`);
        return HttpResponse.json({
          total_count: 1,
          items: [issueJson({ repository_url: `${API}/repos/x/y` })],
        });
      }),
    );
    const t = tracker();
    await t.listIssues('acme/app', { preset: 'created' });
    await t.listIssues('*', { preset: 'all-open', updatedSince: '2026-01-01T00:00:00.000Z' });
    const raw = await t.listIssues('acme/app', { query: 'label:bug' });
    await t.listIssues('acme/app', {});
    await t.listIssues('acme/app', {}, `${API}/search/issues?q=x&page=3`);
    expect(qs).toEqual([
      'is:issue repo:acme/app is:open author:@me',
      'is:issue is:open updated:>=2026-01-01T00:00:00',
      'is:issue repo:acme/app label:bug',
      'is:issue repo:acme/app is:open assignee:@me',
      'x',
    ]);
    expect(raw.items[0]!.tracker.scope).toBe('x/y');
    expect(raw.nextCursor).toBeUndefined();
  });

  it('searchMyIssues merges assignee and creator rows across scopes', async () => {
    const qs: string[] = [];
    server.use(
      http.get(`${API}/search/issues`, ({ request }) => {
        const sp = new URL(request.url).searchParams;
        const q = sp.get('q') ?? '';
        qs.push(`${q}|${sp.get('per_page')}`);
        const items = [
          issueJson({ repository_url: `${API}/repos/acme/app` }),
          issueJson({ number: 99, pull_request: {} }),
        ];
        if (q.includes('author:@me'))
          items.push(issueJson({ number: 13, repository_url: `${API}/repos/acme/web` }));
        return HttpResponse.json({ items });
      }),
    );
    const t = tracker();
    const rows = await t.searchMyIssues!({ scopes: ['acme/app', 'acme/web', 'bad', 'x/'], limit: 1000 });
    expect(qs.sort()).toEqual([
      'is:open is:issue archived:false assignee:@me repo:acme/app repo:acme/web|100',
      'is:open is:issue archived:false author:@me repo:acme/app repo:acme/web|100',
    ]);
    expect(rows.map((r) => [r.issue.tracker.scope, r.issue.key, r.involvement])).toEqual([
      ['acme/app', '#12', ['assignee', 'creator']],
      ['acme/web', '#13', ['creator']],
    ]);

    qs.length = 0;
    const onlyAssigned = await t.searchMyIssues!({ includeCreated: false });
    expect(qs).toEqual(['is:open is:issue archived:false assignee:@me|50']);
    expect(onlyAssigned).toHaveLength(1);
    // Issues without a repository_url fall back to the (empty) cross-repo scope.
    server.use(http.get(`${API}/search/issues`, () => HttpResponse.json({ items: [issueJson()] })));
    expect((await t.searchMyIssues!())[0]!.issue.tracker.scope).toBe('');
  });
});
