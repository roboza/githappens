import fs from 'node:fs';

import {
  DEFAULT_COLUMN_WIDTHS,
  type RepoColumnWidths,
  type RepoGroup,
  type RepoRegistryState,
} from '../../shared/ipc/repos2-contract';
import type { RepoRecord } from '../../shared/ipc/shell-contract';
import { readJson, writeFileAtomic } from '../settings/atomic-file';
import { canonicalKey, type RealpathFn } from './canonical-path';

/** Recent + favorite repositories, per profile (spec 03 §5 `RepoRegistryFile`). */
interface RepoRegistryFile {
  version: 1;
  repos: RepoRecord[];
  groups?: RepoGroup[];
  columnWidths?: RepoColumnWidths;
}

/** Built-in groups (spec 03 §4.1); custom groups follow. */
export const BUILTIN_GROUPS: RepoGroup[] = [
  { id: 'open', kind: 'open', name: 'Open', collapsed: false, order: 0 },
  { id: 'favorites', kind: 'favorites', name: 'Favorites', collapsed: false, order: 1 },
  { id: 'recent', kind: 'recent', name: 'Recently opened', collapsed: false, order: 2 },
];

const GROUP_COLOR = /^[a-z0-9-]{1,40}$/i;

/** Validate + complete a group list: built-ins always present, custom ids `custom:*`, orders 0..n. */
export function sanitizeGroups(groups: unknown): RepoGroup[] {
  const input = Array.isArray(groups) ? (groups as Partial<RepoGroup>[]) : [];
  const out: RepoGroup[] = [];
  const seen = new Set<string>();
  for (const g of input) {
    if (!g || typeof g.id !== 'string' || seen.has(g.id)) continue;
    const builtin = BUILTIN_GROUPS.find((b) => b.id === g.id);
    if (!builtin && !/^custom:[\w-]{1,64}$/.test(g.id)) continue;
    seen.add(g.id);
    const name =
      typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 80) : (builtin?.name ?? 'Group');
    out.push({
      id: g.id,
      kind: builtin?.kind ?? 'custom',
      name: builtin ? builtin.name : name,
      ...(typeof g.color === 'string' && GROUP_COLOR.test(g.color) ? { color: g.color } : {}),
      collapsed: !!g.collapsed,
      order: typeof g.order === 'number' && Number.isFinite(g.order) ? g.order : out.length + 100,
    });
  }
  for (const b of BUILTIN_GROUPS) if (!seen.has(b.id)) out.push({ ...b, order: b.order - 10 });
  return out.sort((a, b) => a.order - b.order).map((g, i) => ({ ...g, order: i }));
}

const clampWidth = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(80, Math.min(1200, Math.round(v))) : d;

type Listener = (repos: RepoRecord[]) => void;
const listeners = new Set<Listener>();

/** Called after every registry change (OS recent documents / JumpList, spec 03 §7 step 16). */
export function onRegistryChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const MAX_RECENT = 50;

/**
 * Comparison key: native realpath (expands Windows 8.3 short names, resolves links), case-insensitive on
 * Windows/macOS, forward slashes.
 */
export function pathKey(
  p: string,
  platform: NodeJS.Platform = process.platform,
  realpath?: RealpathFn,
): string {
  return canonicalKey(p, platform, realpath).replace(/\\/g, '/').replace(/\/+$/, '');
}

export class RepoRegistry {
  private repos: RepoRecord[] = [];
  private groups: RepoGroup[] = sanitizeGroups([]);
  private columnWidths: RepoColumnWidths = { ...DEFAULT_COLUMN_WIDTHS };

  constructor(private readonly file: string) {
    const r = readJson<RepoRegistryFile>(file);
    if (r.kind === 'ok' && Array.isArray(r.value?.repos)) {
      this.repos = r.value.repos;
      this.groups = sanitizeGroups(r.value.groups);
      this.setColumnWidths(r.value.columnWidths ?? DEFAULT_COLUMN_WIDTHS, false);
    }
  }

  /** Everything the Repository Management view needs (spec 03 `RepoRegistryFile`). */
  state(): RepoRegistryState {
    return {
      repos: this.list(),
      groups: this.groups.map((g) => ({ ...g })),
      columnWidths: { ...this.columnWidths },
    };
  }

