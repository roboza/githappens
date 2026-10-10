import { createHash } from 'node:crypto';
import { type HttpClient, ProviderError, parseLinkHeader, parseRemoteUrl } from '../http';
import { mergeInvolved } from '../types';
import { createGitHubInsights } from './insights';
import type {
  CheckRun,
  CreatePrInput,
  HostingProvider,
  IntegrationId,
  Involvement,
  MergeMethod,
  MyPullRequest,
  PrFilter,
  ProviderCapabilities,
  ProviderUser,
  PullRequest,
  RepoRef,
  TimelineItem,
  UpdatePrInput,
} from '../types';
import {
  buildMyPrsQuery,
  gql,
  M_AUTO_MERGE,
  M_AUTO_MERGE_OFF,
  M_DRAFT,
  M_READY,
  M_RESOLVE,
  M_THREAD_REPLY,
  M_UNRESOLVE,
  Q_ASSIGNABLE,
  Q_PR,
  Q_PR_ID,
  Q_PR_LIST,
  Q_PR_SEARCH,
  Q_TIMELINE,
  searchQueries,
} from './graphql';
import {
  checkStatus,
  type GhCheckRun,
  type GhRestRepo,
  type GhRestUser,
  type GhStatus,
  type GqlActor,
  type GqlPr,
  type GqlThread,
  gqlPr,
  gqlTimeline,
  gqlUser,
  restCheckRun,
  restRepo,
  restStatus,
  restUser,
} from './normalize';

export interface GitHubProviderOptions {
  /** HttpClient whose baseUrl is the REST API base (https://api.github.com or https://{host}/api/v3). */
  http: HttpClient;
  /** 'github.com' or the GHE host. */
  host: string;
  /** Defaults to https://api.github.com/graphql or https://{host}/api/graphql (derived from http.baseUrl). */
  graphqlUrl?: string;
  /** Provider user id of the connected account (avoids a GET /user to build RepoRefs). */
  accountId?: string;
}

export const GITHUB_CAPABILITIES: ProviderCapabilities = {
  oauth: true,
  pat: true,
  graphql: true,
  prDraft: true,
  prLabels: true,
  prAssignees: true,
  prMilestone: true,
  prTeamsAsReviewers: true,
  prTemplates: true,
  prAutoMerge: true,
  prStacks: false,
  reviewThreadsResolve: true,
  mergeMethods: ['merge', 'squash', 'rebase'],
  sshKeyUpload: true,
  forkList: true,
  createRepo: true,
  ci: true,
  ciRerun: true,
  issues: true,
  prRefspec: 'refs/pull/{n}/head',
};

const e = encodeURIComponent;
const hostname = (h: string): string =>
  h
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/:].*$/, '')
    .toLowerCase();

/** GraphQL endpoint for a REST base: api.github.com → /graphql, {host}/api/v3 → {host}/api/graphql. */
export function githubGraphqlUrl(restBase: string): string {
  const b = restBase.replace(/\/+$/, '');
  return /\/api\/v3$/.test(b) ? b.replace(/\/api\/v3$/, '/api/graphql') : `${b}/graphql`;
}

/** Pure remote-URL matcher for a GitHub host (https / ssh / scp-like). */
export function matchGitHubRemoteUrl(host: string, url: string): Omit<RepoRef, 'integration'> | null {
  const p = parseRemoteUrl(url);
  if (!p) return null;
  const want = hostname(host);
  const got = p.host;
  const ok =
    got === want || (want === 'github.com' && (got === 'www.github.com' || got === 'ssh.github.com'));
  if (!ok) return null;
  const parts = p.path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/i, '') };
}

/** OpenSSH-style SHA256 fingerprint of a public key line. */
export function sshFingerprint(publicKey: string): string | undefined {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) return undefined;
  try {
    return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
  } catch {
    return undefined;
  }
}

const MERGE_METHODS: Partial<Record<MergeMethod, 'merge' | 'squash' | 'rebase'>> = {
  merge: 'merge',
  squash: 'squash',
  rebase: 'rebase',
};

