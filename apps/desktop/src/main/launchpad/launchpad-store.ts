import path from 'node:path';

import {
  DEFAULT_FILTERS,
  type ItemUserState,
  type LaunchpadFilters,
  type LaunchpadStateFile,
  type SavedView,
} from '@githappens/launchpad';

import { backupCorrupt, readJson, writeFileAtomic } from '../settings/atomic-file';

/** Pin/snooze states unseen for this long are garbage-collected (spec 11 §8). */
export const STATE_GC_MS = 30 * 86_400_000;

const empty = (): LaunchpadStateFile => ({
  version: 1,
  itemStates: {},
  savedViews: [],
  lastFilters: DEFAULT_FILTERS,
});

/**
 * Per-profile Launchpad user state: `profiles/<id>/launchpad.json` (spec 11 §5.2). Atomic writes;
 * a corrupt file is moved aside (`.bak-<ts>`) and the store starts empty.
 */
export class LaunchpadStore {
  private data: LaunchpadStateFile;
  readonly file: string;
  /** Set when the file was corrupt at load (path of the backup). */
  readonly recoveredFrom?: string;

  constructor(profileDir: string) {
    this.file = path.join(profileDir, 'launchpad.json');
    const r = readJson<LaunchpadStateFile>(this.file);
    if (r.kind === 'ok' && r.value && typeof r.value === 'object' && r.value.version === 1) {
      this.data = {
        version: 1,
        itemStates: r.value.itemStates && typeof r.value.itemStates === 'object' ? r.value.itemStates : {},
        savedViews: Array.isArray(r.value.savedViews) ? r.value.savedViews : [],
        lastFilters: r.value.lastFilters ?? DEFAULT_FILTERS,
      };
    } else {
      if (r.kind === 'corrupt' || r.kind === 'ok') this.recoveredFrom = backupCorrupt(this.file);
      this.data = empty();
    }
  }

  private save(): void {
    writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  // ---- item states ----

  states(): Record<string, ItemUserState> {
    return this.data.itemStates;
  }

  get(uid: string): ItemUserState | undefined {
    return this.data.itemStates[uid];
  }

  /** Store a state; one without pin or snooze is removed. Returns the stored state or null. */
  put(state: ItemUserState): ItemUserState | null {
    if (!state.pinnedAt && !state.snooze) {
      delete this.data.itemStates[state.uid];
      this.save();
      return null;
    }
    this.data.itemStates[state.uid] = state;
    this.save();
    return state;
  }

  /** Stamp `lastSeenAt` for returned items and drop states unseen for 30 days. */
  markSeen(uids: Iterable<string>, now: number): void {
    const iso = new Date(now).toISOString();
    let dirty = false;
    for (const uid of uids) {
      const st = this.data.itemStates[uid];
      if (st && st.lastSeenAt !== iso) {
        st.lastSeenAt = iso;
        dirty = true;
      }
    }
    for (const [uid, st] of Object.entries(this.data.itemStates)) {
      const seen = st.lastSeenAt ? Date.parse(st.lastSeenAt) : NaN;
      if (!Number.isNaN(seen) && now - seen > STATE_GC_MS) {
        delete this.data.itemStates[uid];
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  // ---- saved views & last filters ----

  views(): SavedView[] {
    return this.data.savedViews;
  }

  saveView(view: Omit<SavedView, 'id'> & { id?: string }): SavedView {
    const v: SavedView = { ...view, id: view.id || `view-${Date.now().toString(36)}` };
    const i = this.data.savedViews.findIndex((x) => x.id === v.id);
    if (i >= 0) this.data.savedViews[i] = v;
    else this.data.savedViews.push(v);
    this.save();
    return v;
  }

  deleteView(id: string): void {
    this.data.savedViews = this.data.savedViews.filter((v) => v.id !== id);
    this.save();
  }

  /** Settings sync: replace pins/snoozes and saved views at once. */
  replaceUserState(itemStates: Record<string, ItemUserState>, savedViews: SavedView[]): void {
    this.data.itemStates = itemStates;
    this.data.savedViews = savedViews;
    this.save();
  }

  lastFilters(): LaunchpadFilters {
    return this.data.lastFilters;
  }

  setLastFilters(f: LaunchpadFilters): void {
    if (JSON.stringify(f) === JSON.stringify(this.data.lastFilters)) return;
    this.data.lastFilters = f;
    this.save();
  }
}
