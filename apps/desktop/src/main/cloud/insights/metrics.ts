/**
 * Pure Insights calculators (spec 14 §6.6). Inputs are normalized provider PRs and deployment events;
 * outputs are the `InsightsResult` metric blocks. No I/O — unit-tested with fixed fixtures.
 */
import type { InsightsPr } from '@githappens/providers';

import type { DoraMetrics, Percentiles } from '../../../shared/ipc/insights-contract';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Nearest-rank percentile on a copy (0 for an empty list). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** Median with interpolation for even counts. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/** ISO-8601 week label (`2026-W40`) of a time. */
export function isoWeek(t: number | string): string {
  const d = new Date(typeof t === 'string' ? Date.parse(t) : t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * DAY));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Consecutive ISO weeks covering [since, until]. */
export function weeksBetween(since: number, until: number): string[] {
  const out: string[] = [];
  for (let t = since; t <= until + 6 * DAY; t += 7 * DAY) {
    const w = isoWeek(Math.min(t, until));
    if (!out.includes(w)) out.push(w);
  }
  const last = isoWeek(until);
  if (!out.includes(last)) out.push(last);
  return out;
}

export function rangeBounds(range: '7d' | '30d' | '90d', now: number): { since: number; until: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return { since: now - days * DAY, until: now };
}

/** Cycle time: merged − created (or ready-for-review for drafts), hours. */
export function cycleTimeHrs(pr: InsightsPr): number | undefined {
  if (!pr.mergedAt) return undefined;
  const start = Date.parse(pr.readyAt ?? pr.createdAt);
  const end = Date.parse(pr.mergedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return (end - start) / HOUR;
}

/** First non-author review − created (ready-for-review for drafts), hours. */
export function firstReviewHrs(pr: InsightsPr): number | undefined {
  const first = pr.reviews.find((r) => r.login !== pr.author);
  if (!first) return undefined;
  const start = Date.parse(pr.readyAt ?? pr.createdAt);
  const at = Date.parse(first.at);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return undefined;
  return Math.max(0, (at - start) / HOUR);
}

export const SIZE_BUCKETS: Array<{ label: string; max: number }> = [
  { label: 'XS (≤10)', max: 10 },
  { label: 'S (≤50)', max: 50 },
  { label: 'M (≤250)', max: 250 },
  { label: 'L (≤1000)', max: 1000 },
  { label: 'XL (>1000)', max: Infinity },
];

export interface PrMetrics {
  prCycleTimeHrs: Percentiles;
  timeToFirstReviewHrs: Percentiles;
  mergedPerWeek: Array<{ week: string; count: number }>;
  cycleTimeTrend: Array<{ week: string; medianHrs: number | null }>;
  prSize: { p50: number; p90: number; buckets: Array<{ label: string; count: number }> };
  reviewLoad: Array<{ reviewer: string; count: number }>;
  sampleSize: number;
  authors: string[];
}

/** PR metrics over PRs merged in [since, until], optionally filtered by author logins. */
export function computePrMetrics(
  prs: InsightsPr[],
  o: { since: number; until: number; authors?: string[] },
): PrMetrics {
  const authorFilter = o.authors?.length ? new Set(o.authors.map((a) => a.toLowerCase())) : null;
  const allAuthors = new Set<string>();
  const merged = prs.filter((p) => {
    if (!p.mergedAt) return false;
    const t = Date.parse(p.mergedAt);
    if (!(t >= o.since && t <= o.until)) return false;
    allAuthors.add(p.author);
    return !authorFilter || authorFilter.has(p.author.toLowerCase());
  });
  const cycles = merged.map(cycleTimeHrs).filter((v): v is number => v !== undefined);
  const reviews = merged.map(firstReviewHrs).filter((v): v is number => v !== undefined);
  const weeks = weeksBetween(o.since, o.until);
  const perWeek = new Map(weeks.map((w) => [w, [] as number[]]));
  const counts = new Map(weeks.map((w) => [w, 0]));
  for (const p of merged) {
    const w = isoWeek(p.mergedAt!);
    if (!counts.has(w)) continue;
    counts.set(w, counts.get(w)! + 1);
    const c = cycleTimeHrs(p);
    if (c !== undefined) perWeek.get(w)!.push(c);
  }
  const sizes = merged.map((p) => p.additions + p.deletions);
  const buckets = SIZE_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const s of sizes) buckets[SIZE_BUCKETS.findIndex((b) => s <= b.max)]!.count++;
  const load = new Map<string, number>();
  for (const p of merged) {
    // one review per reviewer per PR (spec: "reviews per reviewer")
    for (const login of new Set(p.reviews.filter((r) => r.login !== p.author).map((r) => r.login))) {
      load.set(login, (load.get(login) ?? 0) + 1);
    }
  }
  return {
    prCycleTimeHrs: { median: round(median(cycles)), p75: round(percentile(cycles, 75)) },
    timeToFirstReviewHrs: { median: round(median(reviews)), p75: round(percentile(reviews, 75)) },
    mergedPerWeek: weeks.map((week) => ({ week, count: counts.get(week)! })),
    cycleTimeTrend: weeks.map((week) => {
      const v = perWeek.get(week)!;
      return { week, medianHrs: v.length ? round(median(v)) : null };
    }),
    prSize: { p50: percentile(sizes, 50), p90: percentile(sizes, 90), buckets },
    reviewLoad: [...load.entries()]
      .map(([reviewer, count]) => ({ reviewer, count }))
      .sort((a, b) => b.count - a.count || a.reviewer.localeCompare(b.reviewer)),
    sampleSize: merged.length,
    authors: [...allAuthors].sort((a, b) => a.localeCompare(b)),
  };
}

