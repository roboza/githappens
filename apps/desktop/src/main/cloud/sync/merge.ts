import { canonicalJson } from './canonical';

/**
 * Keyed 3-way merge for sync categories (spec 14 §6.2 step 4).
 *
 * A category document is a map `key → entry`; deletions are tombstones so they can win or lose like
 * any other change. For every key, with base = the version both sides last agreed on:
 *   - local == remote             → either (newest stamp kept)
 *   - only remote changed vs base → remote
 *   - only local changed vs base  → local
 *   - both changed differently    → 'lww': newer `at` wins (ties → remote, so a fresh machine
 *                                   adopts the synced value); 'strict': conflict (unless `prefer`).
 */

export interface SyncEntry {
  /** Value (absent for tombstones). */
  v?: unknown;
  /** epoch ms of the last local change (0 = unknown / initial import). */
  at: number;
  del?: true;
}

export type SyncItems = Record<string, SyncEntry>;
export type MergeStrategy = 'lww' | 'strict';

export interface MergeResult {
  merged: SyncItems;
  /** Keys both sides changed differently ('strict' without `prefer`); merged holds the local side. */
  conflicts: string[];
}

const content = (e: SyncEntry | undefined): string =>
  !e || e.del ? '\u0000deleted' : canonicalJson(e.v === undefined ? null : e.v);

export const sameEntry = (a: SyncEntry | undefined, b: SyncEntry | undefined): boolean =>
  content(a) === content(b);

export function merge3(
  base: SyncItems,
  local: SyncItems,
  remote: SyncItems,
  strategy: MergeStrategy,
  prefer?: 'local' | 'remote',
): MergeResult {
  const merged: SyncItems = {};
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const k of [...keys].sort()) {
    const l = local[k];
    const r = remote[k];
    const b = base[k];
    let pick: SyncEntry | undefined;
    if (sameEntry(l, r)) pick = (l?.at ?? -1) >= (r?.at ?? -1) ? l : r;
    else if (sameEntry(l, b)) pick = r;
    else if (sameEntry(r, b)) pick = l;
    else if (prefer) pick = prefer === 'local' ? l : r;
    else if (strategy === 'lww') pick = (l?.at ?? 0) > (r?.at ?? 0) ? l : r;
    else {
      conflicts.push(k);
      pick = l;
    }
    if (pick) merged[k] = pick;
  }
  return { merged, conflicts };
}

/** Same visible content (tombstones and missing keys are equivalent). */
export function sameItems(a: SyncItems, b: SyncItems): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!sameEntry(a[k], b[k])) return false;
  return true;
}

/** Live values only (tombstones dropped). */
export function liveValues(items: SyncItems): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(items)) if (!e.del) out[k] = e.v;
  return out;
}

/** Drop tombstones older than `maxAgeMs`. */
export function pruneTombstones(items: SyncItems, now: number, maxAgeMs = 90 * 86_400_000): SyncItems {
  const out: SyncItems = {};
  for (const [k, e] of Object.entries(items)) if (!e.del || now - e.at < maxAgeMs) out[k] = e;
  return out;
}
