import type { RefInfo } from '@githappens/git/types';

import type { TreeNode } from '../../lib/format';

/** Pure left-panel helpers (spec 01 §4.5): filter highlight, tree flattening, windowing, multi-select. */

export interface Segment {
  text: string;
  hit: boolean;
}

/**
 * Split `text` into highlighted / plain runs for the fuzzy-match `indices` of `full` (the ref's full
 * short name). `text` is a suffix of `full` (a tree leaf label), so indices are shifted by the offset.
 */
export function highlightSegments(text: string, indices: readonly number[] | null, full = text): Segment[] {
  if (!text) return [];
  const offset = full.length - text.length;
  const hits = new Set((indices ?? []).map((i) => i - offset).filter((i) => i >= 0 && i < text.length));
  if (!hits.size) return [{ text, hit: false }];
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i]!, hit });
  }
  return out;
}

export type FlatRow =
  | { kind: 'folder'; key: string; name: string; depth: number; open: boolean }
  | { kind: 'ref'; key: string; ref: RefInfo; label: string; depth: number };

/**
 * Flatten a ref folder tree into visible rows. `collapsed(key)` says whether a folder is collapsed;
 * with `forceOpen` (filter active) every folder is expanded so matches are visible (auto-expand).
 */
export function flattenRefTree(
  nodes: readonly TreeNode<RefInfo>[],
  opts: { prefix: string; depth?: number; collapsed: (key: string) => boolean; forceOpen?: boolean },
  out: FlatRow[] = [],
): FlatRow[] {
  const depth = opts.depth ?? 0;
  for (const n of nodes) {
    const key = `${opts.prefix}:${n.path}/`;
    if (n.item) {
      out.push({ kind: 'ref', key: n.item.fullName, ref: n.item, label: n.name, depth });
      continue;
    }
    const open = !!opts.forceOpen || !opts.collapsed(key);
    out.push({ kind: 'folder', key, name: n.name, depth, open });
    if (open) flattenRefTree(n.children, { ...opts, depth: depth + 1 }, out);
  }
  return out;
}

export interface WindowRange {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

/** Rows to render for a fixed-row-height virtual list. */
export function windowRange(o: {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewport: number;
  overscan?: number;
}): WindowRange {
  const overscan = o.overscan ?? 8;
  if (o.count <= 0 || o.rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.floor(Math.max(0, o.scrollTop) / o.rowHeight);
  const visible = Math.ceil(Math.max(0, o.viewport) / o.rowHeight) + 1;
  const start = Math.max(0, Math.min(o.count - 1, first - overscan));
  const end = Math.min(o.count, first + visible + overscan);
  return { start, end, padTop: start * o.rowHeight, padBottom: (o.count - end) * o.rowHeight };
}

/** Lists shorter than this render without virtualization (unless the section has a fixed height). */
export const VIRTUALIZE_THRESHOLD = 150;
/** Default body height of a virtualized section without a stored height. */
export const DEFAULT_VIRTUAL_HEIGHT = 360;

/**
 * Click-selection for the Local tree: plain click selects one, Ctrl/Cmd toggles, Shift selects the range
 * from the anchor in visible `order`.
 */
export function nextSelection(
  current: readonly string[],
  order: readonly string[],
  key: string,
  mod: { toggle?: boolean; range?: boolean },
  anchor: string | null,
): { selected: string[]; anchor: string } {
  if (mod.range && anchor && order.includes(anchor) && order.includes(key)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(key);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const base = mod.toggle ? current.filter((k) => !range.includes(k)) : [];
    return { selected: [...base, ...range], anchor };
  }
  if (mod.toggle) {
    return {
      selected: current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
      anchor: key,
    };
  }
  return { selected: [key], anchor: key };
}

/** Branches a multi-delete would act on: selected local branches minus the checked-out one. */
export function deletableBranches(refs: readonly RefInfo[], selected: readonly string[]): RefInfo[] {
  return refs.filter((r) => r.type === 'local' && !r.isHead && selected.includes(r.fullName));
}
