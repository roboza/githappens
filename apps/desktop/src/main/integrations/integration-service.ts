import fs from 'node:fs';
import path from 'node:path';

import { GitError, makeError, type RepoId } from '@githappens/git';
import {
  integrationKey,
  parseRemoteUrl,
  ProviderError,
  type AuthInfo,
  type ConnectedIntegration,
  type HostingProvider,
  type Issue,
  type IssueRef,
  type IssueTracker,
  type PrFilter,
  type PrIndexEntry,
  type ProviderKind,
  type ProviderUser,
  type PullRequest,
  type RepoRef,
} from '@githappens/providers';

import type {
  IntegrationKind,
  IntegrationOrg,
  PrCommit,
  ResolvedRemote,
  SavedPrFilter,
  WebTarget,
} from '../../shared/ipc/integrations-contract';
import type { RepoManager } from '../services/repo-manager';
import type { AccountStore, StoredCredential } from './account-store';
import { inferIssueLink, IssueLinkStore, type InferenceContext } from './issue-links';
import { PrFilterStore } from './pr-filters';

/**
 * Everything provider-specific the service needs, behind one adapter so the clients in
 * @githappens/providers stay pure (spec 10 §5.3/§5.4).
 */
export interface ProviderFactory {
  /** `account.key` lets refreshed OAuth tokens be written back for the right account. */
  provider(
    account: ConnectedIntegration,
    cred: StoredCredential,
    opts?: { background?: boolean },
  ): HostingProvider;
  tracker(
    account: ConnectedIntegration,
    cred: StoredCredential,
    opts?: { background?: boolean },
  ): IssueTracker | null;
  /** Azure DevOps organizations / Jira Cloud sites (OAuth) the account can reach. */
  organizations?(
    account: ConnectedIntegration,
    cred: StoredCredential,
  ): Promise<Array<{ id: string; name: string; url?: string }>>;
  /** Validate a token and return the account it belongs to. */
  validate(
    kind: IntegrationKind,
    host: string,
    cred: StoredCredential,
  ): Promise<{ user: ProviderUser; scopes: string[] }>;
  patPageUrl(kind: IntegrationKind, host: string): string;
  /** Username git should send with the token over HTTPS (e.g. 'x-access-token', 'oauth2'). */
  gitUsername(kind: IntegrationKind, cred: StoredCredential): string;
  /** Default host for a kind (github.com, gitlab.com, bitbucket.org, dev.azure.com). */
  defaultHost(kind: IntegrationKind): string | null;
  /** OAuth/PAT descriptor for a kind + host; null when the kind has none. */
  authInfo(kind: IntegrationKind, host: string): AuthInfo | null;
}

const PUBLIC_HOSTS: Record<string, ProviderKind> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'dev.azure.com': 'azure-devops',
  'ssh.dev.azure.com': 'azure-devops',
};
const HOSTING_KINDS = new Set<string>(['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'azure-devops']);

/** Convert provider failures to IPC errors; the UI reads `details.providerCode` (spec 10 §5.5). */
export function toIpcProviderError(e: unknown): unknown {
  if (!(e instanceof ProviderError)) return e;
  const s = e.serialized;
  const details: Record<string, string | number | string[]> = { providerCode: s.code };
  if (s.retryAt) details.retryAt = s.retryAt;
  if (s.missingScopes?.length) details.missingScopes = s.missingScopes;
  if (s.helpUrl) details.helpUrl = s.helpUrl;
  if (s.providerMessage) details.providerMessage = s.providerMessage;
  return new GitError(makeError('Unknown', { argv: [] }, s.message, details));
}

const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  '.azuredevops/pull_request_template.md',
  '.bitbucket/pull_request_template.md',
];
const PR_TEMPLATE_DIRS = ['.github/PULL_REQUEST_TEMPLATE', '.gitlab/merge_request_templates'];

/** Merged / closed PRs stay in the PR index this long (graph "merged" pill, closed badge). */
export const RECENT_PR_MS = 7 * 24 * 3600_000;

/** Keep open PRs plus PRs merged/closed within `RECENT_PR_MS` (spec 10 §4.6); pure for tests. */
export function prIndexEntries(remote: string, prs: PullRequest[], now: number): PrIndexEntry[] {
  const out: PrIndexEntry[] = [];
  for (const pr of prs) {
    if (pr.isCrossRepository) continue; // fork branches don't exist in this repo's remotes
    if (pr.state === 'merged' || pr.state === 'closed') {
      const at = Date.parse(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt);
      if (!Number.isFinite(at) || now - at > RECENT_PR_MS) continue;
    }
    out.push({
      remote,
      branch: pr.head.branch,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        rollup: pr.rollup,
        stack: pr.stack,
        webUrl: pr.webUrl,
        mergedAt: pr.mergedAt,
        closedAt: pr.closedAt,
        updatedAt: pr.updatedAt,
      },
    });
  }
  return out;
}

