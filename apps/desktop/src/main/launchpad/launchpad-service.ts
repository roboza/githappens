import path from 'node:path';

import {
  CLASSIFIER_VERSION,
  classifyAll,
  countOpenPrs,
  dedupeItems,
  filterItems,
  issueItem,
  matchesFilters,
  nextSnoozeExpiry,
  normalizePath,
  prItem,
  repoKey,
  sortItems,
  summarize,
  tabCounts,
  topItems,
  wipCount,
  wipItem,
  type ClassifiedItem,
  type ClassifyContext,
  type ItemUserState,
  type LaunchpadFilters,
  type LaunchpadItem,
  type LaunchpadSourceError,
  type LaunchpadSummary,
  type LaunchpadTab,
  type OpenPrCounts,
  type SavedView,
  type SnoozeState,
  type WipStatus,
} from '@githappens/launchpad';
import {
  integrationKey,
  ProviderError,
  type ConnectedIntegration,
  type HostingProvider,
  type IssueTracker,
  type ProviderErrorCode,
  type SerializedProviderError,
} from '@githappens/providers';

import type {
  LaunchpadEventContract,
  LaunchpadPrCountsResult,
  LaunchpadQueryResult,
  LaunchpadSummaryResult,
} from '../../shared/ipc/launchpad-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';
import { LaunchpadStore } from './launchpad-store';
import { PrNotifier, type PrNotificationDeps } from './pr-notifier';

/** The subset of IntegrationService the Launchpad needs (spec 10). */
export interface LaunchpadIntegrations {
  list(): ConnectedIntegration[];
  /** Throws when the account isn't a connected hosting provider. */
  provider(key: string): HostingProvider;
  /** Throws when the account has no issue tracker. */
  tracker(key: string): IssueTracker;
}

/** A local repository the Launchpad can map provider items onto (via its remote URLs). */
export interface LocalRepo {
  path: string;
  /** Checked-out branch (open repo tabs only → `current-branch` group). */
  branch?: string;
  /** Fetch URLs of the repo's remotes. */
  remotes?: string[];
}

/** A repository of a workspace (spec 11 §5.1, reduced to what the Launchpad needs). */
export interface LaunchpadWorkspaceRepo {
  id?: string;
  localPath?: string;
  integrationKey?: string;
  owner?: string;
  name?: string;
  remotes?: string[];
}

export interface LaunchpadDeps {
  integrations: LaunchpadIntegrations;
  /** Repos open in tabs with their checked-out branch (and remotes when known). */
  openRepos(): LocalRepo[] | Promise<LocalRepo[]>;
  /** Repos with uncommitted changes in scope (recent repos + workspace repos with a local path). */
  wips(): Promise<Array<WipStatus & { remotes?: string[] }>>;
  /** Active profile directory (state file `launchpad.json` lives here). */
  profileDir(): string;
  /** Cache directory (`launchpad-<profile>.json`). */
  cacheDir(): string;
  emit<E extends keyof LaunchpadEventContract>(event: E, payload: LaunchpadEventContract[E]): void;
  now?(): number;
  /** Profile id for the cache file name (default: basename of profileDir()). */
  profileId?(): string;
  /** Repos of a workspace, or null when it doesn't exist. Enables workspace scope + team mode. */
  workspaceRepos?(workspaceId: string): Promise<LaunchpadWorkspaceRepo[] | null>;
  /** Further local repos (recents) used only to map PRs/issues to local paths. */
  knownRepos?(): Promise<LocalRepo[]>;
  /** Pull request notifications after personal refreshes (`notifications.prEvents`); absent → none. */
  prNotifications?: PrNotificationDeps;
}

/** A workspace repo resolved to a provider repository. */
interface WorkspaceRef {
  id?: string;
  integrationKey: string;
  owner: string;
  name: string;
  localPath?: string;
}

/** One fetch unit: personal PRs or issues of one account. */
interface SourceResult {
  key: string;
  label: string;
  items: LaunchpadItem[];
  error?: SerializedProviderError;
  fetchedAt: number;
}

interface CacheFile {
  version: 1;
  classifier: number;
  fetchedAt: number;
  sources: SourceResult[];
}

