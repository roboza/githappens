import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, ProviderError } from '../src/http';
import {
  BITBUCKET_AUTH,
  BITBUCKET_AUTH_INFO,
  BITBUCKET_CLOUD_CAPABILITIES,
  BITBUCKET_DC_AUTH,
  BITBUCKET_DC_CAPABILITIES,
  bbCheckStatus,
  bbReviewState,
  bbUser,
  bitbucketAuthInfo,
  bitbucketCloudErrorMessage,
  bitbucketDcAuthInfo,
  bitbucketDcErrorMessage,
  createBitbucketCloudProvider,
  createBitbucketDcProvider,
  dcCheckStatus,
  dcReviewState,
} from '../src/bitbucket';
import {
  basicAuth,
  checksRollupOf,
  prRollupOf,
  sleep,
  stripHeads,
  toIso,
  unsupported,
} from '../src/bitbucket/shared';
import type { PullRequest, RepoRef, TimelineItem } from '../src/types';

const BB = 'https://api.bitbucket.org/2.0';
const DC = 'https://git.acme.com/rest/api/latest';
const DC_REST = 'https://git.acme.com/rest';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

type Opts = { mergePollIntervalMs?: number; mergePollTimeoutMs?: number };
const cloud = (o: Opts = {}) =>
  createBitbucketCloudProvider({
    http: new HttpClient({
      baseUrl: BB,
      retries: 0,
      auth: () => 'Bearer t',
      errorMessage: bitbucketCloudErrorMessage,
    }),
    mergePollIntervalMs: 1,
    ...o,
  });
const dc = (host = 'git.acme.com') =>
  createBitbucketDcProvider({
    http: new HttpClient({
      baseUrl: DC,
      retries: 0,
      auth: () => 'Bearer t',
      errorMessage: bitbucketDcErrorMessage,
    }),
    host,
  });

const json = async (r: Request): Promise<Record<string, unknown>> =>
  (await r.json()) as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Bitbucket Cloud
// ---------------------------------------------------------------------------------------------

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

const bbRepo = (over: Record<string, unknown> = {}) => ({
  uuid: '{r1}',
  name: 'New Repo',
  full_name: 'ws/new-repo',
  is_private: true,
  description: 'desc',
  updated_on: '2024-02-02T00:00:00Z',
  ...over,
});

