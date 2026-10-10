import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HttpClient } from '../src/http';
import {
  createTrelloTracker,
  TRELLO_API_BASE,
  TRELLO_AUTH,
  TRELLO_AUTH_INFO,
  trelloBoardId,
  trelloErrorMessage,
  trelloIdTime,
  trelloStateCategory,
} from '../src/trello';

const API = TRELLO_API_BASE;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const AUTH = TRELLO_AUTH.authHeader('tok123', 'key456');
const tracker = () =>
  createTrelloTracker({
    http: new HttpClient({ baseUrl: API, retries: 0, auth: () => AUTH, errorMessage: trelloErrorMessage }),
    integration: { kind: 'trello', host: 'trello.com', accountId: 'm1' },
  });

const ME = { id: 'm1', username: 'me', fullName: 'Me Myself', avatarUrl: 'https://trello-members/m1' };
const BOARDS = [
  {
    id: 'b1',
    name: 'Product',
    shortLink: 'PRD1',
    lists: [
      { id: 'l1', name: 'To Do', pos: 1 },
      { id: 'l2', name: 'Doing', pos: 2 },
      { id: 'l3', name: 'Done', pos: 3 },
    ],
  },
  { id: 'b2', name: 'Ops', shortLink: 'OPS2', lists: [{ id: 'l9', name: 'Backlog', pos: 1 }] },
];
const card = (over: Record<string, unknown> = {}) => ({
  id: '5f2a0b000000000000000001',
  shortLink: 'abC123',
  name: 'Fix login',
  desc: 'Steps…',
  closed: false,
  idBoard: 'b1',
  idList: 'l2',
  idMembers: ['m1'],
  members: [ME],
  labels: [
    { name: 'bug', color: 'red' },
    { name: '', color: 'green' },
  ],
  due: '2026-10-20T12:00:00.000Z',
  dateLastActivity: '2026-10-09T10:00:00.000Z',
  shortUrl: 'https://trello.com/c/abC123',
  badges: { comments: 2 },
  ...over,
});

describe('Trello auth', () => {
  it('builds the OAuth header with key and token (never in the URL)', () => {
    expect(AUTH).toBe('OAuth oauth_consumer_key="key456", oauth_token="tok123"');
    expect(TRELLO_AUTH.authHeader('t"x')).toBe('OAuth oauth_token="tx"');
  });
  it('describes the connect flow', () => {
    const info = TRELLO_AUTH_INFO.trello!('');
    expect(info.apiBaseUrl).toBe('https://api.trello.com/1');
    expect(info.host).toBe('trello.com');
    expect(info.oauth).toBe('none');
    expect(info.patPageUrl).toContain('trello.com/power-ups/admin');
    expect(TRELLO_AUTH.tokenPageUrl('KEY')).toContain('key=KEY');
    expect(TRELLO_AUTH.tokenPageUrl('KEY')).toContain('expiration=never');
  });
  it('maps error bodies', () => {
    expect(trelloErrorMessage(401, 'invalid token')).toBe('invalid token');
    expect(trelloErrorMessage(400, { message: 'bad' })).toBe('bad');
    expect(trelloErrorMessage(500, undefined)).toBeUndefined();
  });
});

describe('Trello helpers', () => {
  it('parses scopes and derives states / creation time', () => {
    expect(trelloBoardId('b1/Product')).toBe('b1');
    expect(trelloBoardId('b1')).toBe('b1');
    expect(trelloStateCategory('Done')).toBe('done');
    expect(trelloStateCategory('In Progress')).toBe('in_progress');
    expect(trelloStateCategory('Code review')).toBe('in_progress');
    expect(trelloStateCategory('Backlog')).toBe('todo');
    expect(trelloStateCategory('Backlog', true)).toBe('done');
    expect(trelloIdTime('5f2a0b000000000000000001')).toBe(new Date(0x5f2a0b00 * 1000).toISOString());
    expect(trelloIdTime('nope')).toBeUndefined();
  });
});

