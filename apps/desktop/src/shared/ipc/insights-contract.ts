/**
 * Insights IPC (spec 14 §4.5, §5.4, §6.6) — backend-free: PR and DORA-style metrics computed locally from
 * provider APIs (and local tags for deployments) over a workspace's repositories. Nothing is uploaded.
 */

export type InsightsRange = '7d' | '30d' | '90d';

/** Deployment signal for the DORA tiles (none = tiles hidden). */
export type DeploySignal =
  | { kind: 'none' }
  /** Tags matching a glob (`v*`, `release-*`) in the local clones; tag time = deploy time. */
  | { kind: 'tags'; pattern: string }
  /** GitHub Deployments API for an environment (latest status success / failure). */
  | { kind: 'github-deployments'; environment: string };

export interface InsightsQuery {
  workspaceId: string;
  range: InsightsRange;
  /** Workspace repo ids (default: all repos with a provider). */
  repos?: string[];
  /** Provider logins (team mode); default everyone. */
  authors?: string[];
  /** Default: the `insights.*` settings. */
  deploy?: DeploySignal;
  /** Ignore the 6 h cache. */
  force?: boolean;
}

export interface Percentiles {
  median: number;
  p75: number;
}

export interface DoraMetrics {
  deploymentsPerWeek: number;
  /** Commit (tags) or merge (deployments API) → deploy, median hours. */
  leadTimeHrs: number;
  /** 0..1. */
  changeFailureRate: number;
  /** Failure → next successful deploy, median hours (0 when no failures). */
  mttrHrs: number;
  deployments: number;
  signal: Exclude<DeploySignal['kind'], 'none'>;
}

export interface InsightsRepoStatus {
  repoId: string;
  name: string;
  state: 'ok' | 'skipped' | 'error';
  message?: string;
  prs: number;
  fromCache: boolean;
  truncated?: boolean;
}

export interface InsightsResult {
  range: InsightsRange;
  since: string;
  until: string;
  prCycleTimeHrs: Percentiles;
  timeToFirstReviewHrs: Percentiles;
  /** ISO weeks (`2026-W40`), oldest first, zero-filled. */
  mergedPerWeek: Array<{ week: string; count: number }>;
  /** Median cycle time per ISO week (null = no merged PR that week). */
  cycleTimeTrend: Array<{ week: string; medianHrs: number | null }>;
  prSize: { p50: number; p90: number; buckets: Array<{ label: string; count: number }> };
  reviewLoad: Array<{ reviewer: string; count: number }>;
  /** Only when a deployment signal is configured. */
  dora?: DoraMetrics;
  /** PRs that entered the metrics (after author filtering). */
  sampleSize: number;
  /** Some repo hit the sample cap (2,000 PRs) or the provider search limit. */
  sampled: boolean;
  /** "Computed locally from 412 PRs via GitHub API". */
  source: string;
  authors: string[];
  repos: InsightsRepoStatus[];
  computedAt: string;
}

export interface InsightsIpcContract {
  'insights:compute': { req: InsightsQuery; res: InsightsResult };
  /** Drop cached provider data (all workspaces, or one). */
  'insights:clearCache': { req: { workspaceId?: string }; res: null };
}

export interface InsightsEventContract {
  'insights:progress': { workspaceId: string; done: number; total: number; repo?: string };
}

export const INSIGHTS_INVOKE_CHANNELS = [
  'insights:compute',
  'insights:clearCache',
] as const satisfies readonly (keyof InsightsIpcContract)[];

export const INSIGHTS_EVENT_CHANNELS = [
  'insights:progress',
] as const satisfies readonly (keyof InsightsEventContract)[];

type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never]
  ? true
  : { missing: Exclude<All, Listed> };
const invokeExhaustive: Exhaustive<keyof InsightsIpcContract, (typeof INSIGHTS_INVOKE_CHANNELS)[number]> =
  true;
const eventExhaustive: Exhaustive<keyof InsightsEventContract, (typeof INSIGHTS_EVENT_CHANNELS)[number]> =
  true;
void invokeExhaustive;
void eventExhaustive;
