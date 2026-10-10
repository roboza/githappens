/**
 * Insights queries (spec 14 §6.6): merged pull requests in a time range with sizes and first reviews,
 * plus deployments, for metrics computed locally on the desktop. Providers expose them through the
 * optional `HostingProvider.insights()`; implementations live next to each provider
 * (`github/insights.ts`, `gitlab/insights.ts`).
 */
import type { RepoRef } from './types';

export interface InsightsPr {
  number: number;
  title: string;
  /** Author login. */
  author: string;
  createdAt: string;
  mergedAt?: string;
  /** Ready-for-review time for PRs opened as drafts (when the provider reports it). */
  readyAt?: string;
  /** First commit's authored time. */
  firstCommitAt?: string;
  additions: number;
  deletions: number;
  /** Non-author reviews / review comments, oldest first. */
  reviews: Array<{ login: string; at: string }>;
  /** Merge (or squash) commit; used for deployment lead time. */
  mergeCommitSha?: string;
  webUrl?: string;
}

export interface InsightsDeployment {
  id: string;
  environment: string;
  sha: string;
  createdAt: string;
  /** Latest status. */
  state: 'success' | 'failure' | 'error' | 'pending' | 'inactive' | 'unknown';
  stateAt?: string;
}

export interface InsightsPrQuery {
  /** ISO time: PRs merged at or after this. */
  since: string;
  /** ISO time: PRs merged before this (default now). */
  until?: string;
  /** Sample cap (spec 14 §8: 2,000); `truncated` is set when more exist. */
  max: number;
  signal?: AbortSignal;
}

export interface ProviderInsights {
  mergedPullRequests(ref: RepoRef, q: InsightsPrQuery): Promise<{ items: InsightsPr[]; truncated: boolean }>;
  /** Deployments to `environment` created since `since` (newest first). Optional per provider. */
  deployments?(
    ref: RepoRef,
    q: { environment: string; since: string; max: number; signal?: AbortSignal },
  ): Promise<InsightsDeployment[]>;
}

export { createGitHubInsights, normalizeGitHubInsightsPr } from './github/insights';
export { createGitLabInsights } from './gitlab/insights';
