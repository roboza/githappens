import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  integrationKey,
  parseRemoteUrl,
  type ConnectedIntegration,
  type HostingProvider,
  type InsightsPr,
  type RepoRef,
} from '@githappens/providers';

import type {
  DeploySignal,
  InsightsEventContract,
  InsightsQuery,
  InsightsRepoStatus,
  InsightsResult,
} from '../../../shared/ipc/insights-contract';
import type { Workspace, WorkspaceRepo } from '../../../shared/ipc/workspaces-contract';
import {
  computeDora,
  computePrMetrics,
  globToRegExp,
  mergeToDeployLeadTimes,
  rangeBounds,
  tagDeployEvents,
  type DeployEvent,
  type TagDeploy,
} from './metrics';

/** Spec 14 §6.6: results cached per (repo, range) for 6 h. */
export const INSIGHTS_CACHE_TTL_MS = 6 * 3_600_000;
/** Spec 14 §8: sample cap per repo. */
export const INSIGHTS_SAMPLE_CAP = 2000;

export interface InsightsServiceDeps {
  workspaces: { list(): Workspace[] };
  integrations: { list(): ConnectedIntegration[]; provider(key: string): HostingProvider };
  /** `git <args>` in a directory (read-only: for-each-ref / log). */
  runGit(cwd: string, args: string[]): Promise<string>;
  /** `<userData>/cache/insights`. */
  cacheDir(): string;
  /** Deployment signal from the `insights.*` settings. */
  defaultDeploy(): DeploySignal;
  emit?<E extends keyof InsightsEventContract>(event: E, payload: InsightsEventContract[E]): void;
  now?(): number;
  log?(message: string): void;
}

interface CacheFile<T> {
  version: 1;
  at: number;
  data: T;
}

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'bitbucket-dc': 'Bitbucket',
  'azure-devops': 'Azure DevOps',
};

/**
 * Insights (spec 14 §6.6), backend-free: merged PRs per workspace repo from the provider API (cached
 * 6 h in `userData/cache/insights/`), metrics computed locally; DORA from local tags or GitHub deployments
 * when a deployment signal is configured. Nothing leaves the machine except the provider API calls.
 */
