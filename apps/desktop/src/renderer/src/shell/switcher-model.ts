import type { RefInfo } from '@githappens/git/types';

import type { TabDescriptor } from '../../../shared/ipc/shell-contract';
import type { DropdownItem } from './FilterDropdown';
import { normPath, tabLabel } from './tab-model';

/** Pure item builders for the breadcrumb switchers (spec 01 §4.4); unit-tested. */

/** Pure: items for the repo switcher (open tabs, favorites, recents; deduplicated). Exported for tests. */
export function repoSwitcherItems(
  tabs: readonly TabDescriptor[],
  activeTabId: string | null,
  repos: readonly { path: string; name: string; alias?: string; favorite: boolean; missing?: boolean }[],
): DropdownItem[] {
  const out: DropdownItem[] = [];
  const seen = new Set<string>();
  for (const t of tabs) {
    if (t.kind !== 'repo' || !t.repoPath) continue;
    seen.add(normPath(t.repoPath));
    out.push({
      id: `tab:${t.id}`,
      label: tabLabel(t),
      detail: t.repoPath,
      group: 'Open tabs',
      current: t.id === activeTabId,
    });
  }
  for (const fav of [true, false]) {
    for (const r of repos) {
      if (r.favorite !== fav || r.missing || seen.has(normPath(r.path))) continue;
      seen.add(normPath(r.path));
      out.push({
        id: `path:${r.path}`,
        label: r.alias ?? r.name,
        detail: r.path,
        group: fav ? 'Favorites' : 'Recent',
      });
    }
  }
  return out;
}

/** Pure: items for the branch switcher (locals first, then remotes without a local twin). Exported for tests. */
export function branchSwitcherItems(refs: readonly RefInfo[]): DropdownItem[] {
  const locals = refs.filter((r) => r.type === 'local');
  const localNames = new Set(locals.map((r) => r.shortName));
  const remotes = refs.filter(
    (r) =>
      r.type === 'remote' &&
      !r.symrefTarget &&
      !r.shortName.endsWith('/HEAD') &&
      !localNames.has(r.shortName.split('/').slice(1).join('/')),
  );
  return [
    ...locals.map((r) => ({
      id: r.fullName,
      label: r.shortName,
      group: 'Local',
      current: r.isHead,
      detail: r.upstream
        ? `${r.upstream.ahead ? `↑${r.upstream.ahead} ` : ''}${r.upstream.behind ? `↓${r.upstream.behind}` : ''}`.trim() ||
          undefined
        : undefined,
    })),
    ...remotes.map((r) => ({ id: r.fullName, label: r.shortName, group: 'Remote' })),
  ];
}