/** Revisions coming from the renderer go before `--`; refuse option-looking or odd values. */
function assertRev(rev: string, what: string): string {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-') || /[\s\p{Cc}~^:?*[\\]|\.\.|@\{/u.test(rev)) {
    throw new GitError(makeError('Unknown', { argv: [] }, `Invalid ${what}: ${String(rev)}`));
  }
  return rev;
}

/** "Assign to me" identifier per tracker: Jira Cloud wants the accountId, others the login. */
export function selfAssignee(account: Pick<ConnectedIntegration, 'kind' | 'accountId' | 'login'>): string {
  return account.kind === 'jira-cloud' ? account.accountId : account.login;
}

export class IntegrationService {
  private readonly prIndexCache = new Map<RepoId, { at: number; entries: PrIndexEntry[] }>();
  private readonly links: IssueLinkStore;
  private readonly filters: PrFilterStore;

  constructor(
    private readonly accounts: AccountStore,
    private readonly factory: ProviderFactory,
    private readonly repos: RepoManager,
    private readonly emit: {
      changed(list: ConnectedIntegration[]): void;
      prIndex(repoId: RepoId, entries: PrIndexEntry[]): void;
    },
  ) {
    this.links = new IssueLinkStore(() => accounts.dir());
    this.filters = new PrFilterStore(() => accounts.dir());
  }

  // ---- accounts ----

  list(): ConnectedIntegration[] {
    return this.accounts.list();
  }

