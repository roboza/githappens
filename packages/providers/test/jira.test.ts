import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/http';
import {
  JIRA_AUTH,
  adfToMarkdown,
  buildJql,
  createJiraCloudTracker,
  createJiraDcTracker,
  jiraErrorMessage,
  markdownToAdf,
} from '../src/jira';

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
    http: new HttpClient({ baseUrl: DC, retries: 0, auth: () => 'Bearer pat' }),
    host: 'jira.acme.com',
  });

const ADF = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.y' } }] },
        { type: 'text', text: ' ' },
        { type: 'mention', attrs: { id: 'u1', text: '@Alice' } },
        { type: 'hardBreak' },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
            {
              type: 'orderedList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
    { type: 'rule' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H' }] }] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v' }] }] },
          ],
        },
      ],
    },
  ],
};

const issue = (key: string, cat: string, over: Record<string, unknown> = {}) => ({
  id: key.replace(/\D/g, ''),
  key,
  fields: {
    summary: `Summary ${key}`,
    description: ADF,
    status: {
      name: cat === 'done' ? 'Done' : cat === 'indeterminate' ? 'In Progress' : 'To Do',
      statusCategory: { key: cat },
    },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    assignee: { accountId: 'acc-1', displayName: 'Me', avatarUrls: { '48x48': 'av' } },
    labels: ['x'],
    fixVersions: [{ name: '1.0' }],
    created: '2024-01-01T10:00:00.000+0200',
    updated: '2024-01-02T10:00:00.000+0000',
    comment: { total: 4 },
    customfield_10020: [
      { name: 'Sprint 1', state: 'closed' },
      { name: 'Sprint 2', state: 'active' },
    ],
    ...over,
  },
});

describe('ADF conversion', () => {
  it('converts ADF to markdown-ish text', () => {
    expect(adfToMarkdown(ADF)).toBe(
      [
        '## Title',
        'Hello **bold** and [link](https://x.y) @Alice\n`code`',
        '- one\n- two\n  1. nested',
        '```ts\nconst a = 1;\n```',
        '> quoted',
        '---',
        '| H |\n| --- |\n| v |',
      ].join('\n\n'),
    );
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown('plain')).toBe('plain');
  });

  it('converts markdown back to ADF paragraphs / code / headings', () => {
    expect(markdownToAdf('# H\n\nline1\nline2\n\n```js\nx()\n```')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'line1' }, { type: 'hardBreak' }, { type: 'text', text: 'line2' }],
        },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x()' }] },
      ],
    });
  });
});

describe('JQL presets', () => {
  it('builds preset queries scoped to a project', () => {
    expect(buildJql('ABC', { preset: 'assigned' })).toBe(
      'project = "ABC" AND (assignee = currentUser() AND statusCategory != Done) ORDER BY updated DESC',
    );
    expect(buildJql('', { preset: 'created' })).toBe('(reporter = currentUser()) ORDER BY updated DESC');
    expect(buildJql('acme.atlassian.net/ABC', { preset: 'mentioned' })).toBe(
      'project = "ABC" AND ((text ~ currentUser() OR watcher = currentUser())) ORDER BY updated DESC',
    );
    expect(buildJql('ABC', { preset: 'all-open', updatedSince: '2024-05-06T07:08:00Z' })).toBe(
      'project = "ABC" AND (statusCategory != Done) AND updated >= "2024-05-06 07:08" ORDER BY updated DESC',
    );
    expect(buildJql('ABC', { query: 'labels = ui ORDER BY priority DESC' })).toBe(
      'project = "ABC" AND (labels = ui) ORDER BY priority DESC',
    );
  });
});