describe('Trello tracker', () => {
  it('searchMyIssues = GET /members/me/cards?filter=open, labelled with board + list', async () => {
    let auth = '';
    let cardsQuery: URLSearchParams | null = null;
    server.use(
      http.get(`${API}/members/me/cards`, ({ request }) => {
        auth = request.headers.get('authorization') ?? '';
        cardsQuery = new URL(request.url).searchParams;
        return HttpResponse.json([
          card(),
          card({
            id: '5f2a0b000000000000000002',
            shortLink: 'ops9',
            name: 'Rotate keys',
            idBoard: 'b2',
            idList: 'l9',
            dateLastActivity: '2026-10-09T11:00:00.000Z',
          }),
          card({ id: '5f2a0b000000000000000003', shortLink: 'old', closed: true }),
        ]);
      }),
      http.get(`${API}/members/me/boards`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('filter')).toBe('open');
        expect(q.get('lists')).toBe('open');
        return HttpResponse.json(BOARDS);
      }),
    );
    const rows = await tracker().searchMyIssues!();
    expect(auth).toBe(AUTH);
    expect(cardsQuery!.get('filter')).toBe('open');
    expect(rows.map((r) => r.issue.key)).toEqual(['ops9', 'abC123']);
    const i = rows[1]!.issue;
    expect(i.tracker).toEqual({
      kind: 'trello',
      integration: { kind: 'trello', host: 'trello.com', accountId: 'm1' },
      scope: 'b1/Product',
    });
    expect(i.state).toBe('Doing');
    expect(i.stateCategory).toBe('in_progress');
    expect(i.labels).toEqual(['bug', 'green']);
    expect(i.assignees[0]).toMatchObject({ id: 'm1', login: 'me', name: 'Me Myself' });
    expect(i.assignees[0]!.avatarUrl).toBe('https://trello-members/m1/50.png');
    expect(i.webUrl).toBe('https://trello.com/c/abC123');
    expect(i.commentsCount).toBe(2);
    expect(i.milestone).toBe('Due 2026-10-20');
    expect(i.updatedAt).toBe('2026-10-09T10:00:00.000Z');
    expect(rows[1]!.involvement).toEqual(['assignee']);
  });

  it('searchMyIssues honours the board filter (id or shortLink) and survives a boards failure', async () => {
    server.use(
      http.get(`${API}/members/me/cards`, () =>
        HttpResponse.json([card(), card({ shortLink: 'ops9', idBoard: 'b2', idList: 'l9' })]),
      ),
      http.get(`${API}/members/me/boards`, () => HttpResponse.json(BOARDS)),
    );
    expect((await tracker().searchMyIssues!({ scopes: ['OPS2'] })).map((r) => r.issue.key)).toEqual(['ops9']);
    expect((await tracker().searchMyIssues!({ scopes: ['b1/Product'] })).map((r) => r.issue.key)).toEqual([
      'abC123',
    ]);

    server.use(http.get(`${API}/members/me/boards`, () => new HttpResponse('nope', { status: 500 })));
    const rows = await tracker().searchMyIssues!();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.issue.tracker.scope).toBe('b1/b1');
  });

  it('lists boards as scopes', async () => {
    server.use(http.get(`${API}/members/me/boards`, () => HttpResponse.json(BOARDS)));
    expect(await tracker().listScopes()).toEqual([
      { scope: 'b1/Product', label: 'Product' },
      { scope: 'b2/Ops', label: 'Ops' },
    ]);
  });

  it('lists a board’s cards with presets, text and paging', async () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      card({
        id: `5f2a0b0000000000000001${String(n).padStart(2, '0')}`,
        shortLink: `c${n}`,
        name: n === 7 ? 'Special search target' : `Card ${n}`,
        idMembers: n % 2 ? ['m1'] : ['x'],
        dateLastActivity: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
      }),
    );
    server.use(
      http.get(`${API}/boards/b1`, () => HttpResponse.json(BOARDS[0])),
      http.get(`${API}/boards/b1/cards`, () => HttpResponse.json(many)),
      http.get(`${API}/members/me`, () => HttpResponse.json(ME)),
    );
    const t = tracker();
    const mine = await t.listIssues('b1/Product', { preset: 'assigned' });
    expect(mine.total).toBe(30);
    expect(mine.nextCursor).toBeUndefined();
    expect(mine.items[0]!.key).toBe('c59');
    const all = await t.listIssues('b1', { preset: 'all-open' });
    expect(all.total).toBe(60);
    expect(all.items).toHaveLength(50);
    expect(all.nextCursor).toBe('50');
    const page2 = await t.listIssues('b1', { preset: 'all-open' }, all.nextCursor);
    expect(page2.items).toHaveLength(10);
    const found = await t.listIssues('b1', { preset: 'all-open', query: 'special' });
    expect(found.items.map((i) => i.key)).toEqual(['c7']);
    await expect(t.listIssues('', {})).rejects.toMatchObject({ code: 'validation' });
  });

  it('gets, creates, updates, transitions and comments on cards', async () => {
    const seen: Array<{ method: string; path: string; body?: unknown }> = [];
    const record = async (request: Request) => {
      const u = new URL(request.url);
      const text = await request.text();
      seen.push({ method: request.method, path: u.pathname, body: text ? JSON.parse(text) : undefined });
    };
    server.use(
      http.get(`${API}/cards/abC123`, () =>
        HttpResponse.json({ ...card(), list: BOARDS[0]!.lists[1], board: { id: 'b1', name: 'Product' } }),
      ),
      http.get(`${API}/boards/b1`, () => HttpResponse.json(BOARDS[0])),
      http.post(`${API}/cards`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(card({ shortLink: 'new1', name: 'New card', idList: 'l1' }));
      }),
      http.put(`${API}/cards/abC123`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(card());
      }),
      http.post(`${API}/cards/abC123/actions/comments`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: 'a1' });
      }),
      http.get(`${API}/cards/abC123/actions`, () =>
        HttpResponse.json([
          { id: 'a2', date: '2026-10-09T10:00:00.000Z', data: { text: 'second' }, memberCreator: ME },
          { id: 'a1', date: '2026-10-08T10:00:00.000Z', data: { text: 'first' } },
        ]),
      ),
    );
    const t = tracker();
    const got = await t.getIssue('ignored', 'abC123');
    expect(got.state).toBe('Doing');
    expect(got.tracker.scope).toBe('b1/Product');

    const created = await t.createIssue!('b1/Product', { title: 'New card', body: 'x', assignees: ['m1'] });
    expect(created.key).toBe('new1');
    expect(created.state).toBe('To Do');
    expect(seen[0]).toMatchObject({
      method: 'POST',
      body: { idList: 'l1', name: 'New card', idMembers: 'm1' },
    });

    await t.updateIssue!('b1', 'abC123', { title: 'Renamed' });
    expect(seen[1]).toMatchObject({ method: 'PUT', body: { name: 'Renamed' } });

    const tr = await t.listTransitions!('b1/Product', 'abC123');
    expect(tr.map((x) => x.id)).toEqual(['list:l1', 'list:l2', 'list:l3', 'archive']);
    expect(tr[2]!.toCategory).toBe('done');
    await t.transition!('b1', 'abC123', 'list:l3');
    expect(seen[2]).toMatchObject({ method: 'PUT', body: { idList: 'l3' } });
    await t.transition!('b1', 'abC123', 'archive');
    expect(seen[3]).toMatchObject({ method: 'PUT', body: { closed: true } });
    await expect(t.transition!('b1', 'abC123', 'bogus')).rejects.toMatchObject({ code: 'validation' });

    await t.addComment!('b1', 'abC123', 'Looks good');
    expect(seen[4]).toMatchObject({ method: 'POST', body: { text: 'Looks good' } });
    const comments = await t.listComments!('b1', 'abC123');
    expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
    expect(comments[1]!.author.login).toBe('me');
  });

  it('maps a revoked token to auth_required', async () => {
    server.use(http.get(`${API}/members/me/cards`, () => new HttpResponse('invalid token', { status: 401 })));
    await expect(tracker().searchMyIssues!()).rejects.toMatchObject({ code: 'auth_required' });
  });
});
