import { ProviderError } from '../http';
import type { CheckRun, CheckStatus, IntegrationId, PrRollupStatus, PullRequest } from '../types';

/**
 * Small helpers shared by the Bitbucket / Azure DevOps / Jira clients (spec 10 §5.3).
 * Kept inside this folder so the files stay within the Phase 4 ownership split; they can be
 * hoisted to a common `src/util.ts` later without behavior changes.
 */

/** Auth descriptor for one integration kind (consumed by AuthService / connect UI). */
export interface AuthDescriptor {
  kind: IntegrationId['kind'];
  /** Default host for the cloud flavour ('' for self-hosted kinds). */
  defaultHost: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes: string[];
  /** Page where the user creates a PAT / API token / HTTP access token. */
  patPageUrl(host: string): string;
  /** Username to give git's askpass for HTTPS. '{username}' = the account's login. */
  usernameForGit: string;
  apiBaseUrl(host: string): string;
  /** Authorization header value. `username` switches to Basic where the provider uses it. */
  authHeader(token: string, username?: string): string;
}

export const basicAuth = (user: string, pass: string): string => {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Normalizes provider timestamps (epoch ms, Jira '+0000' offsets, ISO) to ISO-8601. */
export const toIso = (v: string | number | null | undefined): string | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

export const unsupported = (message: string): ProviderError =>
  new ProviderError({ code: 'unsupported', message });

export const integrationFor = (
  kind: IntegrationId['kind'],
  host: string,
  integration?: IntegrationId,
): IntegrationId => integration ?? { kind, host, accountId: '' };

/** Aggregates checks into a rollup (failure > pending > success; none when empty). */
export function checksRollupOf(checks: Array<Pick<CheckRun, 'status'>>): PrRollupStatus {
  if (checks.length === 0) return 'none';
  const failing: CheckStatus[] = ['failure', 'timed_out', 'action_required', 'cancelled'];
  if (checks.some((c) => failing.includes(c.status))) return 'failure';
  if (checks.some((c) => c.status === 'queued' || c.status === 'in_progress')) return 'pending';
  return 'success';
}

/** Spec 10 §4.5 status icon rules. */
export function prRollupOf(
  pr: Pick<PullRequest, 'checksRollup' | 'reviewDecision' | 'mergeable'>,
): PrRollupStatus {
  if (
    pr.checksRollup === 'failure' ||
    pr.reviewDecision === 'changes_requested' ||
    pr.mergeable === 'conflicting'
  )
    return 'failure';
  const checksOk = pr.checksRollup === 'success' || pr.checksRollup === 'none';
  const reviewOk = pr.reviewDecision === 'approved' || !pr.reviewDecision;
  return checksOk && reviewOk ? 'success' : 'pending';
}

export const stripHeads = (ref: string | undefined): string => (ref ?? '').replace(/^refs\/heads\//, '');

export const enc = encodeURIComponent;