describe('Bitbucket Cloud (coverage)', () => {
  const ref: RepoRef = {
    integration: { kind: 'bitbucket', host: 'bitbucket.org', accountId: '' },
    owner: 'ws',
    name: 'repo',
  };
  const meHandler = http.get(`${BB}/user`, () => HttpResponse.json(ME));

  it('exposes capabilities and lacks unsupported optional methods by design', () => {
    const p = cloud();
    expect(p.kind).toBe('bitbucket');
    expect(p.capabilities).toBe(BITBUCKET_CLOUD_CAPABILITIES);
    expect(p.capabilities.prMilestone).toBe(false);
    expect(p.capabilities.prAutoMerge).toBe(false);
    expect(p.capabilities.ciRerun).toBe(false);
    expect(p.listMilestones).toBeUndefined();
    expect(p.setAutoMerge).toBeUndefined();
    expect(p.rerunCi).toBeUndefined();
    expect(p.reopen).toBeUndefined();
  });

  it('getViewer caches the viewer and retries after a failure; getGrantedScopes splits headers', async () => {
    let calls = 0;
    server.use(
      http.get(`${BB}/user`, () => {
        calls++;
        if (calls === 1) return HttpResponse.json({ error: { message: 'boom' } }, { status: 500 });
        return HttpResponse.json(ME, { headers: { 'x-oauth-scopes': 'account, repository:write pipeline' } });
      }),
    );
    const p = cloud();
    await expect(p.getViewer()).rejects.toMatchObject({ code: 'server', message: 'boom' });
    expect(await p.getViewer()).toEqual({
      id: '{me}',
      login: 'me',
      name: 'Me',
      avatarUrl: 'a',
      isTeam: undefined,
    });
    await p.getViewer();
    expect(calls).toBe(2);
    expect(await p.getGrantedScopes()).toEqual(['account', 'repository:write', 'pipeline']);
    server.use(http.get(`${BB}/user`, () => HttpResponse.json(ME)));
    expect(await p.getGrantedScopes()).toEqual([]);
  });

  it('listRepos queries member repos with a name filter, per-owner or globally', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BB}/repositories/ws`, ({ request }) => {
        const u = new URL(request.url);
        seen.push(
          `ws:${u.searchParams.get('q')}:${u.searchParams.get('pagelen')}:${u.searchParams.get('role')}`,
        );
        return HttpResponse.json({ values: [bbRepo()], next: `${BB}/repositories/ws?page=2`, size: 2 });
      }),
      http.get(`${BB}/repositories`, ({ request }) => {
        const u = new URL(request.url);
        seen.push(`all:${u.searchParams.get('q')}:${u.searchParams.get('pagelen')}`);
        return HttpResponse.json({ values: [] });
      }),
    );
    const p = cloud();
    const r = await p.listRepos({ owner: 'ws', query: 'a"b', pageSize: 10 });
    expect(r.nextCursor).toBe(`${BB}/repositories/ws?page=2`);
    expect(r.total).toBe(2);
    expect(r.items[0]).toEqual({
      ref: { integration: ref.integration, owner: 'ws', name: 'new-repo', id: '{r1}' },
      fullName: 'ws/new-repo',
      description: 'desc',
      isPrivate: true,
      isFork: false,
      parent: undefined,
      defaultBranch: 'main',
      httpsUrl: 'https://bitbucket.org/ws/new-repo.git',
      sshUrl: 'git@bitbucket.org:ws/new-repo.git',
      webUrl: 'https://bitbucket.org/ws/new-repo',
      updatedAt: '2024-02-02T00:00:00.000Z',
    });
    const all = await p.listRepos({});
    expect(all.items).toEqual([]);
    expect(seen).toEqual(['ws:name ~ "a\\"b":10:member', 'all:null:100']);
  });

  it('listOwners walks workspace permissions across pages', async () => {
    server.use(
      http.get(`${BB}/user/permissions/workspaces`, ({ request }) => {
        const u = new URL(request.url);
        if (u.searchParams.get('page') === '2')
          return HttpResponse.json({ values: [{ workspace: { slug: 'two' } }] });
        return HttpResponse.json({
          values: [{ workspace: { slug: 'one', links: { avatar: { href: 'av' } } } }],
          next: `${BB}/user/permissions/workspaces?page=2`,
        });
      }),
    );
    expect(await cloud().listOwners()).toEqual([
      { login: 'one', avatarUrl: 'av', kind: 'workspace' },
      { login: 'two', avatarUrl: undefined, kind: 'workspace' },
    ]);
  });

  it('createRepo POSTs a slugged repo under an explicit workspace', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BB}/repositories/team/new-repo`, async ({ request }) => {
        body = await json(request);
        return HttpResponse.json(bbRepo({ full_name: 'team/new-repo' }));
      }),
    );
    const r = await cloud().createRepo!({
      owner: 'team',
      name: ' New Repo!! ',
      private: true,
      description: 'd',
    });
    expect(body).toEqual({ scm: 'git', name: ' New Repo!! ', is_private: true, description: 'd' });
    expect(r).toMatchObject({ fullName: 'team/new-repo', isPrivate: true, ref: { owner: 'team' } });
  });

  it('createRepo falls back to the viewer username, then nickname, then fails as unsupported', async () => {
    let path = '';
    server.use(
      meHandler,
      http.post(`${BB}/repositories/:owner/:slug`, ({ params }) => {
        path = `${String(params.owner)}/${String(params.slug)}`;
        return HttpResponse.json(bbRepo({ full_name: `${String(params.owner)}/x`, is_private: false }));
      }),
    );
    expect(await cloud().createRepo!({ name: 'X', private: false })).toMatchObject({ isPrivate: false });
    expect(path).toBe('me/x');

    server.use(http.get(`${BB}/user`, () => HttpResponse.json({ uuid: '{u}', nickname: 'nick' })));
    await cloud().createRepo!({ name: 'Y', private: true });
    expect(path).toBe('nick/y');

    server.use(http.get(`${BB}/user`, () => HttpResponse.json({ uuid: '{u}' })));
    await expect(cloud().createRepo!({ name: 'Z', private: true })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('createRepo surfaces API errors (with detail) as ProviderErrors', async () => {
    server.use(
      http.post(`${BB}/repositories/ws/dup`, () =>
        HttpResponse.json({ error: { message: 'Bad request', detail: 'exists' } }, { status: 400 }),
      ),
    );
    await expect(cloud().createRepo!({ owner: 'ws', name: 'dup', private: true })).rejects.toMatchObject({
      code: 'validation',
      message: 'Bad request: exists',
    });
  });

  it('createFork POSTs to /forks with an optional target workspace', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BB}/repositories/ws/repo/forks`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          bbRepo({
            full_name: 'mine/repo',
            parent: { full_name: 'ws/repo', uuid: '{p}' },
            mainbranch: null,
            links: { clone: [{ name: 'https', href: 'https://x@bitbucket.org/mine/repo.git' }] },
          }),
        );
      }),
    );
    const p = cloud();
    const f = await p.createFork!(ref, { owner: 'mine' });
    await p.createFork!(ref);
    expect(bodies).toEqual([{ workspace: { slug: 'mine' } }, {}]);
    expect(f).toMatchObject({
      isFork: true,
      parent: { owner: 'ws', name: 'repo', id: '{p}' },
      httpsUrl: 'https://bitbucket.org/mine/repo.git',
      defaultBranch: 'main',
    });
  });

  it('createFork maps 403 to insufficient_scope', async () => {
    server.use(
      http.post(`${BB}/repositories/ws/repo/forks`, () =>
        HttpResponse.json({ error: { message: 'Forbidden' } }, { status: 403 }),
      ),
    );
    await expect(cloud().createFork!(ref)).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('listPullRequests builds filters for review-requested, author, head, query and states', async () => {
    const seen: Array<{ q: string | null; states: string[] }> = [];
    server.use(
      meHandler,
      http.get(`${BB}/repositories/ws/repo/pullrequests`, ({ request }) => {
        const u = new URL(request.url);
        seen.push({ q: u.searchParams.get('q'), states: u.searchParams.getAll('state') });
        return HttpResponse.json({ values: [] });
      }),
    );
    const p = cloud();
    await p.listPullRequests(ref, {
      preset: 'review-requested',
      author: 'bob',
      head: 'feat',
      query: 'x"y',
      state: 'merged',
    });
    await p.listPullRequests(ref, { state: 'closed' });
    await p.listPullRequests(ref, { preset: 'assigned' });
    expect(seen).toEqual([
      {
        q: 'reviewers.uuid="{me}" AND author.nickname="bob" AND source.branch.name="feat" AND title ~ "x\\"y"',
        states: ['MERGED'],
      },
      { q: null, states: ['DECLINED', 'SUPERSEDED'] },
      { q: 'reviewers.uuid="{me}"', states: ['OPEN'] },
    ]);
  });

  it('listPullRequests tolerates a failing viewer lookup', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json({}, { status: 401 })),
      http.get(`${BB}/repositories/ws/repo/pullrequests`, () =>
        HttpResponse.json({ values: [bbPr({ reviewers: [BOB], participants: undefined })] }),
      ),
    );
    const page = await cloud().listPullRequests(ref, { preset: 'mine' });
    const pr = page.items[0]!;
    expect(pr.reviewers).toEqual([{ user: bbUser(BOB), state: 'pending' }]);
    expect(pr.reviewDecision).toBe('review_required');
    expect(pr.viewer).toMatchObject({ isAuthor: false, canApprove: true, reviewRequested: false });
    expect(pr.rollup).toBe('pending');
  });

  it('searchMyPullRequests merges authored PRs with reviewer PRs for the given repos', async () => {
    server.use(
      meHandler,
      http.get(`${BB}/pullrequests/:sel`, ({ params, request }) => {
        expect(params.sel).toBe('{me}');
        expect(new URL(request.url).searchParams.getAll('state')).toEqual(['OPEN']);
        return HttpResponse.json({
          values: [
            bbPr({ id: 1, author: ME }),
            bbPr({ id: 2, destination: { branch: { name: 'main' }, repository: { full_name: 'x/y' } } }),
          ],
        });
      }),
      http.get(`${BB}/repositories/ws/repo/pullrequests`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('q')).toBe('reviewers.uuid="{me}" AND state="OPEN"');
        return HttpResponse.json({ values: [bbPr({ id: 1, author: ME }), bbPr({ id: 3 })] });
      }),
    );
    const rows = await cloud().searchMyPullRequests!({ repos: [{ owner: 'ws', name: 'repo' }] });
    const byNum = Object.fromEntries(rows.map((r) => [r.pr.number, r.involvement]));
    expect(byNum).toEqual({ 1: ['author', 'reviewer'], 3: ['reviewer'] });
    expect(rows.find((r) => r.pr.number === 1)!.pr.viewer.isAuthor).toBe(true);
  });

  it('searchMyPullRequests without repos returns authored PRs only (account_id fallback)', async () => {
    server.use(
      http.get(`${BB}/user`, () => HttpResponse.json({ account_id: 'acc' })),
      http.get(`${BB}/pullrequests/acc`, () =>
        HttpResponse.json({
          values: [bbPr({ id: 4, destination: { branch: { name: 'main' }, repository: null } })],
        }),
      ),
    );
    const rows = await cloud().searchMyPullRequests!();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.involvement).toEqual(['author']);
    expect(rows[0]!.pr.repo).toMatchObject({ owner: '', name: '' });
  });

  it('getPullRequest returns not-modified on 304 and survives a failing statuses call', async () => {
    server.use(
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, ({ request }) => {
        if (request.headers.get('if-none-match') === '"e1"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json(
          bbPr({
            state: 'MERGED',
            source: { branch: undefined, commit: null, repository: { full_name: 'fork/repo' } },
            destination: { branch: undefined, commit: null, repository: null },
            links: undefined,
            comment_count: undefined,
            description: undefined,
          }),
        );
      }),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7/statuses`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get(`${BB}/user`, () => HttpResponse.json({}, { status: 500 })),
    );
    const p = cloud();
    expect(await p.getPullRequest(ref, 7, { etag: '"e1"' })).toBe('not-modified');
    const pr = (await p.getPullRequest(ref, 7)) as PullRequest;
    expect(pr).toMatchObject({
      state: 'merged',
      checksRollup: 'none',
      body: '',
      commentsCount: 0,
      webUrl: 'https://bitbucket.org/ws/repo/pull-requests/7',
      isCrossRepository: false,
      head: { branch: '', sha: '', repoCloneUrl: 'https://bitbucket.org/fork/repo.git' },
      base: { repo: ref, branch: '' },
    });
    expect(pr.mergedAt).toBe('2024-01-02T00:00:00.000Z');
    expect(pr.closedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('getTimeline skips deleted/pending comments and maps LEFT threads, change requests and updates', async () => {
    server.use(
      meHandler,
      http.get(`${BB}/repositories/ws/repo/pullrequests/7/comments`, () =>
        HttpResponse.json({
          values: [
            { id: 1, content: { raw: 'gone' }, user: ME, created_on: '2024-01-01T01:00:00Z', deleted: true },
            { id: 2, user: ME, created_on: '2024-01-01T01:00:00Z', pending: true },
            {
              id: 3,
              user: ALICE,
              created_on: '2024-01-01T02:00:00Z',
              inline: { path: 'b.ts', from: 9, to: null, outdated: true },
              resolution: { type: 'resolved' },
            },
            { id: 4, user: undefined, created_on: '2024-01-01T05:00:00Z' },
          ],
        }),
      ),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7/activity`, () =>
        HttpResponse.json({
          values: [
            { changes_requested: { date: '2024-01-01T03:00:00Z', user: BOB } },
            { update: { date: '2024-01-01T04:00:00Z', state: 'MERGED', author: ALICE, title: 't' } },
            { update: { date: '2024-01-01T04:30:00Z' } },
            { comment: {} },
          ],
        }),
      ),
    );
    const t = await cloud().getTimeline(ref, 7);
    expect(t.items.map((i) => i.kind)).toEqual(['thread', 'review', 'event', 'event', 'comment']);
    expect(t.items[0]).toMatchObject({ id: '7:3', side: 'LEFT', line: 9, resolved: true, outdated: true });
    expect((t.items[0] as Extract<TimelineItem, { kind: 'thread' }>).comments[0]!.body).toBe('');
    expect(t.items[1]).toMatchObject({
      state: 'changes_requested',
      id: 'changes:{bob}:2024-01-01T03:00:00Z',
    });
    expect(t.items[2]).toMatchObject({ event: 'state:merged', detail: 't', actor: { login: 'alice' } });
    expect(t.items[3]).toMatchObject({ event: 'updated', actor: undefined });
    expect(t.items[4]).toMatchObject({ author: { id: '', login: 'unknown' }, editable: false });
  });

  it('getChecks maps commit statuses', async () => {
    server.use(
      http.get(`${BB}/repositories/ws/repo/commit/abc/statuses`, () =>
        HttpResponse.json({
          values: [
            {
              uuid: '{s}',
              key: 'k',
              state: 'STOPPED',
              created_on: '2024-01-01T00:00:00Z',
              updated_on: '2024-01-01T00:01:00Z',
            },
            {
              key: 'k2',
              name: 'Pipe',
              state: 'FAILED',
              url: 'https://bitbucket.org/ws/repo/pipelines/results/3',
            },
          ],
        }),
      ),
    );
    const checks = await cloud().getChecks(ref, 'abc');
    expect(checks).toEqual([
      {
        id: '{s}',
        name: 'k',
        group: 'k',
        status: 'cancelled',
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:00.000Z',
        detailsUrl: undefined,
        canRerun: false,
        provider: 'status-api',
      },
      expect.objectContaining({ id: 'k2', name: 'Pipe', status: 'failure', provider: 'bitbucket-pipelines' }),
    ]);
  });

  it('searchUsers filters workspace members; listLabels is empty', async () => {
    server.use(
      http.get(`${BB}/workspaces/ws/members`, () =>
        HttpResponse.json({
          values: [
            { user: ALICE },
            { user: BOB },
            { user: { uuid: '{t}', display_name: 'Team Bob', type: 'team' } },
          ],
        }),
      ),
    );
    const p = cloud();
    const r = await p.searchUsers(ref, 'BOB');
    expect(r.map((u) => u.id)).toEqual(['{bob}', '{t}']);
    expect(r[1]!.isTeam).toBe(true);
    expect(await p.searchUsers(ref, '')).toHaveLength(3);
    expect(await p.listLabels(ref)).toEqual([]);
  });

  it('createPullRequest posts source/destination/reviewers', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      meHandler,
      http.post(`${BB}/repositories/ws/repo/pullrequests`, async ({ request }) => {
        body = await json(request);
        return HttpResponse.json(bbPr({ draft: true }));
      }),
    );
    const pr = await cloud().createPullRequest({
      base: ref,
      head: { ...ref, owner: 'fork' },
      baseBranch: 'main',
      headBranch: 'feature',
      title: 'T',
      body: 'B',
      reviewers: ['{u1}', 'acc2'],
      draft: true,
    });
    expect(body).toEqual({
      title: 'T',
      description: 'B',
      source: { branch: { name: 'feature' }, repository: { full_name: 'fork/repo' } },
      destination: { branch: { name: 'main' } },
      reviewers: [{ uuid: '{u1}' }, { account_id: 'acc2' }],
      close_source_branch: false,
      draft: true,
    });
    expect(pr.state).toBe('draft');
  });

  it('updatePullRequest declines, edits fields and re-reads when nothing to edit', async () => {
    const calls: string[] = [];
    let putBody: Record<string, unknown> | undefined;
    server.use(
      meHandler,
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/decline`, () => {
        calls.push('decline');
        return HttpResponse.json({});
      }),
      http.put(`${BB}/repositories/ws/repo/pullrequests/7`, async ({ request }) => {
        putBody = await json(request);
        calls.push('put');
        return HttpResponse.json(bbPr({ title: 'New' }));
      }),
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => {
        calls.push('get');
        return HttpResponse.json(bbPr({ state: 'DECLINED' }));
      }),
    );
    const p = cloud();
    const closed = await p.updatePullRequest(ref, 7, { state: 'closed' });
    expect(closed.state).toBe('closed');
    const edited = await p.updatePullRequest(ref, 7, {
      title: 'New',
      body: 'b',
      baseBranch: 'dev',
      reviewers: ['{x}', 'acc'],
    });
    expect(edited.title).toBe('New');
    expect(putBody).toEqual({
      title: 'New',
      description: 'b',
      destination: { branch: { name: 'dev' } },
      reviewers: [{ uuid: '{x}' }, { account_id: 'acc' }],
    });
    expect(calls).toEqual(['decline', 'get', 'put']);
  });

  it('reopen (updatePullRequest state=open) is unsupported for declined PRs and a no-op for open ones', async () => {
    let state = 'DECLINED';
    server.use(
      meHandler,
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => HttpResponse.json(bbPr({ state }))),
    );
    const p = cloud();
    await expect(p.updatePullRequest(ref, 7, { state: 'open' })).rejects.toMatchObject({
      code: 'unsupported',
      message: 'Bitbucket Cloud cannot reopen a declined pull request.',
    });
    state = 'OPEN';
    expect((await p.updatePullRequest(ref, 7, { state: 'open' })).state).toBe('open');
  });

  it('addComment posts with and without a parent id', async () => {
    const bodies: unknown[] = [];
    server.use(
      meHandler,
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/comments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          id: 50,
          content: { raw: 'hi' },
          user: ME,
          created_on: '2024-01-01T00:00:00Z',
        });
      }),
    );
    const p = cloud();
    const c = await p.addComment(ref, 7, 'hi', '7:12');
    await p.addComment(ref, 7, 'hi');
    expect(bodies).toEqual([{ content: { raw: 'hi' }, parent: { id: 12 } }, { content: { raw: 'hi' } }]);
    expect(c).toMatchObject({ kind: 'comment', id: '50', body: 'hi', editable: true });
  });

  it('submitReview posts inline comments (LEFT/RIGHT) and a body; COMMENT does not approve', async () => {
    const bodies: unknown[] = [];
    const other: string[] = [];
    server.use(
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/comments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 1 });
      }),
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/:action`, ({ params }) => {
        other.push(String(params.action));
        return HttpResponse.json({});
      }),
    );
    await cloud().submitReview(ref, 7, {
      event: 'COMMENT',
      commitSha: 'x',
      body: 'overall',
      comments: [
        { path: 'a.ts', line: 3, side: 'LEFT', body: 'l' },
        { path: 'a.ts', line: 4, side: 'RIGHT', body: 'r' },
      ],
    });
    expect(bodies).toEqual([
      { content: { raw: 'l' }, inline: { path: 'a.ts', from: 3 } },
      { content: { raw: 'r' }, inline: { path: 'a.ts', to: 4 } },
      { content: { raw: 'overall' } },
    ]);
    expect(other).toEqual([]);
  });

  it('setThreadResolved POSTs / DELETEs the resolve endpoint and validates the thread id', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/comments/12/resolve`, () => {
        calls.push('POST');
        return HttpResponse.json({ type: 'comment_resolution' });
      }),
      http.delete(`${BB}/repositories/ws/repo/pullrequests/7/comments/12/resolve`, () => {
        calls.push('DELETE');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const p = cloud();
    await p.setThreadResolved!(ref, '7:12', true);
    await p.setThreadResolved!(ref, '7:12', false);
    expect(calls).toEqual(['POST', 'DELETE']);
    await expect(p.setThreadResolved!(ref, 'bogus', true)).rejects.toMatchObject({ code: 'validation' });
  });

  it('setThreadResolved surfaces 404s', async () => {
    server.use(
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/comments/99/resolve`, () =>
        HttpResponse.json({ error: { message: 'No comment' } }, { status: 404 }),
      ),
    );
    await expect(cloud().setThreadResolved!(ref, '7:99', true)).rejects.toMatchObject({
      code: 'not_found',
      message: 'No comment',
    });
  });

  it('merge returns the merged PR on 200 and joins title/message', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => HttpResponse.json(bbPr())),
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/merge`, async ({ request }) => {
        body = await json(request);
        return HttpResponse.json(bbPr({ state: 'MERGED', merge_commit: { hash: 'mc' } }));
      }),
    );
    const r = await cloud().merge(ref, 7, {
      method: 'fast-forward',
      title: 'T',
      message: 'M',
      expectedHeadSha: 'abcdef',
    });
    expect(body).toEqual({ merge_strategy: 'fast_forward', message: 'T\n\nM', close_source_branch: false });
    expect(r).toEqual({ merged: true, sha: 'mc' });
  });

  it('merge handles 202 without a location and times out polling a pending task', async () => {
    let withLink = false;
    server.use(
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => HttpResponse.json(bbPr())),
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/merge`, () =>
        HttpResponse.json(withLink ? { links: { self: { href: `${BB}/task/2` } } } : {}, { status: 202 }),
      ),
      http.get(`${BB}/task/2`, () => HttpResponse.json({ task_status: 'PENDING' })),
    );
    expect(await cloud().merge(ref, 7, { method: 'merge', expectedHeadSha: '' })).toEqual({
      merged: false,
      message: 'Merge queued.',
    });
    withLink = true;
    expect(
      await cloud({ mergePollTimeoutMs: 15 }).merge(ref, 7, { method: 'merge', expectedHeadSha: 'abcdef' }),
    ).toEqual({ merged: false, message: 'Merge is still in progress on Bitbucket.' });
  });

  it('merge surfaces a 409 from Bitbucket', async () => {
    server.use(
      http.get(`${BB}/repositories/ws/repo/pullrequests/7`, () => HttpResponse.json(bbPr())),
      http.post(`${BB}/repositories/ws/repo/pullrequests/7/merge`, () =>
        HttpResponse.json({ error: { message: 'Conflicts' } }, { status: 409 }),
      ),
    );
    await expect(cloud().merge(ref, 7, { method: 'squash', expectedHeadSha: 'abc' })).rejects.toMatchObject({
      code: 'conflict',
      message: 'Conflicts',
    });
  });

  it('setDraft PUTs the draft flag', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${BB}/repositories/ws/repo/pullrequests/7`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(bbPr());
      }),
    );
    const p = cloud();
    await p.setDraft!(ref, 7, true);
    await p.setDraft!(ref, 7, false);
    expect(bodies).toEqual([{ draft: true }, { draft: false }]);
  });

  it('setDraft surfaces auth errors', async () => {
    server.use(
      http.put(`${BB}/repositories/ws/repo/pullrequests/7`, () =>
        HttpResponse.json({ error: { message: 'nope' } }, { status: 401 }),
      ),
    );
    await expect(cloud().setDraft!(ref, 7, true)).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('listCiRuns maps pipeline states and paginates', async () => {
    const queries: Array<string | null> = [];
    const pipe = (n: number, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      uuid: `{p${n}}`,
      build_number: n,
      state,
      ...extra,
    });
    server.use(
      http.get(`${BB}/repositories/ws/repo/pipelines/`, ({ request }) => {
        const u = new URL(request.url);
        queries.push(u.searchParams.get('target.branch'));
        if (u.searchParams.get('page') === '2') return HttpResponse.json({ values: [] });
        expect(u.searchParams.get('sort')).toBe('-created_on');
        return HttpResponse.json({
          values: [
            pipe(1, { name: 'PENDING' }),
            pipe(2, { name: 'IN_PROGRESS' }),
            pipe(
              3,
              { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
              {
                target: { ref_name: 'main' },
                trigger: { name: 'PUSH' },
                creator: ALICE,
                created_on: '2024-01-01T00:00:00Z',
                completed_on: '2024-01-01T00:05:00Z',
              },
            ),
            pipe(4, { name: 'COMPLETED', result: { name: 'STOPPED' } }),
            pipe(5, { name: 'COMPLETED', result: { name: 'FAILED' } }),
            pipe(6, { name: 'COMPLETED', result: { name: 'ERROR' } }),
            pipe(7, { name: 'COMPLETED', result: { name: 'EXPIRED' } }),
          ],
          next: `${BB}/repositories/ws/repo/pipelines/?page=2`,
        });
      }),
    );
    const p = cloud();
    const runs = await p.listCiRuns!(ref, { branch: 'main' });
    expect(runs.items.map((r) => r.status)).toEqual([
      'queued',
      'in_progress',
      'success',
      'cancelled',
      'failure',
      'failure',
      'neutral',
    ]);
    expect(runs.items[2]).toEqual({
      id: '{p3}',
      name: 'Pipeline #3',
      status: 'success',
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:05:00.000Z',
      detailsUrl: 'https://bitbucket.org/ws/repo/pipelines/results/3',
      canRerun: false,
      provider: 'bitbucket-pipelines',
      runNumber: 3,
      branch: 'main',
      event: 'push',
      actor: bbUser(ALICE),
    });
    expect(runs.items[0]!.actor).toBeUndefined();
    expect(runs.nextCursor).toContain('page=2');
    const next = await p.listCiRuns!(ref, { cursor: runs.nextCursor });
    expect(next.items).toEqual([]);
    expect(next.nextCursor).toBeUndefined();
    expect(queries).toEqual(['main', null]);
  });

  it('listCiRuns maps a 404 (pipelines disabled) to not_found', async () => {
    server.use(
      http.get(`${BB}/repositories/ws/repo/pipelines/`, () =>
        HttpResponse.json({ error: { message: 'Not found' } }, { status: 404 }),
      ),
    );
    await expect(cloud().listCiRuns!(ref, {})).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cancelCi POSTs stopPipeline with the encoded uuid', async () => {
    let url = '';
    server.use(
      http.post(`${BB}/repositories/ws/repo/pipelines/:id/stopPipeline`, ({ request }) => {
        url = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await cloud().cancelCi!(ref, '{p1}');
    expect(url).toBe(`${BB}/repositories/ws/repo/pipelines/%7Bp1%7D/stopPipeline`);
  });

  it('cancelCi surfaces validation errors (already finished)', async () => {
    server.use(
      http.post(`${BB}/repositories/ws/repo/pipelines/:id/stopPipeline`, () =>
        HttpResponse.json({ error: { message: 'Already completed' } }, { status: 400 }),
      ),
    );
    await expect(cloud().cancelCi!(ref, '{p1}')).rejects.toMatchObject({
      code: 'validation',
      message: 'Already completed',
    });
  });

  it('listSshKeys lists the viewer keys', async () => {
    server.use(
      meHandler,
      http.get(`${BB}/users/:uuid/ssh-keys`, () =>
        HttpResponse.json({
          values: [
            { uuid: '{k1}', label: 'laptop', fingerprint: 'fp' },
            { uuid: '{k2}', comment: 'me@host' },
            { uuid: '{k3}' },
          ],
        }),
      ),
    );
    expect(await cloud().listSshKeys!()).toEqual([
      { id: '{k1}', title: 'laptop', fingerprint: 'fp' },
      { id: '{k2}', title: 'me@host', fingerprint: undefined },
      { id: '{k3}', title: '', fingerprint: undefined },
    ]);
  });

  it('pure helpers: bbUser, bbReviewState, bbCheckStatus, error message mapper', () => {
    expect(bbUser(null)).toEqual({ id: '', login: 'unknown' });
    expect(bbUser({ account_id: 'acc', username: 'u' })).toMatchObject({ id: 'acc', login: 'u' });
    expect(bbUser({ display_name: 'D' })).toMatchObject({ id: '', login: 'D' });
    expect(bbUser({})).toMatchObject({ login: '' });
    expect(bbReviewState({ user: ALICE, role: 'PARTICIPANT', approved: true })).toBe('approved');
    expect(bbReviewState({ user: ALICE, role: 'PARTICIPANT', approved: false })).toBe('commented');
    expect(bbCheckStatus('WEIRD' as never)).toBe('neutral');
    expect(bitbucketCloudErrorMessage(400, undefined)).toBeUndefined();
    expect(bitbucketCloudErrorMessage(400, { error: {} })).toBeUndefined();
    expect(bitbucketCloudErrorMessage(400, { error: { message: 'm' } })).toBe('m');
  });
});

// ---------------------------------------------------------------------------------------------
// Bitbucket Data Center
// ---------------------------------------------------------------------------------------------

const DC_REPO = { id: 1, slug: 'repo', name: 'repo', project: { key: 'PRJ' } };
const dcPr = (over: Record<string, unknown> = {}) => ({
  id: 5,
  version: 3,
  title: 'Fix',
  description: 'd',
  state: 'OPEN',
  open: true,
  createdDate: 1700000000000,
  updatedDate: 1700000100000,
  fromRef: { id: 'refs/heads/fix', displayId: 'fix', latestCommit: 'aaaaaaaa', repository: DC_REPO },
  toRef: { id: 'refs/heads/main', displayId: 'main', latestCommit: 'bbbbbbbb', repository: DC_REPO },
  author: { user: { name: 'alice', displayName: 'Alice', id: 2 }, role: 'AUTHOR' },
  reviewers: [{ user: { name: 'me', id: 1, slug: 'me' }, role: 'REVIEWER', status: 'UNAPPROVED' }],
  properties: { commentCount: 2, mergeResult: { outcome: 'CLEAN' } },
  ...over,
});
const dcRepoRaw = (over: Record<string, unknown> = {}) => ({
  id: 9,
  slug: 'new',
  name: 'New',
  description: 'nd',
  public: false,
  project: { key: '~ME' },
  links: {
    clone: [
      { name: 'http', href: 'https://me@git.acme.com/scm/~me/new.git' },
      { name: 'ssh', href: 'ssh://git@git.acme.com:7999/~me/new.git' },
    ],
    self: [{ href: 'https://git.acme.com/users/me/repos/new/browse' }],
  },
  ...over,
});

describe('Bitbucket Data Center (coverage)', () => {
  const ref: RepoRef = {
    integration: { kind: 'bitbucket-dc', host: 'git.acme.com', accountId: '' },
    owner: 'PRJ',
    name: 'repo',
  };
  const viewerHandlers = [
    http.get(`${DC}/application-properties`, () =>
      HttpResponse.json({ version: '8.19' }, { headers: { 'X-AUSERNAME': 'me' } }),
    ),
    http.get(`${DC}/users/me`, () =>
      HttpResponse.json({ name: 'me', slug: 'me', id: 1, displayName: 'Me', emailAddress: 'me@acme.com' }),
    ),
  ];
  const anonymous = http.get(`${DC}/application-properties`, () => HttpResponse.json({ version: '8.19' }));

  it('exposes capabilities and lacks unsupported optional methods by design', () => {
    const p = dc();
    expect(p.kind).toBe('bitbucket-dc');
    expect(p.capabilities).toBe(BITBUCKET_DC_CAPABILITIES);
    expect(p.capabilities.prDraft).toBe(false);
    expect(p.capabilities.reviewThreadsResolve).toBe(false);
    expect(p.capabilities.prAutoMerge).toBe(false);
    expect(p.setDraft).toBeUndefined();
    expect(p.setThreadResolved).toBeUndefined();
    expect(p.listMilestones).toBeUndefined();
    expect(p.setAutoMerge).toBeUndefined();
    expect(p.listCiRuns).toBeUndefined();
    expect(p.rerunCi).toBeUndefined();
    expect(p.cancelCi).toBeUndefined();
    expect(p.uploadSshKey).toBeUndefined();
  });

  it('getViewer resolves via X-AUSERNAME; fails as auth_required when anonymous', async () => {
    server.use(anonymous);
    const p = dc();
    await expect(p.getViewer()).rejects.toMatchObject({ code: 'auth_required' });
    server.use(...viewerHandlers);
    expect(await p.getViewer()).toEqual({
      id: '1',
      login: 'me',
      name: 'Me',
      email: 'me@acme.com',
      avatarUrl: 'https://git.acme.com/users/me/avatar.png',
    });
    expect(await p.getGrantedScopes()).toEqual([]);
  });

  it('listRepos filters per-project repos client-side and searches globally by name', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${DC}/projects/PRJ/repos`, ({ request }) => {
        const u = new URL(request.url);
        seen.push(`prj:${u.searchParams.get('limit')}:${u.searchParams.get('start')}`);
        return HttpResponse.json({
          values: [
            { ...DC_REPO, name: 'Alpha', slug: 'alpha' },
            { ...DC_REPO, name: 'Beta', slug: 'beta', public: true },
          ],
          isLastPage: false,
          nextPageStart: 2,
          size: 2,
        });
      }),
      http.get(`${DC}/repos`, ({ request }) => {
        const u = new URL(request.url);
        seen.push(`all:${u.searchParams.get('name')}:${u.searchParams.get('limit')}`);
        return HttpResponse.json({ values: [DC_REPO], isLastPage: true, size: 1 });
      }),
    );
    const p = dc();
    const r = await p.listRepos({ owner: 'PRJ', query: 'ALP', cursor: '0' });
    expect(r.items.map((x) => x.fullName)).toEqual(['PRJ/alpha']);
    expect(r.nextCursor).toBe('2');
    expect((await p.listRepos({ owner: 'PRJ' })).items.map((x) => x.isPrivate)).toEqual([true, false]);
    const g = await p.listRepos({ query: 'repo', pageSize: 5 });
    expect(g.items[0]).toEqual({
      ref: { integration: ref.integration, owner: 'PRJ', name: 'repo', id: '1' },
      fullName: 'PRJ/repo',
      description: undefined,
      isPrivate: true,
      isFork: false,
      parent: undefined,
      defaultBranch: '',
      httpsUrl: 'https://git.acme.com/scm/prj/repo.git',
      sshUrl: '',
      webUrl: 'https://git.acme.com/projects/PRJ/repos/repo/browse',
      updatedAt: '',
    });
    expect(g.total).toBe(1);
    expect(seen).toEqual(['prj:100:0', 'prj:100:null', 'all:repo:5']);
  });

  it('listOwners lists projects and prepends the personal project when signed in', async () => {
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/projects`, () => HttpResponse.json({ values: [{ key: 'PRJ' }], isLastPage: true })),
    );
    expect(await dc().listOwners()).toEqual([
      { login: '~me', avatarUrl: 'https://git.acme.com/users/me/avatar.png', kind: 'user' },
      { login: 'PRJ', avatarUrl: 'https://git.acme.com/projects/PRJ/avatar.png', kind: 'project' },
    ]);
    server.use(anonymous);
    expect((await dc().listOwners()).map((o) => o.login)).toEqual(['PRJ']);
  });

  it('getRepo resolves the default branch via default-branch, then branches/default, then empty', async () => {
    let mode = 0;
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo`, () =>
        HttpResponse.json({ ...DC_REPO, origin: { ...DC_REPO, id: 2, project: { key: 'UP' } } }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/default-branch`, () =>
        mode === 0
          ? HttpResponse.json({ id: 'refs/heads/develop' })
          : HttpResponse.json({ errors: [{ message: 'nope' }] }, { status: 404 }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/branches/default`, () =>
        mode === 1
          ? HttpResponse.json({ displayId: 'trunk' })
          : mode === 2
            ? HttpResponse.json({})
            : new HttpResponse(null, { status: 204 }),
      ),
    );
    const p = dc();
    const r0 = await p.getRepo(ref);
    expect(r0).toMatchObject({
      defaultBranch: 'develop',
      isFork: true,
      parent: { owner: 'UP', name: 'repo', id: '2' },
    });
    mode = 1;
    expect((await p.getRepo(ref)).defaultBranch).toBe('trunk');
    mode = 2;
    expect((await p.getRepo(ref)).defaultBranch).toBe('');
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/branches/default`, () =>
        HttpResponse.json({ errors: [{ message: 'empty' }] }, { status: 404 }),
      ),
    );
    mode = 3;
    expect((await p.getRepo(ref)).defaultBranch).toBe('');
  });

  it('createFork POSTs to the repo path with an optional target project', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${DC}/projects/PRJ/repos/repo`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(dcRepoRaw({ origin: DC_REPO }));
      }),
    );
    const p = dc();
    const f = await p.createFork!(ref, { owner: 'TEAM' });
    await p.createFork!(ref);
    expect(bodies).toEqual([{ project: { key: 'TEAM' } }, {}]);
    expect(f).toMatchObject({
      fullName: '~ME/new',
      isFork: true,
      parent: { owner: 'PRJ', name: 'repo' },
      httpsUrl: 'https://git.acme.com/scm/~me/new.git',
      sshUrl: 'ssh://git@git.acme.com:7999/~me/new.git',
      webUrl: 'https://git.acme.com/users/me/repos/new/browse',
      description: 'nd',
    });
  });

  it('createFork maps BBDC error payloads', async () => {
    server.use(
      http.post(`${DC}/projects/PRJ/repos/repo`, () =>
        HttpResponse.json(
          { errors: [{ message: 'Forking disabled' }, {}, { message: 'x' }] },
          { status: 400 },
        ),
      ),
    );
    await expect(dc().createFork!(ref)).rejects.toMatchObject({
      code: 'validation',
      message: 'Forking disabled; x',
    });
  });

  it('createRepo POSTs under the given project or the personal project', async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    server.use(
      ...viewerHandlers,
      http.post(`${DC}/projects/:key/repos`, async ({ params, request }) => {
        seen.push({ path: String(params.key), body: await request.json() });
        return HttpResponse.json(dcRepoRaw());
      }),
    );
    const p = dc();
    const r = await p.createRepo!({ owner: 'PRJ', name: 'New', private: true, description: 'nd' });
    await p.createRepo!({ name: 'Pub', private: false });
    expect(seen).toEqual([
      { path: 'PRJ', body: { name: 'New', scmId: 'git', public: false, description: 'nd' } },
      { path: '~me', body: { name: 'Pub', scmId: 'git', public: true } },
    ]);
    expect(r).toMatchObject({ fullName: '~ME/new', isPrivate: true });
  });

  it('createRepo without an owner fails when anonymous; surfaces 409 conflicts', async () => {
    server.use(anonymous);
    await expect(dc().createRepo!({ name: 'x', private: true })).rejects.toMatchObject({
      code: 'auth_required',
    });
    server.use(
      http.post(`${DC}/projects/PRJ/repos`, () =>
        HttpResponse.json({ errors: [{ message: 'exists' }] }, { status: 409 }),
      ),
    );
    await expect(dc().createRepo!({ owner: 'PRJ', name: 'x', private: true })).rejects.toMatchObject({
      code: 'conflict',
      message: 'exists',
    });
  });

  it('matchRemoteUrl handles users/ browse URLs, generic paths and full https hosts', () => {
    const p = dc('https://git.acme.com:7990/bitbucket/');
    expect(p.matchRemoteUrl('https://git.acme.com/users/Alice/repos/Repo/browse')).toEqual({
      owner: '~alice',
      name: 'repo',
    });
    expect(p.matchRemoteUrl('ssh://git@git.acme.com/prj/repo.git')).toEqual({ owner: 'PRJ', name: 'repo' });
    expect(p.matchRemoteUrl('https://git.acme.com/only')).toBeNull();
    expect(p.matchRemoteUrl('not a url')).toBeNull();
  });

  it('listPullRequests maps filters (author, head, query, states) and anonymous presets', async () => {
    const seen: Array<Record<string, string>> = [];
    server.use(
      anonymous,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests`, ({ request }) => {
        seen.push(Object.fromEntries(new URL(request.url).searchParams));
        return HttpResponse.json({ values: [], isLastPage: true });
      }),
    );
    const p = dc();
    await p.listPullRequests(ref, { author: 'bob', head: 'feat', query: 'q', state: 'closed' });
    await p.listPullRequests(ref, { preset: 'mine', state: 'merged' });
    await p.listPullRequests(ref, { state: 'all' });
    expect(seen).toEqual([
      {
        state: 'DECLINED',
        limit: '50',
        order: 'NEWEST',
        'role.1': 'AUTHOR',
        'username.1': 'bob',
        at: 'refs/heads/feat',
        direction: 'OUTGOING',
        filterText: 'q',
      },
      { state: 'MERGED', limit: '50', order: 'NEWEST' },
      { state: 'ALL', limit: '50', order: 'NEWEST' },
    ]);
  });

  it('listPullRequests normalizes declined, approved and author-viewer PRs', async () => {
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests`, () =>
        HttpResponse.json({
          isLastPage: true,
          values: [
            dcPr({
              state: 'DECLINED',
              open: false,
              closedDate: 1700000200000,
              author: { user: { name: 'me', slug: 'me' } },
              reviewers: [{ user: { name: 'bob' }, approved: true }],
              properties: undefined,
              links: { self: [{ href: 'https://git.acme.com/pr/5' }] },
              fromRef: { id: 'refs/heads/x', repository: { ...DC_REPO, id: 7, project: { key: 'FORK' } } },
              toRef: { id: 'refs/heads/main' },
              description: undefined,
            }),
            dcPr({ id: 6, draft: true, reviewers: undefined }),
            dcPr({ id: 7, reviewers: [{ user: { name: 'z' }, role: 'PARTICIPANT' }] }),
          ],
        }),
      ),
    );
    const page = await dc().listPullRequests(ref, { preset: 'mine' });
    const [a, b, c] = page.items;
    expect(a).toMatchObject({
      state: 'closed',
      closedAt: new Date(1700000200000).toISOString(),
      mergedAt: undefined,
      reviewDecision: 'approved',
      mergeable: 'unknown',
      commentsCount: 0,
      body: '',
      webUrl: 'https://git.acme.com/pr/5',
      isCrossRepository: false,
      head: { branch: 'x', sha: '', repo: { owner: 'FORK' } },
      base: { repo: ref, branch: 'main', sha: undefined },
      viewer: { isAuthor: true, canApprove: false, canMerge: false, reviewRequested: false },
    });
    expect(a!.rollup).toBe('success');
    expect(b).toMatchObject({ state: 'draft', reviewDecision: null, mergeable: 'mergeable' });
    expect(c!.reviewers[0]!.state).toBe('commented');
    expect(c!.reviewDecision).toBe('review_required');
  });

  it('searchMyPullRequests merges dashboard results by role and filters by repo', async () => {
    const roles: string[] = [];
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/dashboard/pull-requests`, ({ request }) => {
        const u = new URL(request.url);
        const role = u.searchParams.get('role')!;
        roles.push(`${role}:${u.searchParams.get('limit')}`);
        if (role === 'AUTHOR')
          return HttpResponse.json({
            isLastPage: true,
            values: [
              dcPr({ id: 1 }),
              dcPr({ id: 2, toRef: { id: 'refs/heads/main' } }),
              dcPr({ id: 3, toRef: { id: 'refs/heads/main', repository: { ...DC_REPO, slug: 'other' } } }),
            ],
          });
        return HttpResponse.json({ isLastPage: true, values: [dcPr({ id: 1 })] });
      }),
    );
    const rows = await dc().searchMyPullRequests!({ repos: [{ owner: 'prj', name: 'REPO' }], limit: 500 });
    expect(rows.map((r) => [r.pr.number, r.involvement])).toEqual([[1, ['author', 'reviewer']]]);
    expect(roles.sort()).toEqual(['AUTHOR:100', 'REVIEWER:100']);
    const all = await dc().searchMyPullRequests!();
    expect(all.map((r) => r.pr.number).sort()).toEqual([1, 3]);
  });

  it('getPullRequest returns not-modified, merges checks and caches allowed merge methods', async () => {
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, ({ request }) => {
        if (request.headers.get('if-none-match') === '"v1"') return new HttpResponse(null, { status: 304 });
        return HttpResponse.json(dcPr(), { headers: { etag: '"v2"' } });
      }),
      http.get(`${DC_REST}/build-status/latest/commits/aaaaaaaa`, () =>
        HttpResponse.json({
          isLastPage: true,
          values: [{ state: 'INPROGRESS', key: 'ci', dateAdded: 1 }],
        }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () =>
        HttpResponse.json({
          mergeConfig: {
            strategies: [
              { id: 'ff-only', enabled: true },
              { id: 'rebase-no-ff', enabled: true },
              { id: 'squash', enabled: false },
              { id: 'mystery', enabled: true },
            ],
          },
        }),
      ),
    );
    const p = dc();
    expect(await p.getPullRequest(ref, 5, { etag: '"v1"' })).toBe('not-modified');
    const pr = (await p.getPullRequest(ref, 5)) as PullRequest;
    expect(pr.etag).toBe('"v2"');
    expect(pr.checksRollup).toBe('pending');
    expect(pr.allowedMergeMethods).toEqual(['fast-forward', 'rebase-merge']);
    expect(pr.viewer.reviewRequested).toBe(true);
  });

  it('getPullRequest without a head sha and with failing settings falls back to merge', async () => {
    server.use(
      anonymous,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () =>
        HttpResponse.json(dcPr({ fromRef: { id: 'refs/heads/fix' } })),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () =>
        HttpResponse.json({ errors: [{ message: 'no' }] }, { status: 403 }),
      ),
    );
    const pr = (await dc().getPullRequest(ref, 5)) as PullRequest;
    expect(pr.allowedMergeMethods).toEqual(['merge']);
    expect(pr.checksRollup).toBe('none');
    expect(pr.head.repoCloneUrl).toBeUndefined();
  });

  it('getPullRequest tolerates a failing build-status call and empty strategy config', async () => {
    server.use(
      anonymous,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () => HttpResponse.json(dcPr())),
      http.get(`${DC_REST}/build-status/latest/commits/aaaaaaaa`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () => HttpResponse.json({})),
    );
    const pr = (await dc().getPullRequest(ref, 5)) as PullRequest;
    expect(pr.checksRollup).toBe('none');
    expect(pr.allowedMergeMethods).toEqual(['merge']);
  });

  it('getTimeline handles plain comments with replies, skipped edits, LEFT threads, forced rescopes and events', async () => {
    server.use(
      ...viewerHandlers,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5/activities`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('start')).toBe('10');
        return HttpResponse.json({
          isLastPage: false,
          nextPageStart: 60,
          values: [
            {
              id: 1,
              createdDate: 1,
              user: { name: 'me' },
              action: 'COMMENTED',
              comment: {
                id: 20,
                text: 'top',
                author: { name: 'me' },
                createdDate: 1,
                comments: [{ id: 21, text: 'reply', author: { name: 'bob' }, createdDate: 2 }],
              },
            },
            {
              id: 2,
              createdDate: 1,
              user: { name: 'me' },
              action: 'COMMENTED',
              commentAction: 'EDITED',
              comment: { id: 22, text: 'x', author: { name: 'me' }, createdDate: 1 },
            },
            { id: 3, createdDate: 1, user: { name: 'me' }, action: 'COMMENTED' },
            {
              id: 4,
              createdDate: 1,
              user: { name: 'bob' },
              action: 'COMMENTED',
              comment: { id: 23, text: 'old', author: { name: 'bob' }, createdDate: 1, state: 'RESOLVED' },
              commentAnchor: { path: 'a.ts', line: 1, lineType: 'REMOVED', orphaned: true },
            },
            {
              id: 5,
              createdDate: 1,
              user: { name: 'alice' },
              action: 'RESCOPED',
              addedCommits: [{ id: 'n1' }],
              removedCommits: [{ id: 'o1' }],
            },
            { id: 6, createdDate: 1, user: { name: 'alice' }, action: 'RESCOPED' },
            { id: 7, createdDate: 1, user: { name: 'alice' }, action: 'OPENED' },
          ],
        });
      }),
    );
    const t = await dc().getTimeline(ref, 5, '10');
    expect(t.nextCursor).toBe('60');
    expect(t.items.map((i) => i.kind)).toEqual(['comment', 'comment', 'thread', 'commits', 'event']);
    expect(t.items[0]).toMatchObject({ id: '20', editable: true });
    expect(t.items[1]).toMatchObject({ id: '21', editable: false, body: 'reply' });
    expect(t.items[2]).toMatchObject({ side: 'LEFT', resolved: true, outdated: true });
    expect(t.items[3]).toMatchObject({ shas: ['n1'], forced: true });
    expect(t.items[4]).toMatchObject({ event: 'opened', actor: { login: 'alice' } });
  });

  it('searchUsers queries with repo permission filters; listLabels/listPrTemplates are empty', async () => {
    server.use(
      http.get(`${DC}/users`, ({ request }) => {
        const u = new URL(request.url);
        expect(Object.fromEntries(u.searchParams)).toEqual({
          filter: 'al',
          limit: '25',
          'permission.1': 'REPO_READ',
          'permission.1.projectKey': 'PRJ',
          'permission.1.repositorySlug': 'repo',
        });
        return HttpResponse.json({ isLastPage: true, values: [{ name: 'alice', id: 2 }] });
      }),
    );
    const p = dc();
    expect(await p.searchUsers(ref, 'al')).toEqual([
      {
        id: '2',
        login: 'alice',
        name: undefined,
        email: undefined,
        avatarUrl: 'https://git.acme.com/users/alice/avatar.png',
      },
    ]);
    expect(await p.listLabels(ref)).toEqual([]);
    expect(await p.listPrTemplates(ref, 'main')).toEqual([]);
  });

  it('createPullRequest posts fromRef/toRef/reviewers', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      anonymous,
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests`, async ({ request }) => {
        body = await json(request);
        return HttpResponse.json(dcPr());
      }),
    );
    const pr = await dc().createPullRequest({
      base: ref,
      head: { ...ref, owner: '~me', name: 'fork' },
      baseBranch: 'main',
      headBranch: 'fix',
      title: 'T',
      body: 'B',
      reviewers: ['bob'],
    });
    expect(body).toEqual({
      title: 'T',
      description: 'B',
      fromRef: { id: 'refs/heads/fix', repository: { slug: 'fork', project: { key: '~me' } } },
      toRef: { id: 'refs/heads/main', repository: { slug: 'repo', project: { key: 'PRJ' } } },
      reviewers: [{ user: { name: 'bob' } }],
    });
    expect(pr.number).toBe(5);
    await dc().createPullRequest({
      base: ref,
      head: ref,
      baseBranch: 'main',
      headBranch: 'x',
      title: 't',
      body: '',
    });
    expect(body!.reviewers).toEqual([]);
  });

  it('updatePullRequest declines / reopens with the version and edits fields', async () => {
    const calls: string[] = [];
    const puts: unknown[] = [];
    server.use(
      anonymous,
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () => HttpResponse.json(dcPr())),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/:action`, ({ params, request }) => {
        calls.push(`${String(params.action)}@${new URL(request.url).searchParams.get('version')}`);
        return HttpResponse.json(dcPr());
      }),
      http.put(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json(dcPr({ title: 'New' }));
      }),
    );
    const p = dc();
    await p.updatePullRequest(ref, 5, { state: 'closed' });
    await p.updatePullRequest(ref, 5, { state: 'open' });
    const edited = await p.updatePullRequest(ref, 5, { title: 'New', baseBranch: 'dev', reviewers: ['x'] });
    await p.updatePullRequest(ref, 5, { body: 'only body' });
    expect(calls).toEqual(['decline@3', 'reopen@3']);
    expect(edited.title).toBe('New');
    expect(puts).toEqual([
      {
        version: 3,
        title: 'New',
        description: 'd',
        toRef: { id: 'refs/heads/dev', repository: DC_REPO },
        reviewers: [{ user: { name: 'x' } }],
      },
      { version: 3, title: 'Fix', description: 'only body', reviewers: [{ user: { name: 'me' } }] },
    ]);
  });

  it('addComment posts text with an optional parent', async () => {
    const bodies: unknown[] = [];
    server.use(
      ...viewerHandlers,
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/comments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 30, text: 'hi', author: { name: 'me' }, createdDate: 1 });
      }),
    );
    const p = dc();
    const c = await p.addComment(ref, 5, 'hi', '12');
    await p.addComment(ref, 5, 'hi');
    expect(bodies).toEqual([{ text: 'hi', parent: { id: 12 } }, { text: 'hi' }]);
    expect(c).toMatchObject({
      kind: 'comment',
      id: '30',
      editable: true,
      createdAt: new Date(1).toISOString(),
    });
  });

  it('submitReview posts anchored comments and a body; COMMENT stops before participants; APPROVE approves', async () => {
    const bodies: unknown[] = [];
    let participant: unknown;
    server.use(
      ...viewerHandlers,
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/comments`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 1 });
      }),
      http.put(`${DC}/projects/PRJ/repos/repo/pull-requests/5/participants/me`, async ({ request }) => {
        participant = await request.json();
        return HttpResponse.json({});
      }),
    );
    const p = dc();
    await p.submitReview(ref, 5, {
      event: 'COMMENT',
      commitSha: 'x',
      body: 'overall',
      comments: [
        { path: 'a.ts', line: 3, side: 'LEFT', body: 'l' },
        { path: 'a.ts', line: 4, side: 'RIGHT', body: 'r' },
      ],
    });
    expect(bodies).toEqual([
      {
        text: 'l',
        anchor: { path: 'a.ts', line: 3, lineType: 'REMOVED', fileType: 'FROM', diffType: 'EFFECTIVE' },
      },
      {
        text: 'r',
        anchor: { path: 'a.ts', line: 4, lineType: 'ADDED', fileType: 'TO', diffType: 'EFFECTIVE' },
      },
      { text: 'overall' },
    ]);
    expect(participant).toBeUndefined();
    await p.submitReview(ref, 5, { event: 'APPROVE', commitSha: 'x' });
    expect(participant).toEqual({ user: { name: 'me' }, approved: true, status: 'APPROVED' });
  });

  it('merge falls back to the first strategy when settings are unreadable and deletes the source branch', async () => {
    let mergeBody: unknown;
    let deleted: unknown;
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () => HttpResponse.json(dcPr())),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/merge`, async ({ request }) => {
        mergeBody = await request.json();
        return HttpResponse.json(dcPr({ state: 'MERGED', properties: { mergeCommit: { id: 'mc' } } }));
      }),
      http.delete(`${DC_REST}/branch-utils/latest/projects/PRJ/repos/repo/branches`, async ({ request }) => {
        deleted = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const r = await dc().merge(ref, 5, {
      method: 'rebase',
      title: 'T',
      message: 'M',
      expectedHeadSha: 'aaaa',
      deleteBranch: true,
    });
    expect(mergeBody).toEqual({ strategyId: 'rebase-ff-only', message: 'T\n\nM' });
    expect(deleted).toEqual({ name: 'refs/heads/fix', dryRun: false });
    expect(r).toEqual({ merged: true, sha: 'mc' });
  });

  it('merge swallows branch-delete failures and reports non-merged results', async () => {
    let state = 'MERGED';
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () =>
        HttpResponse.json({}, { status: 500 }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () => HttpResponse.json(dcPr())),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/merge`, () =>
        HttpResponse.json(dcPr({ state })),
      ),
      http.delete(`${DC_REST}/branch-utils/latest/projects/PRJ/repos/repo/branches`, () =>
        HttpResponse.json({ errors: [{ message: 'no' }] }, { status: 403 }),
      ),
    );
    const p = dc();
    expect(await p.merge(ref, 5, { method: 'merge', expectedHeadSha: '', deleteBranch: true })).toEqual({
      merged: true,
      sha: undefined,
    });
    state = 'OPEN';
    expect(await p.merge(ref, 5, { method: 'merge', expectedHeadSha: '', deleteBranch: true })).toEqual({
      merged: false,
      sha: undefined,
    });
  });

  it('merge rejects disabled strategies and moved heads without retrying', async () => {
    let gets = 0;
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/settings/pull-requests`, () =>
        HttpResponse.json({ mergeConfig: { strategies: [{ id: 'no-ff', enabled: true }] } }),
      ),
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () => {
        gets++;
        return HttpResponse.json(dcPr());
      }),
    );
    const p = dc();
    await expect(p.merge(ref, 5, { method: 'squash', expectedHeadSha: 'aaaa' })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(p.merge(ref, 5, { method: 'merge', expectedHeadSha: 'ffff' })).rejects.toMatchObject({
      code: 'conflict',
      message: 'The pull request head changed since it was loaded. Refresh and try again.',
    });
    expect(gets).toBe(1);
  });

  it('close declines with the PR version', async () => {
    let url = '';
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () =>
        HttpResponse.json(dcPr({ version: 8 })),
      ),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/decline`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({});
      }),
    );
    await dc().close(ref, 5);
    expect(new URL(url).searchParams.get('version')).toBe('8');
  });

  it('reopen POSTs /reopen with the version and retries once on a stale 409', async () => {
    let version = 3;
    const seen: string[] = [];
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () =>
        HttpResponse.json(dcPr({ state: 'DECLINED', open: false, version: version++ })),
      ),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/reopen`, async ({ request }) => {
        const v = new URL(request.url).searchParams.get('version')!;
        seen.push(`${v}:${JSON.stringify(await request.json())}`);
        if (v === '3') return HttpResponse.json({ errors: [{ message: 'stale' }] }, { status: 409 });
        return HttpResponse.json(dcPr({ version: 5 }));
      }),
    );
    await dc().reopen!(ref, 5);
    expect(seen).toEqual(['3:{}', '4:{}']);
  });

  it('reopen surfaces non-conflict errors without retrying', async () => {
    let posts = 0;
    server.use(
      http.get(`${DC}/projects/PRJ/repos/repo/pull-requests/5`, () => HttpResponse.json(dcPr())),
      http.post(`${DC}/projects/PRJ/repos/repo/pull-requests/5/reopen`, () => {
        posts++;
        return HttpResponse.json({ errors: [{ message: 'Not declined' }] }, { status: 400 });
      }),
    );
    await expect(dc().reopen!(ref, 5)).rejects.toMatchObject({ code: 'validation', message: 'Not declined' });
    expect(posts).toBe(1);
  });

  it('listForks pages with nextPageStart; listOwners follows multiple project pages', async () => {
    server.use(
      anonymous,
      http.get(`${DC}/projects/PRJ/repos/repo/forks`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('start')).toBe('5');
        return HttpResponse.json({
          values: [dcRepoRaw({ origin: DC_REPO })],
          isLastPage: false,
          nextPageStart: 6,
          size: 1,
        });
      }),
      http.get(`${DC}/projects`, ({ request }) => {
        const start = new URL(request.url).searchParams.get('start');
        if (start === '1') return HttpResponse.json({ values: [{ key: 'B' }], isLastPage: true });
        return HttpResponse.json({ values: [{ key: 'A' }], isLastPage: false, nextPageStart: 1 });
      }),
    );
    const p = dc();
    const forks = await p.listForks(ref, '5');
    expect(forks).toMatchObject({ nextCursor: '6', total: 1 });
    expect(forks.items[0]).toMatchObject({ isFork: true, parent: { owner: 'PRJ', name: 'repo' } });
    expect((await p.listOwners()).map((o) => o.login)).toEqual(['A', 'B']);
  });

  it('pure helpers: dcReviewState, dcCheckStatus, error message mapper', () => {
    expect(dcReviewState({ user: { name: 'x' }, approved: true })).toBe('approved');
    expect(dcReviewState({ user: { name: 'x' } })).toBe('pending');
    expect(dcCheckStatus('CANCELLED')).toBe('cancelled');
    expect(dcCheckStatus('UNKNOWN')).toBe('neutral');
    expect(dcCheckStatus('INPROGRESS')).toBe('in_progress');
    expect(bitbucketDcErrorMessage(400, undefined)).toBeUndefined();
    expect(bitbucketDcErrorMessage(400, { errors: [] })).toBeUndefined();
  });

  it('getChecks maps cancelled/unknown with updatedDate', async () => {
    server.use(
      http.get(`${DC_REST}/build-status/latest/commits/abc`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('limit')).toBe('100');
        return HttpResponse.json({
          isLastPage: true,
          values: [
            { state: 'CANCELLED', key: 'a', dateAdded: 1, updatedDate: 2 },
            { state: 'INPROGRESS', key: 'b', name: 'B', dateAdded: 1 },
          ],
        });
      }),
    );
    const checks = await dc().getChecks(ref, 'abc');
    expect(checks[0]).toMatchObject({ status: 'cancelled', completedAt: new Date(2).toISOString() });
    expect(checks[1]).toMatchObject({ name: 'B', status: 'in_progress', completedAt: undefined });
  });
});

// ---------------------------------------------------------------------------------------------
// Auth descriptors + shared helpers
// ---------------------------------------------------------------------------------------------

describe('Bitbucket auth info factories', () => {
  it('bitbucketAuthInfo describes the OAuth broker flow', () => {
    const info = bitbucketAuthInfo('ignored');
    expect(info).toMatchObject({
      kind: 'bitbucket',
      host: 'bitbucket.org',
      authorizeUrl: 'https://bitbucket.org/site/oauth2/authorize',
      tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
      patPageUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      usernameForGit: 'x-token-auth',
      apiBaseUrl: 'https://api.bitbucket.org/2.0',
      oauth: 'broker',
      refreshable: true,
    });
    expect(info.patScopes).toContain('read:pipeline:bitbucket');
    expect(info.authorization('t')).toBe('Bearer t');
    expect(BITBUCKET_AUTH.patPageUrl('x')).toBe(info.patPageUrl);
    expect(BITBUCKET_AUTH.apiBaseUrl('x')).toBe(info.apiBaseUrl);
  });

  it('bitbucketDcAuthInfo normalizes the host', () => {
    const info = bitbucketDcAuthInfo('https://Git.Acme.com:8443/bitbucket');
    expect(info).toMatchObject({
      kind: 'bitbucket-dc',
      host: 'git.acme.com:8443',
      scopes: [],
      patScopes: ['REPO_WRITE', 'PROJECT_ADMIN'],
      patPageUrl: 'https://git.acme.com:8443/plugins/servlet/access-tokens/manage',
      usernameForGit: '{username}',
      apiBaseUrl: 'https://git.acme.com:8443/rest/api/latest',
      oauth: 'none',
      refreshable: false,
    });
    expect(info.authorization('t')).toBe('Bearer t');
    expect(BITBUCKET_DC_AUTH.authHeader('x')).toBe('Bearer x');
    expect(BITBUCKET_AUTH_INFO.bitbucket).toBe(bitbucketAuthInfo);
    expect(BITBUCKET_AUTH_INFO['bitbucket-dc']).toBe(bitbucketDcAuthInfo);
  });
});

describe('Bitbucket shared helpers', () => {
  it('toIso, basicAuth, stripHeads, unsupported, sleep', async () => {
    expect(toIso(null)).toBeUndefined();
    expect(toIso('')).toBeUndefined();
    expect(toIso(0)).toBe(new Date(0).toISOString());
    expect(toIso('2024-01-01T00:00:00.000+0000')).toBe('2024-01-01T00:00:00.000Z');
    expect(toIso('garbage')).toBe('garbage');
    expect(basicAuth('ü', 'p')).toBe(`Basic ${Buffer.from('ü:p').toString('base64')}`);
    expect(stripHeads('refs/heads/main')).toBe('main');
    expect(stripHeads(undefined)).toBe('');
    const e = unsupported('nope');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('unsupported');
    await sleep(0);
  });

  it('checksRollupOf and prRollupOf', () => {
    expect(checksRollupOf([])).toBe('none');
    expect(checksRollupOf([{ status: 'success' }, { status: 'timed_out' }])).toBe('failure');
    expect(checksRollupOf([{ status: 'queued' }])).toBe('pending');
    expect(checksRollupOf([{ status: 'success' }, { status: 'neutral' }])).toBe('success');
    expect(prRollupOf({ checksRollup: 'success', reviewDecision: 'approved', mergeable: 'mergeable' })).toBe(
      'success',
    );
    expect(prRollupOf({ checksRollup: 'none', reviewDecision: null, mergeable: 'conflicting' })).toBe(
      'failure',
    );
    expect(prRollupOf({ checksRollup: 'pending', reviewDecision: null, mergeable: 'unknown' })).toBe(
      'pending',
    );
  });
});