  async connect(
    kind: IntegrationKind,
    host: string,
    cred: StoredCredential,
    authType: 'oauth' | 'pat',
  ): Promise<ConnectedIntegration> {
    const h = (host || this.factory.defaultHost(kind) || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    if (!h) throw new GitError(makeError('Unknown', { argv: [] }, 'Enter the server host name.'));
    const { user, scopes } = await this.factory.validate(kind, h, cred).catch((e: unknown) => {
      throw toIpcProviderError(e);
    });
    const id = { kind, host: h, accountId: user.id };
    const meta: ConnectedIntegration = {
      ...id,
      key: integrationKey(id),
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      authType,
      scopes,
      connectedAt: Date.now(),
    };
    this.accounts.save(meta, cred);
    this.emit.changed(this.accounts.list());
    return meta;
  }

  disconnect(key: string): void {
    this.accounts.remove(key);
    this.prIndexCache.clear();
    this.emit.changed(this.accounts.list());
  }

  tokenPageUrl(kind: IntegrationKind, host: string): string {
    return this.factory.patPageUrl(kind, host || this.factory.defaultHost(kind) || '');
  }

  /** Token-based HTTPS login for git, used by the credential service before prompting (spec 09 §6.6). */
  gitLogin(host: string): { username: string; password: string } | null {
    const h = host.toLowerCase();
    for (const i of this.accounts.list()) {
      if (!HOSTING_KINDS.has(i.kind) || i.host.split('/')[0] !== h) continue;
      const cred = this.accounts.credential(i.key);
      if (cred) return { username: this.factory.gitUsername(i.kind, cred), password: cred.accessToken };
    }
    return null;
  }

  provider(key: string, opts?: { background?: boolean }): HostingProvider {
    const meta = this.accounts.get(key);
    const cred = meta && this.accounts.credential(key);
    if (!meta || !cred || !HOSTING_KINDS.has(meta.kind)) {
      throw new GitError(
        makeError('Unknown', { argv: [] }, 'This account is not connected.', {
          providerCode: 'auth_required',
        }),
      );
    }
    return this.factory.provider(meta, cred, opts);
  }

  tracker(key: string, opts?: { background?: boolean }): IssueTracker {
    const meta = this.accounts.get(key);
    const cred = meta && this.accounts.credential(key);
    const t = meta && cred ? this.factory.tracker(meta, cred, opts) : null;
    if (!t) {
      throw new GitError(
        makeError('Unknown', { argv: [] }, 'This issue tracker is not connected.', {
          providerCode: 'auth_required',
        }),
      );
    }
    return t;
  }

  /** Run a provider call with error conversion. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toIpcProviderError(e);
    }
  }

  /** Credential of an account (main-process only; used for revocation). */
  credential(key: string): StoredCredential | null {
    return this.accounts.credential(key);
  }

  // ---- organizations (Azure DevOps orgs / Jira Cloud sites) ----

  async organizations(key: string): Promise<IntegrationOrg[]> {
    const meta = this.accounts.get(key);
    const cred = this.accounts.credential(key);
    if (!meta || !cred) {
      throw new GitError(
        makeError('Unknown', { argv: [] }, 'This account is not connected.', {
          providerCode: 'auth_required',
        }),
      );
    }
    const list =
      (await this.call(() => this.factory.organizations?.(meta, cred) ?? Promise.resolve([]))) ?? [];
    const currentOrg = meta.host.split('/')[1];
    return list.map((o) => ({
      ...o,
      selected:
        meta.kind === 'jira-cloud'
          ? cred.cloudId === o.id
          : !!currentOrg && currentOrg.toLowerCase() === o.id.toLowerCase(),
    }));
  }

  /** Re-scope an account to one org/site; the integration key changes with the host. */
  async selectOrganization(key: string, id: string): Promise<ConnectedIntegration> {
    const meta = this.accounts.get(key);
    const cred = this.accounts.credential(key);
    if (!meta || !cred)
      throw new GitError(makeError('Unknown', { argv: [] }, 'This account is not connected.'));
    const orgs = await this.organizations(key);
    const org = orgs.find((o) => o.id === id);
    if (!org) throw new GitError(makeError('Unknown', { argv: [] }, `Unknown organization: ${id}`));
    let host: string;
    let next: StoredCredential = cred;
    if (meta.kind === 'jira-cloud') {
      host = org.url ? org.url.replace(/^https?:\/\//, '').replace(/\/+$/, '') : meta.host;
      next = { ...cred, cloudId: org.id };
    } else {
      host = `${meta.host.split('/')[0]}/${org.id}`;
    }
    const id2 = { kind: meta.kind, host, accountId: meta.accountId };
    const updated: ConnectedIntegration = { ...meta, ...id2, key: integrationKey(id2) };
    if (updated.key !== key) this.accounts.remove(key);
    this.accounts.save(updated, next);
    this.prIndexCache.clear();
    this.emit.changed(this.accounts.list());
    return updated;
  }

  // ---- remotes ----

  async resolveRemotes(repoId: RepoId): Promise<ResolvedRemote[]> {
    const remotes = await this.repos.get(repoId).remotes();
    const accounts = this.accounts.list().filter((i) => HOSTING_KINDS.has(i.kind));
    return remotes.map((r) => {
      const parsed = parseRemoteUrl(r.fetchUrl);
      const host = parsed?.host ?? '';
      const account =
        accounts.find((a) => a.host.split('/')[0] === host) ??
        // Azure SSH remotes use ssh.dev.azure.com while the account host is dev.azure.com.
        (host === 'ssh.dev.azure.com' ? accounts.find((a) => a.host.startsWith('dev.azure.com')) : undefined);
      const kind =
        (account?.kind as ProviderKind | undefined) ??
        PUBLIC_HOSTS[host] ??
        (host.endsWith('.visualstudio.com') ? 'azure-devops' : null);
      const out: ResolvedRemote = { remote: r.name, url: r.fetchUrl, kind, host };
      if (account) {
        try {
          const m = this.provider(account.key).matchRemoteUrl(r.fetchUrl);
          if (m) {
            out.integrationKey = account.key;
            out.owner = m.owner;
            out.name = m.name;
            out.ref = {
              ...m,
              integration: { kind: account.kind, host: account.host, accountId: account.accountId },
            };
          }
        } catch {
          /* credential missing; leave unresolved */
        }
      }
      return out;
    });
  }

  /** Web link for any target (spec 10 §11 provider web-link builder); pure, no network. */
  async webUrl(repoId: RepoId, target: WebTarget, remote?: string): Promise<string | null> {
    const remotes = await this.resolveRemotes(repoId);
    const r =
      (remote ? remotes.find((x) => x.remote === remote && x.kind) : undefined) ??
      remotes.find((x) => x.remote === 'origin' && x.kind) ??
      remotes.find((x) => x.kind);
    if (!r?.kind) return null;
    return buildWebUrl(r.kind, r.url, r.host, target);
  }

  // ---- pull requests ----

  private async providerRefs(repoId: RepoId): Promise<Array<{ remote: string; ref: RepoRef; key: string }>> {
    const seen = new Set<string>();
    const out: Array<{ remote: string; ref: RepoRef; key: string }> = [];
    for (const r of await this.resolveRemotes(repoId)) {
      if (!r.ref || !r.integrationKey) continue;
      const id = `${r.integrationKey}/${r.ref.owner}/${r.ref.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ remote: r.remote, ref: r.ref, key: r.integrationKey });
    }
    return out;
  }

  async listPullRequests(repoId: RepoId, filter: PrFilter, background = false): Promise<PullRequest[]> {
    const refs = await this.providerRefs(repoId);
    const pages = await Promise.all(
      refs.map((r) =>
        this.call(() => this.provider(r.key, { background }).listPullRequests(r.ref, filter)).then(
          (p) => p.items,
        ),
      ),
    );
    return pages.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Branch → PR map for graph badges; cached for a minute per repo (spec 10 §5.4 PrIndex). Open PRs plus
   * PRs merged or closed in the last 7 days (merged pill / closed badge, §4.6).
   */
  async prIndex(repoId: RepoId, force = false, background = false): Promise<PrIndexEntry[]> {
    const cached = this.prIndexCache.get(repoId);
    if (cached && !force && Date.now() - cached.at < 60_000) return cached.entries;
    const refs = await this.providerRefs(repoId);
    const entries: PrIndexEntry[] = [];
    let failed = 0;
    for (const r of refs) {
      const p = this.provider(r.key, { background });
      const [open, merged, closed] = await Promise.all(
        (['open', 'merged', 'closed'] as const).map((state) =>
          this.call(() => p.listPullRequests(r.ref, { preset: 'all', state })).catch(() => null),
        ),
      );
      if (!open) failed++;
      const prs = [...(open?.items ?? []), ...(merged?.items ?? []), ...(closed?.items ?? [])];
      entries.push(...prIndexEntries(r.remote, prs, Date.now()));
    }
    // Background refresh paused / failed everywhere: keep showing the last good index.
    if (cached && refs.length && failed === refs.length) return cached.entries;
    this.prIndexCache.set(repoId, { at: Date.now(), entries });
    this.emit.prIndex(repoId, entries);
    return entries;
  }

  /** Remote hosting the PR (base repo) and, for fork PRs, a remote that already points at the head repo. */
  private async prRemotes(
    repoId: RepoId,
    pr: PullRequest,
  ): Promise<{ base: ResolvedRemote & { integrationKey: string }; head?: ResolvedRemote }> {
    const remotes = await this.resolveRemotes(repoId);
    const same = (r: ResolvedRemote, o: { owner: string; name: string }): boolean =>
      !!r.ref &&
      r.ref.owner.toLowerCase() === o.owner.toLowerCase() &&
      r.ref.name.toLowerCase() === o.name.toLowerCase();
    const base = remotes.find((r) => same(r, pr.repo));
    if (!base?.integrationKey) {
      throw new GitError(
        makeError('RemoteNotFound', { argv: [] }, `No remote points at ${pr.repo.owner}/${pr.repo.name}.`),
      );
    }
    const headRepo = pr.head.repo;
    const head = pr.isCrossRepository && headRepo ? remotes.find((r) => same(r, headRepo)) : undefined;
    return { base: base as ResolvedRemote & { integrationKey: string }, head };
  }

  /**
   * Check out a PR (spec 10 §6.3): same-repo PRs (or fork PRs whose fork is a remote) track the head
   * branch; other fork PRs use the provider PR ref. `worktree` mode adds a worktree next to the repo.
   */
  async checkoutPr(
    repoId: RepoId,
    pr: PullRequest,
    mode: 'branch' | 'worktree' = 'branch',
    worktreePath?: string,
  ): Promise<{ branch: string; path?: string }> {
    const { base, head } = await this.prRemotes(repoId, pr);
    const provider = this.provider(base.integrationKey);
    const viaFork = !!head;
    const sameRepo = !pr.isCrossRepository || viaFork;
    const remote = head ? head.remote : base.remote;
    const localBranch = sameRepo
      ? pr.head.branch
      : `pr/${pr.number}-${pr.head.branch}`.replace(/[^\w./-]+/g, '-');
    let wt: string | undefined;
    if (mode === 'worktree') {
      const root = this.repos.get(repoId).repo.worktreeRoot;
      if (!worktreePath && !root) {
        throw new GitError(makeError('Unknown', { argv: [] }, 'Choose a folder for the new worktree.'));
      }
      wt =
        worktreePath ??
        path.join(path.dirname(root!), `${path.basename(root!)}.worktrees`, `pr-${pr.number}`);
    }
    const r = await this.repos.runOp(repoId, {
      type: 'pr.checkout',
      remote,
      number: pr.number,
      headBranch: pr.head.branch,
      sameRepo,
      refspec: provider.capabilities.prRefspec,
      headCloneUrl: pr.head.repoCloneUrl,
      localBranch,
      checkout: mode === 'branch',
      mode,
      worktreePath: wt,
    });
    const data = r.data as { branch?: string; path?: string } | undefined;
    return { branch: data?.branch ?? localBranch, ...(wt ? { path: data?.path ?? wt } : {}) };
  }

  /** Fetch PR head + base for local commits/diff views; no branch is touched. */
  async fetchPr(repoId: RepoId, pr: PullRequest): Promise<{ headRef: string; baseRef: string }> {
    const { base, head } = await this.prRemotes(repoId, pr);
    const provider = this.provider(base.integrationKey);
    const sameRepo = !pr.isCrossRepository;
    const r = await this.repos.runOp(
      repoId,
      {
        type: 'pr.checkout',
        remote: base.remote,
        number: pr.number,
        headBranch: pr.head.branch,
        sameRepo,
        // A fork that's already a remote can be fetched directly when the provider has no PR ref.
        refspec: provider.capabilities.prRefspec,
        headCloneUrl: pr.head.repoCloneUrl ?? head?.url,
        localBranch: `pr/${pr.number}`,
        checkout: false,
        mode: 'fetch',
        baseBranch: pr.base.branch,
      },
      true,
    );
    const ref = (r.data as { ref?: string } | undefined)?.ref ?? `refs/githappens/pr/${pr.number}`;
    return { headRef: ref, baseRef: `refs/remotes/${base.remote}/${pr.base.branch}` };
  }

  /** `git log base..head` (newest first, ≤ 250) for the create-PR preview and the PR Commits tab. */
  async commits(repoId: RepoId, base: string, head: string): Promise<PrCommit[]> {
    const r = await this.repos
      .get(repoId)
      .runRead([
        'log',
        '--no-color',
        '--max-count=250',
        '--format=%H%x00%s%x00%an%x00%ae%x00%ct',
        `${assertRev(base, 'base')}..${assertRev(head, 'head')}`,
        '--',
      ]);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', subject = '', authorName = '', authorEmail = '', date = '0'] = line.split('\0');
        return { sha, subject, authorName, authorEmail, date: Number(date) };
      });
  }

  /** `git merge-tree --write-tree` conflict pre-check (git ≥ 2.38); exit 1 = conflicts (spec 10 §6.3). */
  async conflictCheck(
    repoId: RepoId,
    source: string,
    target: string,
  ): Promise<{ conflicts: boolean; files: string[]; unsupported?: boolean }> {
    const r = await this.repos
      .get(repoId)
      .runRead(
        [
          'merge-tree',
          '--write-tree',
          '--name-only',
          '--no-messages',
          assertRev(target, 'target'),
          assertRev(source, 'source'),
        ],
        { expectedExitCodes: [0, 1, 128, 129] },
      );
    if (r.exitCode === 0) return { conflicts: false, files: [] };
    if (r.exitCode === 1) {
      const files = r.stdout
        .split('\n')
        .slice(1)
        .map((x) => x.trim())
        .filter(Boolean);
      return { conflicts: true, files: [...new Set(files)] };
    }
    return { conflicts: false, files: [], unsupported: true };
  }

  /** Re-run failed jobs of the latest failed run per workflow on a branch. */
  async rerunFailedCi(ref: RepoRef, branch: string): Promise<{ rerun: number }> {
    const p = this.provider(integrationKey(ref.integration));
    if (!p.listCiRuns || !p.rerunCi) {
      throw new GitError(
        makeError('Unknown', { argv: [] }, 'This provider cannot re-run CI.', {
          providerCode: 'unsupported',
        }),
      );
    }
    const page = await this.call(() => p.listCiRuns!(ref, { branch }));
    const latest = new Map<string, (typeof page.items)[number]>();
    for (const run of page.items) {
      const g = run.group ?? run.name;
      if (!latest.has(g)) latest.set(g, run); // newest first
    }
    const failed = [...latest.values()].filter(
      (r) => r.canRerun && (r.status === 'failure' || r.status === 'timed_out' || r.status === 'cancelled'),
    );
    for (const run of failed) await this.call(() => p.rerunCi!(ref, run.id, { failedOnly: true }));
    return { rerun: failed.length };
  }

  // ---- PR filters ----

  prFilters(): SavedPrFilter[] {
    return this.filters.list();
  }

  savePrFilters(filters: unknown): SavedPrFilter[] {
    return this.filters.save(filters);
  }

  // ---- issues ----

  private async inferenceContext(repoId: RepoId): Promise<InferenceContext> {
    const accounts = this.accounts.list().map((a) => ({ key: a.key, kind: a.kind, host: a.host }));
    const remotes = await this.resolveRemotes(repoId).catch(() => [] as ResolvedRemote[]);
    const r =
      remotes.find((x) => x.remote === 'origin' && x.ref && (x.kind === 'github' || x.kind === 'gitlab')) ??
      remotes.find((x) => x.ref && (x.kind === 'github' || x.kind === 'gitlab'));
    if (!r?.ref || !r.integrationKey) return { accounts };
    const web = buildWebUrl(r.kind!, r.url, r.host, { kind: 'repo' });
    return {
      accounts,
      repo: {
        integrationKey: r.integrationKey,
        kind: r.kind as 'github' | 'gitlab',
        owner: r.ref.owner,
        name: r.ref.name,
        webBase: web ?? `https://${r.host}/${r.ref.owner}/${r.ref.name}`,
      },
    };
  }

  async linkForBranch(repoId: RepoId, branch: string): Promise<IssueRef | null> {
    return this.links.get(repoId, branch) ?? inferIssueLink(branch, await this.inferenceContext(repoId));
  }

  /** Stored + inferred links for every local branch. */
  async issueLinks(repoId: RepoId): Promise<Record<string, IssueRef>> {
    const stored = this.links.all(repoId);
    const ctx = await this.inferenceContext(repoId);
    const refs = await this.repos.get(repoId).refs();
    const out: Record<string, IssueRef> = {};
    for (const ref of refs) {
      if (ref.type !== 'local') continue;
      const link = stored[ref.shortName] ?? inferIssueLink(ref.shortName, ctx);
      if (link) out[ref.shortName] = link;
    }
    return out;
  }

  setIssueLink(repoId: RepoId, branch: string, issue: IssueRef | null): void {
    this.links.set(repoId, branch, issue);
  }

  async assignSelf(key: string, scope: string, issueKey: string): Promise<Issue> {
    const account = this.accounts.get(key);
    const t = this.tracker(key);
    if (!account || !t.updateIssue) {
      throw new GitError(
        makeError('Unknown', { argv: [] }, 'This tracker cannot assign issues.', {
          providerCode: 'unsupported',
        }),
      );
    }
    return this.call(() => t.updateIssue!(scope, issueKey, { assignees: [selfAssignee(account)] }));
  }

  /**
   * Create (and optionally check out) a branch for an issue (spec 10 §4.9), link it, and optionally
   * transition / self-assign the issue. Tracker failures after the branch exists become warnings.
   */
  async createBranch(
    repoId: RepoId,
    name: string,
    base: string,
    checkout: boolean,
    issue?: IssueRef,
    opts: { transitionId?: string; assignSelf?: boolean } = {},
  ): Promise<{ branch: string; warnings?: string[] }> {
    await this.repos.runOp(repoId, { type: 'branch.create', name, startPoint: base, checkout });
    const warnings: string[] = [];
    if (issue) {
      this.links.set(repoId, name, issue);
      if (opts.transitionId) {
        try {
          const t = this.tracker(issue.integrationKey);
          if (!t.transition) throw new Error('This tracker has no workflow transitions.');
          await this.call(() => t.transition!(issue.scope, issue.key, opts.transitionId!));
        } catch (e) {
          warnings.push(`Could not transition ${issue.key}: ${(e as Error).message}`);
        }
      }
      if (opts.assignSelf) {
        try {
          await this.assignSelf(issue.integrationKey, issue.scope, issue.key);
        } catch (e) {
          warnings.push(`Could not assign ${issue.key}: ${(e as Error).message}`);
        }
      }
    }
    return warnings.length ? { branch: name, warnings } : { branch: name };
  }

  /** PR body templates: repository files first, then the provider (spec 10 §6.4). */
  async templates(
    repoId: RepoId,
    ref: RepoRef,
    branch: string,
  ): Promise<Array<{ name: string; path: string; body: string }>> {
    const root = this.repos.get(repoId).repo.worktreeRoot;
    const out: Array<{ name: string; path: string; body: string }> = [];
    if (root) {
      // Case-insensitive filesystems report both spellings of the same file; keep the first.
      const seen = new Set<string>();
      for (const rel of PR_TEMPLATE_PATHS) {
        const p = path.join(root, rel);
        if (seen.has(rel.toLowerCase()) || !fs.existsSync(p)) continue;
        seen.add(rel.toLowerCase());
        out.push({ name: 'Default', path: rel, body: fs.readFileSync(p, 'utf8') });
      }
      for (const dir of PR_TEMPLATE_DIRS) {
        const d = path.join(root, dir);
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d).filter((x) => x.toLowerCase().endsWith('.md'))) {
          out.push({
            name: f.replace(/\.md$/i, ''),
            path: `${dir}/${f}`,
            body: fs.readFileSync(path.join(d, f), 'utf8'),
          });
        }
      }
    }
    if (out.length) return out;
    return this.call(() => this.provider(integrationKey(ref.integration)).listPrTemplates(ref, branch)).catch(
      () => [],
    );
  }
}

