import { integrationKey, type Issue, type PullRequest } from '@githappens/providers/types';

import type { Involvement, LaunchpadItem } from './types';

/** Normalized local path: forward slashes, no trailing slash, case-folded for Windows paths. */
export function normalizePath(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(s) || p.includes('\\') ? s.toLowerCase() : s;
}

export const samePath = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && normalizePath(a) === normalizePath(b);

/** Key identifying a provider repository across integrations: `${integrationKey}|owner/name`. */
export const repoKey = (integration: string, owner: string, name: string): string =>
  `${integration}|${owner}/${name}`.toLowerCase();

export const prUid = (pr: PullRequest): string =>
  `pr:${integrationKey(pr.repo.integration)}:${pr.repo.owner}/${pr.repo.name}:${pr.number}`;

export const issueUid = (issue: Issue): string =>
  `issue:${integrationKey(issue.tracker.integration)}:${issue.tracker.scope}:${issue.key}`;

export const wipUid = (path: string): string => `wip:${normalizePath(path)}`;

const INVOLVEMENT_ORDER: Involvement[] = [
  'author',
  'creator',
  'assignee',
  'review-requested',
  'reviewer',
  'mentioned',
];

export function mergeInvolvement(a: readonly Involvement[], b: readonly Involvement[]): Involvement[] {
  const set = new Set([...a, ...b]);
  return INVOLVEMENT_ORDER.filter((i) => set.has(i));
}

/**
 * Dedupe by uid (spec 11 §6.4 step 2). Later duplicates merge their involvement into the first
 * occurrence; the most recently updated payload wins.
 */
export function dedupeItems<T extends LaunchpadItem>(items: Iterable<T>): T[] {
  const byUid = new Map<string, T>();
  for (const it of items) {
    const cur = byUid.get(it.uid);
    if (!cur) {
      byUid.set(it.uid, it);
      continue;
    }
    const newer = Date.parse(it.updatedAt) > Date.parse(cur.updatedAt) ? it : cur;
    byUid.set(it.uid, { ...newer, involvement: mergeInvolvement(cur.involvement, it.involvement) });
  }
  return [...byUid.values()];
}