  /** Replace the group list (order, colours, collapsed, custom groups); memberships of deleted groups go. */
  saveGroups(groups: unknown): void {
    this.groups = sanitizeGroups(groups);
    const ids = new Set(this.groups.map((g) => g.id));
    this.repos = this.repos.map((r) => ({ ...r, groupIds: (r.groupIds ?? []).filter((id) => ids.has(id)) }));
    this.save();
  }

  /** Add / remove a repo to / from a custom group. */
  assignGroup(p: string, groupId: string, member: boolean): void {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g || g.kind !== 'custom') throw new Error('Unknown group');
    const key = pathKey(p);
    this.repos = this.repos.map((r) => {
      if (pathKey(r.path) !== key) return r;
      const ids = (r.groupIds ?? []).filter((id) => id !== groupId);
      return { ...r, groupIds: member ? [...ids, groupId] : ids };
    });
    this.save();
  }

  setColumnWidths(w: Partial<RepoColumnWidths>, persist = true): void {
    const d = DEFAULT_COLUMN_WIDTHS;
    this.columnWidths = {
      name: clampWidth(w?.name, d.name),
      remote: clampWidth(w?.remote, d.remote),
      branch: clampWidth(w?.branch, d.branch),
    };
    if (persist) this.save();
  }

  /** Favorites in this order (drag-reorder, spec 03 `repos:reorderFavorites`); unlisted favorites follow. */
  reorderFavorites(paths: string[]): void {
    const keys = paths.map((p) => pathKey(p));
    const favs = this.repos.filter((r) => r.favorite);
    const rank = (r: RepoRecord): number => {
      const i = keys.indexOf(pathKey(r.path));
      return i < 0 ? keys.length + (r.favoriteOrder ?? 0) : i;
    };
    const ordered = [...favs].sort((a, b) => rank(a) - rank(b));
    const order = new Map(ordered.map((r, i) => [pathKey(r.path), i + 1]));
    this.repos = this.repos.map((r) =>
      r.favorite ? { ...r, favoriteOrder: order.get(pathKey(r.path)) } : r,
    );
    this.save();
  }

  /** Recents sorted by last opened, favorites first; `missing` refreshed from disk. */
  list(): RepoRecord[] {
    return this.repos
      .map((r) => ({ ...r, missing: !fs.existsSync(r.path) }))
      .sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          (a.favoriteOrder ?? 0) - (b.favoriteOrder ?? 0) ||
          (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
      );
  }

  /** Record an open; keeps favorites and alias of an existing entry. */
  touch(rec: Omit<RepoRecord, 'favorite' | 'groupIds' | 'lastOpenedAt'>, now = Date.now()): RepoRecord {
    const key = pathKey(rec.path);
    const existing = this.repos.find((r) => pathKey(r.path) === key);
    const next: RepoRecord = {
      favorite: false,
      groupIds: [],
      ...existing,
      ...rec,
      alias: rec.alias ?? existing?.alias,
      lastOpenedAt: now,
    };
    delete next.missing;
    this.repos = [next, ...this.repos.filter((r) => pathKey(r.path) !== key)];
    // Trim non-favorite recents beyond the cap.
    let recent = 0;
    this.repos = this.repos.filter((r) => r.favorite || ++recent <= MAX_RECENT);
    this.save();
    return next;
  }

  remove(p: string): void {
    const key = pathKey(p);
    this.repos = this.repos.filter((r) => pathKey(r.path) !== key);
    this.save();
  }

  setFavorite(p: string, favorite: boolean): void {
    const key = pathKey(p);
    const order = Math.max(0, ...this.repos.map((r) => r.favoriteOrder ?? 0)) + 1;
    this.repos = this.repos.map((r) =>
      pathKey(r.path) === key ? { ...r, favorite, favoriteOrder: favorite ? order : undefined } : r,
    );
    this.save();
  }

  /** Set or (with null) remove the display alias of a recent repository (spec 01 §4.2). */
  setAlias(p: string, alias: string | null): void {
    const key = pathKey(p);
    this.repos = this.repos.map((r) => {
      if (pathKey(r.path) !== key) return r;
      const next = { ...r, alias: alias ?? undefined };
      if (!alias) delete next.alias;
      return next;
    });
    this.save();
  }

  private save(): void {
    const data: RepoRegistryFile = {
      version: 1,
      repos: this.repos,
      groups: this.groups,
      columnWidths: this.columnWidths,
    };
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
    const list = this.repos;
    for (const cb of listeners) {
      try {
        cb(list);
      } catch {
        /* listener errors never break saving */
      }
    }
  }
}
