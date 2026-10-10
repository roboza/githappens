import { compareInGroup } from './query';
import type { ClassifiedItem, LaunchpadPr } from './types';

/**
 * Derived views of Launchpad items used outside the Launchpad tab: workspace PR counts
 * (spec 11 §4.1 "open PRs (mine / total)") and the Home view Focus column (§4.4). Pure.
 */

export interface OpenPrCounts {
  mine: number;
  total: number;
  needsMyReview: number;
}

const isMine = (i: LaunchpadPr): boolean => i.pr.viewer.isAuthor || i.involvement.includes('author');

/**
 * Open (incl. draft) PR counts per key. `keyOf` maps a PR item to a bucket (e.g. a workspace repo
 * id); items it maps to `undefined` are ignored. Items are deduped by uid first.
 */
export function countOpenPrs(
  items: readonly ClassifiedItem[],
  keyOf: (item: ClassifiedItem & LaunchpadPr) => string | undefined,
): Record<string, OpenPrCounts> {
  const out: Record<string, OpenPrCounts> = {};
  const seen = new Set<string>();
  for (const it of items) {
    if (it.type !== 'pr' || seen.has(it.uid)) continue;
    if (it.pr.state !== 'open' && it.pr.state !== 'draft') continue;
    const key = keyOf(it);
    if (key === undefined) continue;
    seen.add(it.uid);
    const c = (out[key] ??= { mine: 0, total: 0, needsMyReview: 0 });
    c.total++;
    if (isMine(it)) c.mine++;
    if (it.statusGroup === 'needs-review') c.needsMyReview++;
  }
  return out;
}

/** Sum of per-repo counts (workspace "N open PRs" chip). */
export function totalPrCounts(counts: Iterable<OpenPrCounts | undefined>): OpenPrCounts {
  const t: OpenPrCounts = { mine: 0, total: 0, needsMyReview: 0 };
  for (const c of counts) {
    if (!c) continue;
    t.mine += c.mine;
    t.total += c.total;
    t.needsMyReview += c.needsMyReview;
  }
  return t;
}

const NAMED_PRIORITY: Record<string, number> = {
  blocker: 0,
  critical: 0,
  urgent: 0,
  highest: 0,
  high: 1,
  major: 1,
  medium: 2,
  normal: 2,
  low: 3,
  minor: 3,
  lowest: 4,
  trivial: 4,
};

/**
 * Comparable priority rank (lower = more important) across trackers: Jira names, Azure 1–4,
 * GitLab/GitHub labels like "P1" / "priority::high". Unknown → 5.
 */
export function priorityRank(priority: string | undefined): number {
  if (!priority) return 5;
  const p = priority.trim().toLowerCase();
  const num = /^(?:p)?([0-4])$/.exec(p);
  if (num) return Math.min(4, Math.max(0, Number(num[1]) - (p.startsWith('p') ? 0 : 1)));
  const named = /(blocker|critical|urgent|highest|high|major|medium|normal|lowest|low|minor|trivial)/.exec(p);
  return named ? NAMED_PRIORITY[named[1]!]! : 5;
}

/**
 * Home "My issues" (§4.4): open issues assigned to the viewer (todo / in progress / current
 * branch / pinned), not snoozed, by priority then most recently updated.
 */
export function topIssues(items: readonly ClassifiedItem[], limit = 5): ClassifiedItem[] {
  return items
    .filter(
      (i) =>
        i.type === 'issue' &&
        i.group !== 'snoozed' &&
        i.issue.stateCategory !== 'done' &&
        (i.statusGroup === 'in-progress' ||
          i.statusGroup === 'todo' ||
          i.statusGroup === 'current-branch' ||
          i.group === 'pinned'),
    )
    .sort((a, b) => {
      if (a.type !== 'issue' || b.type !== 'issue') return 0;
      const pin = (b.group === 'pinned' ? 1 : 0) - (a.group === 'pinned' ? 1 : 0);
      return pin || priorityRank(a.issue.priority) - priorityRank(b.issue.priority) || compareInGroup(a, b);
    })
    .slice(0, limit);
}

/** Home "WIPs across recent repos" (§4.4): repos with uncommitted changes, most recently modified. */
export function recentWips(items: readonly ClassifiedItem[], limit = 5): ClassifiedItem[] {
  const at = (i: ClassifiedItem): number =>
    Date.parse(i.type === 'wip' ? (i.status.lastModified ?? i.updatedAt) : i.updatedAt) || 0;
  return items
    .filter((i) => i.type === 'wip' && i.group !== 'snoozed')
    .sort((a, b) => at(b) - at(a))
    .slice(0, limit);
}
