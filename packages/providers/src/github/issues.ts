import { type HttpClient, parseLinkHeader, ProviderError } from '../http';
import {
  mergeInvolved,
  type IntegrationId,
  type Involvement,
  type Issue,
  type IssueFilter,
  type IssueTracker,
  type ListPage,
  type MyIssue,
  type ProviderUser,
} from '../types';
import { searchQueries } from './graphql';
import { type GhRestRepo, type GhRestUser, restUser } from './normalize';

export interface GitHubIssueTrackerOptions {
  http: HttpClient;
  host: string;
  accountId?: string;
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  labels: Array<string | { name: string }>;
  assignees?: GhRestUser[];
  user?: GhRestUser;
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments?: number;
  repository_url?: string;
  pull_request?: unknown;
}

const e = encodeURIComponent;
const issueNumber = (key: string): string => key.replace(/^#/, '');

/**
 * GitHub Issues as an IssueTracker. Scopes are repo full names ("owner/repo"); the empty scope
 * ('' or '*') searches across every repository the user can see. Pull requests are excluded.
 */
export function createGitHubIssueTracker(o: GitHubIssueTrackerOptions): IssueTracker {
  const { http } = o;
  const host = o.host
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/:].*$/, '')
    .toLowerCase();
  let accountP: Promise<string> | null = null;
  const integration = async (): Promise<IntegrationId> => {
    accountP ??= o.accountId
      ? Promise.resolve(o.accountId)
      : http.get<GhRestUser>('user').then((u) => String(u.id));
    return { kind: 'github', host, accountId: await accountP };
  };
  const repoPath = (scope: string): string => {
    const [owner, name] = scope.split('/');
    if (!owner || !name)
      throw new ProviderError({ code: 'validation', message: `Invalid GitHub issue scope '${scope}'.` });
    return `repos/${e(owner)}/${e(name)}`;
  };
  const scopeOf = (i: GhIssue, fallback: string): string =>
    i.repository_url ? (i.repository_url.split('/repos/')[1] ?? fallback) : fallback;

  const toIssue = (i: GhIssue, scope: string, integ: IntegrationId): Issue => ({
    tracker: { kind: 'github', integration: integ, scope: scopeOf(i, scope) },
    key: `#${i.number}`,
    id: String(i.id),
    title: i.title,
    body: i.body ?? '',
    bodyFormat: 'markdown',
    state: i.state === 'closed' && i.state_reason ? `closed (${i.state_reason})` : i.state,
    stateCategory: i.state === 'closed' ? 'done' : 'todo',
    assignees: (i.assignees ?? []).map(restUser),
    reporter: i.user ? restUser(i.user) : undefined,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    milestone: i.milestone?.title,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    webUrl: i.html_url,
    commentsCount: i.comments,
  });

  return {
    kind: 'github',

    async listScopes() {
      const out: Array<{ scope: string; label: string }> = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const res = await http.request<GhRestRepo[]>(
          'user/repos',
          cursor
            ? { url: cursor }
            : {
                query: {
                  per_page: 100,
                  sort: 'updated',
                  affiliation: 'owner,collaborator,organization_member',
                },
              },
        );
        for (const r of res.data)
          if (r.has_issues !== false) out.push({ scope: r.full_name, label: r.full_name });
        cursor = parseLinkHeader(res.headers.get('link')).next;
        if (!cursor) break;
      }
      return out;
    },

    async listIssues(scope: string, filter: IssueFilter, cursor?: string): Promise<ListPage<Issue>> {
      const integ = await integration();
      const parts = ['is:issue'];
      if (scope && scope !== '*') parts.push(`repo:${scope}`);
      switch (filter.preset ?? (filter.query ? undefined : 'assigned')) {
        case 'assigned':
          parts.push('is:open', 'assignee:@me');
          break;
        case 'created':
          parts.push('is:open', 'author:@me');
          break;
        case 'mentioned':
          parts.push('is:open', 'mentions:@me');
          break;
        case 'all-open':
          parts.push('is:open');
          break;
      }
      if (filter.query) parts.push(filter.query);
      if (filter.updatedSince) parts.push(`updated:>=${filter.updatedSince.slice(0, 19)}`);
      const res = await http.request<{ total_count: number; items: GhIssue[] }>(
        'search/issues',
        cursor
          ? { url: cursor }
          : { query: { q: parts.join(' '), per_page: 50, sort: 'updated', order: 'desc' } },
      );
      return {
        items: res.data.items.filter((i) => !i.pull_request).map((i) => toIssue(i, scope, integ)),
        nextCursor: parseLinkHeader(res.headers.get('link')).next,
        total: res.data.total_count,
      };
    },

    async searchMyIssues(opts = {}) {
      const integ = await integration();
      const roles: Array<[string, Involvement]> = [['assignee:@me', 'assignee']];
      if (opts.includeCreated !== false) roles.push(['author:@me', 'creator']);
      const repos = opts.scopes
        ?.map((x) => x.split('/'))
        .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
        .map(([owner, name]) => ({ owner, name }));
      const calls = roles.flatMap(([term, role]) =>
        searchQueries(`is:open is:issue archived:false ${term}`, repos).map(async (q) => {
          const r = await http.get<{ items: GhIssue[] }>('search/issues', {
            query: { q, per_page: Math.min(opts.limit ?? 50, 100), sort: 'updated', order: 'desc' },
          });
          return r.items
            .filter((i) => !i.pull_request)
            .map((i): MyIssue => ({ issue: toIssue(i, '', integ), involvement: [role] }));
        }),
      );
      const rows = (await Promise.all(calls)).flat();
      return mergeInvolved(rows, (r) => `${r.issue.tracker.scope}${r.issue.key}`);
    },

    async getIssue(scope, key) {
      const [i, integ] = await Promise.all([
        http.get<GhIssue>(`${repoPath(scope)}/issues/${e(issueNumber(key))}`),
        integration(),
      ]);
      return toIssue(i, scope, integ);
    },

    async createIssue(scope, input) {
      const [i, integ] = await Promise.all([
        http.post<GhIssue>(`${repoPath(scope)}/issues`, {
          title: input.title,
          body: input.body,
          assignees: input.assignees,
          labels: input.labels,
        }),
        integration(),
      ]);
      return toIssue(i, scope, integ);
    },

    async updateIssue(scope, key, patch) {
      const [i, integ] = await Promise.all([
        http.patch<GhIssue>(`${repoPath(scope)}/issues/${e(issueNumber(key))}`, patch),
        integration(),
      ]);
      return toIssue(i, scope, integ);
    },

    async listTransitions(scope, key) {
      const i = await http.get<GhIssue>(`${repoPath(scope)}/issues/${e(issueNumber(key))}`);
      return i.state === 'open'
        ? [
            { id: 'close', name: 'Close as completed', toCategory: 'done' as const },
            { id: 'close:not_planned', name: 'Close as not planned', toCategory: 'done' as const },
          ]
        : [{ id: 'reopen', name: 'Reopen', toCategory: 'todo' as const }];
    },

    async transition(scope, key, transitionId) {
      const body =
        transitionId === 'reopen'
          ? { state: 'open' }
          : {
              state: 'closed',
              state_reason: transitionId === 'close:not_planned' ? 'not_planned' : 'completed',
            };
      await http.patch(`${repoPath(scope)}/issues/${e(issueNumber(key))}`, body);
    },

    async addComment(scope, key, body) {
      await http.post(`${repoPath(scope)}/issues/${e(issueNumber(key))}/comments`, { body });
    },

    async listComments(scope, key) {
      const out: Array<{ id: string; author: ProviderUser; body: string; createdAt: string }> = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await http.request<
          Array<{ id: number; body: string; created_at: string; user: GhRestUser }>
        >(
          `${repoPath(scope)}/issues/${e(issueNumber(key))}/comments`,
          cursor ? { url: cursor } : { query: { per_page: 100 } },
        );
        out.push(
          ...res.data.map((c) => ({
            id: String(c.id),
            author: restUser(c.user),
            body: c.body,
            createdAt: c.created_at,
          })),
        );
        cursor = parseLinkHeader(res.headers.get('link')).next;
        if (!cursor) break;
      }
      return out;
    },
  };
}
