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
import { checksRollupOf, enc, integrationFor, prRollupOf, toIso, unsupported } from './shared';
import { mergeInvolved, type MyPullRequest } from '../types';

/**
 * Bitbucket Data Center / Server (REST 1.0, `https://{host}/rest/api/latest`) — spec 10 §6.2.
 * Owners are project keys (personal projects are `~username`). Merges/updates use optimistic
 * locking via the PR `version`.
 */

interface DcPage<T> {
  values: T[];
  size?: number;
  isLastPage: boolean;
  start?: number;
  limit?: number;
  nextPageStart?: number | null;
}
export interface DcUser {
  name: string;
  slug?: string;
  id?: number;
  displayName?: string;
  emailAddress?: string;
}
interface DcLinkSet {
  self?: Array<{ href: string }>;
  clone?: Array<{ href: string; name: string }>;
}
export interface DcRepo {
  id: number;
  slug: string;
  name: string;
  description?: string;
  public?: boolean;
  project: { key: string; name?: string; type?: 'NORMAL' | 'PERSONAL'; public?: boolean };
  origin?: DcRepo;
  links?: DcLinkSet;
}
interface DcRef {
  id: string;
  displayId?: string;
  latestCommit?: string;
  repository?: DcRepo;
}
export interface DcParticipant {
  user: DcUser;
  role?: 'AUTHOR' | 'REVIEWER' | 'PARTICIPANT';
  approved?: boolean;
  status?: 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED';
}
export interface DcPullRequest {
  id: number;
  version: number;
  title: string;
  description?: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  open?: boolean;
  draft?: boolean;
  createdDate: number;
  updatedDate: number;
  closedDate?: number;
  fromRef: DcRef;
  toRef: DcRef;
  author: DcParticipant;
  reviewers?: DcParticipant[];
  participants?: DcParticipant[];
  properties?: { commentCount?: number; mergeResult?: { outcome?: string }; mergeCommit?: { id: string } };
  links?: DcLinkSet;
}
interface DcComment {
  id: number;
  version?: number;
  text: string;
  author: DcUser;
  createdDate: number;
  comments?: DcComment[];
  threadResolved?: boolean;
  state?: 'OPEN' | 'RESOLVED' | 'PENDING';
}
interface DcActivity {
  id: number;
  createdDate: number;
  user: DcUser;
  action: string;
  commentAction?: string;
  comment?: DcComment;
  commentAnchor?: {
    path: string;
    line?: number;
    lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT';
    fileType?: 'FROM' | 'TO';
    orphaned?: boolean;
  };
  added?: { commits?: Array<{ id: string }> };
  removed?: { commits?: Array<{ id: string }> };
  addedCommits?: Array<{ id: string }>;
  removedCommits?: Array<{ id: string }>;
}
interface DcBuildStatus {
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'CANCELLED' | 'UNKNOWN';
  key: string;
  name?: string;
  url?: string;
  dateAdded?: number;
  updatedDate?: number;
  description?: string;
}

export interface BitbucketDcOptions {
  http: HttpClient;
  /** 'git.acme.com', 'git.acme.com:7990/bitbucket' or a full 'https://…' base. */
  host: string;
  integration?: IntegrationId;
}

export const BITBUCKET_DC_CAPABILITIES: ProviderCapabilities = {
  oauth: false,
  pat: true,
  graphql: false,
  prDraft: false,
  prLabels: false,
  prAssignees: false,
  prMilestone: false,
  prTeamsAsReviewers: false,
  prTemplates: false,
  prAutoMerge: false,
  prStacks: false,
  reviewThreadsResolve: false,
  mergeMethods: ['merge', 'squash', 'fast-forward', 'rebase', 'rebase-merge'],
  sshKeyUpload: false,
  forkList: true,
  createRepo: true,
  ci: true,
  ciRerun: false,
  issues: false,
  prRefspec: 'refs/pull-requests/{n}/from',
};

