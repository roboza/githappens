import {
  GROUP_LABEL,
  type ClassifiedItem,
  type LaunchpadFilters,
  type LaunchpadGroup,
  type LaunchpadGrouped,
  type LaunchpadTab,
} from '@githappens/launchpad';

/** Pure Launchpad UI helpers (no React, no window) — unit-tested in test/launchpad-helpers.test.ts. */

export const TAB_ORDER: Array<{ id: LaunchpadTab; label: string }> = [
  { id: 'prs', label: 'Pull Requests' },
  { id: 'issues', label: 'Issues' },
  { id: 'wips', label: 'WIPs' },
  { id: 'all', label: 'All' },
  { id: 'snoozed', label: 'Snoozed' },
];

/** Stable key of the server-side part of the filters (text search is client-side). */
export function filtersKey(f: LaunchpadFilters): string {
  const sorted = (xs?: string[]) => (xs?.length ? [...xs].sort().join(',') : '');
  return [
    f.scope.kind === 'workspace' ? `ws:${f.scope.workspaceId}` : 'all',
    f.mode,
    sorted(f.providers),
    sorted(f.repos),
    sorted(f.labels),
    sorted(f.authors),
    sorted(f.milestones),
    sorted(f.sprints),
    sorted(f.fixVersions),
    f.updatedWithin ?? 'any',
  ].join('|');
}

export const serverFilters = (f: LaunchpadFilters): LaunchpadFilters => {
  const { text: _text, ...rest } = f;
  return rest;
};

/** Number of active (non-scope) filters, for the filter bar badge. */
export function activeFilterCount(f: LaunchpadFilters): number {
  return (
    [f.providers, f.repos, f.labels, f.authors, f.milestones, f.sprints, f.fixVersions].filter(
      (x) => x?.length,
    ).length + (f.updatedWithin && f.updatedWithin !== 'any' ? 1 : 0)
  );
}

export type ListRow =
  | { kind: 'header'; key: string; group: string; label: string; count: number; collapsed: boolean }
  | { kind: 'item'; key: string; item: ClassifiedItem; group: string };

/** Flatten grouped items into virtualized rows (collapsed groups contribute only their header). */
export function flattenGroups(groups: LaunchpadGrouped[], collapsed: ReadonlySet<string>): ListRow[] {
  const rows: ListRow[] = [];
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.group);
    rows.push({
      kind: 'header',
      key: `h:${g.group}`,
      group: g.group,
      label: g.label,
      count: g.items.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed)
      for (const it of g.items) rows.push({ kind: 'item', key: it.uid, item: it, group: g.group });
  }
  return rows;
}

/** Next selectable (item) row index moving by `delta` (±1); stays put at the ends. */
export function moveSelection(rows: ListRow[], current: number, delta: 1 | -1): number {
  let i = current;
  for (;;) {
    i += delta;
    if (i < 0 || i >= rows.length) return current >= 0 && current < rows.length ? current : firstItem(rows);
    if (rows[i]!.kind === 'item') return i;
  }
}

export function firstItem(rows: ListRow[]): number {
  return rows.findIndex((r) => r.kind === 'item');
}

/** Visible window for fixed-height virtualization. */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 8,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end };
}

export type GlyphTone = 'green' | 'yellow' | 'red' | 'grey' | 'purple' | 'blue';
export interface StatusGlyph {
  kind: 'review' | 'ci' | 'conflict' | 'draft' | 'no-reviewers';
  tone: GlyphTone;
  label: string;
}

/** PR status column glyphs (§4.2): review, CI and conflict state. */
export function prGlyphs(item: ClassifiedItem): StatusGlyph[] {
  if (item.type !== 'pr') return [];
  const pr = item.pr;
  const out: StatusGlyph[] = [];
  if (pr.state === 'draft') out.push({ kind: 'draft', tone: 'grey', label: 'Draft' });
  if (pr.reviewDecision === 'approved') out.push({ kind: 'review', tone: 'green', label: 'Approved' });
  else if (pr.reviewDecision === 'changes_requested')
    out.push({ kind: 'review', tone: 'red', label: 'Changes requested' });
  else if (item.flags.noReviewers) out.push({ kind: 'no-reviewers', tone: 'yellow', label: 'No reviewers' });
  else out.push({ kind: 'review', tone: 'grey', label: 'Review pending' });
  if (pr.checksRollup === 'success') out.push({ kind: 'ci', tone: 'green', label: 'Checks passed' });
  else if (pr.checksRollup === 'failure') out.push({ kind: 'ci', tone: 'red', label: 'Checks failing' });
  else if (pr.checksRollup === 'pending') out.push({ kind: 'ci', tone: 'yellow', label: 'Checks running' });
  if (pr.mergeable === 'conflicting') out.push({ kind: 'conflict', tone: 'red', label: 'Merge conflicts' });
  return out;
}

/** Merge is offered only from Ready to merge (§4.2), to viewers allowed to merge. */
export const canMergeFromLaunchpad = (item: ClassifiedItem): boolean =>
  item.type === 'pr' &&
  item.statusGroup === 'ready-to-merge' &&
  item.pr.state === 'open' &&
  item.pr.viewer.canMerge &&
  item.pr.allowedMergeMethods.length > 0;

/** "3 files changed" style WIP summary. */
export function wipLabel(s: {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}): string {
  const n = s.staged + s.unstaged + s.untracked + s.conflicted;
  const parts = [`${n} file${n === 1 ? '' : 's'} changed`];
  if (s.conflicted) parts.push(`${s.conflicted} conflicted`);
  return parts.join(' · ');
}

/** Short "2m ago" style label for timestamps (ms or ISO). */
export function ago(at: number | string | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return 'never';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Status-bar counter config (§4.3): at most three counters. */
export const STATUS_COUNTERS: Array<{
  key: 'needsReview' | 'readyToMerge' | 'blocked';
  group: LaunchpadGroup;
  label: string;
}> = [
  { key: 'needsReview', group: 'needs-review', label: 'review' },
  { key: 'readyToMerge', group: 'ready-to-merge', label: 'mergeable' },
  { key: 'blocked', group: 'blocked', label: 'blocked' },
];

export const groupLabel = (g: LaunchpadGroup): string => GROUP_LABEL[g];

/** Whether the status-bar indicator shows, per `launchpad.statusBar` (§4.3). */
export function showStatusIndicator(
  mode: 'auto' | 'always' | 'never' | undefined,
  s: { needsReview: number; readyToMerge: number; blocked: number; hasIntegrations: boolean } | undefined,
): boolean {
  if (mode === 'never' || !s || !s.hasIntegrations) return false;
  if (mode === 'always') return true;
  return s.needsReview + s.readyToMerge + s.blocked > 0;
}
