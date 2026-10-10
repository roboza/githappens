import { type HttpClient, ProviderError, parseRemoteUrl } from '../http';
import type {
  CheckRun,
  CheckStatus,
  CreatePrInput,
  HostingProvider,
  IntegrationId,
  MergeMethod,
  PrFilter,
  ProviderCapabilities,
  ProviderUser,
  PullRequest,
  RemoteRepo,
  RepoRef,
  ReviewState,
  SubmitReviewInput,
  TimelineItem,
  UpdatePrInput,
} from '../types';
import { checksRollupOf, enc, integrationFor, prRollupOf, sleep, toIso, unsupported } from './shared';
import { mergeInvolved, type MyPullRequest } from '../types';

/**
 * Bitbucket Cloud (REST API 2.0, https://api.bitbucket.org/2.0) — spec 10 §6.2.
 * Owners are workspaces; PR numbers are the per-repo PR ids.
 */

// ---- raw API shapes (subset) ----

interface BbPage<T> {
  values: T[];
  next?: string;
  size?: number;
}
interface BbLink {
  href: string;
  name?: string;
}
export interface BbUser {
  uuid?: string;
  account_id?: string;
  nickname?: string;
  username?: string;
  display_name?: string;
  type?: string;
  links?: { avatar?: BbLink };
}
export interface BbRepo {
  uuid: string;
  name: string;
  slug?: string;
  full_name: string;
  description?: string;
  is_private: boolean;
  parent?: { full_name: string; uuid?: string } | null;
  mainbranch?: { name: string } | null;
  updated_on?: string;
  links?: { clone?: BbLink[]; html?: BbLink; avatar?: BbLink };
}
interface BbRefSide {
  branch?: { name: string };
  commit?: { hash: string } | null;
  repository?: { full_name: string; uuid?: string; links?: { html?: BbLink } } | null;
}
export interface BbParticipant {
  user: BbUser;
  role: 'PARTICIPANT' | 'REVIEWER';
  approved: boolean;
  state?: 'approved' | 'changes_requested' | null;
}
export interface BbPullRequest {
  id: number;
  title: string;
  description?: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  author?: BbUser;
  created_on: string;
  updated_on: string;
  source: BbRefSide;
  destination: BbRefSide;
  participants?: BbParticipant[];
  reviewers?: BbUser[];
  comment_count?: number;
  merge_commit?: { hash: string } | null;
  closed_by?: BbUser | null;
  links?: { html?: BbLink };
}
interface BbComment {
  id: number;
  content?: { raw?: string };
  user?: BbUser;
  created_on: string;
  deleted?: boolean;
  pending?: boolean;
  parent?: { id: number };
  inline?: { path: string; from?: number | null; to?: number | null; outdated?: boolean };
  resolution?: unknown;
}
type BbActivity = {
  approval?: { date: string; user: BbUser };
  changes_requested?: { date: string; user: BbUser };
  update?: { date: string; author?: BbUser; state?: string; title?: string };
  comment?: unknown;
};
interface BbStatus {
  uuid?: string;
  key: string;
  name?: string;
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
  url?: string;
  created_on?: string;
  updated_on?: string;
}
interface BbPipeline {
  uuid: string;
  build_number: number;
  state: { name: string; result?: { name: string }; stage?: { name: string } };
  target?: { ref_name?: string };
  trigger?: { name?: string };
  creator?: BbUser;
  created_on?: string;
  completed_on?: string;
}

export interface BitbucketCloudOptions {
  http: HttpClient;
  /** Identity stamped on RepoRefs (defaults to { kind:'bitbucket', host:'bitbucket.org', accountId:'' }). */
  integration?: IntegrationId;
  /** Merge-task polling interval (202 responses). Default 1000ms; timeout 60s. */
  mergePollIntervalMs?: number;
  mergePollTimeoutMs?: number;
}

export const BITBUCKET_CLOUD_CAPABILITIES: ProviderCapabilities = {
  oauth: true,
  pat: true,
  graphql: false,
  prDraft: true,
  prLabels: false,
  prAssignees: false,
  prMilestone: false,
  prTeamsAsReviewers: false,
  prTemplates: false,
  prAutoMerge: false,
  prStacks: false,
  reviewThreadsResolve: true,
  mergeMethods: ['merge', 'squash', 'fast-forward'],
  sshKeyUpload: true,
  forkList: true,
  createRepo: true,
  ci: true,
  ciRerun: false,
  issues: false,
  prRefspec: null,
};

