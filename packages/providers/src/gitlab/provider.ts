import { createGitLabInsights } from './insights';
import { type HttpClient, ProviderError, parseRemoteUrl } from '../http';
import { sshFingerprint } from '../github/provider';
import { mergeInvolved } from '../types';
import type {
  CheckRun,
  CreatePrInput,
  HostingProvider,
  IntegrationId,
  Involvement,
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
  type GlApprovals,
  type GlDiscussion,
  type GlJob,
  glJob,
  glMr,
  type GlMr,
  type GlNote,
  type GlProject,
  glRepo,
  glTimeline,
  glUser,
  type GlUser,
  jobStatus,
  splitPath,
  withDraftPrefix,
} from './normalize';

export interface GitLabProviderOptions {
  /** HttpClient whose baseUrl is https://{host}/api/v4. */
  http: HttpClient;
  /** 'gitlab.com' or the self-managed host. */
  host: string;
  accountId?: string;
}

export const GITLAB_CAPABILITIES: ProviderCapabilities = {
  oauth: true,
  pat: true,
  graphql: false,
  prDraft: true,
  prLabels: true,
  prAssignees: true,
  prMilestone: true,
  prTeamsAsReviewers: false,
  prTemplates: true,
  prAutoMerge: true,
  prStacks: false,
  reviewThreadsResolve: true,
  mergeMethods: ['merge', 'squash', 'fast-forward', 'semi-linear'],
  sshKeyUpload: true,
  forkList: true,
  createRepo: true,
  ci: true,
  ciRerun: true,
  issues: true,
  prRefspec: 'refs/merge-requests/{n}/head',
};

const e = encodeURIComponent;
const hostname = (h: string): string =>
  h
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/:].*$/, '')
    .toLowerCase();

/** Pure remote-URL matcher for a GitLab host; supports nested groups (`group/sub/repo`). */
export function matchGitLabRemoteUrl(host: string, url: string): Omit<RepoRef, 'integration'> | null {
  const p = parseRemoteUrl(url);
  if (!p || p.host !== hostname(host)) return null;
  let parts = p.path.split('/').filter(Boolean);
  const dash = parts.indexOf('-');
  if (dash >= 0) parts = parts.slice(0, dash);
  if (parts.length < 2) return null;
  return { owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1]!.replace(/\.git$/i, '') };
}

/** URL-encoded project id: "group%2Fsub%2Frepo". */
export const projectId = (r: { owner: string; name: string }): string => e(`${r.owner}/${r.name}`);

