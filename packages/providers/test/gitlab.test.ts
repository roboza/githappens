import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGitLabIssueTracker } from '../src/gitlab/issues';
import { createGitLabProvider, matchGitLabRemoteUrl } from '../src/gitlab/provider';
import { HttpClient, type ProviderError } from '../src/http';
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
const provider = () => createGitLabProvider({ http: client(), host: 'gitlab.com', accountId: '100' });

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
  http.get(`${API}/projects/3`, () =>
    HttpResponse.json({ message: '404 Project Not Found' }, { status: 404 }),
  ),
];

describe('GitLab MR normalization', () => {
  it('lists MRs: open/draft/merged/fork/deleted fork + x-next-page pagination', async () => {
    let query: URLSearchParams | undefined;
    server.use(
      ...baseHandlers(),
      http.get(`${API}/projects/${PID}/merge_requests`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(
          [
            mr(),
            mr({ iid: 2, title: 'Draft: WIP thing', draft: true, detailed_merge_status: 'not_approved' }),
            mr({ iid: 3, state: 'merged', merged_at: '2026-01-03T00:00:00Z' }),
            mr({ iid: 4, source_project_id: 2, has_conflicts: true, detailed_merge_status: 'conflict' }),
            mr({ iid: 5, source_project_id: 3, detailed_merge_status: 'ci_still_running' }),
          ],
          { headers: { 'x-next-page': '2', 'x-total': '7' } },
        );
      }),
    );
    const page = await provider().listPullRequests(ref, { preset: 'mine' });
    expect(query?.get('state')).toBe('opened');
    expect(query?.get('scope')).toBe('created_by_me');
    expect(page.nextCursor).toBe('2');
    expect(page.total).toBe(7);
    const [open, draft, merged, fork, deleted] = page.items as [
      PullRequest,
      PullRequest,
      PullRequest,
      PullRequest,
      PullRequest,
    ];

    expect(open).toMatchObject({
      number: 1,
      id: '5001',
      state: 'open',
      labels: [{ name: 'bug', color: '#ff0000' }],
      milestone: { id: '77', title: 'v1' },
      mergeable: 'mergeable',
      checksRollup: 'none',
      rollup: 'success',
      changedFiles: 3,
      allowedMergeMethods: ['fast-forward', 'squash'],
      isCrossRepository: false,
      head: { branch: 'feature/login', sha: 'head1', repoCloneUrl: 'https://gitlab.com/grp/sub/app.git' },
      viewer: { isAuthor: true, canEdit: true, canMerge: true },
    });
    expect(open.head.repo).toMatchObject({ owner: 'grp/sub', name: 'app' });
    expect(open.reviewers).toEqual([{ user: expect.objectContaining({ login: 'bob' }), state: 'pending' }]);

    expect(draft.state).toBe('draft');
    expect(draft.title).toBe('WIP thing');
    expect(draft.reviewDecision).toBe('review_required');
    expect(draft.rollup).toBe('pending');

    expect(merged.state).toBe('merged');
    expect(merged.viewer.canMerge).toBe(false);

    expect(fork.isCrossRepository).toBe(true);
    expect(fork.head.repo).toMatchObject({ owner: 'dave', name: 'app', id: '2' });
    expect(fork.head.repoCloneUrl).toBe('https://gitlab.com/dave/app.git');
    expect(fork.mergeable).toBe('conflicting');
    expect(fork.rollup).toBe('failure');

    expect(deleted.head.repo).toBeNull();
    expect(deleted.checksRollup).toBe('pending');
  });

  it('getPullRequest uses head pipeline + approvals', async () => {
    server.use(
      ...baseHandlers(),
      http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
        HttpResponse.json(
          mr({
            head_pipeline: { id: 9, status: 'failed' },
            user: { can_merge: false },
            diff_refs: { base_sha: 'b', head_sha: 'head1', start_sha: 's' },
          }),
          {
            headers: { etag: 'W/"e1"' },
          },
        ),
      ),
      http.get(`${API}/projects/${PID}/merge_requests/1/approvals`, () =>
        HttpResponse.json({
          approved: true,
          approvals_required: 1,
          approvals_left: 0,
          approved_by: [{ user: user(101, 'bob') }, { user: user(102, 'carol') }],
          user_can_approve: false,
        }),
      ),
    );
    const pr = (await provider().getPullRequest(ref, 1)) as PullRequest;
    expect(pr.checksRollup).toBe('failure');
    expect(pr.rollup).toBe('failure');
    expect(pr.reviewDecision).toBe('approved');
    expect(pr.base.sha).toBe('b');
    expect(pr.etag).toBe('W/"e1"');
    expect(pr.viewer).toMatchObject({ canMerge: false, canApprove: false });
    expect(pr.reviewers).toEqual([
      { user: expect.objectContaining({ login: 'bob' }), state: 'approved' },
      { user: expect.objectContaining({ login: 'carol' }), state: 'approved' },
    ]);
  });

  it('returns not-modified on 304', async () => {
    server.use(
      http.get(`${API}/projects/${PID}/merge_requests/1`, () => new HttpResponse(null, { status: 304 })),
    );
    expect(await provider().getPullRequest(ref, 1, { etag: 'W/"e1"' })).toBe('not-modified');
  });

  it('maps discussions to the timeline incl. resolvable threads', async () => {
    server.use(
      ...baseHandlers(),
      http.get(`${API}/projects/${PID}/merge_requests/1`, () =>
        HttpResponse.json(mr({ diff_refs: { base_sha: 'b', head_sha: 'head2', start_sha: 's' } })),
      ),
      http.get(`${API}/projects/${PID}/merge_requests/1/discussions`, () =>
        HttpResponse.json(
          [
            {
              id: 'd1',
              individual_note: true,
              notes: [
                {
                  id: 1,
                  body: 'added 2 commits\n\n<ul><li>abc1234 - one</li><li>def5678 - two</li></ul>',
                  author: user(100, 'alice'),
                  created_at: '2026-01-01T01:00:00Z',
                  system: true,
                },
              ],
            },
            {
              id: 'd2',
              individual_note: true,
              notes: [
                {
                  id: 2,
                  body: 'LGTM?',
                  author: user(100, 'alice'),
                  created_at: '2026-01-01T02:00:00Z',
                  system: false,
                },
              ],
            },
            {
              id: 'd3',
              individual_note: false,
              notes: [
                {
                  id: 3,
                  type: 'DiffNote',
                  body: 'nit',
                  author: user(101, 'bob'),
                  created_at: '2026-01-01T03:00:00Z',
                  system: false,
                  resolvable: true,
                  resolved: true,
                  position: {
                    new_path: 'src/a.ts',
                    old_path: 'src/a.ts',
                    new_line: 12,
                    old_line: null,
                    head_sha: 'head1',
                  },
                },
                {
                  id: 4,
                  type: 'DiffNote',
                  body: 'fixed',
                  author: user(100, 'alice'),
                  created_at: '2026-01-01T03:10:00Z',
                  system: false,
                  resolvable: true,
                  resolved: true,
                },
              ],
            },
            {
              id: 'd4',
              individual_note: true,
              notes: [
                {
                  id: 5,
                  body: 'approved this merge request',
                  author: user(101, 'bob'),
                  created_at: '2026-01-01T04:00:00Z',
                  system: true,
                },
              ],
            },
            {
              id: 'd5',
              individual_note: true,
              notes: [
                {
                  id: 6,
                  body: 'added ~12 label',
                  author: user(101, 'bob'),
                  created_at: '2026-01-01T05:00:00Z',
                  system: true,
                },
              ],
            },
          ],
          { headers: { 'x-next-page': '' } },
        ),
      ),
    );
    const t = await provider().getTimeline(ref, 1);
    expect(t.nextCursor).toBeUndefined();
    expect(t.items.map((i) => i.kind)).toEqual(['commits', 'comment', 'thread', 'review', 'event']);
    expect(t.items[0]).toMatchObject({ shas: ['abc1234', 'def5678'] });
    expect(t.items[1]).toMatchObject({ id: '2', editable: true });
    expect(t.items[2]).toMatchObject({
      id: '1:d3',
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
      resolved: true,
      outdated: true,
    });
    expect(t.items[3]).toMatchObject({ kind: 'review', state: 'approved' });
    expect(t.items[4]).toMatchObject({ kind: 'event', event: 'labeled' });
  });

  it('merges with sha and resolves threads by encoded id', async () => {
    let mergeBody: unknown;
    let resolveUrl = '';
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/1/merge`, async ({ request }) => {
        mergeBody = await request.json();
        return HttpResponse.json(mr({ state: 'merged', squash_commit_sha: 'sq1' }));
      }),
      http.put(`${API}/projects/${PID}/merge_requests/1/discussions/d3`, ({ request }) => {
        resolveUrl = request.url;
        return HttpResponse.json({});
      }),
    );
    const p = provider();
    const r = await p.merge(ref, 1, {
      method: 'squash',
      expectedHeadSha: 'head1',
      deleteBranch: true,
      title: 'T',
    });
    expect(mergeBody).toEqual({
      sha: 'head1',
      squash: true,
      should_remove_source_branch: true,
      squash_commit_message: 'T',
    });
    expect(r).toEqual({ merged: true, sha: 'sq1', message: undefined });
    await p.setThreadResolved!(ref, '1:d3', true);
    expect(new URL(resolveUrl).searchParams.get('resolved')).toBe('true');
    await expect(p.merge(ref, 1, { method: 'rebase', expectedHeadSha: 'x' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('maps sha mismatch (409) to conflict', async () => {
    server.use(
      http.put(`${API}/projects/${PID}/merge_requests/1/merge`, () =>
        HttpResponse.json({ message: 'SHA does not match HEAD of source branch' }, { status: 409 }),
      ),
    );
    await expect(provider().merge(ref, 1, { method: 'merge', expectedHeadSha: 'old' })).rejects.toMatchObject(
      { code: 'conflict' },
    );
  });

  it('creates fork MRs on the source project with draft prefix and resolved user ids', async () => {
    let created: any;
    server.use(
      ...baseHandlers(),
      http.get(`${API}/users`, ({ request }) => {
        const u = new URL(request.url).searchParams.get('username');
        return HttpResponse.json(u === 'bob' ? [user(101, 'bob')] : []);
      }),
      http.post(`${API}/projects/dave%2Fapp/merge_requests`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(mr({ iid: 8 }), { status: 201 });
      }),
      http.get(`${API}/projects/${PID}/merge_requests/8`, () =>
        HttpResponse.json(mr({ iid: 8, title: 'Draft: T', draft: true })),
      ),
      http.get(`${API}/projects/${PID}/merge_requests/8/approvals`, () =>
        HttpResponse.json({ approvals_left: 0, approved_by: [] }),
      ),
    );
    const pr = await provider().createPullRequest({
      base: ref,
      baseBranch: 'main',
      head: { integration, owner: 'dave', name: 'app' },
      headBranch: 'feat',
      title: 'T',
      body: 'B',
      draft: true,
      reviewers: ['bob'],
      labels: ['a', 'b'],
      deleteSourceBranch: true,
    });
    expect(created).toMatchObject({
      source_branch: 'feat',
      target_branch: 'main',
      target_project_id: 1,
      title: 'Draft: T',
      reviewer_ids: [101],
      labels: 'a,b',
      remove_source_branch: true,
    });
    expect(pr).toMatchObject({ number: 8, state: 'draft', title: 'T' });
  });

  it('lists templates from .gitlab/merge_request_templates', async () => {
    server.use(
      http.get(`${API}/projects/${PID}/repository/tree`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('path')).toBe('.gitlab/merge_request_templates');
        expect(q.get('ref')).toBe('feat');
        return HttpResponse.json([
          { name: 'Default.md', path: '.gitlab/merge_request_templates/Default.md', type: 'blob' },
          { name: 'notes.txt', path: '.gitlab/merge_request_templates/notes.txt', type: 'blob' },
        ]);
      }),
      http.get(`${API}/projects/${PID}/repository/files/:path/raw`, ({ params }) => {
        expect(params.path).toBe('.gitlab/merge_request_templates/Default.md');
        return HttpResponse.text('## What');
      }),
    );
    expect(await provider().listPrTemplates(ref, 'feat')).toEqual([
      { name: 'Default', path: '.gitlab/merge_request_templates/Default.md', body: '## What' },
    ]);
  });

  it('pipelines → checks', async () => {
    server.use(
      http.get(`${API}/projects/${PID}/pipelines`, () => HttpResponse.json([{ id: 9 }])),
      http.get(`${API}/projects/${PID}/pipelines/9/jobs`, () =>
        HttpResponse.json([
          { id: 1, name: 'build', stage: 'build', status: 'success' },
          { id: 2, name: 'lint', stage: 'test', status: 'failed', allow_failure: true },
          { id: 3, name: 'deploy', stage: 'deploy', status: 'manual' },
          { id: 4, name: 'e2e', stage: 'test', status: 'running' },
        ]),
      ),
    );
    const checks = await provider().getChecks(ref, 'head1');
    expect(checks.map((c) => [c.name, c.status, c.group, c.provider])).toEqual([
      ['build', 'success', 'build', 'gitlab-ci'],
      ['lint', 'neutral', 'test', 'gitlab-ci'],
      ['deploy', 'action_required', 'deploy', 'gitlab-ci'],
      ['e2e', 'in_progress', 'test', 'gitlab-ci'],
    ]);
  });
});

describe('GitLab errors, pagination, owners', () => {
  it('401 → auth_required; 429 → rate_limited with Retry-After', async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json({ message: '401 Unauthorized' }, { status: 401 })),
      http.get(`${API}/projects/${PID}`, () =>
        HttpResponse.json(
          { message: 'Retry later' },
          {
            status: 429,
            headers: { 'retry-after': '30', 'ratelimit-remaining': '0', 'ratelimit-limit': '600' },
          },
        ),
      ),
    );
    await expect(provider().getViewer()).rejects.toMatchObject({ code: 'auth_required' });
    const before = Date.now();
    const err = (await provider()
      .getRepo(ref)
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe('rate_limited');
    expect(err.serialized.retryAt).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('403 insufficient_scope', async () => {
    server.use(
      http.post(`${API}/user/keys`, () =>
        HttpResponse.json({ error: 'insufficient_scope', scope: 'api' }, { status: 403 }),
      ),
    );
    await expect(provider().uploadSshKey!('t', 'ssh-ed25519 AAAA')).rejects.toMatchObject({
      code: 'insufficient_scope',
    });
  });

  it('paginates repos with x-next-page and lists groups as owners', async () => {
    server.use(
      http.get(`${API}/projects`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('membership')).toBe('true');
        return q.get('page') === '2'
          ? HttpResponse.json([project({ id: 4, path_with_namespace: 'grp/other' })], {
              headers: { 'x-next-page': '' },
            })
          : HttpResponse.json([project()], { headers: { 'x-next-page': '2' } });
      }),
      http.get(`${API}/user`, () => HttpResponse.json(user(100, 'alice'))),
      http.get(`${API}/groups`, () => HttpResponse.json([{ full_path: 'grp' }, { full_path: 'grp/sub' }])),
    );
    const p = provider();
    const first = await p.listRepos({});
    expect(first.items[0]).toMatchObject({
      fullName: 'grp/sub/app',
      isPrivate: true,
      viewerPermission: 'write',
      ref: { owner: 'grp/sub', name: 'app' },
    });
    expect(first.nextCursor).toBe('2');
    const second = await p.listRepos({ cursor: first.nextCursor });
    expect(second.items[0]!.ref).toMatchObject({ owner: 'grp', name: 'other' });
    expect(second.nextCursor).toBeUndefined();
    expect(await p.listOwners()).toEqual([
      { login: 'alice', avatarUrl: 'https://a/alice', kind: 'user' },
      { login: 'grp', avatarUrl: undefined, kind: 'group' },
      { login: 'grp/sub', avatarUrl: undefined, kind: 'group' },
    ]);
  });
});

describe('GitLab remote URL mapping', () => {
  it.each([
    ['https://gitlab.com/grp/sub/app.git', { owner: 'grp/sub', name: 'app' }],
    ['https://gitlab.com/grp/sub/deeper/app', { owner: 'grp/sub/deeper', name: 'app' }],
    ['git@gitlab.com:grp/sub/app.git', { owner: 'grp/sub', name: 'app' }],
    ['ssh://git@gitlab.com:2222/grp/app.git', { owner: 'grp', name: 'app' }],
    ['https://gitlab.com/grp/sub/app/-/tree/main', { owner: 'grp/sub', name: 'app' }],
    ['https://oauth2@gitlab.com/user/app.git', { owner: 'user', name: 'app' }],
    ['https://gitlab.com/app.git', null],
    ['https://github.com/grp/app.git', null],
  ])('gitlab.com %s', (url, expected) => {
    expect(matchGitLabRemoteUrl('gitlab.com', url)).toEqual(expected);
    expect(provider().matchRemoteUrl(url)).toEqual(expected);
  });

  it('self-managed host', () => {
    expect(matchGitLabRemoteUrl('https://git.acme.io', 'git@git.acme.io:platform/infra/tools.git')).toEqual({
      owner: 'platform/infra',
      name: 'tools',
    });
    expect(matchGitLabRemoteUrl('git.acme.io', 'https://gitlab.com/platform/tools.git')).toBeNull();
  });
});

describe('GitLab issue tracker', () => {
  it('lists assigned issues with x-next-page', async () => {
    let q: URLSearchParams | undefined;
    server.use(
      http.get(`${API}/projects/${PID}/issues`, ({ request }) => {
        q = new URL(request.url).searchParams;
        return HttpResponse.json(
          [
            {
              id: 1,
              iid: 12,
              project_id: 1,
              title: 'Crash',
              state: 'opened',
              labels: ['bug', 'Doing'],
              assignees: [user(100, 'alice')],
              author: user(101, 'bob'),
              created_at: 'a',
              updated_at: 'b',
              web_url: 'https://gitlab.com/grp/sub/app/-/issues/12',
              references: { full: 'grp/sub/app#12' },
              issue_type: 'issue',
            },
          ],
          { headers: { 'x-next-page': '2', 'x-total': '3' } },
        );
      }),
    );
    const t = createGitLabIssueTracker({ http: client(), host: 'gitlab.com', accountId: '100' });
    const page = await t.listIssues('grp/sub/app', { preset: 'assigned' });
    expect(q?.get('scope')).toBe('assigned_to_me');
    expect(q?.get('state')).toBe('opened');
    expect(page).toMatchObject({ nextCursor: '2', total: 3 });
    expect(page.items[0]).toMatchObject({
      key: '#12',
      stateCategory: 'in_progress',
      labels: ['bug', 'Doing'],
      tracker: { kind: 'gitlab', scope: 'grp/sub/app' },
      type: 'issue',
    });
  });
});
