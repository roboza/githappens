import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGitLabIssueTracker } from '../src/gitlab/issues';
import { createGitLabProvider } from '../src/gitlab/provider';
import { HttpClient } from '../src/http';
import type { IntegrationId, PullRequest, RepoRef } from '../src/types';

const API = 'https://gitlab.com/api/v4';
const PID = 'grp%2Fsub%2Fapp';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = (baseUrl = API) => new HttpClient({ baseUrl, auth: () => 'Bearer glpat-test', retries: 0 });
const integration: IntegrationId = { kind: 'gitlab', host: 'gitlab.com', accountId: '100' };
const ref: RepoRef = { integration, owner: 'grp/sub', name: 'app' };
const provider = (accountId: string | undefined = '100') =>
  createGitLabProvider({ http: client(), host: 'gitlab.com', accountId });
const tracker = (accountId: string | undefined = '100') =>
  createGitLabIssueTracker({ http: client(), host: 'https://gitlab.com/', accountId });

interface Call {
  method: string;
  url: URL;
  body: unknown;
}
/** Records every matching request (method, URL, parsed JSON body). */
const recorder = () => {
  const calls: Call[] = [];
  const record = async (request: Request): Promise<void> => {
    const text = await request.text();
    calls.push({
      method: request.method,
      url: new URL(request.url),
      body: text ? JSON.parse(text) : undefined,
    });
  };
  return { calls, record };
};

