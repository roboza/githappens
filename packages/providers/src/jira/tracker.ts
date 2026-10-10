import { type HttpClient, ProviderError } from '../http';
import type { IntegrationId, Issue, IssueFilter, IssueTracker, ListPage, ProviderUser } from '../types';
import { mergeInvolved, type Involvement, type MyIssue } from '../types';
import { enc, integrationFor, toIso } from '../bitbucket/shared';
import { adfToMarkdown, markdownToAdf } from './adf';

/**
 * Jira Cloud (REST v3, ADF bodies, `POST /search/jql` with nextPageToken) and Jira Data Center
 * (REST v2, wiki-text bodies, `POST /search` with startAt) — spec 10 §6.2.
 * Scope = project key ('' or '*' = all projects; 'site/KEY' is accepted too).
 */

export interface JiraCloudOptions {
  http: HttpClient;
  /** 'acme.atlassian.net' (or just 'acme'). Used for browse URLs and the integration id. */
  site: string;
  integration?: IntegrationId;
}
export interface JiraDcOptions {
  http: HttpClient;
  host: string;
  integration?: IntegrationId;
}

interface JiraUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName?: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}
interface JiraStatus {
  name: string;
  statusCategory?: { key: 'new' | 'indeterminate' | 'done' | string };
}
export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: JiraStatus;
    issuetype?: { name: string };
    priority?: { name: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    labels?: string[];
    fixVersions?: Array<{ name: string }>;
    created?: string;
    updated?: string;
    comment?: { total?: number };
    sprint?: { name: string } | null;
    customfield_10020?: Array<{ name: string; state?: string }> | null;
  };
}

export const JQL_PRESETS: Record<NonNullable<IssueFilter['preset']>, string> = {
  assigned: 'assignee = currentUser() AND statusCategory != Done',
  created: 'reporter = currentUser()',
  mentioned: '(text ~ currentUser() OR watcher = currentUser())',
  'all-open': 'statusCategory != Done',
};

export function jiraStateCategory(key: string | undefined): Issue['stateCategory'] {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

const projectOf = (scope: string): string => {
  const s = scope.trim();
  if (!s || s === '*') return '';
  return s.split('/').pop() ?? '';
};

const jqlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Builds the JQL for a scope + filter (custom query wins over the preset). */
export function buildJql(scope: string, filter: IssueFilter): string {
  const project = projectOf(scope);
  let base = filter.query?.trim() || JQL_PRESETS[filter.preset ?? 'assigned'];
  let order = 'ORDER BY updated DESC';
  const m = /\s+ORDER\s+BY\s+(.+)$/i.exec(base);
  if (m) {
    order = `ORDER BY ${m[1]}`;
    base = base.slice(0, m.index);
  }
  const clauses = [project ? `project = ${jqlString(project)}` : '', base ? `(${base})` : ''];
  if (filter.updatedSince) {
    const d = new Date(filter.updatedSince);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      clauses.push(`updated >= "${s}"`);
    }
  }
  return `${clauses.filter(Boolean).join(' AND ')} ${order}`.trim();
}

const FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'reporter',
  'issuetype',
  'priority',
  'labels',
  'created',
  'updated',
  'fixVersions',
  'comment',
  'sprint',
  'customfield_10020',
];