export function createGitLabProvider(o: GitLabProviderOptions): HostingProvider {
  const { http } = o;
  const host = hostname(o.host);
  const webBase = http.baseUrl.replace(/\/api\/v4\/?$/, '');

  let viewerP: Promise<ProviderUser> | null = null;
  const viewer = (): Promise<ProviderUser> => {
    viewerP ??= http.get<GlUser>('user').then(glUser);
    viewerP.catch(() => (viewerP = null));
    return viewerP;
  };
  const integration = async (): Promise<IntegrationId> => ({
    kind: 'gitlab',
    host,
    accountId: o.accountId ?? (await viewer()).id,
  });

  // project cache (by path and by numeric id); null = not found (deleted fork)
  const projects = new Map<string, Promise<GlProject | null>>();
  const getProject = (key: string | number): Promise<GlProject | null> => {
    const k = String(key);
    let p = projects.get(k);
    if (!p) {
      p = http.get<GlProject>(`projects/${typeof key === 'number' ? key : e(k)}`).catch((err: unknown) => {
        if (err instanceof ProviderError && err.code === 'not_found') return null;
        projects.delete(k);
        throw err;
      });
      projects.set(k, p);
      setTimeout(() => projects.delete(k), 5 * 60_000).unref?.();
    }
    return p;
  };
  const projectFor = async (r: RepoRef): Promise<GlProject> => {
    const p = await getProject(`${r.owner}/${r.name}`);
    if (!p)
      throw new ProviderError({ code: 'not_found', message: `Project ${r.owner}/${r.name} not found.` });
    return p;
  };

  async function page<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    cursor?: string,
  ): Promise<{ data: T; next?: string; total?: number }> {
    const res = await http.request<T>(path, { query: { ...query, page: cursor } });
    const next = res.headers.get('x-next-page');
    const total = res.headers.get('x-total');
    return { data: res.data, next: next || undefined, total: total ? Number(total) : undefined };
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

  const mrPath = (r: RepoRef, iid: number): string => `projects/${projectId(r)}/merge_requests/${iid}`;

  async function sourceProjectOf(mr: GlMr): Promise<GlProject | null | undefined> {
    if (mr.source_project_id === mr.target_project_id) return undefined;
    if (mr.source_project_id == null) return null;
    return getProject(mr.source_project_id);
  }

  async function fetchMr(ref: RepoRef, iid: number, etag?: string): Promise<PullRequest | 'not-modified'> {
    const res = await http.request<GlMr>(mrPath(ref, iid), { etag });
    if (res.notModified) return 'not-modified';
    const mr = res.data;
    const [me, baseProject, sourceProject, approvals] = await Promise.all([
      viewer().catch(() => undefined),
      getProject(`${ref.owner}/${ref.name}`).then((p) => p ?? undefined),
      sourceProjectOf(mr),
      http.get<GlApprovals>(`${mrPath(ref, iid)}/approvals`).catch(() => undefined),
    ]);
    return { ...glMr(mr, ref, { viewer: me, baseProject, sourceProject, approvals }), etag: res.etag };
  }
  async function mustFetchMr(ref: RepoRef, iid: number): Promise<PullRequest> {
    return (await fetchMr(ref, iid)) as PullRequest;
  }

  async function userIds(names: string[] | undefined): Promise<number[] | undefined> {
    if (names === undefined) return undefined;
    return Promise.all(
      names.map(async (n) => {
        if (/^\d+$/.test(n)) return Number(n);
        const found = await http.get<GlUser[]>('users', { query: { username: n.replace(/^@/, '') } });
        const u = found[0];
        if (!u) throw new ProviderError({ code: 'validation', message: `GitLab user '${n}' not found.` });
        return u.id;
      }),
    );
  }

  const discussionOf = (id: string): { iid?: number; discussion: string } => {
    const m = /^(\d+):(.+)$/.exec(id);
    return m ? { iid: Number(m[1]), discussion: m[2]! } : { discussion: id };
  };

  const provider: HostingProvider = {
    kind: 'gitlab',
    capabilities: GITLAB_CAPABILITIES,
    insights: () => createGitLabInsights({ http }),

    getViewer: () => {
      viewerP = null;
      return viewer();
    },

    async getGrantedScopes() {
      try {
        return (await http.get<{ scopes?: string[] }>('personal_access_tokens/self')).scopes ?? [];
      } catch {
        try {
          const ti = await http.get<{ scope?: string[] | string; scopes?: string[] }>(
            `${webBase}/oauth/token/info`,
          );
          const s = ti.scope ?? ti.scopes ?? [];
          return Array.isArray(s) ? s : s.split(/\s+/).filter(Boolean);
        } catch {
          return [];
        }
      }
    },

    // ---------------- repos ----------------

    async listRepos(opts) {
      const integ = await integration();
      const query = {
        search: opts.query || undefined,
        order_by: 'last_activity_at',
        per_page: Math.min(opts.pageSize ?? 100, 100),
      };
      let p;
      if (opts.owner) {
        const me = await viewer();
        p =
          opts.owner.toLowerCase() === me.login.toLowerCase()
            ? await page<GlProject[]>(`users/${e(me.login)}/projects`, query, opts.cursor)
            : await page<GlProject[]>(
                `groups/${e(opts.owner)}/projects`,
                { ...query, include_subgroups: true },
                opts.cursor,
              );
      } else p = await page<GlProject[]>('projects', { ...query, membership: true }, opts.cursor);
      return { items: p.data.map((x) => glRepo(x, integ)), nextCursor: p.next, total: p.total };
    },

    async listOwners() {
      const [me, groups] = await Promise.all([
        http.get<GlUser>('user'),
        all<{ full_path: string; avatar_url?: string | null }>('groups', { min_access_level: 10 }),
      ]);
      return [
        { login: me.username, avatarUrl: me.avatar_url ?? undefined, kind: 'user' as const },
        ...groups.map((g) => ({
          login: g.full_path,
          avatarUrl: g.avatar_url ?? undefined,
          kind: 'group' as const,
        })),
      ];
    },

    async getRepo(ref) {
      return glRepo(await http.get<GlProject>(`projects/${projectId(ref)}`), ref.integration);
    },

    async listForks(ref, cursor) {
      const p = await page<GlProject[]>(`projects/${projectId(ref)}/forks`, { per_page: 100 }, cursor);
      return { items: p.data.map((x) => glRepo(x, ref.integration)), nextCursor: p.next, total: p.total };
    },

    async createFork(ref, opts) {
      const p = await http.post<GlProject>(
        `projects/${projectId(ref)}/fork`,
        opts?.owner ? { namespace_path: opts.owner } : {},
      );
      return glRepo(p, ref.integration);
    },

    async createRepo(opts) {
      let namespace_id: number | undefined;
      if (opts.owner) {
        const me = await viewer();
        if (opts.owner.toLowerCase() !== me.login.toLowerCase()) {
          namespace_id = (await http.get<{ id: number }>(`namespaces/${e(opts.owner)}`)).id;
        }
      }
      // GitLab has no gitignore/license template parameters on project creation; they're ignored.
      const p = await http.post<GlProject>('projects', {
        name: opts.name,
        namespace_id,
        visibility: opts.private ? 'private' : 'public',
        description: opts.description,
      });
      return glRepo(p, await integration());
    },

    matchRemoteUrl: (url) => matchGitLabRemoteUrl(host, url),

    // ---------------- merge requests ----------------

    async listPullRequests(ref, filter: PrFilter, cursor) {
      const state = filter.state ?? 'open';
      const me = filter.preset === 'review-requested' ? await viewer() : undefined;
      const p = await page<GlMr[]>(
        `projects/${projectId(ref)}/merge_requests`,
        {
          state: state === 'open' ? 'opened' : state,
          scope:
            filter.preset === 'mine'
              ? 'created_by_me'
              : filter.preset === 'assigned'
                ? 'assigned_to_me'
                : 'all',
          reviewer_username: me?.login,
          author_username: filter.author,
          source_branch: filter.head,
          search: filter.query,
          order_by: 'updated_at',
          sort: 'desc',
          with_labels_details: true,
          per_page: 50,
        },
        cursor,
      );
      const [viewerUser, baseProject] = await Promise.all([
        viewer().catch(() => undefined),
        getProject(`${ref.owner}/${ref.name}`).then((x) => x ?? undefined),
      ]);
      const items = await Promise.all(
        p.data.map(async (mr) =>
          glMr(mr, ref, { viewer: viewerUser, baseProject, sourceProject: await sourceProjectOf(mr) }),
        ),
      );
      return { items, nextCursor: p.next, total: p.total };
    },

    async searchMyPullRequests(opts = {}) {
      const [me, integ] = await Promise.all([viewer(), integration()]);
      const per_page = Math.min(opts.limit ?? 50, 100);
      const roles: Array<[Record<string, string>, Involvement]> = [
        [{ scope: 'created_by_me' }, 'author'],
        [{ scope: 'all', reviewer_id: me.id }, 'reviewer'],
        [{ scope: 'assigned_to_me' }, 'assignee'],
      ];
      const want = opts.repos?.length
        ? new Set(opts.repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()))
        : null;
      const lists = await Promise.all(
        roles.map(async ([query, role]) => {
          const mrs = await http.get<GlMr[]>('merge_requests', {
            query: { ...query, state: 'opened', order_by: 'updated_at', sort: 'desc', per_page },
          });
          return mrs.map((mr) => ({ mr, role }));
        }),
      );
      const rows: MyPullRequest[] = [];
      for (const { mr, role } of lists.flat()) {
        const path =
          mr.references?.full?.replace(/![0-9]+$/, '') ??
          new URL(mr.web_url).pathname.replace(/^\/+/, '').split('/-/')[0]!;
        if (want && !want.has(path.toLowerCase())) continue;
        const ref: RepoRef = { integration: integ, ...splitPath(path), id: String(mr.target_project_id) };
        const pr = glMr(mr, ref, { viewer: me, sourceProject: await sourceProjectOf(mr).catch(() => null) });
        rows.push({ pr, involvement: [role] });
      }
      return mergeInvolved(rows, (r) => r.pr.id);
    },

    getPullRequest: (ref, number, opts) => fetchMr(ref, number, opts?.etag),

    async getTimeline(ref, number, cursor) {
      const [p, mr, me] = await Promise.all([
        page<GlDiscussion[]>(`${mrPath(ref, number)}/discussions`, { per_page: 100 }, cursor),
        http.get<GlMr>(mrPath(ref, number)),
        viewer().catch(() => undefined),
      ]);
      return {
        items: glTimeline(p.data, number, mr.diff_refs?.head_sha ?? mr.sha, me?.id),
        nextCursor: p.next,
      };
    },

    async getChecks(ref, sha) {
      const pipelines = await http.get<Array<{ id: number }>>(`projects/${projectId(ref)}/pipelines`, {
        query: { sha, per_page: 5, order_by: 'id', sort: 'desc' },
      });
      const latest = pipelines[0];
      if (latest) {
        const jobs = await all<GlJob>(`projects/${projectId(ref)}/pipelines/${latest.id}/jobs`, {}, 5);
        return jobs.map(glJob);
      }
      // External CI reporting through the commit status API.
      const statuses = await http.get<
        Array<{
          id: number;
          name: string;
          status: string;
          started_at?: string | null;
          finished_at?: string | null;
          target_url?: string | null;
          allow_failure?: boolean;
        }>
      >(`projects/${projectId(ref)}/repository/commits/${e(sha)}/statuses`, { query: { per_page: 100 } });
      return statuses.map((s): CheckRun => ({
        id: `status:${s.id}`,
        name: s.name,
        status: jobStatus(s.status, s.allow_failure),
        startedAt: s.started_at ?? undefined,
        completedAt: s.finished_at ?? undefined,
        detailsUrl: s.target_url ?? undefined,
        canRerun: false,
        provider: 'status-api',
      }));
    },

    async listPrTemplates(ref, branch) {
      const dir = '.gitlab/merge_request_templates';
      let tree: Array<{ name: string; path: string; type: string }>;
      try {
        tree = await http.get(`projects/${projectId(ref)}/repository/tree`, {
          query: { path: dir, ref: branch, per_page: 100 },
        });
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'not_found') return [];
        throw err;
      }
      const files = tree.filter((t) => t.type === 'blob' && /\.md$/i.test(t.name));
      return Promise.all(
        files.map(async (f) => {
          const raw = await http.get<unknown>(
            `projects/${projectId(ref)}/repository/files/${e(f.path)}/raw`,
            {
              query: { ref: branch },
              headers: { Accept: 'text/plain' },
            },
          );
          return {
            name: f.name.replace(/\.md$/i, ''),
            path: f.path,
            body: typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
          };
        }),
      );
    },

    async searchUsers(ref, query) {
      const users = await http.get<GlUser[]>(`projects/${projectId(ref)}/users`, {
        query: { search: query || undefined, per_page: 30 },
      });
      return users.map(glUser);
    },

    async listLabels(ref) {
      const labels = await all<{ name: string; color?: string }>(`projects/${projectId(ref)}/labels`);
      return labels.map((l) => ({ name: l.name, color: l.color }));
    },

    async listMilestones(ref) {
      const ms = await all<{ id: number; title: string }>(`projects/${projectId(ref)}/milestones`, {
        state: 'active',
      });
      return ms.map((m) => ({ id: String(m.id), title: m.title }));
    },

    async createPullRequest(input: CreatePrInput) {
      const [baseProject, assignee_ids, reviewer_ids] = await Promise.all([
        input.base.id && /^\d+$/.test(input.base.id)
          ? Promise.resolve({ id: Number(input.base.id) })
          : projectFor(input.base),
        userIds(input.assignees),
        userIds(input.reviewers),
      ]);
      // Fork MRs are created on the source project.
      const created = await http.post<GlMr>(`projects/${projectId(input.head)}/merge_requests`, {
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        target_project_id: baseProject.id,
        title: withDraftPrefix(input.title, !!input.draft),
        description: input.body,
        assignee_ids,
        reviewer_ids,
        labels: input.labels?.length ? input.labels.join(',') : undefined,
        milestone_id: input.milestone ? Number(input.milestone) : undefined,
        remove_source_branch: input.deleteSourceBranch,
        squash: input.squash,
      });
      return mustFetchMr(input.base, created.iid);
    },

    async updatePullRequest(ref, number, patch: UpdatePrInput) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) {
        const cur = await http.get<GlMr>(mrPath(ref, number));
        const isDraft = cur.draft ?? cur.work_in_progress ?? false;
        body.title = withDraftPrefix(patch.title, isDraft);
      }
      if (patch.body !== undefined) body.description = patch.body;
      if (patch.baseBranch !== undefined) body.target_branch = patch.baseBranch;
      if (patch.state !== undefined) body.state_event = patch.state === 'closed' ? 'close' : 'reopen';
      if (patch.labels !== undefined) body.labels = patch.labels.join(',');
      if (patch.milestone !== undefined) body.milestone_id = patch.milestone ? Number(patch.milestone) : 0;
      const [assignees, reviewers] = await Promise.all([userIds(patch.assignees), userIds(patch.reviewers)]);
      if (assignees !== undefined) body.assignee_ids = assignees.length ? assignees : [0];
      if (reviewers !== undefined) body.reviewer_ids = reviewers.length ? reviewers : [0];
      if (Object.keys(body).length) await http.put(mrPath(ref, number), body);
      return mustFetchMr(ref, number);
    },

    async addComment(ref, number, body, inReplyTo): Promise<TimelineItem> {
      const n = inReplyTo
        ? await http.post<GlNote>(
            `${mrPath(ref, number)}/discussions/${e(discussionOf(inReplyTo).discussion)}/notes`,
            { body },
          )
        : await http.post<GlNote>(`${mrPath(ref, number)}/notes`, { body });
      return {
        kind: 'comment',
        id: String(n.id),
        author: glUser(n.author),
        body: n.body,
        createdAt: n.created_at,
        editable: true,
      };
    },

    async submitReview(ref, number, input) {
      if (input.comments?.length) {
        const mr = await http.get<GlMr>(mrPath(ref, number));
        const refs = mr.diff_refs;
        if (!refs)
          throw new ProviderError({
            code: 'conflict',
            message: 'The merge request diff is not available yet; refresh and retry.',
          });
        if (input.commitSha && refs.head_sha !== input.commitSha) {
          throw new ProviderError({
            code: 'conflict',
            message: 'The merge request was updated since the review started; refresh and retry.',
          });
        }
        for (const c of input.comments) {
          await http.post(`${mrPath(ref, number)}/discussions`, {
            body: c.body,
            position: {
              position_type: 'text',
              base_sha: refs.base_sha,
              start_sha: refs.start_sha,
              head_sha: refs.head_sha,
              new_path: c.path,
              old_path: c.path,
              ...(c.side === 'LEFT' ? { old_line: c.line } : { new_line: c.line }),
            },
          });
        }
      }
      const summary = input.body?.trim();
      if (summary) await http.post(`${mrPath(ref, number)}/notes`, { body: summary });
      if (input.event === 'APPROVE')
        await http.post(`${mrPath(ref, number)}/approve`, { sha: input.commitSha });
      else if (input.event === 'REQUEST_CHANGES' && !summary) {
        // No portable "request changes" REST state across GitLab versions → leave a note.
        await http.post(`${mrPath(ref, number)}/notes`, { body: 'Requested changes.' });
      }
    },

    async setThreadResolved(ref, id, resolved) {
      const { iid, discussion } = discussionOf(id);
      if (iid === undefined)
        throw new ProviderError({
          code: 'validation',
          message: `Thread id '${id}' must be '{iid}:{discussionId}'.`,
        });
      await http.put(`${mrPath(ref, iid)}/discussions/${e(discussion)}`, undefined, { query: { resolved } });
    },

    async merge(ref, number, input) {
      if (input.method === 'rebase' || input.method === 'rebase-merge') {
        throw new ProviderError({
          code: 'unsupported',
          message: `GitLab does not support the '${input.method}' merge method.`,
        });
      }
      const squash = input.method === 'squash';
      const msg = [input.title, input.message].filter(Boolean).join('\n\n') || undefined;
      const mr = await http.put<GlMr>(`${mrPath(ref, number)}/merge`, {
        sha: input.expectedHeadSha,
        squash,
        should_remove_source_branch: input.deleteBranch,
        merge_commit_message: squash ? undefined : msg,
        squash_commit_message: squash ? msg : undefined,
      });
      return {
        merged: mr.state === 'merged',
        sha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? undefined,
        message: mr.state === 'merged' ? undefined : (mr.detailed_merge_status ?? mr.merge_status),
      };
    },

    async setAutoMerge(ref, number, method) {
      if (method === null) {
        await http.post(`${mrPath(ref, number)}/cancel_merge_when_pipeline_succeeds`);
        return;
      }
      await http.put(`${mrPath(ref, number)}/merge`, {
        merge_when_pipeline_succeeds: true,
        auto_merge: true,
        squash: method === 'squash',
      });
    },

    async close(ref, number) {
      await http.put(mrPath(ref, number), { state_event: 'close' });
    },
    async reopen(ref, number) {
      await http.put(mrPath(ref, number), { state_event: 'reopen' });
    },
    async setDraft(ref, number, draft) {
      const cur = await http.get<GlMr>(mrPath(ref, number));
      await http.put(mrPath(ref, number), { title: withDraftPrefix(cur.title, draft) });
    },

    // ---------------- CI ----------------

    async listCiRuns(ref, opts) {
      type Pipeline = {
        id: number;
        iid?: number;
        status: string;
        ref?: string;
        sha?: string;
        source?: string;
        web_url?: string;
        created_at: string;
        updated_at: string;
        user?: GlUser;
      };
      const p = await page<Pipeline[]>(
        `projects/${projectId(ref)}/pipelines`,
        { ref: opts.branch, per_page: 30 },
        opts.cursor,
      );
      const done = new Set(['success', 'failed', 'canceled', 'skipped']);
      return {
        items: p.data.map((x) => ({
          id: String(x.id),
          name: `Pipeline #${x.iid ?? x.id}`,
          group: x.source,
          status: jobStatus(x.status),
          startedAt: x.created_at,
          completedAt: done.has(x.status) ? x.updated_at : undefined,
          detailsUrl: x.web_url,
          canRerun: done.has(x.status),
          provider: 'gitlab-ci' as const,
          runNumber: x.iid ?? x.id,
          branch: x.ref,
          event: x.source,
          actor: x.user ? glUser(x.user) : undefined,
        })),
        nextCursor: p.next,
        total: p.total,
      };
    },
    async rerunCi(ref, runId) {
      // GitLab "retry" re-runs failed/canceled jobs of the pipeline.
      await http.post(`projects/${projectId(ref)}/pipelines/${e(runId)}/retry`);
    },
    async cancelCi(ref, runId) {
      await http.post(`projects/${projectId(ref)}/pipelines/${e(runId)}/cancel`);
    },

    // ---------------- SSH ----------------

    async uploadSshKey(title, publicKey) {
      const k = await http.post<{ id: number }>('user/keys', { title, key: publicKey.trim() });
      return { id: String(k.id) };
    },
    async listSshKeys() {
      const keys = await all<{ id: number; title: string; key: string }>('user/keys');
      return keys.map((k) => ({ id: String(k.id), title: k.title, fingerprint: sshFingerprint(k.key) }));
    },
  };
  return provider;
}