const BB_HOSTS = new Set(['bitbucket.org', 'www.bitbucket.org', 'altssh.bitbucket.org']);

export function bbUser(u: BbUser | null | undefined): ProviderUser {
  if (!u) return { id: '', login: 'unknown' };
  return {
    id: u.uuid ?? u.account_id ?? '',
    login: u.nickname ?? u.username ?? u.display_name ?? '',
    name: u.display_name,
    avatarUrl: u.links?.avatar?.href,
    isTeam: u.type === 'team' ? true : undefined,
  };
}

export function bbReviewState(p: BbParticipant): ReviewState {
  if (p.state === 'changes_requested') return 'changes_requested';
  if (p.state === 'approved' || p.approved) return 'approved';
  return p.role === 'REVIEWER' ? 'pending' : 'commented';
}

export function bbCheckStatus(s: BbStatus['state']): CheckStatus {
  switch (s) {
    case 'SUCCESSFUL':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'INPROGRESS':
      return 'in_progress';
    case 'STOPPED':
      return 'cancelled';
    default:
      return 'neutral';
  }
}

const MERGE_STRATEGY: Partial<Record<MergeMethod, string>> = {
  merge: 'merge_commit',
  squash: 'squash',
  'fast-forward': 'fast_forward',
};

const shaMatches = (a: string, b: string): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

