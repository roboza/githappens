import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, ProviderError } from '../src/http';
import {
  BITBUCKET_AUTH,
  BITBUCKET_DC_AUTH,
  bitbucketCloudErrorMessage,
  createBitbucketCloudProvider,
  createBitbucketDcProvider,
} from '../src/bitbucket';
import type { PullRequest, RepoRef } from '../src/types';

const BB = 'https://api.bitbucket.org/2.0';
const DC = 'https://git.acme.com/rest/api/latest';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const cloud = () =>
  createBitbucketCloudProvider({
    http: new HttpClient({
      baseUrl: BB,
      retries: 0,
      auth: () => 'Bearer t',
      errorMessage: bitbucketCloudErrorMessage,
    }),
    mergePollIntervalMs: 1,
  });
const dc = () =>
  createBitbucketDcProvider({
    http: new HttpClient({ baseUrl: DC, retries: 0, auth: () => 'Bearer t' }),
    host: 'git.acme.com',
  });

const ME = {
  uuid: '{me}',
  nickname: 'me',
  display_name: 'Me',
  username: 'me',
  links: { avatar: { href: 'a' } },
};
const ALICE = { uuid: '{alice}', nickname: 'alice', display_name: 'Alice' };
const BOB = { uuid: '{bob}', nickname: 'bob', display_name: 'Bob' };

const bbPr = (over: Record<string, unknown> = {}) => ({
  id: 7,
  title: 'Add login',
  description: 'body',
  state: 'OPEN',
  draft: false,
  author: ALICE,
  created_on: '2024-01-01T00:00:00.000000+00:00',
  updated_on: '2024-01-02T00:00:00.000000+00:00',
  source: {
    branch: { name: 'feature' },
    commit: { hash: 'abcdef123456' },
    repository: { full_name: 'ws/repo' },
  },
  destination: {
    branch: { name: 'main' },
    commit: { hash: '111111111111' },
    repository: { full_name: 'ws/repo' },
  },
  participants: [],
  comment_count: 3,
  links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
  ...over,
});