const user = (id: number, username: string) => ({
  id,
  username,
  name: username.toUpperCase(),
  avatar_url: `https://a/${username}`,
});
const project = (o: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'app',
  path: 'app',
  path_with_namespace: 'grp/sub/app',
  namespace: { full_path: 'grp/sub' },
  visibility: 'private',
  default_branch: 'main',
  http_url_to_repo: 'https://gitlab.com/grp/sub/app.git',
  ssh_url_to_repo: 'git@gitlab.com:grp/sub/app.git',
  web_url: 'https://gitlab.com/grp/sub/app',
  last_activity_at: '2026-01-01T00:00:00Z',
  merge_method: 'ff',
  squash_option: 'default_off',
  permissions: { project_access: { access_level: 30 }, group_access: null },
  ...o,
});
const mr = (o: Record<string, unknown> = {}) => ({
  id: 5001,
  iid: 1,
  project_id: 1,
  title: 'Add login',
  description: 'Body',
  state: 'opened',
  draft: false,
  author: user(100, 'alice'),
  assignees: [user(100, 'alice')],
  reviewers: [user(101, 'bob')],
  labels: [{ name: 'bug', color: '#ff0000' }],
  milestone: { id: 77, title: 'v1' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  source_branch: 'feature/login',
  target_branch: 'main',
  source_project_id: 1,
  target_project_id: 1,
  sha: 'head1',
  merge_status: 'can_be_merged',
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  user_notes_count: 2,
  changes_count: '3',
  web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/1',
  ...o,
});
const issue = (o: Record<string, unknown> = {}) => ({
  id: 9001,
  iid: 12,
  project_id: 1,
  title: 'Crash',
  description: 'It crashes',
  state: 'opened',
  labels: ['bug'],
  assignees: [user(100, 'alice')],
  author: user(101, 'bob'),
  milestone: { title: 'v1' },
  issue_type: 'issue',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  web_url: 'https://gitlab.com/grp/sub/app/-/issues/12',
  user_notes_count: 4,
  references: { full: 'grp/sub/app#12' },
  ...o,
});
const err = (status: number, message = 'nope') => HttpResponse.json({ message }, { status });

const baseHandlers = () => [
  http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
  http.get(`${API}/projects/${PID}`, () => HttpResponse.json(project())),
  http.get(`${API}/projects/2`, () =>
    HttpResponse.json(
      project({
        id: 2,
        path_with_namespace: 'dave/app',
        http_url_to_repo: 'https://gitlab.com/dave/app.git',
        forked_from_project: { id: 1, path_with_namespace: 'grp/sub/app' },
      }),
    ),
  ),
  http.get(`${API}/projects/${PID}/merge_requests/:iid/approvals`, () =>
    HttpResponse.json({ approvals_left: 0, approved_by: [] }),
  ),
];

// ---------------------------------------------------------------- repos

describe('GitLab provider: repos', () => {
  it('createRepo in the viewer namespace (no namespace lookup)', async () => {
    const { calls, record } = recorder();
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.post(`${API}/projects`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(
          project({ id: 50, path_with_namespace: 'alice/new', visibility: 'public', permissions: undefined }),
          { status: 201 },
        );
      }),
    );
    const repo = await provider(undefined).createRepo!({
      owner: 'Alice',
      name: 'new',
      private: false,
      description: 'D',
      gitignore: 'Node',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/api/v4/projects');
    expect(calls[0]!.body).toEqual({ name: 'new', visibility: 'public', description: 'D' });
    expect(repo).toMatchObject({
      fullName: 'alice/new',
      isPrivate: false,
      isFork: false,
      viewerPermission: undefined,
      ref: { owner: 'alice', name: 'new', id: '50', integration: { kind: 'gitlab', accountId: '100' } },
    });
  });

  it('createRepo in a group resolves namespace_id; private; no owner', async () => {
    const { calls, record } = recorder();
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/namespaces/grp%2Fsub`, () => HttpResponse.json({ id: 42 })),
      http.post(`${API}/projects`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(project({ id: 51, path_with_namespace: 'grp/sub/new' }), { status: 201 });
      }),
    );
    const p = provider();
    const repo = await p.createRepo!({ owner: 'grp/sub', name: 'new', private: true });
    expect(calls[0]!.body).toEqual({ name: 'new', namespace_id: 42, visibility: 'private' });
    expect(repo).toMatchObject({ fullName: 'grp/sub/new', isPrivate: true, viewerPermission: 'write' });
    await p.createRepo!({ name: 'bare', private: true });
    expect(calls[1]!.body).toEqual({ name: 'bare', visibility: 'private' });
  });

  it('createRepo surfaces namespace 404 and 400 validation errors', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/namespaces/:ns`, () => err(404, '404 Namespace Not Found')),
    );
    await expect(provider().createRepo!({ owner: 'nope', name: 'x', private: true })).rejects.toMatchObject({
      code: 'not_found',
    });
    server.use(http.post(`${API}/projects`, () => err(400, 'name has already been taken')));
    await expect(provider().createRepo!({ name: 'x', private: true })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('createFork with and without a target namespace', async () => {
    const { calls, record } = recorder();
    server.use(
      http.post(`${API}/projects/${PID}/fork`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(
          project({
            id: 2,
            path_with_namespace: 'dave/app',
            forked_from_project: { id: 1, path_with_namespace: 'grp/sub/app' },
            permissions: { project_access: { access_level: 50 } },
          }),
          { status: 201 },
        );
      }),
    );
    const fork = await provider().createFork!(ref, { owner: 'dave' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ namespace_path: 'dave' });
    expect(fork).toMatchObject({
      fullName: 'dave/app',
      isFork: true,
      viewerPermission: 'admin',
      parent: { owner: 'grp/sub', name: 'app', id: '1' },
    });
    await provider().createFork!(ref);
    expect(calls[1]!.body).toEqual({});
  });

  it('createFork maps 409 to conflict', async () => {
    server.use(http.post(`${API}/projects/${PID}/fork`, () => err(409, 'already forked')));
    await expect(provider().createFork!(ref)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('getRepo / listForks / listRepos by owner (user + group)', async () => {
    const queries: Record<string, URLSearchParams> = {};
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/projects/${PID}`, () =>
        HttpResponse.json(
          project({ permissions: { project_access: null, group_access: { access_level: 40 } } }),
        ),
      ),
      http.get(`${API}/projects/${PID}/forks`, () =>
        HttpResponse.json([project({ id: 2, path_with_namespace: 'dave/app', default_branch: null })], {
          headers: { 'x-next-page': '3', 'x-total': '9' },
        }),
      ),
      http.get(`${API}/users/alice/projects`, ({ request }) => {
        queries.user = new URL(request.url).searchParams;
        return HttpResponse.json([project({ permissions: { project_access: { access_level: 10 } } })]);
      }),
      http.get(`${API}/groups/grp/projects`, ({ request }) => {
        queries.group = new URL(request.url).searchParams;
        return HttpResponse.json([project()]);
      }),
    );
    const p = provider(undefined);
    expect(await p.getRepo(ref)).toMatchObject({ viewerPermission: 'maintain' });
    const forks = await p.listForks(ref);
    expect(forks).toMatchObject({ nextCursor: '3', total: 9 });
    expect(forks.items[0]).toMatchObject({ fullName: 'dave/app', defaultBranch: 'main' });
    const mine = await p.listRepos({ owner: 'ALICE', query: 'ap', pageSize: 500 });
    expect(mine.items[0]!.viewerPermission).toBe('read');
    expect(queries.user!.get('search')).toBe('ap');
    expect(queries.user!.get('per_page')).toBe('100');
    await p.listRepos({ owner: 'grp' });
    expect(queries.group!.get('include_subgroups')).toBe('true');
  });

  it('getViewer, granted scopes (PAT, oauth fallback string + array, total failure)', async () => {
    server.use(
      http.get(`${API}/user`, () =>
        HttpResponse.json({ ...user(100, 'alice'), email: '', public_email: 'a@x.io' }),
      ),
      http.get(`${API}/personal_access_tokens/self`, () =>
        HttpResponse.json({ scopes: ['api', 'read_user'] }),
      ),
    );
    expect(await provider().getViewer()).toMatchObject({ id: '100', login: 'alice', email: 'a@x.io' });
    expect(await provider().getGrantedScopes()).toEqual(['api', 'read_user']);

    server.use(
      http.get(`${API}/personal_access_tokens/self`, () => err(401)),
      http.get('https://gitlab.com/oauth/token/info', () =>
        HttpResponse.json({ scope: 'api  read_repository' }),
      ),
    );
    expect(await provider().getGrantedScopes()).toEqual(['api', 'read_repository']);

    server.use(http.get('https://gitlab.com/oauth/token/info', () => HttpResponse.json({ scopes: ['api'] })));
    expect(await provider().getGrantedScopes()).toEqual(['api']);

    server.use(http.get('https://gitlab.com/oauth/token/info', () => HttpResponse.json({})));
    expect(await provider().getGrantedScopes()).toEqual([]);

    server.use(http.get('https://gitlab.com/oauth/token/info', () => err(401)));
    expect(await provider().getGrantedScopes()).toEqual([]);

    server.use(http.get(`${API}/personal_access_tokens/self`, () => HttpResponse.json({})));
    expect(await provider().getGrantedScopes()).toEqual([]);
  });

  it('viewer failures are not cached', async () => {
    let n = 0;
    server.use(http.get(`${API}/user`, () => (++n === 1 ? err(500) : HttpResponse.json(user(100, 'alice')))));
    const p = provider();
    await expect(p.getViewer()).rejects.toMatchObject({ code: 'server' });
    await expect(p.getViewer()).resolves.toMatchObject({ login: 'alice' });
  });
});

// ---------------------------------------------------------------- merge requests

describe('GitLab provider: merge request mutations', () => {
  it('setDraft adds/removes the Draft: prefix', async () => {
    const { calls, record } = recorder();
    let title = 'WIP: Add login';
    server.use(
      http.get(`${API}/projects/${PID}/merge_requests/1`, () => HttpResponse.json(mr({ title }))),
      http.put(`${API}/projects/${PID}/merge_requests/1`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(mr());
      }),
    );
    const p = provider();
    await p.setDraft!(ref, 1, true);
    title = 'Draft: Add login';
    await p.setDraft!(ref, 1, false);
    expect(calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['PUT', `/api/v4/projects/${PID}/merge_requests/1`, { title: 'Draft: Add login' }],
      ['PUT', `/api/v4/projects/${PID}/merge_requests/1`, { title: 'Add login' }],
    ]);
  });

  it('setDraft propagates a 404', async () => {
    server.use(http.get(`${API}/projects/${PID}/merge_requests/9`, () => err(404)));
    await expect(provider().setDraft!(ref, 9, true)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('setThreadResolved PUTs resolved=false and validates the id', async () => {
    const { calls, record } = recorder();
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/7/discussions/abc%2Fdef`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: 'abc/def', notes: [] });
      }),
    );
    const p = provider();
    await p.setThreadResolved!(ref, '7:abc/def', false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url.searchParams.get('resolved')).toBe('false');
    expect(calls[0]!.body).toBeUndefined();
    await expect(p.setThreadResolved!(ref, 'no-iid', true)).rejects.toMatchObject({ code: 'validation' });
    server.use(http.put(`${API}/projects/${PID}/merge_requests/7/discussions/:d`, () => err(403)));
    await expect(p.setThreadResolved!(ref, '7:x', true)).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('setAutoMerge enables (squash / merge) and cancels', async () => {
    const { calls, record } = recorder();
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/1/merge`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(mr());
      }),
      http.post(
        `${API}/projects/${PID}/merge_requests/1/cancel_merge_when_pipeline_succeeds`,
        async ({ request }) => {
          await record(request);
          return HttpResponse.json(mr());
        },
      ),
    );
    const p = provider();
    await p.setAutoMerge!(ref, 1, 'squash');
    await p.setAutoMerge!(ref, 1, 'merge');
    await p.setAutoMerge!(ref, 1, null);
    expect(calls.map((c) => [c.method, c.url.pathname.split('/').pop(), c.body])).toEqual([
      ['PUT', 'merge', { merge_when_pipeline_succeeds: true, auto_merge: true, squash: true }],
      ['PUT', 'merge', { merge_when_pipeline_succeeds: true, auto_merge: true, squash: false }],
      ['POST', 'cancel_merge_when_pipeline_succeeds', undefined],
    ]);
  });

  it('setAutoMerge maps 405 to a server error', async () => {
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/1/merge`, () => err(405, 'Method Not Allowed')),
    );
    await expect(provider().setAutoMerge!(ref, 1, 'merge')).rejects.toMatchObject({ code: 'server' });
  });

  it('close / reopen send state_event', async () => {
    const { calls, record } = recorder();
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/1`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(mr());
      }),
    );
    const p = provider();
    await p.reopen!(ref, 1);
    await p.close(ref, 1);
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ['PUT', { state_event: 'reopen' }],
      ['PUT', { state_event: 'close' }],
    ]);
    server.use(http.put(`${API}/projects/${PID}/merge_requests/1`, () => err(404)));
    await expect(p.reopen!(ref, 1)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('merge with merge commit message; not merged returns status message', async () => {
    const { calls, record } = recorder();
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/1/merge`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(mr({ state: 'opened', detailed_merge_status: 'ci_still_running' }));
      }),
    );
    const r = await provider().merge(ref, 1, {
      method: 'merge',
      title: 'T',
      message: 'M',
      expectedHeadSha: 'h',
    });
    expect(calls[0]!.body).toEqual({ sha: 'h', squash: false, merge_commit_message: 'T\n\nM' });
    expect(r).toEqual({ merged: false, sha: undefined, message: 'ci_still_running' });
    await expect(
      provider().merge(ref, 1, { method: 'rebase-merge', expectedHeadSha: 'h' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('updatePullRequest builds the full body and resolves users', async () => {
    const { calls, record } = recorder();
    server.use(
      ...baseHandlers(),
      http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
        HttpResponse.json(mr({ title: 'Old', draft: undefined, work_in_progress: true })),
      ),
      http.get(`${API}/users`, ({ request }) => {
        const u = new URL(request.url).searchParams.get('username');
        return HttpResponse.json(u === 'bob' ? [user(101, 'bob')] : []);
      }),
      http.put(`${API}/projects/${PID}/merge_requests/1`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(mr());
      }),
    );
    const p = provider();
    const pr = await p.updatePullRequest(ref, 1, {
      title: 'New',
      body: 'B',
      baseBranch: 'dev',
      state: 'closed',
      labels: ['x', 'y'],
      milestone: '7',
      assignees: ['@bob', '55'],
      reviewers: [],
    });
    expect(calls[0]!.body).toEqual({
      title: 'Draft: New',
      description: 'B',
      target_branch: 'dev',
      state_event: 'close',
      labels: 'x,y',
      milestone_id: 7,
      assignee_ids: [101, 55],
      reviewer_ids: [0],
    });
    expect(pr.number).toBe(1);

    await p.updatePullRequest(ref, 1, { state: 'open', milestone: '', assignees: [] });
    expect(calls[1]!.body).toEqual({ state_event: 'reopen', milestone_id: 0, assignee_ids: [0] });

    // empty patch: no PUT, just refetch
    await p.updatePullRequest(ref, 1, {});
    expect(calls).toHaveLength(2);

    await expect(p.updatePullRequest(ref, 1, { reviewers: ['ghost'] })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('createPullRequest with numeric base id + assignees + milestone', async () => {
    const { calls, record } = recorder();
    server.use(
      ...baseHandlers(),
      http.post(`${API}/projects/${PID}/merge_requests`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(mr({ iid: 3 }), { status: 201 });
      }),
      http.get(`${API}/projects/${PID}/merge_requests/3`, () => HttpResponse.json(mr({ iid: 3 }))),
    );
    const pr = await provider().createPullRequest({
      base: { ...ref, id: '1' },
      baseBranch: 'main',
      head: ref,
      headBranch: 'feat',
      title: 'Draft: T',
      body: 'B',
      assignees: ['100'],
      milestone: '77',
    });
    expect(calls[0]!.body).toMatchObject({
      target_project_id: 1,
      title: 'T',
      assignee_ids: [100],
      milestone_id: 77,
    });
    expect(pr.number).toBe(3);
  });

  it('createPullRequest fails when the base project is missing; getProject errors are not cached', async () => {
    let n = 0;
    server.use(http.get(`${API}/projects/${PID}`, () => (++n === 1 ? err(500) : err(404))));
    const p = provider();
    const input = { base: ref, baseBranch: 'main', head: ref, headBranch: 'f', title: 'T', body: '' };
    await expect(p.createPullRequest(input)).rejects.toMatchObject({ code: 'server' });
    await expect(p.createPullRequest(input)).rejects.toMatchObject({
      code: 'not_found',
      message: 'Project grp/sub/app not found.',
    });
  });

  it('addComment: top-level note and reply to a discussion', async () => {
    const { calls, record } = recorder();
    const note = { id: 77, body: 'hi', author: user(100, 'alice'), created_at: 'c', system: false };
    server.use(
      http.post(`${API}/projects/${PID}/merge_requests/1/notes`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(note, { status: 201 });
      }),
      http.post(`${API}/projects/${PID}/merge_requests/1/discussions/d9/notes`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ...note, id: 78 }, { status: 201 });
      }),
    );
    const p = provider();
    expect(await p.addComment(ref, 1, 'hi')).toEqual({
      kind: 'comment',
      id: '77',
      author: expect.objectContaining({ login: 'alice' }),
      body: 'hi',
      createdAt: 'c',
      editable: true,
    });
    expect(await p.addComment(ref, 1, 'hi', '1:d9')).toMatchObject({ id: '78' });
    expect(calls.map((c) => c.body)).toEqual([{ body: 'hi' }, { body: 'hi' }]);
  });

  it('submitReview: inline comments, summary, approve / request changes; conflict paths', async () => {
    const { calls, record } = recorder();
    let diffRefs: unknown = { base_sha: 'b', head_sha: 'h', start_sha: 's' };
    server.use(
      http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
        HttpResponse.json(mr({ diff_refs: diffRefs })),
      ),
      http.post(`${API}/projects/${PID}/merge_requests/1/:what`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const p = provider();
    await p.submitReview(ref, 1, {
      event: 'APPROVE',
      commitSha: 'h',
      body: ' Looks good ',
      comments: [
        { path: 'a.ts', line: 3, side: 'RIGHT', body: 'r' },
        { path: 'a.ts', line: 2, side: 'LEFT', body: 'l' },
      ],
    });
    expect(calls.map((c) => [c.url.pathname.split('/').pop(), c.body])).toEqual([
      [
        'discussions',
        {
          body: 'r',
          position: {
            position_type: 'text',
            base_sha: 'b',
            start_sha: 's',
            head_sha: 'h',
            new_path: 'a.ts',
            old_path: 'a.ts',
            new_line: 3,
          },
        },
      ],
      ['discussions', expect.objectContaining({ position: expect.objectContaining({ old_line: 2 }) })],
      ['notes', { body: 'Looks good' }],
      ['approve', { sha: 'h' }],
    ]);
    calls.length = 0;
    await p.submitReview(ref, 1, { event: 'REQUEST_CHANGES', commitSha: 'h' });
    expect(calls.map((c) => c.body)).toEqual([{ body: 'Requested changes.' }]);
    calls.length = 0;
    await p.submitReview(ref, 1, { event: 'COMMENT', commitSha: 'h', body: 'x' });
    expect(calls.map((c) => c.body)).toEqual([{ body: 'x' }]);

    const c = [{ path: 'a', line: 1, side: 'RIGHT' as const, body: 'z' }];
    await expect(
      p.submitReview(ref, 1, { event: 'COMMENT', commitSha: 'other', comments: c }),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('updated') });
    diffRefs = null;
    await expect(
      p.submitReview(ref, 1, { event: 'COMMENT', commitSha: 'h', comments: c }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('not available'),
    });
  });

  it('listMilestones (active, paginated) and labels', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/projects/${PID}/milestones`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        queries.push(q);
        return q.get('page') === '2'
          ? HttpResponse.json([{ id: 3, title: 'v3' }])
          : HttpResponse.json(
              [
                { id: 1, title: 'v1' },
                { id: 2, title: 'v2' },
              ],
              { headers: { 'x-next-page': '2' } },
            );
      }),
      http.get(`${API}/projects/${PID}/labels`, () =>
        HttpResponse.json([{ name: 'bug', color: '#f00' }, { name: 'docs' }]),
      ),
    );
    const p = provider();
    expect(await p.listMilestones!(ref)).toEqual([
      { id: '1', title: 'v1' },
      { id: '2', title: 'v2' },
      { id: '3', title: 'v3' },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0]!.get('state')).toBe('active');
    expect(queries[0]!.get('per_page')).toBe('100');
    expect(await p.listLabels(ref)).toEqual([
      { name: 'bug', color: '#f00' },
      { name: 'docs', color: undefined },
    ]);
    server.use(http.get(`${API}/projects/${PID}/milestones`, () => err(403)));
    await expect(p.listMilestones!(ref)).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('searchUsers', async () => {
    let q: URLSearchParams | undefined;
    server.use(
      http.get(`${API}/projects/${PID}/users`, ({ request }) => {
        q = new URL(request.url).searchParams;
        return HttpResponse.json([user(101, 'bob')]);
      }),
    );
    expect(await provider().searchUsers(ref, '')).toEqual([
      { id: '101', login: 'bob', name: 'BOB', avatarUrl: 'https://a/bob', email: undefined },
    ]);
    expect(q!.has('search')).toBe(false);
  });

  it('listPrTemplates: missing dir → [], other errors rethrown, JSON raw bodies', async () => {
    server.use(http.get(`${API}/projects/${PID}/repository/tree`, () => err(404)));
    expect(await provider().listPrTemplates(ref, 'main')).toEqual([]);
    server.use(http.get(`${API}/projects/${PID}/repository/tree`, () => err(500)));
    await expect(provider().listPrTemplates(ref, 'main')).rejects.toMatchObject({ code: 'server' });
    server.use(
      http.get(`${API}/projects/${PID}/repository/tree`, () =>
        HttpResponse.json([
          { name: 'A.md', path: 'd/A.md', type: 'blob' },
          { name: 'sub', path: 'd/sub', type: 'tree' },
        ]),
      ),
      http.get(`${API}/projects/${PID}/repository/files/:path/raw`, () => HttpResponse.json({ x: 1 })),
    );
    expect(await provider().listPrTemplates(ref, 'main')).toEqual([
      { name: 'A', path: 'd/A.md', body: '{"x":1}' },
    ]);
  });
});

// ---------------------------------------------------------------- listing / normalize

describe('GitLab provider: listing + normalization branches', () => {
  it('listPullRequests tolerates a failing viewer lookup', async () => {
    server.use(
      http.get(`${API}/user`, () => err(500)),
      http.get(`${API}/projects/${PID}`, () => HttpResponse.json(project())),
      http.get(`${API}/projects/${PID}/merge_requests`, () => HttpResponse.json([mr()])),
    );
    const page = await provider().listPullRequests(ref, {});
    expect(page.items[0]!.viewer).toMatchObject({ isAuthor: false, reviewRequested: false });
    expect(page.nextCursor).toBeUndefined();
  });

  it('listPullRequests review-requested / assigned presets and closed state', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      ...baseHandlers(),
      http.get(`${API}/projects/${PID}/merge_requests`, ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json([
          mr({
            state: 'closed',
            labels: ['plain'],
            head_pipeline: { id: 1, status: 'running' },
            merge_status: 'checking',
            detailed_merge_status: undefined,
            changes_count: null,
          }),
          mr({
            iid: 2,
            source_project_id: null,
            detailed_merge_status: 'ci_must_pass',
            reviewers: undefined,
          }),
        ]);
      }),
    );
    const p = provider();
    const page = await p.listPullRequests(ref, { preset: 'review-requested', state: 'all' });
    expect(queries[0]!.get('reviewer_username')).toBe('alice');
    expect(queries[0]!.get('scope')).toBe('all');
    expect(queries[0]!.get('state')).toBe('all');
    const [closed, deleted] = page.items as [PullRequest, PullRequest];
    expect(closed).toMatchObject({
      state: 'closed',
      labels: [{ name: 'plain' }],
      checksRollup: 'pending',
      mergeable: 'unknown',
      changedFiles: undefined,
    });
    expect(deleted.head.repo).toBeNull();
    expect(deleted.checksRollup).toBe('failure');
    await p.listPullRequests(ref, { preset: 'assigned' });
    expect(queries[1]!.get('scope')).toBe('assigned_to_me');
  });

  it('getPullRequest: pipeline statuses, approvals_left, merge methods, failing viewer/approvals', async () => {
    const cases: Array<[unknown, string]> = [
      [{ id: 1, status: 'success' }, 'success'],
      [{ id: 1, status: 'canceled' }, 'failure'],
      [{ id: 1, status: 'skipped' }, 'none'],
      [null, 'none'],
    ];
    for (const [pipeline, rollup] of cases) {
      server.use(
        http.get(`${API}/user`, () => err(500)),
        http.get(`${API}/projects/${PID}`, () =>
          HttpResponse.json(project({ merge_method: 'rebase_merge', squash_option: 'never' })),
        ),
        http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
          HttpResponse.json(mr({ head_pipeline: pipeline, title: '[WIP] x', draft: undefined })),
        ),
        http.get(`${API}/projects/${PID}/merge_requests/1/approvals`, () =>
          HttpResponse.json({ approvals_left: 2, user_can_approve: true }),
        ),
      );
      const pr = (await provider().getPullRequest(ref, 1)) as PullRequest;
      expect(pr.checksRollup).toBe(rollup);
      expect(pr.reviewDecision).toBe('review_required');
      expect(pr.allowedMergeMethods).toEqual(['semi-linear']);
      expect(pr.state).toBe('draft');
      expect(pr.viewer).toMatchObject({ isAuthor: false, reviewRequested: false, canApprove: true });
    }
    server.use(
      http.get(`${API}/projects/${PID}/merge_requests/1/approvals`, () => err(403)),
      http.get(`${API}/projects/${PID}`, () => HttpResponse.json(project({ merge_method: 'merge' }))),
      ...baseHandlers(),
      http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
        HttpResponse.json(mr({ source_project_id: 2, reviewers: [user(100, 'alice')] })),
      ),
    );
    const pr = (await provider().getPullRequest(ref, 1)) as PullRequest;
    expect(pr.allowedMergeMethods).toEqual(['merge', 'squash']);
    expect(pr.viewer.reviewRequested).toBe(true);
    expect(pr.head.repo).toMatchObject({ owner: 'dave' });
  });

  it('getPullRequest without a base project falls back to merge/squash', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/projects/${PID}`, () => err(404)),
      http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
        HttpResponse.json(mr({ user: undefined, approvals: undefined })),
      ),
      http.get(`${API}/projects/${PID}/merge_requests/1/approvals`, () =>
        HttpResponse.json({ approved_by: [{ user: user(101, 'bob') }] }),
      ),
    );
    const pr = (await provider().getPullRequest(ref, 1)) as PullRequest;
    expect(pr.allowedMergeMethods).toEqual(['merge', 'squash']);
    expect(pr.head.repoCloneUrl).toBeUndefined();
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.viewer.canMerge).toBe(false);
  });

  it('searchMyPullRequests merges roles and filters by repo', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      ...baseHandlers(),
      http.get(`${API}/merge_requests`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        queries.push(q);
        if (q.get('scope') === 'created_by_me')
          return HttpResponse.json([mr({ references: { full: 'grp/sub/app!1' } })]);
        if (q.get('reviewer_id') === '100')
          return HttpResponse.json([
            mr({ references: { full: 'grp/sub/app!1' } }),
            mr({
              id: 6000,
              iid: 9,
              web_url: 'https://gitlab.com/other/repo/-/merge_requests/9',
              source_project_id: 2,
            }),
          ]);
        return HttpResponse.json([]);
      }),
    );
    const all = await provider().searchMyPullRequests!({ limit: 500 });
    expect(queries.every((q) => q.get('per_page') === '100' && q.get('state') === 'opened')).toBe(true);
    expect(all.map((r) => [r.pr.id, r.involvement])).toEqual([
      ['5001', ['author', 'reviewer']],
      ['6000', ['reviewer']],
    ]);
    expect(all[1]!.pr.repo).toMatchObject({ owner: 'other', name: 'repo', id: '1' });
    expect(all[1]!.pr.head.repo).toMatchObject({ owner: 'dave' });
    const filtered = await provider().searchMyPullRequests!({ repos: [{ owner: 'GRP/sub', name: 'App' }] });
    expect(filtered.map((r) => r.pr.id)).toEqual(['5001']);
  });

  it('getTimeline: system events, thread without position, unresolved, empty discussions', async () => {
    const n = (id: number, body: string, system = true, extra: Record<string, unknown> = {}) => ({
      id,
      body,
      author: user(101, 'bob'),
      created_at: 't',
      system,
      ...extra,
    });
    server.use(
      http.get(`${API}/user`, () => err(500)),
      http.get(`${API}/projects/${PID}/merge_requests/1`, () => HttpResponse.json(mr({ diff_refs: null }))),
      http.get(`${API}/projects/${PID}/merge_requests/1/discussions`, () =>
        HttpResponse.json(
          [
            { id: 'e', individual_note: true, notes: [] },
            {
              id: 's',
              individual_note: false,
              notes: [n(1, 'requested changes'), n(2, 'something odd'), n(3, 'merged'), n(4, 'mine', false)],
            },
            {
              id: 't1',
              individual_note: false,
              notes: [
                n(5, 'general', false, { resolvable: true, resolved: false }),
                n(6, 'resolved', false, { resolvable: true, resolved: true }),
              ],
            },
            {
              id: 't2',
              individual_note: false,
              notes: [
                n(7, 'left', false, {
                  position: {
                    new_path: null,
                    old_path: 'old.ts',
                    new_line: null,
                    old_line: 4,
                    head_sha: 'head1',
                  },
                }),
              ],
            },
          ],
          { headers: { 'x-next-page': '2' } },
        ),
      ),
    );
    const t = await provider().getTimeline(ref, 1);
    expect(t.nextCursor).toBe('2');
    expect(t.items).toEqual([
      expect.objectContaining({ kind: 'review', state: 'changes_requested' }),
      expect.objectContaining({ kind: 'event', event: 'system', detail: 'something odd' }),
      expect.objectContaining({ kind: 'event', event: 'merged' }),
      expect.objectContaining({ kind: 'comment', id: '4', editable: false }),
      expect.objectContaining({
        kind: 'thread',
        id: '1:t1',
        path: '',
        line: undefined,
        side: undefined,
        resolved: false,
        outdated: false,
      }),
      expect.objectContaining({
        kind: 'thread',
        id: '1:t2',
        path: 'old.ts',
        line: 4,
        side: 'LEFT',
        resolved: false,
      }),
    ]);
  });

  it('getChecks falls back to the commit status API', async () => {
    server.use(
      http.get(`${API}/projects/${PID}/pipelines`, () => HttpResponse.json([])),
      http.get(`${API}/projects/${PID}/repository/commits/abc/statuses`, () =>
        HttpResponse.json([
          {
            id: 1,
            name: 'ext',
            status: 'canceled',
            started_at: 's',
            finished_at: 'f',
            target_url: 'https://ci/1',
          },
          { id: 2, name: 'ext2', status: 'skipped', started_at: null, target_url: null },
          { id: 3, name: 'ext3', status: 'pending' },
          { id: 4, name: 'ext4', status: 'failed' },
        ]),
      ),
    );
    expect(await provider().getChecks(ref, 'abc')).toEqual([
      {
        id: 'status:1',
        name: 'ext',
        status: 'cancelled',
        startedAt: 's',
        completedAt: 'f',
        detailsUrl: 'https://ci/1',
        canRerun: false,
        provider: 'status-api',
      },
      expect.objectContaining({
        id: 'status:2',
        status: 'skipped',
        startedAt: undefined,
        detailsUrl: undefined,
      }),
      expect.objectContaining({ id: 'status:3', status: 'queued' }),
      expect.objectContaining({ id: 'status:4', status: 'failure' }),
    ]);
  });

  it('SSH keys upload + list with fingerprints', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/user/keys`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 5 }, { status: 201 });
      }),
      http.get(`${API}/user/keys`, () =>
        HttpResponse.json([
          { id: 5, title: 'laptop', key: 'ssh-ed25519 AAAA' },
          { id: 6, title: 'bad', key: 'garbage' },
        ]),
      ),
    );
    const p = provider();
    expect(await p.uploadSshKey!('laptop', '  ssh-ed25519 AAAA \n')).toEqual({ id: '5' });
    expect(body).toEqual({ title: 'laptop', key: 'ssh-ed25519 AAAA' });
    const keys = await p.listSshKeys!();
    expect(keys[0]).toMatchObject({
      id: '5',
      title: 'laptop',
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
    expect(keys[1]).toEqual({ id: '6', title: 'bad', fingerprint: undefined });
  });
});

// ---------------------------------------------------------------- CI

describe('GitLab provider: CI', () => {
  it('listCiRuns normalizes pipelines and forwards branch + cursor', async () => {
    let q: URLSearchParams | undefined;
    server.use(
      http.get(`${API}/projects/${PID}/pipelines`, ({ request }) => {
        q = new URL(request.url).searchParams;
        return HttpResponse.json(
          [
            {
              id: 900,
              iid: 12,
              status: 'success',
              ref: 'main',
              sha: 'abc',
              source: 'push',
              web_url: 'https://gitlab.com/grp/sub/app/-/pipelines/900',
              created_at: 'c1',
              updated_at: 'u1',
              user: user(100, 'alice'),
            },
            { id: 901, status: 'running', created_at: 'c2', updated_at: 'u2' },
          ],
          { headers: { 'x-next-page': '3', 'x-total': '40' } },
        );
      }),
    );
    const res = await provider().listCiRuns!(ref, { branch: 'main', cursor: '2' });
    expect(q!.get('ref')).toBe('main');
    expect(q!.get('page')).toBe('2');
    expect(q!.get('per_page')).toBe('30');
    expect(res.nextCursor).toBe('3');
    expect(res.total).toBe(40);
    expect(res.items).toEqual([
      {
        id: '900',
        name: 'Pipeline #12',
        group: 'push',
        status: 'success',
        startedAt: 'c1',
        completedAt: 'u1',
        detailsUrl: 'https://gitlab.com/grp/sub/app/-/pipelines/900',
        canRerun: true,
        provider: 'gitlab-ci',
        runNumber: 12,
        branch: 'main',
        event: 'push',
        actor: expect.objectContaining({ id: '100', login: 'alice' }),
      },
      expect.objectContaining({
        id: '901',
        name: 'Pipeline #901',
        status: 'in_progress',
        completedAt: undefined,
        canRerun: false,
        runNumber: 901,
        actor: undefined,
      }),
    ]);
  });

  it('listCiRuns error', async () => {
    server.use(http.get(`${API}/projects/${PID}/pipelines`, () => err(404)));
    await expect(provider().listCiRuns!(ref, {})).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rerunCi / cancelCi POST to retry / cancel', async () => {
    const { calls, record } = recorder();
    server.use(
      http.post(`${API}/projects/${PID}/pipelines/900/:action`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: 900, status: 'pending' }, { status: 201 });
      }),
    );
    const p = provider();
    await p.rerunCi!(ref, '900');
    await p.cancelCi!(ref, '900');
    expect(calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['POST', `/api/v4/projects/${PID}/pipelines/900/retry`, undefined],
      ['POST', `/api/v4/projects/${PID}/pipelines/900/cancel`, undefined],
    ]);
  });

  it('rerunCi / cancelCi errors', async () => {
    server.use(
      http.post(`${API}/projects/${PID}/pipelines/1/retry`, () => err(403)),
      http.post(`${API}/projects/${PID}/pipelines/1/cancel`, () => err(404)),
    );
    await expect(provider().rerunCi!(ref, '1')).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(provider().cancelCi!(ref, '1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ---------------------------------------------------------------- issues

describe('GitLab issue tracker: mutations', () => {
  it('createIssue resolves users and normalizes the result', async () => {
    const { calls, record } = recorder();
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/users`, () => HttpResponse.json([user(101, 'bob')])),
      http.post(`${API}/projects/${PID}/issues`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(issue({ labels: ['bug', 'workflow::in progress'] }), { status: 201 });
      }),
    );
    const t = tracker(undefined);
    const i = await t.createIssue!('grp/sub/app', {
      title: 'Crash',
      body: 'It crashes',
      assignees: ['@bob', '7'],
      labels: ['bug', 'workflow::in progress'],
      type: 'incident',
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe(`/api/v4/projects/${PID}/issues`);
    expect(calls[0]!.body).toEqual({
      title: 'Crash',
      description: 'It crashes',
      assignee_ids: [101, 7],
      labels: 'bug,workflow::in progress',
      issue_type: 'incident',
    });
    expect(i).toEqual({
      tracker: {
        kind: 'gitlab',
        integration: { kind: 'gitlab', host: 'gitlab.com', accountId: '100' },
        scope: 'grp/sub/app',
      },
      key: '#12',
      id: '9001',
      title: 'Crash',
      body: 'It crashes',
      bodyFormat: 'markdown',
      state: 'opened',
      stateCategory: 'in_progress',
      type: 'issue',
      assignees: [expect.objectContaining({ login: 'alice' })],
      reporter: expect.objectContaining({ login: 'bob' }),
      labels: ['bug', 'workflow::in progress'],
      milestone: 'v1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      webUrl: 'https://gitlab.com/grp/sub/app/-/issues/12',
      commentsCount: 4,
    });
  });

  it('createIssue: minimal input, unknown user, invalid scope, 403', async () => {
    const { calls, record } = recorder();
    server.use(
      http.get(`${API}/users`, () => HttpResponse.json([])),
      http.post(`${API}/projects/${PID}/issues`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(
          issue({
            description: null,
            labels: undefined,
            assignees: undefined,
            author: undefined,
            milestone: null,
            references: undefined,
          }),
          { status: 201 },
        );
      }),
    );
    const t = tracker();
    const i = await t.createIssue!('grp/sub/app', { title: 'T' });
    expect(calls[0]!.body).toEqual({ title: 'T' });
    expect(i).toMatchObject({
      body: '',
      labels: [],
      assignees: [],
      reporter: undefined,
      milestone: undefined,
      stateCategory: 'todo',
      tracker: { scope: 'grp/sub/app' },
    });
    await expect(t.createIssue!('grp/sub/app', { title: 'T', assignees: ['ghost'] })).rejects.toMatchObject({
      code: 'validation',
      message: "GitLab user 'ghost' not found.",
    });
    await expect(t.createIssue!('noslash', { title: 'T' })).rejects.toMatchObject({ code: 'validation' });
    server.use(http.post(`${API}/projects/${PID}/issues`, () => err(403)));
    await expect(t.createIssue!('grp/sub/app', { title: 'T' })).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('updateIssue builds a sparse body; empty assignees → [0]', async () => {
    const { calls, record } = recorder();
    server.use(
      http.put(`${API}/projects/${PID}/issues/12`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(issue({ title: 'New', state: 'closed' }));
      }),
    );
    const t = tracker();
    const i = await t.updateIssue!('grp/sub/app', '#12', {
      title: 'New',
      body: 'B',
      labels: ['a', 'b'],
      assignees: ['5'],
    });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url.pathname).toBe(`/api/v4/projects/${PID}/issues/12`);
    expect(calls[0]!.body).toEqual({ title: 'New', description: 'B', labels: 'a,b', assignee_ids: [5] });
    expect(i).toMatchObject({ key: '#12', title: 'New', state: 'closed', stateCategory: 'done' });
    await t.updateIssue!('grp/sub/app', '12', { assignees: [] });
    expect(calls[1]!.body).toEqual({ assignee_ids: [0] });
    await t.updateIssue!('grp/sub/app', '12', {});
    expect(calls[2]!.body).toEqual({});
    server.use(http.put(`${API}/projects/${PID}/issues/12`, () => err(422, 'title is too long')));
    await expect(t.updateIssue!('grp/sub/app', '12', { title: 'x' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('listTransitions depends on the issue state', async () => {
    let state = 'opened';
    server.use(http.get(`${API}/projects/${PID}/issues/12`, () => HttpResponse.json(issue({ state }))));
    const t = tracker();
    expect(await t.listTransitions!('grp/sub/app', '#12')).toEqual([
      { id: 'close', name: 'Close', toCategory: 'done' },
    ]);
    state = 'closed';
    expect(await t.listTransitions!('grp/sub/app', '#12')).toEqual([
      { id: 'reopen', name: 'Reopen', toCategory: 'todo' },
    ]);
    server.use(http.get(`${API}/projects/${PID}/issues/99`, () => err(404)));
    await expect(t.listTransitions!('grp/sub/app', '#99')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('transition sends state_event and rejects unknown ids', async () => {
    const { calls, record } = recorder();
    server.use(
      http.put(`${API}/projects/${PID}/issues/12`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(issue());
      }),
    );
    const t = tracker();
    await t.transition!('grp/sub/app', '#12', 'close');
    await t.transition!('grp/sub/app', '#12', 'reopen');
    expect(calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['PUT', `/api/v4/projects/${PID}/issues/12`, { state_event: 'close' }],
      ['PUT', `/api/v4/projects/${PID}/issues/12`, { state_event: 'reopen' }],
    ]);
    await expect(t.transition!('grp/sub/app', '#12', 'done')).rejects.toMatchObject({ code: 'validation' });
    expect(calls).toHaveLength(2);
    server.use(http.put(`${API}/projects/${PID}/issues/12`, () => err(403)));
    await expect(t.transition!('grp/sub/app', '#12', 'close')).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('addComment posts a note', async () => {
    const { calls, record } = recorder();
    server.use(
      http.post(`${API}/projects/${PID}/issues/12/notes`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: 1, body: 'hello' }, { status: 201 });
      }),
    );
    await tracker().addComment!('grp/sub/app', '#12', 'hello');
    expect(calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['POST', `/api/v4/projects/${PID}/issues/12/notes`, { body: 'hello' }],
    ]);
    server.use(http.post(`${API}/projects/${PID}/issues/12/notes`, () => err(404)));
    await expect(tracker().addComment!('grp/sub/app', '#12', 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('listComments paginates and drops system notes', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/projects/${PID}/issues/12/notes`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        queries.push(q);
        return q.get('page') === '2'
          ? HttpResponse.json([
              { id: 3, body: 'third', created_at: 'c3', author: user(100, 'alice'), system: false },
            ])
          : HttpResponse.json(
              [
                { id: 1, body: 'first', created_at: 'c1', author: user(101, 'bob'), system: false },
                {
                  id: 2,
                  body: 'changed the description',
                  created_at: 'c2',
                  author: user(101, 'bob'),
                  system: true,
                },
              ],
              { headers: { 'x-next-page': '2' } },
            );
      }),
    );
    const out = await tracker().listComments!('grp/sub/app', '#12');
    expect(queries[0]!.get('sort')).toBe('asc');
    expect(queries[0]!.get('order_by')).toBe('created_at');
    expect(queries[0]!.has('page')).toBe(false);
    expect(out).toEqual([
      { id: '1', author: expect.objectContaining({ login: 'bob' }), body: 'first', createdAt: 'c1' },
      { id: '3', author: expect.objectContaining({ login: 'alice' }), body: 'third', createdAt: 'c3' },
    ]);
    server.use(http.get(`${API}/projects/${PID}/issues/12/notes`, () => err(401)));
    await expect(tracker().listComments!('grp/sub/app', '#12')).rejects.toMatchObject({
      code: 'auth_required',
    });
  });
});

describe('GitLab issue tracker: listing', () => {
  it('listScopes paginates projects', async () => {
    server.use(
      http.get(`${API}/projects`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('with_issues_enabled')).toBe('true');
        return q.get('page') === '2'
          ? HttpResponse.json([project({ path_with_namespace: 'grp/two' })])
          : HttpResponse.json([project()], { headers: { 'x-next-page': '2' } });
      }),
    );
    expect(await tracker().listScopes()).toEqual([
      { scope: 'grp/sub/app', label: 'grp/sub/app' },
      { scope: 'grp/two', label: 'grp/two' },
    ]);
  });

  it('listIssues: global scope, mentioned / created / query-only presets', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/issues`, ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json([issue({ references: { full: 'other/proj#12' } })]);
      }),
    );
    const t = tracker(undefined);
    const p1 = await t.listIssues(
      '*',
      { preset: 'mentioned', query: 'boom', updatedSince: '2026-01-01' },
      '4',
    );
    expect(queries[0]!.get('search')).toBe('@alice boom');
    expect(queries[0]!.get('scope')).toBe('all');
    expect(queries[0]!.get('updated_after')).toBe('2026-01-01');
    expect(queries[0]!.get('page')).toBe('4');
    expect(p1).toMatchObject({ nextCursor: undefined, total: undefined });
    expect(p1.items[0]!.tracker).toMatchObject({ scope: 'other/proj', integration: { accountId: '100' } });
    await t.listIssues('', { preset: 'created' });
    expect(queries[1]!.get('scope')).toBe('created_by_me');
    await t.listIssues('', { query: 'only' });
    expect(queries[2]!.get('scope')).toBe('all');
    expect(queries[2]!.has('state')).toBe(false);
    await t.listIssues('', {});
    expect(queries[3]!.get('scope')).toBe('assigned_to_me');
  });

  it('getIssue and searchMyIssues (roles merged, scope filter, includeCreated=false)', async () => {
    const scopes: string[] = [];
    server.use(
      http.get(`${API}/projects/${PID}/issues/12`, () => HttpResponse.json(issue())),
      http.get(`${API}/issues`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        scopes.push(q.get('scope')!);
        expect(q.get('per_page')).toBe('100');
        return q.get('scope') === 'assigned_to_me'
          ? HttpResponse.json([issue(), issue({ id: 2, iid: 3, references: { full: 'x/y#3' } })])
          : HttpResponse.json([issue()]);
      }),
    );
    const t = tracker();
    expect(await t.getIssue('grp/sub/app', '#12')).toMatchObject({ id: '9001', key: '#12' });
    const mine = await t.searchMyIssues!({ limit: 1000, scopes: ['GRP/sub/app'] });
    expect(mine.map((r) => [r.issue.id, r.involvement])).toEqual([['9001', ['assignee', 'creator']]]);
    scopes.length = 0;
    const onlyAssigned = await t.searchMyIssues!({ includeCreated: false, limit: 100 });
    expect(scopes).toEqual(['assigned_to_me']);
    expect(onlyAssigned).toHaveLength(2);
  });
});
