import { type HttpClient, ProviderError, parseRemoteUrl } from '../http';
import type {
  CheckRun,
  CheckStatus,
  CreatePrInput,
  HostingProvider,
  IntegrationId,
  ListPage,
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
import { mergeInvolved, type MyPullRequest } from '../types';
import {
  checksRollupOf,
  enc,
  integrationFor,
  prRollupOf,
  stripHeads,
  toIso,
  unsupported,
} from '../bitbucket/shared';

/**
 * Azure DevOps Services (`https://dev.azure.com/{org}` or legacy `https://{org}.visualstudio.com`),
 * REST api-version 7.1 — spec 10 §6.2. RepoRef.owner is "org/project".
 * All URLs are built absolutely from `host`, so the HttpClient baseUrl is only a fallback.
 */

export const AZURE_API_VERSION = '7.1';
const VSSPS = 'https://app.vssps.visualstudio.com';

// ---- raw shapes (subset) ----
export interface AzIdentity {
  id: string;
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
  isContainer?: boolean;
  _links?: { avatar?: { href: string } };
}
export interface AzReviewer extends AzIdentity {
  vote: number;
  isRequired?: boolean;
  hasDeclined?: boolean;
}
export interface AzRepo {
  id: string;
  name: string;
  project: { id: string; name: string; visibility?: string; lastUpdateTime?: string; description?: string };
  defaultBranch?: string;
  remoteUrl?: string;
  sshUrl?: string;
  webUrl?: string;
  isFork?: boolean;
  isDisabled?: boolean;
  parentRepository?: { id: string; name: string; project?: { name: string }; collection?: { name?: string } };
}
export interface AzPullRequest {
  pullRequestId: number;
  codeReviewId?: number;
  status: 'active' | 'completed' | 'abandoned' | 'notSet' | 'all';
  isDraft?: boolean;
  title: string;
  description?: string;
  createdBy: AzIdentity;
  creationDate: string;
  closedDate?: string;
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
  mergeStatus?: 'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure';
  mergeFailureMessage?: string;
  reviewers?: AzReviewer[];
  labels?: Array<{ name: string; active?: boolean }>;
  repository: AzRepo;
  forkSource?: { repository: AzRepo };
  autoCompleteSetBy?: AzIdentity;
}
interface AzComment {
  id: number;
  parentCommentId?: number;
  author: AzIdentity;
  content?: string;
  publishedDate: string;
  commentType?: 'text' | 'system' | 'codeChange' | 'unknown';
  isDeleted?: boolean;
}
export interface AzThread {
  id: number;
  publishedDate: string;
  status?: 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending' | 'unknown';
  isDeleted?: boolean;
  comments: AzComment[];
  threadContext?: {
    filePath: string;
    rightFileStart?: { line: number };
    leftFileStart?: { line: number };
  } | null;
  properties?: Record<string, { $value?: string | number } | undefined>;
}
export interface AzStatus {
  id: number;
  state: 'notSet' | 'pending' | 'succeeded' | 'failed' | 'error' | 'notApplicable';
  description?: string;
  context: { name: string; genre?: string };
  targetUrl?: string;
  creationDate?: string;
  updatedDate?: string;
}
export interface AzPolicyEvaluation {
  evaluationId: string;
  status: 'queued' | 'running' | 'approved' | 'rejected' | 'notApplicable' | 'broken';
  configuration: {
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { displayName?: string };
    settings?: { displayName?: string };
  };
  context?: { buildId?: number };
  startedDate?: string;
  completedDate?: string;
}
interface AzBuild {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  definition?: { name: string };
  sourceBranch?: string;
  reason?: string;
  requestedFor?: AzIdentity;
  startTime?: string;
  finishTime?: string;
  queueTime?: string;
  _links?: { web?: { href: string } };
}

export interface AzureDevOpsOptions {
  http: HttpClient;
  /** 'dev.azure.com' or '{org}.visualstudio.com'. */
  host: string;
  /** Restrict to one organization (required for PAT-scoped single-org accounts). */
  organization?: string;
  integration?: IntegrationId;
}

export const AZURE_DEVOPS_CAPABILITIES: ProviderCapabilities = {
  oauth: true,
  pat: true,
  graphql: false,
  prDraft: true,
  prLabels: true,
  prAssignees: false,
  prMilestone: false,
  prTeamsAsReviewers: true,
  prTemplates: true,
  prAutoMerge: true,
  prStacks: false,
  reviewThreadsResolve: true,
  mergeMethods: ['merge', 'squash', 'rebase', 'rebase-merge'],
  sshKeyUpload: false,
  forkList: true,
  createRepo: false,
  ci: true,
  ciRerun: true,
  issues: true,
  prRefspec: 'refs/pull/{n}/merge',
};

/** Reviewer vote → ReviewState (10 approved, 5 approved w/ suggestions, 0 none, -5 waiting, -10 rejected). */
export function azVoteToState(vote: number, hasDeclined?: boolean): ReviewState {
  if (vote >= 5) return 'approved';
  if (vote <= -5) return 'changes_requested';
  return hasDeclined ? 'dismissed' : 'pending';
}

export const AZ_MERGE_STRATEGY: Partial<Record<MergeMethod, string>> = {
  merge: 'noFastForward',
  squash: 'squash',
  rebase: 'rebase',
  'rebase-merge': 'rebaseMerge',
};

export function azStatusToCheck(s: AzStatus['state']): CheckStatus {
  switch (s) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'error':
      return 'failure';
    case 'pending':
      return 'in_progress';
    case 'notApplicable':
      return 'skipped';
    default:
      return 'queued';
  }
}
export function azPolicyToCheck(s: AzPolicyEvaluation['status']): CheckStatus {
  switch (s) {
    case 'approved':
      return 'success';
    case 'rejected':
    case 'broken':
      return 'failure';
    case 'running':
      return 'in_progress';
    case 'notApplicable':
      return 'skipped';
    default:
      return 'queued';
  }
}