const HOSTING = new Set(['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'azure-devops']);
const TRACKING = new Set([
  'github',
  'gitlab',
  'jira-cloud',
  'jira-dc',
  'trello',
  'azure-devops',
  'azure-boards',
]);
const KIND_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'bitbucket-dc': 'Bitbucket DC',
  'azure-devops': 'Azure DevOps',
  'azure-boards': 'Azure Boards',
  'jira-cloud': 'Jira',
  'jira-dc': 'Jira DC',
  trello: 'Trello',
};
const TEAM_CAP = 500;
const TEAM_CONCURRENCY = 4;
const WIP_MEMO_MS = 5_000;
const STARTUP_REFRESH_MS = 3_000;
/** Floor of the background (PR notification) refresh interval. */
export const BACKGROUND_MIN_MS = 3 * 60_000;
const ERROR_CODES = new Set<ProviderErrorCode>([
  'auth_required',
  'token_expired',
  'insufficient_scope',
  'rate_limited',
  'not_found',
  'forbidden_org_policy',
  'network',
  'conflict',
  'validation',
  'unsupported',
  'server',
]);

/** Normalize anything thrown by a provider / IntegrationService into a serializable error. */
export function serializeError(e: unknown): SerializedProviderError {
  if (e instanceof ProviderError) return e.serialized;
  const ser = (e as { serialized?: { message?: string; details?: Record<string, unknown> } } | null)
    ?.serialized;
  if (ser && typeof ser === 'object') {
    const code = ser.details?.providerCode;
    const out: SerializedProviderError = {
      code:
        typeof code === 'string' && ERROR_CODES.has(code as ProviderErrorCode)
          ? (code as ProviderErrorCode)
          : 'server',
      message: ser.message ?? 'Request failed.',
    };
    if (typeof ser.details?.retryAt === 'number') out.retryAt = ser.details.retryAt;
    return out;
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message) ? 'network' : 'server',
    message,
  };
}

