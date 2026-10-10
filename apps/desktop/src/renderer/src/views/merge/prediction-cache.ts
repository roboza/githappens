import type { ConflictPrediction } from '@githappens/git/types';

/**
 * Renderer-side conflict prediction cache (spec 08 §6.9): LRU by `(repo, oursSha, theirsSha)`, with
 * in-flight de-duplication so a context menu, a 500 ms drag hover and a pill badge share one
 * `git merge-tree`. Pure (no DOM / IPC) so it can be unit-tested.
 */
export class PredictionCache {
  private readonly done = new Map<string, ConflictPrediction>();
  private readonly pending = new Map<string, Promise<ConflictPrediction | null>>();

  constructor(private readonly max = 256) {}

  static key(repoId: string, ours: string, theirs: string): string {
    return `${repoId}|${ours}|${theirs}`;
  }

  peek(key: string): ConflictPrediction | undefined {
    const hit = this.done.get(key);
    if (hit) {
      this.done.delete(key);
      this.done.set(key, hit);
    }
    return hit;
  }

  get size(): number {
    return this.done.size;
  }

  /** Cached result, the in-flight request, or a new `load()` (failures are not cached). */
  get(key: string, load: () => Promise<ConflictPrediction>): Promise<ConflictPrediction | null> {
    const hit = this.peek(key);
    if (hit) return Promise.resolve(hit);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = load()
      .then((r) => {
        this.set(key, r);
        return r;
      })
      .catch(() => null)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  set(key: string, r: ConflictPrediction): void {
    this.done.delete(key);
    this.done.set(key, r);
    while (this.done.size > this.max) this.done.delete(this.done.keys().next().value!);
  }

  clear(): void {
    this.done.clear();
  }
}

/** "Will conflict in 3 files" (spec 08 §4.9 wording); null when nothing to warn about. */
export function conflictHint(p: ConflictPrediction | null | undefined): string | null {
  if (!p?.supported || !p.conflicts.length) return null;
  return `Will conflict in ${p.conflicts.length} file${p.conflicts.length === 1 ? '' : 's'}`;
}

/** Hover list for the hint (first `max` files). */
export function conflictHintTitle(p: ConflictPrediction | null | undefined, max = 15): string | undefined {
  if (!conflictHint(p)) return undefined;
  const files = p!.conflicts;
  const list = files.slice(0, max).join('\n');
  return `Conflicting files:\n${list}${files.length > max ? `\n…and ${files.length - max} more` : ''}`;
}

/** "Merge X into H — will conflict in N files" (menu label, spec 08 §4.9). */
export function withHint(label: string, p: ConflictPrediction | null | undefined): string {
  const h = conflictHint(p);
  return h ? `${label} — ⚠ ${h.charAt(0).toLowerCase()}${h.slice(1)}` : label;
}
