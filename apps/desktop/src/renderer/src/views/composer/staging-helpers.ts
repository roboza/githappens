import { rawPathKey } from '@githappens/git/ops';
import type { DiffSpec, StatusEntry } from '@githappens/git/types';

/**
 * Pure helpers for the staging file lists (spec 06 §4.3): sorting, path/tree flattening with folder
 * aggregation, multi-selection and per-repo view preferences.
 */

export type WipStatus = 'A' | 'D' | 'M' | 'R' | 'C' | 'T' | 'U' | '?';

export interface WipRow {
  /** Shown name (for a name that is not valid UTF-8: decoded with U+FFFD, see `rawKey`). */
  path: string;
  oldPath?: string;
  status: WipStatus;
  untracked: boolean;
  /** `rawPathKey(rawPath)` when the name is not valid UTF-8 (spec 02 §8): what ops must be given. */
  rawKey?: string;
  oldRawKey?: string;
}

/** The path ops take for a row: its raw key when the name is not valid UTF-8, else its path. */
export const opPathOf = (r: Pick<WipRow, 'path' | 'rawKey'>): string => r.rawKey ?? r.path;

const WT_STATUS = (e: StatusEntry): WipStatus | null => {
  if (e.kind === 'untracked') return '?';
  if (e.kind === 'ignored' || e.kind === 'unmerged') return null;
  return e.worktree === '.' ? null : (e.worktree as WipStatus);
};
const IDX_STATUS = (e: StatusEntry): WipStatus | null => {
  if (e.kind !== 'ordinary' && e.kind !== 'renamed') return null;
  return e.index === '.' ? null : (e.index as WipStatus);
};

/**
 * Unstaged / staged rows of a status. Names that are not valid UTF-8 (spec 02 §8) are shown decoded and
 * carry their raw key (`rawKey` / `oldRawKey`) for every action.
 */
export function wipRows(entries: StatusEntry[]): { unstaged: WipRow[]; staged: WipRow[] } {
  const unstaged: WipRow[] = [];
  const staged: WipRow[] = [];
  for (const e of entries) {
    const raw = e.rawPath ? { rawKey: rawPathKey(e.rawPath) } : {};
    const w = WT_STATUS(e);
    if (w) unstaged.push({ path: e.path, status: w, untracked: e.kind === 'untracked', ...raw });
    const i = IDX_STATUS(e);
    if (i) {
      staged.push({
        path: e.path,
        status: i,
        untracked: false,
        oldPath: e.kind === 'renamed' ? e.origPath : undefined,
        ...raw,
        ...(e.kind === 'renamed' && e.origRawPath ? { oldRawKey: rawPathKey(e.origRawPath) } : {}),
      });
    }
  }
  return { unstaged, staged };
}

/** Shown paths (selection, drag & drop) → the paths ops take (raw keys where rows have one). */
export function opKeyMapper(rows: WipRow[]): (paths: string[]) => string[] {
  const keyOf = new Map<string, string>();
  for (const r of rows) if (r.rawKey) keyOf.set(r.path, r.rawKey);
  return (paths) => (keyOf.size ? paths.map((p) => keyOf.get(p) ?? p) : paths);
}

/** The diff a WIP row shows (staging panel, external diff tool), by op path (raw keys included). */
export function wipDiffSpec(
  f: Pick<WipRow, 'path' | 'oldPath' | 'rawKey' | 'oldRawKey'> & { untracked?: boolean },
  side: 'unstaged' | 'staged',
): DiffSpec {
  const p = f.rawKey ?? f.path;
  if (side === 'unstaged')
    return f.untracked ? { kind: 'untracked', path: p } : { kind: 'workdir', paths: [p] };
  const old = f.oldRawKey ?? f.oldPath;
  return { kind: 'staged', paths: old ? [old, p] : [p] };
}

export type SortKey = 'path' | 'name' | 'status' | 'extension';
export type SortDir = 'asc' | 'desc';
export type ViewMode = 'path' | 'tree';

export interface ViewPrefs {
  mode: ViewMode;
  sort: SortKey;
  dir: SortDir;
}

export const DEFAULT_VIEW: ViewPrefs = { mode: 'path', sort: 'path', dir: 'asc' };
/** Above this many changes the tree starts collapsed and a banner explains it (spec 06 §4.3). */
export const LARGE_CHANGESET = 5000;

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const ext = (p: string): string => {
  const b = base(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
const STATUS_ORDER: Record<WipStatus, number> = { U: 0, A: 1, '?': 1, M: 2, T: 3, R: 4, C: 4, D: 5 };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Stable sort by key, ties broken by full path. */
export function sortRows<T extends WipRow>(rows: T[], sort: SortKey, dir: SortDir): T[] {
  const key = (r: T): string | number => {
    switch (sort) {
      case 'name':
        return base(r.path).toLowerCase();
      case 'status':
        return STATUS_ORDER[r.status];
      case 'extension':
        return ext(r.path);
      default:
        return r.path.toLowerCase();
    }
  };
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = typeof ka === 'number' ? ka - (kb as number) : cmp(ka, kb as string);
    return (c || cmp(a.path, b.path)) * sign;
  });
}

export type FlatRow<T extends WipRow> =
  | { kind: 'file'; key: string; row: T; depth: number; label: string }
  | {
      kind: 'folder';
      key: string;
      path: string;
      name: string;
      depth: number;
      count: number;
      collapsed: boolean;
    };

interface Folder<T> {
  name: string;
  path: string;
  folders: Map<string, Folder<T>>;
  files: T[];
  count: number;
}

/**
 * Rows to render. Path view: the sorted files. Tree view: folders first (by name), then files in the
 * sort order; single-child folder chains are compacted (`src/main`), counts aggregate descendants and
 * collapsed folders hide their subtree. `collapsedByDefault` inverts `toggled` (large change sets).
 */
