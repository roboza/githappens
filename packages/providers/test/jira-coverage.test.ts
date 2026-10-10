import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http';
import {
  JIRA_AUTH,
  JIRA_AUTH_INFO,
  JIRA_DC_AUTH,
  adfToMarkdown,
  buildJql,
  createJiraCloudTracker,
  createJiraDcTracker,
  jiraCloudAuthInfo,
  jiraDcAuthInfo,
  jiraErrorMessage,
  jiraStateCategory,
  listAtlassianSites,
  markdownToAdf,
} from '../src/jira';

/** Extra Jira Cloud / Data Center / ADF / auth coverage (msw-backed, no real network). */

const CLOUD = 'https://acme.atlassian.net/rest/api/3';
const DC = 'https://jira.acme.com/rest/api/2';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const cloud = () =>
  createJiraCloudTracker({
    http: new HttpClient({
      baseUrl: CLOUD,
      retries: 0,
      auth: () => JIRA_AUTH.authHeader('tok', 'me@acme.com'),
      errorMessage: jiraErrorMessage,
    }),
    site: 'acme',
  });
const dc = () =>
  createJiraDcTracker({
    http: new HttpClient({
      baseUrl: DC,
      retries: 0,
      auth: () => 'Bearer pat',
      errorMessage: jiraErrorMessage,
    }),
    host: 'https://jira.acme.com/',
  });

