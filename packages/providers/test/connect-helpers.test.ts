import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { revokeToken } from '../src/auth';
import { AZURE_AUTH, createAzureBoardsTracker, listAzureOrganizations } from '../src/azure';
import { HttpClient, ProviderError } from '../src/http';
import { JIRA_AUTH, createJiraCloudTracker, listAtlassianSites } from '../src/jira';

/** Connect/disconnect helpers: token revocation, Atlassian sites, Azure orgs (spec 10 §6.1). */

const BROKER = 'https://broker.example.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('revokeToken', () => {
  it('revokes GitLab tokens directly (form-encoded, public client)', async () => {
    let form: URLSearchParams | undefined;
    let ct: string | null = null;
    server.use(
      http.post('https://gitlab.example.com/oauth/revoke', async ({ request }) => {
        ct = request.headers.get('content-type');
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({});
      }),
    );
    await expect(
      revokeToken({ kind: 'gitlab', host: 'https://gitlab.example.com/', token: 't1', clientId: 'cid' }),
    ).resolves.toBe('revoked');
    expect(ct).toContain('application/x-www-form-urlencoded');
    expect(form?.get('token')).toBe('t1');
    expect(form?.get('client_id')).toBe('cid');
  });

  it('defaults GitLab to gitlab.com and surfaces errors', async () => {
    server.use(http.post('https://gitlab.com/oauth/revoke', () => HttpResponse.json({}, { status: 500 })));
    await expect(revokeToken({ kind: 'gitlab', token: 't' })).rejects.toBeInstanceOf(ProviderError);
  });

  it.each([
    ['github', 'github'],
    ['bitbucket', 'bitbucket'],
    ['jira-cloud', 'atlassian'],
    ['atlassian', 'atlassian'],
  ])('revokes %s through the broker (/revoke/%s)', async (kind, provider) => {
    let body: unknown;
    server.use(
      http.post(`${BROKER}/revoke/${provider}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ revoked: true });
      }),
    );
    await expect(revokeToken({ kind, token: 'tok', brokerUrl: `${BROKER}/` })).resolves.toBe('revoked');
    expect(body).toEqual({ token: 'tok' });
  });

  it('maps broker 501 to unsupported and other failures to ProviderError', async () => {
    server.use(
      http.post(`${BROKER}/revoke/github`, () =>
        HttpResponse.json({ error: 'unsupported' }, { status: 501 }),
      ),
      http.post(`${BROKER}/revoke/bitbucket`, () => HttpResponse.json({ message: 'boom' }, { status: 502 })),
      http.post(`${BROKER}/revoke/atlassian`, () => HttpResponse.json({ revoked: false })),
    );
    await expect(revokeToken({ kind: 'github', token: 't', brokerUrl: BROKER })).resolves.toBe('unsupported');
    await expect(revokeToken({ kind: 'jira-cloud', token: 't', brokerUrl: BROKER })).resolves.toBe(
      'unsupported',
    );
    await expect(revokeToken({ kind: 'bitbucket', token: 't', brokerUrl: BROKER })).rejects.toMatchObject({
      code: 'server',
    });
  });

  it('returns unsupported without a broker, for Azure and unknown kinds', async () => {
    await expect(revokeToken({ kind: 'github', token: 't' })).resolves.toBe('unsupported');
    await expect(revokeToken({ kind: 'azure-devops', token: 't', brokerUrl: BROKER })).resolves.toBe(
      'unsupported',
    );
    await expect(revokeToken({ kind: 'azure-boards', token: 't' })).resolves.toBe('unsupported');
    await expect(revokeToken({ kind: 'trello', token: 't', brokerUrl: BROKER })).resolves.toBe('unsupported');
  });
});

describe('listAtlassianSites', () => {
  it('lists accessible resources with the bearer token', async () => {
    let auth: string | null = null;
    server.use(
      http.get(JIRA_AUTH.accessibleResourcesUrl, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json([
          { id: 'cloud-1', name: 'acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
          { id: 'cloud-2', url: 'https://beta.atlassian.net' },
        ]);
      }),
    );
    expect(await listAtlassianSites({ token: 'oat' })).toEqual([
      { id: 'cloud-1', name: 'acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
      { id: 'cloud-2', name: 'https://beta.atlassian.net', url: 'https://beta.atlassian.net', scopes: [] },
    ]);
    expect(auth).toBe('Bearer oat');
  });

  it('maps 401 to auth_required', async () => {
    server.use(http.get(JIRA_AUTH.accessibleResourcesUrl, () => new HttpResponse(null, { status: 401 })));
    await expect(listAtlassianSites({ token: 'bad' })).rejects.toMatchObject({ code: 'auth_required' });
  });
});

describe('Jira Cloud tracker over the OAuth (cloudId) base', () => {
  it('calls api.atlassian.com/ex/jira/{cloudId} but builds web links on the site', async () => {
    const base = JIRA_AUTH.oauthApiBaseUrl('cloud-1');
    expect(base).toBe('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3');
    server.use(
      http.get(`${base}/issue/ABC-1`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer oat');
        return HttpResponse.json({
          id: '10001',
          key: 'ABC-1',
          fields: {
            summary: 'Fix it',
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            created: '2026-10-01T00:00:00.000+0000',
            updated: '2026-10-02T00:00:00.000+0000',
          },
        });
      }),
    );
    const t = createJiraCloudTracker({
      http: new HttpClient({ baseUrl: base, retries: 0, auth: () => JIRA_AUTH.authHeader('oat') }),
      site: 'https://acme.atlassian.net/',
    });
    const issue = await t.getIssue('ABC', 'ABC-1');
    expect(issue.webUrl).toBe('https://acme.atlassian.net/browse/ABC-1');
    expect(JSON.stringify(issue.tracker.integration)).toContain('acme.atlassian.net');
    expect(issue.stateCategory).toBe('todo');
  });
});

describe('listAzureOrganizations', () => {
  it('resolves the member id then lists accounts', async () => {
    const VSSPS = 'https://app.vssps.visualstudio.com';
    server.use(
      http.get(`${VSSPS}/_apis/profile/profiles/me`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('api-version')).toBe('7.1');
        return HttpResponse.json({ id: 'member-1', displayName: 'Me' });
      }),
      http.get(`${VSSPS}/_apis/accounts`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('memberId')).toBe('member-1');
        return HttpResponse.json({
          count: 2,
          value: [
            { accountId: 'a1', accountName: 'acme', accountUri: 'https://acme.vssps.visualstudio.com/' },
            { accountId: 'a2', accountName: 'beta corp' },
          ],
        });
      }),
    );
    const orgs = await listAzureOrganizations(
      new HttpClient({
        baseUrl: 'https://dev.azure.com',
        retries: 0,
        auth: () => AZURE_AUTH.authHeader('pat'),
      }),
    );
    expect(orgs).toEqual([
      { id: 'a1', name: 'acme', url: 'https://dev.azure.com/acme' },
      { id: 'a2', name: 'beta corp', url: 'https://dev.azure.com/beta%20corp' },
    ]);
  });
});

describe('Azure Boards write parity', () => {
  const ORG = 'https://dev.azure.com/acme';
  const tracker = () =>
    createAzureBoardsTracker({
      http: new HttpClient({
        baseUrl: 'https://dev.azure.com',
        retries: 0,
        auth: () => AZURE_AUTH.authHeader('pat'),
      }),
      host: 'dev.azure.com',
      organization: 'acme',
    });
  const item = (id: number, fields: Record<string, unknown> = {}) => ({
    id,
    fields: {
      'System.Title': 'T',
      'System.State': 'New',
      'System.WorkItemType': 'Bug',
      'System.CreatedDate': '2026-10-01T00:00:00Z',
      'System.ChangedDate': '2026-10-02T00:00:00Z',
      ...fields,
    },
  });

  it('creates a work item with a JSON-Patch body', async () => {
    let ct: string | null = null;
    let ops: unknown;
    server.use(
      http.post(`${ORG}/Web/_apis/wit/workitems/:type`, async ({ request, params }) => {
        expect(params.type).toBe('$Bug');
        ct = request.headers.get('content-type');
        ops = await request.json();
        return HttpResponse.json(item(42, { 'System.Title': 'New bug', 'System.Tags': 'a; b' }));
      }),
    );
    const issue = await tracker().createIssue!('acme/Web', {
      title: 'New bug',
      body: '<p>x</p>',
      type: 'Bug',
      labels: ['a', 'b'],
      assignees: ['me@acme.com'],
    });
    expect(ct).toBe('application/json-patch+json');
    expect(ops).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'New bug' },
      { op: 'add', path: '/fields/System.Description', value: '<p>x</p>' },
      { op: 'add', path: '/fields/System.Tags', value: 'a; b' },
      { op: 'add', path: '/fields/System.AssignedTo', value: 'me@acme.com' },
    ]);
    expect(issue).toMatchObject({ key: '42', title: 'New bug', labels: ['a', 'b'] });
    expect(issue.webUrl).toBe(`${ORG}/Web/_workitems/edit/42`);
  });

  it('defaults the created type to Task', async () => {
    server.use(
      http.post(`${ORG}/Web/_apis/wit/workitems/:type`, ({ params }) => {
        expect(params.type).toBe('$Task');
        return HttpResponse.json(item(43));
      }),
    );
    expect((await tracker().createIssue!('Web', { title: 'x' })).key).toBe('43');
  });

  it('updates a work item and returns it', async () => {
    let ops: unknown;
    server.use(
      http.patch(`${ORG}/_apis/wit/workitems/7`, async ({ request }) => {
        expect(request.headers.get('content-type')).toBe('application/json-patch+json');
        ops = await request.json();
        return HttpResponse.json(item(7, { 'System.Title': 'Renamed' }));
      }),
    );
    const issue = await tracker().updateIssue!('acme/Web', '7', { title: 'Renamed', assignees: [] });
    expect(ops).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Renamed' },
      { op: 'add', path: '/fields/System.AssignedTo', value: '' },
    ]);
    expect(issue.title).toBe('Renamed');
  });

  it('lists transitions from the type states, minus the current one', async () => {
    server.use(
      http.get(`${ORG}/_apis/wit/workitems`, () =>
        HttpResponse.json({ value: [item(7, { 'System.State': 'Active' })] }),
      ),
      http.get(`${ORG}/Web/_apis/wit/workitemtypes/Bug/states`, () =>
        HttpResponse.json({
          value: [
            { name: 'New', category: 'Proposed' },
            { name: 'Active', category: 'InProgress' },
            { name: 'Resolved', category: 'Resolved' },
            { name: 'Closed', category: 'Completed' },
          ],
        }),
      ),
    );
    expect(await tracker().listTransitions!('acme/Web', '7')).toEqual([
      { id: 'New', name: 'New', toCategory: 'todo' },
      { id: 'Resolved', name: 'Resolved', toCategory: 'done' },
      { id: 'Closed', name: 'Closed', toCategory: 'done' },
    ]);
  });

  it('listTransitions → not_found for a missing item', async () => {
    server.use(http.get(`${ORG}/_apis/wit/workitems`, () => HttpResponse.json({ value: [] })));
    await expect(tracker().listTransitions!('acme/Web', '9')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('transitions by patching System.State', async () => {
    let ops: unknown;
    server.use(
      http.patch(`${ORG}/_apis/wit/workitems/7`, async ({ request }) => {
        ops = await request.json();
        return HttpResponse.json(item(7, { 'System.State': 'Closed' }));
      }),
    );
    await tracker().transition!('acme/Web', '7', 'Closed');
    expect(ops).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Closed' }]);
  });

  it('lists comments', async () => {
    server.use(
      http.get(`${ORG}/Web/_apis/wit/workItems/7/comments`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('api-version')).toBe('7.1-preview.4');
        return HttpResponse.json({
          comments: [
            {
              id: 1,
              text: '<p>hi</p>',
              createdBy: { id: 'u1', displayName: 'Ann', uniqueName: 'ann@acme.com' },
              createdDate: '2026-10-03T00:00:00Z',
            },
            { id: 2 },
          ],
        });
      }),
    );
    expect(await tracker().listComments!('acme/Web', '7')).toEqual([
      {
        id: '1',
        author: { id: 'u1', login: 'ann@acme.com', name: 'Ann', avatarUrl: undefined },
        body: '<p>hi</p>',
        createdAt: '2026-10-03T00:00:00.000Z',
      },
      { id: '2', author: { id: '', login: 'unknown' }, body: '', createdAt: '' },
    ]);
  });
});