export function flattenRows<T extends WipRow>(
  rows: T[],
  view: ViewPrefs,
  toggled: ReadonlySet<string>,
  collapsedByDefault = false,
): FlatRow<T>[] {
  const sorted = sortRows(rows, view.sort, view.dir);
  if (view.mode === 'path') {
    return sorted.map((r) => ({ kind: 'file', key: r.path, row: r, depth: 0, label: r.path }));
  }
  const root: Folder<T> = { name: '', path: '', folders: new Map(), files: [], count: 0 };
  for (const r of sorted) {
    const segs = r.path.split('/');
    let node = root;
    node.count++;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join('/');
      let child = node.folders.get(segs[i]!);
      if (!child) {
        child = { name: segs[i]!, path: p, folders: new Map(), files: [], count: 0 };
        node.folders.set(segs[i]!, child);
      }
      child.count++;
      node = child;
    }
    node.files.push(r);
  }
  const out: FlatRow<T>[] = [];
  const walk = (n: Folder<T>, depth: number): void => {
    const folders = [...n.folders.values()].sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
    for (let f of folders) {
      let name = f.name;
      while (f.folders.size === 1 && f.files.length === 0) {
        f = [...f.folders.values()][0]!;
        name = `${name}/${f.name}`;
      }
      const collapsed = collapsedByDefault !== toggled.has(f.path);
      out.push({ kind: 'folder', key: `d:${f.path}`, path: f.path, name, depth, count: f.count, collapsed });
      if (!collapsed) walk(f, depth + 1);
    }
    for (const r of n.files) out.push({ kind: 'file', key: r.path, row: r, depth, label: base(r.path) });
  };
  walk(root, 0);
  return out;
}

/** Every file at or under a folder path. */
export function filesUnder<T extends WipRow>(rows: T[], folder: string): T[] {
  const prefix = `${folder}/`;
  return rows.filter((r) => r.path.startsWith(prefix));
}

// ---- selection ----

export interface Selection {
  paths: Set<string>;
  anchor: string | null;
}

export const emptySelection = (): Selection => ({ paths: new Set(), anchor: null });

/**
 * Click handling over the visible file order: plain → only this; Ctrl/Cmd → toggle; Shift → range from
 * the anchor (added to the selection with Ctrl/Cmd, replacing it otherwise).
 */
export function clickSelect(
  sel: Selection,
  order: string[],
  path: string,
  mods: { ctrl: boolean; shift: boolean },
): Selection {
  if (mods.shift && sel.anchor && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(path);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const range = order.slice(lo, hi + 1);
    const paths = mods.ctrl ? new Set([...sel.paths, ...range]) : new Set(range);
    return { paths, anchor: sel.anchor };
  }
  if (mods.ctrl) {
    const paths = new Set(sel.paths);
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    return { paths, anchor: path };
  }
  return { paths: new Set([path]), anchor: path };
}

/** Drop selected paths that are no longer listed (after a status refresh). */
export function pruneSelection(sel: Selection, present: ReadonlySet<string>): Selection {
  const kept = [...sel.paths].filter((p) => present.has(p));
  if (kept.length === sel.paths.size && (!sel.anchor || present.has(sel.anchor))) return sel;
  return { paths: new Set(kept), anchor: sel.anchor && present.has(sel.anchor) ? sel.anchor : null };
}

/** The paths an action applies to: the selection when the target is part of it, else just the target. */
export function actionPaths(sel: Selection, target: string, order: string[]): string[] {
  if (!sel.paths.has(target)) return [target];
  return order.filter((p) => sel.paths.has(p));
}

// ---- persisted view prefs (per repository) ----

const VIEW_KEY = (repoKey: string): string => `staging:view:${repoKey}`;

export function parseViewPrefs(raw: string | null): ViewPrefs {
  if (!raw) return DEFAULT_VIEW;
  try {
    const v = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      mode: v.mode === 'tree' ? 'tree' : 'path',
      sort: v.sort === 'name' || v.sort === 'status' || v.sort === 'extension' ? v.sort : 'path',
      dir: v.dir === 'desc' ? 'desc' : 'asc',
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function loadViewPrefs(repoKey: string): ViewPrefs {
  try {
    return parseViewPrefs(localStorage.getItem(VIEW_KEY(repoKey)));
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveViewPrefs(repoKey: string, v: ViewPrefs): void {
  try {
    localStorage.setItem(VIEW_KEY(repoKey), JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

// ---- drag & drop between the lists ----

export const WIP_DRAG_MIME = 'application/x-githappens-wip-files';

export function encodeDrag(side: 'unstaged' | 'staged', paths: string[]): string {
  return JSON.stringify({ side, paths });
}

export function decodeDrag(raw: string): { side: 'unstaged' | 'staged'; paths: string[] } | null {
  try {
    const v = JSON.parse(raw) as { side?: unknown; paths?: unknown };
    if ((v.side !== 'unstaged' && v.side !== 'staged') || !Array.isArray(v.paths)) return null;
    const paths = v.paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    return paths.length ? { side: v.side, paths } : null;
  } catch {
    return null;
  }
}

// ---- virtualization ----

/** Visible index window for fixed-height rows inside a scrolled container (with overscan). */
export function visibleRange(
  count: number,
  rowHeight: number,
  listTop: number,
  scrollTop: number,
  viewport: number,
  overscan = 10,
): { start: number; end: number } {
  const first = Math.floor((scrollTop - listTop) / rowHeight);
  const last = Math.ceil((scrollTop - listTop + viewport) / rowHeight);
  return {
    start: Math.max(0, Math.min(count, first - overscan)),
    end: Math.max(0, Math.min(count, last + overscan)),
  };
}