const issue = (key: string, over: Record<string, unknown> = {}) => ({
  id: key.replace(/\D/g, ''),
  key,
  fields: {
    summary: `Summary ${key}`,
    description: null,
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    issuetype: { name: 'Task' },
    created: '2024-01-01T00:00:00.000+0000',
    updated: '2024-01-02T00:00:00.000+0000',
    ...over,
  },
});
const q = (request: Request) => new URL(request.url).searchParams;
const doc = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Jira Cloud — writes', () => {
  it('createIssue: picks the wanted type (case-insensitive), sends ADF body, labels and accountId', async () => {
    let created: any;
    server.use(
      http.get(`${CLOUD}/issue/createmeta/ABC/issuetypes`, () =>
        HttpResponse.json({
          values: [
            { id: '1', name: 'Bug' },
            { id: '2', name: 'Task' },
          ],
        }),
      ),
      http.post(`${CLOUD}/issue`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ id: '9', key: 'ABC-9' }, { status: 201 });
      }),
      http.get(`${CLOUD}/issue/ABC-9`, ({ request }) => {
        expect(q(request).get('fields')).toContain('customfield_10020');
        return HttpResponse.json(issue('ABC-9', { description: doc('hello'), labels: ['ui'] }));
      }),
    );
    const i = await cloud().createIssue!('acme.atlassian.net/ABC', {
      title: 'New',
      body: 'hello',
      type: 'bug',
      labels: ['ui'],
      assignees: ['acc-1'],
    });
    expect(created).toEqual({
      fields: {
        project: { key: 'ABC' },
        summary: 'New',
        issuetype: { id: '1' },
        description: doc('hello'),
        labels: ['ui'],
        assignee: { accountId: 'acc-1' },
      },
    });
    expect(i).toMatchObject({
      key: 'ABC-9',
      title: 'Summary ABC-9',
      body: 'hello',
      labels: ['ui'],
      state: 'To Do',
      stateCategory: 'todo',
      webUrl: 'https://acme.atlassian.net/browse/ABC-9',
      tracker: { kind: 'jira-cloud', scope: 'ABC' },
    });
  });

  it('createIssue falls back to the first non-subtask type and omits empty optional fields', async () => {
    let created: any;
    server.use(
      http.get(`${CLOUD}/issue/createmeta/ABC/issuetypes`, () =>
        HttpResponse.json({
          issueTypes: [
            { id: '5', name: 'Sub-task', subtask: true },
            { id: '6', name: 'Story' },
          ],
        }),
      ),
      http.post(`${CLOUD}/issue`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ id: '10', key: 'ABC-10' });
      }),
      http.get(`${CLOUD}/issue/ABC-10`, () => HttpResponse.json(issue('ABC-10'))),
    );
    await cloud().createIssue!('ABC', { title: 'T', type: 'Epic', labels: [], assignees: [] });
    expect(created).toEqual({ fields: { project: { key: 'ABC' }, summary: 'T', issuetype: { id: '6' } } });
  });

  it('createIssue validates the project and available issue types, and surfaces Jira errors', async () => {
    await expect(cloud().createIssue!('*', { title: 'x' })).rejects.toMatchObject({ code: 'validation' });
    await expect(cloud().createIssue!('', { title: 'x' })).rejects.toMatchObject({ code: 'validation' });
    server.use(http.get(`${CLOUD}/issue/createmeta/EMP/issuetypes`, () => HttpResponse.json({})));
    await expect(cloud().createIssue!('EMP', { title: 'x' })).rejects.toMatchObject({
      code: 'validation',
      message: 'No issue types available in EMP.',
    });
    server.use(
      http.get(`${CLOUD}/issue/createmeta/ABC/issuetypes`, () =>
        HttpResponse.json({ issueTypes: [{ id: '2', name: 'Task' }] }),
      ),
      http.post(`${CLOUD}/issue`, () =>
        HttpResponse.json(
          { errorMessages: [], errors: { summary: 'You must specify a summary.' } },
          { status: 400 },
        ),
      ),
    );
    await expect(cloud().createIssue!('ABC', { title: '' })).rejects.toMatchObject({
      code: 'validation',
      serialized: { providerMessage: 'summary: You must specify a summary.' },
    });
  });

  it('updateIssue PUTs only the changed fields (ADF body, unassign) then re-reads the issue', async () => {
    const puts: unknown[] = [];
    let gets = 0;
    server.use(
      http.put(`${CLOUD}/issue/ABC-1`, async ({ request }) => {
        puts.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${CLOUD}/issue/ABC-1`, () => {
        gets++;
        return HttpResponse.json(issue('ABC-1', { summary: 'Renamed' }));
      }),
    );
    const t = cloud();
    const i = await t.updateIssue!('ABC', 'ABC-1', {
      title: 'Renamed',
      body: 'b',
      labels: ['x', 'y'],
      assignees: [],
    });
    expect(i.title).toBe('Renamed');
    await t.updateIssue!('ABC', 'ABC-1', { assignees: ['acc-2'] });
    await t.updateIssue!('ABC', 'ABC-1', {});
    expect(puts).toEqual([
      { fields: { summary: 'Renamed', description: doc('b'), labels: ['x', 'y'], assignee: null } },
      { fields: { assignee: { accountId: 'acc-2' } } },
    ]);
    expect(gets).toBe(3);
  });

  it('updateIssue surfaces permission errors', async () => {
    server.use(
      http.put(`${CLOUD}/issue/ABC-1`, () =>
        HttpResponse.json({ errorMessages: ['You do not have permission'] }, { status: 403 }),
      ),
    );
    await expect(cloud().updateIssue!('ABC', 'ABC-1', { title: 'x' })).rejects.toMatchObject({
      code: 'insufficient_scope',
      serialized: { providerMessage: 'You do not have permission' },
    });
  });

  it('listTransitions defaults missing target categories to todo; transition errors propagate', async () => {
    server.use(
      http.get(`${CLOUD}/issue/ABC-1/transitions`, () =>
        HttpResponse.json({ transitions: [{ id: '1', name: 'Reopen' }] }),
      ),
      http.post(`${CLOUD}/issue/ABC-1/transitions`, () =>
        HttpResponse.json({ errorMessages: ['Transition 99 is not valid'] }, { status: 400 }),
      ),
    );
    const t = cloud();
    expect(await t.listTransitions!('ABC', 'ABC-1')).toEqual([
      { id: '1', name: 'Reopen', toCategory: 'todo' },
    ]);
    await expect(t.transition!('ABC', 'ABC-1', '99')).rejects.toMatchObject({ code: 'validation' });
  });

  it('listTransitions on a missing issue is not_found', async () => {
    server.use(
      http.get(`${CLOUD}/issue/ABC-404/transitions`, () =>
        HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 }),
      ),
    );
    await expect(cloud().listTransitions!('ABC', 'ABC-404')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('addComment sends ADF; listComments asks for 100 by created and handles missing authors', async () => {
    let posted: any;
    server.use(
      http.post(`${CLOUD}/issue/ABC-1/comment`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: '1' }, { status: 201 });
      }),
      http.get(`${CLOUD}/issue/ABC-1/comment`, ({ request }) => {
        expect(q(request).get('maxResults')).toBe('100');
        expect(q(request).get('orderBy')).toBe('created');
        return HttpResponse.json({
          comments: [
            { id: '1', body: doc('anon'), created: '2024-01-01T00:00:00.000+0000' },
            {
              id: '2',
              author: {
                accountId: 'a',
                displayName: 'A',
                emailAddress: 'a@x',
                avatarUrls: { '48x48': 'av' },
              },
              body: doc('hi'),
              created: '',
            },
          ],
        });
      }),
    );
    const t = cloud();
    await t.addComment!('ABC', 'ABC-1', 'line1\nline2');
    expect(posted).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'hardBreak' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    });
    expect(await t.listComments!('ABC', 'ABC-1')).toEqual([
      {
        id: '1',
        author: { id: '', login: 'unknown' },
        body: 'anon',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: '2',
        author: { id: 'a', login: 'a', name: 'A', email: 'a@x', avatarUrl: 'av' },
        body: 'hi',
        createdAt: '',
      },
    ]);
  });

  it('addComment / listComments surface auth errors', async () => {
    server.use(
      http.post(`${CLOUD}/issue/ABC-1/comment`, () => new HttpResponse(null, { status: 401 })),
      http.get(`${CLOUD}/issue/ABC-1/comment`, () => new HttpResponse(null, { status: 401 })),
    );
    await expect(cloud().addComment!('ABC', 'ABC-1', 'x')).rejects.toMatchObject({ code: 'auth_required' });
    await expect(cloud().listComments!('ABC', 'ABC-1')).rejects.toMatchObject({ code: 'auth_required' });
  });
});

describe('Jira Cloud — reads', () => {
  it('listScopes pages project/search until isLast', async () => {
    const starts: string[] = [];
    server.use(
      http.get(`${CLOUD}/project/search`, ({ request }) => {
        const s = q(request);
        starts.push(s.get('startAt')!);
        expect(s.get('orderBy')).toBe('name');
        if (s.get('startAt') === '0')
          return HttpResponse.json({ values: [{ key: 'A', name: 'Alpha' }], isLast: false });
        return HttpResponse.json({ values: [{ key: 'B', name: 'Beta' }] });
      }),
    );
    expect(await cloud().listScopes()).toEqual([
      { scope: 'A', label: 'Alpha (A)' },
      { scope: 'B', label: 'Beta (B)' },
    ]);
    expect(starts).toEqual(['0', '1']);
  });

  it('listScopes stops on an empty page even when isLast is false', async () => {
    server.use(http.get(`${CLOUD}/project/search`, () => HttpResponse.json({ values: [], isLast: false })));
    expect(await cloud().listScopes()).toEqual([]);
  });

  it('listIssues: nextPageToken without isLast continues; sprint/priority/user fallbacks', async () => {
    server.use(
      http.post(`${CLOUD}/search/jql`, () =>
        HttpResponse.json({
          issues: [
            issue('XYZ-1', {
              sprint: { name: 'Board sprint' },
              priority: null,
              reporter: { key: 'rkey', displayName: 'R' },
              status: { name: 'Doing', statusCategory: { key: 'indeterminate' } },
            }),
            issue('XYZ-2', {
              customfield_10020: [
                { name: 'S1', state: 'closed' },
                { name: 'S2', state: 'future' },
              ],
              reporter: { name: 'rname' },
              status: undefined,
            }),
          ],
          nextPageToken: 'tok',
        }),
      ),
    );
    const page = await cloud().listIssues('*', { query: 'labels = x' });
    expect(page.nextCursor).toBe('tok');
    const [a, b] = page.items;
    expect(a).toMatchObject({
      sprint: 'Board sprint',
      priority: undefined,
      reporter: { id: 'rkey', login: 'R', name: 'R' },
      stateCategory: 'in_progress',
      tracker: { scope: 'XYZ' },
      body: '',
      assignees: [],
      labels: [],
    });
    expect(b).toMatchObject({
      sprint: 'S2',
      reporter: { id: 'rname', login: 'rname' },
      state: '',
      stateCategory: 'todo',
    });
  });

  it('listIssues with isLast true and a token returns no cursor', async () => {
    server.use(
      http.post(`${CLOUD}/search/jql`, () =>
        HttpResponse.json({ issues: [], nextPageToken: 't', isLast: true }),
      ),
    );
    expect((await cloud().listIssues('ABC', {})).nextCursor).toBeUndefined();
  });

  it('searchMyIssues runs assigned + created JQL across scopes and merges involvement', async () => {
    const jqls: string[] = [];
    server.use(
      http.post(`${CLOUD}/search/jql`, async ({ request }) => {
        const body: any = await request.json();
        jqls.push(body.jql);
        return HttpResponse.json({
          issues: body.jql.includes('assignee') ? [issue('ABC-1'), issue('ABC-2')] : [issue('ABC-1')],
          isLast: true,
        });
      }),
    );
    const r = await cloud().searchMyIssues!({ scopes: ['ABC', 'site/DEF', '*'] });
    expect(jqls).toEqual([
      '(project in ("ABC", "DEF") AND assignee = currentUser() AND statusCategory != Done) ORDER BY updated DESC',
      '(project in ("ABC", "DEF") AND reporter = currentUser() AND statusCategory != Done) ORDER BY updated DESC',
    ]);
    expect(r.map((x) => [x.issue.key, x.involvement.sort()])).toEqual([
      ['ABC-1', ['assignee', 'creator']],
      ['ABC-2', ['assignee']],
    ]);
    jqls.length = 0;
    await cloud().searchMyIssues!({ includeCreated: false });
    expect(jqls).toEqual(['(assignee = currentUser() AND statusCategory != Done) ORDER BY updated DESC']);
  });

  it('jiraErrorMessage joins errorMessages and field errors', () => {
    expect(jiraErrorMessage(400, { errorMessages: ['a'], errors: { f: 'b' } })).toBe('a; f: b');
    expect(jiraErrorMessage(400, undefined)).toBeUndefined();
    expect(jiraErrorMessage(400, {})).toBeUndefined();
  });

  it('jiraStateCategory and buildJql edge cases', () => {
    expect(jiraStateCategory(undefined)).toBe('todo');
    expect(buildJql('ABC', { preset: 'assigned', updatedSince: 'not a date' })).toBe(
      'project = "ABC" AND (assignee = currentUser() AND statusCategory != Done) ORDER BY updated DESC',
    );
    expect(buildJql('A"B', { query: '   ' })).toBe(
      'project = "A\\"B" AND (assignee = currentUser() AND statusCategory != Done) ORDER BY updated DESC',
    );
  });
});

describe('Jira Data Center — writes and reads', () => {
  it('createIssue sends a wiki-text body and a name assignee', async () => {
    let created: any;
    server.use(
      http.get(`${DC}/issue/createmeta/DEV/issuetypes`, () =>
        HttpResponse.json({ values: [{ id: '3', name: 'Task' }] }),
      ),
      http.post(`${DC}/issue`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer pat');
        created = await request.json();
        return HttpResponse.json({ id: '7', key: 'DEV-7' });
      }),
      http.get(`${DC}/issue/DEV-7`, () =>
        HttpResponse.json(
          issue('DEV-7', { description: 'h1. wiki', assignee: { name: 'jdoe', key: 'JIRAUSER1' } }),
        ),
      ),
    );
    const i = await dc().createIssue!('DEV', { title: 'T', body: 'h1. wiki', assignees: ['jdoe'] });
    expect(created).toEqual({
      fields: {
        project: { key: 'DEV' },
        summary: 'T',
        issuetype: { id: '3' },
        description: 'h1. wiki',
        assignee: { name: 'jdoe' },
      },
    });
    expect(i).toMatchObject({
      key: 'DEV-7',
      body: 'h1. wiki',
      assignees: [{ id: 'JIRAUSER1', login: 'jdoe' }],
      webUrl: 'https://jira.acme.com/browse/DEV-7',
      tracker: { kind: 'jira-dc', scope: 'DEV', integration: { host: 'jira.acme.com' } },
    });
  });

  it('createIssue surfaces server errors', async () => {
    server.use(
      http.get(`${DC}/issue/createmeta/DEV/issuetypes`, () =>
        HttpResponse.json({ errorMessages: ['boom'] }, { status: 500 }),
      ),
    );
    await expect(dc().createIssue!('DEV', { title: 'T' })).rejects.toMatchObject({ code: 'server' });
  });

  it('updateIssue sends plain text and name assignees', async () => {
    let put: unknown;
    server.use(
      http.put(`${DC}/issue/DEV-1`, async ({ request }) => {
        put = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${DC}/issue/DEV-1`, () =>
        HttpResponse.json(issue('DEV-1', { description: doc('adf in dc') })),
      ),
    );
    const i = await dc().updateIssue!('DEV', 'DEV-1', { body: 'plain', assignees: ['bob'] });
    expect(put).toEqual({ fields: { description: 'plain', assignee: { name: 'bob' } } });
    // A DC server that still returns ADF is converted.
    expect(i.body).toBe('adf in dc');
  });

  it('listTransitions + transition', async () => {
    let applied: unknown;
    server.use(
      http.get(`${DC}/issue/DEV-1/transitions`, () =>
        HttpResponse.json({
          transitions: [
            { id: '5', name: 'Resolve', to: { name: 'Resolved', statusCategory: { key: 'done' } } },
          ],
        }),
      ),
      http.post(`${DC}/issue/DEV-1/transitions`, async ({ request }) => {
        applied = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = dc();
    expect(await t.listTransitions!('DEV', 'DEV-1')).toEqual([
      { id: '5', name: 'Resolve', toCategory: 'done' },
    ]);
    await t.transition!('DEV', 'DEV-1', '5');
    expect(applied).toEqual({ transition: { id: '5' } });
  });

  it('listTransitions / transition surface errors', async () => {
    server.use(
      http.get(`${DC}/issue/DEV-9/transitions`, () => new HttpResponse(null, { status: 404 })),
      http.post(`${DC}/issue/DEV-9/transitions`, () =>
        HttpResponse.json({ errorMessages: ['nope'] }, { status: 409 }),
      ),
    );
    await expect(dc().listTransitions!('DEV', 'DEV-9')).rejects.toMatchObject({ code: 'not_found' });
    await expect(dc().transition!('DEV', 'DEV-9', '1')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('addComment sends plain text; listComments keeps wiki strings', async () => {
    let posted: unknown;
    server.use(
      http.post(`${DC}/issue/DEV-1/comment`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: '1' });
      }),
      http.get(`${DC}/issue/DEV-1/comment`, () =>
        HttpResponse.json({
          comments: [
            {
              id: '3',
              author: { name: 'jdoe', key: 'K', displayName: 'J' },
              body: '*bold* wiki',
              created: '2024-01-01T00:00:00.000+0000',
            },
          ],
        }),
      ),
    );
    const t = dc();
    await t.addComment!('DEV', 'DEV-1', '*bold* wiki');
    expect(posted).toEqual({ body: '*bold* wiki' });
    expect(await t.listComments!('DEV', 'DEV-1')).toEqual([
      {
        id: '3',
        author: { id: 'K', login: 'jdoe', name: 'J', email: undefined, avatarUrl: undefined },
        body: '*bold* wiki',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('addComment / listComments surface errors', async () => {
    server.use(
      http.post(`${DC}/issue/DEV-1/comment`, () =>
        HttpResponse.json({ errors: { body: 'empty' } }, { status: 400 }),
      ),
      http.get(`${DC}/issue/DEV-1/comment`, () => new HttpResponse(null, { status: 404 })),
    );
    await expect(dc().addComment!('DEV', 'DEV-1', '')).rejects.toMatchObject({
      code: 'validation',
      serialized: { providerMessage: 'body: empty' },
    });
    await expect(dc().listComments!('DEV', 'DEV-1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('listIssues: empty page → no cursor; searchMyIssues uses /search', async () => {
    server.use(
      http.post(`${DC}/search`, async ({ request }) => {
        const body: any = await request.json();
        if (body.jql.includes('reporter'))
          return HttpResponse.json({ issues: [], startAt: 0, maxResults: 50, total: 0 });
        return HttpResponse.json({ issues: [issue('DEV-1')], startAt: 0, maxResults: 50, total: 1 });
      }),
    );
    const t = dc();
    const r = await t.searchMyIssues!();
    expect(r.map((x) => x.issue.key)).toEqual(['DEV-1']);
    expect(r[0]!.issue.tracker.scope).toBe('DEV');
    const p = await t.listIssues('DEV', { preset: 'created' });
    expect(p).toMatchObject({ nextCursor: undefined, total: 0 });
  });

  it('DC host without a scheme', async () => {
    const t = createJiraDcTracker({
      http: new HttpClient({ baseUrl: DC, retries: 0 }),
      host: 'jira.acme.com',
    });
    server.use(http.get(`${DC}/issue/DEV-2`, () => HttpResponse.json(issue('DEV-2'))));
    expect((await t.getIssue('DEV', 'DEV-2')).webUrl).toBe('https://jira.acme.com/browse/DEV-2');
  });
});

describe('Jira auth', () => {
  it('descriptors build URLs and headers', () => {
    expect(JIRA_AUTH.apiBaseUrl('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net/rest/api/3');
    expect(JIRA_AUTH.oauthApiBaseUrl('a b')).toBe('https://api.atlassian.com/ex/jira/a%20b/rest/api/3');
    expect(JIRA_AUTH.authHeader('oat')).toBe('Bearer oat');
    expect(JIRA_AUTH.authHeader('tok', 'me@x')).toBe(`Basic ${btoa('me@x:tok')}`);
    expect(JIRA_AUTH.patPageUrl('x')).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(JIRA_DC_AUTH.apiBaseUrl('https://jira.acme.com/')).toBe('https://jira.acme.com/rest/api/2');
    expect(JIRA_DC_AUTH.patPageUrl('jira.acme.com')).toBe(
      'https://jira.acme.com/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens',
    );
    expect(JIRA_DC_AUTH.authHeader('pat')).toBe('Bearer pat');
  });

  it('AuthInfo factories for Cloud (broker OAuth) and DC (PAT only)', () => {
    const c = jiraCloudAuthInfo('acme.atlassian.net');
    expect(c).toMatchObject({
      kind: 'jira-cloud',
      host: 'acme.atlassian.net',
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: JIRA_AUTH.scopes,
      patScopes: [],
      apiBaseUrl: 'https://acme.atlassian.net/rest/api/3',
      oauth: 'broker',
      refreshable: true,
    });
    expect(c.authorization('t')).toBe('Bearer t');
    const d = jiraDcAuthInfo('jira.acme.com');
    expect(d).toMatchObject({
      kind: 'jira-dc',
      host: 'jira.acme.com',
      apiBaseUrl: 'https://jira.acme.com/rest/api/2',
      oauth: 'none',
      refreshable: false,
    });
    expect(d.authorization('p')).toBe('Bearer p');
    expect(JIRA_AUTH_INFO['jira-cloud']).toBe(jiraCloudAuthInfo);
    expect(JIRA_AUTH_INFO['jira-dc']).toBe(jiraDcAuthInfo);
  });

  it('listAtlassianSites defaults the name to the URL and scopes to []', async () => {
    server.use(
      http.get(JIRA_AUTH.accessibleResourcesUrl, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer oat');
        return HttpResponse.json([
          { id: 'c1', url: 'https://acme.atlassian.net' },
          { id: 'c2', name: 'Beta', url: 'https://beta.atlassian.net', scopes: ['read:jira-work'] },
        ]);
      }),
    );
    expect(await listAtlassianSites({ token: 'oat', fetch: (...a) => fetch(...a) })).toEqual([
      { id: 'c1', name: 'https://acme.atlassian.net', url: 'https://acme.atlassian.net', scopes: [] },
      { id: 'c2', name: 'Beta', url: 'https://beta.atlassian.net', scopes: ['read:jira-work'] },
    ]);
  });

  it('listAtlassianSites treats an empty body as no sites', async () => {
    server.use(http.get(JIRA_AUTH.accessibleResourcesUrl, () => new HttpResponse(null, { status: 204 })));
    expect(await listAtlassianSites({ token: 'oat' })).toEqual([]);
  });
});

describe('ADF → markdown (extra node types)', () => {
  it('renders inline marks, mentions, emoji, cards, status, dates and media', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'it', marks: [{ type: 'em' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'gone', marks: [{ type: 'strike' }] },
            { type: 'text', text: ' ' },
            { type: 'mention', attrs: { id: 'u1' } },
            { type: 'text', text: ' ' },
            { type: 'mention', attrs: {} },
            { type: 'emoji', attrs: { shortName: ':smile:' } },
            { type: 'emoji', attrs: { text: '🙂' } },
            { type: 'emoji' },
            { type: 'inlineCard', attrs: { url: 'https://card' } },
            { type: 'inlineCard' },
            { type: 'status', attrs: { text: 'DONE' } },
            { type: 'status' },
            { type: 'date', attrs: { timestamp: '1704067200000' } },
            { type: 'date', attrs: { timestamp: 'nope' } },
            { type: 'mediaInline', attrs: { alt: 'pic.png' } },
            { type: 'media' },
            { type: 'unknownInline', content: [{ type: 'text', text: '[x]' }] },
            { type: 'unknownLeaf', text: 'leaf' },
            { type: 'unknownEmpty' },
            { type: 'text' },
            { type: 'text', text: 'L', marks: [{ type: 'link' }, { type: 'underline' }] },
          ],
        },
      ],
    });
    expect(md).toBe(
      '*it* ~~gone~~ @u1 @:smile:🙂https://card[DONE][]2024-01-01[attachment: pic.png][attachment][x]leaf[L]()',
    );
  });

  it('renders tasks, code without language, panels, headings, tables, media groups, expands', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'H6' }] },
        { type: 'heading', attrs: { level: 0 }, content: [{ type: 'text', text: 'H1' }] },
        { type: 'heading', content: [{ type: 'text', text: 'Hdef' }] },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'a' }] },
            { type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'b' }] },
          ],
        },
        { type: 'taskList' },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x' }, { type: 'text' }] },
        { type: 'codeBlock' },
        {
          type: 'panel',
          attrs: { panelType: 'warning' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'p1' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'p2' }] },
          ],
        },
        { type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'i' }] }] },
        { type: 'table', content: [] },
        { type: 'table' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A|B' }] }],
                },
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }],
                },
              ],
            },
            { type: 'tableRow', content: [{ type: 'tableCell' }] },
            { type: 'tableRow' },
          ],
        },
        {
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { alt: 'one' } }, { type: 'media' }],
        },
        { type: 'mediaGroup' },
        {
          type: 'expand',
          attrs: { title: 'More' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hidden' }] }],
        },
        { type: 'nestedExpand', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'n' }] }] },
        { type: 'layoutSection', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'col' }] }] },
        { type: 'mention', attrs: { text: '@Top' } },
        { type: 'paragraph' },
      ],
    });
    expect(md.split('\n\n')).toEqual([
      '###### H6',
      '# H1',
      '# Hdef',
      '- [x] a\n- [ ] b',
      '```\nx\n```',
      // An empty code block renders as "```\n\n```", which the split cuts in two.
      '```',
      '```',
      '> **warning:** p1\n> \n> p2',
      '> **info:** i',
      '| A\\|B | C |\n| --- | --- |\n|  |  |\n|  |  |',
      '[attachment: one] [attachment]',
      '**More**',
      'hidden',
      'n',
      'col',
      '@Top',
    ]);
  });

  it('renders ordered lists with a start number and nested bullet lists / multi-paragraph items', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { order: 3 },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }],
                    },
                  ],
                },
              ],
            },
            { type: 'listItem' },
          ],
        },
      ],
    });
    expect(md).toBe('3. three\n  - b\n4.');
  });

  it('non-ADF inputs become empty strings', () => {
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown(42)).toBe('');
    expect(adfToMarkdown({ foo: 1 })).toBe('');
  });
});

describe('markdown → ADF (extra cases)', () => {
  it('handles CRLF, code fences without a language, empty fences and multi-line "headings"', () => {
    expect(markdownToAdf('```\nplain\n```\r\n\r\n```\n```\n\n## not\nheading\n\n\n')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'codeBlock', content: [{ type: 'text', text: 'plain' }] },
        { type: 'codeBlock', content: [] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '## not' },
            { type: 'hardBreak' },
            { type: 'text', text: 'heading' },
          ],
        },
      ],
    });
    expect(markdownToAdf('')).toEqual({ type: 'doc', version: 1, content: [] });
  });
});
