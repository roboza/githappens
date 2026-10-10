import { MRU_MAX } from './fuzzy';

/** Most-recently-used palette entries (spec 01 §4.8), persisted in localStorage `palette:mru`. */
export const MRU_STORAGE_KEY = 'palette:mru';

let memory: string[] = [];

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Most-recent-first keys (command ids, or `kind:id` for argument picks). */
export function getMru(): string[] {
  const s = storage();
  if (!s) return [...memory];
  try {
    const raw = s.getItem(MRU_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed))
      return parsed.filter((x): x is string => typeof x === 'string').slice(0, MRU_MAX);
  } catch {
    /* corrupt or blocked storage: fall through to memory */
  }
  return [...memory];
}

export function recordMru(key: string): void {
  const next = [key, ...getMru().filter((k) => k !== key)].slice(0, MRU_MAX);
  memory = next;
  try {
    storage()?.setItem(MRU_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / blocked storage: keep the in-memory copy */
  }
}

export function clearMru(): void {
  memory = [];
  try {
    storage()?.removeItem(MRU_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