export function createGitHubProvider(o: GitHubProviderOptions): HostingProvider {
  const { http } = o;
  const host = hostname(o.host) === 'api.github.com' ? 'github.com' : hostname(o.host);
  const graphqlUrl = o.graphqlUrl ?? githubGraphqlUrl(http.baseUrl);
  const q = <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> =>
    gql<T>(http, graphqlUrl, query, variables);
  const repoPath = (r: { owner: string; name: string }): string => `repos/${e(r.owner)}/${e(r.name)}`;

  let viewerP: Promise<ProviderUser> | null = null;
  const viewer = (): Promise<ProviderUser> => {
    viewerP ??= http.get<GhRestUser>('user').then(restUser);
    viewerP.catch(() => (viewerP = null));
    return viewerP;
  };
  const integration = async (): Promise<IntegrationId> => ({
    kind: 'github',
    host,
    accountId: o.accountId ?? (await viewer()).id,
  });

  async function page<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    cursor?: string,
  ): Promise<{ data: T; next?: string; headers: Headers }> {
    const res = await http.request<T>(path, cursor ? { url: cursor } : { query });
    return { data: res.data, next: parseLinkHeader(res.headers.get('link')).next, headers: res.headers };
  }
  async function all<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    maxPages = 10,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const p = await page<T[]>(path, { per_page: 100, ...query }, cursor);
      out.push(...(p.data ?? []));
      if (!p.next) break;
      cursor = p.next;
    }
    return out;
  }
  const notFoundToEmpty = <T>(p: Promise<T>, empty: T): Promise<T> =>
    p.catch((err: unknown) => {
      if (err instanceof ProviderError && err.code === 'not_found') return empty;
      throw err;
    });

  async function fetchPr(ref: RepoRef, number: number): Promise<PullRequest> {
    const d = await q<{ viewer: { login: string }; repository: { pullRequest: GqlPr | null } | null }>(Q_PR, {
      owner: ref.owner,
      name: ref.name,
      number,
    });
    const n = d.repository?.pullRequest;
    if (!n) throw new ProviderError({ code: 'not_found', message: `Pull request #${number} not found.` });
    return gqlPr(n, ref, d.viewer.login);
  }
  async function prNodeId(ref: RepoRef, number: number): Promise<string> {
    const d = await q<{ repository: { pullRequest: { id: string } | null } | null }>(Q_PR_ID, {
      owner: ref.owner,
      name: ref.name,
      number,
    });
    const id = d.repository?.pullRequest?.id;
    if (!id) throw new ProviderError({ code: 'not_found', message: `Pull request #${number} not found.` });
    return id;
  }

  async function syncReviewers(
    ref: RepoRef,
    number: number,
    users?: string[],
    teams?: string[],
  ): Promise<void> {
    if (users === undefined && teams === undefined) return;
    const cur = await http.get<{ users: GhRestUser[]; teams: Array<{ slug: string }> }>(
      `${repoPath(ref)}/pulls/${number}/requested_reviewers`,
    );
    const lc = (s: string): string => s.toLowerCase();
    const curUsers = cur.users.map((u) => u.login);
    const curTeams = cur.teams.map((t) => t.slug);
    const add = {
      reviewers: users ? users.filter((u) => !curUsers.map(lc).includes(lc(u))) : [],
      team_reviewers: teams ? teams.filter((t) => !curTeams.map(lc).includes(lc(t))) : [],
    };
    const remove = {
      reviewers: users ? curUsers.filter((u) => !users.map(lc).includes(lc(u))) : [],
      team_reviewers: teams ? curTeams.filter((t) => !teams.map(lc).includes(lc(t))) : [],
    };
    const path = `${repoPath(ref)}/pulls/${number}/requested_reviewers`;
    if (remove.reviewers.length || remove.team_reviewers.length)
      await http.request(path, { method: 'DELETE', body: remove });
    if (add.reviewers.length || add.team_reviewers.length) await http.post(path, add);
  }

  const provider: HostingProvider = {
    kind: 'github',
    capabilities: GITHUB_CAPABILITIES,
    insights: () => createGitHubInsights({ http, graphqlUrl }),

    getViewer: () => {
      viewerP = null;
      return viewer();
    },

    async getGrantedScopes() {
      const res = await http.request<GhRestUser>('user');
      const h = res.headers.get('x-oauth-scopes');
      return h
        ? h
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    },

    // ---------------- repos ----------------

    async listRepos(opts) {
      const integ = await integration();
      const per_page = Math.min(opts.pageSize ?? 100, 100);
      if (opts.query) {
        const me = await viewer();
        let scopeQ: string;
        if (opts.owner) scopeQ = `user:${opts.owner}`;
        else {
          const orgs = await all<{ login: string }>('user/orgs');
          scopeQ = [`user:${me.login}`, ...orgs.map((x) => `org:${x.login}`)].join(' ');
        }
        const p = await page<{ total_count: number; items: GhRestRepo[] }>(
          'search/repositories',
          { q: `${opts.query} in:name fork:true ${scopeQ}`, per_page, sort: 'updated' },
          opts.cursor,
        );
        return {
          items: p.data.items.map((r) => restRepo(r, integ)),
          nextCursor: p.next,
          total: p.data.total_count,
        };
      }
      let path = 'user/repos';
      let query: Record<string, string | number> = {
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        per_page,
      };
      if (opts.owner) {
        const me = await viewer();
        if (opts.owner.toLowerCase() === me.login.toLowerCase())
          query = { affiliation: 'owner', sort: 'updated', per_page };
        else {
          path = `orgs/${e(opts.owner)}/repos`;
          query = { sort: 'updated', per_page };
        }
      }
      const p = await page<GhRestRepo[]>(path, query, opts.cursor);
      return { items: p.data.map((r) => restRepo(r, integ)), nextCursor: p.next };
    },

    async listOwners() {
      const [me, orgs] = await Promise.all([
        http.get<GhRestUser>('user'),
        all<{ login: string; avatar_url?: string }>('user/orgs'),
      ]);
      return [
        { login: me.login, avatarUrl: me.avatar_url, kind: 'user' as const },
        ...orgs.map((x) => ({ login: x.login, avatarUrl: x.avatar_url, kind: 'org' as const })),
      ];
    },

    async getRepo(ref) {
      return restRepo(await http.get<GhRestRepo>(repoPath(ref)), ref.integration);
    },

    async listForks(ref, cursor) {
      const p = await page<GhRestRepo[]>(`${repoPath(ref)}/forks`, { per_page: 100, sort: 'newest' }, cursor);
      return { items: p.data.map((r) => restRepo(r, ref.integration)), nextCursor: p.next };
    },

    async createFork(ref, opts) {
      const me = await viewer();
      const organization =
        opts?.owner && opts.owner.toLowerCase() !== me.login.toLowerCase() ? opts.owner : undefined;
      const r = await http.post<GhRestRepo>(`${repoPath(ref)}/forks`, organization ? { organization } : {});
      return restRepo(r, ref.integration);
    },

    async createRepo(opts) {
      const me = await viewer();
      const path =
        opts.owner && opts.owner.toLowerCase() !== me.login.toLowerCase()
          ? `orgs/${e(opts.owner)}/repos`
          : 'user/repos';
      const r = await http.post<GhRestRepo>(path, {
        name: opts.name,
        private: opts.private,
        description: opts.description,
        gitignore_template: opts.gitignore || undefined,
        license_template: opts.license || undefined,
      });
      return restRepo(r, await integration());
    },

    matchRemoteUrl: (url) => matchGitHubRemoteUrl(host, url),

    // ---------------- pull requests ----------------

    async listPullRequests(ref, filter: PrFilter, cursor) {
      const first = 50;
      const state = filter.state ?? 'open';
      const useSearch = (filter.preset && filter.preset !== 'all') || !!filter.query || !!filter.author;
      if (useSearch) {
        const parts = [`repo:${ref.owner}/${ref.name}`, 'is:pr'];
        if (state === 'open') parts.push('is:open');
        else if (state === 'closed') parts.push('is:closed', 'is:unmerged');
        else if (state === 'merged') parts.push('is:merged');
        if (filter.preset === 'mine') parts.push('author:@me');
        else if (filter.preset === 'review-requested') parts.push('review-requested:@me');
        else if (filter.preset === 'assigned') parts.push('assignee:@me');
        if (filter.author) parts.push(`author:${filter.author}`);
        if (filter.head) parts.push(`head:${filter.head}`);
        if (filter.query) parts.push(filter.query);
        parts.push('sort:updated-desc');
        const d = await q<{
          viewer: { login: string };
          search: {
            issueCount: number;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<GqlPr | Record<string, never>>;
          };
        }>(Q_PR_SEARCH, { q: parts.join(' '), first, after: cursor ?? null });
        return {
          items: d.search.nodes
            .filter((n): n is GqlPr => 'number' in n)
            .map((n) => gqlPr(n, ref, d.viewer.login)),
          nextCursor: d.search.pageInfo.hasNextPage ? (d.search.pageInfo.endCursor ?? undefined) : undefined,
          total: d.search.issueCount,
        };
      }
      const states = state === 'all' ? null : [state.toUpperCase()];
      const d = await q<{
        viewer: { login: string };
        repository: {
          pullRequests: {
            totalCount: number;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: GqlPr[];
          };
        } | null;
      }>(Q_PR_LIST, {
        owner: ref.owner,
        name: ref.name,
        states,
        head: filter.head ?? null,
        first,
        after: cursor ?? null,
      });
      if (!d.repository)
        throw new ProviderError({
          code: 'not_found',
          message: `Repository ${ref.owner}/${ref.name} not found.`,
        });
      const c = d.repository.pullRequests;
      return {
        items: c.nodes.map((n) => gqlPr(n, ref, d.viewer.login)),
        nextCursor: c.pageInfo.hasNextPage ? (c.pageInfo.endCursor ?? undefined) : undefined,
        total: c.totalCount,
      };
    },

    async searchMyPullRequests(opts = {}) {
      const integ = await integration();
      const roles: Array<[string, Involvement]> = [
        ['author:@me', 'author'],
        ['review-requested:@me', 'review-requested'],
        ['assignee:@me', 'assignee'],
        ['mentions:@me', 'mentioned'],
      ];
      const queries: Array<{ q: string; role: Involvement }> = [];
      for (const [term, role] of roles) {
        for (const q of searchQueries(`is:open is:pr archived:false ${term} sort:updated-desc`, opts.repos))
          queries.push({ q, role });
      }
      const vars: Record<string, unknown> = { first: Math.min(opts.limit ?? 50, 100) };
      queries.forEach((x, i) => (vars[`q${i}`] = x.q));
      const d = await q<
        { viewer: { login: string } } & Record<string, { nodes: Array<GqlPr | Record<string, never>> }>
      >(buildMyPrsQuery(queries.length), vars);
      const rows: MyPullRequest[] = [];
      queries.forEach((x, i) => {
        const nodes = (d[`s${i}`]?.nodes ?? []).filter((n): n is GqlPr => 'number' in n);
        for (const n of nodes) {
          const br = n.baseRepository;
          const base: RepoRef = br
            ? { integration: integ, owner: br.owner.login, name: br.name, id: br.id }
            : { integration: integ, ...(matchGitHubRemoteUrl(host, n.url) ?? { owner: '', name: '' }) };
          rows.push({ pr: gqlPr(n, base, d.viewer.login), involvement: [x.role] });
        }
      });
      return mergeInvolved(rows, (r) => r.pr.id);
    },

    async getPullRequest(ref, number, opts) {
      // REST conditional GET gives a cheap ETag check (304s don't count against the rate limit).
      const rest = await http.request(`${repoPath(ref)}/pulls/${number}`, { etag: opts?.etag });
      if (rest.notModified) return 'not-modified';
      const pr = await fetchPr(ref, number);
      return { ...pr, etag: rest.etag };
    },

    async getTimeline(ref, number, cursor) {
      const d = await q<{
        repository: {
          pullRequest: {
            timelineItems: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{ __typename: string }>;
            };
            reviewThreads?: { nodes: GqlThread[] };
          } | null;
        } | null;
      }>(Q_TIMELINE, {
        owner: ref.owner,
        name: ref.name,
        number,
        after: cursor ?? null,
        withThreads: !cursor,
      });
      const pr = d.repository?.pullRequest;
      if (!pr) throw new ProviderError({ code: 'not_found', message: `Pull request #${number} not found.` });
      const ti = pr.timelineItems;
      return {
        items: gqlTimeline(ti.nodes, pr.reviewThreads?.nodes ?? []),
        nextCursor: ti.pageInfo.hasNextPage ? (ti.pageInfo.endCursor ?? undefined) : undefined,
      };
    },

    async getChecks(ref, sha) {
      const [runs, status] = await Promise.all([
        (async () => {
          const out: GhCheckRun[] = [];
          let cursor: string | undefined;
          for (let i = 0; i < 5; i++) {
            const p = await page<{ check_runs: GhCheckRun[] }>(
              `${repoPath(ref)}/commits/${e(sha)}/check-runs`,
              { per_page: 100 },
              cursor,
            );
            out.push(...p.data.check_runs);
            if (!p.next) break;
            cursor = p.next;
          }
          return out;
        })(),
        notFoundToEmpty(http.get<{ statuses: GhStatus[] }>(`${repoPath(ref)}/commits/${e(sha)}/status`), {
          statuses: [],
        }),
      ]);
      return [...runs.map(restCheckRun), ...(status.statuses ?? []).map(restStatus)];
    },

    async listPrTemplates(ref, branch) {
      type Entry = { name: string; path: string; type: 'file' | 'dir' | string };
      const dir = (p: string): Promise<Entry[]> =>
        notFoundToEmpty(
          http.get<Entry[] | Entry>(p ? `${repoPath(ref)}/contents/${p}` : `${repoPath(ref)}/contents`, {
            query: { ref: branch },
          }),
          [] as Entry[],
        ).then((r) => (Array.isArray(r) ? r : []));
      const [gh, root, docs] = await Promise.all([dir('.github'), dir(''), dir('docs')]);
      const files: Array<{ name: string; path: string }> = [];
      const isFile = (x: Entry): boolean => x.type === 'file' && /^pull_request_template\.md$/i.test(x.name);
      for (const listing of [gh, root, docs]) {
        const d = listing.find((x) => x.type === 'dir' && /^pull_request_template$/i.test(x.name));
        if (d) {
          for (const f of await dir(d.path.split('/').map(e).join('/'))) {
            if (f.type === 'file' && /\.md$/i.test(f.name))
              files.push({ name: f.name.replace(/\.md$/i, ''), path: f.path });
          }
        }
        const f = listing.find(isFile);
        if (f) files.push({ name: 'Default', path: f.path });
      }
      const seen = new Set<string>();
      const unique = files.filter((f) => !seen.has(f.path.toLowerCase()) && seen.add(f.path.toLowerCase()));
      return Promise.all(
        unique.map(async (f) => {
          const c = await http.get<{ content?: string; encoding?: string }>(
            `${repoPath(ref)}/contents/${f.path.split('/').map(e).join('/')}`,
            { query: { ref: branch } },
          );
          const body =
            c.encoding === 'base64' && c.content
              ? Buffer.from(c.content, 'base64').toString('utf8')
              : (c.content ?? '');
          return { name: f.name, path: f.path, body };
        }),
      );
    },

    async searchUsers(ref, query) {
      const [users, teams] = await Promise.all([
        q<{ repository: { assignableUsers: { nodes: GqlActor[] } } | null }>(Q_ASSIGNABLE, {
          owner: ref.owner,
          name: ref.name,
          q: query || null,
        }).then((d) => (d.repository?.assignableUsers.nodes ?? []).map(gqlUser)),
        http
          .get<Array<{ id: number; slug: string; name: string }>>(`orgs/${e(ref.owner)}/teams`, {
            query: { per_page: 100 },
          })
          .catch(() => [] as Array<{ id: number; slug: string; name: string }>),
      ]);
      const ql = query.toLowerCase();
      const matchingTeams = teams
        .filter((t) => !ql || t.slug.toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql))
        .map((t): ProviderUser => ({ id: String(t.id), login: t.slug, name: t.name, isTeam: true }));
      return [...users, ...matchingTeams];
    },

    async listLabels(ref) {
      const labels = await all<{ name: string; color?: string }>(`${repoPath(ref)}/labels`);
      return labels.map((l) => ({ name: l.name, color: l.color ? `#${l.color}` : undefined }));
    },

    async listMilestones(ref) {
      const ms = await all<{ number: number; title: string }>(`${repoPath(ref)}/milestones`, {
        state: 'open',
      });
      return ms.map((m) => ({ id: String(m.number), title: m.title }));
    },

    async createPullRequest(input: CreatePrInput) {
      const { base, head } = input;
      const cross = head.owner.toLowerCase() !== base.owner.toLowerCase();
      const created = await http.post<{ number: number }>(`${repoPath(base)}/pulls`, {
        title: input.title,
        body: input.body,
        head: cross ? `${head.owner}:${input.headBranch}` : input.headBranch,
        base: input.baseBranch,
        draft: input.draft || undefined,
      });
      const n = created.number;
      // Follow-ups are best effort: the PR exists; the returned PR shows what was applied.
      const followUps: Array<Promise<unknown>> = [];
      const issuePatch: Record<string, unknown> = {};
      if (input.assignees?.length) issuePatch.assignees = input.assignees;
      if (input.labels?.length) issuePatch.labels = input.labels;
      if (input.milestone) issuePatch.milestone = Number(input.milestone);
      if (Object.keys(issuePatch).length)
        followUps.push(http.patch(`${repoPath(base)}/issues/${n}`, issuePatch));
      if (input.reviewers?.length || input.teamReviewers?.length) {
        followUps.push(
          http.post(`${repoPath(base)}/pulls/${n}/requested_reviewers`, {
            reviewers: input.reviewers ?? [],
            team_reviewers: input.teamReviewers ?? [],
          }),
        );
      }
      await Promise.allSettled(followUps);
      return fetchPr(base, n);
    },

    async updatePullRequest(ref, number, patch: UpdatePrInput) {
      const pull: Record<string, unknown> = {};
      if (patch.title !== undefined) pull.title = patch.title;
      if (patch.body !== undefined) pull.body = patch.body;
      if (patch.baseBranch !== undefined) pull.base = patch.baseBranch;
      if (patch.state !== undefined) pull.state = patch.state;
      if (Object.keys(pull).length) await http.patch(`${repoPath(ref)}/pulls/${number}`, pull);
      const issue: Record<string, unknown> = {};
      if (patch.labels !== undefined) issue.labels = patch.labels;
      if (patch.assignees !== undefined) issue.assignees = patch.assignees;
      if (patch.milestone !== undefined) issue.milestone = patch.milestone ? Number(patch.milestone) : null;
      if (Object.keys(issue).length) await http.patch(`${repoPath(ref)}/issues/${number}`, issue);
      await syncReviewers(ref, number, patch.reviewers, patch.teamReviewers);
      return fetchPr(ref, number);
    },

    async addComment(ref, number, body, inReplyTo): Promise<TimelineItem> {
      type RestComment = { id: number; body: string; created_at: string; user: GhRestUser };
      if (inReplyTo && !/^\d+$/.test(inReplyTo)) {
        const d = await q<{
          addPullRequestReviewThreadReply: {
            comment: { id: string; databaseId: number; body: string; createdAt: string; author: GqlActor };
          };
        }>(M_THREAD_REPLY, { id: inReplyTo, body });
        const c = d.addPullRequestReviewThreadReply.comment;
        return {
          kind: 'comment',
          id: String(c.databaseId ?? c.id),
          author: gqlUser(c.author),
          body: c.body,
          createdAt: c.createdAt,
          editable: true,
        };
      }
      const c = inReplyTo
        ? await http.post<RestComment>(`${repoPath(ref)}/pulls/${number}/comments/${inReplyTo}/replies`, {
            body,
          })
        : await http.post<RestComment>(`${repoPath(ref)}/issues/${number}/comments`, { body });
      return {
        kind: 'comment',
        id: String(c.id),
        author: restUser(c.user),
        body: c.body,
        createdAt: c.created_at,
        editable: true,
      };
    },

    async submitReview(ref, number, input) {
      await http.post(`${repoPath(ref)}/pulls/${number}/reviews`, {
        commit_id: input.commitSha,
        event: input.event,
        body: input.body || undefined,
        comments: input.comments?.length
          ? input.comments.map((c) => ({
              path: c.path,
              line: c.line,
              side: c.side,
              start_line: c.startLine,
              start_side: c.startLine !== undefined ? c.side : undefined,
              body: c.body,
            }))
          : undefined,
      });
    },

    async setThreadResolved(_ref, threadId, resolved) {
      await q(resolved ? M_RESOLVE : M_UNRESOLVE, { id: threadId });
    },

    async merge(ref, number, input) {
      const method = MERGE_METHODS[input.method];
      if (!method)
        throw new ProviderError({
          code: 'unsupported',
          message: `GitHub does not support the '${input.method}' merge method.`,
        });
      const pr = input.deleteBranch
        ? await http.get<{ head: { ref: string; repo: { full_name: string } | null } }>(
            `${repoPath(ref)}/pulls/${number}`,
          )
        : null;
      const r = await http.put<{ sha?: string; merged: boolean; message?: string }>(
        `${repoPath(ref)}/pulls/${number}/merge`,
        {
          merge_method: method,
          commit_title: input.title || undefined,
          commit_message: input.message || undefined,
          sha: input.expectedHeadSha,
        },
      );
      let message = r.message;
      if (r.merged && pr?.head.repo) {
        const branch = pr.head.ref.split('/').map(e).join('/');
        const [ho, hr] = pr.head.repo.full_name.split('/');
        try {
          await http.delete(`repos/${e(ho!)}/${e(hr!)}/git/refs/heads/${branch}`);
        } catch (err) {
          message = `${message ?? 'Merged.'} The branch could not be deleted: ${(err as Error).message}`;
        }
      }
      return { merged: r.merged, sha: r.sha, message };
    },

    async setAutoMerge(ref, number, method) {
      const id = await prNodeId(ref, number);
      if (method === null) {
        await q(M_AUTO_MERGE_OFF, { id });
        return;
      }
      const m = MERGE_METHODS[method];
      if (!m)
        throw new ProviderError({
          code: 'unsupported',
          message: `GitHub does not support the '${method}' merge method.`,
        });
      await q(M_AUTO_MERGE, { id, method: m.toUpperCase() });
    },

    async close(ref, number) {
      await http.patch(`${repoPath(ref)}/pulls/${number}`, { state: 'closed' });
    },
    async reopen(ref, number) {
      await http.patch(`${repoPath(ref)}/pulls/${number}`, { state: 'open' });
    },
    async setDraft(ref, number, draft) {
      const id = await prNodeId(ref, number);
      await q(draft ? M_DRAFT : M_READY, { id });
    },

    // ---------------- CI ----------------

    async listCiRuns(ref, opts) {
      type Run = {
        id: number;
        name?: string;
        display_title?: string;
        run_number: number;
        head_branch?: string;
        event?: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        run_started_at?: string;
        updated_at: string;
        html_url: string;
        actor?: GhRestUser;
      };
      const p = await page<{ total_count: number; workflow_runs: Run[] }>(
        `${repoPath(ref)}/actions/runs`,
        { branch: opts.branch, per_page: 30 },
        opts.cursor,
      );
      return {
        items: p.data.workflow_runs.map(
          (r): CheckRun & { runNumber?: number; branch?: string; event?: string; actor?: ProviderUser } => ({
            id: String(r.id),
            name: r.display_title ?? r.name ?? `Run #${r.run_number}`,
            group: r.name,
            status: checkStatus(r.status, r.conclusion),
            startedAt: r.run_started_at ?? r.created_at,
            completedAt: r.status === 'completed' ? r.updated_at : undefined,
            detailsUrl: r.html_url,
            canRerun: r.status === 'completed',
            provider: 'actions',
            runNumber: r.run_number,
            branch: r.head_branch,
            event: r.event,
            actor: r.actor ? restUser(r.actor) : undefined,
          }),
        ),
        nextCursor: p.next,
        total: p.data.total_count,
      };
    },
    async rerunCi(ref, runId, opts) {
      await http.post(
        `${repoPath(ref)}/actions/runs/${e(runId)}/${opts?.failedOnly ? 'rerun-failed-jobs' : 'rerun'}`,
      );
    },
    async cancelCi(ref, runId) {
      await http.post(`${repoPath(ref)}/actions/runs/${e(runId)}/cancel`);
    },

    // ---------------- SSH ----------------

    async uploadSshKey(title, publicKey) {
      const k = await http.post<{ id: number }>('user/keys', { title, key: publicKey.trim() });
      return { id: String(k.id) };
    },
    async listSshKeys() {
      const keys = await all<{ id: number; title?: string; key: string }>('user/keys');
      return keys.map((k) => ({
        id: String(k.id),
        title: k.title ?? '',
        fingerprint: sshFingerprint(k.key),
      }));
    },
  };
  return provider;
}