function createJiraTracker(o: {
  http: HttpClient;
  flavor: 'cloud' | 'dc';
  webBase: string;
  integration: IntegrationId;
}): IssueTracker {
  const { http, flavor, webBase, integration } = o;
  const cloud = flavor === 'cloud';
  const kind = cloud ? 'jira-cloud' : 'jira-dc';

  const userOf = (u: JiraUser | null | undefined): ProviderUser | undefined =>
    u
      ? {
          id: u.accountId ?? u.key ?? u.name ?? '',
          login: u.name ?? u.accountId ?? u.displayName ?? '',
          name: u.displayName,
          email: u.emailAddress,
          avatarUrl: u.avatarUrls?.['48x48'],
        }
      : undefined;

  const bodyOut = (b: unknown): string =>
    cloud ? adfToMarkdown(b) : typeof b === 'string' ? b : adfToMarkdown(b);
  const bodyIn = (md: string): unknown => (cloud ? markdownToAdf(md) : md);

  function toIssue(scope: string, i: JiraIssue): Issue {
    const f = i.fields;
    const assignee = userOf(f.assignee);
    const sprints = f.customfield_10020 ?? [];
    const sprint =
      f.sprint?.name ?? (sprints.find((s) => s.state === 'active') ?? sprints[sprints.length - 1])?.name;
    return {
      tracker: { kind, integration, scope: scope || i.key.split('-')[0]! },
      key: i.key,
      id: i.id,
      title: f.summary ?? '',
      body: bodyOut(f.description),
      bodyFormat: 'markdown',
      state: f.status?.name ?? '',
      stateCategory: jiraStateCategory(f.status?.statusCategory?.key),
      type: f.issuetype?.name,
      priority: f.priority?.name,
      assignees: assignee ? [assignee] : [],
      reporter: userOf(f.reporter),
      labels: f.labels ?? [],
      sprint,
      fixVersions: f.fixVersions?.map((v) => v.name),
      createdAt: toIso(f.created) ?? '',
      updatedAt: toIso(f.updated) ?? '',
      webUrl: `${webBase}/browse/${i.key}`,
      commentsCount: f.comment?.total,
    };
  }

  const getIssue = async (scope: string, key: string): Promise<Issue> =>
    toIssue(scope, await http.get<JiraIssue>(`issue/${enc(key)}`, { query: { fields: FIELDS.join(',') } }));

  async function issueTypeId(project: string, wanted?: string): Promise<string> {
    const r = await http.get<{
      issueTypes?: Array<{ id: string; name: string; subtask?: boolean }>;
      values?: Array<{ id: string; name: string; subtask?: boolean }>;
    }>(`issue/createmeta/${enc(project)}/issuetypes`);
    const types = r.issueTypes ?? r.values ?? [];
    const pick =
      (wanted && types.find((t) => t.name.toLowerCase() === wanted.toLowerCase())) ||
      types.find((t) => t.name === 'Task') ||
      types.find((t) => !t.subtask);
    if (!pick)
      throw new ProviderError({ code: 'validation', message: `No issue types available in ${project}.` });
    return pick.id;
  }

  const assigneeField = (a: string | undefined) => (a ? (cloud ? { accountId: a } : { name: a }) : null);

  return {
    kind,
    async listScopes() {
      if (cloud) {
        const out: Array<{ scope: string; label: string }> = [];
        let startAt = 0;
        for (let i = 0; i < 20; i++) {
          const r = await http.get<{
            values: Array<{ key: string; name: string }>;
            isLast?: boolean;
            total?: number;
          }>('project/search', { query: { startAt, maxResults: 100, orderBy: 'name' } });
          out.push(...r.values.map((p) => ({ scope: p.key, label: `${p.name} (${p.key})` })));
          startAt += r.values.length;
          if (r.isLast !== false || !r.values.length) break;
        }
        return out;
      }
      const r = await http.get<Array<{ key: string; name: string }>>('project');
      return r.map((p) => ({ scope: p.key, label: `${p.name} (${p.key})` }));
    },

    async listIssues(scope, filter, cursor): Promise<ListPage<Issue>> {
      const jql = buildJql(scope, filter);
      if (cloud) {
        const r = await http.post<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
          'search/jql',
          {
            jql,
            fields: FIELDS,
            maxResults: 50,
            ...(cursor ? { nextPageToken: cursor } : {}),
          },
        );
        return {
          items: r.issues.map((i) => toIssue(projectOf(scope), i)),
          nextCursor:
            r.isLast === false || (r.isLast === undefined && r.nextPageToken) ? r.nextPageToken : undefined,
        };
      }
      const startAt = cursor ? Number(cursor) : 0;
      const r = await http.post<{ issues: JiraIssue[]; startAt: number; maxResults: number; total: number }>(
        'search',
        {
          jql,
          fields: FIELDS,
          startAt,
          maxResults: 50,
        },
      );
      const next = r.startAt + r.issues.length;
      return {
        items: r.issues.map((i) => toIssue(projectOf(scope), i)),
        nextCursor: r.issues.length && next < r.total ? String(next) : undefined,
        total: r.total,
      };
    },

    async searchMyIssues(opts = {}) {
      const projects = opts.scopes?.map(projectOf).filter(Boolean) ?? [];
      const projectClause = projects.length ? `project in (${projects.map(jqlString).join(', ')}) AND ` : '';
      const roles: Array<[string, Involvement]> = [[JQL_PRESETS.assigned, 'assignee']];
      if (opts.includeCreated !== false)
        roles.push(['reporter = currentUser() AND statusCategory != Done', 'creator']);
      const lists = await Promise.all(
        roles.map(async ([jql, role]) => {
          const page = await this.listIssues('', { query: `${projectClause}${jql} ORDER BY updated DESC` });
          return page.items.map((issue): MyIssue => ({ issue, involvement: [role] }));
        }),
      );
      return mergeInvolved(lists.flat(), (r) => r.issue.key);
    },

    getIssue: (scope, key) => getIssue(projectOf(scope), key),

    async createIssue(scope, input) {
      const project = projectOf(scope);
      if (!project)
        throw new ProviderError({
          code: 'validation',
          message: 'Pick a Jira project to create the issue in.',
        });
      const fields: Record<string, unknown> = {
        project: { key: project },
        summary: input.title,
        issuetype: { id: await issueTypeId(project, input.type) },
      };
      if (input.body) fields.description = bodyIn(input.body);
      if (input.labels?.length) fields.labels = input.labels;
      if (input.assignees?.[0]) fields.assignee = assigneeField(input.assignees[0]);
      const r = await http.post<{ id: string; key: string }>('issue', { fields });
      return getIssue(project, r.key);
    },

    async updateIssue(scope, key, patch) {
      const fields: Record<string, unknown> = {};
      if (patch.title !== undefined) fields.summary = patch.title;
      if (patch.body !== undefined) fields.description = bodyIn(patch.body);
      if (patch.labels !== undefined) fields.labels = patch.labels;
      if (patch.assignees !== undefined) fields.assignee = assigneeField(patch.assignees[0]);
      if (Object.keys(fields).length) await http.put(`issue/${enc(key)}`, { fields });
      return getIssue(projectOf(scope), key);
    },

    async listTransitions(_scope, key) {
      const r = await http.get<{
        transitions: Array<{ id: string; name: string; to?: JiraStatus }>;
      }>(`issue/${enc(key)}/transitions`);
      return r.transitions.map((t) => ({
        id: t.id,
        name: t.name,
        toCategory: jiraStateCategory(t.to?.statusCategory?.key),
      }));
    },
    async transition(_scope, key, transitionId) {
      await http.post(`issue/${enc(key)}/transitions`, { transition: { id: transitionId } });
    },
    async addComment(_scope, key, body) {
      await http.post(`issue/${enc(key)}/comment`, { body: bodyIn(body) });
    },
    async listComments(_scope, key) {
      const r = await http.get<{
        comments: Array<{ id: string; author?: JiraUser; body: unknown; created: string }>;
      }>(`issue/${enc(key)}/comment`, { query: { maxResults: 100, orderBy: 'created' } });
      return r.comments.map((c) => ({
        id: c.id,
        author: userOf(c.author) ?? { id: '', login: 'unknown' },
        body: bodyOut(c.body),
        createdAt: toIso(c.created) ?? '',
      }));
    },
  };
}