export function createBitbucketCloudProvider(o: BitbucketCloudOptions): HostingProvider {
  const { http } = o;
  const integration = integrationFor('bitbucket', 'bitbucket.org', o.integration);
  let viewer: Promise<BbUser> | undefined;
  const me = (): Promise<BbUser> => {
    viewer ??= http.get<BbUser>('user').catch((e: unknown) => {
      viewer = undefined;
      throw e;
    });
    return viewer;
  };

  const refOf = (fullName: string, id?: string): RepoRef => {
    const [owner = '', name = ''] = fullName.split('/');
    return { integration, owner, name, ...(id ? { id } : {}) };
  };
  const repoPath = (r: RepoRef): string => `repositories/${enc(r.owner)}/${enc(r.name)}`;
  const prPath = (r: RepoRef, n: number): string => `${repoPath(r)}/pullrequests/${n}`;

  async function page<T>(path: string, query: Record<string, string | number | undefined>, cursor?: string) {
    const res = await http.request<BbPage<T>>(path, cursor ? { url: cursor } : { query });
    return res.data;
  }
  async function all<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    max = 20,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < max; i++) {
      const p = await page<T>(path, query, cursor);
      out.push(...p.values);
      if (!p.next) break;
      cursor = p.next;
    }
    return out;
  }

  function toRepo(r: BbRepo): RemoteRepo {
    const clone = r.links?.clone ?? [];
    const https = clone.find((c) => c.name === 'https')?.href ?? `https://bitbucket.org/${r.full_name}.git`;
    return {
      ref: refOf(r.full_name, r.uuid),
      fullName: r.full_name,
      description: r.description || undefined,
      isPrivate: r.is_private,
      isFork: !!r.parent,
      parent: r.parent ? refOf(r.parent.full_name, r.parent.uuid) : undefined,
      defaultBranch: r.mainbranch?.name ?? 'main',
      // Strip "user@" that Bitbucket embeds in HTTPS clone links.
      httpsUrl: https.replace(/^https:\/\/[^@/]+@/, 'https://'),
      sshUrl: clone.find((c) => c.name === 'ssh')?.href ?? `git@bitbucket.org:${r.full_name}.git`,
      webUrl: r.links?.html?.href ?? `https://bitbucket.org/${r.full_name}`,
      updatedAt: toIso(r.updated_on) ?? '',
    };
  }

  function toPr(
    ref: RepoRef,
    p: BbPullRequest,
    viewerUuid?: string,
    checks?: CheckRun[],
    etag?: string,
  ): PullRequest {
    const participants = p.participants ?? [];
    const reviewers = participants
      .filter((x) => x.role === 'REVIEWER' || x.approved || x.state)
      .map((x) => ({ user: bbUser(x.user), state: bbReviewState(x) }));
    // Reviewers listed without a participant entry yet → pending.
    for (const r of p.reviewers ?? []) {
      if (!reviewers.some((x) => x.user.id === (r.uuid ?? r.account_id)))
        reviewers.push({ user: bbUser(r), state: 'pending' });
    }
    const states = reviewers.map((r) => r.state);
    const reviewDecision = states.includes('changes_requested')
      ? 'changes_requested'
      : states.includes('approved')
        ? 'approved'
        : reviewers.length
          ? 'review_required'
          : null;
    const state: PullRequest['state'] =
      p.state === 'OPEN' ? (p.draft ? 'draft' : 'open') : p.state === 'MERGED' ? 'merged' : 'closed';
    const srcRepo = p.source.repository;
    const dstRepo = p.destination.repository;
    const checksRollup = checks ? checksRollupOf(checks) : 'none';
    const isAuthor = !!viewerUuid && p.author?.uuid === viewerUuid;
    const open = p.state === 'OPEN';
    const pr: PullRequest = {
      repo: ref,
      number: p.id,
      id: String(p.id),
      title: p.title,
      body: p.description ?? '',
      state,
      author: bbUser(p.author),
      createdAt: toIso(p.created_on) ?? '',
      updatedAt: toIso(p.updated_on) ?? '',
      mergedAt: p.state === 'MERGED' ? toIso(p.updated_on) : undefined,
      closedAt: open ? undefined : toIso(p.updated_on),
      head: {
        repo: srcRepo ? refOf(srcRepo.full_name, srcRepo.uuid) : null,
        repoCloneUrl: srcRepo ? `https://bitbucket.org/${srcRepo.full_name}.git` : undefined,
        branch: p.source.branch?.name ?? '',
        sha: p.source.commit?.hash ?? '',
      },
      base: {
        repo: dstRepo ? refOf(dstRepo.full_name, dstRepo.uuid) : ref,
        branch: p.destination.branch?.name ?? '',
        sha: p.destination.commit?.hash,
      },
      reviewers,
      assignees: [],
      labels: [],
      reviewDecision,
      mergeable: 'unknown',
      checksRollup,
      rollup: 'none',
      commentsCount: p.comment_count ?? 0,
      webUrl: p.links?.html?.href ?? `https://bitbucket.org/${ref.owner}/${ref.name}/pull-requests/${p.id}`,
      isCrossRepository: !!srcRepo && !!dstRepo && srcRepo.full_name !== dstRepo.full_name,
      viewer: {
        canMerge: open,
        canEdit: open,
        canApprove: open && !isAuthor,
        isAuthor,
        reviewRequested: reviewers.some((r) => r.user.id === viewerUuid && r.state === 'pending'),
      },
      allowedMergeMethods: [...BITBUCKET_CLOUD_CAPABILITIES.mergeMethods],
      etag,
    };
    pr.rollup = prRollupOf(pr);
    return pr;
  }

  function toCheck(s: BbStatus): CheckRun {
    return {
      id: s.uuid ?? s.key,
      name: s.name || s.key,
      group: s.key,
      status: bbCheckStatus(s.state),
      startedAt: toIso(s.created_on),
      completedAt: s.state === 'INPROGRESS' ? undefined : toIso(s.updated_on),
      detailsUrl: s.url,
      canRerun: false,
      provider: /\/pipelines\//.test(s.url ?? '') ? 'bitbucket-pipelines' : 'status-api',
    };
  }

  const commentItem = (c: BbComment, viewerUuid?: string): TimelineItem => ({
    kind: 'comment',
    id: String(c.id),
    author: bbUser(c.user),
    body: c.content?.raw ?? '',
    createdAt: toIso(c.created_on) ?? '',
    editable: !!viewerUuid && c.user?.uuid === viewerUuid,
  });

  async function getPrRaw(ref: RepoRef, n: number) {
    return http.get<BbPullRequest>(prPath(ref, n), { query: { fields: '+participants,+draft' } });
  }

  async function prChecks(ref: RepoRef, n: number): Promise<CheckRun[]> {
    try {
      return (await all<BbStatus>(`${prPath(ref, n)}/statuses`, { pagelen: 100 }, 5)).map(toCheck);
    } catch {
      return [];
    }
  }

  const provider: HostingProvider = {
    kind: 'bitbucket',
    capabilities: BITBUCKET_CLOUD_CAPABILITIES,

    async getViewer() {
      return bbUser(await me());
    },
    async getGrantedScopes() {
      const res = await http.request('user');
      return (res.headers.get('x-oauth-scopes') ?? '')
        .split(/[ ,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    },

    async listRepos({ owner, query, cursor, pageSize }) {
      const q = query ? `name ~ "${query.replace(/"/g, '\\"')}"` : undefined;
      const path = owner ? `repositories/${enc(owner)}` : 'repositories';
      const p = await page<BbRepo>(
        path,
        { role: 'member', sort: '-updated_on', pagelen: pageSize ?? 100, q },
        cursor,
      );
      return { items: p.values.map(toRepo), nextCursor: p.next, total: p.size };
    },
    async listOwners() {
      const perms = await all<{ workspace: { slug: string; name?: string; links?: { avatar?: BbLink } } }>(
        'user/permissions/workspaces',
        { pagelen: 100 },
      );
      return perms.map((p) => ({
        login: p.workspace.slug,
        avatarUrl: p.workspace.links?.avatar?.href,
        kind: 'workspace' as const,
      }));
    },
    async getRepo(ref) {
      return toRepo(await http.get<BbRepo>(repoPath(ref)));
    },
    async listForks(ref, cursor) {
      const p = await page<BbRepo>(`${repoPath(ref)}/forks`, { pagelen: 100 }, cursor);
      return { items: p.values.map(toRepo), nextCursor: p.next, total: p.size };
    },
    async createFork(ref, opts) {
      const body = opts?.owner ? { workspace: { slug: opts.owner } } : {};
      return toRepo(await http.post<BbRepo>(`${repoPath(ref)}/forks`, body));
    },
    async createRepo(opts) {
      const owner = opts.owner ?? (await me()).username ?? (await me()).nickname;
      if (!owner) throw unsupported('A workspace is required to create a Bitbucket repository.');
      const slug = opts.name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const r = await http.post<BbRepo>(`repositories/${enc(owner)}/${enc(slug)}`, {
        scm: 'git',
        name: opts.name,
        is_private: opts.private,
        description: opts.description,
      });
      return toRepo(r);
    },
    matchRemoteUrl(url) {
      const p = parseRemoteUrl(url);
      if (!p || !BB_HOSTS.has(p.host)) return null;
      const segs = p.path.split('/').filter(Boolean);
      if (segs.length !== 2) return null;
      return { owner: segs[0]!, name: segs[1]! };
    },

    async listPullRequests(ref, filter: PrFilter, cursor) {
      if (cursor) {
        const [p, v] = await Promise.all([page<BbPullRequest>('', {}, cursor), me().catch(() => undefined)]);
        return { items: p.values.map((x) => toPr(ref, x, v?.uuid)), nextCursor: p.next, total: p.size };
      }
      const v = await me().catch(() => undefined);
      const clauses: string[] = [];
      const preset = filter.preset ?? 'all';
      if (preset === 'mine' && v?.uuid) clauses.push(`author.uuid="${v.uuid}"`);
      if ((preset === 'review-requested' || preset === 'assigned') && v?.uuid)
        clauses.push(`reviewers.uuid="${v.uuid}"`);
      if (filter.author) clauses.push(`author.nickname="${filter.author}"`);
      if (filter.head) clauses.push(`source.branch.name="${filter.head}"`);
      if (filter.query) clauses.push(`title ~ "${filter.query.replace(/"/g, '\\"')}"`);
      const states =
        filter.state === 'merged'
          ? ['MERGED']
          : filter.state === 'closed'
            ? ['DECLINED', 'SUPERSEDED']
            : filter.state === 'all'
              ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']
              : ['OPEN'];
      const url = new URL(
        http.buildUrl(`${repoPath(ref)}/pullrequests`, {
          pagelen: 50,
          fields: '+values.participants,+values.draft',
          q: clauses.length ? clauses.join(' AND ') : undefined,
        }),
      );
      for (const s of states) url.searchParams.append('state', s);
      const p = await page<BbPullRequest>('', {}, url.toString());
      return { items: p.values.map((x) => toPr(ref, x, v?.uuid)), nextCursor: p.next, total: p.size };
    },

    async searchMyPullRequests(opts = {}) {
      const v = await me();
      const selected = v.uuid ?? v.account_id ?? '';
      const fields = '+values.participants,+values.draft';
      // Authored PRs across all repos (no cross-repo reviewer search on Bitbucket Cloud, spec 11 §6.4).
      const url = new URL(http.buildUrl(`pullrequests/${enc(selected)}`, { pagelen: 50, fields }));
      url.searchParams.append('state', 'OPEN');
      const authored = await page<BbPullRequest>('', {}, url.toString());
      const rows: MyPullRequest[] = authored.values.map((x) => ({
        pr: toPr(refOf(x.destination.repository?.full_name ?? ''), x, v.uuid),
        involvement: ['author'],
      }));
      // Reviewer search only for the given repos (workspace scope), capped at 30.
      if (v.uuid) {
        const lists = await Promise.all(
          (opts.repos ?? []).slice(0, 30).map(async (r) => {
            const ref: RepoRef = { integration, owner: r.owner, name: r.name };
            const p = await page<BbPullRequest>(`${repoPath(ref)}/pullrequests`, {
              pagelen: 50,
              fields,
              q: `reviewers.uuid="${v.uuid}" AND state="OPEN"`,
            });
            return p.values.map((x): MyPullRequest => ({
              pr: toPr(ref, x, v.uuid),
              involvement: ['reviewer'],
            }));
          }),
        );
        rows.push(...lists.flat());
      }
      const want = opts.repos?.length
        ? new Set(opts.repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()))
        : null;
      return mergeInvolved(
        rows.filter((r) => !want || want.has(`${r.pr.repo.owner}/${r.pr.repo.name}`.toLowerCase())),
        (r) => `${r.pr.repo.owner}/${r.pr.repo.name}#${r.pr.number}`,
      );
    },

    async getPullRequest(ref, n, opts) {
      const res = await http.request<BbPullRequest>(prPath(ref, n), {
        query: { fields: '+participants,+draft' },
        etag: opts?.etag,
      });
      if (res.notModified) return 'not-modified';
      const [v, checks] = await Promise.all([me().catch(() => undefined), prChecks(ref, n)]);
      return toPr(ref, res.data, v?.uuid, checks, res.etag);
    },

    async getTimeline(ref, n) {
      const v = await me().catch(() => undefined);
      const [comments, activity] = await Promise.all([
        all<BbComment>(`${prPath(ref, n)}/comments`, { pagelen: 100 }),
        all<BbActivity>(`${prPath(ref, n)}/activity`, { pagelen: 50 }),
      ]);
      const entries: Array<{ at: string; item: TimelineItem }> = [];
      const push = (at: string | undefined, item: TimelineItem): void => {
        entries.push({ at: at ?? ('createdAt' in item ? item.createdAt : ''), item });
      };
      const byId = new Map(comments.map((c) => [c.id, c]));
      const rootOf = (c: BbComment): BbComment => {
        let cur = c;
        for (let i = 0; i < 100 && cur.parent && byId.has(cur.parent.id); i++) cur = byId.get(cur.parent.id)!;
        return cur;
      };
      const threads = new Map<number, Extract<TimelineItem, { kind: 'thread' }>>();
      for (const c of comments) {
        if (c.deleted || c.pending) continue;
        const root = rootOf(c);
        if (root.inline) {
          let t = threads.get(root.id);
          if (!t) {
            const line = root.inline.to ?? root.inline.from ?? undefined;
            t = {
              kind: 'thread',
              id: `${n}:${root.id}`,
              path: root.inline.path,
              line: line ?? undefined,
              side: root.inline.to != null ? 'RIGHT' : 'LEFT',
              resolved: root.resolution != null,
              outdated: !!root.inline.outdated,
              comments: [],
            };
            threads.set(root.id, t);
            push(toIso(root.created_on), t);
          }
          t.comments.push({
            id: String(c.id),
            author: bbUser(c.user),
            body: c.content?.raw ?? '',
            createdAt: toIso(c.created_on) ?? '',
          });
        } else {
          push(toIso(c.created_on), commentItem(c, v?.uuid));
        }
      }
      for (const a of activity) {
        if (a.approval) {
          push(undefined, {
            kind: 'review',
            id: `approval:${a.approval.user.uuid}:${a.approval.date}`,
            author: bbUser(a.approval.user),
            state: 'approved',
            body: '',
            createdAt: toIso(a.approval.date) ?? '',
          });
        } else if (a.changes_requested) {
          push(undefined, {
            kind: 'review',
            id: `changes:${a.changes_requested.user.uuid}:${a.changes_requested.date}`,
            author: bbUser(a.changes_requested.user),
            state: 'changes_requested',
            body: '',
            createdAt: toIso(a.changes_requested.date) ?? '',
          });
        } else if (a.update) {
          push(undefined, {
            kind: 'event',
            event: a.update.state ? `state:${a.update.state.toLowerCase()}` : 'updated',
            actor: a.update.author ? bbUser(a.update.author) : undefined,
            createdAt: toIso(a.update.date) ?? '',
            detail: a.update.title,
          });
        }
      }
      entries.sort((x, y) => x.at.localeCompare(y.at));
      return { items: entries.map((e) => e.item) };
    },

    async getChecks(ref, sha) {
      return (await all<BbStatus>(`${repoPath(ref)}/commit/${enc(sha)}/statuses`, { pagelen: 100 }, 5)).map(
        toCheck,
      );
    },
    async listPrTemplates() {
      return []; // Bitbucket has no PR template files (spec 10 §6.3); local read covers the rest.
    },
    async searchUsers(ref, query) {
      const q = query.toLowerCase();
      const members = await all<{ user: BbUser }>(
        `workspaces/${enc(ref.owner)}/members`,
        { pagelen: 100 },
        5,
      );
      return members
        .map((m) => bbUser(m.user))
        .filter((u) => !q || u.login.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q));
    },
    async listLabels() {
      return [];
    },

    async createPullRequest(input: CreatePrInput) {
      const p = await http.post<BbPullRequest>(`${repoPath(input.base)}/pullrequests`, {
        title: input.title,
        description: input.body,
        source: {
          branch: { name: input.headBranch },
          repository: { full_name: `${input.head.owner}/${input.head.name}` },
        },
        destination: { branch: { name: input.baseBranch } },
        reviewers: (input.reviewers ?? []).map((r) => (r.startsWith('{') ? { uuid: r } : { account_id: r })),
        close_source_branch: !!input.deleteSourceBranch,
        draft: !!input.draft,
      });
      const v = await me().catch(() => undefined);
      return toPr(input.base, p, v?.uuid);
    },

    async updatePullRequest(ref, n, patch: UpdatePrInput) {
      if (patch.state === 'closed') await http.post(`${prPath(ref, n)}/decline`);
      else if (patch.state === 'open') {
        const cur = await getPrRaw(ref, n);
        if (cur.state !== 'OPEN') throw unsupported('Bitbucket Cloud cannot reopen a declined pull request.');
      }
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.body !== undefined) body.description = patch.body;
      if (patch.baseBranch !== undefined) body.destination = { branch: { name: patch.baseBranch } };
      if (patch.reviewers !== undefined)
        body.reviewers = patch.reviewers.map((r) => (r.startsWith('{') ? { uuid: r } : { account_id: r }));
      const p = Object.keys(body).length
        ? await http.put<BbPullRequest>(prPath(ref, n), body)
        : await getPrRaw(ref, n);
      const v = await me().catch(() => undefined);
      return toPr(ref, p, v?.uuid);
    },

    async addComment(ref, n, body, inReplyTo) {
      const parentId = inReplyTo ? Number(inReplyTo.split(':').pop()) : undefined;
      const c = await http.post<BbComment>(`${prPath(ref, n)}/comments`, {
        content: { raw: body },
        ...(parentId ? { parent: { id: parentId } } : {}),
      });
      const v = await me().catch(() => undefined);
      return commentItem(c, v?.uuid);
    },

    async submitReview(ref, n, input: SubmitReviewInput) {
      for (const c of input.comments ?? []) {
        await http.post(`${prPath(ref, n)}/comments`, {
          content: { raw: c.body },
          inline: c.side === 'LEFT' ? { path: c.path, from: c.line } : { path: c.path, to: c.line },
        });
      }
      if (input.body) await http.post(`${prPath(ref, n)}/comments`, { content: { raw: input.body } });
      if (input.event === 'APPROVE') await http.post(`${prPath(ref, n)}/approve`);
      else if (input.event === 'REQUEST_CHANGES') await http.post(`${prPath(ref, n)}/request-changes`);
    },

    async setThreadResolved(ref, threadId, resolved) {
      const [n, id] = threadId.split(':');
      if (!n || !id) throw new ProviderError({ code: 'validation', message: `Bad thread id ${threadId}` });
      const path = `${prPath(ref, Number(n))}/comments/${id}/resolve`;
      if (resolved) await http.post(path);
      else await http.delete(path);
    },

    async merge(ref, n, input) {
      const strategy = MERGE_STRATEGY[input.method];
      if (!strategy)
        throw unsupported(`Bitbucket Cloud does not support the "${input.method}" merge method.`);
      const cur = await getPrRaw(ref, n);
      const head = cur.source.commit?.hash ?? '';
      if (input.expectedHeadSha && head && !shaMatches(head, input.expectedHeadSha)) {
        throw new ProviderError({
          code: 'conflict',
          message: 'The pull request head changed since it was loaded. Refresh and try again.',
        });
      }
      const message = [input.title, input.message].filter(Boolean).join('\n\n') || undefined;
      const res = await http.request<BbPullRequest | { task_status?: string; links?: { self?: BbLink } }>(
        `${prPath(ref, n)}/merge`,
        {
          method: 'POST',
          body: { merge_strategy: strategy, message, close_source_branch: !!input.deleteBranch },
        },
      );
      if (res.status === 202) {
        const location =
          res.headers.get('location') ??
          (res.data as { links?: { self?: BbLink } } | undefined)?.links?.self?.href;
        if (!location) return { merged: false, message: 'Merge queued.' };
        const interval = o.mergePollIntervalMs ?? 1000;
        const deadline = Date.now() + (o.mergePollTimeoutMs ?? 60_000);
        while (Date.now() < deadline) {
          await sleep(interval);
          const t = await http.get<{ task_status: string; merge_result?: BbPullRequest }>('', {
            url: location,
          });
          if (t.task_status === 'SUCCESS') {
            return { merged: true, sha: t.merge_result?.merge_commit?.hash };
          }
        }
        return { merged: false, message: 'Merge is still in progress on Bitbucket.' };
      }
      const pr = res.data as BbPullRequest;
      return { merged: pr.state === 'MERGED', sha: pr.merge_commit?.hash ?? undefined };
    },

    async close(ref, n) {
      await http.post(`${prPath(ref, n)}/decline`);
    },
    async setDraft(ref, n, draft) {
      await http.put(prPath(ref, n), { draft });
    },

    async listCiRuns(ref, opts) {
      const p = await page<BbPipeline>(
        `${repoPath(ref)}/pipelines/`,
        { 'target.branch': opts.branch, sort: '-created_on', pagelen: 30 },
        opts.cursor,
      );
      return {
        items: p.values.map((x) => {
          const st = x.state.name;
          const result = x.state.result?.name;
          const status: CheckStatus =
            st === 'PENDING'
              ? 'queued'
              : st === 'IN_PROGRESS'
                ? 'in_progress'
                : result === 'SUCCESSFUL'
                  ? 'success'
                  : result === 'STOPPED'
                    ? 'cancelled'
                    : result === 'FAILED' || result === 'ERROR'
                      ? 'failure'
                      : 'neutral';
          return {
            id: x.uuid,
            name: `Pipeline #${x.build_number}`,
            status,
            startedAt: toIso(x.created_on),
            completedAt: toIso(x.completed_on),
            detailsUrl: `https://bitbucket.org/${ref.owner}/${ref.name}/pipelines/results/${x.build_number}`,
            canRerun: false,
            provider: 'bitbucket-pipelines' as const,
            runNumber: x.build_number,
            branch: x.target?.ref_name,
            event: x.trigger?.name?.toLowerCase(),
            actor: x.creator ? bbUser(x.creator) : undefined,
          };
        }),
        nextCursor: p.next,
      };
    },
    async cancelCi(ref, runId) {
      await http.post(`${repoPath(ref)}/pipelines/${enc(runId)}/stopPipeline`);
    },

    async uploadSshKey(title, publicKey) {
      const v = await me();
      const k = await http.post<{ uuid: string }>(`users/${enc(v.uuid ?? '')}/ssh-keys`, {
        key: publicKey.trim(),
        label: title,
      });
      return { id: k.uuid };
    },
    async listSshKeys() {
      const v = await me();
      const keys = await all<{ uuid: string; label?: string; comment?: string; fingerprint?: string }>(
        `users/${enc(v.uuid ?? '')}/ssh-keys`,
        { pagelen: 100 },
      );
      return keys.map((k) => ({ id: k.uuid, title: k.label ?? k.comment ?? '', fingerprint: k.fingerprint }));
    },
  };
  return provider;
}

/** HttpClient `errorMessage` for Bitbucket Cloud payloads (`{ error: { message, detail } }`). */
export function bitbucketCloudErrorMessage(_status: number, body: unknown): string | undefined {
  const e = (body as { error?: { message?: string; detail?: string } } | undefined)?.error;
  if (!e?.message) return undefined;
  return e.detail ? `${e.message}: ${e.detail}` : e.message;
}