/** Strip bodies from items for the disk cache (list fields only, §6.4 step 6). */
function slim(item: LaunchpadItem): LaunchpadItem {
  if (item.type === 'pr') return { ...item, pr: { ...item.pr, body: '' } };
  if (item.type === 'issue') return { ...item, issue: { ...item.issue, body: '' } };
  return item;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Launchpad pipeline (spec 11 §6.4): fan-out personal queries per connected integration, dedupe,
 * enrich with local repos, apply pin/snooze, classify, filter. Snapshot cached in memory and on disk
 * (instant startup paint); pin/snooze/views persisted per profile.
 *
 * Refresh policy (§6.5) is driven by callers: the renderer polls `query`/`summary` with a
 * `maxAgeMs` (3 min visible, 10 min status bar) and TanStack pauses polling when hidden; a stale
 * snapshot triggers a background refresh that ends with `launchpad:updated`.
 */
export class LaunchpadService {
  private storeCache: { dir: string; store: LaunchpadStore } | null = null;
  private sources = new Map<string, SourceResult>();
  private fetchedAt: number | null = null;
  private fromCache = false;
  private cacheLoaded = false;
  private inflight: Promise<void> | null = null;
  private team = new Map<string, { fetchedAt: number; sources: SourceResult[] }>();
  private teamInflight = new Map<string, Promise<void>>();
  private wipMemo: { at: number; value: Array<WipStatus & { remotes?: string[] }> } | null = null;
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private bgTimer: ReturnType<typeof setTimeout> | null = null;
  /** System suspended (powerMonitor `suspend` → `resume`). */
  private suspended = false;
  /** Screen locked (powerMonitor `lock-screen` → `unlock-screen`). */
  private locked = false;
  private disposed = false;
  private readonly prNotifier: PrNotifier | null;

  constructor(private readonly deps: LaunchpadDeps) {
    this.prNotifier = deps.prNotifications
      ? new PrNotifier({
          ...deps.prNotifications,
          profileDir: () => this.deps.profileDir(),
          emit: (e, p) => this.deps.emit(e, p),
          now: () => this.now(),
        })
      : null;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Per-profile store (re-created after a profile switch). */
  get store(): LaunchpadStore {
    const dir = this.deps.profileDir();
    if (this.storeCache?.dir !== dir) {
      this.storeCache = { dir, store: new LaunchpadStore(dir) };
      this.resetSnapshot();
    }
    return this.storeCache.store;
  }

  private resetSnapshot(): void {
    this.sources.clear();
    this.team.clear();
    this.fetchedAt = null;
    this.fromCache = false;
    this.cacheLoaded = false;
  }

  private get cacheFile(): string {
    const id = this.deps.profileId?.() ?? path.basename(this.deps.profileDir());
    return path.join(this.deps.cacheDir(), `launchpad-${id.replace(/[^\w.-]+/g, '_')}.json`);
  }

  // ---------------------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------------------

  /** App start: paint from disk cache, refresh after 3 s idle (§6.5). */
  start(): void {
    void this.store;
    this.loadCache();
    this.scheduleSnoozeTimer();
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.deps.integrations.list().length) void this.refresh().catch(() => undefined);
    }, STARTUP_REFRESH_MS);
    this.startTimer.unref?.();
    this.scheduleBackground();
  }

  /** System resumed from sleep / clock change: recompute snooze expiry (§8); background polling resumes. */
  onResume(): void {
    this.suspended = false;
    this.scheduleSnoozeTimer();
    this.emitUpdated();
    this.scheduleBackground();
  }

  /** System is going to sleep: no background refresh until `onResume`. */
  onSuspend(): void {
    this.suspended = true;
    this.clearBackground();
  }

  /** Screen locked / unlocked: background refresh pauses while locked. */
  setScreenLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.clearBackground();
    else this.scheduleBackground();
  }

  // ---------------------------------------------------------------------------------------------
  // background refresh (PR notifications)
  // ---------------------------------------------------------------------------------------------

  /**
   * Interval of the main-process refresh: `launchpad.refreshMinutes`, at least 3 min. The renderer
   * stops polling after 10 min blurred — exactly when OS notifications matter — so main keeps the
   * personal snapshot fresh while `notifications.prEvents` is on.
   */
  private backgroundIntervalMs(): number {
    let min = 3;
    try {
      min = Number(this.deps.prNotifications?.refreshMinutes?.() ?? 3);
    } catch {
      /* default */
    }
    return Math.max(BACKGROUND_MIN_MS, (Number.isFinite(min) ? min : 3) * 60_000);
  }

  private clearBackground(): void {
    if (this.bgTimer) clearTimeout(this.bgTimer);
    this.bgTimer = null;
  }

  /** (Re-)arm the background timer; `delay` defaults to the interval. No-op without PR notifications. */
  private scheduleBackground(delay?: number): void {
    this.clearBackground();
    if (this.disposed || !this.deps.prNotifications || this.suspended || this.locked) return;
    this.bgTimer = setTimeout(
      () => {
        this.bgTimer = null;
        void this.backgroundTick();
      },
      Math.max(1_000, delay ?? this.backgroundIntervalMs()),
    );
    this.bgTimer.unref?.();
  }

  private safeDep(fn: (() => boolean) | undefined): boolean {
    try {
      return !!fn?.();
    } catch {
      return false;
    }
  }

  /**
   * One background check. Refreshes only when PR notifications are on, an integration is
   * connected, the app is online, the snapshot is older than the interval (renderer polling keeps it
   * fresh → no double refresh) and not every PR source is rate-limited. Shares the in-flight refresh.
   * Returns whether a refresh ran (tests).
   */
  async backgroundTick(): Promise<boolean> {
    const n = this.deps.prNotifications;
    if (this.disposed || !n || this.suspended || this.locked) return false;
    const interval = this.backgroundIntervalMs();
    let next = interval;
    try {
      if (!this.safeDep(() => n.enabled())) return false;
      if (!this.deps.integrations.list().length) return false;
      if (!this.safeDep(() => n.isOnline())) return false;
      void this.store;
      this.loadCache();
      const now = this.now();
      // Renderer (or another caller) refreshed recently: wait until that snapshot is due.
      if (this.inflight) return false;
      if (this.fetchedAt !== null && !this.fromCache && now - this.fetchedAt < interval) {
        next = interval - (now - this.fetchedAt) + 1_000;
        return false;
      }
      // Rate limiting (§6.5): when every PR source is backing off, wait for the earliest reset.
      const prSources = [...this.sources.values()].filter((s) => s.key.endsWith('#prs'));
      const limited = prSources.filter(
        (s) => s.error?.code === 'rate_limited' && (s.error.retryAt ?? 0) > now,
      );
      if (prSources.length && limited.length === prSources.length) {
        const reset = Math.min(...limited.map((s) => s.error!.retryAt!));
        next = Math.max(interval, reset - now + 1_000);
        return false;
      }
      await this.refresh().catch(() => undefined);
      return true;
    } finally {
      // Always re-arm (cheap check): a runtime toggle of the setting takes effect on the next tick.
      this.scheduleBackground(next);
    }
  }

  /**
   * A repo's working tree / branch changed, or the set of local repos did (workspace edits): drop the
   * WIP memo; with `notify`, lists refetch (`launchpad:updated`).
   */
  invalidateLocal(notify = false): void {
    this.wipMemo = null;
    if (notify) this.emitUpdated();
  }

  dispose(): void {
    this.disposed = true;
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.snoozeTimer = this.startTimer = null;
    this.clearBackground();
  }

  private loadCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const r = readJson<CacheFile>(this.cacheFile);
    if (r.kind !== 'ok' || r.value?.version !== 1 || !Array.isArray(r.value.sources)) return;
    if (this.fetchedAt !== null) return; // a live refresh already landed
    for (const s of r.value.sources) this.sources.set(s.key, s);
    this.fetchedAt = r.value.fetchedAt;
    this.fromCache = true;
  }

  private saveCache(): void {
    if (this.fetchedAt === null) return;
    const file: CacheFile = {
      version: 1,
      classifier: CLASSIFIER_VERSION,
      fetchedAt: this.fetchedAt,
      sources: [...this.sources.values()].map((s) => ({ ...s, items: s.items.map(slim) })),
    };
    try {
      writeFileAtomic(this.cacheFile, JSON.stringify(file));
    } catch {
      /* cache is best effort */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // fetching
  // ---------------------------------------------------------------------------------------------

  /** Refresh personal sources (or a workspace's team listing) now; concurrent calls share one run. */
  refresh(opts: { force?: boolean; workspaceId?: string } = {}): Promise<void> {
    this.wipMemo = null;
    if (opts.workspaceId && this.deps.workspaceRepos) {
      return Promise.all([this.refreshTeam(opts.workspaceId), this.refresh({ force: opts.force })]).then(
        () => undefined,
      );
    }
    this.inflight ??= this.runRefresh(!!opts.force).finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Epoch ms of the last personal refresh (or of the loaded disk cache). */
  get lastFetchedAt(): number | null {
    return this.fetchedAt;
  }

  private label(i: ConnectedIntegration): string {
    return `${KIND_LABEL[i.kind] ?? i.kind} (${i.host})`;
  }

  private async runRefresh(force: boolean): Promise<void> {
    void this.store;
    const accounts = this.deps.integrations.list();
    const now = this.now();
    const tasks: Array<{ key: string; label: string; run: () => Promise<LaunchpadItem[]> }> = [];
    for (const acc of accounts) {
      if (HOSTING.has(acc.kind)) {
        let p: HostingProvider | undefined;
        try {
          p = this.deps.integrations.provider(acc.key);
        } catch {
          p = undefined;
        }
        if (p?.searchMyPullRequests) {
          const search = p.searchMyPullRequests.bind(p);
          tasks.push({
            key: `${acc.key}#prs`,
            label: this.label(acc),
            run: async () => (await search()).map((r) => prItem(r.pr, r.involvement)),
          });
        }
      }
      if (TRACKING.has(acc.kind)) {
        let t: IssueTracker | undefined;
        try {
          t = this.deps.integrations.tracker(acc.key);
        } catch {
          t = undefined;
        }
        if (t?.searchMyIssues) {
          const search = t.searchMyIssues.bind(t);
          tasks.push({
            key: `${acc.key}#issues`,
            label: this.label(acc),
            run: async () => (await search()).map((r) => issueItem(r.issue, r.involvement)),
          });
        }
      }
    }

    const next = new Map<string, SourceResult>();
    /** Accounts whose PR source returned live data this time (PR notifications diff only those). */
    const okAccounts: string[] = [];
    await Promise.all(
      tasks.map(async (t) => {
        const prev = this.sources.get(t.key);
        // Rate-limited source: skip until reset, keep cached items + chip (§6.5).
        if (!force && prev?.error?.code === 'rate_limited' && (prev.error.retryAt ?? 0) > now) {
          next.set(t.key, prev);
          return;
        }
        try {
          next.set(t.key, { key: t.key, label: t.label, items: await t.run(), fetchedAt: this.now() });
          if (t.key.endsWith('#prs')) okAccounts.push(t.key.slice(0, -'#prs'.length));
        } catch (e) {
          next.set(t.key, {
            key: t.key,
            label: t.label,
            items: prev?.items ?? [],
            error: serializeError(e),
            fetchedAt: prev?.fetchedAt ?? 0,
          });
        }
      }),
    );
    if (this.disposed) return;
    this.sources = next;
    this.fetchedAt = this.now();
    this.fromCache = false;
    this.store.markSeen(
      [...next.values()].flatMap((s) => s.items.map((i) => i.uid)),
      this.fetchedAt,
    );
    this.saveCache();
    this.scheduleSnoozeTimer();
    this.emitUpdated(this.prNotifier ? (items) => this.prNotifier?.onRefresh(items, okAccounts) : undefined);
  }

  /** Team mode (§6.4): every open PR of the workspace repos, per-repo listing, concurrency 4. */
  private refreshTeam(workspaceId: string): Promise<void> {
    let p = this.teamInflight.get(workspaceId);
    if (!p) {
      p = this.runTeam(workspaceId).finally(() => this.teamInflight.delete(workspaceId));
      this.teamInflight.set(workspaceId, p);
    }
    return p;
  }

  private async runTeam(workspaceId: string): Promise<void> {
    const repos = (await this.deps.workspaceRepos?.(workspaceId)) ?? [];
    const refs = await this.workspaceRefs(repos);
    const byAccount = new Map<string, Array<{ owner: string; name: string }>>();
    for (const r of refs) {
      const list = byAccount.get(r.integrationKey) ?? [];
      list.push(r);
      byAccount.set(r.integrationKey, list);
    }
    const accounts = new Map(this.deps.integrations.list().map((a) => [a.key, a]));
    const sources: SourceResult[] = [];
    for (const [key, list] of byAccount) {
      const acc = accounts.get(key);
      if (!acc) continue;
      const src: SourceResult = {
        key: `${key}#team`,
        label: this.label(acc),
        items: [],
        fetchedAt: this.now(),
      };
      try {
        const p = this.deps.integrations.provider(key);
        const lists = await mapLimit(list, TEAM_CONCURRENCY, async (r) => {
          const page = await p.listPullRequests(
            {
              integration: { kind: acc.kind, host: acc.host, accountId: acc.accountId },
              owner: r.owner,
              name: r.name,
            },
            { preset: 'all', state: 'open' },
          );
          return page.items;
        });
        src.items = lists
          .flat()
          .slice(0, TEAM_CAP)
          .map((pr) => prItem(pr));
      } catch (e) {
        src.error = serializeError(e);
      }
      sources.push(src);
    }
    this.team.set(workspaceId, { fetchedAt: this.now(), sources });
    this.emitUpdated();
  }

  // ---------------------------------------------------------------------------------------------
  // enrichment
  // ---------------------------------------------------------------------------------------------

  /** Provider-repo keys a remote URL belongs to, for every connected hosting account. */
  private remoteKeys(urls: string[] | undefined, providers: Array<[string, HostingProvider]>): string[] {
    const out: string[] = [];
    for (const url of urls ?? []) {
      for (const [key, p] of providers) {
        const m = p.matchRemoteUrl(url);
        if (m) out.push(repoKey(key, m.owner, m.name));
      }
    }
    return out;
  }

  private hostingProviders(): Array<[string, HostingProvider]> {
    const out: Array<[string, HostingProvider]> = [];
    for (const acc of this.deps.integrations.list()) {
      if (!HOSTING.has(acc.kind)) continue;
      try {
        out.push([acc.key, this.deps.integrations.provider(acc.key)]);
      } catch {
        /* not connected */
      }
    }
    return out;
  }

  private async workspaceRefs(repos: LaunchpadWorkspaceRepo[]): Promise<WorkspaceRef[]> {
    const providers = this.hostingProviders();
    const out: WorkspaceRef[] = [];
    for (const r of repos) {
      if (r.integrationKey && r.owner && r.name) {
        out.push({
          id: r.id,
          integrationKey: r.integrationKey,
          owner: r.owner,
          name: r.name,
          localPath: r.localPath,
        });
        continue;
      }
      for (const url of r.remotes ?? []) {
        for (const [key, p] of providers) {
          const m = p.matchRemoteUrl(url);
          if (m)
            out.push({ id: r.id, integrationKey: key, owner: m.owner, name: m.name, localPath: r.localPath });
        }
      }
    }
    return out;
  }

  private async localContext(): Promise<{
    wips: Array<WipStatus & { remotes?: string[] }>;
    pathByRepo: Map<string, string>;
    currentBranches: NonNullable<ClassifyContext['currentBranches']>;
  }> {
    const now = this.now();
    if (!this.wipMemo || now - this.wipMemo.at > WIP_MEMO_MS) {
      const value = await this.deps.wips().catch(() => []);
      this.wipMemo = { at: now, value };
    }
    const wips = this.wipMemo.value;
    const open = await this.deps.openRepos();
    const known = (await this.deps.knownRepos?.().catch(() => [])) ?? [];
    const providers = this.hostingProviders();
    const pathByRepo = new Map<string, string>();
    const keysOf = new Map<string, string[]>();
    for (const r of [...open, ...wips.map((w) => ({ path: w.path, remotes: w.remotes })), ...known]) {
      const np = normalizePath(r.path);
      if (keysOf.has(np) && !r.remotes?.length) continue;
      const keys = this.remoteKeys(r.remotes, providers);
      keysOf.set(np, keys);
      for (const k of keys) if (!pathByRepo.has(k)) pathByRepo.set(k, r.path);
    }
    const currentBranches = open
      .filter((r) => r.branch)
      .map((r) => ({
        branch: r.branch!,
        localPath: r.path,
        repoKeys: keysOf.get(normalizePath(r.path)) ?? [],
      }));
    return { wips, pathByRepo, currentBranches };
  }

  private itemRepoKey(item: LaunchpadItem): string | undefined {
    if (item.type === 'pr')
      return repoKey(integrationKey(item.pr.repo.integration), item.pr.repo.owner, item.pr.repo.name);
    if (
      item.type === 'issue' &&
      (item.issue.tracker.kind === 'github' || item.issue.tracker.kind === 'gitlab')
    ) {
      const scope = item.issue.tracker.scope;
      const i = scope.lastIndexOf('/');
      if (i > 0)
        return repoKey(integrationKey(item.issue.tracker.integration), scope.slice(0, i), scope.slice(i + 1));
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // query
  // ---------------------------------------------------------------------------------------------

  private viewers(): ClassifyContext['viewers'] {
    const out: NonNullable<ClassifyContext['viewers']> = {};
    for (const a of this.deps.integrations.list()) out[a.key] = { id: a.accountId, login: a.login };
    return out;
  }

  /** Make sure there is data: disk cache or a first refresh; refresh in the background when stale. */
  private async ensureFresh(maxAgeMs: number | undefined, offline = false): Promise<void> {
    void this.store;
    this.loadCache();
    // Offline (§6.5): no requests; callers paint the cached snapshot with an "Offline" banner.
    if (offline || !this.deps.integrations.list().length) return;
    if (this.fetchedAt === null) {
      await this.refresh();
      return;
    }
    const age = this.now() - this.fetchedAt;
    if (this.fromCache || (maxAgeMs !== undefined && age > maxAgeMs))
      void this.refresh().catch(() => undefined);
  }

  /** Classified items for the scope/mode (no tab/text filtering). */
  private async scopedItems(
    filters: LaunchpadFilters,
  ): Promise<{ items: ClassifiedItem[]; errors: LaunchpadSourceError[]; teamUnavailable?: boolean }> {
    const { wips, pathByRepo, currentBranches } = await this.localContext();
    const scope = filters.scope;
    let sources = [...this.sources.values()];
    let teamUnavailable = false;
    if (filters.mode === 'team') {
      if (scope.kind === 'workspace') sources = this.team.get(scope.workspaceId)?.sources ?? [];
      else teamUnavailable = true;
    }
    let items: LaunchpadItem[] = dedupeItems(sources.flatMap((s) => s.items));

    // Workspace scope: provider items of workspace repos (+ issues of global trackers) and local WIPs.
    let wipList = wips.filter((w) => wipCount(w) > 0);
    if (scope.kind === 'workspace') {
      const repos = (await this.deps.workspaceRepos?.(scope.workspaceId)) ?? [];
      const refs = await this.workspaceRefs(repos);
      const keys = new Set(refs.map((r) => repoKey(r.integrationKey, r.owner, r.name)));
      const paths = new Set(repos.filter((r) => r.localPath).map((r) => normalizePath(r.localPath!)));
      items = items.filter((i) => {
        const k = this.itemRepoKey(i);
        if (k) return keys.has(k);
        return i.type === 'issue'; // Jira / Azure Boards: all projects by default (§6.4)
      });
      wipList = wipList.filter((w) => paths.has(normalizePath(w.path)));
    }

    // Enrich with local paths (§6.4 step 3).
    items = items.map((i) => {
      const k = this.itemRepoKey(i);
      const local = k ? pathByRepo.get(k) : undefined;
      return local && i.repo ? { ...i, repo: { ...i.repo, localPath: local } } : i;
    });
    const now = this.now();
    items.push(...wipList.map((w) => wipItem(w, now)));

    const classified = classifyAll(items, {
      now,
      itemStates: this.store.states(),
      currentBranches,
      viewers: this.viewers(),
    });
    const errors = sources
      .filter((s) => s.error)
      .map((s) => ({ source: s.key.split('#')[0]!, label: s.label, error: s.error! }));
    return { items: classified, errors, teamUnavailable: teamUnavailable || undefined };
  }

  async query(req: {
    filters: LaunchpadFilters;
    tab: LaunchpadTab;
    maxAgeMs?: number;
    offline?: boolean;
  }): Promise<LaunchpadQueryResult> {
    const { filters, tab } = req;
    this.store.setLastFilters(filters);
    if (req.offline) {
      await this.ensureFresh(undefined, true);
    } else if (filters.mode === 'team' && filters.scope.kind === 'workspace') {
      const t = this.team.get(filters.scope.workspaceId);
      const max = req.maxAgeMs ?? 5 * 60_000;
      if (!t) await this.refreshTeam(filters.scope.workspaceId);
      else if (this.now() - t.fetchedAt > max) void this.refreshTeam(filters.scope.workspaceId);
    } else {
      await this.ensureFresh(req.maxAgeMs);
    }
    const { items, errors, teamUnavailable } = await this.scopedItems(filters);
    const now = this.now();
    const inFilter = items.filter((i) => matchesFilters(i, filters, now));
    const fetchedAt =
      filters.mode === 'team' && filters.scope.kind === 'workspace'
        ? (this.team.get(filters.scope.workspaceId)?.fetchedAt ?? null)
        : this.fetchedAt;
    return {
      items: sortItems(filterItems(items, filters, tab, now)),
      errors,
      fetchedAt,
      stale: this.fromCache,
      refreshing: !!this.inflight,
      counts: tabCounts(inFilter),
      summary: summarize(items, errors.length > 0),
      hasIntegrations: this.deps.integrations.list().length > 0,
      ...(teamUnavailable ? { teamUnavailable } : {}),
    };
  }

  private async personalSummary(): Promise<{ items: ClassifiedItem[]; summary: LaunchpadSummary }> {
    const { items, errors } = await this.scopedItems({ scope: { kind: 'all' }, mode: 'personal' });
    return { items, summary: summarize(items, errors.length > 0) };
  }

  async summary(req: { maxAgeMs?: number; offline?: boolean } = {}): Promise<LaunchpadSummaryResult> {
    await this.ensureFresh(req.maxAgeMs ?? 10 * 60_000, !!req.offline);
    const { items, summary } = await this.personalSummary();
    return {
      ...summary,
      fetchedAt: this.fetchedAt,
      hasIntegrations: this.deps.integrations.list().length > 0,
      top: topItems(items, 5).map((i) => ({
        uid: i.uid,
        title: i.title,
        group: i.statusGroup,
        ref:
          i.type === 'pr'
            ? `${i.repo?.fullName ?? ''}#${i.pr.number}`
            : i.type === 'issue'
              ? i.issue.key
              : i.title,
      })),
    };
  }

  /**
   * Open-PR counts per workspace repo (spec 11 §4.1 overview column + "N open PRs" chip), from the
   * personal snapshot plus the workspace's team listing (which supplies the totals). Never waits for
   * the network: stale / missing data starts a background refresh that ends with `launchpad:updated`.
   */
  async workspacePrCounts(req: {
    workspaceId: string;
    maxAgeMs?: number;
    offline?: boolean;
  }): Promise<LaunchpadPrCountsResult> {
    void this.store;
    this.loadCache();
    const hasIntegrations = this.deps.integrations.list().length > 0;
    const repos = (await this.deps.workspaceRepos?.(req.workspaceId)) ?? null;
    if (!repos) return { counts: {}, complete: false, fetchedAt: null, hasIntegrations };
    const refs = await this.workspaceRefs(repos);
    const idByKey = new Map<string, string>();
    for (const r of refs) if (r.id) idByKey.set(repoKey(r.integrationKey, r.owner, r.name), r.id);

    const team = this.team.get(req.workspaceId);
    const maxAge = req.maxAgeMs ?? 5 * 60_000;
    if (!req.offline && hasIntegrations && idByKey.size) {
      if (!team || this.now() - team.fetchedAt > maxAge)
        void this.refreshTeam(req.workspaceId).catch(() => undefined);
      if (this.fetchedAt === null || this.fromCache || this.now() - this.fetchedAt > maxAge)
        void this.refresh().catch(() => undefined);
    }
    const items = dedupeItems([...this.sources.values(), ...(team?.sources ?? [])].flatMap((s) => s.items));
    const classified = classifyAll(items, {
      now: this.now(),
      itemStates: this.store.states(),
      viewers: this.viewers(),
    });
    const counts: Record<string, OpenPrCounts> = countOpenPrs(classified, (i) => {
      const k = this.itemRepoKey(i);
      return k ? idByKey.get(k) : undefined;
    });
    return {
      counts,
      complete: !!team && !team.sources.some((s) => s.error),
      fetchedAt: team?.fetchedAt ?? this.fetchedAt,
      hasIntegrations,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // user state
  // ---------------------------------------------------------------------------------------------

  setItemState(req: { uid: string; pin?: boolean; snooze?: SnoozeState | null }): ItemUserState | null {
    const nowIso = new Date(this.now()).toISOString();
    const cur = this.store.get(req.uid);
    const st: ItemUserState = cur ? { ...cur } : { uid: req.uid, lastSeenAt: nowIso };
    if (req.pin === true) {
      st.pinnedAt = nowIso;
      delete st.snooze;
    } else if (req.pin === false) delete st.pinnedAt;
    if (req.snooze === null) delete st.snooze;
    else if (req.snooze) {
      st.snooze = req.snooze;
      delete st.pinnedAt;
    }
    const out = this.store.put(st);
    this.scheduleSnoozeTimer();
    this.emitUpdated();
    this.notifyUserState();
    return out;
  }

  views(): { views: SavedView[]; lastFilters: LaunchpadFilters } {
    return { views: this.store.views(), lastFilters: this.store.lastFilters() };
  }

  saveView(view: Omit<SavedView, 'id'> & { id?: string }): SavedView {
    if (!view.name?.trim()) throw new Error('A saved view needs a name.');
    const saved = this.store.saveView({ ...view, name: view.name.trim() });
    this.notifyUserState();
    return saved;
  }

  deleteView(id: string): void {
    this.store.deleteView(id);
    this.notifyUserState();
  }

  // ---- settings sync (spec 14 §6.2): pins, snoozes and saved views ----

  private userStateListeners = new Set<() => void>();

  userState(): { itemStates: Record<string, ItemUserState>; savedViews: SavedView[] } {
    return { itemStates: { ...this.store.states() }, savedViews: [...this.store.views()] };
  }

  applyUserState(itemStates: Record<string, ItemUserState>, savedViews: SavedView[]): void {
    this.store.replaceUserState(itemStates, savedViews);
    this.scheduleSnoozeTimer();
    this.emitUpdated();
  }

  /** Pin/snooze/saved-view changes made by the user (not the sync itself). */
  onUserStateChange(listener: () => void): () => void {
    this.userStateListeners.add(listener);
    return () => this.userStateListeners.delete(listener);
  }

  private notifyUserState(): void {
    for (const l of [...this.userStateListeners]) l();
  }

  // ---------------------------------------------------------------------------------------------
  // events & timers
  // ---------------------------------------------------------------------------------------------

  /** `afterRefresh` gets the classified personal items of the refresh (PR notifications). */
  private emitUpdated(afterRefresh?: (items: ClassifiedItem[]) => void): void {
    if (this.disposed) return;
    void this.personalSummary()
      .then(({ items, summary }) => {
        this.deps.emit('launchpad:updated', { fetchedAt: this.fetchedAt, summary });
        if (!this.disposed) afterRefresh?.(items);
      })
      .catch(() => undefined);
  }

  /** One timer to the nearest snooze `until`; on expiry re-classify and emit (§6.5). */
  private scheduleSnoozeTimer(): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = null;
    if (this.disposed) return;
    const now = this.now();
    const next = nextSnoozeExpiry(Object.values(this.store.states()), now);
    if (next === null) return;
    // Cap at 24 days (setTimeout limit); the timer simply re-arms.
    const delay = Math.min(next - now + 50, 2_000_000_000);
    this.snoozeTimer = setTimeout(() => {
      this.snoozeTimer = null;
      this.emitUpdated();
      this.scheduleSnoozeTimer();
    }, delay);
    this.snoozeTimer.unref?.();
  }
}
