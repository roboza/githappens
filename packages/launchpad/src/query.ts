import { GROUP_LABEL, groupPriority } from './classify';
import type {
  ClassifiedItem,
  LaunchpadFilters,
  LaunchpadGroup,
  LaunchpadGroupBy,
  LaunchpadGrouped,
  LaunchpadItem,
  LaunchpadSummary,
  LaunchpadTab,
} from './types';

// ---------------------------------------------------------------------------------------------
// Search (§4.2 SearchInput): `#123` and `ABC-12` match exactly; anything else is a fuzzy match
// over title, number, repo, branch and author.
// ---------------------------------------------------------------------------------------------

export type ParsedSearch =
  | { kind: 'empty' }
  | { kind: 'number'; n: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; tokens: string[] };

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function parseSearch(text: string | undefined): ParsedSearch {
  const t = (text ?? '').trim();
  if (!t) return { kind: 'empty' };
  const num = /^#(\d+)$/.exec(t);
  if (num) return { kind: 'number', n: Number(num[1]) };
  if (KEY_RE.test(t)) return { kind: 'key', key: t.toUpperCase() };
  return { kind: 'text', tokens: t.toLowerCase().split(/\s+/).filter(Boolean) };
}

/** Subsequence match where the first character starts a word (keeps short queries precise). */
export function fuzzyIncludes(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return true;
  if (h.includes(n)) return true;
  if (n.length < 3) return false;
  for (let start = 0; start < h.length; start++) {
    if (h[start] !== n[0] || (start > 0 && /[a-z0-9]/.test(h[start - 1]!))) continue;
    let j = 1;
    for (let i = start + 1; i < h.length && j < n.length; i++) if (h[i] === n[j]) j++;
    if (j === n.length) return true;
  }
  return false;
}

function searchFields(item: LaunchpadItem): string[] {
  const out = [item.title, item.repo?.fullName ?? ''];
  if (item.type === 'pr') {
    const pr = item.pr;
    out.push(`#${pr.number}`, pr.head.branch, pr.base.branch, pr.author.login, pr.author.name ?? '');
  } else if (item.type === 'issue') {
    const i = item.issue;
    out.push(i.key, i.reporter?.login ?? '', ...i.assignees.map((a) => a.login));
  } else {
    out.push(item.status.name, item.status.branch ?? '', item.status.path);
  }
  return out.filter(Boolean);
}

