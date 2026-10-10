import { type HttpClient, ProviderError } from '../http';
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
import { type GlProject, glUser, type GlUser } from './normalize';

export interface GitLabIssueTrackerOptions {
  http: HttpClient;
  host: string;
  accountId?: string;
}

interface GlIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed';
  labels?: string[];
  assignees?: GlUser[];
  author?: GlUser;
  milestone?: { title: string } | null;
  issue_type?: string;
  created_at: string;
  updated_at: string;
  web_url: string;
  user_notes_count?: number;
  references?: { full?: string };
}

const e = encodeURIComponent;
const iidOf = (key: string): string => key.replace(/^#/, '');
const IN_PROGRESS = /^(doing|in[ -]?progress|workflow::in[ -]?(progress|dev)|status::in[ -]?progress)$/i;

/**
 * GitLab issues as an IssueTracker. Scopes are project paths ("group/sub/project"); the empty
 * scope ('' or '*') lists issues across all accessible projects (GET /issues).
 */
export function createGitLabIssueTracker(o: GitLabIssueTrackerOptions): IssueTracker {
  const { http } = o;
  const host = o.host
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/:].*$/, '')
    .toLowerCase();
  let viewerP: Promise<GlUser> | null = null;
  const viewer = (): Promise<GlUser> => {
    if (!viewerP) {
      viewerP = http.get<GlUser>('user');
      viewerP.catch(() => (viewerP = null));
    }
    return viewerP;
  };
  const integration = async (): Promise<IntegrationId> => ({
    kind: 'gitlab',
    host,
    accountId: o.accountId ?? String((await viewer()).id),
  });
  const proj = (scope: string): string => {
    if (!scope.includes('/'))
      throw new ProviderError({ code: 'validation', message: `Invalid GitLab issue scope '${scope}'.` });
    return `projects/${e(scope)}`;
  };
  const scopeOf = (i: GlIssue, fallback: string): string => {
    const full = i.references?.full;
    return full ? full.replace(/#\d+$/, '') : fallback;
  };
  const toIssue = (i: GlIssue, scope: string, integ: IntegrationId): Issue => ({
    tracker: { kind: 'gitlab', integration: integ, scope: scopeOf(i, scope) },
    key: `#${i.iid}`,
    id: String(i.id),
    title: i.title,
    body: i.description ?? '',
    bodyFormat: 'markdown',
    state: i.state,
    stateCategory:
      i.state === 'closed'
        ? 'done'
        : (i.labels ?? []).some((l) => IN_PROGRESS.test(l))
          ? 'in_progress'
          : 'todo',
    type: i.issue_type,
    assignees: (i.assignees ?? []).map(glUser),
    reporter: i.author ? glUser(i.author) : undefined,
    labels: i.labels ?? [],
    milestone: i.milestone?.title,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    webUrl: i.web_url,
    commentsCount: i.user_notes_count,
  });
  async function userIds(names: string[] | undefined): Promise<number[] | undefined> {
    if (names === undefined) return undefined;
    return Promise.all(
      names.map(async (n) => {
        if (/^\d+$/.test(n)) return Number(n);
        const u = (await http.get<GlUser[]>('users', { query: { username: n.replace(/^@/, '') } }))[0];
        if (!u) throw new ProviderError({ code: 'validation', message: `GitLab user '${n}' not found.` });
        return u.id;
      }),
    );
  }

  return {
    kind: 'gitlab',

    async listScopes() {
      const out: Array<{ scope: string; label: string }> = [];
      let pageNo: string | undefined;
      for (let i = 0; i < 5; i++) {
        const res = await http.request<GlProject[]>('projects', {
          query: {
            membership: true,
            with_issues_enabled: true,
            order_by: 'last_activity_at',
            per_page: 100,
            page: pageNo,
          },
        });
        for (const p of res.data) out.push({ scope: p.path_with_namespace, label: p.path_with_namespace });
        pageNo = res.headers.get('x-next-page') || undefined;
        if (!pageNo) break;
      }
      return out;
    },

    async listIssues(scope: string, filter: IssueFilter, cursor?: string): Promise<ListPage<Issue>> {
      const integ = await integration();
      const preset = filter.preset ?? (filter.query ? undefined : 'assigned');
      let search = filter.query;
      if (preset === 'mentioned')
        search = [`@${(await viewer()).username}`, filter.query].filter(Boolean).join(' ');
      const res = await http.request<GlIssue[]>(scope && scope !== '*' ? `${proj(scope)}/issues` : 'issues', {
        query: {
          state: preset ? 'opened' : undefined,
          scope: preset === 'assigned' ? 'assigned_to_me' : preset === 'created' ? 'created_by_me' : 'all',
          search,
          updated_after: filter.updatedSince,
          order_by: 'updated_at',
          sort: 'desc',
          per_page: 50,
          page: cursor,
        },
      });
      const total = res.headers.get('x-total');
      return {
        items: res.data.map((i) => toIssue(i, scope, integ)),
        nextCursor: res.headers.get('x-next-page') || undefined,
        total: total ? Number(total) : undefined,
      };
    },

    async searchMyIssues(opts = {}) {
      const integ = await integration();
      const roles: Array<[string, Involvement]> = [['assigned_to_me', 'assignee']];
      if (opts.includeCreated !== false) roles.push(['created_by_me', 'creator']);
      const want = opts.scopes?.length ? new Set(opts.scopes.map((x) => x.toLowerCase())) : null;
      const lists = await Promise.all(
        roles.map(async ([scope, role]) => {
          const issues = await http.get<GlIssue[]>('issues', {
            query: {
              scope,
              state: 'opened',
              order_by: 'updated_at',
              sort: 'desc',
              per_page: Math.min(opts.limit ?? 50, 100),
            },
          });
          return issues.map((i): MyIssue => ({ issue: toIssue(i, '', integ), involvement: [role] }));
        }),
      );
      const rows = lists.flat().filter((r) => !want || want.has(r.issue.tracker.scope.toLowerCase()));
      return mergeInvolved(rows, (r) => r.issue.id);
    },

    async getIssue(scope, key) {
      const [i, integ] = await Promise.all([
        http.get<GlIssue>(`${proj(scope)}/issues/${e(iidOf(key))}`),
        integration(),
      ]);
      return toIssue(i, scope, integ);
    },

    async createIssue(scope, input) {
      const assignee_ids = await userIds(input.assignees);
      const [i, integ] = await Promise.all([
        http.post<GlIssue>(`${proj(scope)}/issues`, {
          title: input.title,
          description: input.body,
          assignee_ids,
          labels: input.labels?.join(','),
          issue_type: input.type,
        }),
        integration(),
      ]);
      return toIssue(i, scope, integ);
    },

    async updateIssue(scope, key, patch) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.body !== undefined) body.description = patch.body;
      if (patch.labels !== undefined) body.labels = patch.labels.join(',');
      const assignees = await userIds(patch.assignees);
      if (assignees !== undefined) body.assignee_ids = assignees.length ? assignees : [0];
      const [i, integ] = await Promise.all([
        http.put<GlIssue>(`${proj(scope)}/issues/${e(iidOf(key))}`, body),
        integration(),
      ]);
      return toIssue(i, scope, integ);
    },

    async listTransitions(scope, key) {
      const i = await http.get<GlIssue>(`${proj(scope)}/issues/${e(iidOf(key))}`);
      return i.state === 'closed'
        ? [{ id: 'reopen', name: 'Reopen', toCategory: 'todo' as const }]
        : [{ id: 'close', name: 'Close', toCategory: 'done' as const }];
    },

    async transition(scope, key, transitionId) {
      if (transitionId !== 'close' && transitionId !== 'reopen') {
        throw new ProviderError({
          code: 'validation',
          message: `Unknown GitLab issue transition '${transitionId}'.`,
        });
      }
      await http.put(`${proj(scope)}/issues/${e(iidOf(key))}`, { state_event: transitionId });
    },

    async addComment(scope, key, body) {
      await http.post(`${proj(scope)}/issues/${e(iidOf(key))}/notes`, { body });
    },

    async listComments(scope, key) {
      const out: Array<{ id: string; author: ProviderUser; body: string; createdAt: string }> = [];
      let pageNo: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await http.request<
          Array<{ id: number; body: string; created_at: string; author: GlUser; system: boolean }>
        >(`${proj(scope)}/issues/${e(iidOf(key))}/notes`, {
          query: { sort: 'asc', order_by: 'created_at', per_page: 100, page: pageNo },
        });
        for (const n of res.data) {
          if (!n.system)
            out.push({ id: String(n.id), author: glUser(n.author), body: n.body, createdAt: n.created_at });
        }
        pageNo = res.headers.get('x-next-page') || undefined;
        if (!pageNo) break;
      }
      return out;
    },
  };
}