describe('Bitbucket Cloud', () => {
  const p = cloud();
  const ref: RepoRef = {
    integration: { kind: 'bitbucket', host: 'bitbucket.org', accountId: '' },
    owner: 'ws',
    name: 'repo',
  };

  it('matchRemoteUrl handles https, scp and ssh:// forms', () => {
    expect(p.matchRemoteUrl('https://me@bitbucket.org/ws/repo.git')).toEqual({ owner: 'ws', name: 'repo' });
    expect(p.matchRemoteUrl('git@bitbucket.org:ws/repo.git')).toEqual({ owner: 'ws', name: 'repo' });
    expect(p.matchRemoteUrl('ssh://git@bitbucket.org/ws/repo')).toEqual({ owner: 'ws', name: 'repo' });
    expect(p.matchRemoteUrl('https://github.com/ws/repo.git')).toBeNull();
    expect(p.matchRemoteUrl('https://bitbucket.org/ws/repo/extra')).toBeNull();
  });

  it('normalizes PR states, drafts and participant review states', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json(ME)),
      http.get(`${BB}/repositories/ws/repo/pullrequests`, ({ request }) => {
        const u = new URL(request.url);
        expect(u.searchParams.getAll('state')).toEqual(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']);
        return HttpResponse.json({
          values: [
            bbPr({
              participants: [
                { user: ME, role: 'REVIEWER', approved: false, state: null },
                { user: BOB, role: 'REVIEWER', approved: true, state: 'approved' },
              ],
            }),
            bbPr({ id: 8, draft: true }),
            bbPr({ id: 9, state: 'MERGED', merge_commit: { hash: 'm' } }),
            bbPr({ id: 10, state: 'DECLINED' }),
            bbPr({
              id: 11,
              participants: [{ user: BOB, role: 'REVIEWER', approved: false, state: 'changes_requested' }],
            }),
          ],
        });
      }),
    );
    const page = await p.listPullRequests(ref, { state: 'all' });
    const [a, b, c, d, e] = page.items as PullRequest[];
    expect(a!.state).toBe('open');
    expect(a!.reviewers.map((r) => r.state)).toEqual(['pending', 'approved']);
    expect(a!.reviewDecision).toBe('approved');
    expect(a!.viewer.reviewRequested).toBe(true);
    expect(a!.viewer.canApprove).toBe(true);
    expect(b!.state).toBe('draft');
    expect(c!.state).toBe('merged');
    expect(d!.state).toBe('closed');
    expect(e!.reviewDecision).toBe('changes_requested');
    expect(e!.rollup).toBe('failure');
    expect(a!.allowedMergeMethods).toEqual(['merge', 'squash', 'fast-forward']);
  });

  it('follows `next` links for pagination and filters "mine" by author uuid', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json(ME)),
      http.get(`${BB}/repositories/ws/repo/pullrequests`, ({ request }) => {
        const u = new URL(request.url);
        if (u.searchParams.get('page') === '2') return HttpResponse.json({ values: [bbPr({ id: 2 })] });
        expect(u.searchParams.get('q')).toBe('author.uuid="{me}"');
        return HttpResponse.json({
          values: [bbPr({ id: 1 })],
          next: `${BB}/repositories/ws/repo/pullrequests?page=2`,
        });
      }),
    );
    const first = await p.listPullRequests(ref, { preset: 'mine' });
    expect(first.items.map((x) => x.number)).toEqual([1]);
    expect(first.nextCursor).toContain('page=2');
    const second = await p.listPullRequests(ref, { preset: 'mine' }, first.nextCursor);
    expect(second.items.map((x) => x.number)).toEqual([2]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('getPullRequest computes checks rollup from statuses', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json(ME)),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () =>
        HttpResponse.json(bbPr(), { headers: { etag: '"e1"' } }),
      ),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7/statuses`, () =>
        HttpResponse.json({
          values: [
            {
              key: 'build',
              name: 'Build',
              state: 'INPROGRESS',
              url: 'https://bitbucket.org/ws/repo/pipelines/results/1',
            },
            { key: 'lint', state: 'SUCCESSFUL' },
          ],
        }),
      ),
    );
    const pr = (await p.getPullRequest(ref, 7)) as PullRequest;
    expect(pr.checksRollup).toBe('pending');
    expect(pr.etag).toBe('"e1"');
    expect(pr.head).toMatchObject({ branch: 'feature', sha: 'abcdef123456' });
  });

  it('builds a timeline with inline comment threads', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json(ME)),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7/comments`, () =>
        HttpResponse.json({
          values: [
            { id: 1, content: { raw: 'general' }, user: ME, created_on: '2024-01-01T01:00:00Z' },
            {
              id: 2,
              content: { raw: 'inline' },
              user: ALICE,
              created_on: '2024-01-01T02:00:00Z',
              inline: { path: 'a.ts', to: 4 },
            },
            {
              id: 3,
              content: { raw: 'reply' },
              user: ME,
              created_on: '2024-01-01T03:00:00Z',
              parent: { id: 2 },
              inline: { path: 'a.ts', to: 4 },
            },
          ],
        }),
      ),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7/activity`, () =>
        HttpResponse.json({ values: [{ approval: { date: '2024-01-01T04:00:00Z', user: BOB } }] }),
      ),
    );
    const t = await p.getTimeline(ref, 7);
    expect(t.items.map((i) => i.kind)).toEqual(['comment', 'thread', 'review']);
    const thread = t.items[1] as Extract<(typeof t.items)[number], { kind: 'thread' }>;
    expect(thread).toMatchObject({ id: '7:2', path: 'a.ts', line: 4, side: 'RIGHT' });
    expect(thread.comments.map((c) => c.body)).toEqual(['inline', 'reply']);
    expect((t.items[0] as { editable: boolean }).editable).toBe(true);
  });

  it('merges with the mapped strategy and polls 202 merge tasks', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => HttpResponse.json(bbPr())),
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/merge`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({}, { status: 202, headers: { location: `${BB}/task/1` } });
      }),
      http.get(`${BB}/task/1`, () =>
        HttpResponse.json({ task_status: 'SUCCESS', merge_result: { merge_commit: { hash: 'mmm' } } }),
      ),
    );
    const r = await p.merge(ref, 7, {
      method: 'squash',
      expectedHeadSha: 'abcdef1234567890',
      deleteBranch: true,
    });
    expect(body).toMatchObject({ merge_strategy: 'squash', close_source_branch: true });
    expect(r).toEqual({ merged: true, sha: 'mmm' });
    await expect(p.merge(ref, 7, { method: 'rebase', expectedHeadSha: 'x' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('rejects merge when head moved', async () => {
    server.use(http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => HttpResponse.json(bbPr())));
    await expect(p.merge(ref, 7, { method: 'merge', expectedHeadSha: 'ffff' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('approves / requests changes / declines', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/:action`, ({ params }) => {
        calls.push(String(params.action));
        return HttpResponse.json({});
      }),
    );
    await p.submitReview(ref, 7, { event: 'APPROVE', commitSha: 'x' });
    await p.submitReview(ref, 7, { event: 'REQUEST_CHANGES', commitSha: 'x' });
    await p.close(ref, 7);
    expect(calls).toEqual(['approve', 'request-changes', 'decline']);
  });

  it('uploads SSH keys under the viewer uuid', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json(ME)),
      http.post(`${BB}/users/:uuid/ssh-keys`, async ({ params, request }) => {
        expect(params.uuid).toBe('{me}');
        expect(await request.json()).toEqual({ key: 'ssh-ed25519 AAA', label: 'laptop' });
        return HttpResponse.json({ uuid: '{k1}' });
      }),
    );
    expect(await p.uploadSshKey!('laptop', 'ssh-ed25519 AAA\n')).toEqual({ id: '{k1}' });
    expect(await p.listPrTemplates(ref, 'main')).toEqual([]);
  });

  it('maps 401 and 429 to ProviderErrors', async () => {
    server.use(
      http.get(`${BB}/repositories/ws/repo`, () =>
        HttpResponse.json({ type: 'error', error: { message: 'Unauthorized' } }, { status: 401 }),
      ),
      http.get(`${BB}/repositories/ws/other`, () =>
        HttpResponse.json(
          { error: { message: 'Rate limit' } },
          { status: 429, headers: { 'retry-after': '30' } },
        ),
      ),
    );
    await expect(p.getRepo(ref)).rejects.toMatchObject({ code: 'auth_required' });
    const err = await p.getRepo({ ...ref, name: 'other' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('rate_limited');
    expect((err as ProviderError).serialized.retryAt).toBeGreaterThan(Date.now());
  });

  it('normalizes repos (clone links, fork parent, workspaces)', async () => {
    server.use(
      http.get(`${BB}/repositories/ws/repo/forks`, () =>
        HttpResponse.json({
          values: [
            {
              uuid: '{r}',
              name: 'repo',
              full_name: 'bob/repo',
              is_private: true,
              parent: { full_name: 'ws/repo' },
              mainbranch: { name: 'develop' },
              links: {
                clone: [
                  { name: 'https', href: 'https://me@bitbucket.org/bob/repo.git' },
                  { name: 'ssh', href: 'git@bitbucket.org:bob/repo.git' },
                ],
                html: { href: 'https://bitbucket.org/bob/repo' },
              },
            },
          ],
        }),
      ),
    );
    const forks = await p.listForks(ref);
    expect(forks.items[0]).toMatchObject({
      fullName: 'bob/repo',
      isFork: true,
      parent: { owner: 'ws', name: 'repo' },
      httpsUrl: 'https://bitbucket.org/bob/repo.git',
      sshUrl: 'git@bitbucket.org:bob/repo.git',
      defaultBranch: 'develop',
    });
  });
});

const dcPr = (over: Record<string, unknown> = {}) => ({
  id: 5,
  version: 3,
  title: 'Fix',
  description: 'd',
  state: 'OPEN',
  open: true,
  createdDate: 1700000000000,
  updatedDate: 1700000100000,
  fromRef: {
    id: 'refs/heads/fix',
    displayId: 'fix',
    latestCommit: 'aaaaaaaa',
    repository: { id: 1, slug: 'repo', name: 'repo', project: { key: 'PRJ' } },
  },
  toRef: {
    id: 'refs/heads/main',
    displayId: 'main',
    latestCommit: 'bbbbbbbb',
    repository: { id: 1, slug: 'repo', name: 'repo', project: { key: 'PRJ' } },
  },
  author: { user: { name: 'alice', displayName: 'Alice', id: 2 }, role: 'AUTHOR' },
  reviewers: [
    { user: { name: 'me', id: 1, slug: 'me' }, role: 'REVIEWER', status: 'UNAPPROVED' },
    { user: { name: 'bob', id: 3 }, role: 'REVIEWER', status: 'NEEDS_WORK' },
  ],
  properties: { commentCount: 2, mergeResult: { outcome: 'CONFLICTED' } },
  ...over,
});

describe('Bitbucket Data Center', () => {
  const p = dc();
  const ref: RepoRef = {
    integration: { kind: 'bitbucket-dc', host: 'git.acme.com', accountId: '' },
    owner: 'PRJ',
    name: 'repo',
  };
  const viewerHandlers = [
    http.get(`${DC}/application-properties`, () =>
      HttpResponse.json({ version: '8.19' }, { headers: { 'X-AUSERNAME': 'me' } }),
    ),
    http.get(`${DC}/users/me`, () => HttpResponse.json({ name: 'me', slug: 'me', id: 1, displayName: 'Me' })),
  ];

  it('matchRemoteUrl handles /scm/ https, ssh :7999, browse URLs and personal repos', () => {
    expect(p.matchRemoteUrl('https://git.acme.com/scm/prj/repo.git')).toEqual({ owner: 'PRJ', name: 'repo' });
    expect(p.matchRemoteUrl('https://me@git.acme.com/bitbucket/scm/prj/repo.git')).toEqual({
      owner: 'PRJ',
      name: 'repo',
    });
    expect(p.matchRemoteUrl('ssh://git@git.acme.com:7999/prj/repo.git')).toEqual({
      owner: 'PRJ',
      name: 'repo',
    });
    expect(p.matchRemoteUrl('ssh://git@git.acme.com:7999/~alice/repo.git')).toEqual({
      owner: '~alice',
      name: 'repo',
    });
    expect(p.matchRemoteUrl('https://git.acme.com/projects/PRJ/repos/repo/browse')).toEqual({
      owner: 'PRJ',
      name: 'repo',
    });
    expect(p.matchRemoteUrl('https://other.com/scm/prj/repo.git')).toBeNull();
    expect(p.capabilities.sshKeyUpload).toBe(false);
    expect(p.capabilities.prRefspec).toBe('refs/pull-requests/{n}/from');
  });

  it('normalizes participants, mergeability and paginates with nextPageStart', async () => {
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests`, ({ request }) => {
        const u = new URL(request.url);
        expect(u.searchParams.get('role.1')).toBe('REVIEWER');
        expect(u.searchParams.get('username.1')).toBe('me');
        if (u.searchParams.get('start') === '25')
          return HttpResponse.json({
            values: [dcPr({ id: 6, state: 'MERGED', open: false })],
            isLastPage: true,
          });
        return HttpResponse.json({ values: [dcPr()], isLastPage: false, nextPageStart: 25 });
      }),
    );
    const first = await p.listPullRequests(ref, { preset: 'review-requested' });
    const pr = first.items[0]!;
    expect(pr.reviewers.map((r) => r.state)).toEqual(['pending', 'changes_requested']);
    expect(pr.reviewDecision).toBe('changes_requested');
    expect(pr.mergeable).toBe('conflicting');
    expect(pr.viewer.reviewRequested).toBe(true);
    expect(pr.createdAt).toBe(new Date(1700000000000).toISOString());
    expect(first.nextCursor).toBe('25');
    const second = await p.listPullRequests(ref, { preset: 'review-requested' }, first.nextCursor);
    expect(second.items[0]!.state).toBe('merged');
    expect(second.nextCursor).toBeUndefined();
  });

  it('merges with the PR version and retries once on a stale-version 409', async () => {
    let version = 3;
    const seen: string[] = [];
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () =>
        HttpResponse.json({
          mergeConfig: {
            strategies: [
              { id: 'no-ff', enabled: true },
              { id: 'squash', enabled: true },
            ],
          },
        }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () =>
        HttpResponse.json(dcPr({ version: version++ })),
      ),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/merge`, async ({ request }) => {
        const v = new URL(request.url).searchParams.get('version')!;
        seen.push(`${v}:${((await request.json()) as { strategyId: string }).strategyId}`);
        if (v === '3') return HttpResponse.json({ errors: [{ message: 'stale' }] }, { status: 409 });
        return HttpResponse.json(dcPr({ state: 'MERGED', properties: { mergeCommit: { id: 'mc' } } }));
      }),
    );
    const r = await p.merge(ref, 5, { method: 'squash', expectedHeadSha: 'aaaaaaaa' });
    expect(seen).toEqual(['3:squash', '4:squash']);
    expect(r).toEqual({ merged: true, sha: 'mc' });
  });

  it('timeline maps activities (comments, anchored threads, approvals, rescopes)', async () => {
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5/activities`, () =>
        HttpResponse.json({
          isLastPage: true,
          values: [
            { id: 1, createdDate: 3, user: { name: 'bob' }, action: 'APPROVED' },
            {
              id: 2,
              createdDate: 2,
              user: { name: 'bob' },
              action: 'COMMENTED',
              commentAction: 'ADDED',
              comment: {
                id: 10,
                text: 'nit',
                author: { name: 'bob' },
                createdDate: 2,
                comments: [{ id: 11, text: 'ok', author: { name: 'me' }, createdDate: 2 }],
              },
              commentAnchor: { path: 'src/a.ts', line: 3, lineType: 'ADDED', fileType: 'TO' },
            },
            {
              id: 3,
              createdDate: 1,
              user: { name: 'alice' },
              action: 'RESCOPED',
              added: { commits: [{ id: 'c1' }] },
            },
            { id: 4, createdDate: 1, user: { name: 'bob' }, action: 'REVIEWED' },
          ],
        }),
      ),
    );
    const t = await p.getTimeline(ref, 5);
    expect(t.items.map((i) => i.kind)).toEqual(['review', 'thread', 'commits', 'review']);
    expect(t.items[1]).toMatchObject({ path: 'src/a.ts', line: 3, side: 'RIGHT' });
    expect((t.items[3] as { state: string }).state).toBe('changes_requested');
  });

  it('reads build statuses from the build-status API', async () => {
    server.use(
      http.get('https://git.acme.com/rest/build-status/latest/commits/abc', () =>
        HttpResponse.json({
          isLastPage: true,
          values: [
            { state: 'FAILED', key: 'ci', name: 'CI', url: 'u', dateAdded: 1 },
            { state: 'SUCCESSFUL', key: 'lint', dateAdded: 1 },
          ],
        }),
      ),
    );
    const checks = await p.getChecks(ref, 'abc');
    expect(checks.map((c) => c.status)).toEqual(['failure', 'success']);
  });

  it('approves via participants with the viewer slug', async () => {
    let body: unknown;
    server.use(
      ...viewerHandlers,
      http.put(`${DC}/projects/PRJ/repos/repo/pull-requests/5/participants/me`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    await p.submitReview(ref, 5, { event: 'REQUEST_CHANGES', commitSha: 'x' });
    expect(body).toMatchObject({ status: 'NEEDS_WORK' });
  });
});

describe('Bitbucket auth descriptors', () => {
  it('builds headers', () => {
    expect(BITBUCKET_AUTH.authHeader('tok')).toBe('Bearer tok');
    expect(BITBUCKET_AUTH.authHeader('tok', 'a@b.c')).toBe(`Basic ${btoa('a@b.c:tok')}`);
    expect(BITBUCKET_DC_AUTH.apiBaseUrl('git.acme.com')).toBe('https://git.acme.com/rest/api/latest');
    expect(BITBUCKET_DC_AUTH.patPageUrl('https://git.acme.com/')).toBe(
      'https://git.acme.com/plugins/servlet/access-tokens/manage',
    );
  });
});