describe('Jira Cloud', () => {
  it('searches with /search/jql + nextPageToken and normalizes issues', async () => {
    const seen: any[] = [];
    server.use(
      http.post(`${CLOUD}/search/jql`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe(`Basic ${btoa('me@acme.com:tok')}`);
        const body: any = await request.json();
        seen.push(body);
        if (body.nextPageToken === 'p2')
          return HttpResponse.json({ issues: [issue('ABC-3', 'done')], isLast: true });
        return HttpResponse.json({
          issues: [issue('ABC-1', 'new'), issue('ABC-2', 'indeterminate')],
          nextPageToken: 'p2',
          isLast: false,
        });
      }),
    );
    const t = cloud();
    const p1 = await t.listIssues('ABC', { preset: 'assigned' });
    expect(seen[0].jql).toContain('assignee = currentUser() AND statusCategory != Done');
    expect(p1.items.map((i) => i.stateCategory)).toEqual(['todo', 'in_progress']);
    const i = p1.items[0]!;
    expect(i).toMatchObject({
      key: 'ABC-1',
      title: 'Summary ABC-1',
      bodyFormat: 'markdown',
      state: 'To Do',
      type: 'Bug',
      priority: 'High',
      labels: ['x'],
      fixVersions: ['1.0'],
      sprint: 'Sprint 2',
      commentsCount: 4,
      webUrl: 'https://acme.atlassian.net/browse/ABC-1',
      createdAt: '2024-01-01T08:00:00.000Z',
      tracker: { kind: 'jira-cloud', scope: 'ABC', integration: { host: 'acme.atlassian.net' } },
    });
    expect(i.body.startsWith('## Title')).toBe(true);
    expect(p1.nextCursor).toBe('p2');
    const p2 = await t.listIssues('ABC', { preset: 'assigned' }, p1.nextCursor);
    expect(p2.items[0]!.stateCategory).toBe('done');
    expect(p2.nextCursor).toBeUndefined();
  });

  it('lists and applies transitions', async () => {
    let applied: unknown;
    server.use(
      http.get(`${CLOUD}/issue/ABC-1/transitions`, () =>
        HttpResponse.json({
          transitions: [
            {
              id: '11',
              name: 'Start',
              to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            },
            { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
          ],
        }),
      ),
      http.post(`${CLOUD}/issue/ABC-1/transitions`, async ({ request }) => {
        applied = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = cloud();
    expect(await t.listTransitions!('ABC', 'ABC-1')).toEqual([
      { id: '11', name: 'Start', toCategory: 'in_progress' },
      { id: '31', name: 'Done', toCategory: 'done' },
    ]);
    await t.transition!('ABC', 'ABC-1', '11');
    expect(applied).toEqual({ transition: { id: '11' } });
  });

  it('creates issues with an ADF description and resolved issue type', async () => {
    let created: any;
    server.use(
      http.get(`${CLOUD}/issue/createmeta/ABC/issuetypes`, () =>
        HttpResponse.json({
          issueTypes: [
            { id: '1', name: 'Bug' },
            { id: '2', name: 'Task' },
          ],
        }),
      ),
      http.post(`${CLOUD}/issue`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ id: '9', key: 'ABC-9' }, { status: 201 });
      }),
      http.get(`${CLOUD}/issue/ABC-9`, () => HttpResponse.json(issue('ABC-9', 'new'))),
    );
    const i = await cloud().createIssue!('ABC', { title: 'New', body: 'hello', assignees: ['acc-1'] });
    expect(created.fields).toEqual({
      project: { key: 'ABC' },
      summary: 'New',
      issuetype: { id: '2' },
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      },
      assignee: { accountId: 'acc-1' },
    });
    expect(i.key).toBe('ABC-9');
  });

  it('comments are converted both ways', async () => {
    let posted: any;
    server.use(
      http.post(`${CLOUD}/issue/ABC-1/comment`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: '1' }, { status: 201 });
      }),
      http.get(`${CLOUD}/issue/ABC-1/comment`, () =>
        HttpResponse.json({
          comments: [
            {
              id: '5',
              author: { accountId: 'a', displayName: 'A' },
              body: ADF,
              created: '2024-01-01T00:00:00.000+0000',
            },
          ],
        }),
      ),
    );
    const t = cloud();
    await t.addComment!('ABC', 'ABC-1', 'hi');
    expect(posted.body.type).toBe('doc');
    const comments = await t.listComments!('ABC', 'ABC-1');
    expect(comments[0]!.body.startsWith('## Title')).toBe(true);
  });

  it('maps 401 / 429 and surfaces Jira error messages', async () => {
    server.use(
      http.get(`${CLOUD}/issue/ABC-1`, () => HttpResponse.json({ errorMessages: ['nope'] }, { status: 401 })),
      http.get(`${CLOUD}/issue/ABC-2`, () =>
        HttpResponse.json(
          { errorMessages: ['slow down'] },
          { status: 429, headers: { 'retry-after': '10' } },
        ),
      ),
      http.get(`${CLOUD}/issue/ABC-3`, () =>
        HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 }),
      ),
    );
    const t = cloud();
    await expect(t.getIssue('ABC', 'ABC-1')).rejects.toMatchObject({ code: 'auth_required' });
    await expect(t.getIssue('ABC', 'ABC-2')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(t.getIssue('ABC', 'ABC-3')).rejects.toMatchObject({
      code: 'not_found',
      serialized: { providerMessage: 'Issue does not exist' },
    });
  });
});

describe('Jira Data Center', () => {
  it('searches with startAt paging and keeps wiki text bodies', async () => {
    server.use(
      http.post(`${DC}/search`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer pat');
        const body: any = await request.json();
        if (body.startAt === 2)
          return HttpResponse.json({
            issues: [issue('DEV-3', 'new', { description: 'h1. Wiki' })],
            startAt: 2,
            maxResults: 50,
            total: 3,
          });
        return HttpResponse.json({
          issues: [
            issue('DEV-1', 'new', {
              description: 'plain *wiki*',
              assignee: { name: 'jdoe', displayName: 'J' },
            }),
            issue('DEV-2', 'done', { description: null }),
          ],
          startAt: 0,
          maxResults: 50,
          total: 3,
        });
      }),
    );
    const t = dc();
    const p1 = await t.listIssues('DEV', { preset: 'created' });
    expect(p1.items[0]).toMatchObject({
      body: 'plain *wiki*',
      assignees: [{ login: 'jdoe' }],
      webUrl: 'https://jira.acme.com/browse/DEV-1',
    });
    expect(p1.items[0]!.tracker.kind).toBe('jira-dc');
    expect(p1.nextCursor).toBe('2');
    expect(p1.total).toBe(3);
    const p2 = await t.listIssues('DEV', { preset: 'created' }, p1.nextCursor);
    expect(p2.items[0]!.body).toBe('h1. Wiki');
    expect(p2.nextCursor).toBeUndefined();
  });

  it('lists projects and comments as plain text', async () => {
    let posted: unknown;
    server.use(
      http.get(`${DC}/project`, () => HttpResponse.json([{ key: 'DEV', name: 'Development' }])),
      http.post(`${DC}/issue/DEV-1/comment`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: '1' });
      }),
    );
    const t = dc();
    expect(await t.listScopes()).toEqual([{ scope: 'DEV', label: 'Development (DEV)' }]);
    await t.addComment!('DEV', 'DEV-1', 'hello');
    expect(posted).toEqual({ body: 'hello' });
  });
});