/** Provider web URLs (spec 10 §11 table); pure. */
export function buildWebUrl(
  kind: ProviderKind,
  url: string,
  rawHost: string,
  target: WebTarget,
): string | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return null;
  const host = rawHost === 'ssh.dev.azure.com' ? 'dev.azure.com' : rawHost;
  const repoPath = parsed.path.replace(/^v3\//, '');
  const enc = (x: string): string => x.split('/').map(encodeURIComponent).join('/');
  const lines = (t: { line?: number; endLine?: number }, a: string, sep: string, b = ''): string =>
    t.line ? `${a}${t.line}${t.endLine && t.endLine !== t.line ? `${sep}${b}${t.endLine}` : ''}` : '';
  if (kind === 'github' || kind === 'gitlab') {
    const base = `https://${host}/${repoPath}`;
    const d = kind === 'gitlab' ? '/-' : '';
    switch (target.kind) {
      case 'repo':
        return base;
      case 'commit':
        return `${base}${d}/commit/${target.sha}`;
      case 'branch':
        return `${base}${d}/tree/${enc(target.name)}`;
      case 'tag':
        return `${base}${d}/tree/${enc(target.name)}`;
      case 'file':
        return `${base}${d}/blob/${target.rev}/${enc(target.path)}${
          kind === 'github' ? lines(target, '#L', '-', 'L') : lines(target, '#L', '-')
        }`;
      case 'pr':
        return kind === 'github'
          ? `${base}/pull/${target.number}`
          : `${base}/-/merge_requests/${target.number}`;
      case 'compare':
        return `${base}${d}/compare/${enc(target.base)}...${enc(target.head)}`;
    }
  }
  if (kind === 'bitbucket') {
    const base = `https://${host}/${repoPath}`;
    switch (target.kind) {
      case 'repo':
        return base;
      case 'commit':
        return `${base}/commits/${target.sha}`;
      case 'branch':
        return `${base}/branch/${enc(target.name)}`;
      case 'tag':
        return `${base}/src/${enc(target.name)}`;
      case 'file':
        return `${base}/src/${target.rev}/${enc(target.path)}${lines(target, '#lines-', ':')}`;
      case 'pr':
        return `${base}/pull-requests/${target.number}`;
      case 'compare':
        return `${base}/branches/compare/${enc(target.head)}%0D${enc(target.base)}`;
    }
  }
  if (kind === 'bitbucket-dc') {
    // https://host/scm/KEY/slug(.git) or ssh://git@host:7999/KEY/slug
    const parts = repoPath.replace(/^scm\//, '').split('/');
    if (parts.length < 2) return null;
    const base = `https://${host}/projects/${parts[0]!.toUpperCase()}/repos/${parts[1]}`;
    switch (target.kind) {
      case 'repo':
        return `${base}/browse`;
      case 'commit':
        return `${base}/commits/${target.sha}`;
      case 'branch':
        return `${base}/browse?at=${encodeURIComponent(`refs/heads/${target.name}`)}`;
      case 'tag':
        return `${base}/browse?at=${encodeURIComponent(`refs/tags/${target.name}`)}`;
      case 'file':
        return `${base}/browse/${enc(target.path)}?at=${encodeURIComponent(target.rev)}${lines(target, '#', '-')}`;
      case 'pr':
        return `${base}/pull-requests/${target.number}`;
      case 'compare':
        return `${base}/compare/diff?sourceBranch=${encodeURIComponent(`refs/heads/${target.head}`)}&targetBranch=${encodeURIComponent(`refs/heads/${target.base}`)}`;
    }
  }
  if (kind === 'azure-devops') {
    // ssh path v3/org/project/repo → https://dev.azure.com/org/project/_git/repo
    const parts = repoPath.split('/');
    const az = parts.includes('_git')
      ? `https://${host}/${repoPath}`
      : `https://${host}/${parts[0]}/${parts[1]}/_git/${parts[2]}`;
    switch (target.kind) {
      case 'repo':
        return az;
      case 'commit':
        return `${az}/commit/${target.sha}`;
      case 'branch':
        return `${az}?version=GB${encodeURIComponent(target.name)}`;
      case 'tag':
        return `${az}?version=GT${encodeURIComponent(target.name)}`;
      case 'file':
        return `${az}?path=/${encodeURIComponent(target.path)}&version=GC${target.rev}${
          target.line ? `&line=${target.line}&lineEnd=${target.endLine ?? target.line}` : ''
        }`;
      case 'pr':
        return `${az}/pullrequest/${target.number}`;
      case 'compare':
        return `${az}/branchCompare?baseVersion=GB${encodeURIComponent(target.base)}&targetVersion=GB${encodeURIComponent(target.head)}`;
    }
  }
  return null;
}