const normalizeSite = (site: string): string => {
  const s = site.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return s.includes('.') ? s : `${s}.atlassian.net`;
};

/**
 * HttpClient baseUrl: `https://{site}/rest/api/3` (Basic email:apiToken) or
 * `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3` (OAuth 3LO Bearer).
 */
export function createJiraCloudTracker(o: JiraCloudOptions): IssueTracker {
  const site = normalizeSite(o.site);
  return createJiraTracker({
    http: o.http,
    flavor: 'cloud',
    webBase: `https://${site}`,
    integration: integrationFor('jira-cloud', site, o.integration),
  });
}

/** HttpClient baseUrl: `https://{host}/rest/api/2`, Authorization `Bearer {PAT}`. */
export function createJiraDcTracker(o: JiraDcOptions): IssueTracker {
  const webBase = (/^https?:\/\//i.test(o.host) ? o.host : `https://${o.host}`).replace(/\/+$/, '');
  return createJiraTracker({
    http: o.http,
    flavor: 'dc',
    webBase,
    integration: integrationFor('jira-dc', new URL(webBase).hostname, o.integration),
  });
}

/** HttpClient `errorMessage` for Jira payloads (`{ errorMessages: [], errors: {} }`). */
export function jiraErrorMessage(_status: number, body: unknown): string | undefined {
  const b = body as { errorMessages?: string[]; errors?: Record<string, string> } | undefined;
  const parts = [
    ...(b?.errorMessages ?? []),
    ...Object.entries(b?.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  return parts.length ? parts.join('; ') : undefined;
}