/** BBDC merge strategy ids → normalized method. */
export const DC_STRATEGY_TO_METHOD: Record<string, MergeMethod> = {
  'no-ff': 'merge',
  ff: 'merge',
  'ff-only': 'fast-forward',
  squash: 'squash',
  'squash-ff-only': 'squash',
  'rebase-no-ff': 'rebase-merge',
  'rebase-ff-only': 'rebase',
};
const METHOD_TO_STRATEGIES: Record<MergeMethod, string[]> = {
  merge: ['no-ff', 'ff'],
  'fast-forward': ['ff-only', 'ff'],
  squash: ['squash', 'squash-ff-only'],
  rebase: ['rebase-ff-only'],
  'rebase-merge': ['rebase-no-ff'],
  'semi-linear': ['rebase-no-ff'],
};

export function dcReviewState(p: DcParticipant): ReviewState {
  if (p.status === 'APPROVED' || p.approved) return 'approved';
  if (p.status === 'NEEDS_WORK') return 'changes_requested';
  return p.role === 'PARTICIPANT' ? 'commented' : 'pending';
}

export function dcCheckStatus(s: DcBuildStatus['state']): CheckStatus {
  switch (s) {
    case 'SUCCESSFUL':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'INPROGRESS':
      return 'in_progress';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'neutral';
  }
}

class HeadMovedError extends ProviderError {
  constructor() {
    super({
      code: 'conflict',
      message: 'The pull request head changed since it was loaded. Refresh and try again.',
    });
  }
}

