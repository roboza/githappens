import { type HttpClient, ProviderError } from '../http';
import type {
  IntegrationId,
  Involvement,
  Issue,
  IssueFilter,
  IssueTracker,
  ListPage,
  MyIssue,
  ProviderUser,
} from '../types';
import { mergeInvolved } from '../types';
import { enc, integrationFor, toIso } from '../bitbucket/shared';
import { AZURE_API_VERSION } from './devops';

/**
 * Azure Boards (work items) — minimal IssueTracker over WIQL (spec 10 §6.2).
 * Scope = "org/project". Description is HTML (bodyFormat 'html').
 */

export interface AzureBoardsOptions {
  http: HttpClient;
  host: string;
  organization: string;
  integration?: IntegrationId;
}

interface AzWorkItem {
  id: number;
  fields: Record<string, unknown>;
  _links?: { html?: { href: string } };
}
interface AzIdentityRef {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
}

const PAGE = 50;
const DONE = ['Closed', 'Done', 'Removed', 'Resolved', 'Completed'];
const TODO = ['New', 'To Do', 'Proposed', 'Design', 'Open'];

export function azStateCategory(state: string, category?: string): Issue['stateCategory'] {
  // System.StateCategory is not exposed on work items; fall back to well-known state names.
  if (category) {
    if (/completed|removed|resolved/i.test(category)) return 'done';
    if (/proposed/i.test(category)) return 'todo';
    return 'in_progress';
  }
  if (DONE.includes(state)) return 'done';
  if (TODO.includes(state)) return 'todo';
  return 'in_progress';
}

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function wiqlFor(project: string, filter: IssueFilter): string {
  if (filter.query) return filter.query;
  const where = [`[System.TeamProject] = ${quote(project)}`];
  const open = `[System.State] NOT IN ('Closed', 'Done', 'Removed')`;
  switch (filter.preset ?? 'assigned') {
    case 'assigned':
      where.push('[System.AssignedTo] = @Me', open);
      break;
    case 'created':
      where.push('[System.CreatedBy] = @Me');
      break;
    case 'mentioned':
      where.push('[System.Id] IN (@RecentMentions)');
      break;
    case 'all-open':
      where.push(open);
      break;
  }
  if (filter.updatedSince) where.push(`[System.ChangedDate] >= ${quote(filter.updatedSince.slice(0, 10))}`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

const OPEN_CLAUSE = `[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed')`;

/**
 * Org-level WIQL for the Launchpad (spec 11 §6.4 "Work items via WIQL `@Me`"): open work items
 * assigned to / created by the viewer across projects (or only `projects`).
 */
export function myWorkItemsWiql(role: 'assigned' | 'created', projects: string[] = []): string {
  const where = [role === 'assigned' ? '[System.AssignedTo] = @Me' : '[System.CreatedBy] = @Me', OPEN_CLAUSE];
  if (projects.length) where.unshift(`[System.TeamProject] IN (${projects.map(quote).join(', ')})`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

export function createAzureBoardsTracker(o: AzureBoardsOptions): IssueTracker {
  const { http } = o;
  const host = o.host
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const integration = integrationFor('azure-boards', host, o.integration);
  const orgBase = (org: string) =>
    host.endsWith('.visualstudio.com')
      ? `https://${enc(org)}.visualstudio.com`
      : `https://dev.azure.com/${enc(org)}`;
  const split = (scope: string) => {
    const i = scope.indexOf('/');
    return i < 0
      ? { org: o.organization, project: scope }
      : { org: scope.slice(0, i), project: scope.slice(i + 1) };
  };
  const q = (extra: Record<string, string | number | undefined> = {}) => ({
    ...extra,
    'api-version': AZURE_API_VERSION,
  });

  const userOf = (u: unknown): ProviderUser | undefined => {
    if (!u || typeof u !== 'object') return undefined;
    const x = u as AzIdentityRef;
    return {
      id: x.id ?? x.uniqueName ?? '',
      login: x.uniqueName ?? x.displayName ?? '',
      name: x.displayName,
      avatarUrl: x.imageUrl,
    };
  };

  function toIssue(scope: string, w: AzWorkItem): Issue {
    const f = w.fields;
    const { org, project } = split(scope);
    const state = String(f['System.State'] ?? '');
    const assignee = userOf(f['System.AssignedTo']);
    return {
      tracker: { kind: 'azure-boards', integration, scope },
      key: String(w.id),
      id: String(w.id),
      title: String(f['System.Title'] ?? ''),
      body: String(f['System.Description'] ?? ''),
      bodyFormat: 'html',
      state,
      stateCategory: azStateCategory(state),
      type: f['System.WorkItemType'] as string | undefined,
      priority:
        f['Microsoft.VSTS.Common.Priority'] != null ? String(f['Microsoft.VSTS.Common.Priority']) : undefined,
      assignees: assignee ? [assignee] : [],
      reporter: userOf(f['System.CreatedBy']),
      labels: String(f['System.Tags'] ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      sprint: (f['System.IterationPath'] as string | undefined) ?? undefined,
      createdAt: toIso(f['System.CreatedDate'] as string) ?? '',
      updatedAt: toIso(f['System.ChangedDate'] as string) ?? '',
      webUrl: w._links?.html?.href ?? `${orgBase(org)}/${enc(project)}/_workitems/edit/${w.id}`,
      commentsCount:
        typeof f['System.CommentCount'] === 'number' ? (f['System.CommentCount'] as number) : undefined,
    };
  }

  async function fetchItems(scope: string, ids: number[]): Promise<AzWorkItem[]> {
    if (!ids.length) return [];
    const { org } = split(scope);
    const out: AzWorkItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const r = await http.get<{ value: AzWorkItem[] }>(`${orgBase(org)}/_apis/wit/workitems`, {
        query: q({ ids: ids.slice(i, i + 200).join(','), $expand: 'fields' }),
      });
      out.push(...r.value);
    }
    return out;
  }

  return {
    kind: 'azure-boards',
    async listScopes() {
      const r = await http.get<{ value: Array<{ name: string }> }>(
        `${orgBase(o.organization)}/_apis/projects`,
        {
          query: q({ $top: 500 }),
        },
      );
      return r.value.map((p) => ({ scope: `${o.organization}/${p.name}`, label: p.name }));
    },
    async listIssues(scope, filter, cursor): Promise<ListPage<Issue>> {
      const { org, project } = split(scope);
      const r = await http.post<{ workItems: Array<{ id: number }> }>(
        `${orgBase(org)}/${enc(project)}/_apis/wit/wiql`,
        { query: wiqlFor(project, filter) },
        { query: q({ $top: 1000 }) },
      );
      const start = cursor ? Number(cursor) : 0;
      const ids = r.workItems.map((w) => w.id);
      const items = await fetchItems(scope, ids.slice(start, start + PAGE));
      return {
        items: items.map((w) => toIssue(scope, w)),
        nextCursor: start + PAGE < ids.length ? String(start + PAGE) : undefined,
        total: ids.length,
      };
    },
    /** WIQL `@Me` at the organization level (one query per role), spec 11 §6.4. */
    async searchMyIssues(opts = {}) {
      const org = o.organization;
      const projects = (opts.scopes ?? [])
        .map((sc) => split(sc))
        .filter((x) => x.org.toLowerCase() === org.toLowerCase() && x.project)
        .map((x) => x.project);
      const roles: Array<['assigned' | 'created', Involvement]> = [['assigned', 'assignee']];
      if (opts.includeCreated !== false) roles.push(['created', 'creator']);
      const limit = Math.min(opts.limit ?? 100, 200);
      const lists = await Promise.all(
        roles.map(async ([role, inv]) => {
          const r = await http.post<{ workItems: Array<{ id: number }> }>(
            `${orgBase(org)}/_apis/wit/wiql`,
            { query: myWorkItemsWiql(role, projects) },
            { query: q({ $top: limit }) },
          );
          const ids = r.workItems.map((w) => w.id).slice(0, limit);
          const items = await fetchItems(org, ids);
          return items.map((w): MyIssue => {
            const project = String(w.fields['System.TeamProject'] ?? '');
            return { issue: toIssue(project ? `${org}/${project}` : org, w), involvement: [inv] };
          });
        }),
      );
      return mergeInvolved(lists.flat(), (x) => x.issue.id);
    },
    async getIssue(scope, key) {
      const [w] = await fetchItems(scope, [Number(key)]);
      if (!w) throw new ProviderError({ code: 'not_found', message: `Work item ${key} not found.` });
      return toIssue(scope, w);
    },
    async addComment(scope, key, body) {
      const { org, project } = split(scope);
      await http.post(
        `${orgBase(org)}/${enc(project)}/_apis/wit/workItems/${enc(key)}/comments`,
        { text: body },
        {
          query: { 'api-version': '7.1-preview.4' },
        },
      );
    },
    async listComments(scope, key) {
      const { org, project } = split(scope);
      const r = await http.get<{
        comments: Array<{
          id: number | string;
          text?: string;
          createdBy?: AzIdentityRef;
          createdDate?: string;
        }>;
      }>(`${orgBase(org)}/${enc(project)}/_apis/wit/workItems/${enc(key)}/comments`, {
        query: { 'api-version': '7.1-preview.4' },
      });
      return r.comments.map((c) => ({
        id: String(c.id),
        author: userOf(c.createdBy) ?? { id: '', login: 'unknown' },
        body: c.text ?? '',
        createdAt: toIso(c.createdDate) ?? '',
      }));
    },
    async createIssue(scope, input) {
      const { org, project } = split(scope);
      const ops = azWorkItemPatchOps({
        title: input.title,
        body: input.body,
        labels: input.labels,
        assignees: input.assignees,
      });
      const w = await http.post<AzWorkItem>(
        `${orgBase(org)}/${enc(project)}/_apis/wit/workitems/$${enc(input.type ?? 'Task')}`,
        ops,
        { query: q(), headers: JSON_PATCH },
      );
      return toIssue(scope, w);
    },
    async updateIssue(scope, key, patch) {
      const { org } = split(scope);
      const w = await http.patch<AzWorkItem>(
        `${orgBase(org)}/_apis/wit/workitems/${enc(key)}`,
        azWorkItemPatchOps(patch),
        {
          query: q(),
          headers: JSON_PATCH,
        },
      );
      return toIssue(scope, w);
    },
    async listTransitions(scope, key) {
      const { org, project } = split(scope);
      const [w] = await fetchItems(scope, [Number(key)]);
      if (!w) throw new ProviderError({ code: 'not_found', message: `Work item ${key} not found.` });
      const type = String(w.fields['System.WorkItemType'] ?? 'Task');
      const current = String(w.fields['System.State'] ?? '');
      const r = await http.get<{ value: Array<{ name: string; category?: string }> }>(
        `${orgBase(org)}/${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/states`,
        { query: q() },
      );
      return r.value
        .filter((s) => s.name !== current)
        .map((s) => ({ id: s.name, name: s.name, toCategory: azStateCategory(s.name, s.category) }));
    },
    async transition(scope, key, transitionId) {
      const { org } = split(scope);
      await http.patch(
        `${orgBase(org)}/_apis/wit/workitems/${enc(key)}`,
        [{ op: 'add', path: '/fields/System.State', value: transitionId }],
        { query: q(), headers: JSON_PATCH },
      );
    },
  };
}

const JSON_PATCH = { 'Content-Type': 'application/json-patch+json' };

/** JSON-Patch ops for work-item create/update (labels → '; '-joined System.Tags). */
export function azWorkItemPatchOps(
  p: Partial<{ title: string; body: string; labels: string[]; assignees: string[] }>,
): Array<{ op: 'add'; path: string; value: string }> {
  const ops: Array<{ op: 'add'; path: string; value: string }> = [];
  const add = (field: string, value: string) => ops.push({ op: 'add', path: `/fields/${field}`, value });
  if (p.title !== undefined) add('System.Title', p.title);
  if (p.body !== undefined) add('System.Description', p.body);
  if (p.labels !== undefined) add('System.Tags', p.labels.join('; '));
  if (p.assignees !== undefined) add('System.AssignedTo', p.assignees[0] ?? '');
  return ops;
}
