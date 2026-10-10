import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AZURE_AUTH, createAzureBoardsTracker, myWorkItemsWiql } from '../src/azure';
import { HttpClient } from '../src/http';

/** Azure Boards as a Launchpad issue source (spec 11 §6.4: work items via WIQL `@Me`). */

const ORG = 'https://dev.azure.com/acme';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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

const wi = (id: number, project: string, state = 'Active', changed = '2026-10-09T10:00:00Z') => ({
  id,
  fields: {
    'System.Title': `Item ${id}`,
    'System.State': state,
    'System.TeamProject': project,
    'System.WorkItemType': 'Bug',
    'System.ChangedDate': changed,
    'System.CreatedDate': '2026-10-01T00:00:00Z',
    'System.AssignedTo': { id: 'me-id', displayName: 'Me', uniqueName: 'me@acme.com' },
    'Microsoft.VSTS.Common.Priority': 2,
  },
  _links: { html: { href: `${ORG}/${project}/_workitems/edit/${id}` } },
});

describe('myWorkItemsWiql', () => {
  it('builds open @Me queries, optionally restricted to projects', () => {
    expect(myWorkItemsWiql('assigned')).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed') ORDER BY [System.ChangedDate] DESC",
    );
    expect(myWorkItemsWiql('created', ['Web', "O'Brien"])).toContain(
      "[System.TeamProject] IN ('Web', 'O''Brien') AND [System.CreatedBy] = @Me",
    );
  });
});

describe('Azure Boards searchMyIssues', () => {
  it('runs one org-level WIQL per role, fetches the items and merges involvement', async () => {
    const wiql: string[] = [];
    server.use(
      http.post(`${ORG}/_apis/wit/wiql`, async ({ request }) => {
        const { query } = (await request.json()) as { query: string };
        wiql.push(query);
        expect(new URL(request.url).searchParams.get('$top')).toBe('100');
        return HttpResponse.json({
          workItems: query.includes('AssignedTo') ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }],
        });
      }),
      http.get(`${ORG}/_apis/wit/workitems`, ({ request }) => {
        const ids = new URL(request.url).searchParams.get('ids')!.split(',').map(Number);
        return HttpResponse.json({
          value: ids.map((id) => wi(id, id === 3 ? 'Infra' : 'Web')),
        });
      }),
    );
    const rows = await tracker().searchMyIssues!();
    expect(wiql).toHaveLength(2);
    expect(rows.map((r) => [r.issue.key, r.issue.tracker.scope, r.involvement])).toEqual([
      ['1', 'acme/Web', ['assignee']],
      ['2', 'acme/Web', ['assignee', 'creator']],
      ['3', 'acme/Infra', ['creator']],
    ]);
    const i = rows[0]!.issue;
    expect(i.tracker.kind).toBe('azure-boards');
    expect(i.stateCategory).toBe('in_progress');
    expect(i.priority).toBe('2');
    expect(i.webUrl).toBe(`${ORG}/Web/_workitems/edit/1`);
  });

  it('restricts to workspace projects of this organization and skips created when asked', async () => {
    const wiql: string[] = [];
    server.use(
      http.post(`${ORG}/_apis/wit/wiql`, async ({ request }) => {
        wiql.push(((await request.json()) as { query: string }).query);
        return HttpResponse.json({ workItems: [] });
      }),
    );
    const rows = await tracker().searchMyIssues!({
      scopes: ['acme/Web', 'other-org/Nope'],
      includeCreated: false,
    });
    expect(rows).toEqual([]);
    expect(wiql).toEqual([
      expect.stringContaining("[System.TeamProject] IN ('Web') AND [System.AssignedTo] = @Me"),
    ]);
  });

  it('propagates provider errors (Launchpad turns them into chips)', async () => {
    server.use(http.post(`${ORG}/_apis/wit/wiql`, () => new HttpResponse(null, { status: 401 })));
    await expect(tracker().searchMyIssues!()).rejects.toMatchObject({ code: 'auth_required' });
  });
});