const shaMatches = (a: string, b: string): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const stripRef = (id: string | undefined): string => (id ?? '').replace(/^refs\/heads\//, '');

export function createBitbucketDcProvider(o: BitbucketDcOptions): HostingProvider {
  const { http } = o;
  const webBase = (/^https?:\/\//i.test(o.host) ? o.host : `https://${o.host}`).replace(/\/+$/, '');
  const hostname = new URL(webBase).hostname.toLowerCase();
  const integration = integrationFor('bitbucket-dc', hostname, o.integration);
  /** `https://host/rest` — for non-core REST plugins (build-status). */
  const restRoot = http.baseUrl.replace(/\/+$/, '').replace(/\/api\/(latest|1\.0)$/, '');

  let viewer: Promise<DcUser> | undefined;
  const me = (): Promise<DcUser> => {
    viewer ??= (async () => {
      const res = await http.request('application-properties');
      const name = res.headers.get('x-ausername');
      if (!name)
        throw new ProviderError({ code: 'auth_required', message: 'Not authenticated to Bitbucket.' });
      return http.get<DcUser>(`users/${enc(name)}`);
    })().catch((e: unknown) => {
      viewer = undefined;
      throw e;
    });
    return viewer;
  };

  const userOf = (u: DcUser | undefined): ProviderUser =>
    u
      ? {
          id: String(u.id ?? u.name),
          login: u.name,
          name: u.displayName,
          email: u.emailAddress,
          avatarUrl: `${webBase}/users/${enc(u.slug ?? u.name)}/avatar.png`,
        }
      : { id: '', login: 'unknown' };

  const refOf = (r: DcRepo): RepoRef => ({
    integration,
    owner: r.project.key,
    name: r.slug,
    id: String(r.id),
  });
  const repoPath = (r: RepoRef): string => `projects/${enc(r.owner)}/repos/${enc(r.name)}`;
  const prPath = (r: RepoRef, n: number): string => `${repoPath(r)}/pull-requests/${n}`;

  async function page<T>(path: string, query: Record<string, string | number | undefined>, cursor?: string) {
    const p = await http.get<DcPage<T>>(path, { query: { ...query, start: cursor } });
    const nextCursor = !p.isLastPage && p.nextPageStart != null ? String(p.nextPageStart) : undefined;
    return { items: p.values, nextCursor, total: p.size };
  }
  async function all<T>(path: string, query: Record<string, string | number | undefined>, max = 20) {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < max; i++) {
      const p = await page<T>(path, query, cursor);
      out.push(...p.items);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    return out;
  }

  function toRepo(r: DcRepo, defaultBranch = ''): RemoteRepo {
    const clone = r.links?.clone ?? [];
    return {
      ref: refOf(r),
      fullName: `${r.project.key}/${r.slug}`,
      description: r.description || undefined,
      isPrivate: !(r.public ?? false),
      isFork: !!r.origin,
      parent: r.origin ? refOf(r.origin) : undefined,
      defaultBranch,
      httpsUrl:
        clone
          .find((c) => c.name === 'http' || c.name === 'https')
          ?.href.replace(/^(https?:\/\/)[^@/]+@/, '$1') ??
        `${webBase}/scm/${r.project.key.toLowerCase()}/${r.slug}.git`,
      sshUrl: clone.find((c) => c.name === 'ssh')?.href ?? '',
      webUrl: r.links?.self?.[0]?.href ?? `${webBase}/projects/${r.project.key}/repos/${r.slug}/browse`,
      updatedAt: '',
    };
  }

  const mergeSettings = new Map<string, MergeMethod[]>();
  async function allowedMethods(ref: RepoRef): Promise<{ methods: MergeMethod[]; strategies: string[] }> {
    try {
      const s = await http.get<{
        mergeConfig?: {
          strategies?: Array<{ id: string; enabled: boolean }>;
          defaultStrategy?: { id: string };
        };
      }>(`${repoPath(ref)}/settings/pull-requests`);
      const strategies = (s.mergeConfig?.strategies ?? []).filter((x) => x.enabled).map((x) => x.id);
      const methods = [
        ...new Set(strategies.map((id) => DC_STRATEGY_TO_METHOD[id]).filter(Boolean)),
      ] as MergeMethod[];
      const result = { methods: methods.length ? methods : ['merge' as const], strategies };
      mergeSettings.set(`${ref.owner}/${ref.name}`, result.methods);
      return result;
    } catch {
      return { methods: ['merge'], strategies: [] };
    }
  }

  function toPr(ref: RepoRef, p: DcPullRequest, v?: DcUser, checks?: CheckRun[]): PullRequest {
    const reviewers = (p.reviewers ?? []).map((r) => ({ user: userOf(r.user), state: dcReviewState(r) }));
    const states = reviewers.map((r) => r.state);
    const reviewDecision = states.includes('changes_requested')
      ? 'changes_requested'
      : states.includes('approved')
        ? 'approved'
        : reviewers.length
          ? 'review_required'
          : null;
    const open = p.state === 'OPEN';
    const outcome = p.properties?.mergeResult?.outcome;
    const fromRepo = p.fromRef.repository;
    const toRepoRaw = p.toRef.repository;
    const isAuthor = !!v && p.author.user.name === v.name;
    const pr: PullRequest = {
      repo: ref,
      number: p.id,
      id: String(p.id),
      title: p.title,
      body: p.description ?? '',
      state: open ? (p.draft ? 'draft' : 'open') : p.state === 'MERGED' ? 'merged' : 'closed',
      author: userOf(p.author.user),
      createdAt: toIso(p.createdDate) ?? '',
      updatedAt: toIso(p.updatedDate) ?? '',
      mergedAt: p.state === 'MERGED' ? toIso(p.closedDate ?? p.updatedDate) : undefined,
      closedAt: open ? undefined : toIso(p.closedDate ?? p.updatedDate),
      head: {
        repo: fromRepo ? refOf(fromRepo) : null,
        repoCloneUrl: fromRepo ? toRepo(fromRepo).httpsUrl : undefined,
        branch: p.fromRef.displayId ?? stripRef(p.fromRef.id),
        sha: p.fromRef.latestCommit ?? '',
      },
      base: {
        repo: toRepoRaw ? refOf(toRepoRaw) : ref,
        branch: p.toRef.displayId ?? stripRef(p.toRef.id),
        sha: p.toRef.latestCommit,
      },
      reviewers,
      assignees: [],
      labels: [],
      reviewDecision,
      mergeable: outcome === 'CLEAN' ? 'mergeable' : outcome === 'CONFLICTED' ? 'conflicting' : 'unknown',
      checksRollup: checks ? checksRollupOf(checks) : 'none',
      rollup: 'none',
      commentsCount: p.properties?.commentCount ?? 0,
      webUrl:
        p.links?.self?.[0]?.href ??
        `${webBase}/projects/${ref.owner}/repos/${ref.name}/pull-requests/${p.id}`,
      isCrossRepository: !!fromRepo && !!toRepoRaw && fromRepo.id !== toRepoRaw.id,
      viewer: {
        canMerge: open,
        canEdit: open,
        canApprove: open && !isAuthor,
        isAuthor,
        reviewRequested:
          !!v && (p.reviewers ?? []).some((r) => r.user.name === v.name && r.status !== 'APPROVED'),
      },
      allowedMergeMethods: mergeSettings.get(`${ref.owner}/${ref.name}`) ?? ['merge'],
    };
    pr.rollup = prRollupOf(pr);
    return pr;
  }

  const toCheck = (s: DcBuildStatus): CheckRun => ({
    id: s.key,
    name: s.name || s.key,
    group: s.key,
    status: dcCheckStatus(s.state),
    startedAt: toIso(s.dateAdded),
    completedAt: s.state === 'INPROGRESS' ? undefined : toIso(s.updatedDate ?? s.dateAdded),
    detailsUrl: s.url,
    canRerun: false,
    provider: 'status-api',
  });

  async function getChecks(_ref: RepoRef, sha: string): Promise<CheckRun[]> {
    const p = await http.get<DcPage<DcBuildStatus>>(`${restRoot}/build-status/latest/commits/${enc(sha)}`, {
      query: { limit: 100 },
    });
    return p.values.map(toCheck);
  }

  const getRaw = (ref: RepoRef, n: number): Promise<DcPullRequest> => http.get<DcPullRequest>(prPath(ref, n));

  /** Runs a version-locked mutation; on 409 (stale version) refetches and retries once (spec 10 §8). */
  async function withVersion<T>(ref: RepoRef, n: number, fn: (pr: DcPullRequest) => Promise<T>): Promise<T> {
    try {
      return await fn(await getRaw(ref, n));
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'conflict' && !(e instanceof HeadMovedError))
        return fn(await getRaw(ref, n));
      throw e;
    }
  }

  const commentItem = (c: DcComment, v?: DcUser): TimelineItem => ({
    kind: 'comment',
    id: String(c.id),
    author: userOf(c.author),
    body: c.text,
    createdAt: toIso(c.createdDate) ?? '',
    editable: !!v && c.author.name === v.name,
  });
  const flatten = (c: DcComment): DcComment[] => [c, ...(c.comments ?? []).flatMap(flatten)];

  const provider: HostingProvider = {
    kind: 'bitbucket-dc',
    capabilities: BITBUCKET_DC_CAPABILITIES,

    async getViewer() {
      return userOf(await me());
    },
    async getGrantedScopes() {
      return []; // HTTP access tokens expose no scope introspection.
    },

    async listRepos({ owner, query, cursor, pageSize }) {
      const limit = pageSize ?? 100;
      if (owner) {
        const p = await page<DcRepo>(`projects/${enc(owner)}/repos`, { limit }, cursor);
        const q = query?.toLowerCase();
        const items = p.items.filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug.includes(q));
        return { items: items.map((r) => toRepo(r)), nextCursor: p.nextCursor, total: p.total };
      }
      const p = await page<DcRepo>('repos', { limit, name: query }, cursor);
      return { items: p.items.map((r) => toRepo(r)), nextCursor: p.nextCursor, total: p.total };
    },
    async listOwners() {
      const projects = await all<{ key: string; name?: string; type?: string }>('projects', { limit: 100 });
      const owners: Array<{ login: string; avatarUrl?: string; kind: 'user' | 'project' }> = projects.map(
        (p) => ({
          login: p.key,
          avatarUrl: `${webBase}/projects/${enc(p.key)}/avatar.png`,
          kind: 'project',
        }),
      );
      try {
        const v = await me();
        owners.unshift({ login: `~${v.slug ?? v.name}`, avatarUrl: userOf(v).avatarUrl, kind: 'user' });
      } catch {
        /* anonymous */
      }
      return owners;
    },
    async getRepo(ref) {
      const r = await http.get<DcRepo>(repoPath(ref));
      let def = '';
      try {
        const b = await http.get<{ displayId?: string; id?: string }>(`${repoPath(ref)}/default-branch`);
        def = b.displayId ?? stripRef(b.id);
      } catch {
        try {
          const b = await http.get<{ displayId?: string }>(`${repoPath(ref)}/branches/default`);
          def = b.displayId ?? '';
        } catch {
          /* empty repo */
        }
      }
      return toRepo(r, def);
    },
    async listForks(ref, cursor) {
      const p = await page<DcRepo>(`${repoPath(ref)}/forks`, { limit: 100 }, cursor);
      return { items: p.items.map((r) => toRepo(r)), nextCursor: p.nextCursor, total: p.total };
    },
    async createFork(ref, opts) {
      const r = await http.post<DcRepo>(repoPath(ref), opts?.owner ? { project: { key: opts.owner } } : {});
      return toRepo(r);
    },
    async createRepo(opts) {
      const owner = opts.owner ?? `~${(await me()).slug ?? (await me()).name}`;
      const r = await http.post<DcRepo>(`projects/${enc(owner)}/repos`, {
        name: opts.name,
        scmId: 'git',
        public: !opts.private,
        description: opts.description,
      });
      return toRepo(r);
    },
    matchRemoteUrl(url) {
      const p = parseRemoteUrl(url);
      if (!p || p.host !== hostname) return null;
      const segs = p.path.split('/').filter(Boolean);
      let key: string | undefined;
      let slug: string | undefined;
      const scm = segs.lastIndexOf('scm');
      const projects = segs.indexOf('projects');
      const users = segs.indexOf('users');
      if (scm >= 0 && segs.length - scm === 3) [key, slug] = [segs[scm + 1], segs[scm + 2]];
      else if (projects >= 0 && segs[projects + 2] === 'repos')
        [key, slug] = [segs[projects + 1], segs[projects + 3]];
      else if (users >= 0 && segs[users + 2] === 'repos')
        [key, slug] = [`~${segs[users + 1]}`, segs[users + 3]];
      else if (segs.length >= 2) [key, slug] = [segs[segs.length - 2], segs[segs.length - 1]];
      if (!key || !slug) return null;
      return { owner: key.startsWith('~') ? key.toLowerCase() : key.toUpperCase(), name: slug.toLowerCase() };
    },

    async listPullRequests(ref, filter: PrFilter, cursor) {
      const v = await me().catch(() => undefined);
      const preset = filter.preset ?? 'all';
      const role =
        preset === 'mine'
          ? 'AUTHOR'
          : preset === 'review-requested' || preset === 'assigned'
            ? 'REVIEWER'
            : undefined;
      const username = filter.author ?? (role ? v?.name : undefined);
      const state = { open: 'OPEN', merged: 'MERGED', closed: 'DECLINED', all: 'ALL' }[
        filter.state ?? 'open'
      ];
      const p = await page<DcPullRequest>(
        `${repoPath(ref)}/pull-requests`,
        {
          state,
          limit: 50,
          order: 'NEWEST',
          'role.1': username ? (filter.author ? 'AUTHOR' : role) : undefined,
          'username.1': username,
          at: filter.head ? `refs/heads/${filter.head}` : undefined,
          direction: filter.head ? 'OUTGOING' : undefined,
          filterText: filter.query,
        },
        cursor,
      );
      return { items: p.items.map((x) => toPr(ref, x, v)), nextCursor: p.nextCursor, total: p.total };
    },

    async searchMyPullRequests(opts = {}) {
      const v = await me().catch(() => undefined);
      const want = opts.repos?.length
        ? new Set(opts.repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()))
        : null;
      const roles: Array<['AUTHOR' | 'REVIEWER', 'author' | 'reviewer']> = [
        ['AUTHOR', 'author'],
        ['REVIEWER', 'reviewer'],
      ];
      const lists = await Promise.all(
        roles.map(async ([role, inv]) => {
          const p = await page<DcPullRequest>('dashboard/pull-requests', {
            state: 'OPEN',
            role,
            order: 'NEWEST',
            limit: Math.min(opts.limit ?? 50, 100),
          });
          return p.items
            .filter((x) => x.toRef.repository)
            .map((x): MyPullRequest => ({ pr: toPr(refOf(x.toRef.repository!), x, v), involvement: [inv] }));
        }),
      );
      return mergeInvolved(
        lists.flat().filter((r) => !want || want.has(`${r.pr.repo.owner}/${r.pr.repo.name}`.toLowerCase())),
        (r) => `${r.pr.repo.owner}/${r.pr.repo.name}#${r.pr.number}`,
      );
    },

    async getPullRequest(ref, n, opts) {
      const res = await http.request<DcPullRequest>(prPath(ref, n), { etag: opts?.etag });
      if (res.notModified) return 'not-modified';
      const sha = res.data.fromRef.latestCommit;
      const [v, checks] = await Promise.all([
        me().catch(() => undefined),
        sha ? getChecks(ref, sha).catch(() => []) : Promise.resolve([]),
        allowedMethods(ref),
      ]);
      const pr = toPr(ref, res.data, v, checks);
      pr.etag = res.etag;
      return pr;
    },

    async getTimeline(ref, n, cursor) {
      const v = await me().catch(() => undefined);
      const p = await page<DcActivity>(`${prPath(ref, n)}/activities`, { limit: 50 }, cursor);
      const items: TimelineItem[] = [];
      for (const a of p.items) {
        const at = toIso(a.createdDate) ?? '';
        switch (a.action) {
          case 'COMMENTED': {
            if (!a.comment || (a.commentAction && a.commentAction !== 'ADDED')) break;
            if (a.commentAnchor) {
              const anc = a.commentAnchor;
              items.push({
                kind: 'thread',
                id: String(a.comment.id),
                path: anc.path,
                line: anc.line,
                side: anc.fileType === 'FROM' || anc.lineType === 'REMOVED' ? 'LEFT' : 'RIGHT',
                resolved: !!a.comment.threadResolved || a.comment.state === 'RESOLVED',
                outdated: !!anc.orphaned,
                comments: flatten(a.comment).map((c) => ({
                  id: String(c.id),
                  author: userOf(c.author),
                  body: c.text,
                  createdAt: toIso(c.createdDate) ?? '',
                })),
              });
            } else {
              for (const c of flatten(a.comment)) items.push(commentItem(c, v));
            }
            break;
          }
          case 'APPROVED':
            items.push({
              kind: 'review',
              id: String(a.id),
              author: userOf(a.user),
              state: 'approved',
              body: '',
              createdAt: at,
            });
            break;
          case 'REVIEWED':
            items.push({
              kind: 'review',
              id: String(a.id),
              author: userOf(a.user),
              state: 'changes_requested',
              body: '',
              createdAt: at,
            });
            break;
          case 'RESCOPED': {
            const added = a.added?.commits ?? a.addedCommits ?? [];
            const removed = a.removed?.commits ?? a.removedCommits ?? [];
            if (added.length || removed.length)
              items.push({
                kind: 'commits',
                shas: added.map((c) => c.id),
                actor: userOf(a.user),
                createdAt: at,
                forced: removed.length > 0,
              });
            break;
          }
          default:
            items.push({
              kind: 'event',
              event: a.action.toLowerCase(),
              actor: userOf(a.user),
              createdAt: at,
            });
        }
      }
      return { items, nextCursor: p.nextCursor };
    },

    getChecks,
    async listPrTemplates() {
      return [];
    },
    async searchUsers(ref, query) {
      const p = await http.get<DcPage<DcUser>>('users', {
        query: {
          filter: query,
          limit: 25,
          'permission.1': 'REPO_READ',
          'permission.1.projectKey': ref.owner,
          'permission.1.repositorySlug': ref.name,
        },
      });
      return p.values.map(userOf);
    },
    async listLabels() {
      return [];
    },

    async createPullRequest(input: CreatePrInput) {
      const side = (r: RepoRef, branch: string) => ({
        id: `refs/heads/${branch}`,
        repository: { slug: r.name, project: { key: r.owner } },
      });
      const p = await http.post<DcPullRequest>(`${repoPath(input.base)}/pull-requests`, {
        title: input.title,
        description: input.body,
        fromRef: side(input.head, input.headBranch),
        toRef: side(input.base, input.baseBranch),
        reviewers: (input.reviewers ?? []).map((name) => ({ user: { name } })),
      });
      return toPr(input.base, p, await me().catch(() => undefined));
    },

    async updatePullRequest(ref, n, patch: UpdatePrInput) {
      if (patch.state === 'closed')
        await withVersion(ref, n, (pr) =>
          http.post(`${prPath(ref, n)}/decline`, {}, { query: { version: pr.version } }),
        );
      if (patch.state === 'open')
        await withVersion(ref, n, (pr) =>
          http.post(`${prPath(ref, n)}/reopen`, {}, { query: { version: pr.version } }),
        );
      const hasEdit =
        patch.title !== undefined ||
        patch.body !== undefined ||
        patch.baseBranch !== undefined ||
        patch.reviewers !== undefined;
      const p = hasEdit
        ? await withVersion(ref, n, (pr) =>
            http.put<DcPullRequest>(prPath(ref, n), {
              version: pr.version,
              title: patch.title ?? pr.title,
              description: patch.body ?? pr.description,
              ...(patch.baseBranch
                ? { toRef: { id: `refs/heads/${patch.baseBranch}`, repository: pr.toRef.repository } }
                : {}),
              reviewers: patch.reviewers
                ? patch.reviewers.map((name) => ({ user: { name } }))
                : (pr.reviewers ?? []).map((r) => ({ user: { name: r.user.name } })),
            }),
          )
        : await getRaw(ref, n);
      return toPr(ref, p, await me().catch(() => undefined));
    },

    async addComment(ref, n, body, inReplyTo) {
      const c = await http.post<DcComment>(`${prPath(ref, n)}/comments`, {
        text: body,
        ...(inReplyTo ? { parent: { id: Number(inReplyTo) } } : {}),
      });
      return commentItem(c, await me().catch(() => undefined));
    },

    async submitReview(ref, n, input: SubmitReviewInput) {
      for (const c of input.comments ?? []) {
        await http.post(`${prPath(ref, n)}/comments`, {
          text: c.body,
          anchor: {
            path: c.path,
            line: c.line,
            lineType: c.side === 'LEFT' ? 'REMOVED' : 'ADDED',
            fileType: c.side === 'LEFT' ? 'FROM' : 'TO',
            diffType: 'EFFECTIVE',
          },
        });
      }
      if (input.body) await http.post(`${prPath(ref, n)}/comments`, { text: input.body });
      if (input.event === 'COMMENT') return;
      const v = await me();
      await http.put(`${prPath(ref, n)}/participants/${enc(v.slug ?? v.name)}`, {
        user: { name: v.name },
        approved: input.event === 'APPROVE',
        status: input.event === 'APPROVE' ? 'APPROVED' : 'NEEDS_WORK',
      });
    },

    async merge(ref, n, input) {
      const { strategies } = await allowedMethods(ref);
      const wanted = METHOD_TO_STRATEGIES[input.method] ?? [];
      const strategyId = strategies.length ? wanted.find((s) => strategies.includes(s)) : wanted[0];
      if (!strategyId)
        throw unsupported(`The "${input.method}" merge strategy is not enabled for this repository.`);
      const message = [input.title, input.message].filter(Boolean).join('\n\n') || undefined;
      const res = await withVersion(ref, n, async (pr) => {
        if (
          input.expectedHeadSha &&
          pr.fromRef.latestCommit &&
          !shaMatches(pr.fromRef.latestCommit, input.expectedHeadSha)
        )
          throw new HeadMovedError();
        return http.post<DcPullRequest>(
          `${prPath(ref, n)}/merge`,
          { strategyId, message },
          { query: { version: pr.version } },
        );
      });
      if (input.deleteBranch && res.state === 'MERGED' && res.fromRef.repository) {
        try {
          await http.request(
            `${restRoot}/branch-utils/latest/${repoPath(refOf(res.fromRef.repository))}/branches`,
            {
              method: 'DELETE',
              body: { name: res.fromRef.id, dryRun: false },
            },
          );
        } catch {
          /* best effort: the merge itself succeeded */
        }
      }
      return { merged: res.state === 'MERGED', sha: res.properties?.mergeCommit?.id };
    },

    async close(ref, n) {
      await withVersion(ref, n, (pr) =>
        http.post(`${prPath(ref, n)}/decline`, {}, { query: { version: pr.version } }),
      );
    },
    async reopen(ref, n) {
      await withVersion(ref, n, (pr) =>
        http.post(`${prPath(ref, n)}/reopen`, {}, { query: { version: pr.version } }),
      );
    },
  };
  return provider;
}

/** HttpClient `errorMessage` for BBDC payloads (`{ errors: [{ message }] }`). */
export function bitbucketDcErrorMessage(_status: number, body: unknown): string | undefined {
  const errs = (body as { errors?: Array<{ message?: string }> } | undefined)?.errors;
  return errs?.length
    ? errs
        .map((e) => e.message)
        .filter(Boolean)
        .join('; ')
    : undefined;
}
