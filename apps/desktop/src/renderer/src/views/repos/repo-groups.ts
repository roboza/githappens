import type { RepoGroup } from '../../../../shared/ipc/repos2-contract';
import type { RepoRecord } from '../../../../shared/ipc/shell-contract';

/**
 * Pure model of the Repository Management list (spec 03 §4.1): Open / Favorites / Recent / custom groups,
 * filtered by the search box. DOM-free for unit tests.
 */

export interface GroupView {
  group: RepoGroup;
  repos: RepoRecord[];
}

/** Palette for group colours (spec 03 §4.3 "palette of 8"); rendered as `var(--kl-<name>)`. */
export const GROUP_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'teal', 'pink'] as const;

export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Subsequence match over alias, name, path and remote (case-insensitive). */
export function matchesFilter(r: RepoRecord, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  const hay = `${r.alias ?? ''} ${r.name} ${r.path} ${r.remoteUrl ?? ''}`.toLowerCase();
  if (hay.includes(q)) return true;
  let i = 0;
  for (const ch of hay) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/** owner/repo from a remote URL (`git@github.com:o/r.git`, `https://h/o/r`). */
export function remoteLabel(url: string | undefined): string {
  if (!url) return '';
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : url;
}

export function buildGroupViews(
  repos: RepoRecord[],
  groups: RepoGroup[],
  openPaths: string[],
  filter: string,
): GroupView[] {
  const open = new Set(openPaths.map(normPath));
  const visible = repos.filter((r) => matchesFilter(r, filter));
  const recency = (a: RepoRecord, b: RepoRecord): number => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
  return [...groups]
    .sort((a, b) => a.order - b.order)
    .map((group) => {
      let list: RepoRecord[];
      switch (group.kind) {
        case 'open':
          list = visible.filter((r) => open.has(normPath(r.path))).sort(recency);
          break;
        case 'favorites':
          list = visible
            .filter((r) => r.favorite)
            .sort((a, b) => (a.favoriteOrder ?? 0) - (b.favoriteOrder ?? 0));
          break;
        case 'recent':
          list = [...visible].sort(recency);
          break;
        default:
          list = visible.filter((r) => (r.groupIds ?? []).includes(group.id)).sort(recency);
      }
      return { group, repos: list };
    });
}

/** Move `id` to `toIndex` and renumber `order`. */
export function moveGroup(groups: RepoGroup[], id: string, toIndex: number): RepoGroup[] {
  const sorted = [...groups].sort((a, b) => a.order - b.order);
  const from = sorted.findIndex((g) => g.id === id);
  if (from < 0) return groups;
  const [g] = sorted.splice(from, 1);
  sorted.splice(Math.max(0, Math.min(toIndex, sorted.length)), 0, g!);
  return sorted.map((x, i) => ({ ...x, order: i }));
}

/** Favorite paths after dragging `path` onto the position of `beforePath` (null = end). */
export function reorderedFavorites(favorites: string[], path: string, beforePath: string | null): string[] {
  const rest = favorites.filter((p) => normPath(p) !== normPath(path));
  const i = beforePath === null ? -1 : rest.findIndex((p) => normPath(p) === normPath(beforePath));
  if (i < 0) return [...rest, path];
  return [...rest.slice(0, i), path, ...rest.slice(i)];
}