const RESOLVED_THREAD = new Set(['fixed', 'wontFix', 'closed', 'byDesign']);
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/** Parses Azure DevOps clone URLs (https dev.azure.com / visualstudio.com, ssh v3). */
export function parseAzureRemote(url: string): { org: string; project: string; repo: string } | null {
  const p = parseRemoteUrl(url);
  if (!p) return null;
  const host = p.host;
  const segs = p.path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo} | {org}@vs-ssh.visualstudio.com:v3/…
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    if (segs[0] !== 'v3' || segs.length !== 4) return null;
    return { org: segs[1]!, project: segs[2]!, repo: segs[3]! };
  }
  const git = segs.indexOf('_git');
  if (git < 0 || git + 1 >= segs.length) return null;
  const repo = segs[git + 1]!;
  let org: string | undefined;
  let rest: string[];
  if (host === 'dev.azure.com') {
    // `_git` must follow at least the org segment (`dev.azure.com/_git/x` is not a repo URL).
    org = git >= 1 ? segs[0] : undefined;
    rest = segs.slice(1, git);
  } else if (host.endsWith('.visualstudio.com')) {
    org = host.slice(0, -'.visualstudio.com'.length);
    rest = segs.slice(0, git).filter((s) => s.toLowerCase() !== 'defaultcollection');
  } else return null;
  if (!org) return null;
  // `_git/{repo}` directly under org → project has the same name as the repo.
  const project = rest[rest.length - 1] ?? repo;
  return { org, project, repo };
}

export type AzureDevOpsProvider = HostingProvider & {
  /** PR statuses + policy evaluations (build validation, required reviewers, …). */
  getPrChecks(ref: RepoRef, number: number): Promise<CheckRun[]>;
  listOrganizations(): Promise<string[]>;
};