/** A deployment as seen by the DORA calculator. */
export interface DeployEvent {
  at: number;
  /** Failed deployment (status failure/error) or followed by a revert/hotfix within 24 h. */
  failed: boolean;
}

/**
 * DORA metrics from deployments in [since, until] and lead times (hours). MTTR = failed deploy → next
 * successful deploy (median).
 */
export function computeDora(
  deploys: DeployEvent[],
  leadTimesHrs: number[],
  o: { since: number; until: number; signal: DoraMetrics['signal'] },
): DoraMetrics {
  const inRange = deploys.filter((d) => d.at >= o.since && d.at <= o.until).sort((a, b) => a.at - b.at);
  const weeks = Math.max(1, (o.until - o.since) / (7 * DAY));
  const failures = inRange.filter((d) => d.failed);
  const recoveries: number[] = [];
  const all = [...deploys].sort((a, b) => a.at - b.at);
  for (const f of failures) {
    const next = all.find((d) => d.at > f.at && !d.failed);
    if (next) recoveries.push((next.at - f.at) / HOUR);
  }
  return {
    deploymentsPerWeek: round(inRange.length / weeks, 2),
    leadTimeHrs: round(median(leadTimesHrs)),
    changeFailureRate: inRange.length ? round(failures.length / inRange.length, 3) : 0,
    mttrHrs: round(median(recoveries)),
    deployments: inRange.length,
    signal: o.signal,
  };
}

/** `v*` / `release-*` style glob → RegExp (only `*` and `?` are special). */
export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export const HOTFIX_RE = /^(Revert\b|hotfix\b|\[hotfix\]|fix\(hotfix\))/i;

export interface TagDeploy {
  name: string;
  at: number;
  /** Commits released by this tag (prev tag..tag): commit time + subject. */
  commits: Array<{ at: number; subject: string }>;
}

/**
 * Tag-based deployments: lead time = tag time − commit time of each released commit; a deployment
 * failed when the NEXT deployment ships a revert/hotfix committed within 24 h after it.
 */
export function tagDeployEvents(tags: TagDeploy[]): { events: DeployEvent[]; leadTimesHrs: number[] } {
  const sorted = [...tags].sort((a, b) => a.at - b.at);
  const leadTimesHrs: number[] = [];
  const events: DeployEvent[] = sorted.map((t, i) => {
    for (const c of t.commits) if (t.at >= c.at) leadTimesHrs.push((t.at - c.at) / HOUR);
    const next = sorted[i + 1];
    const failed =
      !!next && next.commits.some((c) => HOTFIX_RE.test(c.subject) && c.at >= t.at && c.at - t.at <= DAY);
    return { at: t.at, failed };
  });
  return { events, leadTimesHrs };
}

/** Lead time for API deployments: merged PR → first successful deployment after its merge. */
export function mergeToDeployLeadTimes(prs: InsightsPr[], deploys: DeployEvent[]): number[] {
  const ok = deploys.filter((d) => !d.failed).sort((a, b) => a.at - b.at);
  const out: number[] = [];
  for (const p of prs) {
    if (!p.mergedAt) continue;
    const m = Date.parse(p.mergedAt);
    const d = ok.find((x) => x.at >= m);
    if (d) out.push((d.at - m) / HOUR);
  }
  return out;
}
