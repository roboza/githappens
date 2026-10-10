import type { TabDescriptor } from '../../../shared/ipc/shell-contract';

/**
 * Pure tab-bar helpers (spec 01 §4.2): labels, worktree grouping, close targets and overflow.
 * DOM-free; unit-tested in node.
 */

const baseName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function tabLabel(t: TabDescriptor): string {
  if (t.kind === 'repo') return t.alias?.trim() || baseName(t.repoPath ?? 'Repository');
  if (t.kind === 'launchpad') return 'Launchpad';
  if (t.kind === 'workspace') return t.alias?.trim() || 'Workspace';
  return 'New Tab';
}

/** Repository identity shared by a repo and its worktrees: the common git dir. */
export function worktreeGroupKey(t: TabDescriptor): string | null {
  if (t.kind !== 'repo' || !t.repoPath) return null;
  return normPath(t.worktreeOf ?? `${t.repoPath}/.git`);
}

export type GroupPosition = 'first' | 'middle' | 'last';

export interface TabView {
  tab: TabDescriptor;
  /** Set when the tab belongs to a worktree group of two or more tabs. */
  group?: { key: string; position: GroupPosition; size: number };
}

/**
 * Display order: with grouping on, tabs of the same repository (main worktree + linked worktrees) are
 * pulled next to the group's first tab, keeping relative order otherwise (spec 01 §4.2, 12.4 behavior).
 */
export function arrangeTabs(tabs: readonly TabDescriptor[], groupWorktrees: boolean): TabView[] {
  const keys = tabs.map(worktreeGroupKey);
  const counts = new Map<string, number>();
  for (const k of keys) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  if (!groupWorktrees) return tabs.map((tab) => ({ tab }));
  const out: TabView[] = [];
  const placed = new Set<string>();
  tabs.forEach((tab, i) => {
    const k = keys[i];
    const size = k ? (counts.get(k) ?? 0) : 0;
    if (!k || size < 2) {
      out.push({ tab });
      return;
    }
    if (placed.has(k)) return;
    placed.add(k);
    const members = tabs.filter((_, j) => keys[j] === k);
    members.forEach((m, j) =>
      out.push({
        tab: m,
        group: { key: k, size, position: j === 0 ? 'first' : j === members.length - 1 ? 'last' : 'middle' },
      }),
    );
  });
  return out;
}

const closable = (t: TabDescriptor): boolean => t.kind !== 'launchpad';

/** Tabs closed by "Close other tabs" / "Close tabs to the right" (display order for "right"). */
export function closeTargets(tabs: readonly TabDescriptor[], id: string, mode: 'others' | 'right'): string[] {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return [];
  if (mode === 'others') return tabs.filter((t) => t.id !== id && closable(t)).map((t) => t.id);
  return tabs
    .slice(i + 1)
    .filter(closable)
    .map((t) => t.id);
}

/** Ids of tabs not fully inside the visible strip (for the overflow dropdown). */
export function hiddenTabIds(
  items: readonly { id: string; left: number; right: number }[],
  viewport: { left: number; right: number },
): string[] {
  return items.filter((r) => r.left < viewport.left - 1 || r.right > viewport.right + 1).map((r) => r.id);
}

/** Next focus zone index for F6 / Shift+F6 cycling (-1 = nothing focused yet). */
export function nextZoneIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}