export function createAzureDevOpsProvider(o: AzureDevOpsOptions): AzureDevOpsProvider {
  const { http } = o;
  const host = o.host
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const legacyOrg = host.endsWith('.visualstudio.com')
    ? host.slice(0, -'.visualstudio.com'.length)
    : undefined;
  const defaultOrg = o.organization ?? legacyOrg;
  const integration = integrationFor('azure-devops', host, o.integration);

  const orgBase = (org: string): string =>
    host.endsWith('.visualstudio.com')
      ? `https://${enc(org)}.visualstudio.com`
      : `https://dev.azure.com/${enc(org)}`;
  const split = (owner: string): { org: string; project: string } => {
    const i = owner.indexOf('/');
    if (i < 0) {
      if (!defaultOrg)
        throw new ProviderError({ code: 'validation', message: `Owner "${owner}" must be "org/project".` });
      return { org: defaultOrg, project: owner };
    }
    return { org: owner.slice(0, i), project: owner.slice(i + 1) };
  };
  const projBase = (r: { owner: string }): string => {
    const { org, project } = split(r.owner);
    return `${orgBase(org)}/${enc(project)}/_apis`;
  };
  const repoApi = (r: RepoRef): string => `${projBase(r)}/git/repositories/${enc(r.id ?? r.name)}`;
  const prApi = (r: RepoRef, n: number): string => `${repoApi(r)}/pullrequests/${n}`;

  /** All calls go through here: adds api-version, maps the 203 sign-in page to auth_required. */
  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      apiVersion?: string;
    } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const res = await http.request<T>(url, {
      method,
      query: { ...opts.query, 'api-version': opts.apiVersion ?? AZURE_API_VERSION },
      body: opts.body,
    });
    if (res.status === 203 || (typeof res.data === 'string' && /<html/i.test(res.data))) {
      throw new ProviderError({
        code: 'auth_required',
        message:
          'Azure DevOps rejected the credentials (sign-in page returned). Check the PAT and organization.',
      });
    }
    return { data: res.data, headers: res.headers };
  }
  const get = async <T>(url: string, query?: Record<string, string | number | boolean | undefined>) =>
    (await call<T>('GET', url, { query })).data;

  /** Pages through APIs that use the x-ms-continuationtoken header. */
  async function tokenPage<T>(
    url: string,
    query: Record<string, string | number | undefined>,
    cursor?: string,
  ): Promise<ListPage<T>> {
    const { data, headers } = await call<{ value: T[]; count?: number }>('GET', url, {
      query: { ...query, continuationToken: cursor },
    });
    return { items: data.value, nextCursor: headers.get('x-ms-continuationtoken') ?? undefined };
  }

  // identity
  let profile:
    Promise<{ id: string; displayName?: string; emailAddress?: string; publicAlias?: string }> | undefined;
  const getProfile = () => {
    profile ??= get<{ id: string; displayName?: string; emailAddress?: string; publicAlias?: string }>(
      `${VSSPS}/_apis/profile/profiles/me`,
    ).catch((e: unknown) => {
      profile = undefined;
      throw e;
    });
    return profile;
  };
  const connData = new Map<
    string,
    Promise<{
      authenticatedUser: AzIdentity & {
        providerDisplayName?: string;
        properties?: Record<string, { $value?: string }>;
      };
      instanceId: string;
    }>
  >();
  const connection = (org: string) => {
    let p = connData.get(org);
    if (!p) {
      p = get(`${orgBase(org)}/_apis/connectionData`);
      p.catch(() => connData.delete(org));
      connData.set(org, p);
    }
    return p;
  };
  /** Identity id of the viewer within an org (reviewer ids are identity ids). */
  const viewerId = async (org: string): Promise<string> => (await connection(org)).authenticatedUser.id;

  async function listOrganizations(): Promise<string[]> {
    if (defaultOrg) return [defaultOrg];
    const p = await getProfile();
    const accounts = await get<{ value: Array<{ accountName: string }> }>(`${VSSPS}/_apis/accounts`, {
      memberId: p.id,
    });
    return accounts.value.map((a) => a.accountName);
  }

  const userOf = (u: AzIdentity | undefined): ProviderUser =>
    u
      ? {
          id: u.id,
          login: u.uniqueName ?? u.displayName ?? u.id,
          name: u.displayName,
          avatarUrl: u._links?.avatar?.href ?? u.imageUrl,
          isTeam: u.isContainer ? true : undefined,
        }
      : { id: '', login: 'unknown' };

  const repoRefOf = (org: string, r: AzRepo): RepoRef => ({
    integration,
    owner: `${org}/${r.project.name}`,
    name: r.name,
    id: r.id,
  });
  const orgOfUrl = (u: string | undefined, fallback: string): string => {
    const parsed = u ? parseAzureRemote(u) : null;
    return parsed?.org ?? fallback;
  };

  function toRepo(org: string, r: AzRepo): RemoteRepo {
    const parent = r.parentRepository;
    return {
      ref: repoRefOf(org, r),
      fullName: `${org}/${r.project.name}/${r.name}`,
      description: r.project.description || undefined,
      isPrivate: (r.project.visibility ?? 'private') !== 'public',
      isFork: !!r.isFork,
      parent: parent
        ? {
            integration,
            owner: `${parent.collection?.name ?? org}/${parent.project?.name ?? r.project.name}`,
            name: parent.name,
            id: parent.id,
          }
        : undefined,
      defaultBranch: stripHeads(r.defaultBranch) || 'main',
      httpsUrl: (r.remoteUrl ?? `${orgBase(org)}/${enc(r.project.name)}/_git/${enc(r.name)}`).replace(
        /^https:\/\/[^@/]+@/,
        'https://',
      ),
      sshUrl: r.sshUrl ?? `git@ssh.dev.azure.com:v3/${org}/${r.project.name}/${r.name}`,
      webUrl: r.webUrl ?? `${orgBase(org)}/${enc(r.project.name)}/_git/${enc(r.name)}`,
      updatedAt: toIso(r.project.lastUpdateTime) ?? '',
    };
  }

  function reviewDecisionOf(reviewers: AzReviewer[]): PullRequest['reviewDecision'] {
    const real = reviewers.filter((r) => !r.isContainer || r.vote !== 0);
    if (real.some((r) => r.vote <= -5)) return 'changes_requested';
    const required = reviewers.filter((r) => r.isRequired);
    if (required.some((r) => r.vote < 5)) return 'review_required';
    if (real.some((r) => r.vote >= 5)) return 'approved';
    return reviewers.length ? 'review_required' : null;
  }

  function toPr(
    ref: RepoRef,
    p: AzPullRequest,
    me?: string,
    extra?: { checks?: CheckRun[]; commentsCount?: number },
  ): PullRequest {
    const { org } = split(ref.owner);
    const reviewersRaw = p.reviewers ?? [];
    const reviewers = reviewersRaw.map((r) => ({
      user: userOf(r),
      state: azVoteToState(r.vote, r.hasDeclined),
      required: r.isRequired ? true : undefined,
    }));
    const headRepo = p.forkSource?.repository ?? p.repository;
    const active = p.status === 'active';
    const isAuthor = !!me && p.createdBy.id === me;
    const pr: PullRequest = {
      repo: ref,
      number: p.pullRequestId,
      id: String(p.pullRequestId),
      title: p.title,
      body: p.description ?? '',
      state: active ? (p.isDraft ? 'draft' : 'open') : p.status === 'completed' ? 'merged' : 'closed',
      author: userOf(p.createdBy),
      createdAt: toIso(p.creationDate) ?? '',
      updatedAt: toIso(p.closedDate ?? p.creationDate) ?? '',
      mergedAt: p.status === 'completed' ? toIso(p.closedDate) : undefined,
      closedAt: active ? undefined : toIso(p.closedDate),
      head: {
        repo: headRepo ? repoRefOf(orgOfUrl(headRepo.remoteUrl, org), headRepo) : null,
        repoCloneUrl: headRepo?.remoteUrl,
        branch: stripHeads(p.sourceRefName),
        sha: p.lastMergeSourceCommit?.commitId ?? '',
      },
      base: { repo: ref, branch: stripHeads(p.targetRefName), sha: p.lastMergeTargetCommit?.commitId },
      reviewers,
      assignees: [],
      labels: (p.labels ?? []).filter((l) => l.active !== false).map((l) => ({ name: l.name })),
      reviewDecision: reviewDecisionOf(reviewersRaw),
      mergeable:
        p.mergeStatus === 'conflicts' || p.mergeStatus === 'failure'
          ? 'conflicting'
          : p.mergeStatus === 'succeeded'
            ? 'mergeable'
            : 'unknown',
      checksRollup: extra?.checks ? checksRollupOf(extra.checks) : 'none',
      rollup: 'none',
      commentsCount: extra?.commentsCount ?? 0,
      webUrl: `${orgBase(org)}/${enc(p.repository.project.name)}/_git/${enc(p.repository.name)}/pullrequest/${p.pullRequestId}`,
      isCrossRepository: !!p.forkSource,
      viewer: {
        canMerge: active && !p.isDraft,
        canEdit: active,
        canApprove: active,
        isAuthor,
        reviewRequested: !!me && reviewersRaw.some((r) => r.id === me && r.vote === 0),
      },
      allowedMergeMethods: [...AZURE_DEVOPS_CAPABILITIES.mergeMethods],
    };
    pr.rollup = prRollupOf(pr);
    return pr;
  }

  const statusCheck = (s: AzStatus): CheckRun => ({
    id: `status:${s.id}`,
    name: s.description || s.context.name,
    group: s.context.genre ? `${s.context.genre}/${s.context.name}` : s.context.name,
    status: azStatusToCheck(s.state),
    startedAt: toIso(s.creationDate),
    completedAt: s.state === 'pending' ? undefined : toIso(s.updatedDate),
    detailsUrl: s.targetUrl,
    canRerun: false,
    provider: s.context.genre?.includes('pipeline') ? 'azure-pipelines' : 'status-api',
  });
  const policyCheck = (e: AzPolicyEvaluation): CheckRun => {
    const type = e.configuration.type?.displayName ?? 'Policy';
    return {
      id: `policy:${e.evaluationId}`,
      name: e.configuration.settings?.displayName || type,
      group: e.configuration.isBlocking === false ? `${type} (optional)` : type,
      status: azPolicyToCheck(e.status),
      startedAt: toIso(e.startedDate),
      completedAt: toIso(e.completedDate),
      canRerun: false,
      provider: e.context?.buildId ? 'azure-pipelines' : 'other',
    };
  };

  async function getPrRaw(ref: RepoRef, n: number) {
    return get<AzPullRequest>(prApi(ref, n));
  }
  async function getThreads(ref: RepoRef, n: number): Promise<AzThread[]> {
    return (await get<{ value: AzThread[] }>(`${prApi(ref, n)}/threads`)).value;
  }
  async function getPrChecks(ref: RepoRef, n: number, raw?: AzPullRequest): Promise<CheckRun[]> {
    const pr = raw ?? (await getPrRaw(ref, n));
    const { org } = split(ref.owner);
    const [statuses, policies] = await Promise.all([
      get<{ value: AzStatus[] }>(`${prApi(ref, n)}/statuses`).then(
        (r) => r.value,
        () => [] as AzStatus[],
      ),
      get<{ value: AzPolicyEvaluation[] }>(
        `${orgBase(org)}/${enc(pr.repository.project.name)}/_apis/policy/evaluations`,
        {
          artifactId: `vstfs:///CodeReview/CodeReviewId/${pr.repository.project.id}/${n}`,
        },
      ).then(
        (r) => r.value,
        () => [] as AzPolicyEvaluation[],
      ),
    ]);
    // Latest status per context.
    const latest = new Map<string, AzStatus>();
    for (const s of statuses) {
      const k = `${s.context.genre ?? ''}/${s.context.name}`;
      const prev = latest.get(k);
      if (!prev || prev.id < s.id) latest.set(k, s);
    }
    return [
      ...[...latest.values()].map(statusCheck),
      ...policies.filter((e) => e.configuration.isEnabled !== false).map(policyCheck),
    ];
  }

  const isSystem = (t: AzThread): boolean =>
    t.comments.length > 0 && t.comments.every((c) => c.commentType === 'system');
  const userComments = (t: AzThread): AzComment[] =>
    t.comments.filter((c) => !c.isDeleted && c.commentType !== 'system');

  function threadToItems(n: number, t: AzThread, me?: string): TimelineItem[] {
    if (t.isDeleted) return [];
    const at = toIso(t.publishedDate) ?? '';
    if (isSystem(t)) {
      const type = String(t.properties?.CodeReviewThreadType?.$value ?? '');
      const first = t.comments[0]!;
      if (type === 'VoteUpdate') {
        const vote = Number(t.properties?.CodeReviewVoteResult?.$value ?? 0);
        return [
          {
            kind: 'review',
            id: `${n}:${t.id}`,
            author: userOf(first.author),
            state: azVoteToState(vote),
            body: '',
            createdAt: at,
          },
        ];
      }
      if (type === 'RefUpdate') {
        return [{ kind: 'commits', shas: [], actor: userOf(first.author), createdAt: at }];
      }
      return [
        {
          kind: 'event',
          event: type || 'system',
          actor: userOf(first.author),
          createdAt: at,
          detail: first.content,
        },
      ];
    }
    const comments = userComments(t);
    if (!comments.length) return [];
    if (t.threadContext?.filePath) {
      const ctx = t.threadContext;
      const right = ctx.rightFileStart?.line;
      return [
        {
          kind: 'thread',
          id: `${n}:${t.id}`,
          path: ctx.filePath.replace(/^\//, ''),
          line: right ?? ctx.leftFileStart?.line,
          side: right != null ? 'RIGHT' : 'LEFT',
          resolved: RESOLVED_THREAD.has(t.status ?? ''),
          outdated: false,
          comments: comments.map((c) => ({
            id: `${n}:${t.id}:${c.id}`,
            author: userOf(c.author),
            body: c.content ?? '',
            createdAt: toIso(c.publishedDate) ?? '',
          })),
        },
      ];
    }
    return comments.map((c) => ({
      kind: 'comment' as const,
      id: `${n}:${t.id}:${c.id}`,
      author: userOf(c.author),
      body: c.content ?? '',
      createdAt: toIso(c.publishedDate) ?? '',
      editable: !!me && c.author.id === me,
    }));
  }

  async function resolveRepoId(r: RepoRef): Promise<string> {
    if (r.id) return r.id;
    return (await get<AzRepo>(`${projBase(r)}/git/repositories/${enc(r.name)}`)).id;
  }

  const provider: AzureDevOpsProvider = {
    kind: 'azure-devops',
    capabilities: AZURE_DEVOPS_CAPABILITIES,
    getPrChecks: (ref, n) => getPrChecks(ref, n),
    listOrganizations,

    async getViewer() {
      if (defaultOrg) {
        const u = (await connection(defaultOrg)).authenticatedUser;
        return {
          id: u.id,
          login: u.properties?.Account?.$value ?? u.providerDisplayName ?? u.id,
          name: u.providerDisplayName ?? u.displayName,
        };
      }
      const p = await getProfile();
      return {
        id: p.id,
        login: p.emailAddress ?? p.publicAlias ?? p.id,
        name: p.displayName,
        email: p.emailAddress,
      };
    },
    async getGrantedScopes() {
      return []; // PATs/Entra tokens: no introspection endpoint; probe per call.
    },

    async listRepos({ owner, query }) {
      const orgs = owner ? [split(owner).org] : await listOrganizations();
      const items: RemoteRepo[] = [];
      for (const org of orgs) {
        const url = owner
          ? `${projBase({ owner })}/git/repositories`
          : `${orgBase(org)}/_apis/git/repositories`;
        const r = await get<{ value: AzRepo[] }>(url);
        items.push(...r.value.filter((x) => !x.isDisabled).map((x) => toRepo(org, x)));
      }
      const q = query?.toLowerCase();
      return { items: q ? items.filter((r) => r.fullName.toLowerCase().includes(q)) : items };
    },
    async listOwners() {
      const out: Array<{ login: string; kind: 'org' | 'project' }> = [];
      for (const org of await listOrganizations()) {
        let cursor: string | undefined;
        for (let i = 0; i < 20; i++) {
          const p = await tokenPage<{ name: string }>(
            `${orgBase(org)}/_apis/projects`,
            { $top: 200 },
            cursor,
          );
          out.push(...p.items.map((x) => ({ login: `${org}/${x.name}`, kind: 'project' as const })));
          if (!p.nextCursor) break;
          cursor = p.nextCursor;
        }
      }
      return out;
    },
    async getRepo(ref) {
      return toRepo(
        split(ref.owner).org,
        await get<AzRepo>(`${projBase(ref)}/git/repositories/${enc(ref.id ?? ref.name)}`),
      );
    },
    async listForks(ref) {
      const { org } = split(ref.owner);
      const [id, conn] = await Promise.all([resolveRepoId(ref), connection(org)]);
      const r = await get<{ value: AzRepo[] }>(
        `${projBase(ref)}/git/repositories/${enc(id)}/forks/${enc(conn.instanceId)}`,
      );
      return { items: r.value.map((x) => toRepo(orgOfUrl(x.remoteUrl, org), x)) };
    },
    matchRemoteUrl(url) {
      const m = parseAzureRemote(url);
      if (!m) return null;
      const p = parseRemoteUrl(url);
      const h = p?.host ?? '';
      const azureHost =
        h === 'dev.azure.com' ||
        h === 'ssh.dev.azure.com' ||
        h === 'vs-ssh.visualstudio.com' ||
        h.endsWith('.visualstudio.com');
      if (!azureHost) return null;
      if (o.organization && m.org.toLowerCase() !== o.organization.toLowerCase()) return null;
      if (legacyOrg && !o.organization && m.org.toLowerCase() !== legacyOrg) return null;
      return { owner: `${m.org}/${m.project}`, name: m.repo };
    },

    async listPullRequests(ref, filter: PrFilter, cursor) {
      const { org } = split(ref.owner);
      const me = await viewerId(org).catch(() => undefined);
      const preset = filter.preset ?? 'all';
      const top = 50;
      const skip = cursor ? Number(cursor) : 0;
      const status = { open: 'active', merged: 'completed', closed: 'abandoned', all: 'all' }[
        filter.state ?? 'open'
      ];
      const r = await get<{ value: AzPullRequest[] }>(`${repoApi(ref)}/pullrequests`, {
        'searchCriteria.status': status,
        'searchCriteria.creatorId': preset === 'mine' ? me : undefined,
        'searchCriteria.reviewerId': preset === 'review-requested' || preset === 'assigned' ? me : undefined,
        'searchCriteria.sourceRefName': filter.head ? `refs/heads/${filter.head}` : undefined,
        $top: top,
        $skip: skip || undefined,
      });
      const q = filter.query?.toLowerCase();
      const author = filter.author?.toLowerCase();
      const items = r.value
        .filter((p) => !q || p.title.toLowerCase().includes(q))
        .filter((p) => !author || (p.createdBy.uniqueName ?? '').toLowerCase().includes(author))
        .map((p) => toPr(ref, p, me));
      return { items, nextCursor: r.value.length === top ? String(skip + top) : undefined };
    },

    async searchMyPullRequests(opts = {}) {
      const want = opts.repos?.length
        ? new Set(opts.repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()))
        : null;
      const orgs = await listOrganizations();
      const perOrg = await Promise.all(
        orgs.map(async (org) => {
          const me = await viewerId(org);
          const roles: Array<[string, 'author' | 'reviewer']> = [
            ['searchCriteria.creatorId', 'author'],
            ['searchCriteria.reviewerId', 'reviewer'],
          ];
          const lists = await Promise.all(
            roles.map(async ([param, inv]) => {
              const r = await get<{ value: AzPullRequest[] }>(`${orgBase(org)}/_apis/git/pullrequests`, {
                [param]: me,
                'searchCriteria.status': 'active',
                $top: Math.min(opts.limit ?? 50, 100),
              });
              return r.value.map((p): MyPullRequest => ({
                pr: toPr(repoRefOf(org, p.repository), p, me),
                involvement: [inv],
              }));
            }),
          );
          return lists.flat();
        }),
      );
      return mergeInvolved(
        perOrg.flat().filter((r) => !want || want.has(`${r.pr.repo.owner}/${r.pr.repo.name}`.toLowerCase())),
        (r) => `${r.pr.repo.owner}/${r.pr.repo.name}#${r.pr.number}`,
      );
    },

    async getPullRequest(ref, n) {
      const { org } = split(ref.owner);
      const raw = await getPrRaw(ref, n);
      const [me, checks, threads] = await Promise.all([
        viewerId(org).catch(() => undefined),
        getPrChecks(ref, n, raw),
        getThreads(ref, n).catch(() => [] as AzThread[]),
      ]);
      const commentsCount = threads
        .filter((t) => !t.isDeleted && !isSystem(t))
        .reduce((a, t) => a + userComments(t).length, 0);
      return toPr(ref, raw, me, { checks, commentsCount });
    },

    async getTimeline(ref, n) {
      const me = await viewerId(split(ref.owner).org).catch(() => undefined);
      const threads = await getThreads(ref, n);
      const items = threads
        .slice()
        .sort((a, b) => a.publishedDate.localeCompare(b.publishedDate))
        .flatMap((t) => threadToItems(n, t, me));
      return { items };
    },

    async getChecks(ref, sha) {
      const r = await get<{ value: AzStatus[] }>(`${repoApi(ref)}/commits/${enc(sha)}/statuses`, {
        latestOnly: true,
      });
      return r.value.map(statusCheck);
    },
    async listPrTemplates(ref, branch) {
      const paths = [
        '.azuredevops/pull_request_template.md',
        '.vsts/pull_request_template.md',
        'docs/pull_request_template.md',
        'pull_request_template.md',
      ];
      const out: Array<{ name: string; path: string; body: string }> = [];
      for (const path of paths) {
        try {
          const { data } = await call<string | { content?: string }>('GET', `${repoApi(ref)}/items`, {
            query: {
              path: `/${path}`,
              includeContent: true,
              'versionDescriptor.version': branch,
              'versionDescriptor.versionType': 'branch',
              $format: 'json',
            },
          });
          const body = typeof data === 'string' ? data : (data?.content ?? '');
          out.push({ name: path.split('/').pop()!, path, body });
          break;
        } catch (e) {
          if (!(e instanceof ProviderError) || e.code !== 'not_found') throw e;
        }
      }
      return out;
    },
    async searchUsers(ref, query) {
      const { org } = split(ref.owner);
      const vssps = host.endsWith('.visualstudio.com')
        ? `https://${enc(org)}.vssps.visualstudio.com`
        : `https://vssps.dev.azure.com/${enc(org)}`;
      const r = await get<{
        value: Array<{
          id: string;
          providerDisplayName?: string;
          isContainer?: boolean;
          properties?: Record<string, { $value?: string }>;
        }>;
      }>(`${vssps}/_apis/identities`, {
        searchFilter: 'General',
        filterValue: query,
        queryMembership: 'None',
      });
      return r.value.map((i) => ({
        id: i.id,
        login: i.properties?.Account?.$value ?? i.properties?.Mail?.$value ?? i.providerDisplayName ?? i.id,
        name: i.providerDisplayName,
        email: i.properties?.Mail?.$value,
        isTeam: i.isContainer ? true : undefined,
      }));
    },
    async listLabels() {
      return []; // PR tags are free-form in Azure DevOps.
    },

    async createPullRequest(input: CreatePrInput) {
      const { org } = split(input.base.owner);
      const cross =
        input.head.owner.toLowerCase() !== input.base.owner.toLowerCase() ||
        input.head.name.toLowerCase() !== input.base.name.toLowerCase();
      const forkId = cross ? await resolveRepoId(input.head) : undefined;
      const p = await call<AzPullRequest>('POST', `${repoApi(input.base)}/pullrequests`, {
        body: {
          sourceRefName: `refs/heads/${input.headBranch}`,
          targetRefName: `refs/heads/${input.baseBranch}`,
          title: input.title,
          description: input.body,
          isDraft: !!input.draft,
          reviewers: [...(input.reviewers ?? []), ...(input.teamReviewers ?? [])].map((id) => ({ id })),
          labels: (input.labels ?? []).map((name) => ({ name })),
          ...(forkId ? { forkSource: { repository: { id: forkId } } } : {}),
          ...(input.deleteSourceBranch || input.squash
            ? {
                completionOptions: {
                  deleteSourceBranch: !!input.deleteSourceBranch,
                  ...(input.squash ? { mergeStrategy: 'squash' } : {}),
                },
              }
            : {}),
        },
      });
      return toPr(input.base, p.data, await viewerId(org).catch(() => undefined));
    },

    async updatePullRequest(ref, n, patch: UpdatePrInput) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.body !== undefined) body.description = patch.body;
      if (patch.baseBranch !== undefined) body.targetRefName = `refs/heads/${patch.baseBranch}`;
      if (patch.state === 'closed') body.status = 'abandoned';
      if (patch.state === 'open') body.status = 'active';
      for (const id of [...(patch.reviewers ?? []), ...(patch.teamReviewers ?? [])]) {
        await call('PUT', `${prApi(ref, n)}/reviewers/${enc(id)}`, { body: { vote: 0 } });
      }
      for (const name of patch.labels ?? []) {
        await call('POST', `${prApi(ref, n)}/labels`, { body: { name } });
      }
      const p = Object.keys(body).length
        ? (await call<AzPullRequest>('PATCH', prApi(ref, n), { body })).data
        : await getPrRaw(ref, n);
      return toPr(ref, p, await viewerId(split(ref.owner).org).catch(() => undefined));
    },

    async addComment(ref, n, body, inReplyTo) {
      const me = await viewerId(split(ref.owner).org).catch(() => undefined);
      if (inReplyTo) {
        const [, threadId, commentId] = inReplyTo.split(':');
        const tid = threadId ?? inReplyTo;
        const c = await call<AzComment>('POST', `${prApi(ref, n)}/threads/${enc(tid)}/comments`, {
          body: { content: body, parentCommentId: Number(commentId ?? 1), commentType: 1 },
        });
        return {
          kind: 'comment',
          id: `${n}:${tid}:${c.data.id}`,
          author: userOf(c.data.author),
          body: c.data.content ?? body,
          createdAt: toIso(c.data.publishedDate) ?? '',
          editable: true,
        };
      }
      const t = await call<AzThread>('POST', `${prApi(ref, n)}/threads`, {
        body: { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 'active' },
      });
      const item = threadToItems(n, t.data, me)[0];
      if (!item)
        throw new ProviderError({ code: 'server', message: 'Azure DevOps returned an empty thread.' });
      return item;
    },

    async submitReview(ref, n, input: SubmitReviewInput) {
      for (const c of input.comments ?? []) {
        const start = { line: c.startLine ?? c.line, offset: 1 };
        const end = { line: c.line, offset: 1 };
        await call('POST', `${prApi(ref, n)}/threads`, {
          body: {
            comments: [{ parentCommentId: 0, content: c.body, commentType: 1 }],
            status: 'active',
            threadContext: {
              filePath: `/${c.path.replace(/^\//, '')}`,
              ...(c.side === 'LEFT'
                ? { leftFileStart: start, leftFileEnd: end }
                : { rightFileStart: start, rightFileEnd: end }),
            },
          },
        });
      }
      if (input.body) {
        await call('POST', `${prApi(ref, n)}/threads`, {
          body: { comments: [{ parentCommentId: 0, content: input.body, commentType: 1 }], status: 'active' },
        });
      }
      if (input.event === 'COMMENT') return;
      const me = await viewerId(split(ref.owner).org);
      await call('PUT', `${prApi(ref, n)}/reviewers/${enc(me)}`, {
        body: { id: me, vote: input.event === 'APPROVE' ? 10 : -5 },
      });
    },

    async setThreadResolved(ref, threadId, resolved) {
      const [n, tid] = threadId.split(':');
      if (!n || !tid) throw new ProviderError({ code: 'validation', message: `Bad thread id ${threadId}` });
      await call('PATCH', `${prApi(ref, Number(n))}/threads/${enc(tid)}`, {
        body: { status: resolved ? 'fixed' : 'active' },
      });
    },

    async merge(ref, n, input) {
      const mergeStrategy = AZ_MERGE_STRATEGY[input.method];
      if (!mergeStrategy)
        throw unsupported(`Azure DevOps does not support the "${input.method}" merge method.`);
      const message = [input.title, input.message].filter(Boolean).join('\n\n') || undefined;
      const r = await call<AzPullRequest>('PATCH', prApi(ref, n), {
        body: {
          status: 'completed',
          lastMergeSourceCommit: { commitId: input.expectedHeadSha },
          completionOptions: {
            mergeStrategy,
            deleteSourceBranch: !!input.deleteBranch,
            mergeCommitMessage: message,
          },
        },
      });
      const p = r.data;
      if (p.status === 'completed') return { merged: true, sha: p.lastMergeCommit?.commitId };
      return {
        merged: false,
        message:
          p.mergeFailureMessage ??
          (p.mergeStatus === 'rejectedByPolicy'
            ? 'Completion is blocked by branch policies.'
            : p.mergeStatus === 'queued'
              ? 'Merge queued.'
              : `Merge status: ${p.mergeStatus ?? 'unknown'}`),
      };
    },

    async setAutoMerge(ref, n, method) {
      const me = await viewerId(split(ref.owner).org);
      await call('PATCH', prApi(ref, n), {
        body:
          method === null
            ? { autoCompleteSetBy: { id: ZERO_GUID } }
            : {
                autoCompleteSetBy: { id: me },
                completionOptions: { mergeStrategy: AZ_MERGE_STRATEGY[method] ?? 'noFastForward' },
              },
      });
    },
    async close(ref, n) {
      await call('PATCH', prApi(ref, n), { body: { status: 'abandoned' } });
    },
    async reopen(ref, n) {
      await call('PATCH', prApi(ref, n), { body: { status: 'active' } });
    },
    async setDraft(ref, n, draft) {
      await call('PATCH', prApi(ref, n), { body: { isDraft: draft } });
    },

    async listCiRuns(ref, opts) {
      const id = await resolveRepoId(ref);
      const p = await tokenPage<AzBuild>(
        `${projBase(ref)}/build/builds`,
        {
          repositoryId: id,
          repositoryType: 'TfsGit',
          branchName: opts.branch ? `refs/heads/${opts.branch}` : undefined,
          $top: 30,
          queryOrder: 'queueTimeDescending',
        },
        opts.cursor,
      );
      return {
        items: p.items.map((b) => {
          const status: CheckStatus =
            b.status === 'completed'
              ? b.result === 'succeeded'
                ? 'success'
                : b.result === 'partiallySucceeded'
                  ? 'neutral'
                  : b.result === 'canceled'
                    ? 'cancelled'
                    : 'failure'
              : b.status === 'inProgress' || b.status === 'cancelling'
                ? 'in_progress'
                : 'queued';
          return {
            id: String(b.id),
            name: b.definition?.name ?? `Build ${b.buildNumber}`,
            group: b.definition?.name,
            status,
            startedAt: toIso(b.startTime ?? b.queueTime),
            completedAt: toIso(b.finishTime),
            detailsUrl: b._links?.web?.href,
            canRerun: b.status === 'completed',
            provider: 'azure-pipelines' as const,
            runNumber: Number(b.buildNumber.replace(/\D+/g, '')) || b.id,
            branch: stripHeads(b.sourceBranch),
            event: b.reason,
            actor: b.requestedFor ? userOf(b.requestedFor) : undefined,
          };
        }),
        nextCursor: p.nextCursor,
      };
    },
    async rerunCi(ref, runId) {
      await call('PATCH', `${projBase(ref)}/build/builds/${enc(runId)}`, {
        query: { retry: true },
        body: {},
      });
    },
    async cancelCi(ref, runId) {
      await call('PATCH', `${projBase(ref)}/build/builds/${enc(runId)}`, { body: { status: 'cancelling' } });
    },
  };
  return provider;
}