export class InsightsService {
  private readonly inflight = new Map<string, Promise<InsightsResult>>();
  constructor(private readonly d: InsightsServiceDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  compute(q: InsightsQuery): Promise<InsightsResult> {
    const key = JSON.stringify(q);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.run(q).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  clearCache(workspaceId?: string): null {
    void workspaceId; // cache entries are per repo and shared between workspaces
    fs.rmSync(this.d.cacheDir(), { recursive: true, force: true });
    return null;
  }

  /** RepoRef for a workspace repo: its provider entry, else a connected account matching the remote host. */
  repoRef(r: WorkspaceRepo): RepoRef | undefined {
    const accounts = this.d.integrations.list();
    if (r.provider) {
      const acc = accounts.find((a) => a.key === r.provider!.integrationKey);
      if (acc)
        return {
          integration: { kind: acc.kind, host: acc.host, accountId: acc.accountId },
          owner: r.provider.owner,
          name: r.provider.name,
        };
    }
    const url = r.remoteUrl ?? r.provider?.cloneUrlHttps;
    const parsed = url ? parseRemoteUrl(url) : null;
    if (!parsed) return undefined;
    const acc = accounts.find((a) => a.host.split('/')[0]!.toLowerCase() === parsed.host);
    const parts = parsed.path.split('/').filter(Boolean);
    if (!acc || parts.length < 2) return undefined;
    const name = parts.pop()!.replace(/\.git$/i, '');
    return {
      integration: { kind: acc.kind, host: acc.host, accountId: acc.accountId },
      owner: parts.join('/'),
      name,
    };
  }

  private async run(q: InsightsQuery): Promise<InsightsResult> {
    const ws = this.d.workspaces.list().find((w) => w.id === q.workspaceId);
    if (!ws) throw new Error('Workspace not found.');
    const now = this.now();
    const { since, until } = rangeBounds(q.range, now);
    const deploy = q.deploy ?? this.d.defaultDeploy();
    const repos = ws.repos.filter((r) => !q.repos?.length || q.repos.includes(r.id));
    const statuses: InsightsRepoStatus[] = [];
    const allPrs: InsightsPr[] = [];
    const deployEvents: DeployEvent[] = [];
    const leadTimes: number[] = [];
    const kinds = new Set<string>();
    let sampled = false;
    let done = 0;
    const progress = (repo?: string): void =>
      this.d.emit?.('insights:progress', {
        workspaceId: ws.id,
        done,
        total: repos.length,
        ...(repo ? { repo } : {}),
      });
    progress();
    for (const r of repos) {
      const ref = this.repoRef(r);
      const st: InsightsRepoStatus = { repoId: r.id, name: r.name, state: 'ok', prs: 0, fromCache: false };
      statuses.push(st);
      try {
        if (!ref) {
          st.state = 'skipped';
          st.message = 'No connected account for this repository’s host.';
          continue;
        }
        const provider = this.d.integrations.provider(integrationKey(ref.integration));
        const insights = provider.insights?.();
        if (!insights) {
          st.state = 'skipped';
          st.message = `Insights are not available for ${PROVIDER_LABEL[ref.integration.kind] ?? ref.integration.kind} yet.`;
          continue;
        }
        kinds.add(ref.integration.kind);
        const cacheKey = `prs:${ref.integration.kind}:${ref.integration.host}:${ref.owner}/${ref.name}:${q.range}`;
        const cached = q.force
          ? undefined
          : this.cacheGet<{ items: InsightsPr[]; truncated: boolean }>(cacheKey);
        const res =
          cached ??
          (await insights.mergedPullRequests(ref, {
            since: new Date(since).toISOString(),
            until: new Date(until).toISOString(),
            max: INSIGHTS_SAMPLE_CAP,
          }));
        if (!cached) this.cachePut(cacheKey, res);
        st.fromCache = !!cached;
        st.prs = res.items.length;
        if (res.truncated) {
          st.truncated = true;
          sampled = true;
        }
        allPrs.push(...res.items);

        if (deploy.kind === 'github-deployments' && insights.deployments) {
          const dk = `deploys:${ref.integration.host}:${ref.owner}/${ref.name}:${deploy.environment}:${q.range}`;
          type Deploys = Awaited<ReturnType<NonNullable<typeof insights.deployments>>>;
          let list = q.force ? undefined : this.cacheGet<Deploys>(dk);
          if (!list) {
            list = await insights.deployments(ref, {
              environment: deploy.environment,
              since: new Date(since - 30 * 86_400_000).toISOString(),
              max: 1000,
            });
            this.cachePut(dk, list);
          }
          const evs = list
            .filter((x) => x.state !== 'pending' && x.state !== 'unknown')
            .map((x) => ({
              at: Date.parse(x.createdAt),
              failed: x.state === 'failure' || x.state === 'error',
            }));
          deployEvents.push(...evs);
          leadTimes.push(...mergeToDeployLeadTimes(res.items, evs));
        } else if (deploy.kind === 'tags' && r.localPath && fs.existsSync(r.localPath)) {
          const tags = await this.tagDeploys(r.localPath, deploy.pattern, since - 30 * 86_400_000);
          const t = tagDeployEvents(tags);
          deployEvents.push(...t.events);
          leadTimes.push(...t.leadTimesHrs);
        }
      } catch (e) {
        st.state = 'error';
        st.message = (e as Error).message;
        this.d.log?.(`insights ${r.name}: ${st.message}`);
      } finally {
        done++;
        progress(r.name);
      }
    }
    const m = computePrMetrics(allPrs, {
      since,
      until,
      ...(q.authors?.length ? { authors: q.authors } : {}),
    });
    const via = [...kinds].map((k) => PROVIDER_LABEL[k] ?? k).join(' + ') || 'provider';
    const result: InsightsResult = {
      range: q.range,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      ...m,
      sampled,
      source: `Computed locally from ${m.sampleSize} PR${m.sampleSize === 1 ? '' : 's'} via ${via} API${
        sampled ? ` (sampled: up to ${INSIGHTS_SAMPLE_CAP} per repository)` : ''
      }`,
      repos: statuses,
      computedAt: new Date(now).toISOString(),
    };
    if (deploy.kind !== 'none') {
      result.dora = computeDora(deployEvents, leadTimes, { since, until, signal: deploy.kind });
    }
    return result;
  }

  /** Tags matching `pattern` with their creation time and the commits each one released. */
  private async tagDeploys(dir: string, pattern: string, notBefore: number): Promise<TagDeploy[]> {
    const re = globToRegExp(pattern || '*');
    const out = await this.d.runGit(dir, [
      'for-each-ref',
      'refs/tags',
      '--sort=creatordate',
      '--format=%(refname:short)%09%(creatordate:unix)',
    ]);
    const tags = out
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((p) => p.length === 2 && re.test(p[0]!))
      .map(([name, t]) => ({ name: name!, at: Number(t) * 1000 }))
      .filter((t) => Number.isFinite(t.at));
    const result: TagDeploy[] = [];
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i]!;
      if (t.at < notBefore) continue;
      const prev = tags[i - 1];
      const range = prev ? [`${prev.name}..${t.name}`] : [t.name, '--max-count=200'];
      const log = await this.d
        .runGit(dir, ['log', '--no-merges', '--format=%ct%x09%s', ...range, '--'])
        .catch(() => '');
      result.push({
        name: t.name,
        at: t.at,
        commits: log
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [ct, ...subject] = l.split('\t');
            return { at: Number(ct) * 1000, subject: subject.join('\t') };
          }),
      });
    }
    return result;
  }

  // ---- cache ----

  private cachePath(key: string): string {
    return path.join(
      this.d.cacheDir(),
      `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`,
    );
  }

  private cacheGet<T>(key: string): T | undefined {
    try {
      const f = JSON.parse(fs.readFileSync(this.cachePath(key), 'utf8')) as CacheFile<T>;
      if (f.version !== 1 || this.now() - f.at > INSIGHTS_CACHE_TTL_MS || this.now() < f.at) return undefined;
      return f.data;
    } catch {
      return undefined;
    }
  }

  private cachePut<T>(key: string, data: T): void {
    try {
      fs.mkdirSync(this.d.cacheDir(), { recursive: true });
      fs.writeFileSync(
        this.cachePath(key),
        JSON.stringify({ version: 1, at: this.now(), data } satisfies CacheFile<T>),
      );
    } catch {
      /* cache only */
    }
  }
}