export function matchesSearch(item: LaunchpadItem, search: ParsedSearch | string | undefined): boolean {
  const q = typeof search === 'object' ? search : parseSearch(search);
  switch (q.kind) {
    case 'empty':
      return true;
    case 'number':
      if (item.type === 'pr') return item.pr.number === q.n;
      if (item.type === 'issue') return item.issue.key === `#${q.n}` || item.issue.key === String(q.n);
      return false;
    case 'key': {
      if (item.type === 'issue') return item.issue.key.toUpperCase() === q.key;
      if (item.type === 'pr')
        return (
          item.pr.head.branch.toUpperCase().includes(q.key) || item.pr.title.toUpperCase().includes(q.key)
        );
      return false;
    }
    case 'text': {
      const fields = searchFields(item);
      return q.tokens.every((tok) => fields.some((f) => fuzzyIncludes(f, tok)));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Filters (§5.2 LaunchpadFilters) and view tabs.
// ---------------------------------------------------------------------------------------------

const WITHIN_MS: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

const lcSet = (xs: string[] | undefined): Set<string> | null =>
  xs && xs.length ? new Set(xs.map((x) => x.toLowerCase())) : null;
const anyIn = (set: Set<string>, values: Array<string | undefined>): boolean =>
  values.some((v) => !!v && set.has(v.toLowerCase()));

export function providerOf(item: LaunchpadItem): string | undefined {
  return item.repo?.provider ?? item.integrationKey?.split(':')[0];
}

/** Whether an item is shown on a tab (snoozed items only appear on the Snoozed tab). */
export function inTab(item: ClassifiedItem, tab: LaunchpadTab): boolean {
  if (tab === 'snoozed') return item.group === 'snoozed';
  if (item.group === 'snoozed') return false;
  if (tab === 'all') return true;
  return tab === 'prs' ? item.type === 'pr' : tab === 'issues' ? item.type === 'issue' : item.type === 'wip';
}

/** Apply every filter except scope/mode (the service resolves those when fetching). */
export function matchesFilters(item: LaunchpadItem, f: Partial<LaunchpadFilters>, now: number): boolean {
  const providers = lcSet(f.providers);
  if (providers && !anyIn(providers, [providerOf(item), item.integrationKey])) return false;
  const repos = lcSet(f.repos);
  if (repos && !anyIn(repos, [item.repo?.fullName, item.repo?.localPath])) return false;

  const pr = item.type === 'pr' ? item.pr : undefined;
  const issue = item.type === 'issue' ? item.issue : undefined;

  const labels = lcSet(f.labels);
  if (labels && !anyIn(labels, pr ? pr.labels.map((l) => l.name) : (issue?.labels ?? []))) return false;
  const authors = lcSet(f.authors);
  if (
    authors &&
    !anyIn(
      authors,
      pr
        ? [pr.author.login, pr.author.name]
        : issue
          ? [issue.reporter?.login, issue.reporter?.name, ...issue.assignees.map((a) => a.login)]
          : [],
    )
  )
    return false;
  const milestones = lcSet(f.milestones);
  if (milestones && !anyIn(milestones, [pr?.milestone?.title, issue?.milestone])) return false;
  const sprints = lcSet(f.sprints);
  if (sprints && !anyIn(sprints, [issue?.sprint])) return false;
  const fixVersions = lcSet(f.fixVersions);
  if (fixVersions && !anyIn(fixVersions, issue?.fixVersions ?? [])) return false;

  if (f.updatedWithin && f.updatedWithin !== 'any') {
    const updated = Date.parse(item.updatedAt);
    if (Number.isNaN(updated) || now - updated > WITHIN_MS[f.updatedWithin]!) return false;
  }
  return matchesSearch(item, f.text);
}

export function filterItems(
  items: readonly ClassifiedItem[],
  filters: Partial<LaunchpadFilters>,
  tab: LaunchpadTab,
  now: number,
): ClassifiedItem[] {
  const search = parseSearch(filters.text);
  const f = { ...filters, text: undefined };
  return items.filter((i) => inTab(i, tab) && matchesFilters(i, f, now) && matchesSearch(i, search));
}

/** Item counts per tab (header badges). */
export function tabCounts(items: readonly ClassifiedItem[]): Record<LaunchpadTab, number> {
  const c: Record<LaunchpadTab, number> = { prs: 0, issues: 0, wips: 0, all: 0, snoozed: 0 };
  for (const i of items) {
    if (i.group === 'snoozed') {
      c.snoozed++;
      continue;
    }
    c.all++;
    if (i.type === 'pr') c.prs++;
    else if (i.type === 'issue') c.issues++;
    else c.wips++;
  }
  return c;
}

/** Facet values present in the items (filter dropdown options). */
export function facets(items: readonly LaunchpadItem[]): {
  providers: string[];
  repos: string[];
  labels: string[];
  authors: string[];
  milestones: string[];
} {
  const sets = {
    providers: new Set<string>(),
    repos: new Set<string>(),
    labels: new Set<string>(),
    authors: new Set<string>(),
    milestones: new Set<string>(),
  };
  for (const i of items) {
    const p = providerOf(i);
    if (p) sets.providers.add(p);
    if (i.repo?.fullName) sets.repos.add(i.repo.fullName);
    if (i.type === 'pr') {
      i.pr.labels.forEach((l) => sets.labels.add(l.name));
      sets.authors.add(i.pr.author.login);
      if (i.pr.milestone) sets.milestones.add(i.pr.milestone.title);
    } else if (i.type === 'issue') {
      i.issue.labels.forEach((l) => sets.labels.add(l));
      if (i.issue.reporter) sets.authors.add(i.issue.reporter.login);
      if (i.issue.milestone) sets.milestones.add(i.issue.milestone);
      if (i.issue.sprint) sets.milestones.add(i.issue.sprint);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    providers: sorted(sets.providers),
    repos: sorted(sets.repos),
    labels: sorted(sets.labels),
    authors: sorted(sets.authors),
    milestones: sorted(sets.milestones),
  };
}

// ---------------------------------------------------------------------------------------------
// Sorting & grouping (§5.3 "Within groups").
// ---------------------------------------------------------------------------------------------

const ms = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const recency = (i: ClassifiedItem): number =>
  i.type === 'wip' ? ms(i.status.lastModified ?? i.updatedAt) : ms(i.updatedAt);

/** Sort comparator within a group: pinned by `pinnedAt` desc, snoozed by `snoozedAt` desc, else updated desc. */
export function compareInGroup(a: ClassifiedItem, b: ClassifiedItem): number {
  if (a.group === 'pinned' && b.group === 'pinned') return ms(b.pinnedAt) - ms(a.pinnedAt);
  if (a.group === 'snoozed' && b.group === 'snoozed')
    return ms(b.snoozed?.snoozedAt) - ms(a.snoozed?.snoozedAt);
  return recency(b) - recency(a) || a.uid.localeCompare(b.uid);
}

/** Full sort: group priority, then within-group order. */
export function sortItems(items: readonly ClassifiedItem[]): ClassifiedItem[] {
  return [...items].sort((a, b) => groupPriority(a.group) - groupPriority(b.group) || compareInGroup(a, b));
}

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'bitbucket-dc': 'Bitbucket Data Center',
  'azure-devops': 'Azure DevOps',
  'azure-boards': 'Azure Boards',
  'jira-cloud': 'Jira',
  'jira-dc': 'Jira Data Center',
  trello: 'Trello',
};

/** Group items for display; empty groups are omitted (§4.2 "Empty group → hidden"). */
export function groupItems(
  items: readonly ClassifiedItem[],
  groupBy: LaunchpadGroupBy = 'status',
): LaunchpadGrouped[] {
  const buckets = new Map<string, { label: string; priority: number; items: ClassifiedItem[] }>();
  const add = (key: string, label: string, priority: number, item: ClassifiedItem): void => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { label, priority, items: [] }));
    b.items.push(item);
  };
  for (const it of items) {
    if (groupBy === 'status' || it.group === 'pinned' || it.group === 'snoozed') {
      add(it.group, GROUP_LABEL[it.group], groupPriority(it.group), it);
    } else if (groupBy === 'repo') {
      const name = it.repo?.fullName ?? (it.type === 'wip' ? it.status.name : 'No repository');
      add(`repo:${name.toLowerCase()}`, name, 100, it);
    } else if (groupBy === 'provider') {
      const p = it.type === 'wip' ? 'local' : (providerOf(it) ?? 'other');
      add(`provider:${p}`, p === 'local' ? 'Local' : (PROVIDER_LABEL[p] ?? p), 100, it);
    } else add('all', 'All items', 100, it);
  }
  return [...buckets.entries()]
    .map(([group, b]) => ({
      group,
      label: b.label,
      priority: b.priority,
      items: b.items.sort(compareInGroup),
    }))
    .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------------------------
// Summary (§4.3 status bar, `launchpad:summary`).
// ---------------------------------------------------------------------------------------------

export function summarize(items: readonly ClassifiedItem[], partial = false): LaunchpadSummary {
  const s: LaunchpadSummary = { needsReview: 0, readyToMerge: 0, blocked: 0, noReviewers: 0, conflicts: 0 };
  for (const i of items) {
    if (i.type !== 'pr' || i.group === 'snoozed') continue;
    if (i.statusGroup === 'needs-review') s.needsReview++;
    else if (i.statusGroup === 'ready-to-merge') s.readyToMerge++;
    else if (i.statusGroup === 'blocked') {
      s.blocked++;
      if (i.flags.conflicts) s.conflicts++;
    } else if (i.statusGroup === 'waiting-for-review' && i.flags.noReviewers) s.noReviewers++;
  }
  if (partial) s.partial = true;
  return s;
}

/** Top actionable PRs/issues for tooltips and the compact Launchpad (group priority, then recency). */
export function topItems(
  items: readonly ClassifiedItem[],
  limit = 5,
  groups: LaunchpadGroup[] = ['needs-review', 'blocked', 'ready-to-merge'],
): ClassifiedItem[] {
  return sortItems(items.filter((i) => i.group !== 'snoozed' && groups.includes(i.statusGroup))).slice(
    0,
    limit,
  );
}

/** Items of the given status groups, max `perGroup` each (Home view Focus column). */
export function compactGroups(
  items: readonly ClassifiedItem[],
  groups: LaunchpadGroup[] = ['needs-review', 'ready-to-merge', 'blocked'],
  perGroup = 5,
): Array<{ group: LaunchpadGroup; label: string; items: ClassifiedItem[]; total: number }> {
  return groups.map((g) => {
    const all = items.filter((i) => i.group !== 'snoozed' && i.statusGroup === g).sort(compareInGroup);
    return { group: g, label: GROUP_LABEL[g], items: all.slice(0, perGroup), total: all.length };
  });
}
