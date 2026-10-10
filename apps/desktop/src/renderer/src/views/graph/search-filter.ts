/**
 * Search "Filter graph" mode (spec 12 §4.7, spec 04 §4.12): the graph renders only matching rows, with
 * edges collapsed onto the nearest visible ancestors. Pure: builds a second GraphModel over the loaded
 * matches; row indices of the returned model are what the virtualized list shows.
 */
import { GraphModel } from '@githappens/graph';
import type { CommitSummary, Sha } from '@githappens/git/types';

/** Max collapsed parents kept per row (huge merges would otherwise fan out to every match). */
const MAX_PARENTS = 8;

/**
 * For every loaded commit, the nearest matching ancestors along each parent path (the "visible
 * parents" of a filtered row). Commits are in row order (children before parents).
 */
export function collapseParents(
  commits: readonly Pick<CommitSummary, 'sha' | 'parents'>[],
  isMatch: (sha: Sha) => boolean,
): Map<Sha, Sha[]> {
  const loaded = new Set(commits.map((c) => c.sha));
  // nearest matches reachable through (and including) each commit: [sha] when it matches
  const nearest = new Map<Sha, Sha[]>();
  const visible = new Map<Sha, Sha[]>();
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]!;
    const out: Sha[] = [];
    const seen = new Set<Sha>();
    for (const p of c.parents) {
      if (!loaded.has(p)) continue; // unloaded parents: the edge ends (more history may load later)
      for (const s of nearest.get(p) ?? []) {
        if (out.length >= MAX_PARENTS) break;
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
    if (isMatch(c.sha)) {
      visible.set(c.sha, out);
      nearest.set(c.sha, [c.sha]);
    } else nearest.set(c.sha, out);
  }
  return visible;
}

/**
 * A GraphModel of only the matching loaded commits, parents rewritten to their nearest visible
 * ancestors. Row items keep the commits' real `parents` (menus check merges), only the layout uses the
 * collapsed ones.
 */
export function filteredGraphModel(
  full: GraphModel<CommitSummary>,
  isMatch: (sha: Sha) => boolean,
): GraphModel<CommitSummary> {
  const commits = full.commits();
  const parents = collapseParents(commits, isMatch);
  const items: CommitSummary[] = [];
  for (const c of commits) {
    const p = parents.get(c.sha);
    if (p) items.push({ ...c, parents: p });
  }
  const head = full.headSha;
  const model = new GraphModel<CommitSummary>({ headSha: head && parents.has(head) ? head : null });
  model.append(items, true);
  // layout is done: restore the real parents on the row items
  const byId = new Map(commits.map((c) => [c.sha, c.parents]));
  for (const it of items) it.parents = byId.get(it.sha) ?? it.parents;
  return model;
}
